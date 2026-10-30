(function () {
  "use strict";
  // cosmos.js: UI touches left after the page sky was removed. Sheen beam alignment
  // (--cz-bx/--cz-by on glass), warp streaks on #cosmos-fx (above the graph, below the glass,
  // clipped to the open canvas; the only rAF, alive <= 300 ms), orbital loader. Hover glow,
  // prism hairline, pane arrival: CSS (cosmos.css). Colours: --cosmos-* via a probe span.
  // Gate: RM, data-anim=0, MX.state.anim false, hidden, forced colours -> .cosmos-still, no rAF.
  const MX = window.MX || null;
  const root = document.documentElement;
  const LS = 0.5;                                        // fx canvas resolution scale
  const DUR = {view: 280, fly: 240};                     // warp length, ms (<= 300)
  const rmq = matchMedia("(prefers-reduced-motion: reduce)");
  const fcq = matchMedia("(forced-colors: active)");

  let probeEl = null, cvFx = null, fctx = null, fxDirty = false, clipRect = null;
  let C = {warp: [0, 0, 0, 0]}, W = 0, H = 0;
  let warp = null, warpTimer = 0, raf = 0, booted = 0;
  const force = {rm: null, hidden: null};
  const perf = {frames: 0, warps: 0, staticDraws: 0, js: new Float32Array(600), jn: 0};

  // ---- colours ----
  function parse(s) {
    const m = /rgba?\(([^)]+)\)/.exec(s || "");
    if (!m) return [0, 0, 0, 0];
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
  }
  const rgba = (c, a) => "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + Math.max(0, Math.min(1, c[3] * a)).toFixed(3) + ")";
  function probe() {
    probeEl.style.color = "var(--cosmos-warp)";
    C = {warp: parse(getComputedStyle(probeEl).color)};
  }

  // ---- geometry: beam alignment + the open canvas clip ----
  function alignBeam() {  // all reads, then all writes: one layout, no read-after-write thrash
    const rs = [...document.querySelectorAll(".glass, .glass-strong")].map(el => [el, el.getBoundingClientRect()]);
    for (const [el, r] of rs) {
      if (!r.width) continue;
      el.style.setProperty("--cz-bx", (-r.left).toFixed(0) + "px");
      el.style.setProperty("--cz-by", (-r.top).toFixed(0) + "px");
    }
  }
  // open canvas = viewport minus fixed chrome, intersected with MX.camera.safeRect(): no glass re-blurs
  function safeRect() {
    let l = 0, t = 0, r = W, b = H;
    for (const el of document.querySelectorAll("[data-overlay], .glass, .glass-strong")) {
      if (el.closest("#stage") || el.classList.contains("pane")) continue;
      const q = el.getBoundingClientRect();
      if (!q.width || !q.height || getComputedStyle(el).position !== "fixed") continue;
      if (q.width > W * 0.5) { if (q.top + q.height / 2 < H / 2) t = Math.max(t, q.bottom); else b = Math.min(b, q.top); }
      else if (q.left + q.width / 2 < W / 2) l = Math.max(l, q.right);
      else r = Math.min(r, q.left);
    }
    try {
      const k = MX && MX.camera && MX.camera.safeRect && MX.camera.safeRect();
      if (k && k.r > k.l) { l = Math.max(l, k.l); t = Math.max(t, k.t); r = Math.min(r, k.r); if (k.b != null) b = Math.min(b, k.b); }
    } catch (e) { /* DOM measurement stands */ }
    return {l, t, r: Math.max(l, r), b: Math.max(t, b)};
  }
  function layout() {
    if (!cvFx) return;
    W = Math.max(1, innerWidth); H = Math.max(1, innerHeight);
    cvFx.width = Math.ceil(W * LS); cvFx.height = Math.ceil(H * LS);
    fxDirty = false;
    const sr = safeRect(), l = Math.max(0, sr.l | 0), t = Math.max(0, sr.t | 0);  // reads before alignBeam's writes
    alignBeam();
    const r = Math.min(W, Math.ceil(sr.r)), b = Math.min(H, Math.ceil(sr.b));
    clipRect = {l, t, r, b};
    cvFx.style.clipPath = "inset(" + t + "px " + (W - r) + "px " + (H - b) + "px " + l + "px)";
  }
  let rsT = 0;
  const onResize = () => { clearTimeout(rsT); rsT = setTimeout(layout, 150); };
  const onTheme = () => { if (probeEl) probe(); };

  // ---- motion gate ----
  function motionOK() {
    if (force.rm != null ? force.rm : rmq.matches) return false;
    if (root.dataset.anim === "0") return false;
    if (MX && MX.state && MX.state.anim === false) return false;
    if (force.hidden != null ? force.hidden : document.hidden) return false;
    return !fcq.matches;
  }
  function gate() {
    if (!cvFx) return;
    const ok = motionOK();
    root.classList.toggle("cosmos-still", !ok);
    if (ok) { kick(); return; }
    if (raf) cancelAnimationFrame(raf);
    raf = 0; endWarp();
    if (fxDirty) { fctx.setTransform(1, 0, 0, 1, 0, 0); fctx.clearRect(0, 0, cvFx.width, cvFx.height); fxDirty = false; }
    perf.staticDraws++;
  }
  function kick() { if (!raf && warp && motionOK()) raf = requestAnimationFrame(frame); }

  // ---- frame: only while a warp lives ----
  function frame(now) {
    raf = 0;
    if (!motionOK()) { gate(); return; }
    const t0 = performance.now();
    perf.frames++;
    drawFx(now);
    perf.js[perf.jn++ % perf.js.length] = performance.now() - t0;
    if (warp && motionOK()) raf = requestAnimationFrame(frame);
  }
  function drawFx(now) {
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, cvFx.width, cvFx.height);
    fxDirty = !!warp;
    if (!warp) return;
    const p = (now - warp.t0) / warp.dur;
    if (p >= 1) { endWarp(); fxDirty = false; return; }
    fctx.setTransform(LS, 0, 0, LS, 0, 0);
    const a = Math.sin(Math.PI * Math.max(0, p)), reach = warp.R * 0.9 * Math.pow(Math.max(0, p), 1.4);
    fctx.strokeStyle = rgba(C.warp, 1); fctx.lineCap = "round";
    for (let b = 0; b < 3; b++) {
      fctx.globalAlpha = a * (0.28 + 0.3 * b); fctx.lineWidth = 0.7 + 0.6 * b;
      fctx.beginPath();
      for (const s of warp.s) {
        if (s.b !== b) continue;
        const rr = s.r0 + reach * s.v, len = Math.max(3, warp.R * 0.34 * a * s.v), r0 = Math.max(0, rr - len);
        fctx.moveTo(warp.x + s.cx * r0, warp.y + s.cy * r0);
        fctx.lineTo(warp.x + s.cx * rr, warp.y + s.cy * rr);
      }
      fctx.stroke();
    }
    fctx.globalAlpha = 1;
  }

  // ---- warp ----
  function warpTo(x, y, kind) {
    if (!cvFx || !motionOK() || performance.now() < booted) return false;
    const fly = kind === "fly", n = fly ? 120 : 180, r = Math.random;
    const R = Math.hypot(Math.max(x, W - x), Math.max(y, H - y)), s = [];
    for (let i = 0; i < n; i++) {
      const th = r() * 6.2832;
      s.push({cx: Math.cos(th), cy: Math.sin(th), r0: 6 + Math.pow(r(), 0.7) * R * 0.45, v: 0.55 + r() * 0.8, b: (r() * 3) | 0});
    }
    warp = {t0: performance.now(), dur: fly ? DUR.fly : DUR.view, x, y, R, s};
    perf.warps++;
    root.classList.remove("cz-warping");
    if (!fly) { void root.offsetWidth; root.classList.add("cz-warping"); }   // restart pane arrival
    clearTimeout(warpTimer);
    warpTimer = setTimeout(endWarp, warp.dur + 40);
    kick();
    return true;
  }
  function endWarp() {
    warp = null; clearTimeout(warpTimer);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }   // a stalled frame must not outlive the warp
    if (fxDirty && fctx) { fctx.setTransform(1, 0, 0, 1, 0, 0); fctx.clearRect(0, 0, cvFx.width, cvFx.height); fxDirty = false; }
    root.classList.remove("cz-warping");
  }
  function centre() {
    let l = 0, t = 0, rr = W, b = H;
    try { if (MX && MX.camera && MX.camera.safeRect) ({l, t, r: rr, b} = MX.camera.safeRect()); } catch (e) { /* default */ }
    return [(l + rr) / 2, (t + b) / 2];
  }

  // ---- orbital loading indicator ----
  function orbit(size) {
    const o = document.createElement("span");
    o.className = "cz-orbit"; o.setAttribute("aria-hidden", "true");
    if (size) o.style.setProperty("--cz-s", size + "px");
    o.innerHTML = '<i class="cz-sun"></i><i class="cz-ring"><b></b></i><i class="cz-ring cz-r2"><b></b></i>';
    return o;
  }
  function watchBusy() {
    const el = document.getElementById("layout-status");
    if (!el) return;
    const sync = () => {
      if (!el.querySelector(".cz-orbit") && el.firstChild) el.appendChild(orbit(18));
      el.classList.toggle("cz-busy", /settling|building|loading/i.test(el.textContent || ""));
    };
    new MutationObserver(sync).observe(el, {childList: true, subtree: true, characterData: true});
    sync();
  }

  // ---- init ----
  let inited = false;
  function init() {
    if (inited || !document.body) return;
    inited = true;
    probeEl = document.createElement("span"); probeEl.className = "cz-probe"; probeEl.setAttribute("aria-hidden", "true");
    cvFx = document.createElement("canvas"); cvFx.id = "cosmos-fx"; cvFx.setAttribute("aria-hidden", "true");
    fctx = cvFx.getContext("2d");
    document.body.append(probeEl, cvFx);
    // root class + probe/geometry reads after render.js frame 1 (MX "ready", same task, before paint): no forced
    // style recalc / layout between MX.boot and frame 1
    const geo = () => { root.classList.add("cosmos"); probe(); layout(); gate(); };
    booted = performance.now() + 400;                 // the boot-time view/flyto events do not warp
    if (MX && MX.module && MX.on) MX.on("ready", geo); else geo();
    addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", gate);
    rmq.addEventListener("change", gate);
    fcq.addEventListener("change", gate);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onTheme);
    new MutationObserver(ms => {
      for (const m of ms) (m.attributeName === "data-anim" ? gate : onTheme)();
    }).observe(root, {attributes: true, attributeFilter: ["data-anim", "data-theme"]});
    if (MX && MX.on) {
      MX.on("theme", onTheme);
      MX.on("anim", gate);
      MX.on("view", () => { layout(); const [x, y] = centre(); warpTo(x, y, "view"); gate(); });
      MX.on("chrome", layout);
      MX.on("flyto", d => {
        const c = centre(), x = d && isFinite(d.sx) ? +d.sx : c[0], y = d && isFinite(d.sy) ? +d.sy : c[1];
        warpTo(x, y, "fly");
      });
    }
    watchBusy();
    if (MX && MX.selftest) addTests();
  }

  // ---- public API ----
  const api = {
    stats() {
      const n = Math.min(perf.jn, perf.js.length), v = Array.from(perf.js.subarray(0, n)).sort((a, b) => a - b);
      return {frames: perf.frames, warps: perf.warps, staticDraws: perf.staticDraws, raf: !!raf, warping: !!warp,
              still: root.classList.contains("cosmos-still"), motion: motionOK(),
              jsAvgMs: n ? v.reduce((a, b) => a + b, 0) / n : 0, jsP95Ms: n ? v[Math.floor(n * 0.95)] : 0,
              jsSamples: n, clip: clipRect, colors: C};
    },
    warp(x, y, kind) { const c = centre(); return warpTo(x == null ? c[0] : x, y == null ? c[1] : y, kind); },
    orbit, refresh: () => { probe(); layout(); },
    resetPerf() { perf.js.fill(0); perf.jn = 0; },
    _force(o) { Object.assign(force, o); gate(); },
  };
  if (MX) MX.cosmos = api; else window.KBcosmos = api;

  // ---- self-tests (registered by init) ----
  const wait = ms => new Promise(r => setTimeout(r, ms));
  function addTests() {
    MX.selftest.add("cosmos.layer", () => {
      if (!root.classList.contains("cosmos")) throw new Error("html.cosmos missing");
      if (document.getElementById("cosmos")) throw new Error("page sky still present");
      const fx = document.getElementById("cosmos-fx");
      if (!fx || !/inset/.test(fx.style.clipPath)) throw new Error("#cosmos-fx missing or unclipped");
      if (!(C.warp[3] > 0)) throw new Error("--cosmos-warp not probed");
      const g = document.querySelector(".glass, .glass-strong");
      if (g && g.getBoundingClientRect().width && !g.style.getPropertyValue("--cz-bx")) throw new Error("sheen beam not aligned");
      const st = api.stats();
      if (!st.warping && st.raf) throw new Error("rAF scheduled with no warp");
    });
    MX.selftest.add("cosmos.warpIdle", async () => {
      if (!motionOK()) return;                      // RM / hidden: rmStatic + hiddenPause
      const b0 = booted;
      booted = 0;
      try {
        if (!warpTo(W / 2, H / 2, "view")) throw new Error("warp refused with motion on");
        if (warp.dur > 300) throw new Error("warp longer than 300 ms: " + warp.dur);
        await wait(DUR.view + 120);
        const st = api.stats();
        if (st.warping || st.raf) throw new Error("warp did not end: warping=" + st.warping + " raf=" + st.raf);
        if (root.classList.contains("cz-warping")) throw new Error("cz-warping left on");
        const f1 = perf.frames;
        await wait(200);
        if (perf.frames !== f1) throw new Error("frames after the warp ended");
      } finally { booted = b0; endWarp(); }
    });
    MX.selftest.add("cosmos.rmStatic", async () => {
      const prev = root.dataset.anim, sd0 = perf.staticDraws;
      try {
        api._force({rm: true});
        let st = api.stats();
        if (!st.still || st.raf || st.motion) throw new Error("RM: still=" + st.still + " raf=" + st.raf);
        if (perf.staticDraws <= sd0) throw new Error("RM: gate not applied");
        if (warpTo(W / 2, H / 2, "view")) throw new Error("RM: warp ran");
        api._force({rm: null});
        root.dataset.anim = "0";
        await wait(60);
        st = api.stats();
        if (!st.still || st.raf) throw new Error("data-anim=0: still=" + st.still + " raf=" + st.raf);
        if (warpTo(W / 2, H / 2, "view")) throw new Error("data-anim=0: warp ran");
      } finally {
        api._force({rm: null});
        if (prev === undefined) delete root.dataset.anim; else root.dataset.anim = prev;
        await wait(30);
      }
    });
    MX.selftest.add("cosmos.hiddenPause", async () => {
      try {
        api._force({hidden: true});
        const st = api.stats();
        if (!st.still || st.raf) throw new Error("hidden: still=" + st.still + " raf=" + st.raf);
        const f0 = perf.frames;
        await wait(300);
        if (perf.frames !== f0) throw new Error("hidden: frames advanced " + (perf.frames - f0));
      } finally { api._force({hidden: null}); }
      if (api.stats().raf) throw new Error("visible again: rAF with nothing to animate");
    });
  }

  // MX.module runs init at boot (before #selftest=); the timeout covers a late load
  if (MX && MX.module) MX.module("cosmos", init);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(init, 0));
  else setTimeout(init, 0);
})();
