(function () {
  "use strict";
  // minimap: a small face-on overview (world x / y; north = -y = screen up in 2D) of the whole universe, bottom-right
  // of the stage above #layout-status. Static layer (cluster rings, galaxies, the largest suns, frame) cached offscreen,
  // rebuilt on settle / repack / visibility / theme / resize. Live layer (target crosshair, 3D view wedge | 2D footprint,
  // trail, read-out) drawn only when the camera signature changes, polled <= 15 fps by a timer (headless-safe) only
  // while the camera moves: ~1 s unchanged and the poll stops until an event wakes it (camera input on the stage,
  // flyto / view3d / chrome / view / select ...; render's idle spin is looked for once, ~21 s after a wake); no work
  // while hidden; nothing to map (0 bodies shown) hides the map. Click: fly the target there; drag: pan live; wheel: dolly; m: toggle (localStorage mx.minimap).
  // Public APIs only: MX.camera (target, view, view3d, fitAll, safeRect, flyTo, zoomBy, flying), MX.universe
  // (clusters, galaxies, systems, centerOf, radiusOf), MX.state (x, y, nodeVisible, view).
  const S = MX.state, KEY = "mx.minimap", PW = 168, PH = 168, RH = 22, MW = PW, MH = PH - RH, PAD = 11, TICK = 66, TRAIL = 10;
  const STILL = 1000, SPINLOOK = 21000;   // the poll stops after STILL ms unchanged; one spin look SPINLOOK ms later
  const CSS = [
    "#minimap{position:absolute;right:calc(var(--rx,364px) + 12px);bottom:62px;transition:right var(--dur) var(--ease);width:" + PW + "px;height:" + PH + "px;border-radius:9px;",
    "background:var(--surface);box-shadow:var(--lift,none);overflow:hidden;cursor:crosshair;touch-action:none;",
    "-webkit-user-select:none;user-select:none;z-index:2}",
    "#minimap::after{content:\"\";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px var(--ring);pointer-events:none}",
    "#minimap[hidden],#minimap.mm-empty{display:none}",
    "#minimap canvas{position:absolute;left:0;top:0;width:" + MW + "px;height:" + MH + "px;display:block}",
    "#minimap .mm-read{position:absolute;left:0;right:0;bottom:0;height:" + RH + "px;display:flex;align-items:center;",
    "justify-content:space-between;gap:8px;padding:0 10px;box-shadow:inset 0 1px 0 var(--ring);",
    "font:11px/1 var(--font-mono);letter-spacing:0;text-transform:uppercase;color:var(--text-3);",
    "white-space:nowrap;font-variant-numeric:tabular-nums;pointer-events:none}",
    "#minimap .mm-probe{position:absolute;width:0;height:0;overflow:hidden;visibility:hidden}",
    "#pane-graph[inert] #minimap{visibility:hidden}",
    "@media (max-width:760px){#minimap{display:none}}",
  ].join("");
  const INK = {hi: "--line-hi", mid: "--line-mid", edge: "--line-edge", lo: "--line-lo", t3: "--text-3",
    g0: "--g0", g1: "--g1", g2: "--g2", g3: "--g3"};

  MX.module("minimap", () => {
    const C = MX.camera, U = MX.universe, stage = document.getElementById("stage");
    if (!C || typeof C.target !== "function" || !U || !U.clusters || !stage) { MX.warn("minimap: camera/universe missing"); return; }

    const st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
    const el = document.createElement("div");
    el.id = "minimap";
    el.setAttribute("role", "img");
    el.innerHTML = '<canvas aria-hidden="true"></canvas><div class="mm-read" aria-hidden="true"><span class="mm-xy"></span>' +
      '<span class="mm-z"></span></div><span class="mm-probe" aria-hidden="true"></span>';
    stage.appendChild(el);
    const cv = el.firstChild, ctx = cv.getContext("2d"), xyEl = el.querySelector(".mm-xy"), zEl = el.querySelector(".mm-z");
    const probeEl = el.querySelector(".mm-probe");
    const stat = document.createElement("canvas"), sctx = stat.getContext("2d");

    let shown = true;
    try { shown = localStorage.getItem(KEY) !== "0"; } catch (e) { /* storage blocked: default on */ }
    el.hidden = !shown;

    // ---- world -> map fit (cluster discs; bodies when no cluster is placed)
    let fit = null, ink = {}, font = "", dpr = 0, staticDirty = true, sig = "", timer = 0, trail = [], marker = null, lastAria = "";
    function bounds() {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      U.clusters.forEach((_c, k) => {
        const c = U.centerOf("cluster", k), r = U.radiusOf("cluster", k);
        if (!c || !isFinite(c[0]) || !isFinite(c[1])) return;
        x0 = Math.min(x0, c[0] - r); x1 = Math.max(x1, c[0] + r); y0 = Math.min(y0, c[1] - r); y1 = Math.max(y1, c[1] + r);
      });
      if (!(x1 > x0)) for (let i = 0; i < MX.g.N; i++) {
        if (!S.nodeVisible[i] || !isFinite(S.x[i])) continue;
        x0 = Math.min(x0, S.x[i]); x1 = Math.max(x1, S.x[i]); y0 = Math.min(y0, S.y[i]); y1 = Math.max(y1, S.y[i]);
      }
      if (!(x1 >= x0)) return null;
      const k = Math.min((MW - 2 * PAD) / Math.max(x1 - x0, 1e-3), (MH - 2 * PAD) / Math.max(y1 - y0, 1e-3));
      return {k, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2};
    }
    const toMap = (x, y) => [MW / 2 + (x - fit.cx) * fit.k, MH / 2 + (y - fit.cy) * fit.k];
    const toWorld = (mx, my) => [fit.cx + (mx - MW / 2) / fit.k, fit.cy + (my - MH / 2) / fit.k];

    function probe() {
      for (const k in INK) { probeEl.style.color = "var(" + INK[k] + ")"; ink[k] = getComputedStyle(probeEl).color; }
      font = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";
    }
    const DPR = () => Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    function size(c, x) { c.width = Math.round(MW * dpr); c.height = Math.round(MH * dpr); x.setTransform(dpr, 0, 0, dpr, 0, 0); }

    // ---- static layer
    function buildStatic() {
      staticDirty = false;
      dpr = DPR();
      size(stat, sctx); size(cv, ctx); probe();
      fit = S.nodesShown > 0 ? bounds() : null;
      el.classList.toggle("mm-empty", !fit);
      const x = sctx;
      x.clearRect(0, 0, MW, MH);
      x.lineWidth = 1;
      // frame: corner brackets + north tick
      x.strokeStyle = ink.edge; x.globalAlpha = 0.55; x.beginPath();
      for (const [cx, cy, sx, sy] of [[5, 5, 1, 1], [MW - 5, 5, -1, 1], [5, MH - 5, 1, -1], [MW - 5, MH - 5, -1, -1]]) {
        x.moveTo(cx + 0.5 * sx + 6 * sx, cy + 0.5 * sy); x.lineTo(cx + 0.5 * sx, cy + 0.5 * sy); x.lineTo(cx + 0.5 * sx, cy + 0.5 * sy + 6 * sy);
      }
      x.moveTo(MW / 2 + 0.5, 0); x.lineTo(MW / 2 + 0.5, 4);
      x.stroke();
      x.globalAlpha = 0.75; x.fillStyle = ink.t3; x.font = "10px " + font; x.textAlign = "center"; x.textBaseline = "top";
      x.fillText("N", MW / 2, 5);
      if (!fit) { x.globalAlpha = 1; return; }
      // clusters: dim dashed hairline circles
      x.setLineDash([2, 3]); x.strokeStyle = ink.edge; x.globalAlpha = 0.5;
      U.clusters.forEach((_c, k) => {
        const c = U.centerOf("cluster", k), r = U.radiusOf("cluster", k);
        if (!c || !(r > 0)) return;
        const p = toMap(c[0], c[1]);
        x.beginPath(); x.arc(p[0], p[1], Math.max(2, r * fit.k), 0, 2 * Math.PI); x.stroke();
      });
      x.setLineDash([]);
      // galaxies: faint disc + ring in the muted group accent
      U.galaxies.forEach((G, k) => {
        const c = U.centerOf("galaxy", k), r = U.radiusOf("galaxy", k);
        if (!c) return;
        const p = toMap(c[0], c[1]), R = Math.max(1.6, r * fit.k), col = ink["g" + Math.min(3, Math.max(0, G.cluster | 0))];
        x.fillStyle = col; x.strokeStyle = col;
        x.globalAlpha = 0.09; x.beginPath(); x.arc(p[0], p[1], R, 0, 2 * Math.PI); x.fill();
        x.globalAlpha = 0.5; x.stroke();
      });
      // the three largest visible suns: ring + dot
      const big = U.systems.map((y, j) => j).filter(j => S.nodeVisible[U.systems[j].sun]).sort((a, b) => U.systems[b].size - U.systems[a].size).slice(0, 3);
      x.strokeStyle = ink.hi; x.fillStyle = ink.hi; x.globalAlpha = 0.6;
      for (const j of big) {
        const i = U.systems[j].sun, p = toMap(S.x[i], S.y[i]);
        x.beginPath(); x.arc(p[0], p[1], 2.6, 0, 2 * Math.PI); x.stroke();
        x.beginPath(); x.arc(p[0], p[1], 0.9, 0, 2 * Math.PI); x.fill();
      }
      x.globalAlpha = 1;
      sig = "";
    }

    // ---- camera read (accessors only)
    function camRead() {
      const v = C.view || {}, T = C.target(), sr = C.safeRect ? C.safeRect() : null;
      const F = v.F > 0 ? v.F : 1, D = v.D > 0 ? v.D : 1;
      return {T, yaw: v.yaw || 0, pitch: v.pitch || 0, s: F / D, F,
        hw: sr ? (sr.r - sr.l) / 2 : 400, hh: sr ? (sr.b - sr.t) / 2 : 300};
    }
    const fmtN = v => (v < 0 ? "−" : "") + (Math.abs(v) >= 100 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1));

    // ---- live layer
    function drawLive(c) {
      const x = ctx;
      x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height); x.drawImage(stat, 0, 0);
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!fit || !c || !isFinite(c.T[0]) || !isFinite(c.T[1])) { marker = null; return; }
      const p = toMap(c.T[0], c.T[1]), k = fit.k, inside = p[0] >= 0 && p[0] <= MW && p[1] >= 0 && p[1] <= MH;
      const q = [Math.max(4, Math.min(MW - 4, p[0])), Math.max(4, Math.min(MH - 4, p[1]))];
      marker = p;
      // trail: the last few target positions (> 3 map px apart)
      const last = trail[trail.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 3) { trail.push(p); if (trail.length > TRAIL) trail.shift(); }
      x.fillStyle = ink.hi;
      for (let j = 0; j < trail.length - 1; j++) {
        x.globalAlpha = 0.08 + 0.3 * j / TRAIL;
        x.beginPath(); x.arc(trail[j][0], trail[j][1], 0.9, 0, 2 * Math.PI); x.fill();
      }
      x.strokeStyle = ink.hi; x.lineWidth = 1;
      if (Math.abs(c.pitch) < 0.05) {
        // 2D: the visible footprint (safe rect at the focal plane), rotated by yaw
        const hw = c.hw / c.s * k, hh = c.hh / c.s * k, cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
        x.save(); x.translate(p[0], p[1]); x.rotate(Math.atan2(sy, cy));
        x.globalAlpha = 0.06; x.fillStyle = ink.hi; x.fillRect(-hw, -hh, 2 * hw, 2 * hh);
        x.globalAlpha = 0.4; x.strokeRect(-hw + 0.5, -hh + 0.5, 2 * hw - 1, 2 * hh - 1);
        x.restore();
      } else {
        // 3D: FOV wedge along the ground heading (forward = (sin yaw, -cos yaw)), length = the focal-plane half height
        const a = Math.atan2(-Math.cos(c.yaw), Math.sin(c.yaw)) + (c.pitch < 0 ? Math.PI : 0), h = Math.atan(c.hw / c.F);
        const L = Math.max(12, Math.min(46, 0.7 * c.hh / c.s * k));
        const g = x.createRadialGradient(q[0], q[1], 0, q[0], q[1], L);
        g.addColorStop(0, ink.hi); g.addColorStop(1, "rgba(0,0,0,0)");
        x.globalAlpha = 0.14; x.fillStyle = g;
        x.beginPath(); x.moveTo(q[0], q[1]); x.arc(q[0], q[1], L, a - h, a + h); x.closePath(); x.fill();
        x.globalAlpha = 0.4; x.beginPath();
        x.moveTo(q[0] + Math.cos(a - h) * L, q[1] + Math.sin(a - h) * L); x.lineTo(q[0], q[1]); x.lineTo(q[0] + Math.cos(a + h) * L, q[1] + Math.sin(a + h) * L);
        x.stroke();
        x.globalAlpha = 0.25; x.setLineDash([1, 2]); x.beginPath(); x.arc(q[0], q[1], L, a - h, a + h); x.stroke(); x.setLineDash([]);
      }
      // crosshair: dot + four ticks (a hollow ring when the target is off the map)
      x.globalAlpha = 0.95; x.fillStyle = ink.hi; x.strokeStyle = ink.hi;
      x.beginPath(); x.arc(q[0], q[1], inside ? 1.9 : 2.6, 0, 2 * Math.PI); inside ? x.fill() : x.stroke();
      x.globalAlpha = 0.7; x.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { x.moveTo(q[0] + dx * 4, q[1] + dy * 4); x.lineTo(q[0] + dx * 8, q[1] + dy * 8); }
      x.stroke();
      x.globalAlpha = 1;
      // read-out
      const z = C.fitAll > 0 ? c.s / C.fitAll : NaN, xy = "X " + fmtN(c.T[0]) + " Y " + fmtN(c.T[1]);
      const zs = !(z > 0 && isFinite(z)) ? "—" : z < 0.1 ? "×<0.1" : "×" + z.toFixed(z >= 10 ? 0 : 1);   // never ×0.0 / ×NaN
      if (xyEl.textContent !== xy) xyEl.textContent = xy;
      if (zEl.textContent !== zs) zEl.textContent = zs;
      const aria = "Minimap: top-down overview of the universe, north up. Camera at x " + fmtN(c.T[0]) + ", y " + fmtN(c.T[1]) +
        ", zoom " + zs + ". Click to fly there, drag to pan, scroll to zoom, M hides it.";
      if (aria !== lastAria) { lastAria = aria; el.setAttribute("aria-label", aria); }
    }

    // ---- loop: poll the camera signature <= 15 fps while visible; stops when hidden, woken by events
    const visible = () => shown && !el.hidden && S.view === "graph" && !document.hidden &&
      (el.classList.contains("mm-empty") || el.getClientRects().length > 0);   // empty: keep checking, it may fill
    let movedAt = 0, spinT = 0, polls = 0, lookAgain = false;
    function tick(force) {
      if (!visible() && !force) return false;
      if (staticDirty || DPR() !== dpr) buildStatic();
      const c = camRead(), s = c.T.join(",") + "|" + c.yaw + "|" + c.pitch + "|" + c.s + "|" + c.hw + "|" + c.hh + "|" + (C.fitAll || 0);
      if (s !== sig || force) { if (s !== sig) movedAt = performance.now(); sig = s; drawLive(c); }
      return true;
    }
    const spinning = () => { try { const f = MX.statusExt.camera; return !!(f && f().spin); } catch (e) { return false; } };
    function loop() {
      timer = 0; polls++;
      if (!tick()) return;
      if (performance.now() - movedAt < STILL || spinning()) { timer = setTimeout(loop, TICK); return; }
      // still: stop polling. render emits no camera event and its idle spin starts 20 s after the last input: look
      // once more then (not again until the next real wake)
      if (lookAgain) { lookAgain = false; clearTimeout(spinT); spinT = setTimeout(() => wake(true), SPINLOOK); }
    }
    function wake(fromLook) {
      movedAt = performance.now();
      if (fromLook !== true) lookAgain = true;
      if (!timer) timer = setTimeout(loop, 0);
    }
    const dirty = () => { staticDirty = true; wake(); };
    for (const ev of ["settled", "repack", "visibility", "theme"]) MX.on(ev, dirty);
    for (const ev of ["view", "view3d", "ready", "flyto", "chrome", "select", "focus", "path", "camera"]) MX.on(ev, wake);
    window.addEventListener("resize", dirty);
    document.addEventListener("visibilitychange", wake);
    // camera input (drag, wheel, keys): capture phase, passive; any of it may move the camera
    stage.addEventListener("pointerdown", wake, {capture: true, passive: true});
    stage.addEventListener("pointermove", e => { if (e.buttons) wake(); }, {capture: true, passive: true});
    stage.addEventListener("wheel", wake, {capture: true, passive: true});
    document.addEventListener("keydown", wake, {capture: true, passive: true});

    function setShown(on, quiet) {
      shown = !!on; el.hidden = !shown;
      if (!quiet) {
        try { localStorage.setItem(KEY, shown ? "1" : "0"); } catch (e) { /* storage blocked */ }
        if (MX.announce) MX.announce(shown ? "Minimap shown" : "Minimap hidden");
      }
      if (shown) { sig = ""; wake(); }
      MX.status();
    }
    document.addEventListener("keydown", e => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (e.key !== "m" && e.key !== "M")) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (S.view !== "graph") return;
      e.preventDefault();
      setShown(!shown);
    });

    // ---- interaction
    const local = e => { const r = cv.getBoundingClientRect(); return [Math.max(0, Math.min(MW, e.clientX - r.left)), Math.max(0, Math.min(MH, e.clientY - r.top))]; };
    function goTo(m, instant) {
      if (!fit) return false;
      const w = toWorld(m[0], m[1]), c = camRead();
      const ok = C.flyTo({x: w[0], y: w[1], z: c.T[2] || 0, scale: c.s}, {instant: !!instant || !MX.motionOK()});
      wake();
      return ok;
    }
    let drag = null;
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      drag = {id: e.pointerId, m0: local(e), moved: false};
    });
    el.addEventListener("pointermove", e => {
      if (!drag || e.pointerId !== drag.id) return;
      const m = local(e);
      if (!drag.moved && Math.hypot(m[0] - drag.m0[0], m[1] - drag.m0[1]) < 3) return;
      drag.moved = true;
      goTo(m, true);
    });
    const up = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      if (e.type === "pointerup" && !d.moved) goTo(local(e), false);
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", e => {
      e.preventDefault();
      const sr = C.safeRect ? C.safeRect() : null;
      C.zoomBy(Math.exp(-e.deltaY * 0.0012), sr ? (sr.l + sr.r) / 2 : null, sr ? (sr.t + sr.b) / 2 : null);
      wake();
    }, {passive: false});

    MX.statusExt.minimap = () => ({shown, visible: visible(), polling: !!timer, polls, empty: !fit,
      marker: marker ? [Math.round(marker[0] * 10) / 10, Math.round(marker[1] * 10) / 10] : null});
    wake();

    // ---- self-test: a programmatic pan moves the marker by world delta x map scale; a map click flies the target there
    MX.selftest.add("minimap.track", async () => {
      const was = shown, view0 = S.view;
      if (S.view !== "graph" && MX.dash && MX.dash.setView) MX.dash.setView("graph");
      setShown(true, true);
      const c0 = camRead();
      const fail = m => { throw new Error(m); };
      try {
        staticDirty = true;
        if (!S.nodesShown) MX.selftest.skip("no visible bodies to map");
        C.fit(0.88);                                  // from fit-all: a 90 px pan is a visible map step at any prior zoom
        if (!tick(true) || !fit || !marker) fail("minimap not drawn (fit " + !!fit + ")");
        const cA = camRead(), m0 = marker.slice();
        C.panBy(-90, 40);
        tick(true);
        const c1 = camRead(), m1 = marker.slice();
        const ex = (c1.T[0] - cA.T[0]) * fit.k, ey = (c1.T[1] - cA.T[1]) * fit.k;
        if (Math.hypot(ex, ey) < 0.5) fail("pan did not move the target on the map: " + [ex, ey]);
        if (Math.abs(m1[0] - m0[0] - ex) > 0.5 || Math.abs(m1[1] - m0[1] - ey) > 0.5) fail("marker moved " + [m1[0] - m0[0], m1[1] - m0[1]] + " expected " + [ex, ey]);
        // click 30 px from the marker (kept inside the map), expect the target to land on that world point
        const mx = Math.max(PAD, Math.min(MW - PAD, m1[0] + (m1[0] > MW / 2 ? -30 : 30))), my = Math.max(PAD, Math.min(MH - PAD, m1[1] + (m1[1] > MH / 2 ? -24 : 24)));
        const P = toWorld(mx, my), d0 = Math.hypot(c1.T[0] - P[0], c1.T[1] - P[1]), r = cv.getBoundingClientRect();
        const o = {bubbles: true, cancelable: true, button: 0, pointerId: 41, pointerType: "mouse", clientX: r.left + mx, clientY: r.top + my};
        cv.dispatchEvent(new PointerEvent("pointerdown", o));
        cv.dispatchEvent(new PointerEvent("pointerup", o));
        for (let t = 0; t < 100 && C.flying; t++) await new Promise(res => setTimeout(res, 30));
        tick(true);
        const c2 = camRead(), d2 = Math.hypot(c2.T[0] - P[0], c2.T[1] - P[1]);
        if (!(d2 < 0.05 * d0 + 1e-3)) fail("click: target " + d2.toFixed(3) + " from the clicked point (was " + d0.toFixed(3) + ")");
        if (Math.hypot(marker[0] - mx, marker[1] - my) > 1) fail("marker not at the clicked point: " + marker + " vs " + [mx, my]);
      } finally {
        C.flyTo({x: c0.T[0], y: c0.T[1], z: c0.T[2] || 0, scale: c0.s}, {instant: true});
        setShown(was, true);
        if (view0 !== S.view && MX.dash && MX.dash.setView) MX.dash.setView(view0);
        trail = []; sig = ""; wake();
      }
    }, {timeout: 8000});
  });
})();
