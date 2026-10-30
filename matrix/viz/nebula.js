(function () {
  "use strict";
  // MX.nebula (14d; design v3 recipe): world-locked gas + glow ON clusters/galaxies, one low-res world
  // texture rebuilt on repack/settled/theme. Cluster --glow-g wash; per galaxy a --gas-g body, clumps anchored on its
  // members (follow arms + orbits; update() recomposes on drift) tinted to --gas-g<n>-b by distance, --glow-g core.
  // Inks: theme probe (rgb = ceiling, a = per-blob alpha); without --gas-* the glowG inks stand in, capped by R.CAP.
  // Texture is source-over; scene: dark add/screen, light over/multiply. Off: forced colours, reduced transparency.
  // GL: gl.texture(t.canvas) per t.version; gl.draw({tex: alpha(band), texOff: texOff(cam, W, H), add: t.add}).
  // 2D: draw(ctx, cam, W, H, band). Camera: screen = world * scale + pan + size / 2 (CSS px).
  // Near mode (U2+, visual polish): the view sits inside one galaxy, so the world texture would be a flat wash.
  // Instead a view-local texture (SPAN x the view) holds gas around each on-screen system (sun-anchored, radius
  // ~ system radius) plus an optional faint galaxy medium, recomposed when the view leaves it or zoom drifts x ZOOM.
  const MX = window.MX;
  if (!MX || !MX.state) return;
  const S = MX.state, M = Math;
  const R = {  // recipe: radii x R_gal / R_cl, alphas x token alpha
    PX: 1024, SPR: 64, SEED: 20261015, MID: [0.5, 0.45],  // tex px, sprite px, seed, stop 0.5 -> 0.45 a
    CL_R: 1.1, CL_A: 0.6,  // cluster wash (--glow-g)
    BODY_R: 1.9, BODY_A: 0.8,  // galaxy gas body (--gas-g)
    PER_LOG2: 1.6, CLUMP_R: [0.6, 1.2], CLUMP_A: 0.9, DUST_REDRAW: 0.6, HUE: 0.8,  // clumps, rim mix (d / R_gal)^HUE
    CORE_R: 0.5, CORE_A: 0.8,  // core glow (--glow-g), drawn last
    CAP: [0.5, 0.35],  // [dark, light] layer alpha without --gas-* tokens
    BAND: [[0.06, 0.06, 0.055, 0.045, 0.04], [0.06, 0.055, 0.05, 0.04, 0.035]],  // [dark, light] layer alpha per band U0..U4 (a whisper)
    NEAR: {PX: 768, SPAN: 2, ZOOM: 1.6, SYS_R: 2.2, SYS_A: 0.8, CORE_R: 0.55, CORE_A: 0.55, MIN_PX: 6, MED: [0.18, 0], CAP: 400},
    DRIFT: 0.75, GAP: 250,  // recompose: anchor moved > DRIFT texels, >= GAP ms apart
  };
  const U = () => (MX.universe && MX.universe.started ? MX.universe : null);
  let cv = null, ctx = null, k = 1, rx = 0, ry = 0, cw = 0, ch = 0, dirty = true, key = "", ver = 0, on = false, dark = true;
  let spr = [], ink = [], gas = false, blobs = [], sent = [], snap = [], lastT = 0, buildMs = 0, composeMs = 0;
  let near = null, far = null, nScale = 0, vw = 0, vh = 0;  // near: {x0, y0, x1, y1} view-local region; far: saved world tex

  function rngOf(a) {  // mulberry32
    a >>>= 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = M.imul(a ^ (a >>> 15), 1 | a); t = (t + M.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function canvas(w, h) {
    if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
    const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
  }
  // ink[group] = [gas core, gas rim, glow], [r, g, b, a] 0..1
  function inks() {                            // theme.js probe keys gasG<n> (--gas-g<n>), gasB<n> (--gas-g<n>-b), glowG<n>
    const q = S.theme.rgba;
    gas = !!(q.gasG0 && getComputedStyle(document.documentElement).getPropertyValue("--gas-g0").trim());
    ink = [0, 1, 2, 3].map(g => gas ? [q["gasG" + g], q["gasB" + g], q["glowG" + g]] : [q["glowG" + g], q["glowG" + g], q["glowG" + g]]);
  }
  // spr[group] = [core -> rim at t = 0 .. 1 in 1/4 steps, glow]; radial a: 1 -> MID -> 0
  function sprites() {
    const kk = JSON.stringify(ink);
    if (kk === key) return;
    key = kk; spr = [];
    const n = R.SPR, h = n / 2, m0 = R.MID[0], m1 = R.MID[1];
    for (let g = 0; g < 4; g++) {
      const row = [];
      for (let v = 0; v < 6; v++) {
        const s = canvas(n, n), x2 = s.getContext("2d"), im = x2.createImageData(n, n), d = im.data, t = v / 4;
        const c = v > 4 ? ink[g][2] : [0, 1, 2].map(i => ink[g][0][i] + (ink[g][1][i] - ink[g][0][i]) * t);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const r = M.hypot(x + 0.5 - h, y + 0.5 - h) / h, o = 4 * (y * n + x);
          if (r >= 1) continue;
          d[o] = c[0] * 255; d[o + 1] = c[1] * 255; d[o + 2] = c[2] * 255;
          d[o + 3] = 255 * (r < m0 ? 1 + (m1 - 1) * r / m0 : m1 * (1 - r) / (1 - m0));
        }
        x2.putImageData(im, 0, 0); row.push(s);
      }
      spr.push(row);
    }
  }
  function enabled() {
    const th = S.theme;
    return !!(U() && th && th.rgba && !th.forced && !(th.glass && th.glass.reducedTransparency));
  }
  function build() {
    const t0 = performance.now();
    dirty = false; on = enabled(); blobs = []; sent = []; near = far = null;
    if (on) { dark = S.theme.blend === "lighter"; inks(); sprites(); layout(U()); }
    if (!blobs.length) { on = false; cv = ctx = null; }
    buildMs = performance.now() - t0;
    if (S.perf) S.perf.nebulaMs = buildMs;
  }
  // blob = [group, sprite, alpha, radius (world), anchor body | -1, "cluster" | "galaxy", index]
  function layout(u) {
    const N = MX.g.N, vis = S.nodeVisible, X = S.x, Y = S.y, nG = u.galaxies.length, rnd = rngOf(R.SEED);
    const mem = u.galaxies.map(() => []), maxR = new Float64Array(u.clusters.length), core = [];
    for (let i = 0; i < N; i++) if (vis[i]) mem[u.galaxyOf(i)].push(i);
    u.clusters.forEach((_, c) => { if (u.centerOf("cluster", c)) blobs.push([c & 3, 5, ink[c & 3][2][3] * R.CL_A, u.radiusOf("cluster", c) * R.CL_R, -1, "cluster", c]); });
    for (let gk = 0; gk < nG; gk++) {
      const m = mem[gk], p = u.centerOf("galaxy", gk), Rg = u.radiusOf("galaxy", gk), cl = u.galaxies[gk].cluster, g = cl & 3, a = ink[g][0][3];
      if (!m.length || !p || !(Rg > 0)) continue;
      blobs.push([g, 0, a * R.BODY_A, Rg * R.BODY_R, -1, "galaxy", gk]);
      const nb = M.ceil(R.PER_LOG2 * M.log2(m.length + 1)), sa = a * R.CLUMP_A / M.sqrt(M.max(1, nb / 6));
      for (let b = 0; b < nb; b++) {
        let j = m[(rnd() * m.length) | 0];
        if (u.role[j] === 2 && rnd() < R.DUST_REDRAW) j = m[(rnd() * m.length) | 0];
        const d = M.min(1, M.hypot(X[j] - p[0], Y[j] - p[1]) / Rg);
        blobs.push([g, M.round(4 * d ** R.HUE), sa, Rg * (R.CLUMP_R[0] + rnd() * (R.CLUMP_R[1] - R.CLUMP_R[0])), j]);
      }
      core.push([g, 5, ink[g][2][3] * R.CORE_A, Rg * R.CORE_R, -1, "galaxy", gk]);
      sent.push(m[0]);
      maxR[cl] = M.max(maxR[cl], Rg * (R.BODY_R + 0.3));  // body and clumps (<= 2.2 R_gal)
    }
    blobs.push(...core);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    u.clusters.forEach((_, c) => {  // rect holds every orbit phase
      const p = u.centerOf("cluster", c), r = u.radiusOf("cluster", c), e = M.max(r * R.CL_R, r + maxR[c]);
      if (p) { x0 = M.min(x0, p[0] - e); y0 = M.min(y0, p[1] - e); x1 = M.max(x1, p[0] + e); y1 = M.max(y1, p[1] + e); }
    });
    if (!(x1 > x0)) { blobs = []; return; }
    k = (R.PX - 4) / M.max(x1 - x0, y1 - y0);
    const [nw, nh] = sizeFor(x1 - x0, y1 - y0);
    rx = x0 - 2 / k; ry = y0 - 2 / k;
    if (!cv || cw !== nw || ch !== nh) { cv = canvas(nw, nh); ctx = cv.getContext("2d"); cw = nw; ch = nh; }
    compose();
  }
  function compose() {  // source-over: hue-true, coverage caps at the ceiling ink
    const t0 = performance.now(), u = U();
    ctx.globalAlpha = 1; ctx.clearRect(0, 0, cw, ch);
    for (const B of blobs) {
      const p = B[4] >= 0 ? [S.x[B[4]], S.y[B[4]]] : u.centerOf(B[5], B[6]), r = B[3] * k;
      if (!p || r < 0.5) continue;
      ctx.globalAlpha = M.min(1, B[2]);
      ctx.drawImage(spr[B[0]][B[1]], (p[0] - rx) * k - r, (p[1] - ry) * k - r, 2 * r, 2 * r);
    }
    ctx.globalAlpha = 1;
    snap = sent.map(i => [S.x[i], S.y[i]]);
    lastT = performance.now(); composeMs = lastT - t0; ver++;
  }
  // ---- near mode (U2+): gas around the on-screen systems of a view-local texture
  const swap = () => ({cv, ctx, k, rx, ry, cw, ch, sent});
  function restore(o) { ({cv, ctx, k, rx, ry, cw, ch, sent} = o); }
  function composeNear(cam, W, H) {
    const t0 = performance.now(), u = U(), Q = R.NEAR, s = cam.scale, mx = -cam.panX / s, my = -cam.panY / s;
    const hw = W / 2 / s * Q.SPAN, hh = H / 2 / s * Q.SPAN, x0 = mx - hw, y0 = my - hh, x1 = mx + hw, y1 = my + hh;
    if (!near) { far = swap(); cv = null; }
    near = {x0, y0, x1, y1}; nScale = s;
    k = (Q.PX - 4) / (2 * M.max(hw, hh));
    const nw = M.ceil(2 * hw * k) + 4, nh = M.ceil(2 * hh * k) + 4;
    rx = x0 - 2 / k; ry = y0 - 2 / k;
    if (!cv || cw !== nw || ch !== nh) { cv = canvas(nw, nh); ctx = cv.getContext("2d"); cw = nw; ch = nh; }
    ctx.globalAlpha = 1; ctx.clearRect(0, 0, cw, ch);
    const hit = (p, r) => p && p[0] + r > x0 && p[0] - r < x1 && p[1] + r > y0 && p[1] - r < y1;
    const blob = (g, v, a, x, y, r) => { r *= k; if (r < 0.5 || !(a > 0)) return; ctx.globalAlpha = M.min(1, a); ctx.drawImage(spr[g][v], (x - rx) * k - r, (y - ry) * k - r, 2 * r, 2 * r); };
    const med = Q.MED[dark ? 0 : 1];
    if (med > 0) u.galaxies.forEach((G, j) => {
      const p = u.centerOf("galaxy", j), Rg = u.radiusOf("galaxy", j) * R.BODY_R, g = G.cluster & 3;
      if (hit(p, Rg)) blob(g, 0, ink[g][0][3] * R.BODY_A * med, p[0], p[1], Rg);
    });
    const vis = S.nodeVisible, list = [];
    u.systems.forEach((y, j) => {
      const r = u.radiusOf("system", j), sun = y.sun;
      if (vis[sun] && r * s * Q.SYS_R >= Q.MIN_PX && hit([S.x[sun], S.y[sun]], r * Q.SYS_R)) list.push([r, sun]);
    });
    list.sort((a, b) => b[0] - a[0]).length = M.min(list.length, Q.CAP);
    for (const [r, sun] of list) { const g = MX.g.group[sun] & 3; blob(g, 1, ink[g][0][3] * Q.SYS_A, S.x[sun], S.y[sun], r * Q.SYS_R); }
    for (const [r, sun] of list) { const g = MX.g.group[sun] & 3; blob(g, 5, ink[g][2][3] * Q.CORE_A, S.x[sun], S.y[sun], r * Q.CORE_R); }
    ctx.globalAlpha = 1;
    sent = list.slice(0, 24).map(e => e[1]); snap = sent.map(i => [S.x[i], S.y[i]]);
    lastT = performance.now(); composeMs = lastT - t0; ver++;
  }
  function leaveNear() {
    restore(far); near = far = null;
    compose();  // world texture again, re-anchored to the current orbit phase
  }
  // true = texture changed. band >= 2 -> near texture covering the view; else the world texture
  function ensure(cam, W, H, band) {
    if (dirty) { build(); if (!on) return true; }
    if (!on || !cam || !(W > 0 && H > 0)) return false;
    if (band >= 2) {
      const s = cam.scale, mx = -cam.panX / s, my = -cam.panY / s, hw = W / 2 / s, hh = H / 2 / s, z = s / nScale;
      if (near && z < R.NEAR.ZOOM && z > 1 / R.NEAR.ZOOM && mx - hw >= near.x0 && mx + hw <= near.x1 && my - hh >= near.y0 && my + hh <= near.y1) return false;
      composeNear(cam, W, H); return true;
    }
    if (near) { leaveNear(); return true; }
    return false;
  }
  function viewSize() {
    // #cv-back's backing store = the view in CSS px (render.js sizes it at DPR 1): no forced layout at boot
    if (!(vw > 0)) { const c = document.getElementById("cv-back"); vw = c ? c.width : innerWidth; vh = c ? c.height : innerHeight; }
  }
  function update(now) {  // per frame; true = texture changed (re-upload)
    const was = ver;
    viewSize();
    ensure(S.camera, vw, vh, MX.camera && MX.camera.band >= 0 ? MX.camera.band : 0);
    if (!on) return ver !== was;
    if (ver !== was || (now || performance.now()) - lastT < R.GAP) return ver !== was;
    let d = 0;
    for (let j = 0; j < sent.length; j++) d = M.max(d, M.abs(S.x[sent[j]] - snap[j][0]), M.abs(S.y[sent[j]] - snap[j][1]));
    if (d * k <= R.DRIFT) return false;
    if (near) composeNear(S.camera, vw, vh); else compose();
    return true;
  }
  function texture() {
    if (dirty) build();
    return on ? {canvas: cv, rect: [rx, ry, rx + cw / k, ry + ch / k], version: ver, add: dark, w: cw, h: ch} : null;
  }
  // gl.js FS_TX samples tex(v * O.zw + O.xy), v = (0, 0) at the screen's bottom-left; canvas row 0 is t = 0 (no flip)
  function texOff(cam, W, H, out) {
    out = out || [0, 0, 1, 1];
    if (W > 0 && H > 0) { vw = W; vh = H; }
    const s = cam.scale, rw = cw / k, rh = ch / k;
    out[0] = (-W / 2 - cam.panX - s * rx) / (s * rw); out[2] = W / (s * rw);
    out[1] = (H / 2 - cam.panY - s * ry) / (s * rh); out[3] = -H / (s * rh);
    return out;
  }
  const alpha = band => (band == null ? 1 : R.BAND[dark ? 0 : 1][M.max(0, M.min(4, band | 0))]) * (gas ? 1 : R.CAP[dark ? 0 : 1]);
  function draw(c2, cam, W, H, band) {  // Canvas2D fallback, on top of the caller's (DPR) transform
    ensure(cam, W, H, band == null ? 0 : band);
    const t = texture();
    if (!t) return false;
    c2.save();
    c2.globalCompositeOperation = dark ? "screen" : "multiply"; c2.globalAlpha = alpha(band); c2.imageSmoothingEnabled = true;
    c2.translate(cam.panX + W / 2, cam.panY + H / 2); c2.scale(cam.scale, cam.scale);
    c2.drawImage(t.canvas, t.rect[0], t.rect[1], t.rect[2] - t.rect[0], t.rect[3] - t.rect[1]);
    c2.restore();
    return true;
  }
  // texture size for a w x h world rect: 2-texel clear border (CLAMP_TO_EDGE); the 1e-6 absorbs float error so the long side is exactly R.PX
  const sizeFor = (w, h) => { const q = (R.PX - 4) / M.max(w, h); return [w, h].map(e => M.min(R.PX, M.ceil(e * q - 1e-6) + 4)); };
  const r2 = x => M.round(x * 100) / 100;
  const stats = () => ({on, gas, w: cw, h: ch, blobs: blobs.length, near: !!near, buildMs: r2(buildMs), composeMs: r2(composeMs), version: ver, add: dark});
  const mark = () => { dirty = true; if (MX.requestDraw) MX.requestDraw(); };
  MX.nebula = {R, sizeFor, build: () => { dirty = true; build(); return stats(); }, update, texture, texOff, alpha, draw, stats, enabled};

  MX.module("nebula", () => {
    MX.on("repack", mark); MX.on("settled", mark); MX.on("theme", mark);
    (MX.statusExt || (MX.statusExt = {})).nebula = stats;
    if (!MX.selftest) return;
    const sk = m => (MX.selftest.skip ? MX.selftest.skip(m) : fail("n/a: " + m));
    const fail = m => { throw new Error(m); }, big = u => {
      let b = -1;
      u.galaxies.forEach((G, j) => { if (u.centerOf("galaxy", j) && (b < 0 || G.size > u.galaxies[b].size)) b = j; });
      return b;
    };
    MX.selftest.add("nebula.build", () => {
      if (!U() || !U().started || !S.nodeVisible.some(v => v)) sk("no visible body (empty graph)");
      const st = MX.nebula.build(), t = texture();
      if (!enabled()) { if (t) fail("texture while disabled"); return; }
      if (!t || !st.blobs || M.max(t.w, t.h) > R.PX) fail("texture " + JSON.stringify(st));
      const u = U(), p = u.centerOf("galaxy", big(u));
      if (!(ctx.getImageData((p[0] - rx) * k, (p[1] - ry) * k, 1, 1).data[3] > 0)) fail("no gas at the biggest galaxy");
    });
    MX.selftest.add("nebula.size", () => {
      let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
      const cases = [[939, 1025], [1025, 939], [1, 1], [1000, 1000.0000001]];
      for (let i = 0; i < 1000; i++) { const a = 1 + rnd() * 5000, m = i % 4; cases.push([a, m === 0 ? a * (1 + rnd() * 1e-6) : m === 1 ? a / (1 + rnd() * 500) : rnd() * 5000 + 1]); }
      for (const [w, h] of cases) {
        const z = MX.nebula.sizeFor(w, h), lo = M.min(...z), hi = M.max(...z);
        if (hi !== R.PX || lo < 5) fail("size " + [w, h] + " -> " + z);
      }
    });
    MX.selftest.add("nebula.worldLock", () => {
      const t = texture();
      if (!t) return;
      const u = U(), p = u.centerOf("galaxy", big(u)), Rg = u.radiusOf("galaxy", big(u)), W = 600, H = 600, c2 = canvas(W, H).getContext("2d");
      const got = [[-60, 20, 1], [90, -70, 1], [-90, 90, 1], [30, 40, 1.5]].map(([dx, dy, z]) => {
        const s = 70 / Rg * z, cam = {scale: s, panX: -p[0] * s + dx, panY: -p[1] * s + dy}, q = texOff(cam, W, H);
        const sx = p[0] * s + cam.panX + W / 2, sy = p[1] * s + cam.panY + H / 2, wr = 1.2 * Rg * s;
        const e = M.hypot(t.rect[0] + (sx / W * q[2] + q[0]) * (t.rect[2] - t.rect[0]) - p[0], t.rect[1] + ((1 - sy / H) * q[3] + q[1]) * (t.rect[3] - t.rect[1]) - p[1]) * s;
        if (!(e <= 2)) fail("texOff off by " + e.toFixed(2) + " px");
        c2.setTransform(1, 0, 0, 1, 0, 0); c2.clearRect(0, 0, W, H); draw(c2, cam, W, H, 1);
        const x0 = M.floor(sx - wr), y0 = M.floor(sy - wr), n = M.ceil(2 * wr), d = c2.getImageData(x0, y0, n, n).data;
        let sw = 0, ax = 0, ay = 0;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const fx = x0 + x + 0.5, fy = y0 + y + 0.5, a = (fx - sx) ** 2 + (fy - sy) ** 2 > wr * wr ? 0 : d[4 * (y * n + x) + 3];
          sw += a; ax += a * fx; ay += a * fy;
        }
        if (!sw) fail("no gas drawn");
        return [(ax / sw - W / 2 - cam.panX) / s, (ay / sw - H / 2 - cam.panY) / s, s];
      });
      for (const o of got) { const e = M.hypot(o[0] - got[0][0], o[1] - got[0][1]) * o[2]; if (!(e <= 2)) fail("centroid drifted " + e.toFixed(2) + " px"); }
    });
    MX.selftest.add("nebula.near", () => {  // U2+: view-local gas around systems, clear sky between; back at U1
      if (!texture()) return;
      const u = U();
      let b = -1;
      u.systems.forEach((y, j) => { if (S.nodeVisible[y.sun] && (b < 0 || y.size > u.systems[b].size)) b = j; });
      if (b < 0) sk("no visible solar system");
      const sun = u.systems[b].sun, s = 0.27, W = 1200, H = 800, cam = {scale: s, panX: -S.x[sun] * s, panY: -S.y[sun] * s};
      ensure(cam, W, H, 2);
      const t = texture();
      if (!near || !t) fail("no near texture at U2");
      if (t.rect[0] > S.x[sun] - W / 2 / s || t.rect[2] < S.x[sun] + W / 2 / s || t.rect[1] > S.y[sun] - H / 2 / s || t.rect[3] < S.y[sun] + H / 2 / s) fail("near texture misses the view");
      if (!(ctx.getImageData((S.x[sun] - rx) * k, (S.y[sun] - ry) * k, 1, 1).data[3] > 0)) fail("no gas at the biggest system");
      const d = ctx.getImageData(0, 0, cw, ch).data;
      let clear = 0;
      for (let j = 3; j < d.length; j += 4) clear += d[j] < 32;
      if (clear / (cw * ch) < 0.25) fail("near gas is a wash: " + M.round(100 * clear / (cw * ch)) + "% clear");
      const v = ver;
      if (ensure(cam, W, H, 2) || ver !== v) fail("recomposed with nothing changed");
      ensure(cam, W, H, 1);
      if (near || texture().w > R.PX) fail("did not return to the world texture at U1");
      if (MX.requestDraw) MX.requestDraw();
    });
  });
})();
