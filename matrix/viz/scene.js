(function () {
  "use strict";
  // MX.scene: pure data module, never draws. update() fills the MX.gl
  // instance buffers. Points (PSTRIDE) = every visible body: x, y, radius(world), glow, r, g, b, flags
  // (1 lift, 2 dim, 4 sun, 8 ring), z. Lines (LSTRIDE) = x0, y0, x1, y1, r, g, b, a, z0, z1, LOD by band:
  //   U0 cluster-pair filaments (<= 6) | U1 galaxy-pair filaments | U2 bucket-pair filaments (bucket = a system or
  //   one galaxy's dust), only when an endpoint bucket is on screen | U3+ individual edges, viewport-culled.
  //   Hot (selection/hover) and path edges are always individual, a > .5 (gl.js: never LOD-dropped).
  // Pair tables rebuild on visibility/repack/settled only (O(M log M), perf.aggMs). Filament ends = centroids of
  // drawn bodies (a system: its sun), so they follow orbits/tweens. Buffers allocated once; update() allocates
  // nothing. Colours: MX.state.theme.rgba, never literals. Dirty flags assume S.x/S.y change only with a
  // "positions" event (MX.universe is the sole writer).
  // Visual polish (design v3): aggregates are few and faint. U0 = top cross-cluster galaxy pairs, U1 = top galaxy
  // pairs, U2 = a few galaxy pairs near the view; all as quadratic arcs (polyline segments, gl.js draws straight
  // quads) trimmed at the galaxy rims, bowed away from the universe centre, a faint group tint (T.arcTint) at the ends -> filament ink
  // mid. U2 adds short sun-to-sun threads only between on-screen systems, faded by screen length, capped.
  const MX = window.MX;
  if (!MX || !MX.g || !MX.gl || !MX.universe) return;
  const g = MX.g, S = MX.state, U = MX.universe, N = g.N, M = g.M, PS = MX.gl.PSTRIDE, LS = MX.gl.LSTRIDE;
  const SRC = g.src, DST = g.dst, ROLE = U.role, RAD = U.radius, GRP = g.group;

  // ---- tuning (tokens_apply retunes here; colours are theme keys) ----
  // arc[band]: galaxy-pair arc peak alpha U0..U2 (x (0.35 + 0.65 sqrt(count / max)); ends a, middle a x arcMid);
  // cap: arcs U0, U1, U2 + U2 threads; fil[l]: pair alpha [min, max] over log2 count (U2 threads use fil[2], x
  // (1 - (screen length / (near x min(W, H)))^2)); bend: arc bow x length; trim: end trim <= trim x length; seg:
  // segments per arc; idle: U3, U4 edge alpha; prov: alpha factor by provenance (never hue); glow: sun, planet,
  // dust; lineW: px by band; keep: gl lineKeep at U3+ = clamp(scale / keep[0], keep[1], 1), aggregates 1; pad: cull
  // margin px; ink: body ink keys (--g<n>, fallback); col: arc middle U0-U2, U2 thread / idle, hot, path.
  // hot / path: a code, not an alpha (gl.js VS_LN owns width + alpha): a = hot + pq x (prov + 3 x tier), tier 0 =
  // crisp hot (the hotN strongest: weight, then neighbour degree), 1 = faint hot, path = path + pq x prov (tier 2);
  // tint: hot ink mixed toward the neighbour's group ink; arcTint: arc ends mixed this far from the neutral filament
  // ink toward the group ink (hairline: threads are neutral grey, a faint tint at most). dens: U3+ idle edge alpha x
  // min(1, sqrt(dens / edges drawn)) (a deep zoom into a hub never piles up into a bright / dark fan); idle edges with
  // an end behind the camera are dropped (gl.js also fades ends near it).
  const T = {
    arc: [0.16, 0.13, 0.11], arcMid: 0.55, arcTint: 0.3, cap: [6, 16, 6, 90], fil: [[0.03, 0.1], [0.03, 0.1], [0.04, 0.12]],
    near: 0.5, bend: 0.16, trim: 0.3, seg: 20, idle: [0.06, 0.08], hot: 0.6, path: 0.84, pq: 0.04, hotN: 24, tint: 0.2,
    prov: [1, 0.7, 0.55], dens: 200, glow: [1.2, 0.5, 0.35], lineW: [1, 1, 1, 1, 1], keep: [0.6, 0.25], pad: 24,
    ink: ["g", "g"], col: ["filament", "filament", "filament", "thread", "threadHot", "pathStroke"],
  };

  // ---- buckets per level: 0 cluster, 1 galaxy, 2 system | nSys + galaxy (its dust) ----
  const nC = Math.max(U.clusters.length, 1 + GRP.reduce((a, b) => Math.max(a, b), 0));
  const nG = U.galaxies.length, nSys = U.systems.length, NB = [nC, nG, nSys + nG];
  const BK = NB.map(() => new Int32Array(N));
  for (let i = 0; i < N; i++) { BK[0][i] = GRP[i]; BK[1][i] = U.galaxyOfBody[i]; BK[2][i] = U.sys[i] >= 0 ? U.sys[i] : nSys + U.galaxyOfBody[i]; }
  const LV = NB.map(K => { const c = Math.min(M, K * K); return {a: new Int32Array(c), b: new Int32Array(c), al: new Float32Array(c), c: new Float32Array(c), ord: new Int32Array(c), n: 0, max: 1, x: 1}; });
  const XC = U.galaxies.map(G => G.cluster);  // galaxy -> cluster (U0 arcs are cross-cluster only)
  const CX = NB.map(K => new Float64Array(K)), CY = NB.map(K => new Float64Array(K)), CN = NB.map(K => new Float64Array(K));
  const BR = new Float32Array(NB[2]), ON = new Uint8Array(NB[2]), KEY = new Float64Array(M);

  const CZ = NB.map(K => new Float64Array(K)), PJ = [0, 0, 0], SP2B = new Float32Array(2 * nSys);   // 3D: centroid z, projector out, system screen xy

  // ---- buffers (once) ----
  const NLS = 2 * M + 2048, AREF = 1 << 24;  // aggregates <= 16 x seg + 90 segments; arc ref = AREF + galaxy pair
  const P = new Float32Array(N * PS), IDX = new Int32Array(N), PF = new Uint8Array(N), L = new Float32Array(NLS * LS);
  const REF = new Int32Array(NLS), OC = new Uint8Array(N), HL = new Int32Array(M), PL = new Int32Array(M);
  const INK = new Float32Array(nC * 3), LC = new Float32Array(T.col.length * 3);
  const DL = new Uint8Array(N), DD = new Uint8Array(N), DR = new Uint8Array(N), DH = new Uint8Array(M), NBR = new Uint8Array(N);
  const out = {pts: P, nPts: 0, lns: L, nLns: 0, ptsDirty: true, lnsDirty: true, index: IDX, ref: REF, keep: 1, lineW: 1, band: -1};
  const st = {nPts: 0, nLns: 0, band: -1, aggMs: 0, updMs: 0, aggs: 0, pairs: [0, 0, 0], onScreen: 0, hot: 0};
  let aggDirty = true, colDirty = true, nL = 0, lD = false, ver = 0, seen = -1;
  // small graphs (< SMALL visible bodies): every band draws the individual edges (they end on the bodies, which
  // render.js floors to a visible px size); aggregates are for crowds
  const SMALL = 500;
  let small = false;

  function colors() {
    const q = (S.theme && S.theme.rgba) || {}, set = (A, o, v) => { for (let j = 0; j < 3; j++) A[o + j] = v ? v[j] : 0; };
    for (let c = 0; c < nC; c++) set(INK, c * 3, q[T.ink[0] + c] || q[T.ink[1] + c]);
    T.col.forEach((k, j) => set(LC, j * 3, q[k]));
    colDirty = false; ver++;
  }

  function aggregate() {                                  // visible edges -> distinct bucket pairs, alpha by count
    const t0 = performance.now(), ev = S.edgeVisible, nv = S.nodeVisible;
    let nvis = 0;
    for (let i = 0; i < N; i++) nvis += nv[i] ? 1 : 0;
    small = nvis < SMALL;
    for (let l = 0; l < 3; l++) {
      const B = BK[l], K = NB[l], A = LV[l], f = T.fil[l];
      let m = 0, n = 0, max = 1;
      for (let e = 0; e < M; e++) {
        if (!ev[e] || !nv[SRC[e]] || !nv[DST[e]]) continue;
        const x = B[SRC[e]], y = B[DST[e]];
        if (x !== y) KEY[m++] = x < y ? x * K + y : y * K + x;
      }
      const ks = KEY.subarray(0, m).sort();
      for (let j = 0; j < m; n++) {
        const k = ks[j];
        let c = 0;
        while (j < m && ks[j] === k) { j++; c++; }
        A.a[n] = Math.floor(k / K); A.b[n] = k - A.a[n] * K; A.al[n] = c; if (c > max) max = c;
      }
      let xm = 1;  // busiest cross-cluster galaxy pair (U0 arcs)
      for (let j = 0; j < n; j++) {
        A.c[j] = A.al[j]; A.ord[j] = j;
        if (l === 1 && XC[A.a[j]] !== XC[A.b[j]] && A.c[j] > xm) xm = A.c[j];
        A.al[j] = f[0] + (f[1] - f[0]) * Math.log2(1 + A.al[j]) / Math.log2(1 + max);
      }
      A.ord.subarray(0, n).sort((x, y) => A.c[y] - A.c[x] || x - y);  // busiest pairs first
      A.n = st.pairs[l] = n; A.max = max; A.x = xm;
    }
    for (let b = 0; b < NB[2]; b++) BR[b] = b < nSys ? U.radiusOf("system", b) : U.radiusOf("galaxy", b - nSys);
    st.aggMs = Math.round((performance.now() - t0) * 100) / 100; st.aggs++;
    if (S.perf) S.perf.aggMs = st.aggMs;
    aggDirty = false; ver++;
  }

  function centres(l) {                                   // centroid of the drawn bodies; a system = its sun
    const B = BK[l], X = S.x, Y = S.y, Z = S.z, nv = S.nodeVisible, cx = CX[l], cy = CY[l], cz = CZ[l], cn = CN[l];
    cx.fill(0); cy.fill(0); cz.fill(0); cn.fill(0);
    for (let i = 0; i < N; i++) if (nv[i]) { const b = B[i]; cx[b] += X[i]; cy[b] += Y[i]; cz[b] += Z[i]; cn[b]++; }
    for (let b = 0; b < NB[l]; b++) if (cn[b]) { cx[b] /= cn[b]; cy[b] /= cn[b]; cz[b] /= cn[b]; }
    if (l === 2) for (let s = 0; s < nSys; s++) if (cn[s]) { const u = U.sun[s]; cx[s] = X[u]; cy[s] = Y[u]; cz[s] = Z[u]; }
  }

  // derived masks (render.js ego/search rules): lift = anchor + 1-hop + hover + path + pinned; ring = selection,
  // focus root, path, pinned, hits; dim = misses / outside the ego; hot = selected|hovered body's edges 1, path 2
  const pin = i => { if (i >= 0 && i < N) DL[i] = DR[i] = 1; };
  function derive() {
    DL.fill(0); DD.fill(0); DR.fill(0); DH.fill(0); NBR.fill(0);
    const sel = S.selected, hv = S.hover, a = sel >= 0 ? sel : hv, fo = S.focus, FS = fo ? fo.set : null;
    const anc = sel >= 0 ? sel : fo ? fo.root : -1, p = S.path && S.path.found ? S.path : null;
    if (a >= 0) for (let k = g.adjOff[a]; k < g.adjOff[a + 1]; k++) { const e = g.adjEdge[k]; NBR[SRC[e] === a ? DST[e] : SRC[e]] |= 1; DH[e] = 1; }
    if (anc >= 0) {
      pin(anc);
      for (let k = g.adjOff[anc]; k < g.adjOff[anc + 1]; k++) { const e = g.adjEdge[k]; DL[SRC[e] === anc ? DST[e] : SRC[e]] = 1; }
    }
    if (hv >= 0) DL[hv] = 1;
    S.pinned.forEach(pin);
    if (p) {
      for (let j = 0; j < p.nodes.length; j++) { pin(p.nodes[j]); NBR[p.nodes[j]] |= 2; }
      for (let j = 0; j < p.edges.length; j++) DH[p.edges[j]] = 2;
    }
    const q = !!S.q && S.results.length > 0, mm = S.matchMask;
    for (let i = 0; i < N; i++) {
      if (q && mm[i]) DR[i] = 1;
      if (!DL[i]) DD[i] = (q && !mm[i]) || (!(FS && FS[i]) && ((a >= 0 && i !== a && !(NBR[i] & 3)) || (p && !(NBR[i] & 2)))) ? 1 : 0;
    }
  }

  // ref: thread pair j | arc AREF + galaxy pair j | edge e | hot -1-e | path -1-M-e. Dirty on any value change.
  const TMP = new Float32Array(10);
  function put(x0, y0, x1, y1, r, gg, b, a, ref, z0, z1) {
    const o = nL * LS;
    if (REF[nL] !== ref) { REF[nL] = ref; lD = true; }
    nL++;
    TMP[0] = x0; TMP[1] = y0; TMP[2] = x1; TMP[3] = y1; TMP[4] = r; TMP[5] = gg; TMP[6] = b; TMP[7] = a; TMP[8] = z0 || 0; TMP[9] = z1 || 0;
    for (let j = 0; j < 10; j++) if (L[o + j] !== TMP[j]) { L[o + j] = TMP[j]; lD = true; }
  }
  const seg = (x0, y0, x1, y1, c, a, ref, z0, z1) => put(x0, y0, x1, y1, LC[c], LC[c + 1], LC[c + 2], a, ref, z0, z1);
  const D = g.deg, nb = e => D[SRC[e]] < D[DST[e]] ? SRC[e] : DST[e], rank = e => g.w[e] * 1e6 + D[nb(e)];  // hot edge: neighbour, strength

  // quadratic arc a -> b as n segments: ends trimmed by ra / rb (<= T.trim x length), bowed T.bend x length away
  // from (ux, uy); colour = body ink of the end's cluster -> LC[c] at the middle, alpha a at the ends -> a x arcMid;
  // z runs linearly za -> zb (the bow stays in the disc plane)
  function arc(ax, ay, bx, by, ra, rb, ca, cb, c, a, n, ref, ux, uy, za, zb) {
    let dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) return;
    dx /= len; dy /= len;
    const ta = Math.min(ra, T.trim * len), tb = Math.min(rb, T.trim * len);
    ax += dx * ta; ay += dy * ta; bx -= dx * tb; by -= dy * tb;
    const l2 = len - ta - tb, mx = (ax + bx) / 2, my = (ay + by) / 2, sg = (mx - ux) * -dy + (my - uy) * dx < 0 ? -1 : 1;
    const qx = mx - dy * sg * T.bend * l2, qy = my + dx * sg * T.bend * l2;
    let px = ax, py = ay, pz = za || 0;
    const z0 = za || 0, dz = (zb || 0) - z0, fa = ta / len, fb = 1 - tb / len;
    for (let i = 1; i <= n; i++) {
      const t = i / n, s = 1 - t, x = s * s * ax + 2 * s * t * qx + t * t * bx, y = s * s * ay + 2 * s * t * qy + t * t * by;
      const tm = (i - 0.5) / n, w = 1 - Math.abs(2 * tm - 1), e = (tm < 0.5 ? ca : cb) * 3, z = z0 + dz * (fa + (fb - fa) * t), v = 1 - (1 - w) * T.arcTint;
      put(px, py, x, y, INK[e] + (LC[c] - INK[e]) * v, INK[e + 1] + (LC[c + 1] - INK[e + 1]) * v, INK[e + 2] + (LC[c + 2] - INK[e + 2]) * v,
        a * (1 - (1 - T.arcMid) * w), ref, i === 1 ? z0 + dz * fa : pz, z);
      px = x; py = y; pz = z;
    }
  }

  // o: {band 0..4, cam: {x, y, scale, W, H} (x, y = render.js panX, panY; 3D: + sx, sy, sk = per-body screen x, y and
  //     perspective factor (sk <= 0 = behind the camera), pj(x, y, z, out3) -> false | out = [sx, sy, k]), lift, dim, ring: Uint8Array(N),
  //     hot: Uint8Array(M) (1 hot, 2 path)}; a mask null/undefined = derived from state, false = none.
  // -> {pts, nPts, lns, nLns, ptsDirty, lnsDirty, index (slot -> body), ref (line -> see seg), keep (gl lineKeep),
  //     lineW (px)}; *Dirty = content changed since the previous call (upload only then).
  function update(o) {
    const t0 = performance.now(), band = Math.max(0, Math.min(4, o.band | 0)), cam = o.cam;
    const k = cam.scale, ox = cam.x + cam.W / 2, oy = cam.y + cam.H / 2, pad = T.pad, W = cam.W + pad, H = cam.H + pad;
    if (colDirty) colors();
    if (aggDirty) aggregate();
    if (o.lift == null || o.dim == null || o.ring == null || o.hot == null) derive();
    const lift = o.lift == null ? DL : o.lift || null, dim = o.dim == null ? DD : o.dim || null;
    const ring = o.ring == null ? DR : o.ring || null, hot = o.hot == null ? DH : o.hot || null;
    const X = S.x, Y = S.y, Z = S.z, nv = S.nodeVisible, ev = S.edgeVisible, moved = ver !== seen, SXs = cam.sx, SYs = cam.sy, SKs = cam.sk, pj = cam.pj;
    seen = ver;

    // points: every visible body (the CMB splat needs them all); lifted ones last (on top in source-over)
    let n = 0, pD = moved;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < N; i++) {
        const l = lift && lift[i] ? 1 : 0;
        if (pass === 0) {                                  // outcodes; 3D: 16 = behind the camera (the GPU clips the rest)
          if (SXs && SKs[i] <= 0) OC[i] = 16; else {
            const px = SXs ? SXs[i] : X[i] * k + ox, py = SXs ? SYs[i] : Y[i] * k + oy;
            OC[i] = (px < -pad ? 1 : px > W ? 2 : 0) | (py < -pad ? 4 : py > H ? 8 : 0);
          }
        }
        if (!nv[i] || l !== pass) continue;
        const f = l | (!l && dim && dim[i] ? 2 : 0) | (ROLE[i] === 0 ? 4 : 0) | (ring && ring[i] ? 8 : 0), p = n * PS, c = GRP[i] * 3;
        if (IDX[n] !== i || PF[n] !== f) { IDX[n] = i; PF[n] = f; pD = true; }
        n++;
        P[p] = X[i]; P[p + 1] = Y[i]; P[p + 2] = RAD[i]; P[p + 3] = T.glow[ROLE[i]];
        P[p + 4] = INK[c]; P[p + 5] = INK[c + 1]; P[p + 6] = INK[c + 2]; P[p + 7] = f; P[p + 8] = Z[i];
      }
    }

    // lines: aggregates (U0-U2) | idle edges (U3+), then hot, then path on top
    const n0 = nL;
    let on = 0, nh = 0, np = 0;
    nL = 0; lD = moved || band !== out.band;
    if (band < 3 && !small) {
      const A = LV[1], gx = CX[1], gy = CY[1], gz = CZ[1], cap = T.cap[band];
      const vis = (x, y, r) => x + r >= -pad && x - r <= W && y + r >= -pad && y - r <= H;
      // on screen: 3D = projected centre, radius x perspective; 2D (no projector) = the old pan/scale formula
      const on3 = (x, y, z, r) => (pj ? pj(x, y, z, PJ) !== false && vis(PJ[0], PJ[1], r * k * PJ[2]) : vis(x * k + ox, y * k + oy, r * k));
      centres(0); centres(1);
      let ux = 0, uy = 0, un = 0;  // universe centre: arcs bow away from it
      for (let c = 0; c < nC; c++) { ux += CX[0][c] * CN[0][c]; uy += CY[0][c] * CN[0][c]; un += CN[0][c]; }
      ux /= un || 1; uy /= un || 1;
      for (let m = 0, got = 0; m < A.n && got < cap; m++) {  // busiest galaxy pairs first
        const j = A.ord[m], a = A.a[j], b = A.b[j], ra = U.radiusOf("galaxy", a), rb = U.radiusOf("galaxy", b);
        if (!CN[1][a] || !CN[1][b] || (band === 0 && XC[a] === XC[b])) continue;
        if (band === 2 && !on3(gx[a], gy[a], gz[a], ra) && !on3(gx[b], gy[b], gz[b], rb)) continue;
        got++;
        const mx = band === 0 ? A.x : A.max;
        arc(gx[a], gy[a], gx[b], gy[b], ra, rb, XC[a], XC[b], band * 3, T.arc[band] * (0.35 + 0.65 * Math.sqrt(Math.min(1, A.c[j] / mx))), T.seg, AREF + j, ux, uy, gz[a], gz[b]);
      }
      if (band === 2) {  // short sun-to-sun threads, both systems on screen, faded by screen length
        const B = LV[2], cx = CX[2], cy = CY[2], cz = CZ[2], lmax = T.near * Math.min(cam.W, cam.H);
        const SP2 = pj ? SP2B : null;   // projected system centres (3D thread length)
        centres(2);
        for (let b = 0; b < nSys; b++) {
          on += ON[b] = CN[2][b] > 0 && on3(cx[b], cy[b], cz[b], BR[b]) ? 1 : 0;
          if (SP2 && ON[b]) { SP2[2 * b] = PJ[0]; SP2[2 * b + 1] = PJ[1]; }
        }
        for (let m = 0, got = 0; m < B.n && got < T.cap[3]; m++) {
          const j = B.ord[m], a = B.a[j], b = B.b[j];
          if (a >= nSys || b >= nSys || !ON[a] || !ON[b]) continue;
          const f = 1 - ((SP2 ? Math.hypot(SP2[2 * b] - SP2[2 * a], SP2[2 * b + 1] - SP2[2 * a + 1]) : Math.hypot(cx[b] - cx[a], cy[b] - cy[a]) * k) / lmax) ** 2;
          if (f <= 0) continue;
          got++;
          seg(cx[a], cy[a], cx[b], cy[b], 6, B.al[j] * f, j, cz[a], cz[b]);
        }
      }
    }
    let ni = 0;   // idle edges that survive the cull (density cap)
    const indiv = band >= 3 || small;
    if (indiv) for (let e = 0; e < M; e++) if (ev[e] && !(hot && hot[e]) && !(OC[SRC[e]] & OC[DST[e]]) && !((OC[SRC[e]] | OC[DST[e]]) & 16) && nv[SRC[e]] && nv[DST[e]]) ni++;
    const idle = T.idle[band > 3 ? 1 : 0] * Math.min(1, Math.sqrt(T.dens / Math.max(ni, 1)));
    for (let e = 0; e < M; e++) {
      const h = hot ? hot[e] : 0;
      if ((!h && !indiv) || !ev[e]) continue;
      const s = SRC[e], t = DST[e];
      if (OC[s] & OC[t] || !nv[s] || !nv[t] || (!h && (OC[s] | OC[t]) & 16)) continue;
      if (h === 2) PL[np++] = e;
      else if (h) HL[nh++] = e;
      else seg(X[s], Y[s], X[t], Y[t], 9, idle * T.prov[g.prov[e]], e, Z[s], Z[t]);
    }
    // hot / path codes: see T (gl.js VS_LN key = round((a - .6) / .04): prov = key mod 3, tier = key / 3; the
    // remainder carries strength s 0..1 = pq x (.9 s - .45): crisp / path 1, faint sqrt(hotN / hot count))
    let cut = -1;
    const sf = 0.9 * Math.sqrt(T.hotN / Math.max(nh, T.hotN)) - 0.45;
    if (nh > T.hotN) { for (let j = 0; j < nh; j++) KEY[j] = rank(HL[j]); cut = KEY.subarray(0, nh).sort()[nh - T.hotN]; }
    for (let j = 0; j < nh; j++) {
      const e = HL[j], c = GRP[nb(e)] * 3, w = T.tint, a = T.hot + T.pq * (g.prov[e] + (rank(e) < cut ? 3 + sf : 0.45));
      put(X[SRC[e]], Y[SRC[e]], X[DST[e]], Y[DST[e]], LC[12] + (INK[c] - LC[12]) * w, LC[13] + (INK[c + 1] - LC[13]) * w, LC[14] + (INK[c + 2] - LC[14]) * w, a, -1 - e, Z[SRC[e]], Z[DST[e]]);
    }
    for (let j = 0; j < np; j++) { const e = PL[j]; seg(X[SRC[e]], Y[SRC[e]], X[DST[e]], Y[DST[e]], 15, T.path + T.pq * (g.prov[e] + 0.45), -1 - M - e, Z[SRC[e]], Z[DST[e]]); }

    out.ptsDirty = pD || n !== out.nPts; out.lnsDirty = lD || nL !== n0;
    out.nPts = st.nPts = n; out.nLns = st.nLns = nL; out.band = st.band = band;
    out.keep = indiv ? Math.max(T.keep[1], Math.min(1, k / T.keep[0])) : 1;
    out.lineW = T.lineW[band];
    st.onScreen = on; st.hot = nh + np; st.updMs = performance.now() - t0;
    return out;
  }

  const dirty = () => { aggDirty = true; };
  MX.scene = {update, T, stats: () => Object.assign({}, st, {pairs: st.pairs.slice(), updMs: Math.round(st.updMs * 100) / 100})};
  MX.module("scene", () => {
    MX.on("visibility", dirty); MX.on("repack", dirty); MX.on("settled", dirty);
    MX.on("positions", () => { ver++; }); MX.on("theme", () => { colDirty = true; });
  });

  // ---- self-tests ----
  if (!MX.selftest) return;
  const fail = m => { throw new Error(m); };
  const NONE = {lift: false, dim: false, ring: false, hot: false};
  async function ready() {
    const t1 = performance.now() + 3000;
    while (!(U.started && S.settled) && performance.now() < t1) await new Promise(r => setTimeout(r, 20));
    if (!U.started) sk("universe not started (empty graph)");
  }
  function setup() {                                      // 1200 x 800 cameras per band: U0 fit, U1+ on the biggest system
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, best = -1;
    for (let i = 0; i < N; i++) if (S.nodeVisible[i]) { x0 = Math.min(x0, S.x[i]); x1 = Math.max(x1, S.x[i]); y0 = Math.min(y0, S.y[i]); y1 = Math.max(y1, S.y[i]); }
    U.systems.forEach((y, s) => { if (S.nodeVisible[y.sun] && (best < 0 || y.size > U.systems[best].size)) best = s; });
    const fit = 0.88 * Math.min(1200 / Math.max(x1 - x0, 1), 800 / Math.max(y1 - y0, 1)), u = U.systems[best].sun;
    const sc = [0.9 * fit, Math.sqrt(Math.min(1.3 * fit, 0.15) * 0.15), 0.27, 0.9, 3.2];
    const cam = b => { const x = b ? S.x[u] : (x0 + x1) / 2, y = b ? S.y[u] : (y0 + y1) / 2; return {x: -x * sc[b], y: -y * sc[b], scale: sc[b], W: 1200, H: 800}; };
    return {u, cam, run: (b, m) => update(Object.assign({band: b, cam: cam(b)}, m || NONE))};
  }

  const sk = r => MX.selftest.skip(r);
  const hasSys = () => U.systems.some(y => S.nodeVisible[y.sun]);
  MX.selftest.add("scene.counts", async () => {
    await ready();
    if (!hasSys()) sk("no visible solar system in this graph");
    let vis = 0;
    for (let i = 0; i < N; i++) vis += S.nodeVisible[i];
    const {u, run} = setup();
    for (let b = 0; b < 5; b++) {
      const r = run(b);
      if (r.nPts !== vis) fail("U" + b + " nPts " + r.nPts + " != visible " + vis);
      for (let j = 0; j < r.nPts; j++) {
        const i = r.index[j], f = r.pts[j * PS + 7];
        if (!S.nodeVisible[i] || r.pts[j * PS] !== S.x[i] || r.pts[j * PS + 1] !== S.y[i]) fail("slot " + j + " is not body " + i);
        if (((f & 4) > 0) !== (ROLE[i] === 0) || (f & 11)) fail("flags " + f + " on " + g.id[i]);
      }
    }
    const lm = new Uint8Array(N), hm = new Uint8Array(M), e = g.adjEdge[g.adjOff[u]];
    lm[u] = 1; hm[e] = 1;
    let r = run(0, {lift: lm, dim: false, ring: lm, hot: hm});
    if (r.index[r.nPts - 1] !== u || r.pts[(r.nPts - 1) * PS + 7] !== 13) fail("lifted sun not last or flags != 13");
    if (S.edgeVisible[e] && !(r.ref[r.nLns - 1] === -1 - e && r.lns[(r.nLns - 1) * LS + 7] > 0.5)) fail("hot edge not last at a > .5");
    const s0 = S.selected;
    S.selected = u;                                       // derived: selecting u lifts + rings it, its edges go hot
    try {
      r = run(3, {});
      const j = r.index.subarray(0, r.nPts).indexOf(u);
      if (j < 0 || (r.pts[j * PS + 7] & 9) !== 9 || !st.hot) fail("derived selection flags / hot edges");
    } finally { S.selected = s0; }
    run(0);
    r = run(0);
    if (r.ptsDirty || r.lnsDirty) fail("dirty with nothing changed");
  });

  MX.selftest.add("scene.filaments", async () => {
    await ready();
    if (!hasSys()) sk("no visible solar system in this graph");
    if (aggDirty) aggregate();
    if (small) sk("small graph (< " + SMALL + " bodies): individual edges at every band, no filaments");
    const {u, cam, run} = setup(), ev = S.edgeVisible, nv = S.nodeVisible, gp = new Set();
    for (let e = 0; e < M; e++) {
      if (!ev[e] || !nv[SRC[e]] || !nv[DST[e]]) continue;
      const a = U.galaxyOfBody[SRC[e]], b = U.galaxyOfBody[DST[e]];
      if (a !== b) gp.add(Math.min(a, b) * nG + Math.max(a, b));
    }
    const arcs = (r, b) => {  // galaxy-pair arcs: <= cap pairs, T.seg contiguous segments each, actually curved
      const seen = new Map();
      for (let j = 0; j < r.nLns; j++) if (r.ref[j] >= AREF) seen.set(r.ref[j], (seen.get(r.ref[j]) || 0) + 1);
      if (seen.size > T.cap[b] || seen.size > gp.size) fail("U" + b + " arcs " + seen.size + " > cap " + T.cap[b]);
      for (const [f, n] of seen) {
        const q = f - AREF;
        if (n !== T.seg) fail("U" + b + " arc " + q + " has " + n + " segments");
        if (b === 0 && XC[LV[1].a[q]] === XC[LV[1].b[q]]) fail("U0 arc inside one cluster");
      }
      for (let j = 1; j < r.nLns; j++) if (r.ref[j] >= AREF && r.ref[j] === r.ref[j - 1]) {
        const o = j * LS, p = o - LS;
        if (r.lns[o] !== r.lns[p + 2] || r.lns[o + 1] !== r.lns[p + 3]) fail("arc polyline not contiguous");
      }
      const o = 0, m = (T.seg >> 1) * LS;  // first arc: the middle vertex is off the chord
      if (r.nLns >= T.seg && r.ref[0] >= AREF) {
        const x0 = r.lns[o], y0 = r.lns[o + 1], x1 = r.lns[(T.seg - 1) * LS + 2], y1 = r.lns[(T.seg - 1) * LS + 3];
        const d = Math.abs((x1 - x0) * (r.lns[m + 1] - y0) - (y1 - y0) * (r.lns[m] - x0)) / Math.max(Math.hypot(x1 - x0, y1 - y0), 1e-9);
        if (!(d > 0.05 * Math.hypot(x1 - x0, y1 - y0))) fail("U" + b + " arc is straight");
      }
      return seen.size;
    };
    let r = run(0);
    if (!arcs(r, 0) || r.nLns !== arcs(r, 0) * T.seg) fail("U0 lines " + r.nLns);
    r = run(1);
    if (!arcs(r, 1)) fail("U1 no arcs");
    const c = cam(2), k = c.scale, ox = c.x + 600, oy = c.y + 400, lmax = T.near * 800;
    r = run(2);
    arcs(r, 2);
    let th = 0;
    for (let j = 0; j < r.nLns; j++) {
      if (r.ref[j] >= AREF) continue;
      th++;
      const p = j * LS, a = LV[2].a[r.ref[j]], b = LV[2].b[r.ref[j]], R = y => U.radiusOf("system", y) * k + T.pad + 1;
      const on = (x, y, q) => { const sx = x * k + ox, sy = y * k + oy; return sx > -R(q) && sx < 1200 + R(q) && sy > -R(q) && sy < 800 + R(q); };
      if (a >= nSys || b >= nSys || !on(r.lns[p], r.lns[p + 1], a) || !on(r.lns[p + 2], r.lns[p + 3], b)) fail("U2 thread " + j + " leaves the screen");
      if (Math.hypot(r.lns[p + 2] - r.lns[p], r.lns[p + 3] - r.lns[p + 1]) * k >= lmax) fail("U2 thread " + j + " too long");
    }
    if (!(th > 0 && th <= T.cap[3] && th < LV[2].n)) fail("U2 threads " + th + " of " + LV[2].n);
    r = run(3);
    let vis = 0;
    for (let e = 0; e < M; e++) vis += ev[e];
    if (!r.nLns || r.nLns > vis || u < 0) fail("U3 lines " + r.nLns + " of " + vis);
  });
})();
