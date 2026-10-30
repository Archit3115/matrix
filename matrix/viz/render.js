(function () {
  "use strict";
  // render_core: per frame band (hysteresis, crossfade) -> universe step (motion) -> MX.scene -> MX.nebula -> MX.gl
  // (#cv-gl) | Canvas2D fallback (#cv-back) -> #cv overlay (route, focus dashes, lanes, rings, MX.labels). rAF only
  // when dirty or animating. Inks: S.theme only. Camera (3D): a perspective orbit camera. Its focal plane (through the
  // target, perpendicular to the view) keeps the 2D contract screen = v * scale + pan + size / 2 with v = the body's
  // view-plane coordinates (world . right, world . down), so every 2D caller (zoom-to-cursor, pan, fly, fit) still holds
  // there; yaw spins about world z, pitch tilts off face-on (0 = the old 2D view). The principal point is the safe-rect
  // centre, the orbit pivot is the target. CPU projection (SX, SY, SK) feeds pick, overlay, labels and the 2D fallback.
  // idle spin (user rule): the view holds still SPIN_DELAY0 ms after load, then drifts; after any input it rests IDLE ms
  const SPIN_DELAY0 = 8000, IDLE = 20000;
  const g = MX.g, S = MX.state, cam = S.camera, N = g.N, M = g.M, P = S.perf, U = MX.universe;
  if (!U || !MX.scene || !MX.labels) { MX.warn("render: universe/scene/labels missing"); return; }
  const $ = id => document.getElementById(id);
  const cv = $("cv"), ctx = cv.getContext("2d"), stage = $("stage") || cv.parentNode;
  const back = $("cv-back"), glc = $("cv-gl"), bctx = back.getContext("2d");  // template: #cv-gl < #cv-back < #cv
  const HASH = location.hash;  // diagnostic keys, read before filter.js rewrites the hash
  const NOGL = /[?&]nogl=1(&|$)/.test(location.search);  // ?nogl=1: Canvas2D fallback (same 3D camera)
  const BENCH = /[#&]bench=1(&|$)/.test(HASH), GL0 = NOGL || /[#&]gl=0(&|$)/.test(HASH), ST = /[#&]selftest=/.test(HASH), CAMK = (/[#&]cam=U([0-4])(&|$)/.exec(HASH) || [])[1];
  // #cam=yaw,pitch[,dist] (degrees; dist = distance x the fit distance): a fixed test view, no auto-rotate
  const CAM3 = /[#&]cam=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?(&|$)/.exec(HASH);
  const VIEWH = (/[#&]view=([23]d)(&|$)/.exec(HASH) || [])[1];   // #view=2d|3d: overrides localStorage mx.view
  const WHEELN = +((/[#&]wheel=(\d+)(&|$)/.exec(HASH) || [])[1] || 0);   // #wheel=n: n wheel notches in at the biggest on-screen galaxy (diagnostic)
  const RAD = U.radius, ROLE = U.role, SRC = g.src, DST = g.dst, PS = MX.gl ? MX.gl.PSTRIDE : 8, LS = MX.gl ? MX.gl.LSTRIDE : 8;
  // body px radius = world r x scale x (D / depth): true perspective, no clamp (RZ / PERSP are the gl.js no-op clamps);
  // MINR = px floor (fainter below it, gl.js); bodies fade out between NEAR[0] and NEAR[1] x min(W, H) px radius (the
  // camera passes them), and lines whose nearer end is closer than LNEAR[0..1] x D fade out (gl.js)
  const RZ = [1, 0, 1e9], MINR = 0.75, NEAR = [0.35, 0.7], LNEAR = [0.1, 0.4], DUR_BAND = 250, HYST = 1.1, SMAX = 12, TAU = 6.2832;
  const MINR_GL = 0.6, TINY_A = 0.5;   // overview star field: sub-pixel bodies = 1.2 px points at alpha .4..1 (gl.js), .5 (Canvas2D)
  const CMB_A = [0.04, 0.03];  // [dark, light] CMB layer alpha at U0: a barely-there haze
  // body marks [dark, light]: [interior alpha, rim alpha, ink -> line-hi mix, solid below px radius] (gl.js FS_PT)
  const BODY = [[0.14, 0.85, 0.3, 1.6], [0.12, 0.95, 0.18, 1.6]];
  const DASH = [[], [4, 3], [1, 3]], NODASH = [];
  // 3D: vertical fov; default view (yaw, pitch rad); idle spin rad/s, resumes after IDLE ms without input (nothing
  // selected); perspective radius factor clamp (= gl.js persp); labels: bodies drop past depth factor LFAR; pitch range
  const FOV = 40 * Math.PI / 180, YAW0 = -0.35, PITCH0 = 0.62, SPIN = 0.045, PERSP = [0, 1e9], LFAR = 0.4, PMAX = 1.5;
  const DEG = Math.PI / 180, ROT = 0.006;  // orbit: rad per dragged px
  // dolly: wheel k = exp(-deltaY x WHEEL), ctrl-drag k = exp(-dy x CDRAG); the eye steps >= DFL x Dmin (passes bodies);
  // anchors past AMAX x D clamp there. Fly-to: van Wijk-Nuij smooth zoom-pan (rho FRHO), FLY ms = [min, max, per unit
  // path]; a body lands at radius BODYF x the safe rect's short side (>= the U3 floor, <= SMAX)
  const WHEEL = 0.0012, CDRAG = 0.01, DFL = 0.5, AMAX = 4, FRHO = 1.4, FLY = [600, 1600, 260], BODYF = 0.06;
  // small graphs (F2): px radius floor SMALLR at <= SMALLN[0] visible bodies, tapering (log N) to MINR / MINR_GL by
  // SMALLN[1]; floor alpha SMALLA there (a floor, so zooming never inflates a body past perspective). ZMIN: zoom-out
  // limit x fitAll. AHEAD: with no body ahead in the view (the eye flew past them all) a wheel step in is k^AHEAD.
  const SMALLR = 2.75, SMALLN = [500, 2000], SMALLA = 0.9, ZMIN = 0.35, AHEAD = 0.12;
  // selection / hover mark (hairline): crisp 1 px ring at SEL[0] x r (>= r + 3 px), faint dashed guide at SEL[1] x r,
  // soft halo r -> SEL[2] x r peaking at HALO_A[dark, light] (hover x .5), group ink mixed HALO_MIX toward neutral
  const SEL = [1.2, 1.65, 2.8], HALO_A = [0.14, 0.08], HALO_MIX = 0.5, HALO_IN = 0.45, HALO_CAP = 160;

  // one radius for draw, pick, labels (= gl.js): px = r x scale x k (k = D / depth, 1 = the focal plane), min MINR
  let floorR = MINR, floorGL = MINR_GL, floorA = 0.4, small = false;   // px floor (small graphs: SMALLR), computeFit
  const bodyR = (i, s, k) => Math.max(RAD[i] * (s == null ? cam.scale : s) * (k == null ? 1 : k), floorR);

  let W = 0, H = 0, dpr = 1, safe = null, pending = 0, timer = 0, inFrame = false, firstDone = false, booted = false;
  let gl = null, mode = "canvas", glReason = "", glFail = "", glStale = true, forceCanvas = false, texVer = -3;
  let dark = true, fitAll = 0, band = -1, fadeFrom = -1, fadeT0 = 0, fading = false, motionOn = false;
  let animFrames = 0, visVer = 0, selVer = 0, posDirty = false, lastLab = 0, phase = "", last = null, camDone = !CAMK && !CAM3;
  let ptrDown = () => false, posVer = 0, projKey = "", EXT = 1, lastInput = -Infinity, spun = 0, lastSpin = 0, spinNow = false, interacted = !!(CAMK || CAM3);
  const TH = [0.15, 0.15, 0.5, 1.6];  // band thresholds, re-derived from MX.universe.bandFor
  const SX = new Float32Array(N), SY = new Float32Array(N), SK = new Float32Array(N), RR = new Float32Array(N);  // SK: D / depth, 0 = hidden / behind
  const ORD = new Int32Array(Math.max(N, 2 * M + 6)), KEYS = new Int32Array(128);
  const F = {rz: RZ, minR: MINR_GL, nearFade: NEAR, lineNear: LNEAR, texOff: [0, 0, 1, 1], time: 0, dim: 0.75};
  const SU = {band: 0, cam: {x: 0, y: 0, scale: 1, W: 1, H: 1, sx: SX, sy: SY, sk: SK, pj: null}};
  Object.assign(P, {lastSegs: 0, lastLabels: [], cmbOn: false});

  // ---- renderer choice
  function chooseMode() {
    const want = gl && !gl.lost && !S.theme.forced && !GL0 && !forceCanvas ? "webgl" : "canvas";
    if (want === "canvas") glReason = GL0 ? "gl=0" : forceCanvas ? "forced by test" : S.theme.forced ? "forced-colors" : gl && gl.lost ? "context lost" : glFail || "no webgl";
    else glReason = "";
    if (want === mode) return;
    mode = want; glStale = true;
    glc.style.visibility = mode === "webgl" ? "" : "hidden";
    bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.clearRect(0, 0, back.width, back.height);
    requestDraw();
  }
  // runs after frame 1 (Canvas2D); swaps to webgl in one task once linked
  let glWait = false, glDeferred = false, glLinkMs = null, glReadyMs = null, firstLite = false, fullMs = null;
  // lite frame while GL links: gas + CMB + cluster labels; bodies/threads arrive with the GL swap (or the failed-create frame)
  const liteNow = () => !ST && mode === "canvas" && glFail === "gl pending";
  function initGL() {
    const t0 = performance.now(), r = GL0 || !MX.gl ? {reason: GL0 ? "gl=0" : "no MX.gl"} : MX.gl.create(glc, {
      onLost() { chooseMode(); if (booted) drawNow(); MX.status(); },
      onRestored() { themeSync(); glStale = true; chooseMode(); requestDraw(); MX.status(); },
      onError(e) { glFail = "restore failed: " + (e && e.message || e); gl = null; chooseMode(); },
    });
    if (!r.ok) { glFail = r.reason; return chooseMode(); }
    glWait = true; r.ready(e => {
      glWait = false; glLinkMs = r2(performance.now() - t0);
      if (e) { glFail = e; return chooseMode(); }
      gl = r; glFail = ""; themeSync(); gl.resize(W, H, 2);
      if (booted) drawNow();
      glReadyMs = r2(performance.now()); MX.status();
    });
  }
  function themeSync() {
    const th = S.theme, q = th.rgba || {};
    dark = th.blend === "lighter";
    if (gl && q.cmb0) gl.setColors({bg: null, accent: q.accentStroke, ramp: [q.cmb0, q.cmb1, q.cmb2, q.cmb2]});
    glStale = true; cmbKey = "";
    U.glow = dark && !th.forced;
    chooseMode();
  }

  // ---- size
  function resize() {
    const w = cv.clientWidth, h = cv.clientHeight;
    if (w !== W || h !== H) { W = w; H = h; safe = null; }  // safe rect kept unless the size really changed
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    let changed = false;
    if (gl) { const gw = glc.width; gl.resize(W, H, 2); changed = gw !== glc.width; }
    if (back.width !== W || back.height !== H) { back.width = W; back.height = H; changed = true; }  // mesh: DPR 1
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; changed = true; }
    if (!changed) return;
    computeFit();
    requestDraw();
    if (booted && !inFrame) drawNow();
  }

  // ---- scheduler: dirty flag + one motion loop
  const rec = {on: false, ms: [], at: []};
  function requestDraw() {
    if (pending || inFrame || S.view !== "graph") return;
    if (timer) { clearTimeout(timer); timer = 0; }
    pending = requestAnimationFrame(frame);
  }
  function frame() {
    pending = 0;
    if (S.view !== "graph" || !W) return;
    const t0 = performance.now(), lt = liteNow();
    inFrame = true;
    try { draw(t0); } finally { inFrame = false; }
    const t1 = performance.now(), dt = t1 - t0;
    if (!firstDone) firstLite = lt;
    if (fullMs == null && !lt) fullMs = t1;
    P.rafCount++; P.frames++;
    P.frameMs.push(dt); if (P.frameMs.length > 600) P.frameMs.shift();
    if (rec.on) { rec.ms.push(dt); rec.at.push(t0); }
    if (!firstDone) { firstDone = true; P.firstPaintMs = t1; }
    if (motionOn) animFrames++;
    if ((motionOn || fading || spinNow || labBusy) && !pending && !timer) {
      if (band === 0 && !fading) timer = setTimeout(() => { timer = 0; requestDraw(); }, 33);  // U0: twinkle at 30 fps
      else pending = requestAnimationFrame(frame);
    }
  }
  // boot/settle paint synchronously (headless --screenshot issues no rAF before capture)
  function drawNow() { if (pending) { cancelAnimationFrame(pending); pending = 0; } frame(); }
  function stop() {
    if (pending) { cancelAnimationFrame(pending); pending = 0; }
    if (timer) { clearTimeout(timer); timer = 0; }
    U.animate = false; motionOn = false;
  }

  // ---- 3D view: basis (r right, u screen-down, f forward; r x u = f), focal F px, distance D = F / scale, target T,
  // eye E = T - f D, principal point = safe-rect centre (O offset from the canvas centre), clip matrix m (column-major)
  const V = {r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, 1], T: [0, 0, 0], E: [0, 0, 0], O: [0, 0], F: 1, D: 1, near: 1, far: 2, m: new Float32Array(16), key: "", ver: 0};
  const PJ = [0, 0, 0];
  const dot = (a, x, y, z) => a[0] * x + a[1] * y + a[2] * z;
  function basis(yaw, pitch, B) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    B.r[0] = cy; B.r[1] = sy; B.r[2] = 0;
    B.u[0] = -sy * cp; B.u[1] = cy * cp; B.u[2] = sp;
    B.f[0] = sy * sp; B.f[1] = -cy * sp; B.f[2] = cp;
  }
  function view() {
    const sr = W && H ? safeRect() : {l: 0, t: 0, r: W, b: H}, ox = (sr.l + sr.r - W) / 2, oy = (sr.t + sr.b - H) / 2;
    const key = cam.scale + "|" + cam.panX + "|" + cam.panY + "|" + cam.yaw + "|" + cam.pitch + "|" + cam.fz + "|" + W + "|" + H + "|" + ox + "|" + oy + "|" + EXT;
    if (key === V.key) return V;
    basis(cam.yaw, cam.pitch, V);
    const s = cam.scale, r = V.r, u = V.u, f = V.f, F = Math.max(1, H) / 2 / Math.tan(FOV / 2), D = F / s;
    const a = (ox - cam.panX) / s, b = (oy - cam.panY) / s;
    for (let c = 0; c < 3; c++) { V.T[c] = r[c] * a + u[c] * b + f[c] * cam.fz; V.E[c] = V.T[c] - f[c] * D; }
    V.F = F; V.D = D; V.O[0] = ox; V.O[1] = oy;
    V.far = D + 4 * EXT + Math.hypot(V.T[0], V.T[1], V.T[2]); V.near = Math.max(D * 0.01, V.far * 1e-5);
    const m = V.m, A = (V.far + V.near) / (V.far - V.near), B = -2 * V.far * V.near / (V.far - V.near);
    const ax = 2 * F / Math.max(W, 1), bx = 2 * ox / Math.max(W, 1), ay = 2 * F / Math.max(H, 1), by = 2 * oy / Math.max(H, 1);
    for (let c = 0; c < 3; c++) { m[c * 4] = ax * r[c] + bx * f[c]; m[c * 4 + 1] = -(ay * u[c] + by * f[c]); m[c * 4 + 2] = A * f[c]; m[c * 4 + 3] = f[c]; }
    for (let k = 0; k < 4; k++) m[12 + k] = -(m[k] * V.E[0] + m[4 + k] * V.E[1] + m[8 + k] * V.E[2]);
    m[14] += B;
    V.key = key; V.ver++;
    return V;
  }
  // world -> screen: out = [x, y, k = D / depth] (CSS px; body px radius = world r x scale x k); false = behind the camera
  function project(x, y, z, out) {
    const v = V, qx = x - v.E[0], qy = y - v.E[1], qz = z - v.E[2], cz = qx * v.f[0] + qy * v.f[1] + qz * v.f[2];
    if (!(cz > v.near)) return false;
    const k = v.F / cz;
    out[0] = W / 2 + v.O[0] + (qx * v.r[0] + qy * v.r[1] + qz * v.r[2]) * k;
    out[1] = H / 2 + v.O[1] + (qx * v.u[0] + qy * v.u[1] + qz * v.u[2]) * k;
    out[2] = v.D / cz;
    return true;
  }
  const pjFn = (x, y, z, out) => project(x, y, z || 0, out);
  SU.cam.pj = pjFn;
  // screen -> world on the plane at depth factor k (k = D / depth; 1 = the focal plane)
  function unproject(mx, my, k) {
    const v = view(), cz = v.D / (k > 0 ? k : 1), t = cz / v.F, dx = mx - W / 2 - v.O[0], dy = my - H / 2 - v.O[1], o = [0, 0, 0];
    for (let c = 0; c < 3; c++) o[c] = v.E[c] + (v.f[c] * v.F + v.r[c] * dx + v.u[c] * dy) * t;
    return o;
  }
  // re-express a world target in pan / fz for the current yaw, pitch, scale (the orbit pivot stays put)
  function setTarget(T) {
    const v = view(), s = cam.scale;
    cam.panX = v.O[0] - dot(v.r, T[0], T[1], T[2]) * s; cam.panY = v.O[1] - dot(v.u, T[0], T[1], T[2]) * s; cam.fz = dot(v.f, T[0], T[1], T[2]);
  }
  function orbitBy(dyaw, dpitch) {
    const T = view().T.slice();
    cam.yaw = (cam.yaw + dyaw) % (2 * Math.PI);
    cam.pitch = Math.max(-PMAX, Math.min(PMAX, cam.pitch + dpitch));
    setTarget(T);
  }
  // all visible bodies -> SX, SY, SK (once per view / positions / visibility change)
  function projectAll() {
    const v = view(), key = v.ver + "|" + posVer + "|" + visVer;
    if (key === projKey) return;
    projKey = key;
    const X = S.x, Y = S.y, Z = S.z, nv = S.nodeVisible;
    for (let i = 0; i < N; i++) {
      if (nv[i] && project(X[i], Y[i], Z[i], PJ)) { SX[i] = PJ[0]; SY[i] = PJ[1]; SK[i] = PJ[2]; } else { SX[i] = SY[i] = -1e6; SK[i] = 0; }
    }
  }
  const bodyRp = i => bodyR(i, null, SK[i]);  // projected radius (same as gl.js), needs projectAll()
  const faded = r => r > NEAR[1] * Math.min(W, H);   // a body the camera is passing: drawn faded out, never picked
  // view-plane coordinates of a world point: [. right, . down, . forward]
  function vplane(x, y, z) { const v = view(); return [dot(v.r, x, y, z), dot(v.u, x, y, z), dot(v.f, x, y, z)]; }
  let idleT = 0, readyAt = Infinity;
  function touch() {   // user input: stops the idle spin; a frame is due when it may resume
    lastInput = performance.now(); interacted = true;
    clearTimeout(idleT); idleT = setTimeout(() => requestDraw(), IDLE + 50);
  }
  // idle auto-rotate: webgl, motion allowed, booted, no input for IDLE ms (or none yet), nothing selected / focused
  function spinning(now) {
    return mode === "webgl" && booted && U.started && MX.motionOK() && S.view === "graph" && S.view3d && !dimT && !fly && !ptrDown() &&
      (interacted ? now - lastInput > IDLE : now - readyAt > SPIN_DELAY0) && S.selected < 0 && !S.focus && !(S.path && S.path.found) && !CAM3 && !CAMK && !ST;
  }

  // ---- camera
  function safeRect() {  // canvas area not under visible [data-overlay] chrome
    if (safe) return safe;
    let l = 0, t = 0, r = W, b = H;
    const c = cv.getBoundingClientRect();
    for (const el of document.querySelectorAll("[data-overlay]")) {
      if (el.hidden || !el.getClientRects().length) continue;
      const q = el.getBoundingClientRect(), side = el.getAttribute("data-overlay");
      if (!q.width || !q.height) continue;
      if (side === "left") l = Math.max(l, q.right - c.left);
      else if (side === "top") t = Math.max(t, q.bottom - c.top);
      else if (side === "right") r = Math.min(r, q.left - c.left);
      else if (side === "bottom") b = Math.min(b, q.top - c.top);   // #hint: labels and fits stay above it
    }
    l = Math.max(0, Math.min(W, l)); t = Math.max(0, Math.min(H, t)); r = Math.max(l, Math.min(W, r)); b = Math.max(t, Math.min(H, b));
    if (r - l < 120 || b - t < 120) { l = 0; t = 0; r = W; b = H; }
    return (safe = {l, t, r, b});
  }
  // bbox of the visible bodies in view-plane coordinates (face = the disc's own x / y: stable under rotation);
  // cf = mean forward depth (the fit target's fz)
  function fitOf(pad, face) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cf = 0, n = 0;
    const v = face ? null : view(), r = v ? v.r : null, u = v ? v.u : null, fw = v ? v.f : null;
    for (let i = 0; i < N; i++) {
      if (!S.nodeVisible[i]) continue;
      const X = S.x[i], Y = S.y[i], Z = S.z[i];
      if (!isFinite(X) || !isFinite(Y) || !isFinite(Z)) continue;
      const x = v ? dot(r, X, Y, Z) : X, y = v ? dot(u, X, Y, Z) : Y;
      if (v) { cf += dot(fw, X, Y, Z); n++; }
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!(x1 >= x0) || !W || !H) return null;
    const sr = safeRect(), s = Math.min((sr.r - sr.l) / Math.max(x1 - x0, 1), (sr.b - sr.t) / Math.max(y1 - y0, 1)) * pad;
    return {s, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cf: n ? cf / n : 0, sr, box: {x0, y0, x1, y1}};
  }
  // ---- projected fit (F1): the eye distance D at which the bodies (ids, else every visible one) project inside the safe
  // rect x pad, body radii and the px floor included, at the current yaw / pitch. All bodies in 3D: yaw-invariant (their
  // bounding cylinder about the vertical through the target, ZB z-bins x YS yaw samples), so the idle spin never
  // carries one out. Per point q = p - T, radius rho: (|q . r| + rho) F / (q . f + D - rho) <= half width (u: height)
  // -> D >= (|q . r| + rho) F / hw - (q . f - rho), closed form. -> {T, s = F / D} | null
  const ZB = 12, YS = 48, ZR = new Float64Array(3 * ZB);
  function fitProj(ids, pad) {
    if (!W || !H) return null;
    const v = view(), sr = safeRect(), F = v.F, X = S.x, Y = S.y, Z = S.z, nv = S.nodeVisible;
    const hw = Math.max(8, (sr.r - sr.l) / 2 * pad - floorR), hh = Math.max(8, (sr.b - sr.t) / 2 * pad - floorR);
    const list = ids || null, len = list ? list.length : N, at = j => (list ? list[j] : j);
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, n = 0;
    for (let j = 0; j < len; j++) {
      const i = at(j), r = RAD[i];
      if (!nv[i] || !isFinite(X[i]) || !isFinite(Y[i]) || !isFinite(Z[i])) continue;
      n++;
      if (X[i] - r < x0) x0 = X[i] - r; if (X[i] + r > x1) x1 = X[i] + r; if (Y[i] - r < y0) y0 = Y[i] - r; if (Y[i] + r > y1) y1 = Y[i] + r;
      if (Z[i] - r < z0) z0 = Z[i] - r; if (Z[i] + r > z1) z1 = Z[i] + r;
    }
    if (!n) return null;
    const T = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    let D = 0;
    const need = (qx, qy, qz, rho) => {
      const a = Math.abs(dot(v.r, qx, qy, qz)) + rho, b = Math.abs(dot(v.u, qx, qy, qz)) + rho, c = dot(v.f, qx, qy, qz) - rho;
      D = Math.max(D, a * F / hw - c, b * F / hh - c, 1e-6 - c);
    };
    if (!list && S.view3d) {   // yaw-invariant: per z-bin the widest ring, sampled around the vertical axis
      ZR.fill(0); for (let b = 0; b < ZB; b++) { ZR[3 * b + 1] = Infinity; ZR[3 * b + 2] = -Infinity; }
      const zs = Math.max(z1 - z0, 1e-9), sc = 1 / Math.cos(Math.PI / YS);   // polygon circumscribes the circle
      for (let i = 0; i < N; i++) {
        if (!nv[i] || !isFinite(X[i]) || !isFinite(Y[i]) || !isFinite(Z[i])) continue;
        const r = RAD[i], b = Math.min(ZB - 1, Math.floor((Z[i] - z0) / zs * ZB)) * 3;
        ZR[b] = Math.max(ZR[b], Math.hypot(X[i] - T[0], Y[i] - T[1]) + r);
        ZR[b + 1] = Math.min(ZR[b + 1], Z[i] - r); ZR[b + 2] = Math.max(ZR[b + 2], Z[i] + r);
      }
      for (let b = 0; b < 3 * ZB; b += 3) {
        if (!(ZR[b + 2] >= ZR[b + 1])) continue;
        for (let k = 0; k < YS; k++) {
          const t = k / YS * TAU, qx = ZR[b] * sc * Math.cos(t), qy = ZR[b] * sc * Math.sin(t);
          need(qx, qy, ZR[b + 1] - T[2], 0); need(qx, qy, ZR[b + 2] - T[2], 0);
        }
      }
    } else for (let j = 0; j < len; j++) {
      const i = at(j);
      if (nv[i] && isFinite(X[i]) && isFinite(Y[i]) && isFinite(Z[i])) need(X[i] - T[0], Y[i] - T[1], Z[i] - T[2], RAD[i]);
    }
    return {T, s: F / Math.max(D, 1e-9)};
  }
  // fitOK (mxstatus.camera): measured on the projection (drawn radius) against the safe rect, 1 px slack
  const inSafe = (x, y, r, sr) => x - r >= sr.l - 1 && x + r <= sr.r + 1 && y - r >= sr.t - 1 && y + r <= sr.b + 1;
  function okIds(ids) {
    projectAll();
    const sr = safeRect(), len = ids ? ids.length : N;
    for (let j = 0; j < len; j++) { const i = ids ? ids[j] : j; if (S.nodeVisible[i] && !(SK[i] > 0 && inSafe(SX[i], SY[i], bodyRp(i), sr))) return false; }
    return true;
  }
  const okAll = () => okIds(null);
  const okSphere = (c, R) => { view(); return !!c && project(c[0], c[1], c[2] || 0, PJ) && inSafe(PJ[0], PJ[1], R * cam.scale * PJ[2], safeRect()); };

  // ---- nothing ahead (F3): no visible body in front of the eye on the canvas (the camera flew past them all). A wheel
  // step in is then damped to k^AHEAD and a quiet hairline note sits in the safe-rect centre until a reverse zoom /
  // fit / flight / reset, or bodies come back into view (pan, orbit)
  let voidEl = null, voidOn = false;
  function ahead() {
    projectAll();
    for (let i = 0; i < N; i++) if (SK[i] > 0 && SX[i] > -24 && SY[i] > -24 && SX[i] < W + 24 && SY[i] < H + 24 && !faded(bodyRp(i))) return true;
    return false;
  }
  function voidHint(on) {
    if (on === voidOn) return;
    voidOn = on;
    if (on && !voidEl) {
      voidEl = document.createElement("div");
      voidEl.id = "void-hint"; voidEl.setAttribute("role", "status");
      voidEl.textContent = "nothing ahead \u00b7 0 to fit";
      voidEl.style.cssText = "position:absolute;transform:translate(-50%,-50%);padding:6px 12px;border:1px solid var(--ring);" +
        "border-radius:8px;background:var(--surface-glass);font:11px/1 var(--font, var(--font-mono));letter-spacing:.04em;" +
        "color:var(--text-3);pointer-events:none;white-space:nowrap";
      stage.appendChild(voidEl);
    }
    if (!voidEl) return;
    voidEl.hidden = !on;
    if (on) { const c = mid(); voidEl.style.left = c[0] + "px"; voidEl.style.top = c[1] + "px"; }
    MX.status();
  }

  function computeFit() {  // fitAll = fit(0.88) scale of the visible universe, face-on (bands never move with rotation)
    if (!U.started) return;
    const f = fitOf(0.88, true);
    if (!f) return;
    fitAll = f.s;
    let e = 1, nv = 0;
    for (let i = 0; i < N; i++) if (S.nodeVisible[i]) { nv++; e = Math.max(e, Math.abs(S.x[i] - f.cx), Math.abs(S.y[i] - f.cy), Math.abs(S.z[i])); }
    EXT = e;
    // F2 floor: SMALLR px at <= SMALLN[0] visible bodies, log taper to the large-graph floor by SMALLN[1]
    const t = Math.max(0, Math.min(1, Math.log(Math.max(nv, 1) / SMALLN[0]) / Math.log(SMALLN[1] / SMALLN[0])));
    small = t < 1;
    floorR = MINR + (SMALLR - MINR) * (1 - t); floorGL = MINR_GL + (SMALLR - MINR_GL) * (1 - t); floorA = 0.4 + (SMALLA - 0.4) * (1 - t);
    for (let k = 1; k <= 4; k++) {  // smallest s with bandFor(s) >= k
      let lo = 1e-7, hi = 1e4;
      for (let j = 0; j < 60; j++) { const m = Math.sqrt(lo * hi); if (U.bandFor(m, fitAll) >= k) hi = m; else lo = m; }
      TH[k - 1] = hi;
    }
  }
  const clampScale = s => Math.min(SMAX, Math.max(fitAll > 0 ? ZMIN * fitAll : 1e-4, s));
  function hyst(cur, s) {  // up needs s >= T*1.1, down needs s < T/1.1
    if (cur < 0) return U.bandFor(s, fitAll);
    const up = U.bandFor(s / HYST, fitAll), dn = U.bandFor(s * HYST, fitAll);
    return up > cur ? up : dn < cur ? dn : cur;
  }
  // ---- dolly (wheel, pinch, ctrl-drag, + / -): the eye moves along the ray through the cursor, toward the anchor = the
  // body under the cursor, else the ray's hit on the disc plane z = 0, else the focal plane (depth <= AMAX x D). Step =
  // (1 - 1 / k) x max(anchor depth, DFL x Dmin), so every point on that ray stays under the cursor (exact), sizes change
  // by perspective only, and in 3D the eye flies on past bodies (no bound in). Focal distance D = F / scale: D / k,
  // clamped to [Dmin = F / SMAX, F / min scale] (bands unchanged); past Dmin the pivot is carried ahead of the eye.
  // 2D: no floor step (the eye never crosses the plane; scale stops at SMAX as before). Out stops at the far limit.
  const minScale = () => clampScale(0);
  function anchorDepth(mx, my) {
    const v = view(), i = pick(mx, my);
    if (i >= 0 && SK[i] > 0) return Math.min(v.D / SK[i], AMAX * v.D);
    const dz = v.f[2] * v.F + v.r[2] * (mx - W / 2 - v.O[0]) + v.u[2] * (my - H / 2 - v.O[1]);   // ray z per unit depth x F
    const t = Math.abs(dz) > 1e-12 ? -v.E[2] / dz * v.F : -1;                                       // depth of the z = 0 hit
    return t > 0 ? Math.min(t, AMAX * v.D) : v.D;
  }
  function dolly(k, mx, my, depth) {
    if (!(k > 0) || !W || !H || k === 1) return false;
    if (k < 1) voidHint(false);
    else if (S.view3d && !ahead()) { k = Math.pow(k, AHEAD); voidHint(true); }   // F3: past everything -> damped
    const v = view(), s1 = clampScale(cam.scale * k), F = v.F, Dmin = F / SMAX;
    const kk = k < 1 || !S.view3d ? s1 / cam.scale : k;                                 // 2D / out: the clamped step
    if (Math.abs(kk - 1) < 1e-12) return false;                                         // at a limit
    const a = depth > 0 ? depth : anchorDepth(mx, my), dx = mx - W / 2 - v.O[0], dy = my - H / 2 - v.O[1], T = [0, 0, 0];
    const adv = Math.max(a, S.view3d && k > 1 ? DFL * Dmin : 0) * (1 - 1 / kk) / F;
    for (let c = 0; c < 3; c++) T[c] = v.E[c] + (v.f[c] * F + v.r[c] * dx + v.u[c] * dy) * adv + v.f[c] * (F / s1);
    cam.scale = s1;
    setTarget(T);
    if (S.view3d && kk > 1 && !voidOn && !ahead()) voidHint(true);
    return true;
  }

  // ---- fly-to: the van Wijk-Nuij smooth zoom-pan path (rho FRHO) between the pivot T0 at
  // focal distance D0 and the target at D1 = F / scale: short hops glide, long ones pull back partway and dive in. The
  // path parameter runs on the hairline curve (EASE3, monotone); duration FLY[0] + FLY[2] x path length, <= FLY[1] ms;
  // yaw / pitch kept. The target is re-read every step (orbits, repack tween), so the flight ends exactly on it, centred
  // (the pivot projects to the safe-rect centre). Any input cancels it. Instant under RM / motion off / hidden / off-tab
  // and before boot (headless --screenshot issues no rAF). Driven by rAF + a timer (virtual time).
  let fly = null, flyRaf = 0, flyTimer = 0, flights = 0, lastBox = null;
  const mid = () => { const sr = safeRect(); return [(sr.l + sr.r) / 2, (sr.t + sr.b) / 2]; };
  function vwPath(w0, w1, u1) {   // -> {S, u(s) 0..u1, w(s)}: w = focal distance (proportional to the view width)
    const R = FRHO, R2 = R * R;
    if (!(u1 > 1e-6 * Math.max(w0, w1))) { const d = Math.log(w1 / w0); return {S: Math.abs(d) / R, u: () => 0, w: s => w0 * Math.exp(Math.sign(d) * R * s)}; }
    const b = (wi, sg) => (w1 * w1 - w0 * w0 + sg * R2 * R2 * u1 * u1) / (2 * wi * R2 * u1), r0 = -Math.asinh(b(w0, 1)), r1 = -Math.asinh(b(w1, -1));
    return {S: (r1 - r0) / R, u: s => w0 / R2 * (Math.cosh(r0) * Math.tanh(R * s + r0) - Math.sinh(r0)), w: s => w0 * Math.cosh(r0) / Math.cosh(R * s + r0)};
  }
  function flyClear() {
    if (flyRaf) { cancelAnimationFrame(flyRaf); flyRaf = 0; }
    if (flyTimer) { clearTimeout(flyTimer); flyTimer = 0; }
  }
  function flyCancel() { if (fly) { fly = null; flyClear(); MX.status(); } }
  function flyStep() {
    flyClear();
    const f = fly;
    if (!f) return;
    const t = f.target(), k = f.instant ? 1 : Math.min(1, (performance.now() - f.t0) / f.dur);
    if (!t || !isFinite(t.x) || !isFinite(t.y)) { fly = null; MX.status(); return; }
    const e = k < 1 ? EASE3(k) : 1, s = e * f.P.S, q = k < 1 && f.u1 > 0 ? Math.min(1, f.P.u(s) / f.u1) : k < 1 ? 0 : 1, T = [0, 0, 0], p = [t.x, t.y, t.z || 0];
    for (let c = 0; c < 3; c++) T[c] = f.T0[c] + (p[c] - f.T0[c]) * q;
    cam.scale = k < 1 ? Math.max(minScale(), Math.min(SMAX, view().F / f.P.w(s))) : clampScale(t.scale);
    setTarget(T);
    f.e = e; f.q = q;
    requestDraw();
    if (k < 1 || (U.tween < 1 && !f.instant)) { flyRaf = requestAnimationFrame(flyStep); flyTimer = setTimeout(flyStep, 34); return; }
    fly = null;
    MX.status();
    if (f.done) f.done();
  }
  // target: {x, y, z, scale} (world centre, CSS px per world unit at the focal plane) or a function returning it per step.
  // opts: {instant, box: world bbox {x0,y0,x1,y1} or fn (mxstatus fitOK), key (same key in flight = no restart), done}
  function flyTo(target, opts) {
    opts = opts || {};
    const fn = typeof target === "function" ? target : () => target, t = fn();
    if (!t || !isFinite(t.x) || !isFinite(t.y) || !(t.scale > 0) || !W || !H) return false;
    if (fly && opts.key && fly.key === opts.key) return true;
    flyClear();
    cam.userAdjusted = true; lastBox = opts.box || null; flights++; touch(); voidHint(false);
    const v = view(), s0 = cam.scale, s1 = clampScale(t.scale), c = mid(), T0 = v.T.slice(), z = t.z || 0;
    const u1 = Math.hypot(t.x - T0[0], t.y - T0[1], z - T0[2]), P = vwPath(v.F / s0, v.F / s1, u1);
    const p0 = project(t.x, t.y, z, PJ) ? [PJ[0], PJ[1]] : [-1e6, -1e6], dist = Math.hypot(p0[0] - c[0], p0[1] - c[1]);
    const instant = !!opts.instant || !booted || U.motionReason() !== "" || (dist < 0.5 && Math.abs(Math.log(s1 / s0)) < 1e-3);
    fly = {target: fn, T0, u1, P, e: 0, q: 0, key: opts.key || "", done: opts.done, instant, t0: instant ? -1e9 : performance.now(),
      dur: Math.min(FLY[1], FLY[0] + FLY[2] * P.S)};
    if (!instant) MX.emit("flyto", {from: {scale: s0}, to: {x: t.x, y: t.y, scale: s1}, bands: Math.abs(U.bandFor(s1, fitAll) - band),
      sx: Math.max(0, Math.min(W, p0[0])), sy: Math.max(0, Math.min(H, p0[1]))});
    flyStep();
    return true;
  }
  // ---- 2D / 3D view (S.view3d, S.zScale). 2D: face-on (yaw = pitch = 0), every z x 0 (MX.universe.setZScale), drag
  // pans, no orbit keys, no idle spin. 3D: depth back, the angle 2D was entered from (else the default tilt). One 700 ms
  // tween on the hairline curve, the orbit target kept (its z scaled with the depth); instant under RM / motion off /
  // before boot. Driven by rAF + a timer (virtual time), like the flights.
  let dimT = null, dimRaf = 0, dimTimer = 0, keep3 = null;
  const DIM_MS = 700, EASE3 = k => (window.HL && HL.EASE_LIFT ? HL.EASE_LIFT(k) : 1 - Math.pow(1 - k, 3));
  const wrapPI = a => Math.atan2(Math.sin(a), Math.cos(a));
  function dimApply(yaw, pitch, z) {
    const T = view().T.slice(), z0 = S.zScale;
    if (z0 > 1e-9) T[2] *= z / z0;
    cam.yaw = yaw; cam.pitch = pitch;
    if (z !== z0) U.setZScale(z);
    setTarget(T);
    requestDraw();
  }
  function dimStep() {
    if (dimRaf) { cancelAnimationFrame(dimRaf); dimRaf = 0; }
    if (dimTimer) { clearTimeout(dimTimer); dimTimer = 0; }
    const d = dimT;
    if (!d) return;
    const k = d.instant ? 1 : Math.min(1, (performance.now() - d.t0) / DIM_MS), e = k < 1 ? EASE3(k) : 1, L = (a, b) => a + (b - a) * e;
    dimApply(L(d.from[0], d.to[0]), L(d.from[1], d.to[1]), L(d.from[2], d.to[2]));
    if (k < 1) { dimRaf = requestAnimationFrame(dimStep); dimTimer = setTimeout(dimStep, 34); return; }
    dimT = null; computeFit(); MX.status();
  }
  function setView3d(on) {
    on = !!on;
    if (on === S.view3d && !dimT) return false;
    flyCancel(); touch();
    if (!on && S.view3d) keep3 = [cam.yaw, cam.pitch];
    S.view3d = on;
    const to = on ? (keep3 || [YAW0, PITCH0]).concat(1) : [0, 0, 0];
    cam.yaw = wrapPI(cam.yaw);   // shortest turn to face-on
    if (on) to[0] = cam.yaw + wrapPI(to[0] - cam.yaw);
    dimT = {from: [cam.yaw, cam.pitch, S.zScale], to, t0: performance.now(), instant: !booted || U.motionReason() !== ""};
    dimStep();
    MX.emit("view3d", on); MX.status();
    return true;
  }
  const camera = MX.camera = {
    safeRect,
    fit(pad) {   // projected, yaw-invariant in 3D (fitProj)
      const f = fitProj(null, pad || 0.9);
      if (!f) return;
      flyCancel(); lastBox = okAll; voidHint(false);
      cam.scale = clampScale(f.s);
      setTarget(f.T);
      requestDraw();
    },
    centerOn(i, minScale) {  // never animated (reduced-motion safe)
      flyCancel(); touch();
      cam.userAdjusted = true;
      cam.scale = clampScale(Math.max(cam.scale, minScale == null ? 1.2 : minScale));
      const sr = W && H ? safeRect() : {l: 0, t: 0, r: W, b: H}, q = vplane(S.x[i], S.y[i], S.z[i]);
      cam.panX = (sr.l + sr.r) / 2 - W / 2 - q[0] * cam.scale;
      cam.panY = (sr.t + sr.b) / 2 - H / 2 - q[1] * cam.scale;
      cam.fz = q[2];
      requestDraw();
    },
    // dolly by k (> 1 in) toward the point under (cx, cy) (default: the safe-rect centre); depth = a fixed anchor depth
    // (ctrl-drag keeps its drag-start anchor). Same path for wheel, pinch, ctrl-drag, + / - keys and buttons.
    zoomBy(k, cx, cy, depth) {
      flyCancel(); touch();
      cam.userAdjusted = true;
      const c = mid();
      dolly(k, cx == null ? c[0] : cx, cy == null ? c[1] : cy, depth);
      requestDraw();
    },
    anchorDepth: (mx, my) => anchorDepth(mx, my),
    panBy(dx, dy) { flyCancel(); touch(); cam.userAdjusted = true; cam.panX += dx; cam.panY += dy; requestDraw(); },
    // orbit about the target (rad); pitch clamped to +-PMAX
    orbit(dyaw, dpitch) { if (!S.view3d) return; flyCancel(); touch(); cam.userAdjusted = true; orbitBy(dyaw || 0, dpitch || 0); requestDraw(); },
    // Reset view: hand framing back to the layout (userAdjusted = false), the default 3D angle (2D: face-on), idle spin,
    // then fit. restore(): a saved {scale, panX, panY, userAdjusted, yaw, pitch, fz}
    reset(pad) {
      flyCancel(); cam.userAdjusted = false; interacted = false; voidHint(false);
      if (S.view3d) { cam.yaw = YAW0; cam.pitch = PITCH0; } else keep3 = null;
      camera.fit(pad || 0.88);
    },
    // 2D / 3D view: setView3d(true | false) -> false when already there; tweening = the 700 ms turn in progress
    setView3d, get view3d() { return S.view3d; }, get tweening() { return !!dimT; },
    restore(c) { flyCancel(); for (const k of ["scale", "panX", "panY", "userAdjusted", "yaw", "pitch", "fz"]) if (k in c) cam[k] = c[k]; band = -1; requestDraw(); },
    screen(i) {
      view();
      if (!project(S.x[i], S.y[i], S.z[i], PJ)) return [-1e6, -1e6, 0];
      return [PJ[0], PJ[1], bodyR(i, null, PJ[2])];
    },
    project(x, y, z) { view(); return project(x, y, z || 0, PJ) ? PJ.slice() : null; },   // [sx, sy, k] | null (behind)
    unproject: (mx, my, k) => unproject(mx, my, k),
    target: () => view().T.slice(),
    get view() { const v = view(); return {yaw: cam.yaw, pitch: cam.pitch, fz: cam.fz, D: v.D, F: v.F, near: v.near, far: v.far, T: v.T.slice(), f: v.f.slice()}; },
    radius: (i, s) => bodyR(i, s),
    get fitAll() { return fitAll; }, get band() { return band; }, get thresholds() { return TH.slice(); },
    flyTo, cancel: flyCancel, get flying() { return !!fly; },
    get flight() { return fly ? {e: fly.e, q: fly.q, dur: fly.dur, S: fly.P.S} : null; },   // progress (self-test)
    // body: centred at max(s, T2 * 1.15), framed: radius >= BODYF x the safe rect's short side (<=
    // SMAX), position re-read per step
    flyBody(i, opts) {
      if (!(i >= 0 && i < N) || !U.started) return false;
      const ft = U.flyTarget("body", i), r = RAD[i], sr = safeRect();
      const s1 = Math.max(ft ? ft.scale : TH[2] * 1.15, Math.min(SMAX, BODYF * Math.min(sr.r - sr.l, sr.b - sr.t) / Math.max(r, 1e-3)));
      return flyTo(() => ({x: S.x[i], y: S.y[i], z: S.z[i], scale: s1}), Object.assign({key: "b" + i,
        box: () => okSphere([S.x[i], S.y[i], S.z[i]], r)}, opts));
    },
    // cluster | galaxy | system: centred, its disc filling 88% of the safe rect's short side (MX.universe.flyTarget)
    flyKind(kind, k, opts) {
      const t0 = U.flyTarget(kind, k);
      if (!t0) return false;
      const box = () => okSphere(U.centerOf(kind, k), U.radiusOf(kind, k));
      return flyTo(() => { const t = U.flyTarget(kind, k); return t ? {x: t.x, y: t.y, z: t.z || 0, scale: Math.min(t.scale, SMAX)} : null; },
        Object.assign({key: kind + k, box}, opts));
    },
    // fit a set of bodies (route, focus) or, with no ids, the whole visible universe (fit 0.88), animated
    flyFit(ids, opts) {   // projected (fitProj): ids = route / focus, else every visible body (yaw-invariant in 3D)
      const pad = ids ? 0.8 : 0.88, cap = ids ? 4 : SMAX, f0 = fitProj(ids, pad);
      if (!f0) return false;
      return flyTo(() => { const f = fitProj(ids, pad) || f0; return {x: f.T[0], y: f.T[1], z: f.T[2], scale: Math.min(cap, f.s)}; },
        Object.assign({key: ids ? "" : "fit", box: ids ? () => okIds(ids) : okAll}, opts));
    },
  };
  function camStatus() {  // mxstatus.camera: centerErrPx = selected body to safe-rect centre; fitOK = last fit box in the safe rect
    if (!W || !H) return {scale: r2(cam.scale * 1e4) / 1e4, fitAll, band: null, centerErrPx: null, fitOK: null, flying: !!fly, flights};
    const c = mid(), sel = S.selected, ok = lastBox ? !!lastBox() : null;   // fitOK: projected (okAll / okIds / okSphere)
    let err = null;
    if (sel >= 0 && S.nodeVisible[sel]) { const p = camera.screen(sel); err = r2(Math.hypot(p[0] - c[0], p[1] - c[1])); }  // projected
    return {scale: r2(cam.scale * 1e4) / 1e4, fitAll: r2(fitAll * 1e4) / 1e4, band: band < 0 ? null : "U" + band,
      centerErrPx: err, fitOK: ok, flying: !!fly, flights, yaw: r2(cam.yaw / DEG), pitch: r2(cam.pitch / DEG), spin: spinNow,
      nothingAhead: voidOn, floorPx: r2(floorR)};
  }
  function applyCam(k) {  // #cam=U0..U4: band's geometric middle (diagnostic), on the selection (#n=) else the biggest system
    computeFit();
    const s = clampScale(k === 0 ? 0.9 * fitAll : k === 4 ? TH[3] * 2 : Math.sqrt(TH[k - 1] * TH[k])), sr = safeRect();
    let best = -1, cx = 0, cy = 0, cf = 0;
    U.systems.forEach((y, j) => { if (S.nodeVisible[y.sun] && (best < 0 || y.size > U.systems[best].size)) best = j; });
    if (k === 0 || best < 0) { const f = fitOf(0.88); if (!f) return; cx = f.cx; cy = f.cy; cf = f.cf; }
    else { const u = S.selected >= 0 && S.nodeVisible[S.selected] ? S.selected : U.systems[best].sun; [cx, cy, cf] = vplane(S.x[u], S.y[u], S.z[u]); }   // #n= selection first
    cam.scale = s;
    cam.panX = (sr.l + sr.r) / 2 - W / 2 - cx * s;
    cam.panY = (sr.t + sr.b) / 2 - H / 2 - cy * s;
    cam.fz = cf;
    cam.userAdjusted = true; band = -1;
  }
  function applyCam3() {  // #cam=yaw,pitch[,dist]: degrees; dist x the fit distance (1 = fit)
    cam.yaw = +CAM3[1] * DEG; cam.pitch = Math.max(-PMAX, Math.min(PMAX, +CAM3[2] * DEG));
    if (!S.view3d) { keep3 = [cam.yaw, cam.pitch]; cam.yaw = cam.pitch = 0; }   // 2D: the angle waits for 3D
    computeFit(); camera.fit(0.88);
    const T = view().T.slice();
    cam.scale = clampScale(cam.scale / (CAM3[3] ? Math.max(0.05, +CAM3[3]) : 1));
    setTarget(T);
    cam.userAdjusted = true; band = -1;
  }

  // ---- frame
  function draw(now) {
    motionOn = mode === "webgl" && U.started && U.motionReason() === "";
    const b = hyst(band, cam.scale);
    if (b !== band) { fadeFrom = band >= 0 && motionOn ? band : -1; fadeT0 = now; band = b; U.band = b; }
    const fk = fadeFrom >= 0 ? Math.min(1, (now - fadeT0) / DUR_BAND) : 1;
    fading = fk < 1;
    if (!fading) fadeFrom = -1;
    U.animate = motionOn && band >= 1;
    if (U.animate && U.step(now)) MX.emit("positions");
    spinNow = spinning(now);
    if (spinNow) {                                        // idle auto-rotate about the target
      const dt = lastSpin ? Math.min(0.1, (now - lastSpin) / 1000) : 0;
      if (dt > 0) { orbitBy(SPIN * dt, 0); spun++; }
      lastSpin = now;
    } else lastSpin = 0;
    projectAll();
    camEmit();
    SU.band = band; SU.cam.x = cam.panX; SU.cam.y = cam.panY; SU.cam.scale = cam.scale; SU.cam.W = W; SU.cam.H = H;
    const r = last = MX.scene.update(SU);
    P.lastSegs = r.nLns;
    if (mode === "webgl") drawGL(r, now, fk); else drawCanvas(r);
    overlay(now);
  }

  // MX.emit("camera") when the view changed (dolly, pan, orbit, idle spin, flights), at most once per CAM_MS; the last
  // change always lands (trailing timer). Listeners (minimap.js) read MX.camera themselves.
  const CAM_MS = 100;
  let camKey = "", camAt = -Infinity, camT = 0;
  function camEmit() {
    if (V.key === camKey) return;
    const t = performance.now();
    if (t - camAt >= CAM_MS) { camAt = t; camKey = V.key; MX.emit("camera"); return; }
    if (!camT) camT = setTimeout(() => { camT = 0; view(); if (V.key !== camKey) { camAt = performance.now(); camKey = V.key; MX.emit("camera"); } }, CAM_MS - (t - camAt));
  }
  function drawGL(r, now, fk) {
    if (r.ptsDirty || glStale) {
      // body colour comes from the scene (T.ink); on paper: no per-body glow. The sun flag stays in both themes (centre pip)
      const A = r.pts;
      if (!dark) for (let j = 0, o = 0; j < r.nPts; j++, o += PS) A[o + 3] = 0;
      gl.points(r.pts, r.nPts);
    }
    if (r.lnsDirty || glStale) gl.lines(r.lns, r.nLns);
    // the nebula texture is world-x/y aligned (2D): shown face-on only, faded out as the view turns (sprites carry 3D gas)
    const fl = flat(), NB = fl > 0 ? MX.nebula : null, t = NB ? (NB.update(now), NB.texture()) : null, tv = t ? t.version : -2;
    if (tv !== texVer || glStale) { gl.texture(t ? t.canvas : null); texVer = tv; }
    sprites(glStale);
    glStale = false;
    const v = view();
    GV.m = v.m; GV.D = v.D; GV.near = v.near;
    gl.setCamera(cam.panX, cam.panY, cam.scale, GV);
    const mix = f => (fadeFrom >= 0 ? f(fadeFrom) + (f(band) - f(fadeFrom)) * fk : f(band));
    if (motionOn) F.time = now / 1000;
    F.cmb = mix(b => (b === 0 ? CMB_A[dark ? 0 : 1] : 0));
    F.tex = t ? mix(NB.alpha) * fl : 0;
    if (t) NB.texOff(cam, W, H, F.texOff);
    F.lines = fadeFrom >= 0 ? fk : 1;
    F.lineW = r.lineW; F.lineKeep = r.keep; F.lenRef = band < 3 ? 1e9 : 320;
    F.twinkle = motionOn && band <= 2 ? 0.1 : 0;
    F.flow = 0;  // curved filaments at U0-U2 read as random dashes with flow; off there
    // hairline bodies: no per-body glow / corona (sun halos are faint sprites); over-blending in both themes so dense
    // discs never sum to white; sprites alone stay additive in the dark (a faint screen-like light)
    F.glow = 0; F.corona = 0; F.haloA = 0; F.add = false;
    F.body = BODY[dark ? 0 : 1]; F.pip = 0.2; F.minR = floorGL; F.minA = floorA;
    F.persp = PERSP; F.sprites = 1; F.spriteAdd = dark;
    gl.draw(F);
    P.cmbOn = F.cmb > 0;
  }
  const GV = {m: null, D: 1, near: 1};
  // face-on factor: 1 at yaw = pitch = 0 (mod 2 pi), 0 past ~7 degrees off (the world-x/y nebula texture)
  function flat() {
    const y = Math.abs(Math.atan2(Math.sin(cam.yaw), Math.cos(cam.yaw))), p = Math.abs(cam.pitch);
    return Math.max(0, 1 - Math.max(y, p) / 0.12);
  }

  // ---- sprites (MX.gl.sprites): basic layer = a watercolour wash per galaxy (core + 4 lobes on its disc plane) + a
  // glow halo per visible sun; anchors re-resolved when positions move; back-to-front only for over-blending (paper)
  // Hairline atmosphere: washes and halos are whispers. SA = [dark, light] alphas: galaxy wash core, lobe (x core),
  // sun halo; halo size x the sun radius. Edge-on clamp: a basic sprite's alpha x (EDGE + (1 - EDGE) x |n . f|), n = its
  // galaxy's disc normal, f = the view direction, so a disc seen edge-on (core + lobes + its suns' halos on one line)
  // never piles up into a bright streak; halos also x 1 / sqrt(suns in the galaxy / HALO_N), at least 1.
  const SA = [[0.06, 0.75, 0.07], [0.07, 0.75, 0.06]], HALO_R = 6, EDGE = 0.3, HALO_N = 8;
  const SPR = MX.gl ? MX.gl.sprites : null;
  let sprVer = -1, sprPos = -1, sprView = "", sprBasic = "", spr2d = null, GN = new Float32Array(0);
  function hash01(k) { let a = (k + 1) * 2654435761 >>> 0; a ^= a >>> 15; a = Math.imul(a, 2246822519) >>> 0; a ^= a >>> 13; return a / 4294967296; }
  function basicSprites() {
    if (!SPR || !SPR.auto || !U.started) return;
    const key = visVer + "|" + S.theme.name + "|" + (S.theme.forced ? 1 : 0) + "|" + U.spacing + "|" + S.zScale;
    if (key === sprBasic) return;
    sprBasic = key;
    const q = S.theme.rgba || {}, list = [], nv = S.nodeVisible, nG = U.galaxies.length, gv = new Uint32Array(nG), gs = new Uint32Array(nG), sa = SA[dark ? 0 : 1];
    if (S.theme.forced) { SPR.set([], "basic"); return; }
    if (GN.length !== 3 * nG) GN = new Float32Array(3 * nG);
    for (let i = 0; i < N; i++) if (nv[i]) gv[U.galaxyOf(i)]++;
    U.galaxies.forEach((G, k) => {
      const c = U.centerOf("galaxy", k), R = U.radiusOf("galaxy", k), gi = G.cluster & 3, c0 = q["gasG" + gi] || q["g" + gi], c1 = q["gasB" + gi] || c0;
      if (!gv[k] || !c || !(R > 0) || !c0) return;
      const h = hash01(k), a0 = sa[0], z0 = U.planeZ(k, c[0], c[1]);
      const nx = -(U.planeZ(k, c[0] + 1, c[1]) - z0), ny = -(U.planeZ(k, c[0], c[1] + 1) - z0), nl = Math.hypot(nx, ny, 1);   // disc normal
      GN[3 * k] = nx / nl; GN[3 * k + 1] = ny / nl; GN[3 * k + 2] = 1 / nl;
      list.push({galaxy: k, size: R * 1.25, color: c0.slice(0, 3), alpha: a0, a0, kind: "wash", rot: h * 6.2832});
      for (let j = 0; j < 4; j++) {
        const a = h * 6.2832 + j * 1.5708 + (hash01(k * 7 + j) - 0.5), d = R * (0.35 + 0.25 * hash01(k * 13 + j)), dx = d * Math.cos(a), dy = d * Math.sin(a);
        list.push({galaxy: k, pos: [dx, dy, U.planeZ(k, c[0] + dx, c[1] + dy) - z0], size: R * (0.55 + 0.25 * hash01(k * 17 + j)),
          color: (j & 1 ? c1 : c0).slice(0, 3), alpha: a0 * sa[1], a0: a0 * sa[1], kind: "wash", rot: hash01(k * 19 + j) * 6.2832});
      }
    });
    for (let y = 0; y < U.systems.length; y++) if (nv[U.systems[y].sun]) gs[U.galaxyOf(U.systems[y].sun)]++;
    for (let y = 0; y < U.systems.length; y++) {
      const sun = U.systems[y].sun, k = U.galaxyOf(sun), c = q["gasG" + (g.group[sun] & 3)] || q.corona;
      if (!nv[sun] || !c) continue;
      const a = sa[2] / Math.sqrt(Math.max(1, gs[k] / HALO_N));
      list.push({body: sun, gal: k, size: RAD[sun] * HALO_R, color: c.slice(0, 3), alpha: a, a0: a, kind: "glow"});
    }
    SPR.set(list, "basic");
  }
  let FW = null;   // view direction for the edge-on clamp (packSprites)
  const sprBase = (it, o) => {
    if (it.a0 != null && FW) {   // basic layer: edge-on clamp (2D: always face-on)
      const k = it.galaxy != null ? it.galaxy : it.gal;
      if (k != null && 3 * k + 2 < GN.length) it.alpha = it.a0 * (S.view3d ? EDGE + (1 - EDGE) * Math.abs(GN[3 * k] * FW[0] + GN[3 * k + 1] * FW[1] + GN[3 * k + 2] * FW[2]) : 1);
    }
    if (it.body != null) { const i = it.body; if (!(i >= 0 && i < N) || !S.nodeVisible[i]) return false; o[0] = S.x[i]; o[1] = S.y[i]; o[2] = S.z[i]; return true; }
    if (it.galaxy != null) { const c = U.centerOf("galaxy", it.galaxy); if (!c) return false; o[0] = c[0]; o[1] = c[1]; o[2] = c[2] || 0; }
    return true;
  };
  function packSprites(force) {  // -> spr2d {a, n}; true = repacked
    if (!SPR) return false;
    basicSprites();
    const v = view(), sort = !dark;
    FW = v.f;
    // repacked when the view direction turns (not on pan / zoom): the edge-on clamp and the paper sort depend on it only
    const dk = cam.yaw + "," + cam.pitch + "," + S.view3d;
    if (!force && sprVer === SPR.version && sprPos === posVer && sprView === dk && spr2d) return false;
    sprVer = SPR.version; sprPos = posVer; sprView = dk;
    spr2d = SPR.pack(sprBase, sort ? v.f : null);
    return true;
  }
  function sprites(force) { if (packSprites(force) || force) gl.sprites(spr2d ? spr2d.a : null, spr2d ? spr2d.n : 0); }

  // ---- Canvas2D fallback on #cv-back (DPR 1): gas, CMB, solid threads, fill-only discs batched per class
  let cmbC = null, cmbR = null, cmbKey = "";
  // 3D: splatted in view-plane coordinates (orthographic, rebuilt when the view turns), drawn with the focal-plane pan/scale
  function cmb2d(c, ox, oy, s) {
    const key = visVer + "|" + S.theme.name + "|" + cam.yaw + "|" + cam.pitch;
    if (key !== cmbKey) {
      cmbKey = key; cmbC = null;
      const v = view(), VX = new Float32Array(N), VY = new Float32Array(N);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < N; i++) if (S.nodeVisible[i]) {
        const x = VX[i] = dot(v.r, S.x[i], S.y[i], S.z[i]), y = VY[i] = dot(v.u, S.x[i], S.y[i], S.z[i]);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      const k = 240 / Math.max(x1 - x0, y1 - y0, 1), w = Math.ceil((x1 - x0) * k) + 32, h = Math.ceil((y1 - y0) * k) + 32;
      const a = document.createElement("canvas"), b = document.createElement("canvas");
      a.width = b.width = w; a.height = b.height = h;
      const ac = a.getContext("2d"), bc = b.getContext("2d");
      ac.globalCompositeOperation = "lighter"; ac.fillStyle = S.theme.colors.cmb1; ac.globalAlpha = 0.12;
      for (let i = 0; i < N; i++) if (S.nodeVisible[i]) ac.fillRect((VX[i] - x0) * k + 15, (VY[i] - y0) * k + 15, 2, 2);
      bc.filter = "blur(6px)"; bc.drawImage(a, 0, 0);
      cmbC = b; cmbR = [x0 - 16 / k, y0 - 16 / k, k];
    }
    if (!cmbC) return;
    c.save();
    c.globalAlpha = CMB_A[dark ? 0 : 1]; c.globalCompositeOperation = dark ? "lighter" : "source-over";
    c.translate(ox, oy); c.scale(s, s);
    c.drawImage(cmbC, cmbR[0], cmbR[1], cmbC.width / cmbR[2], cmbC.height / cmbR[2]);
    c.restore();
  }
  function bucket(n, keyOf, nk) {  // counting sort of 0..n-1 by key -> ORD, KEYS = starts
    KEYS.fill(0, 0, nk + 1);
    for (let j = 0; j < n; j++) KEYS[keyOf(j) + 1]++;
    for (let k = 0; k < nk; k++) KEYS[k + 1] += KEYS[k];
    const at = KEYS.slice(0, nk);
    for (let j = 0; j < n; j++) ORD[at[keyOf(j)]++] = j;
  }
  // sprites on Canvas2D: tinted atlas tiles (cached per kind + colour), centre projected, radius x perspective
  const tint = new Map();
  function tile(kind, c) {
    const A = MX.gl && MX.gl.atlas, key = kind + "|" + c[0].toFixed(3) + "," + c[1].toFixed(3) + "," + c[2].toFixed(3);
    let t = tint.get(key);
    if (t || !A) return t || null;
    const T = A.tile, cv2 = document.createElement("canvas"), x = cv2.getContext("2d"), im = x.createImageData(T, T);
    cv2.width = cv2.height = T;
    for (let j = 0; j < T * T; j++) {
      const a = A.data[Math.floor(j / T) * T * A.kinds + kind * T + (j % T)];
      im.data[4 * j] = c[0] * 255; im.data[4 * j + 1] = c[1] * 255; im.data[4 * j + 2] = c[2] * 255; im.data[4 * j + 3] = a;
    }
    x.putImageData(im, 0, 0);
    if (tint.size > 256) tint.clear();
    tint.set(key, cv2);
    return cv2;
  }
  function drawSprites2d(c) {
    packSprites(false);
    if (!spr2d || !spr2d.n) return;
    const a = spr2d.a, st = MX.gl.SSTRIDE, s = cam.scale, mx = 1.2 * Math.min(W, H), col = [0, 0, 0];
    c.globalCompositeOperation = dark ? "lighter" : "source-over";
    for (let j = 0; j < spr2d.n; j++) {
      const o = j * st;
      if (!project(a[o], a[o + 1], a[o + 2], PJ)) continue;
      const rr = a[o + 3] * s * PJ[2];
      if (rr < 1 || rr > 2 * mx || PJ[0] < -rr || PJ[1] < -rr || PJ[0] > W + rr || PJ[1] > H + rr) continue;
      col[0] = a[o + 4]; col[1] = a[o + 5]; col[2] = a[o + 6];
      const t = tile(Math.round(a[o + 8]) ? 1 : 0, col);
      if (!t) continue;
      c.globalAlpha = Math.min(1, a[o + 7] * (rr > mx ? 1 - (rr - mx) / mx : 1));
      c.drawImage(t, PJ[0] - rr, PJ[1] - rr, 2 * rr, 2 * rr);
    }
    c.globalAlpha = 1; c.globalCompositeOperation = "source-over";
  }
  function drawCanvas(r) {
    const c = bctx, C = S.theme.colors, q = S.theme.rgba || {}, s = cam.scale, ox = cam.panX + W / 2, oy = cam.panY + H / 2;
    const forced = S.theme.forced, L = r.lns, Pt = r.pts, fl = flat();
    c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = "source-over"; c.globalAlpha = 1; c.setLineDash(NODASH);
    c.clearRect(0, 0, W, H);
    P.cmbOn = false;
    view();
    if (!forced && MX.nebula && fl > 0) MX.nebula.draw(c, cam, W, H, band);   // world-x/y nebula: face-on only
    if (!forced && band === 0) { cmb2d(c, ox, oy, s); P.cmbOn = !!cmbC; }
    if (!forced) drawSprites2d(c);
    if (liteNow()) return;
    // threads: class 0 aggregate/idle, 1 hot, 2 path; alpha in 1/32 steps; solid (dashes only on #cv)
    const cls = j => { const f = r.ref[j]; return f >= 0 ? 0 : f >= -M ? 1 : 2; };
    bucket(r.nLns, j => cls(j) * 32 + Math.min(31, Math.round(L[j * LS + 7] * 31)), 96);
    const tok = [band < 3 ? "filament" : "thread", "threadHot", "pathStroke"];
    for (let k = 0; k < 96; k++) {
      let a0 = KEYS[k];
      const a1 = k < 95 ? KEYS[k + 1] : r.nLns;
      // forced colours: idle web = only the 120 strongest edges (buckets ascend by strength), thin GrayText; hot/path stay full
      if (forced && k < 32) a0 = Math.max(a0, KEYS[32] - 120);
      if (a1 <= a0) continue;
      const cl = k >> 5, ta = (q[tok[cl]] || [0, 0, 0, 1])[3] || 1;
      // forced colours has no alpha: with an ego shown, the faint U3+ idle web would paint a solid GrayText wall over it
      if (forced && !cl && band >= 3 && (S.selected >= 0 || S.focus || S.path)) continue;
      c.globalAlpha = forced ? 1 : Math.min(1, (k & 31) / 31 / ta);
      c.strokeStyle = C[tok[cl]]; c.lineWidth = cl ? 1.5 : band < 3 ? r.lineW : 1;
      c.beginPath();
      for (let m = a0; m < a1; m++) {   // both ends projected; a segment with an end behind / near the camera is dropped
        const o = ORD[m] * LS;
        if (!project(L[o], L[o + 1], L[o + 8], PJ) || PJ[2] * LNEAR[0] > 1) continue;
        const x0 = PJ[0], y0 = PJ[1];
        if (!project(L[o + 2], L[o + 3], L[o + 9], PJ) || PJ[2] * LNEAR[0] > 1) continue;
        c.moveTo(x0, y0); c.lineTo(PJ[0], PJ[1]);
      }
      c.stroke();
    }
    // bodies: class = group + 4 dim + 8 tiny | 16 + group lifted; culled to the viewport; rect when < 1.5 px.
    // 3D: projected centres (projectAll), radius x perspective; behind the camera = culled
    const IX = r.index;
    projectAll();
    for (let j = 0; j < r.nPts; j++) {
      const o = j * PS, i = IX[j], f = Pt[o + 7];
      let rr = Pt[o + 2] * s * (f & 1 ? 1.25 : 1) * SK[i];
      const x = SX[i], y = SY[i];
      const gone = faded(rr);     // the camera is passing it (gl.js fades it out)
      if (rr < floorR) rr = small ? floorR : -MINR;  // sign marks "tiny" (small graphs: the floor is a real mark)
      RR[i] = gone || !(SK[i] > 0) || x < -4 - Math.abs(rr) || y < -4 - Math.abs(rr) || x > W + 4 + Math.abs(rr) || y > H + 4 + Math.abs(rr) ? 0 : rr;
    }
    const keyP = j => { const i = IX[j], f = Pt[j * PS + 7], gp = g.group[i] & 3; return !RR[i] ? 20 : f & 1 ? 16 + gp : gp + (f & 2 ? 4 : 0) + (RR[i] < 0 ? 8 : 0); };
    bucket(r.nPts, keyP, 21);
    // hairline marks (= gl.js FS_PT): < BODY[3] + .75 px solid points; larger = dim interior + 1 px rim, all in the
    // group ink mixed BODY[2] toward --accent-stroke (as the shader); a sun adds a centre pip in the pure group ink
    // (>= 2 px, so its centre pixel is the group ink, 14a)
    const bk = BODY[dark ? 0 : 1], solid = bk[3] + 0.75, as = q.accentStroke || [0, 0, 0];
    const mixed = k => { const c = q["g" + k] || as; return "rgb(" + [0, 1, 2].map(j => Math.round(255 * (c[j] + (as[j] - c[j]) * bk[2]))) + ")"; };
    for (let k = 0; k < 20; k++) {
      const a0 = KEYS[k], a1 = KEYS[k + 1];
      if (a1 <= a0) continue;
      const pt = new Path2D(), ring = new Path2D(), pp = new Path2D();
      let np = 0, nq = 0, ns = 0;
      for (let m = a0; m < a1; m++) {
        const i = IX[ORD[m]], rr = Math.abs(RR[i]), x = SX[i], y = SY[i];
        if (rr < 1.5) { const h = RR[i] < 0 ? floorGL : rr; pt.rect(x - h, y - h, 2 * h, 2 * h); np++; }
        else if (rr < solid) { pt.moveTo(x + rr, y); pt.arc(x, y, rr, 0, TAU); np++; }
        else {
          ring.moveTo(x + rr - 0.5, y); ring.arc(x, y, rr - 0.5, 0, TAU); nq++;
          if (ROLE[i] === 0) { const pr = Math.min(2.5, Math.max(1.4, 0.2 * rr)); pp.moveTo(x + pr, y); pp.arc(x, y, pr, 0, TAU); ns++; }   // = gl.js dot
        }
      }
      const ka = k < 16 && k & 4 ? 0.25 : k >= 8 && k < 16 ? TINY_A : 1, bi = bk[0];
      c.fillStyle = c.strokeStyle = forced ? C["g" + (k & 3)] : mixed(k & 3); c.lineWidth = 1;
      if (np) { c.globalAlpha = ka; c.fill(pt); }
      if (nq) { c.globalAlpha = ka * bi; c.fill(ring); c.globalAlpha = ka * bk[1]; c.stroke(ring); }
      if (ns) { c.globalAlpha = ka; c.fillStyle = C["g" + (k & 3)]; c.fill(pp); }
    }
    c.globalAlpha = 1;
  }

  // ---- #cv overlay
  let cands = null, candKey = "";
  const LCAM = {scale: 1, panX: 0, panY: 0}, VIEW = {W: 1, H: 1};
  // label LOD (labels.js): U0 clusters, U1 galaxies, U2 suns, U3+ suns + planets (of systems >= SYS_PX on screen,
  // labelProxies); dust only forced. Forced (bright): the selection (must), the hover (tip), focus root, path, the
  // first 20 search hits, the selection's visible neighbours (labels.js keeps the FCAP highest-degree ones on screen);
  // with a selection / path every other label is dimmed (labels.js DIM) and only placed where room is left.
  // P.labelMore = neighbours beyond NBMAX (for the inspector).
  // Small graphs (< SMALLN[0] bodies): dust is offered like planets and planets need no system size (budget still rules)
  const NBMAX = 40, SYS_PX = 120;
  function candidates() {
    const key = band + "|" + visVer + "|" + selVer;
    if (key === candKey && cands) return cands;
    candKey = key;
    const out = [], nv = S.nodeVisible, fmt = MX.fmt, nC = U.clusters.length, nG = U.galaxies.length;
    const cc = new Uint32Array(nC), gc = new Uint32Array(nG), gpc = new Uint32Array(nC);
    for (let i = 0; i < N; i++) if (nv[i]) { cc[g.group[i]]++; gc[U.galaxyOfBody[i]]++; }
    for (let k = 0; k < nG; k++) if (gc[k]) gpc[U.galaxies[k].cluster]++;
    U.clusters.forEach((C0, c) => {
      const p = U.centerOf("cluster", c);
      if (p && cc[c]) out.push({id: "c" + c, kind: 0, x: p[0], y: p[1], z: p[2] || 0, r: U.radiusOf("cluster", c), text: String(C0.name).toUpperCase(),
        sub: fmt(cc[c]) + " bodies · " + gpc[c] + (gpc[c] === 1 ? " galaxy" : " galaxies"), pri: cc[c], at: ["cluster", c]});
    });
    if (band >= 1) U.galaxies.forEach((G, k) => {
      const p = U.centerOf("galaxy", k);
      if (p && gc[k]) out.push({id: "g" + k, kind: 1, x: p[0], y: p[1], z: p[2] || 0, r: U.radiusOf("galaxy", k), text: G.name + " · " + fmt(gc[k]), pri: gc[k], at: ["galaxy", k]});
    });
    const fm = new Map(), on = i => i >= 0 && i < N && nv[i];
    const force = (i, must) => { if (on(i) && !(fm.get(i) >= 2)) fm.set(i, must ? 2 : 1); };
    force(S.selected, true);
    if (on(S.hover)) fm.set(S.hover, 3);   // 3 = hover tip
    if (S.focus) force(S.focus.root, false);
    if (S.path && S.path.found) for (const i of S.path.nodes) force(i, false);
    if (S.q) { let n = 0; for (const i of S.results) { if (n >= 20) break; if (on(i)) { force(i, false); n++; } } }
    const a = S.selected;
    if (a >= 0) {
      const nb = [];
      for (let k = g.adjOff[a]; k < g.adjOff[a + 1]; k++) { const e = g.adjEdge[k], o = SRC[e] === a ? DST[e] : SRC[e]; if (on(o)) nb.push(o); }
      // all of them forced: the on-screen cut (labelProxies / labels.js) runs before the forced cap (labels.js FCAP,
      // highest degree first), so a global top-NBMAX sitting off-screen can't starve the neighbours in view
      nb.forEach(i => force(i, false));
      P.labelMore = Math.max(0, nb.length - NBMAX);
    } else P.labelMore = 0;
    const dim = a >= 0 || !!(S.path && S.path.found), TY = (g.D && g.D.types) || [];
    if (dim) for (const c of out) c.dim = true;
    for (let i = 0; i < N; i++) {
      if (!nv[i]) continue;
      const kind = small ? Math.min(3, 2 + ROLE[i]) : 2 + ROLE[i], f = fm.get(i);   // small graphs: dust labels like planets
      if ((kind > band || kind === 4) && !f) continue;
      out.push({id: i, kind, x: S.x[i], y: S.y[i], z: S.z[i], r: RAD[i], text: g.label[i], pri: g.deg[i], force: f === 1, must: f === 2,
        tip: f === 3, dim: dim && !f, type: f === 3 ? TY[g.type[i]] : null, sys: U.sys[i]});
    }
    posDirty = false;
    return (cands = out);
  }
  function refreshPos() {  // orbits moved: same objects, new positions
    if (!cands) return;
    for (const c of cands) {
      if (typeof c.id === "number") { c.x = S.x[c.id]; c.y = S.y[c.id]; c.z = S.z[c.id]; }
      else { const p = U.centerOf(c.at[0], c.at[1]); if (p) { c.x = p[0]; c.y = p[1]; c.z = p[2] || 0; } }
    }
    MX.labels.invalidate();
  }

  const CL = [0, 0, 0, 0];
  function clip(x0, y0, x1, y1) {  // Liang-Barsky to the view -> CL
    const dx = x1 - x0, dy = y1 - y0, P = [-dx, dx, -dy, dy], Q = [x0, W - x0, y0, H - y0];
    let a = 0, b = 1;
    for (let k = 0; k < 4; k++) { const t = Q[k] / P[k]; if (!P[k]) { if (!(Q[k] >= 0)) return false; } else if (P[k] < 0) { if (t > a) a = t; } else if (t < b) b = t; }
    CL[0] = x0 + a * dx; CL[1] = y0 + a * dy; CL[2] = x0 + b * dx; CL[3] = y0 + b * dy;
    return a <= b;
  }
  // labels in 3D: screen-space proxies (labels.js sees scale 1, pan 0); behind the camera / past LFAR (bodies) dropped,
  // off-screen culled before placement; the same array is handed back while nothing moved (labels.js cache)
  let lab = {key: "", list: []};
  function labelProxies(cs, sr) {
    const key = projKey + "|" + candKey + "|" + (cs === cands ? 1 : 0) + "|" + sr.l + "," + sr.t + "," + sr.r + "," + sr.b + "|" + lastLab;
    if (key === lab.key) return lab.list;
    const out = [], s = cam.scale, w = sr.r - sr.l, h = sr.b - sr.t;
    // F10: a cluster label hangs off its own cluster's projected bounds (x = its members' mean, y = their top / bottom
    // incl. radii), so in 3D it never floats between clusters (labels.js: below the lowest member, else above the top)
    const CB = cs.some(c => c.kind === 0) ? clusterBounds() : null;
    for (const c of cs) {
      let x, y, k, rr;
      if (c.kind === 0 && CB) {
        const j = 5 * c.at[1];
        if (!(CB[j + 4] > 0)) continue;
        x = CB[j] / CB[j + 4]; y = (CB[j + 1] + CB[j + 2]) / 2; rr = (CB[j + 2] - CB[j + 1]) / 2; k = 1;
      } else {
        if (typeof c.id === "number") { k = SK[c.id]; x = SX[c.id]; y = SY[c.id]; } else { if (!project(c.x, c.y, c.z || 0, PJ)) continue; x = PJ[0]; y = PJ[1]; k = PJ[2]; }
        if (!(k > 0) || (c.kind >= 2 && k < LFAR && !c.must && !c.force && !c.tip)) continue;
        // galaxies are discs near the xy plane: their screen rim shrinks with tilt (labels sit above it)
        rr = c.kind >= 2 ? (c.must ? Math.max(SEL[0] * 1.25 * bodyR(c.id, null, k), 1.25 * bodyR(c.id, null, k) + 3) : bodyR(c.id, null, k) * (c.force || c.tip ? 1.25 : 1)) : c.r * s * k * Math.max(0.35, Math.abs(Math.cos(cam.pitch)));
        if (c.kind === 3 && !small && !c.must && !c.force && !c.tip) {   // planets: only inside a system >= SYS_PX on screen
          const y0 = c.sys, sun = y0 >= 0 ? U.systems[y0].sun : -1;
          if (!(sun >= 0 && SK[sun] > 0 && U.radiusOf("system", y0) * s * SK[sun] >= SYS_PX)) continue;
        }
      }
      x -= sr.l; y -= sr.t;
      if (x < -200 - rr || x > w + 200 + rr || y < -50 - rr || y > h + 50 + rr) continue;
      out.push({id: c.id, kind: c.kind, x, y, r: rr, text: c.text, sub: c.sub, pri: c.pri, force: c.force, must: c.must, tip: c.tip, dim: c.dim, type: c.type});
    }
    lab = {key, list: out};
    return out;
  }
  // per cluster (group) over the visible projected bodies: [sum x, top, bottom, -, n] (bottom / top include radii)
  let CBF = new Float64Array(0);
  function clusterBounds() {
    const nC = U.clusters.length;
    if (CBF.length !== 5 * nC) CBF = new Float64Array(5 * nC);
    for (let c = 0; c < nC; c++) { CBF[5 * c] = 0; CBF[5 * c + 1] = Infinity; CBF[5 * c + 2] = -Infinity; CBF[5 * c + 4] = 0; }
    for (let i = 0; i < N; i++) {
      if (!S.nodeVisible[i] || !(SK[i] > 0) || SX[i] < -W || SX[i] > 2 * W || SY[i] < -H || SY[i] > 2 * H) continue;
      const j = 5 * g.group[i], r = bodyRp(i);
      if (j >= CBF.length) continue;
      CBF[j] += SX[i]; CBF[j + 4]++;
      if (SY[i] - r < CBF[j + 1]) CBF[j + 1] = SY[i] - r;
      if (SY[i] + r > CBF[j + 2]) CBF[j + 2] = SY[i] + r;
    }
    return CBF;
  }
  // selection / hover mark (hairline): the body keeps its own symbol; a soft halo (radial gradient, Gaussian stops:
  // HALO_IN x peak at the centre rising to the peak HALO_A at r, then exp(-4.6 u^2) out to max(SEL[2] r, r + 16) capped at
  // r + HALO_CAP px: no hard edge, no dark core) in the group ink mixed HALO_MIX toward neutral, a
  // crisp 1 px ring at max(SEL[0] r, r + 3) (WebGL: the shader's flag-8 ring on the selection; drawn here for the hover
  // and on Canvas2D), a faint dashed guide at max(SEL[1] r, r + 8). Hover: w = .5. r = the drawn (lifted) radius.
  function mark(i, w, C) {
    const x = SX[i], y = SY[i], r = bodyRp(i) * 1.25, q = S.theme.rgba || {}, ac = q.accentStroke || [0.5, 0.5, 0.5], ink = q["g" + (g.group[i] & 3)] || ac;
    if (faded(r) || x < -4 * r || y < -4 * r || x > W + 4 * r || y > H + 4 * r) return;
    if (!S.theme.forced) {
      const R = Math.min(Math.max(SEL[2] * r, r + 16), r + HALO_CAP), a = HALO_A[dark ? 0 : 1] * w, rgb = [0, 1, 2].map(j => Math.round(255 * (ink[j] + (ac[j] - ink[j]) * HALO_MIX))).join(",");
      const gr = ctx.createRadialGradient(x, y, 0, x, y, R), at = d => Math.max(0, Math.min(1, d / R));
      for (let k = 0; k < 4; k++) { const u = k / 4; gr.addColorStop(at(u * r), "rgba(" + rgb + "," + (a * (HALO_IN + (1 - HALO_IN) * u * u)).toFixed(4) + ")"); }
      for (let k = 0; k <= 8; k++) { const u = k / 8; gr.addColorStop(at(r + (R - r) * u), "rgba(" + rgb + "," + (a * Math.exp(-4.6 * u * u)).toFixed(4) + ")"); }
      gr.addColorStop(1, "rgba(" + rgb + ",0)");
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
    }
    ctx.strokeStyle = C.selRing; ctx.lineWidth = 1;
    if (mode === "canvas" || w < 1) { ctx.globalAlpha = 0.9 * w; ctx.beginPath(); ctx.arc(x, y, Math.max(SEL[0] * r, r + 3), 0, TAU); ctx.stroke(); }
    ctx.globalAlpha = 0.22 * w; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.arc(x, y, Math.max(SEL[1] * r, r + 8), 0, TAU); ctx.stroke();
    ctx.setLineDash(NODASH); ctx.globalAlpha = 1;
  }
  let labBusy = false, labSel = -1;
  function overlay(now) {
    const C = S.theme.colors, s = cam.scale, X = S.x, Y = S.y, Z = S.z, ev = S.edgeVisible;
    projectAll();
    const px = i => SX[i], py = i => SY[i], seen = e => SK[SRC[e]] > 0 && SK[DST[e]] > 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1; ctx.setLineDash(NODASH); ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);
    const path = S.path && S.path.found ? S.path : null;
    phase = "path";  // the one bright route (--path-stroke) over a surface halo, dashed by provenance
    if (path && path.edges.length) {
      ctx.lineWidth = 5; ctx.strokeStyle = C.pathHalo; ctx.beginPath();
      for (const e of path.edges) if (seen(e)) { ctx.moveTo(px(SRC[e]), py(SRC[e])); ctx.lineTo(px(DST[e]), py(DST[e])); }
      ctx.stroke();
      ctx.lineWidth = 3; ctx.strokeStyle = C.accentStroke;
      for (let p = 0; p < 3; p++) {
        ctx.setLineDash(DASH[p]); ctx.beginPath();
        for (const e of path.edges) if (g.prov[e] === p && seen(e)) { ctx.moveTo(px(SRC[e]), py(SRC[e])); ctx.lineTo(px(DST[e]), py(DST[e])); }
        ctx.stroke();
      }
    }
    phase = "focus";  // webgl: scene.js hot lines; canvas: clipped, dashed if <= 64
    const fo = S.selected >= 0 ? S.selected : S.hover, a0 = g.adjOff[fo], a1 = g.adjOff[fo + 1];
    if (mode === "canvas" && fo >= 0 && S.nodeVisible[fo]) {
      const on = e => ev[e] && seen(e) && clip(px(SRC[e]), py(SRC[e]), px(DST[e]), py(DST[e]));
      let n = 0;
      for (let k = a0; k < a1 && n <= 64; k++) n += on(g.adjEdge[k]);
      ctx.strokeStyle = C.prov; ctx.lineWidth = 1.6;
      for (let p = 0, dash = n <= 64; p < 3; p++) {  // > 64: solid, alpha by provenance (scene T.prov)
        ctx.setLineDash(dash ? DASH[p] : NODASH); ctx.globalAlpha = dash ? 1 : MX.scene.T.prov[p]; ctx.beginPath();
        for (let k = a0; k < a1; k++) { const e = g.adjEdge[k]; if (g.prov[e] === p && on(e)) { ctx.moveTo(CL[0], CL[1]); ctx.lineTo(CL[2], CL[3]); } }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    phase = "lanes";
    ctx.setLineDash(NODASH);
    if (band >= 3 && !S.theme.forced) lanes(C, s);
    phase = "rings";
    ctx.globalAlpha = 1;
    if (mode === "canvas" && S.q && S.results.length) {  // GL draws hit rings in-shader (flag 8)
      ctx.strokeStyle = C.searchHit; ctx.lineWidth = 1.5; ctx.beginPath();
      let n = 0;
      for (const i of S.results) {
        if (n++ > 400) break;
        if (!S.nodeVisible[i] || !(SK[i] > 0)) continue;
        const x = px(i), y = py(i), r = bodyRp(i) + 2;
        if (x < -r || y < -r || x > W + r || y > H + r) continue;
        ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU);
      }
      ctx.stroke();
    }
    const sel = S.selected, hv = S.hover;
    if (sel >= 0 && S.nodeVisible[sel] && SK[sel] > 0) mark(sel, 1, C);
    if (hv >= 0 && hv !== sel && S.nodeVisible[hv] && SK[hv] > 0) mark(hv, 0.5, C);   // hover: half strength
    if (voidOn && ahead()) voidHint(false);
    const uv = S.universe;  // drill cursor: soft ring around the cluster / galaxy it points at
    if (uv && band <= 3) {
      const gk = uv.level === "galaxy" || (uv.level === "cluster" && uv.galaxy >= 0);
      const kind = gk ? "galaxy" : "cluster", id = gk ? uv.galaxy : uv.cluster, p = id >= 0 ? U.centerOf(kind, id) : null;
      if (p && uv.level !== "system" && project(p[0], p[1], p[2] || 0, PJ)) {
        const R = U.radiusOf(kind, id) * s * PJ[2], x = PJ[0], y = PJ[1];
        if (R > 6 && x > -R && y > -R && x < W + R && y < H + R) {
          ctx.strokeStyle = C.accentStroke; ctx.lineWidth = 6; ctx.globalAlpha = 0.12;
          ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.stroke();
          ctx.lineWidth = 1.5; ctx.globalAlpha = 0.6; ctx.setLineDash([6, 5]);
          ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.stroke();
          ctx.setLineDash(NODASH); ctx.globalAlpha = 1;
        }
      }
    }
    const kc = S.kbdCursor;
    if (kc >= 0 && kc < N && S.nodeVisible[kc] && SK[kc] > 0) {
      ctx.strokeStyle = C.focusRing; ctx.lineWidth = 2; ctx.setLineDash([3, 2]);
      ctx.beginPath(); ctx.arc(px(kc), py(kc), bodyRp(kc) * 1.25 + (kc === sel ? 6.5 : 3.5), 0, TAU); ctx.stroke();
      ctx.setLineDash(NODASH);
    }
    phase = "labels";
    const cs = candidates();
    if (posDirty && now - lastLab > 250) { refreshPos(); posDirty = false; lastLab = now; }
    const sr = safeRect();  // labels live in the safe rect, never under glass
    VIEW.W = sr.r - sr.l; VIEW.H = sr.b - sr.t; LCAM.scale = 1;   // proxies are already in safe-rect px
    LCAM.panX = -VIEW.W / 2; LCAM.panY = -VIEW.H / 2;
    const fadeL = selVer !== labSel && labSel >= 0 && MX.motionOK();   // selection / hover changed: labels fade
    labSel = selVer;
    MX.labels.place(LCAM, band, labelProxies(cs, sr), VIEW, {fade: fadeL, now});
    ctx.save(); ctx.translate(sr.l, sr.t); ctx.beginPath(); ctx.rect(0, 0, VIEW.W, VIEW.H); ctx.clip();
    labBusy = MX.labels.draw(ctx, now); ctx.restore();
    P.lastLabels = MX.labels.boxes;
    phase = "";
  }
  // orbit lane guides: r*s*k >= 12 px, cap 300; 3D: each ring is the circle on its system's orbital plane
  // (universe.systemTilt), projected as a 48-segment polyline
  function lanes(C, s) {
    const X = S.x, Y = S.y, Z = S.z, ms = U.memStart, mem = U.members, nv = S.nodeVisible, SEG = 48;
    ctx.strokeStyle = C.orbitRing; ctx.lineWidth = 1; ctx.beginPath();
    let n = 0;
    for (let y = 0; y < U.systems.length && n < 300; y++) {
      const a = ms[y], b = ms[y + 1];
      if (b - a < 2) continue;
      const sun = mem[a], k = SK[sun], cx = SX[sun], cy = SY[sun], R = U.radiusOf("system", y) * s * k;
      if (!(k > 0) || !(R >= 12) || cx < -R || cy < -R || cx > W + R || cy > H + R) continue;
      const tl = U.systemTilt(y);
      let prev = -1;
      for (let m = a + 1; m < b && n < 300; m++) {
        const i = mem[m];
        if (!nv[i]) continue;
        const rw = Math.hypot(X[i] - X[sun], Y[i] - Y[sun]), r = rw * s * k;
        if (r < 12 || Math.abs(r - prev) < 3) continue;
        prev = r; n++;
        let pen = false;
        for (let q = 0; q <= SEG; q++) {
          const t = q / SEG * TAU, dx = rw * Math.cos(t), dy = rw * Math.sin(t);
          if (!project(X[sun] + dx, Y[sun] + dy, Z[sun] + tl[0] * dx + tl[1] * dy, PJ)) { pen = false; continue; }
          if (pen) ctx.lineTo(PJ[0], PJ[1]); else { ctx.moveTo(PJ[0], PJ[1]); pen = true; }
        }
      }
    }
    ctx.stroke();
  }

  // ---- picking (3D): nearest body in screen space after projection, same radius as draw. A GC px grid over the
  // projected centres is built once per projection (O(N)) and reused while the view holds (hover = O(cells))
  const GC = 32, GRID = {key: "", cols: 0, rows: 0, start: null, items: new Int32Array(N), maxHit: 0, rad: new Float32Array(N)};
  function grid() {
    projectAll();
    if (GRID.key === projKey + "|" + cam.scale) return GRID;
    GRID.key = projKey + "|" + cam.scale;
    const cols = Math.max(1, Math.ceil(W / GC) + 4), rows = Math.max(1, Math.ceil(H / GC) + 4), nc = cols * rows;
    if (!GRID.start || GRID.start.length < nc + 1) GRID.start = new Int32Array(nc + 1);
    const st = GRID.start, cell = new Int32Array(N).fill(-1);
    st.fill(0, 0, nc + 1);
    let mh = 0;
    for (let i = 0; i < N; i++) {
      if (!(SK[i] > 0)) continue;
      const cx = Math.floor(SX[i] / GC) + 2, cy = Math.floor(SY[i] / GC) + 2;
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
      const r = GRID.rad[i] = bodyRp(i);
      if (faded(r)) continue;
      if (r + 4 > mh) mh = r + 4;
      cell[i] = cy * cols + cx; st[cell[i] + 1]++;
    }
    for (let c = 0; c < nc; c++) st[c + 1] += st[c];
    const at = st.slice(0, nc);
    for (let i = 0; i < N; i++) if (cell[i] >= 0) GRID.items[at[cell[i]]++] = i;
    GRID.cols = cols; GRID.rows = rows; GRID.maxHit = mh;
    return GRID;
  }
  function pick(mx, my) {
    if (!W || !H) return -1;
    const G = grid(), R = Math.ceil(G.maxHit / GC), cx = Math.floor(mx / GC) + 2, cy = Math.floor(my / GC) + 2;
    let best = -1, bestV = Infinity;
    for (let y = Math.max(0, cy - R); y <= Math.min(G.rows - 1, cy + R); y++) for (let x = Math.max(0, cx - R); x <= Math.min(G.cols - 1, cx + R); x++) {
      const c = y * G.cols + x;
      for (let j = G.start[c]; j < G.start[c + 1]; j++) {
        const i = G.items[j], r = G.rad[i], hit = r + 4, dx = SX[i] - mx, dy = SY[i] - my, d2 = dx * dx + dy * dy;
        if (d2 > hit * hit) continue;
        const d = Math.sqrt(d2), v = d <= r ? -1e9 + 1 / SK[i] : d - r;  // inside: nearest (largest SK) wins; else closest rim
        if (v < bestV) { bestV = v; best = i; }
      }
    }
    return best;
  }
  MX.pick = pick;

  const r2 = v => Math.round(v * 100) / 100;
  const status = () => ({renderer: mode, glReason, band: band < 0 ? null : "U" + band, fitAll: r2(fitAll * 1e4) / 1e4, scale: r2(cam.scale * 1e4) / 1e4,
    view3d: {mode: S.view3d ? "3d" : "2d", zScale: r2(S.zScale), yaw: r2(cam.yaw / DEG), pitch: r2(cam.pitch / DEG), spin: spinNow, spun, sprites: spr2d ? spr2d.n : 0,
      spinRestMs: Math.max(0, Math.round(interacted ? IDLE - (performance.now() - lastInput) : SPIN_DELAY0 - (performance.now() - readyAt))) || 0, interacted},
    glPoints: last ? last.nPts : 0, glLines: last ? last.nLns : 0, animFrames, motion: motionOn, cmb: P.cmbOn, frames: P.frames,
    glLinkMs, glDeferred, firstPaintLite: firstLite, firstFullPaintMs: fullMs && r2(fullMs)});
  MX.render = {status, get mode() { return mode; }, get band() { return band; }};

  // ---- bench (#bench=1): MXBENCH line on stderr + #hint
  function startBench() {
    let allRaf = 0, lastRafAt = 0, done = false;
    const raf0 = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = cb => raf0(t => { allRaf++; lastRafAt = performance.now(); cb(t); });
    const wait = ms => new Promise(res => setTimeout(res, ms)), next = () => new Promise(res => raf0(() => res()));
    const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const pct = (a, p) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
    function finish(extra) {
      if (done) return;
      done = true;
      const out = Object.assign({renderer: mode, glReason, band: "U" + band, view3d: {yaw: r2(cam.yaw / DEG), pitch: r2(cam.pitch / DEG), sprites: spr2d ? spr2d.n : 0}, firstPaintMs: r2(P.firstPaintMs),
        firstFullPaintMs: fullMs && r2(fullMs), firstPaintLite: firstLite, reducedMotion: S.reducedMotion, anim: S.anim !== false, motionReason: U.motionReason(), glPoints: last ? last.nPts : 0,
        glLines: last ? last.nLns : 0, frames: P.frames, settled: !!S.settled}, extra || {});
      S.bench = out; window.__mx = {bench: out};
      const json = JSON.stringify(out), hint = $("hint");
      if (hint) hint.textContent = "MXBENCH " + json;
      console.log("MXBENCH " + json);
      MX.status();
    }
    setTimeout(() => finish({timeout: true}), 240000);   // software-GL headless runs at a few rAF / s
    let started = false;
    MX.on("settled", () => {
      if (started) return;
      started = true;
      setTimeout(async () => {
        for (let i = 0; glWait && i < 100; i++) await wait(30);
        const a0 = animFrames, f0 = P.frames, st = U.step, ph = [];
        U.step = (...a) => { const t = performance.now(), v = st(...a); ph.push(performance.now() - t); return v; };
        rec.ms = []; rec.at = []; rec.on = true;
        await wait(1000);  // idle / motion window
        const idleMs = rec.ms.slice();
        rec.ms = []; rec.at = [];
        for (let p = 0; p < 3; p++) for (let f = 0; f < 40; f++) {  // pan 3x
          await next();
          const d = (p & 1 ? -1 : 1) * 6;
          camera.panBy(d, d / 2);
        }
        await next(); await next();
        rec.on = false;
        const pan = rec.ms.slice(), at = rec.at.slice(), gaps = at.slice(1).map((t, j) => t - at[j]);
        let gpu = [];
        if (mode === "webgl" && gl) {
          const px = new Uint8Array(4), G = gl.gl;
          for (let k = 0; k < 15; k++) { const t = performance.now(); draw(t); G.readPixels(0, 0, 1, 1, G.RGBA, G.UNSIGNED_BYTE, px); gpu.push(performance.now() - t); }
        }
        const bands = {}, c0 = Object.assign({}, cam);
        for (let k = 0; k < 5; k++) {  // band walk
          applyCam(k); requestDraw(); await next(); await next();
          rec.ms = []; rec.on = true;
          for (let f = 0; f < 30; f++) { await next(); camera.panBy(f & 1 ? -4 : 4, 0); }
          rec.on = false;
          bands["U" + k] = {avg: r2(avg(rec.ms)), p95: r2(pct(rec.ms, 0.95))};
        }
        Object.assign(cam, c0); band = -1; requestDraw();
        U.step = st;
        const cs = MX.cosmos && MX.cosmos.stats();
        const panEnd = performance.now();
        let rafIdle = false, idleWithinMs = -1;
        while (performance.now() - panEnd < 10000) {
          const c = allRaf, t = performance.now();
          await wait(1000);
          if (allRaf === c) { rafIdle = true; idleWithinMs = r2(t - panEnd); break; }
        }
        let tp = performance.now();
        for (let n = 0; n < 200; n++) pick(Math.random() * W, Math.random() * H);
        const pickMs = r2((performance.now() - tp) / 200);
        const all = idleMs.concat(pan);
        finish({avgFrameMs: r2(avg(all)), p95FrameMs: r2(pct(all, 0.95)), panAvgMs: r2(avg(pan)), panP95Ms: r2(pct(pan, 0.95)),
          idleAvgMs: r2(avg(idleMs)), idleFrames: idleMs.length, panFrames: pan.length, rafGapP95Ms: r2(pct(gaps, 0.95)),
          gpuFrameMs: gpu.length ? r2(avg(gpu)) : null, rafIdle, idleWithinMs, animFrames: animFrames - a0, animFramesTotal: animFrames,
          framesInBench: P.frames - f0, pickMs, scene: MX.scene.stats && MX.scene.stats(), glLinkMs, glReadyMs, glDeferred, bands,
          physicsMs: ph.length ? {avg: r2(avg(ph)), p95: r2(pct(ph, 0.95))} : null,
          cosmosMs: cs && cs.jsSamples ? {avg: r2(cs.jsAvgMs), p95: r2(cs.jsP95Ms)} : null});
      }, 600);
    });
  }

  // ---- self-tests (render.*)
  const ORDER = Uint32Array.from({length: N}, (_, i) => i).sort((a, b) => g.deg[b] - g.deg[a] || a - b);
  function topVisible(pred) {
    for (let j = 0; j < N; j++) { const i = ORDER[j]; if (S.nodeVisible[i] && (!pred || pred(i))) return i; }
    return -1;
  }
  const fail = m => { throw new Error(m); };
  const sk = m => (MX.selftest.skip ? MX.selftest.skip(m) : fail("n/a: " + m));   // data not in this graph -> n/a
  function withView(fn) {
    const c = {scale: cam.scale, panX: cam.panX, panY: cam.panY, userAdjusted: cam.userAdjusted, yaw: cam.yaw, pitch: cam.pitch, fz: cam.fz}, sel = S.selected, hv = S.hover;
    const fin = () => { Object.assign(cam, c); S.hover = hv; if (S.selected !== sel) MX.select(sel); band = -1; requestDraw(); };
    let r;
    try { r = fn(); } catch (e) { fin(); throw e; }
    if (r && r.then) return r.then(v => { fin(); return v; }, e => { fin(); throw e; });
    fin(); return r;
  }
  const now = () => performance.now();
  const wait = ms => new Promise(res => setTimeout(res, ms));
  const INF = g.D.provs.indexOf("INFERRED");
  MX.selftest.add("render.bands", () => withView(() => {
    computeFit();
    if (!(fitAll > 0)) { if (topVisible() < 0) sk("empty graph"); fail("no fitAll"); }
    camera.fit(0.88); band = -1; draw(now());
    if (band !== 0 && small) sk("small graph: fit-all opens at U" + band);
    if (band !== 0) fail("fit-all opens at U" + band + ", want U0 (fitAll " + fitAll + ", T0 " + TH[0] + ")");
    const T2 = TH[2];
    const cases = [[2, T2 * 1.05, 2], [2, T2 * 1.15, 3], [3, T2 / 1.05, 3], [3, T2 / 1.15, 2], [-1, T2 * 1.05, 3]];
    for (const [c0, s, want] of cases) { const got = hyst(c0, s); if (got !== want) fail("hyst(U" + c0 + ", " + s.toFixed(4) + ") = U" + got + ", want U" + want); }
    camera.zoomBy(1e-6);
    if (Math.abs(cam.scale - ZMIN * fitAll) > 1e-9) fail("min clamp " + cam.scale + " != ZMIN*fitAll " + ZMIN * fitAll);
    camera.zoomBy(1e9);
    if (cam.scale !== SMAX) fail("max clamp " + cam.scale);
    const T0 = view().T.slice();
    camera.zoomBy(2);   // 3D: past SMAX the eye keeps flying in (the pivot is carried ahead); 2D: stays
    const moved = Math.hypot(...view().T.map((v, c) => v - T0[c])) > 0;
    if (cam.scale !== SMAX || moved !== S.view3d) fail("past SMAX: scale " + cam.scale + ", pivot moved " + moved + ", 3D " + S.view3d);
    band = -1; draw(now());
    if (band !== 4) fail("scale 12 is U" + band);
  }));
  MX.selftest.add("render.cmb", () => withView(() => {
    if (topVisible() < 0) sk("no visible body");
    camera.fit(0.88); band = -1; draw(now());
    if (band !== 0 && small) sk("small graph: fit-all opens at U" + band + " (CMB is a U0 layer)");
    if (!S.theme.forced && !P.cmbOn) fail("no CMB at U0 (" + mode + ")");
    camera.centerOn(topVisible(), Math.sqrt(TH[1] * TH[2])); band = -1; draw(now());
    if (band !== 2) fail("expected U2, got U" + band);
    if (P.cmbOn) fail("CMB still drawn at U2");
  }));
  MX.selftest.add("render.animIdle", async () => {
    const was = S.anim !== false, sel0 = S.selected, top = topVisible();
    try {
      MX.filter.setAnim(false, true);
      MX.select(top);
      for (let i = 0, q = -1; i < 10 && q !== P.rafCount; i++) { q = P.rafCount; await wait(300); }  // let the select's own frames drain (slow under load)
      const c = P.rafCount, a = animFrames;
      await wait(1000);
      if (P.rafCount !== c) fail("rAF kept running with motion off: " + (P.rafCount - c) + " frames");
      if (animFrames !== a) fail("animFrames moved with motion off");
      MX.filter.setAnim(true, true);
      requestDraw();
      await wait(400);
      const live = mode === "webgl" && U.motionReason() === "";
      if (live && animFrames === a) drawNow();  // headless GPU: rAF may stall under virtual time; one sync frame proves the gate
      if (live && animFrames === a) fail("motion on (webgl) but no animation frames");
      if (live && !pending && !timer) fail("motion on (webgl) but no next frame scheduled");
      if (!live && animFrames !== a) fail("animation frames without a running motion gate (" + mode + ", " + U.motionReason() + ")");
    } finally {
      MX.filter.setAnim(was, true);
      if (S.selected !== sel0) MX.select(sel0);
    }
  });
  MX.selftest.add("render.fallback", () => withView(async () => {
    if (topVisible() < 0) sk("no visible body");
    const m0 = mode;
    forceCanvas = true; chooseMode();
    try {
      camera.fit(0.88); band = -1; draw(now());
      if (mode !== "canvas" || status().renderer !== "canvas") fail("forced fallback renders " + mode);
      if (!glReason) fail("no glReason in canvas mode");
      const i = topVisible(), x = Math.round(SX[i]), y = Math.round(SY[i]);
      if (!(back.width > 0) || !(bctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data[3] > 0)) fail("fallback drew nothing at the top body");
    } finally {
      forceCanvas = false; chooseMode();
    }
    if (m0 === "webgl" && mode !== "webgl") fail("did not return to webgl");
    // real context loss + restore (GPU only; --disable-gpu has no WEBGL_lose_context and keeps the forced path above)
    const lc = m0 === "webgl" && gl && (glc.getContext("webgl2") || glc.getContext("webgl")).getExtension("WEBGL_lose_context");
    if (!lc) return;
    const until = async (ok, ms) => { for (let t = 0; t < ms && !ok(); t += 50) await wait(50); return ok(); };
    lc.loseContext();
    if (!await until(() => mode === "canvas", 3000)) fail("context loss did not fall back to canvas");
    if (!/lost/.test(glReason) || status().renderer !== "canvas") fail("lost glReason: " + glReason);
    lc.restoreContext();
    if (!await until(() => mode === "webgl", 5000)) fail("context restore did not return to webgl");
  }));
  // 14a: a drawn disc's centre shows its group ink (S.theme.rgba g<n>), not --surface. Fallback path (#cv-back).
  MX.selftest.add("render.fillInk", () => withView(() => {
    if (topVisible(i => ROLE[i] === 0) < 0) sk("no visible sun");
    MX.select(-1); S.hover = -1;
    const suns = U.sun && U.sun.length ? Array.from(U.sun) : Array.from(ORDER.slice(0, 200));
    suns.sort((a, b) => g.deg[b] - g.deg[a] || a - b);
    const ink = S.theme.rgba, sr = safeRect(), bad = [];
    const check = (view, need) => {
      draw(now());
      if (mode !== "canvas") drawCanvas(last);
      let n = 0;
      const why = [0, 0, 0];
      for (const i of suns) {
        if (n >= 6) break;
        const rr = RR[i];
        if (!S.nodeVisible[i] || !(rr >= 3)) { why[0]++; continue; }
        const x = SX[i], y = SY[i], grp = g.group[i];
        if (x < sr.l + rr || x > sr.r - rr || y < sr.t + rr || y > sr.b - rr) { why[1]++; continue; }
        let foreign = false;
        for (let j = 0; j < N && !foreign; j++) if (j !== i && S.nodeVisible[j] && RR[j] && g.group[j] !== grp && Math.hypot(SX[j] - x, SY[j] - y) <= Math.abs(RR[j]) + 1) foreign = true;
        if (foreign) { why[2]++; continue; }
        const px = bctx.getImageData(Math.round(x), Math.round(y), 1, 1).data, want = ink["g" + grp];
        n++;
        for (let c = 0; c < 3; c++) if (Math.abs(px[c] - want[c] * 255) > 40) { bad.push(view + " " + g.id[i] + " g" + grp + " px " + Array.from(px).slice(0, 3) + " want " + want.slice(0, 3).map(v => Math.round(v * 255))); break; }
      }
      if (mode !== "canvas") { bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.clearRect(0, 0, back.width, back.height); }
      if (n < need && small) sk("small graph: " + n + " sun centres >= 3 px at " + view);
      if (n < need) fail(view + ": only " + n + " sun centres sampled (need " + need + "); skipped hidden/offscreen/foreign " + why);
    };
    // true perspective: suns are ~1 px at fit-all (no scale floor), so the 3-sun sample is taken at U2 on the busiest
    // galaxy (suns >= 3 px), not at fit
    const G0 = (camera.fit(0.88), bigGalaxies())[0], gc = G0 ? vplane(G0.c[0], G0.c[1], G0.c[2] || 0) : null;
    if (gc) { cam.scale = clampScale(Math.sqrt(TH[1] * TH[2])); const sr0 = safeRect(); cam.panX = (sr0.l + sr0.r) / 2 - W / 2 - gc[0] * cam.scale; cam.panY = (sr0.t + sr0.b) / 2 - H / 2 - gc[1] * cam.scale; cam.fz = gc[2]; }
    check("galaxy", 3);
    camera.centerOn(suns.find(i => S.nodeVisible[i]), 1); check("near", 1);
    if (bad.length) fail(bad.slice(0, 4).join("; "));
  }));
  const FK = ["setLineDash", "moveTo", "lineTo"];
  function focusRec(cv) {  // focus-phase ctx calls of one draw()
    const L = [];
    for (const k of FK) ctx[k] = function () { if (phase === "focus") L.push([k, ...arguments]); return ctx.__proto__[k].apply(this, arguments); };
    forceCanvas = cv; chooseMode();
    try { draw(now()); } finally { for (const k of FK) delete ctx[k]; forceCanvas = false; chooseMode(); }
    return L;
  }
  MX.selftest.add("render.focusDash", () => withView(() => {  // canvas, <= 64 edges
    const i = topVisible(n => g.deg[n] <= 64 && g.adjEdge.subarray(g.adjOff[n], g.adjOff[n + 1]).some(e => g.prov[e] === INF && S.edgeVisible[e]));
    if (i < 0) sk("no node with visible INFERRED edges");
    MX.select(i); S.hover = -1; camera.centerOn(i, 1.2);
    if (!focusRec(true).some(c => c[1] + "" === "4,3")) fail("focus pass never set [4,3]");
  }));
  MX.selftest.add("render.focusGL", () => withView(() => {  // <top> at U3
    const i = topVisible(), wg = mode === "webgl";
    if (i < 0) sk("no visible body");
    MX.select(i); S.hover = -1; cam.scale = 0; camera.centerOn(i, Math.sqrt(TH[2] * TH[3])); band = -1;
    if (small) { draw(now()); if (band !== 3) sk("small graph: U3 scale lands at U" + band); band = -1; }
    const C = focusRec(true), n = C.filter(c => c[0] === FK[1]).length, d = C.some(c => c[0] === FK[0] && c[1].length);
    const out = C.filter(c => c[0] !== FK[0] && !(c[1] > -1 && c[2] > -1 && c[1] < W + 1 && c[2] < H + 1)).length;
    const L = focusRec(false), hot = MX.scene.stats().hot;
    if (band !== 3 || !n || out || (d && n > 64) || (wg && (L.length || hot < n))) fail("" + [band, n, out, d, L.length, hot]);
  }));
  MX.selftest.add("render.cull", () => withView(() => {
    if (S.edgesShown < 50) sk("too few edges (" + S.edgesShown + ") to cull");
    camera.centerOn(topVisible(), 6); band = -1; draw(now());
    if (!(P.lastSegs < S.edgesShown)) fail("lines " + P.lastSegs + " >= edgesShown " + S.edgesShown);
  }));
  MX.selftest.add("render.labelsNoOverlap", () => withView(() => {
    const i = topVisible();
    if (i < 0) sk("no visible body");
    MX.select(i); S.hover = -1; camera.centerOn(i, 1); draw(now());
    const b = P.lastLabels;
    if (!b.some(x => x.id === i)) fail("selected body not labelled");
    for (let a = 0; a < b.length; a++) for (let c = a + 1; c < b.length; c++) {
      const u = b[a], v = b[c];
      if (u.x < v.x + v.w && v.x < u.x + u.w && u.y < v.y + v.h && v.y < u.y + u.h) fail("overlap " + u.id + " / " + v.id);
    }
  }));
  MX.selftest.add("render.pick", () => withView(() => {
    const i = topVisible();
    if (i < 0) sk("no visible body");
    camera.centerOn(i, 2);
    const [x, y, r] = camera.screen(i), got = pick(x + r - 1, y);
    if (got !== i) fail("pick returned " + got + " for " + i);
  }));

  // camera.dolly / controls / fly (3D or 2D, whichever is on): wheel / pointer events go through the real handlers
  function cvAt(type, x, y, o) {
    const rc = cv.getBoundingClientRect(), b = Object.assign({clientX: rc.left + x, clientY: rc.top + y, bubbles: true, cancelable: true}, o);
    return cv.dispatchEvent(type === "wheel" ? new WheelEvent(type, b) : new PointerEvent(type, Object.assign({pointerId: 9, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1}, b)));
  }
  function bigGalaxies() {  // visible galaxies with a projected centre in the safe rect, most bodies first
    const sr = safeRect(), n = new Uint32Array(U.galaxies.length), out = [];
    for (let i = 0; i < N; i++) if (S.nodeVisible[i]) n[U.galaxyOfBody[i]]++;
    U.galaxies.forEach((G, k) => {
      const c = n[k] ? U.centerOf("galaxy", k) : null, p = c && camera.project(c[0], c[1], c[2] || 0);
      if (p && p[0] > sr.l + 40 && p[0] < sr.r - 40 && p[1] > sr.t + 40 && p[1] < sr.b - 40) out.push({k, c, p, n: n[k]});
    });
    return out.sort((a, b) => b.n - a.n || a.k - b.k);
  }
  const depthOf = (x, y, z) => { const v = view(); return dot(v.f, x - v.E[0], y - v.E[1], z - v.E[2]); };
  MX.selftest.add("camera.dolly", () => withView(() => {
    MX.select(-1); S.hover = -1;
    camera.fit(0.88); draw(now());
    const G = bigGalaxies();
    if (!G.length) sk("no galaxy on screen");
    const p = G[0].p.map(Math.round), a = anchorDepth(p[0], p[1]), v = view(), t = a / v.F, dx = p[0] - W / 2 - v.O[0], dy = p[1] - H / 2 - v.O[1];
    const Pw = [0, 1, 2].map(c => v.E[c] + (v.f[c] * v.F + v.r[c] * dx + v.u[c] * dy) * t);   // the world point under the cursor
    let sun = -1;                                                                                // its biggest visible sun
    for (let i = 0; i < N; i++) if (S.nodeVisible[i] && ROLE[i] === 0 && U.galaxyOfBody[i] === G[0].k && (sun < 0 || RAD[i] > RAD[sun])) sun = i;
    if (sun < 0) sk("galaxy without a sun");
    let r0 = 0, d0 = 0, n = 0, worst = 0, ratio = 0;
    for (let j = 0; j < 20; j++) {
      cvAt("wheel", p[0], p[1], {deltaY: -100});
      const q = camera.project(Pw[0], Pw[1], Pw[2]);
      if (!q) fail("step " + j + ": the point under the cursor went behind the camera");
      worst = Math.max(worst, Math.hypot(q[0] - p[0], q[1] - p[1]));
      const sc = camera.screen(sun), d = depthOf(S.x[sun], S.y[sun], S.z[sun]);
      if (!(sc[2] > 0) || faded(sc[2]) || !(d > 0)) continue;
      if (!r0 && sc[2] >= 2 * MINR) { r0 = sc[2]; d0 = d; continue; }
      if (r0) { n++; ratio = Math.max(ratio, Math.abs((sc[2] / r0) / (d0 / d) - 1)); }
    }
    if (worst > 1) fail("point under the cursor drifted " + worst.toFixed(2) + " px");
    if (!n) fail("sun " + g.id[sun] + " never measurable");
    if (ratio > 0.05) fail("sun radius ratio off perspective by " + (100 * ratio).toFixed(1) + "%");
    camera.fit(0.88); draw(now());   // two galaxies: screen separation grows while dollying toward their midpoint
    const H2 = bigGalaxies();
    if (H2.length < 2) sk("need two galaxies on screen");
    const A = H2[0], B = H2[1], m = [Math.round((A.p[0] + B.p[0]) / 2), Math.round((A.p[1] + B.p[1]) / 2)], sep = () => {
      const x = camera.project(A.c[0], A.c[1], A.c[2] || 0), y = camera.project(B.c[0], B.c[1], B.c[2] || 0);
      return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1]) : -1;
    };
    let last = sep();
    for (let j = 0; j < 8; j++) {
      cvAt("wheel", m[0], m[1], {deltaY: -100});
      const d = sep();
      if (d < 0) break;
      if (!(d > last)) fail("galaxy separation did not grow: " + last.toFixed(1) + " -> " + d.toFixed(1) + " px at step " + j);
      last = d;
    }
  }));
  MX.selftest.add("camera.controls", () => withView(() => {
    MX.select(-1); S.hover = -1;
    camera.fit(0.88); draw(now());
    const sr = safeRect();
    let e = null;   // an empty spot (nothing to pick)
    for (let y = sr.t + 30; y < sr.b - 30 && !e; y += 23) for (let x = sr.l + 30; x < sr.r - 30 && !e; x += 29) if (pick(x, y) < 0) e = [x, y];
    if (!e) fail("no empty spot");
    const st = () => [cam.yaw, cam.pitch, cam.panX, cam.panY, cam.scale, cam.fz];
    const drag = (dx, dy, o) => { cvAt("pointerdown", e[0], e[1], o); cvAt("pointermove", e[0] + dx, e[1] + dy, o); cvAt("pointerup", e[0] + dx, e[1] + dy, Object.assign({}, o, {buttons: 0})); };
    let a = st();
    drag(40, 25);
    let b = st();
    if (b[0] !== a[0] || b[1] !== a[1]) fail("left-drag turned the view");
    if (Math.abs(b[2] - a[2] - 40) > 1e-6 || Math.abs(b[3] - a[3] - 25) > 1e-6 || b[4] !== a[4]) fail("left-drag did not pan 1:1: " + [b[2] - a[2], b[3] - a[3]]);
    a = b; drag(40, 25, {shiftKey: true}); b = st();
    if (S.view3d ? b[0] === a[0] || b[1] === a[1] : b[0] !== a[0] || b[1] !== a[1]) fail("shift-drag: yaw / pitch " + a.slice(0, 2) + " -> " + b.slice(0, 2) + " (3D " + S.view3d + ")");
    const c0 = {scale: cam.scale, panX: cam.panX, panY: cam.panY, yaw: cam.yaw, pitch: cam.pitch, fz: cam.fz};
    drag(0, -50, {ctrlKey: true});     // up = in
    const z = st();
    if (!(z[4] > c0.scale)) fail("ctrl-drag up did not dolly in");
    Object.assign(cam, c0);
    cvAt("wheel", e[0], e[1], {deltaY: -50 * CDRAG / WHEEL});
    const w = st();
    for (let j = 2; j < 6; j++) if (Math.abs(w[j] - z[j]) > 1e-6 * Math.max(1, Math.abs(w[j]))) fail("ctrl-drag != wheel: " + z.slice(2) + " vs " + w.slice(2));
  }));
  MX.selftest.add("camera.fly", () => withView(async () => {
    const anim0 = S.anim, rm0 = S.reducedMotion;
    MX.select(-1); S.hover = -1;
    try {
      S.anim = true; S.reducedMotion = false;
      camera.fit(0.88);
      const sunOf = k => { let b = -1; for (let i = 0; i < N; i++) if (S.nodeVisible[i] && ROLE[i] === 0 && U.galaxyOfBody[i] === k && (b < 0 || g.deg[i] > g.deg[b])) b = i; return b; };
      const G = bigGalaxies().map(x => sunOf(x.k)).filter(i => i >= 0);   // galaxies with a sun
      if (G.length < 2) sk("need two galaxies with suns on screen");
      const i0 = G[0], i1 = G[G.length - 1];
      camera.centerOn(i0, 1);      // zoomed in on one galaxy, then jump across the universe
      const F0 = view().F, c = mid(), D0 = F0 / cam.scale;
      if (!camera.flyBody(i1)) fail("flyBody refused");
      const live = U.motionReason() === "";
      if (live && !camera.flying) fail("motion on but the flight was instant");
      const fl = camera.flight, L = [], tf0 = performance.now();
      if (live && !(fl.dur >= FLY[0] && fl.dur <= FLY[1])) fail("duration " + fl.dur);
      for (let t = 0; camera.flying && t < 3000; t += 16) { const f = camera.flight; L.push([Math.log(F0 / cam.scale), view().T.slice(), f ? f.e : 1, f ? f.q : 1]); await wait(16); }
      if (camera.flying) fail("flight still running after 3 s");
      L.push([Math.log(F0 / cam.scale), view().T.slice(), 1, 1]);
      const sc = camera.screen(i1), off = Math.hypot(sc[0] - c[0], sc[1] - c[1]);
      if (off > 2) fail("landed " + off.toFixed(2) + " px off centre");
      if (!live) return;
      const el = performance.now() - tf0;   // the sampler (16 ms timers) must see the flight at frame rate
      if (L.length < 8 && el >= fl.dur && el / Math.max(1, L.length - 1) > 4 * 16) sk("clock stepped " + el.toFixed(0) + " ms over " + L.length + " samples: flight not observable at frame rate here");
      if (L.length < 8) fail("only " + L.length + " samples (dur " + fl.dur.toFixed(0) + " ms, path S " + fl.S.toFixed(3) + ")");
      let tv = 0, tu = 0, mv = 0, mu = 0, peak = -Infinity;
      for (let j = 1; j < L.length; j++) {
        const dl = Math.abs(L[j][0] - L[j - 1][0]), du = Math.hypot(...L[j][1].map((v, k) => v - L[j - 1][1][k]));
        tv += dl; tu += du; mv = Math.max(mv, dl); mu = Math.max(mu, du); peak = Math.max(peak, L[j][0]);
        if (L[j][2] < L[j - 1][2] - 1e-9 || L[j][3] < L[j - 1][3] - 1e-9) fail("easing not monotone at sample " + j);
      }
      if (mv > 0.25 * tv + 0.02 || mu > 0.25 * tu + 1e-6) fail("frame jump: log D " + mv.toFixed(3) + " of " + tv.toFixed(3) + ", pivot " + mu.toFixed(1) + " of " + tu.toFixed(1));
      const u1 = Math.hypot(...L[0][1].map((v, k) => v - L[L.length - 1][1][k])), D1 = Math.exp(L[L.length - 1][0]);
      if (u1 > 4 * Math.max(D0, D1) && !(peak > Math.log(Math.max(D0, D1)) + 0.05)) fail("long jump did not pull back (u " + u1.toFixed(0) + ", D " + D0.toFixed(0) + " -> " + D1.toFixed(0) + ")");
      camera.centerOn(i0, 1); camera.flyBody(i1);   // any input cancels
      cvAt("wheel", c[0], c[1], {deltaY: -100});
      if (camera.flying) fail("wheel did not cancel the flight");
      S.reducedMotion = true; camera.centerOn(i0, 1); camera.flyBody(i1);
      if (camera.flying) fail("reduced motion: flight animated");
    } finally { S.anim = anim0; S.reducedMotion = rm0; camera.cancel(); }
  }), {timeout: 8000});

  // F1: fit-all = every visible body inside the safe rect on the projection, also after the idle spin turns the view
  MX.selftest.add("camera.fitProjected", () => withView(() => {
    if (topVisible() < 0) sk("no visible body");
    MX.select(-1); S.hover = -1;
    camera.fit(0.88); draw(now());
    if (!okAll()) fail("fit-all: a body leaves the safe rect (projected)");
    if (camStatus().fitOK !== true) fail("mxstatus fitOK " + camStatus().fitOK);
    if (S.view3d) for (const t of [0.8, 1.7, 2.9]) { orbitBy(t, 0); draw(now()); if (!okAll()) fail("after a " + (t * 57.3).toFixed(0) + " deg spin a body leaves the safe rect"); }
  }));
  // F3: flying past every body damps the dolly and shows the quiet note; a reverse zoom removes it
  MX.selftest.add("camera.nothingAhead", () => withView(() => {
    if (!S.view3d) sk("2D view: the eye never passes the plane");
    const G = (camera.fit(0.88), draw(now()), bigGalaxies());
    if (!G.length) sk("no galaxy on screen");
    const p = G[0].p;
    let hit = -1;
    for (let j = 0; j < 160 && hit < 0; j++) { cvAt("wheel", p[0], p[1], {deltaY: -120}); if (voidOn) hit = j; }
    if (hit < 0) fail("160 notches in, still bodies ahead / no note");
    if (!voidEl || voidEl.hidden || !/nothing ahead/.test(voidEl.textContent)) fail("note not shown");
    const T0 = view().T.slice(), D0 = view().D;
    cvAt("wheel", p[0], p[1], {deltaY: -120});
    const step = Math.hypot(...view().T.map((v, c) => v - T0[c]));
    if (!(step < 0.3 * DFL * view().F / SMAX + 0.3 * D0)) fail("dolly not damped: " + step);
    cvAt("wheel", p[0], p[1], {deltaY: 120});
    if (voidOn || !voidEl.hidden) fail("reverse zoom kept the note");
    camera.fit(0.88);
  }));
  // labels (user: decluttered LOD): at x3.6 fit no overlap, budget kept, no junk; U2 = suns only; a selection labels
  // its neighbours bright and dims / hides the rest
  MX.selftest.add("labels.declutter", () => withView(() => {
    if (topVisible() < 0) sk("no visible body");
    MX.select(-1); S.hover = -1;
    camera.fit(0.88); draw(now());
    const G = bigGalaxies();
    if (!G.length) sk("no galaxy on screen");
    const L = MX.labels, check = what => {
      const b = P.lastLabels, st = L.stats;
      for (let a = 0; a < b.length; a++) for (let c = a + 1; c < b.length; c++) {
        const u = b[a], v = b[c];
        if (u.x < v.x + v.w && v.x < u.x + u.w && u.y < v.y + v.h && v.y < u.y + u.h) fail(what + ": overlap " + u.id + " / " + v.id);
      }
      if (st && st.free > st.budget) fail(what + ": " + st.free + " free body labels > budget " + st.budget);
      for (const x of b) if (typeof x.id === "number" && x.id !== S.selected && x.id !== S.hover && !L.clean(g.label[x.id])) fail(what + ": junk label '" + g.label[x.id] + "'");
      return b;
    };
    camera.zoomBy(3.6 * fitAll / cam.scale, G[0].p[0], G[0].p[1]); band = -1; draw(now());
    check("x3.6");
    const c = vplane(G[0].c[0], G[0].c[1], G[0].c[2] || 0);   // U2 on the busiest galaxy: suns only
    cam.scale = clampScale(Math.sqrt(TH[1] * TH[2])); { const sr0 = safeRect(); cam.panX = (sr0.l + sr0.r) / 2 - W / 2 - c[0] * cam.scale; cam.panY = (sr0.t + sr0.b) / 2 - H / 2 - c[1] * cam.scale; cam.fz = c[2]; }
    band = -1; draw(now());
    if (band === 2) { const b = check("U2"); const bad = b.filter(x => typeof x.id === "number" && ROLE[x.id] !== 0); if (bad.length) fail("U2 labels a non-sun: " + g.label[bad[0].id]); }
    const sr = safeRect(), inSr = (q, m) => S.nodeVisible[q] && SK[q] > 0 && SX[q] > sr.l + m && SX[q] < sr.r - m && SY[q] > sr.t + m && SY[q] < sr.b - m;
    let i = -1;   // the busiest visible sun in the safe rect (labels live there, never under glass)
    for (let j = 0; j < N && i < 0; j++) { const q = ORDER[j]; if (inSr(q, 0) && g.deg[q] >= 2) i = q; }
    if (i < 0) return;
    MX.select(i); draw(now());
    const b = check("selected"), nb = new Set();
    for (let k = g.adjOff[i]; k < g.adjOff[i + 1]; k++) { const e = g.adjEdge[k]; nb.add(SRC[e] === i ? DST[e] : SRC[e]); }
    if (!b.some(x => x.id === i)) fail("selected body not labelled");
    const nbOn = b.filter(x => nb.has(x.id)).length, other = b.filter(x => typeof x.id === "number" && x.id !== i && !nb.has(x.id) && x.a >= 1);
    let nbVis = 0;
    for (const q of nb) if (inSr(q, 40)) nbVis++;
    if (nbVis && !nbOn) fail("no neighbour labelled (" + nbVis + " on screen)");
    if (other.length) fail(other.length + " non-neighbour labels not dimmed, e.g. " + g.label[other[0].id]);
  }));

  // ---- init
  MX.statusExt.render = status;
  MX.statusExt.camera = camStatus;
  MX.module("render", () => {
    MX.requestDraw = requestDraw;
    MX._drawPending = false;
    stage.classList.remove("depth");  // GL/2D push-back is alpha-only: no CSS blur layer
    cam.yaw = YAW0; cam.pitch = PITCH0;   // default view is 3D (a #cam= hash overrides on first settle)
    let vs = VIEWH;                       // #view=2d|3d, else localStorage mx.view, else 3D
    if (!vs) try { vs = localStorage.getItem("mx.view"); } catch (e) { /* storage blocked */ }
    if (vs === "2d") { S.view3d = false; S.zScale = 0; cam.yaw = cam.pitch = 0; }
    cv.style.touchAction = "none";        // one finger pans, two pinch-zoom / pan (no browser gestures)
    themeSync();
    new ResizeObserver(resize).observe(cv);
    resize();
    if (BENCH) startBench();

    let down = null, pickRaf = 0, hoverAt = null;
    const ptrs = new Map();   // active pointers (pinch)
    ptrDown = () => !!down;
    const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    function hoverPick() {
      pickRaf = 0;
      if (!hoverAt || down) return;
      const h = pick(hoverAt[0], hoverAt[1]);
      if (h !== S.hover) { S.hover = h; selVer++; cv.style.cursor = h >= 0 ? "pointer" : "grab"; requestDraw(); }
    }
    // pointer (3D): click a body = select; click empty space = MX.ui.clickAt (U0 cluster / U1 galaxy fly, else
    // clear); double-click = MX.ui.dblAt (a body: select + fly to it; empty: drill one level in); left-drag empty = pan
    // (screen-aligned, 1:1 at the focal depth); right / middle-drag = pan; shift-drag = orbit (2D: nothing); ctrl-drag
    // up / down = dolly in / out toward the drag-start point (= wheel); drag a body = universe springs (on the plane through
    // the body); wheel = dolly toward the cursor; two pointers = pinch dolly + pan. Any pointer input cancels a camera
    // flight and stops the idle spin.
    const world = (mx, my) => { const w = unproject(mx, my, 1); return [w[0], w[1]]; };
    cv.addEventListener("contextmenu", e => e.preventDefault());
    cv.addEventListener("pointerdown", e => {
      if (e.button > 2) return;
      const [mx, my] = local(e);
      flyCancel(); touch();
      ptrs.set(e.pointerId, [mx, my]);
      if (ptrs.size === 2) {   // second finger: pinch
        const [a, b] = [...ptrs.values()];
        down = {pinch: true, d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], moved: 99, node: -1};
      } else if (ptrs.size === 1) {
        const orbit = e.button === 0 && e.shiftKey, zoom = e.button === 0 && !orbit && (e.ctrlKey || e.metaKey);
        down = {x: e.clientX, y: e.clientY, m: [mx, my], moved: 0, node: orbit || zoom || e.button > 0 ? -1 : pick(mx, my), drag: false, orbit, zoom, a: 0, btn: e.button};
      }
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or already-released pointer */ }
    });
    cv.addEventListener("pointermove", e => {
      if (!down) { hoverAt = local(e); if (!pickRaf) pickRaf = requestAnimationFrame(hoverPick); return; }
      if (down.pinch) {
        if (!ptrs.has(e.pointerId)) return;
        ptrs.set(e.pointerId, local(e));
        const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        camera.panBy(m[0] - down.m[0], m[1] - down.m[1]); camera.zoomBy(d / down.d, m[0], m[1]);
        down.d = d; down.m = m;
        return;
      }
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      down.moved += Math.abs(dx) + Math.abs(dy);
      down.x = e.clientX; down.y = e.clientY;
      if (down.moved <= 4) return;
      touch();
      if (down.node >= 0) {  // drag a body: universe springs, pointer on the plane through the body
        const [mx, my] = local(e), i = down.node, w = unproject(mx, my, SK[i] > 0 ? SK[i] : 1);
        if (!down.drag) { down.drag = true; cv.style.cursor = "grabbing"; }
        MX.layout.drag(i, w[0], w[1]);
      } else if (down.zoom) {    // ctrl-drag: dolly about the drag-start point (anchor depth fixed at the first move)
        if (!down.a) down.a = anchorDepth(down.m[0], down.m[1]);
        cam.userAdjusted = true; dolly(Math.exp(-dy * CDRAG), down.m[0], down.m[1], down.a);
        if (down.a > 0) down.a = Math.max(1e-9, down.a * Math.exp(dy * CDRAG));   // the anchor got nearer / farther
      } else if (down.orbit) { if (S.view3d) { cam.userAdjusted = true; orbitBy(-dx * ROT, dy * ROT); } }   // 2D: nothing
      else { cam.userAdjusted = true; cam.panX += dx; cam.panY += dy; }
      requestDraw();
    });
    const up = e => {
      ptrs.delete(e.pointerId);
      if (!down) return;
      const d = down; down = null;
      if (d.pinch) return;
      if (d.drag) { MX.layout.release(); cv.style.cursor = S.hover >= 0 ? "pointer" : "grab"; return; }
      if (e.type !== "pointerup" || d.moved > 4 || d.btn > 0) return;
      const [mx, my] = local(e), i = pick(mx, my);
      if (i >= 0 || !(MX.ui && MX.ui.clickAt)) MX.select(i);
      else MX.ui.clickAt(...world(mx, my), mx, my);
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("dblclick", e => {
      if (!(MX.ui && MX.ui.dblAt)) return;
      e.preventDefault();
      const [mx, my] = local(e);
      MX.ui.dblAt(...world(mx, my), pick(mx, my), mx, my);
    });
    cv.addEventListener("pointerleave", () => { hoverAt = null; if (!down && S.hover >= 0) { S.hover = -1; selVer++; requestDraw(); } });
    cv.addEventListener("wheel", e => {
      e.preventDefault();
      const [mx, my] = local(e), d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * H : e.deltaY;   // lines / pages -> px
      camera.zoomBy(Math.exp(-d * WHEEL), mx, my);
    }, {passive: false});

    MX.on("positions", () => { posDirty = true; posVer++; requestDraw(); });
    MX.on("settled", () => {
      computeFit(); posDirty = true; lastLab = 0; posVer++;
      if (!camDone) {
        camDone = true; if (CAM3) applyCam3(); else applyCam(+CAMK);
        const G = WHEELN ? bigGalaxies() : [];   // #wheel=n (diagnostic): n notches in at the biggest on-screen galaxy
        for (let j = 0; G.length && j < WHEELN; j++) cvAt("wheel", G[0].p[0], G[0].p[1], {deltaY: -100});
      }
      else if (!cam.userAdjusted) camera.fit(0.88);  // default #: U0 fit-all
      requestDraw(); if (booted) drawNow(); requestDraw();
    });
    MX.on("repack", () => { visVer++; posVer++; });
    MX.on("ready", () => {
      // no layout read here: W/H and the safe rect are cached since module init (ResizeObserver / chrome reset them)
      booted = true; glDeferred = true; glFail = "gl pending";
      readyAt = performance.now(); setTimeout(() => { spinNow = spinning(performance.now()); requestDraw(); MX.status(); }, SPIN_DELAY0 + 50);   // spin cool-down ends
      if (!W) resize();
      computeFit(); drawNow();  // frame 1 = lite (liteNow)
      // full frame: GL swap (initGL ready), else Canvas2D in this task (create failed) or when the link fails
      setTimeout(() => { initGL(); (function w() { if (!gl) glWait ? setTimeout(w, 50) : drawNow(); })(); }, 0);
    });
    MX.on("theme", () => { themeSync(); requestDraw(); });
    MX.on("query", () => { selVer++; requestDraw(); });
    MX.on("visibility", () => { visVer++; requestDraw(); });
    for (const ev of ["select", "focus", "path"]) MX.on(ev, () => { selVer++; requestDraw(); });
    MX.on("anim", () => requestDraw());
    MX.on("chrome", () => { safe = null; computeFit(); requestDraw(); });
    MX.on("view", () => { safe = null; if (S.view === "graph") { resize(); requestDraw(); } else stop(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) requestDraw(); MX.status(); });
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => requestDraw());
  });
})();
