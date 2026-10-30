(function () {
  "use strict";
  // MX.universe: the closed-form gravity + dark-matter layout. Main thread, worker-free,
  // sole writer of S.x/S.y. Hierarchy = payload.universe (never recomputed). The engine is a closed-form
  // physics model with fixed constants, extended with a visibility mask (only visible
  // bodies are packed; a hidden sun stays as the empty centre of its visible planets), a world offset (repack anchor)
  // and allocation-free springs.
  const MX = window.MX;
  if (!MX || !MX.g || !MX.state) return;
  const TAU = Math.PI * 2;

  // ======== engine (closed-form physics model) ===============
  const C = {
    LIFT: 1.25, GAP_SUN: 3, GAP_SUN_K: 1, GAP_RING: 6, GAP_SYS: 8, GAP_SYS_K: 0.3, DUST_CLEAR: 6, GAP_DUST: 3,
    DUST_W: 10, DUST_BANDS_BETWEEN: 1, GAL_K: 3.2, CL_K: 0.55,
    // combined pages: relatedness of two clusters = 1 - exp(-shared names / CL_LINK); an unrelated pair keeps CL_APART x more clearance
    CL_APART: 1.5, CL_LINK: 20,
    SPIRAL_MIN: 400, PITCH: 0.32, ARM_KAPPA: 2.6, ARM_FLOOR: 0.03, SYS_ARM_KAPPA: 1.6,
    FILL_SYS: 0.3, FILL_RING: 0.7, FILL_DUST: 0.5, FILL_GAL: 0.9, SOLO_RING_MAX: 8, DUST_H_SPIRAL: 0.55, DUST_H_ELL: 0.3,
    F_DM: 6, NFW_C: 4, F_DM_CL: 8, CORO: 0.7, P_RING: 30, P_GAL: 600, P_CL: 3600,
    K_ANCHOR: 220, K_SUN: 260, K_PIN: 40, DAMP: 16, SUB: 1 / 120, DUST_TETHER: 20, CLAMP: 0.45, DRAG_K: 0.5, EPS_U: 0.05, DT_MAX: 0.2,
    // depth (3D): cluster z +- Z_CL x its radius (a loose shell), galaxy z +- Z_GAL x its lane radius around the cluster;
    // a galaxy's 2D ellipse (axis ratio q) is the face-on shadow of a circular disc inclined by acos(q), so x/y are
    // unchanged and only z is added; dust / suns get a flattened-ellipsoid thickness (Z_THIN spiral, Z_THICK
    // elliptical) x galaxy radius; each solar system has its own orbital plane, slope <= Z_SYS
    Z_CL: 0.9, Z_GAL: 0.7, Z_SYS: 0.6, Z_THIN: 0.12, Z_THICK: 0.5,
  };
  function rngOf(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const h01 = (a, b) => rngOf((Math.imul(a + 1, 2654435761) ^ Math.imul(b + 7, 40503)) >>> 0)();   // stable per id
  function chooseSlots(cap, m, r, weight, rng) {        // even spread, or weighted sampling w/o replacement
    const out = new Array(m);
    if (!weight) { const off = rng() * cap / m; for (let j = 0; j < m; j++) out[j] = Math.floor(off + j * cap / m) % cap; return out; }
    const keys = new Float64Array(cap), ix = new Array(cap);
    for (let j = 0; j < cap; j++) { keys[j] = Math.log(rng() + 1e-12) / weight((j + 0.5) * TAU / cap, r); ix[j] = j; }
    ix.sort((a, b) => keys[b] - keys[a]);
    for (let j = 0; j < m; j++) out[j] = ix[j];
    return out;
  }
  function laneCap(r, h, rhoMax, rhoMin, g, jitterR) {  // slots >= 2*rhoMax + g apart at the innermost centre radius
    const Rin = jitterR ? Math.max(r - h + rhoMin, 1e-9) : r, s = (2 * rhoMax + g) / (2 * Rin);
    if (s >= 1) return {cap: 1, dmin: TAU};
    const dmin = 2 * Math.asin(s);
    return {cap: Math.max(1, Math.floor(TAU / dmin)), dmin};
  }
  function fillLane(r, h, lc, members, rho, R, T, weight, jitterR, rng) {
    const m = members.length, cap = lc.cap, w = TAU / cap, jit = cap > 1 ? Math.max(0, (w - lc.dmin) / 2) * 0.999 : 0;
    const slots = chooseSlots(cap, m, r, weight, rng), ph = weight ? 0 : rng() * TAU;
    for (let j = 0; j < m; j++) {
      const i = members[j];
      T[i] = ph + slots[j] * w + (cap > 1 ? (rng() * 2 - 1) * jit : 0);
      R[i] = r + (jitterR ? (rng() * 2 - 1) * Math.max(0, h - rho[i]) * 0.999 : 0);
    }
  }
  function pack(items, rho, gap, o, rng) {              // items sorted by rho desc -> concentric lanes [{r,h,idx,g}]
    const R = o.R, T = o.T, lanes = [], n = items.length;
    let k = 0, free = o.r0 || 0;
    if (!n) return lanes;
    const rhoMin = rho[items[n - 1]];
    if (o.centre) {
      const i0 = items[0]; R[i0] = 0; T[i0] = 0;
      lanes.push({r: 0, h: rho[i0], idx: [i0], g: gap[i0]});
      free = rho[i0] + gap[i0] + (o.after ? o.after(0, gap[i0]) : 0); k = 1;
    }
    while (k < n) {
      const f = items[k], h = rho[f], g = gap[f], r = free + h, lc = laneCap(r, h, rho[f], rhoMin, g, o.jitterR);
      let m = Math.min(n - k, Math.max(1, Math.floor(lc.cap * o.fill)), o.maxPer || 1e9);
      if (lc.cap === 1) m = 1;
      const mem = items.slice(k, k + m);
      fillLane(r, h, lc, mem, rho, R, T, o.weight, o.jitterR, rng);
      lanes.push({r, h, idx: mem, g});
      free = r + h + g + (o.after ? o.after(lanes.length - 1, g) : 0);
      k += m;
    }
    return lanes;
  }
  const nfwM = x => Math.log(1 + x) - x / (1 + x);
  function curveFn(cr, Mdm, rs, mc) {                   // v(r) = sqrt((M_baryon(<r) + M_NFW(<r)) / r), G = 1
    function Mbar(r) {
      let lo = 0, hi = cr.r.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cr.r[mid] <= r) lo = mid + 1; else hi = mid; }
      return lo ? cr.m[lo - 1] : 0;
    }
    return r => {
      const mb = Mbar(r), md = Mdm * nfwM(r / rs) / mc;
      return {vb: Math.sqrt(mb / r), vd: Math.sqrt(md / r), v: Math.sqrt((mb + md) / r), mb, md};
    };
  }

  // sample: {n, clusters[names], galaxies[[cluster, type]], galaxyKey, degree, radius, system, galaxy, sun, systemSun}
  function engine(sample, opts) {
    const n = sample.n, nS = sample.systemSun.length, nG = sample.galaxies.length, nC = sample.clusters.length;
    const deg = sample.degree, sys = sample.system, gal = sample.galaxy, seed = opts.seed == null ? 7 : opts.seed;
    const rho = new Float32Array(n), mass = new Float32Array(n), kind = new Uint8Array(n), par = new Int32Array(n);
    let i, s, g, c;
    for (i = 0; i < n; i++) {
      rho[i] = C.LIFT * sample.radius[i]; mass[i] = deg[i] + 1;
      kind[i] = sys[i] < 0 ? 0 : (sample.sun[i] ? 1 : 2);   // 0 dust, 1 sun, 2 planet
      par[i] = sys[i] < 0 ? gal[i] : sys[i];
    }
    const memStart = new Int32Array(nS + 1), mem = new Int32Array(n), cnt = new Int32Array(nS);
    for (i = 0; i < n; i++) if (sys[i] >= 0) cnt[sys[i]]++;
    for (s = 0; s < nS; s++) memStart[s + 1] = memStart[s] + cnt[s];
    const fillp = memStart.slice(0, nS), byDeg = [];
    for (i = 0; i < n; i++) byDeg.push(i);
    byDeg.sort((a, b) => (kind[a] === 1 ? 0 : 1) - (kind[b] === 1 ? 0 : 1) || deg[b] - deg[a] || a - b);
    for (const k of byDeg) if (sys[k] >= 0) mem[fillp[sys[k]]++] = k;
    const sysGal = new Int32Array(nS), galCl = new Int32Array(nG), galNodes = new Int32Array(nG), galMass = new Float64Array(nG);
    for (s = 0; s < nS; s++) sysGal[s] = gal[sample.systemSun[s]];
    for (g = 0; g < nG; g++) galCl[g] = sample.clusters.indexOf(sample.galaxies[g][0]);
    for (i = 0; i < n; i++) { galNodes[gal[i]]++; galMass[gal[i]] += mass[i]; }
    const bR = new Float32Array(n), bT = new Float32Array(n), bW = new Float32Array(n);
    const sR = new Float32Array(nS), sT = new Float32Array(nS), sW = new Float32Array(nS), sRad = new Float32Array(nS),
      sClamp = new Float32Array(nS), sMass = new Float64Array(nS);
    const gR = new Float32Array(nG), gT = new Float32Array(nG), gW = new Float32Array(nG), gRad = new Float32Array(nG),
      gQ = new Float32Array(nG), gCos = new Float32Array(nG), gSin = new Float32Array(nG), gWp = new Float32Array(nG),
      gSpiral = new Uint8Array(nG), gRdisk = new Float32Array(nG);
    const cX = new Float32Array(nC), cY = new Float32Array(nC), cRad = new Float32Array(nC);
    const Z = new Float32Array(n), zn = new Float32Array(n), cZ = new Float32Array(nC), gZo = new Float32Array(nG), gTl = new Float32Array(nG),
      gz = new Float32Array(nG), tX = new Float32Array(nS), tY = new Float32Array(nS), szc = new Float32Array(nS);
    const bkey = sample.key || null, skey = sample.systemKey || null, ckey = sample.clusterKey || null;
    const curves = new Array(nG), galLanes = new Array(nG);
    const U = {
      n, nSystems: nS, nGalaxies: nG, nClusters: nC, kind, par, rho, mass, positions: new Float32Array(2 * n), posZ: Z, t: 0, sp: 1,
      settled: true, buildMs: 0, motion: opts.motion !== false, sysGal, galCl, sysRadius: sRad, galRadius: gRad,
      clRadius: cRad, galSpiral: gSpiral, memStart, members: mem, orbitR: bR, refGalaxy: 0,
    };
    const ux = new Float32Array(n), uy = new Float32Array(n), vx = new Float32Array(n), vy = new Float32Array(n);
    const active = [], dustAct = [], sysU = new Float32Array(2 * nS), sysV = new Float32Array(2 * nS), kP = new Float32Array(n);
    const slotX = new Float32Array(n), slotY = new Float32Array(n), bA = new Float64Array(n), bB = new Float64Array(n);
    const ringOf = new Int32Array(n), sx = new Float32Array(nS), sy = new Float32Array(nS), gx = new Float32Array(nG), gy = new Float32Array(nG);
    let pin = -1, pinX = 0, pinY = 0, pinDX = 0, pinDY = 0, acc = 0, loose = -1, wClamp = 0, nRing = 0, ringW, rCos, rSin;

    function build(sp) {
      const t0 = performance.now(), rng = rngOf(seed);
      U.sp = sp;
      const gapN = new Float32Array(n), ringW0 = [];
      // 1. solar systems: planets on rank-ordered Keplerian rings
      for (s = 0; s < nS; s++) {
        const a = memStart[s], b = memStart[s + 1], sun = mem[a], np = b - a - 1, items = [];
        bR[sun] = 0; bT[sun] = 0; bW[sun] = 0;
        for (let k = a + 1; k < b; k++) { items.push(mem[k]); gapN[mem[k]] = sp * C.GAP_RING; }
        const lanes = pack(items, rho, gapN, {R: bR, T: bT, r0: rho[sun] + sp * (C.GAP_SUN + C.GAP_SUN_K * rho[sun]),
          fill: C.FILL_RING, maxPer: np <= C.SOLO_RING_MAX ? 1 : 0, jitterR: false}, rng);
        let Min = mass[sun], out = rho[sun];
        sMass[s] = mass[sun];
        for (let l = 0; l < lanes.length; l++) {
          const L = lanes[l], w = Math.sqrt(Min / (L.r * L.r * L.r));   // Kepler on the enclosed mass
          if (l === 0) ringW0.push(w);
          for (const k of L.idx) { bW[k] = w; Min += mass[k]; sMass[s] += mass[k]; }
          out = L.r + L.h;
        }
        sRad[s] = out;
      }
      const wsort = ringW0.slice().sort((x, y) => x - y), tauSys = TAU / (C.P_RING * (wsort[wsort.length >> 1] || 1));
      for (i = 0; i < n; i++) if (kind[i] === 2) bW[i] *= tauSys;
      // 2. galaxies: systems on mass-segregated lanes (bulge at the centre), dust bands between and around
      const galVraw = [];
      let refG = 0;
      for (g = 0; g < nG; g++) if (galNodes[g] > galNodes[refG]) refG = g;
      for (g = 0; g < nG; g++) {
        const grng = rngOf((seed * 7919 + sample.galaxyKey[g] * 104729) >>> 0);   // orientation stable across re-packs
        const spiral = galNodes[g] >= C.SPIRAL_MIN, q = spiral ? 0.5 + 0.35 * grng() : 0.68 + 0.27 * grng();
        const phi = grng() * TAU, arms = galNodes[g] >= 1500 ? 3 : 2;
        let ra = 0;
        gSpiral[g] = spiral ? 1 : 0; gQ[g] = q; gCos[g] = Math.cos(phi); gSin[g] = Math.sin(phi);
        const sl = [], dust = [];
        for (s = 0; s < nS; s++) if (sysGal[s] === g) sl.push(s);
        sl.sort((x, y) => sRad[y] - sRad[x] || x - y);
        for (i = 0; i < n; i++) if (kind[i] === 0 && gal[i] === g) dust.push(i);
        const rd = C.LIFT / q, gd = sp * C.GAP_DUST / q, W = C.DUST_W * 2 * rd, hB = W / 2, clear = sp * C.DUST_CLEAR / q;
        const armFn = kap => (th, r) => C.ARM_FLOOR + Math.exp(kap * (Math.cos(arms * (th - Math.log(1 + r / (ra || 1)) / Math.tan(C.PITCH))) - 1));
        const srho = new Float32Array(nS), sgap = new Float32Array(nS), B = C.DUST_BANDS_BETWEEN;
        for (const k of sl) { srho[k] = sRad[k] / q; sgap[k] = sp * (C.GAP_SYS + C.GAP_SYS_K * sRad[k]) / q; }
        ra = sl.length ? srho[sl[0]] + 4 * W : 4 * W;
        const slanes = pack(sl, srho, sgap, {R: sR, T: sT, centre: true, fill: C.FILL_SYS, jitterR: true,
          weight: spiral && sl.length > 6 ? armFn(C.SYS_ARM_KAPPA) : null,
          after: (li, lg) => Math.max(0, 2 * clear + B * W + (B - 1) * gd - lg)}, rng);
        for (const L of slanes) { L.out = L.r + L.h; L.inn = L.r - L.h; }
        const Rdisk = slanes.length ? slanes[slanes.length - 1].out : 0, bands = [];
        gRdisk[g] = Rdisk;
        let capT = 0, r;
        const addBand = rr => {
          const lc = laneCap(rr, hB, rd, rd, gd, true), cc = lc.cap === 1 ? 1 : Math.floor(lc.cap * C.FILL_DUST);
          bands.push({r: rr, lc, cap: cc, n: 0}); capT += cc;
        };
        for (let li = 0; li + 1 < slanes.length; li++) {
          const st = slanes[li].out + clear, en = slanes[li + 1].inn - clear;
          for (r = st + hB; r + hB <= en + 1e-6; r += W + gd) addBand(r);
        }
        for (r = slanes.length ? Rdisk + clear + hB : hB; capT < 1.6 * dust.length || bands.length < 2; r += W + gd) addBand(r);
        // exponential surface density, water-filled into band capacities
        const hS = (spiral ? C.DUST_H_SPIRAL : C.DUST_H_ELL) * Math.max(Rdisk, 6 * W), wts = bands.map(bd => bd.r * Math.exp(-bd.r / hS) + 1e-9);
        let left = dust.length, open = bands.map((_, j) => j);
        while (left > 0 && open.length) {
          let ws = 0, placed = 0;
          for (const j of open) ws += wts[j];
          const nextOpen = [];
          for (const j of open) {
            const x = Math.min(Math.floor(left * wts[j] / ws), bands[j].cap - bands[j].n);
            bands[j].n += x; placed += x;
            if (bands[j].n < bands[j].cap) nextOpen.push(j);
          }
          left -= placed;
          if (!placed) {
            nextOpen.sort((x, y) => wts[y] - wts[x]);
            for (let k = 0; k < nextOpen.length && left > 0; k++) { bands[nextOpen[k]].n++; left--; }
          }
          open = nextOpen;
        }
        while (bands.length && bands[bands.length - 1].n === 0) bands.pop();
        const drho = new Float32Array(n), dArm = spiral ? armFn(C.ARM_KAPPA) : null;
        let di = 0;
        for (const bd of bands) {
          const part = dust.slice(di, di + bd.n); di += bd.n;
          for (const k of part) drho[k] = rd;
          fillLane(bd.r, hB, bd.lc, part, drho, bR, bT, dArm, true, rng);
        }
        const Rg = Math.max(Rdisk, bands.length ? bands[bands.length - 1].r + hB : 0, 1);
        gRad[g] = Rg;
        galLanes[g] = {lanes: slanes, bands};
        // rotation curve: baryons (systems at their lane radius, dust) + NFW halo -> flat v(r)
        const pts = [];
        for (const k of sl) pts.push([sR[k], sMass[k]]);
        for (const k of dust) pts.push([bR[k], mass[k]]);
        pts.sort((x, y) => x[0] - y[0]);
        const cr = {r: [], m: []}, rs = Rg / C.NFW_C;
        let cum = 0;
        for (const p of pts) { cum += p[1]; cr.r.push(p[0]); cr.m.push(cum); }
        const vAt = curveFn(cr, C.F_DM * galMass[g], rs, nfwM(C.NFW_C));
        curves[g] = {vAt, Rg, Rdisk, rs};
        galVraw[g] = vAt;
      }
      const gref = galLanes[refG].lanes, rref = gref.length ? gref[gref.length - 1].r : gRad[refG] * 0.6;
      const tauGal = TAU * rref / (C.P_GAL * galVraw[refG](rref).v) || 0;
      U.tauGal = tauGal; U.tauSys = tauSys; U.refGalaxy = refG;
      for (g = 0; g < nG; g++) {
        for (const L of galLanes[g].lanes) { L.w = L.r > 0 ? tauGal * galVraw[g](L.r).v / L.r : 0; for (const k of L.idx) sW[k] = L.w; }
        const rc = C.CORO * gRad[g];
        gWp[g] = tauGal * galVraw[g](rc).v / rc;           // dust: rigid density-wave pattern speed
      }
      for (i = 0; i < n; i++) if (kind[i] === 0) bW[i] = gWp[gal[i]];
      wClamp = C.CLAMP * sp * Math.min(C.GAP_RING, C.GAP_SUN);
      for (s = 0; s < nS; s++) {
        const gg = sysGal[s];
        let lg = 1e9;
        for (const L of galLanes[gg].lanes) if (L.idx.indexOf(s) >= 0) lg = L.g * gQ[gg];
        sClamp[s] = Math.max(0, C.CLAMP * Math.min(lg, sp * C.DUST_CLEAR) - wClamp);
      }
      // 3. clusters: galaxies on lanes around the largest (cD) galaxy, in an isothermal intracluster halo
      const ggap = new Float32Array(nG), clVraw = [], clLanes = [];
      for (g = 0; g < nG; g++) ggap[g] = sp * C.GAL_K * Math.sqrt(galMass[g]);
      let refC = 0;
      for (c = 0; c < nC; c++) {
        const gl = [];
        for (g = 0; g < nG; g++) if (galCl[g] === c) gl.push(g);
        gl.sort((x, y) => gRad[y] - gRad[x] || x - y);
        const glanes = clLanes[c] = pack(gl, gRad, ggap, {R: gR, T: gT, centre: true, fill: C.FILL_GAL, jitterR: false}, rng);
        cRad[c] = glanes.length ? glanes[glanes.length - 1].r + glanes[glanes.length - 1].h : 1;
        let Mc = 0;
        for (const k of gl) Mc += galMass[k] * (1 + C.F_DM);
        clVraw[c] = Math.sqrt(Mc * (1 + C.F_DM_CL) / cRad[c]);
        if (cRad[c] > cRad[refC]) refC = c;
      }
      const lr = clLanes[refC][clLanes[refC].length - 1], tauCl = lr && lr.r > 0 ? TAU * lr.r / (C.P_CL * clVraw[refC]) : 0;
      for (c = 0; c < nC; c++) for (const L of clLanes[c]) { const w = L.r > 0 ? tauCl * clVraw[c] / L.r : 0; for (const k of L.idx) gW[k] = w; }
      // cluster seats, then contraction + hard minimum separation (wider for unrelated clusters on combined pages)
      const link = sample.link, ck = c => (ckey ? ckey[c] : c);
      const apart = (p1, p2) => link ? 1 + C.CL_APART * Math.exp(-((link[ck(p1)] || [])[ck(p2)] || 0) / C.CL_LINK) : 1;
      const ord = [];
      let tot = 0;
      for (c = 0; c < nC; c++) { ord.push(c); tot += cRad[c]; }
      ord.sort((x, y) => cRad[y] - cRad[x]);
      const SEAT = {Code: [-0.85, -0.55], Data: [0.85, -0.55], Knowledge: [-0.35, 0.9], Other: [0.75, 0.85]};
      ord.forEach((cc, j) => {
        const st = SEAT[sample.clusters[cc]] || [Math.cos(j * 2.399963), Math.sin(j * 2.399963)];
        cX[cc] = tot * st[0]; cY[cc] = tot * st[1];
      });
      for (let it = 0; it < 300; it++) {
        for (c = 0; c < nC; c++) { cX[c] *= 0.97; cY[c] *= 0.97; }
        for (let pass = 0; pass < 40; pass++) {
          let bad = false;
          for (let p1 = 0; p1 < nC; p1++) for (let p2 = p1 + 1; p2 < nC; p2++) {
            const dx = cX[p2] - cX[p1], dy = cY[p2] - cY[p1], d = Math.hypot(dx, dy) || 1e-6, need = (cRad[p1] + cRad[p2]) * (1 + sp * C.CL_K) * apart(p1, p2);
            if (d < need) {
              bad = true;
              const push = (need - d) * 1.0001, wa = cRad[p2] / (cRad[p1] + cRad[p2]);
              cX[p1] -= dx / d * push * wa; cY[p1] -= dy / d * push * wa;
              cX[p2] += dx / d * push * (1 - wa); cY[p2] += dy / d * push * (1 - wa);
            }
          }
          if (!bad) break;
        }
      }
      let mx = 0, my = 0;
      for (c = 0; c < nC; c++) { mx += cX[c] / nC; my += cY[c] / nC; }
      for (c = 0; c < nC; c++) { cX[c] -= mx; cY[c] -= my; }
      // 4. depth: hashed from global ids (stable across re-packs and masks), never from the rng sequence
      for (c = 0; c < nC; c++) cZ[c] = (h01(ckey ? ckey[c] : c, 1) * 2 - 1) * C.Z_CL * cRad[c];
      for (g = 0; g < nG; g++) {
        const gk = sample.galaxyKey[g];
        gZo[g] = (h01(gk, 2) * 2 - 1) * C.Z_GAL * gR[g];
        gTl[g] = (h01(gk, 3) < 0.5 ? -1 : 1) * Math.sqrt(Math.max(0, 1 - gQ[g] * gQ[g]));
      }
      for (s = 0; s < nS; s++) { const sk = skey ? skey[s] : s, a = h01(sk, 4) * TAU, m = C.Z_SYS * h01(sk, 5); tX[s] = m * Math.cos(a); tY[s] = m * Math.sin(a); }
      for (i = 0; i < n; i++) {
        if (kind[i] === 2) { zn[i] = 0; continue; }
        const bk = bkey ? bkey[i] : i, tri = h01(bk, 6) + h01(bk, 7) - 1, gg = kind[i] === 0 ? par[i] : sysGal[par[i]];
        const rr = (kind[i] === 0 ? bR[i] : sR[par[i]]) / Math.max(gRad[gg], 1), th = (gSpiral[gg] ? C.Z_THIN : C.Z_THICK) * gRad[gg];
        zn[i] = tri * th * Math.sqrt(Math.max(0.05, 1 - rr * rr)) * (kind[i] === 1 ? 0.5 : 1);
      }
      const rmap = new Map(), rl = [];
      for (i = 0; i < n; i++) {
        bA[i] = bR[i] * Math.cos(bT[i]); bB[i] = bR[i] * Math.sin(bT[i]);
        if (kind[i] === 1) continue;
        let rid = rmap.get(bW[i]);
        if (rid === undefined) { rid = rl.length; rl.push(bW[i]); rmap.set(bW[i], rid); }
        ringOf[i] = rid;
      }
      nRing = rl.length; ringW = Float64Array.from(rl); rCos = new Float64Array(nRing); rSin = new Float64Array(nRing);
      U.rings = nRing;
      U.buildMs = performance.now() - t0;
      ux.fill(0); uy.fill(0); vx.fill(0); vy.fill(0); sysU.fill(0); sysV.fill(0);
      for (s = 0; s < nS; s++) {                         // ring stiffness: inner rings stiffer (Kepler-like)
        let r1 = 0;
        for (let q1 = memStart[s] + 1; q1 < memStart[s + 1]; q1++) { const p1 = mem[q1]; if (!r1 || bR[p1] < r1) r1 = bR[p1]; }
        for (let q1 = memStart[s] + 1; q1 < memStart[s + 1]; q1++) { const p1 = mem[q1]; kP[p1] = C.K_SUN * Math.max(0.4, Math.sqrt(r1 / bR[p1])); }
        kP[mem[memStart[s]]] = C.K_SUN;
      }
      active.length = 0; dustAct.length = 0; pin = -1; loose = -1; U.settled = true;
      compute();
    }

    function compute() {                                 // closed form at U.t, plus spring offsets
      const t = U.t, P = U.positions;
      for (let k = 0; k < nG; k++) { const a = gT[k] + gW[k] * t, cc = galCl[k]; gx[k] = cX[cc] + gR[k] * Math.cos(a); gy[k] = cY[cc] + gR[k] * Math.sin(a); }
      for (let k = 0; k < nS; k++) {
        const gg = sysGal[k], b = sT[k] + sW[k] * t, lx = sR[k] * Math.cos(b), ly = sR[k] * Math.sin(b) * gQ[gg];
        sx[k] = gx[gg] + lx * gCos[gg] - ly * gSin[gg]; sy[k] = gy[gg] + lx * gSin[gg] + ly * gCos[gg];
      }
      for (let r = 0; r < nRing; r++) { const ang = ringW[r] * t; rCos[r] = Math.cos(ang); rSin[r] = Math.sin(ang); }
      for (let k = 0; k < n; k++) {                      // one rotor per lane, 4 multiply-adds per body
        const kd = kind[k], p = par[k];
        let x, y;
        if (kd === 1) { x = sx[p]; y = sy[p]; } else {
          const ro = ringOf[k], cr = rCos[ro], sr = rSin[ro], A = bA[k], B = bB[k];
          let dx = A * cr - B * sr, dy = B * cr + A * sr;
          if (kd === 0) { dy *= gQ[p]; x = gx[p] + dx * gCos[p] - dy * gSin[p]; y = gy[p] + dx * gSin[p] + dy * gCos[p]; } else { x = sx[p] + dx; y = sy[p] + dy; }
        }
        P[2 * k] = x; P[2 * k + 1] = y;
      }
      for (let j = 0; j < active.length; j++) {
        const s2 = active[j], Ux = sysU[2 * s2], Uy = sysU[2 * s2 + 1];
        for (let q = memStart[s2]; q < memStart[s2 + 1]; q++) { const k = mem[q]; P[2 * k] += Ux + ux[k]; P[2 * k + 1] += Uy + uy[k]; }
      }
      for (let j = 0; j < dustAct.length; j++) { const k = dustAct[j]; P[2 * k] += ux[k]; P[2 * k + 1] += uy[k]; }
      // z follows x/y: dust + suns on their galaxy's inclined disc (+ thickness), planets on their system's plane
      for (let k = 0; k < nG; k++) gz[k] = cZ[galCl[k]] + gZo[k];
      for (let k = 0; k < n; k++) if (kind[k] !== 2) { const gg = kind[k] === 0 ? par[k] : sysGal[par[k]]; Z[k] = zPlane(gg, P[2 * k], P[2 * k + 1]) + zn[k]; }
      for (let k = 0; k < n; k++) if (kind[k] === 2) {
        const s2 = par[k], sun = mem[memStart[s2]];
        Z[k] = Z[sun] + (P[2 * k] - P[2 * sun]) * tX[s2] + (P[2 * k + 1] - P[2 * sun + 1]) * tY[s2];
      }
      for (let k = 0; k < nS; k++) szc[k] = Z[mem[memStart[k]]];
    }
    // z of galaxy gg's disc plane at (x, y): the 2D ellipse's minor-axis offset, de-projected (/ q) and inclined
    function zPlane(gg, x, y) { return gz[gg] + gTl[gg] * ((y - gy[gg]) * gCos[gg] - (x - gx[gg]) * gSin[gg]) / gQ[gg]; }

    // Drag-bounce: system frame U_s on a damped spring to its slot, planets jiggle w_i on K_SUN springs driven by
    // the frame's acceleration. |U_s| <= max(CLAMP * clearance, DRAG_K * system radius): visible at every zoom; overlaps
    // are allowed while dragging / bouncing and other systems never move (only active systems get offsets).
    function springs(dt) {
      let keep = 0;
      for (let j = 0; j < active.length; j++) {
        const s2 = active[j], a = memStart[s2], b = memStart[s2 + 1], sun = mem[a], Ls = Math.max(sClamp[s2], C.DRAG_K * sRad[s2]), Lw = wClamp;
        let Ux = sysU[2 * s2], Uy = sysU[2 * s2 + 1], Vx = sysV[2 * s2], Vy = sysV[2 * s2 + 1], moving = false;
        let Ax = -C.K_ANCHOR * Ux - C.DAMP * Vx, Ay = -C.K_ANCHOR * Uy - C.DAMP * Vy;
        const pinned = pin >= 0 && kind[pin] !== 0 && par[pin] === s2;
        if (!U.motion) {                                 // motion off: only the dragged body follows the pointer
          if (pinned) { ux[pin] = pinDX; uy[pin] = pinDY; active[keep++] = s2; }
          continue;
        }
        if (pinned) { Ax += C.K_PIN * (pinDX - Ux); Ay += C.K_PIN * (pinDY - Uy); }
        Vx += Ax * dt; Vy += Ay * dt; Ux += Vx * dt; Uy += Vy * dt;
        let m = Math.hypot(Ux, Uy), nx, ny, vr;
        if (m > Ls) { nx = Ux / m; ny = Uy / m; vr = Vx * nx + Vy * ny; Ux = nx * Ls; Uy = ny * Ls; if (vr > 0) { Vx -= vr * nx; Vy -= vr * ny; } }
        sysU[2 * s2] = Ux; sysU[2 * s2 + 1] = Uy; sysV[2 * s2] = Vx; sysV[2 * s2 + 1] = Vy;
        if (Math.abs(Ux) + Math.abs(Uy) > C.EPS_U || Math.abs(Vx) + Math.abs(Vy) > C.EPS_U) moving = true;
        for (let q = a; q < b; q++) {
          const k = mem[q];
          if (k === pin) { ux[k] = pinDX - Ux; uy[k] = pinDY - Uy; continue; }
          if (k === sun && !ux[k] && !uy[k] && !vx[k] && !vy[k]) continue;   // the sun is the frame (PH froze a released sun's offset, then snapped)
          const kk = kP[k], m0 = Math.max(Lw, Math.hypot(ux[k], uy[k]));
          vx[k] += (-kk * ux[k] - C.DAMP * vx[k] - Ax) * dt; vy[k] += (-kk * uy[k] - C.DAMP * vy[k] - Ay) * dt;
          ux[k] += vx[k] * dt; uy[k] += vy[k] * dt;
          m = Math.hypot(ux[k], uy[k]);
          if (m > m0) { nx = ux[k] / m; ny = uy[k] / m; vr = vx[k] * nx + vy[k] * ny; ux[k] = nx * m0; uy[k] = ny * m0; if (vr > 0) { vx[k] -= vr * nx; vy[k] -= vr * ny; } }
          if (k === loose && m0 <= Lw) loose = -1;
          if (Math.abs(ux[k]) + Math.abs(uy[k]) > C.EPS_U || Math.abs(vx[k]) + Math.abs(vy[k]) > C.EPS_U) moving = true;
        }
        if (pinned) moving = true;
        if (moving) active[keep++] = s2;
        else { for (let q = a; q < b; q++) { const k = mem[q]; ux[k] = uy[k] = vx[k] = vy[k] = 0; } sysU[2 * s2] = sysU[2 * s2 + 1] = sysV[2 * s2] = sysV[2 * s2 + 1] = 0; }
      }
      active.length = keep; keep = 0;
      for (let j = 0; j < dustAct.length; j++) {         // dust: tethered to its slot
        const d = dustAct[j];
        if (d === pin) { ux[d] = pinDX; uy[d] = pinDY; dustAct[keep++] = d; continue; }
        if (!U.motion) continue;
        vx[d] += (-C.K_ANCHOR * ux[d] - C.DAMP * vx[d]) * dt; vy[d] += (-C.K_ANCHOR * uy[d] - C.DAMP * vy[d]) * dt;
        ux[d] += vx[d] * dt; uy[d] += vy[d] * dt;
        if (Math.abs(ux[d]) + Math.abs(uy[d]) > C.EPS_U || Math.abs(vx[d]) + Math.abs(vy[d]) > C.EPS_U) dustAct[keep++] = d;
        else { ux[d] = uy[d] = vx[d] = vy[d] = 0; if (loose === d) loose = -1; }
      }
      dustAct.length = keep;
      if (loose >= 0 && (kind[loose] === 0 ? dustAct.indexOf(loose) < 0 : active.indexOf(par[loose]) < 0)) loose = -1;
      U.settled = active.length === 0 && dustAct.length === 0;
    }
    function pinTo() {                                   // pinned displacement = pointer - slot, soft-limited
      const dust = kind[pin] === 0, s2 = par[pin], dx = pinX - slotX[pin], dy = pinY - slotY[pin], m = Math.hypot(dx, dy);
      const Lm = dust ? C.DUST_TETHER * U.sp : kind[pin] === 1 ? Math.max(2 * sClamp[s2], C.DRAG_K * sRad[s2]) : 1.5 * sRad[s2] + 1, f = m > 0 ? Lm * Math.tanh(m / Lm) / m : 0;
      pinDX = dx * f; pinDY = dy * f;
      const bx = dust ? 0 : sysU[2 * s2], by = dust ? 0 : sysU[2 * s2 + 1];
      vx[pin] = 0.7 * vx[pin] + 0.3 * (pinDX - bx - ux[pin]) / C.SUB; vy[pin] = 0.7 * vy[pin] + 0.3 * (pinDY - by - uy[pin]) / C.SUB;
    }
    U.step = function (dt, animate) {
      dt = Math.min(dt || 0, C.DT_MAX);
      let moved = false;
      if (animate && dt > 0) { U.t += dt; moved = true; }
      if (active.length || dustAct.length) {
        compute();
        const P = U.positions;
        for (let j = 0; j < active.length; j++) for (let q = memStart[active[j]]; q < memStart[active[j] + 1]; q++) {
          const k = mem[q]; slotX[k] = P[2 * k] - ux[k] - sysU[2 * active[j]]; slotY[k] = P[2 * k + 1] - uy[k] - sysU[2 * active[j] + 1];
        }
        for (let j = 0; j < dustAct.length; j++) { const k = dustAct[j]; slotX[k] = P[2 * k] - ux[k]; slotY[k] = P[2 * k + 1] - uy[k]; }
        acc += dt;
        let steps = 0;
        while (acc >= C.SUB && steps < 24) { if (pin >= 0) pinTo(); springs(C.SUB); acc -= C.SUB; steps++; }
        if (steps === 24) acc = 0;
        moved = true;
      }
      if (moved) compute();
      return moved;
    };
    U.dragStart = function (k, x, y) {
      if (!(k >= 0 && k < n)) return false;
      if (pin >= 0) U.dragEnd();
      const P = U.positions;
      if (kind[k] === 0) { if (dustAct.indexOf(k) < 0) { dustAct.push(k); slotX[k] = P[2 * k]; slotY[k] = P[2 * k + 1]; } } else {
        const s2 = par[k];
        if (active.indexOf(s2) < 0) { active.push(s2); for (let q = memStart[s2]; q < memStart[s2 + 1]; q++) { const m = mem[q]; slotX[m] = P[2 * m]; slotY[m] = P[2 * m + 1]; } }
      }
      pin = k; pinX = x; pinY = y; acc = 0; loose = -1; U.settled = false;
      return true;
    };
    U.dragMove = (x, y) => { if (pin >= 0) { pinX = x; pinY = y; } };
    U.dragEnd = function () {
      if (pin < 0) return;
      if (!U.motion) {                                   // snap home, no bounce frames
        if (kind[pin] === 0) { ux[pin] = uy[pin] = vx[pin] = vy[pin] = 0; dustAct.splice(dustAct.indexOf(pin), 1); } else {
          const s2 = par[pin];
          for (let q = memStart[s2]; q < memStart[s2 + 1]; q++) { const k = mem[q]; ux[k] = uy[k] = vx[k] = vy[k] = 0; }
          sysU[2 * s2] = sysU[2 * s2 + 1] = sysV[2 * s2] = sysV[2 * s2 + 1] = 0; active.splice(active.indexOf(s2), 1);
        }
        pin = -1; loose = -1; U.settled = active.length === 0 && dustAct.length === 0; compute(); return;
      }
      loose = pin; pin = -1;
    };
    U.dragging = () => pin >= 0;
    U.lifted = () => (pin >= 0 ? pin : loose);
    U.setSpacing = sp => build(Math.max(0.5, Math.min(3, +sp || 1)));
    U.setTime = t => { U.t = t; compute(); };
    U.shift = (dx, dy) => { for (let k = 0; k < nC; k++) { cX[k] += dx; cY[k] += dy; } compute(); };
    // vis (Uint8Array n, optional): only these bodies count. Sweep-and-prune on lifted envelopes.
    function list(vis) { const ix = []; for (let k = 0; k < n; k++) if (!vis || vis[k]) ix.push(k); return ix; }
    U.overlaps = function (skip, vis) {
      const P = U.positions, ix = list(vis), m = ix.length;
      let cc = 0, worst = 0;
      ix.sort((a, b) => (P[2 * a] - rho[a]) - (P[2 * b] - rho[b]));
      for (let j = 0; j < m; j++) {
        const a = ix[j], ax = P[2 * a], ay = P[2 * a + 1], hi = ax + rho[a];
        for (let k = j + 1; k < m; k++) {
          const b = ix[k];
          if (P[2 * b] - rho[b] > hi) break;
          if (a === skip || b === skip) continue;
          const d = Math.hypot(P[2 * b] - ax, P[2 * b + 1] - ay), need = rho[a] + rho[b];
          if (d < need - 1e-3) { cc++; worst = Math.max(worst, need - d); }
        }
      }
      return {count: cc, worst};
    };
    U.meanNN = function (vis) {                          // mean centre-to-nearest-neighbour distance (world units)
      const P = U.positions, ix = list(vis), m = ix.length;
      let tot = 0;
      if (m < 2) return 0;
      ix.sort((p, q) => P[2 * p] - P[2 * q]);
      for (let j = 0; j < m; j++) {
        const a = ix[j], ax = P[2 * a], ay = P[2 * a + 1];
        let best = Infinity;
        for (let k = j + 1; k < m; k++) { const b = ix[k], dx = P[2 * b] - ax; if (dx >= best) break; best = Math.min(best, Math.hypot(dx, P[2 * b + 1] - ay)); }
        for (let k = j - 1; k >= 0; k--) { const b = ix[k], dx = ax - P[2 * b]; if (dx >= best) break; best = Math.min(best, Math.hypot(dx, P[2 * b + 1] - ay)); }
        tot += best;
      }
      return tot / m;
    };
    U.rotationCurve = function (gg, samples) {
      const cv = curves[gg], out = [];
      samples = samples || 24;
      for (let k = 1; k <= samples; k++) { const r = cv.Rg * k / samples, v = cv.vAt(r); out.push({r, v: v.v, vBaryon: v.vb, vDM: v.vd}); }
      return {galaxy: gg, Rg: cv.Rg, Rdisk: cv.Rdisk, rs: cv.rs, points: out};
    };
    U.systemCentre = k => [sx[k], sy[k], szc[k]];
    U.galaxyCentre = k => [gx[k], gy[k], gz[k]];
    U.clusterCentre = k => [cX[k], cY[k], cZ[k]];
    U.zPlane = zPlane;
    U.systemTilt = k => [tX[k], tY[k]];
    U.setSpacing(opts.sp == null ? 1 : opts.sp);
    return U;
  }

  // ======== hierarchy tables from payload.universe ===========================================
  const g = MX.g, D = g.D, N = g.N, S = MX.state;
  const PU = D.universe && Array.isArray(D.universe.sys) && D.universe.sys.length === N && Array.isArray(D.universe.sun) ? D.universe : null;
  const CL = (PU && PU.clusters) || D.groups || [];
  const nSys = PU ? PU.sun.length : 0, sunOf = new Int32Array(nSys), sysOf = new Int32Array(N).fill(-1), role = new Uint8Array(N);
  for (let s = 0; s < nSys; s++) sunOf[s] = PU.sun[s];
  if (PU) for (let i = 0; i < N; i++) { const s = PU.sys[i]; sysOf[i] = Number.isInteger(s) && s >= 0 && s < nSys ? s : -1; }
  for (let i = 0; i < N; i++) role[i] = sysOf[i] < 0 ? 2 : sunOf[sysOf[i]] === i ? 0 : 1;   // 0 sun, 1 planet, 2 dust
  const tGroup = new Int16Array(D.types.length).fill(-1);
  for (let i = 0; i < N; i++) tGroup[g.type[i]] = g.group[i];
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const tOrder = D.types.map((_, t) => t).filter(t => tGroup[t] >= 0).sort((a, b) => tGroup[a] - tGroup[b] || cmp(D.types[a], D.types[b]));
  const galOfType = new Int16Array(D.types.length).fill(-1), nGal = tOrder.length, galOf = new Uint16Array(N);
  tOrder.forEach((t, k) => { galOfType[t] = k; });
  for (let i = 0; i < N; i++) galOf[i] = galOfType[g.type[i]];
  const radius = new Float32Array(N);                    // A10, world units before lift
  for (let i = 0; i < N; i++) { const r = role[i], q = Math.sqrt(g.deg[i]); radius[i] = r === 0 ? 3 + 2.2 * q : r === 1 ? 1.5 + 0.5 * q : 1; }
  const memStart = new Int32Array(nSys + 1), members = new Int32Array(N - role.reduce((a, r) => a + (r === 2 ? 1 : 0), 0));
  {                                                      // CSR per system in orbit order: sun, then (-deg, index)
    const cnt = new Int32Array(nSys), ord = [];
    for (let i = 0; i < N; i++) if (sysOf[i] >= 0) { cnt[sysOf[i]]++; ord.push(i); }
    for (let s = 0; s < nSys; s++) memStart[s + 1] = memStart[s] + cnt[s];
    ord.sort((a, b) => role[a] - role[b] || g.deg[b] - g.deg[a] || a - b);
    const fp = memStart.slice(0, nSys);
    for (const i of ord) members[fp[sysOf[i]]++] = i;
  }
  const galaxies = tOrder.map(t => ({cluster: tGroup[t], type: D.types[t], name: D.types[t], size: 0, systems: [], dust: []}));
  for (let i = 0; i < N; i++) { const G = galaxies[galOf[i]]; G.size++; if (role[i] === 2) G.dust.push(i); }
  const systems = [];
  for (let s = 0; s < nSys; s++) { const k = galOf[sunOf[s]]; galaxies[k].systems.push(s); systems.push({sun: sunOf[s], galaxy: k, size: memStart[s + 1] - memStart[s], name: g.label[sunOf[s]]}); }
  for (const G of galaxies) { G.systems = Int32Array.from(G.systems); G.dust = Int32Array.from(G.dust); }
  const clusters = CL.map((name, c) => ({name, galaxies: [], size: 0}));
  galaxies.forEach((G, k) => { const c = clusters[G.cluster]; if (c) { c.galaxies.push(k); c.size += G.size; } });

  // Engine instance over a visibility mask (payload order). Galaxies/clusters/systems with nothing visible are left out;
  // a hidden sun of a visible planet stays as its (undrawn) centre so the hierarchy never changes.
  function instance(mask, sp, motion) {
    const sysVis = new Uint8Array(nSys), li = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; i++) if (mask[i] && sysOf[i] >= 0) sysVis[sysOf[i]] = 1;
    const gi = [];
    for (let i = 0; i < N; i++) if (mask[i] || (role[i] === 0 && sysVis[sysOf[i]])) { li[i] = gi.length; gi.push(i); }
    const n = gi.length;
    if (!n) return null;
    const gLoc = new Int32Array(nGal).fill(-1), cLoc = new Int32Array(CL.length).fill(-1), sLoc = new Int32Array(nSys).fill(-1);
    for (const i of gi) gLoc[galOf[i]] = 0;
    const gl = [], cl = [], sl = [];
    for (let k = 0; k < nGal; k++) if (gLoc[k] === 0) { gLoc[k] = gl.length; gl.push(k); cLoc[galaxies[k].cluster] = 0; }
    for (let c = 0; c < CL.length; c++) if (cLoc[c] === 0) { cLoc[c] = cl.length; cl.push(c); }
    for (let s = 0; s < nSys; s++) if (sysVis[s]) { sLoc[s] = sl.length; sl.push(s); }
    const sample = {n, clusters: cl.map(c => CL[c]), galaxies: gl.map(k => [CL[galaxies[k].cluster], galaxies[k].type]),
      galaxyKey: Int32Array.from(gl), degree: new Float32Array(n), radius: new Float32Array(n), system: new Int32Array(n),
      galaxy: new Int32Array(n), sun: new Uint8Array(n), systemSun: Int32Array.from(sl, s => li[sunOf[s]]),
      key: Int32Array.from(gi), systemKey: Int32Array.from(sl), clusterKey: Int32Array.from(cl),
      link: PU && Array.isArray(PU.link) ? PU.link : null};
    const vis = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const i = gi[k];
      sample.degree[k] = g.deg[i]; sample.radius[k] = radius[i]; sample.galaxy[k] = gLoc[galOf[i]];
      sample.system[k] = sysOf[i] >= 0 ? sLoc[sysOf[i]] : -1; sample.sun[k] = role[i] === 0 ? 1 : 0; vis[k] = mask[i] ? 1 : 0;
    }
    return {eng: engine(sample, {sp, seed: 7, motion}), n, gi: Int32Array.from(gi), li, gLoc, cLoc, sLoc, vis};
  }

  // ======== page state ======================================================================================
  const DUR = 300;                                       // --dur-repack
  const packed = new Uint8Array(N), fromX = new Float32Array(N), fromY = new Float32Array(N), fromZ = new Float32Array(N), appear = new Uint8Array(N);
  let cur = null, sp = 1, started = false, t = 0, tw0 = -1, twK = 1, lastNow = 0, repacks = 0, frames = 0, dragI = -1;
  let meas = {overlaps: 0, meanNN: 0}, rafId = 0, toId = 0;

  function motionReason() {                              // motion gate; inputs: S.anim, RM, document.hidden, S.view
    if (S.anim === false) return "off";
    if (S.reducedMotion) return "rm";
    if (document.hidden) return "hidden";
    if (S.view !== "graph") return "view";
    return "";
  }
  function write() {                                     // engine (local) -> S.x/S.y (payload order), with the repack tween
    if (!cur) return;
    const P = cur.eng.positions, PZ = cur.eng.posZ, gi = cur.gi, n = cur.n, X = S.x, Y = S.y, Z = S.z, zs = S.zScale;   // zs: 2D / 3D depth
    if (tw0 >= 0) {
      const k = Math.min(1, (performance.now() - tw0) / DUR), e = 1 - (1 - k) * (1 - k) * (1 - k);
      for (let j = 0; j < n; j++) {
        const i = gi[j];
        if (appear[i]) { X[i] = P[2 * j]; Y[i] = P[2 * j + 1]; Z[i] = PZ[j] * zs; } else {
          X[i] = fromX[i] + (P[2 * j] - fromX[i]) * e; Y[i] = fromY[i] + (P[2 * j + 1] - fromY[i]) * e; Z[i] = fromZ[i] + (PZ[j] * zs - fromZ[i]) * e;
        }
      }
      twK = e;
      if (k >= 1) { tw0 = -1; twK = 1; }
    } else for (let j = 0; j < n; j++) { const i = gi[j]; X[i] = P[2 * j]; Y[i] = P[2 * j + 1]; Z[i] = PZ[j] * zs; }
  }
  function measure() {
    meas = cur ? {overlaps: cur.eng.overlaps(-1, cur.vis).count, meanNN: Math.round(cur.eng.meanNN(cur.vis) * 100) / 100} : {overlaps: 0, meanNN: 0};
  }
  function settle() {
    S.settled = true; S.alpha = 0;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (toId) { clearTimeout(toId); toId = 0; }
    measure();
    MX.emit("positions"); MX.emit("settled"); MX.status();
  }
  const transient = () => !!cur && (tw0 >= 0 || !cur.eng.settled);
  function tick() {                                      // runs only while a tween or spring transient is live
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (toId) { clearTimeout(toId); toId = 0; }
    if (step(performance.now())) MX.emit("positions");
    if (transient()) kick();
  }
  function kick() {                                      // rAF, with a timer so a frozen virtual-time clock still finishes
    if (!rafId) rafId = requestAnimationFrame(tick);
    if (!toId) toId = setTimeout(tick, 34);
  }
  function step(now) {
    if (!cur) return false;
    const dt = lastNow ? Math.min(Math.max(0, (now - lastNow) / 1000), C.DT_MAX) : 0, reason = motionReason();
    lastNow = now;
    const e = cur.eng, anim = U.animate && reason === "", tw = tw0 >= 0, wasSettled = e.settled;
    e.motion = reason === "";
    let moved = e.step(dt, anim);
    if (anim && dt > 0) { t = e.t; frames++; }
    if (moved || tw) { write(); moved = true; }
    if ((tw || !wasSettled) && tw0 < 0 && e.settled && dragI < 0) settle();
    return moved;
  }
  function anchor() {                                    // repack anchor: selected body, else visible sun nearest the screen centre
    const sel = S.selected;
    if (sel >= 0 && packed[sel] && S.nodeVisible[sel]) return sel;
    const cam = S.camera, tg = MX.camera && MX.camera.target ? MX.camera.target() : null;   // 3D: the orbit target
    const cx = tg ? tg[0] : -cam.panX / cam.scale, cy = tg ? tg[1] : -cam.panY / cam.scale;
    let best = -1, bd = Infinity;
    for (let i = 0; i < N; i++) {
      if (role[i] !== 0 || !packed[i] || !S.nodeVisible[i]) continue;
      const d = (S.x[i] - cx) ** 2 + (S.y[i] - cy) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function repack(reason, tween) {
    if (dragI >= 0) U.dragEnd();
    const had = !!cur, nv = S.nodeVisible;
    tween = tween !== false && had && motionReason() === "";
    if (tween) { fromX.set(S.x); fromY.set(S.y); fromZ.set(S.z); }
    for (let i = 0; i < N; i++) appear[i] = nv[i] && !packed[i] ? 1 : 0;
    const A = had && S.camera.userAdjusted ? anchor() : -1, ax = A >= 0 ? S.x[A] : 0, ay = A >= 0 ? S.y[A] : 0;
    packed.set(nv);
    cur = instance(packed, sp, motionReason() === "");
    if (cur) {
      cur.eng.setTime(t);
      const k = A >= 0 ? cur.li[A] : -1;
      if (k >= 0) cur.eng.shift(ax - cur.eng.positions[2 * k], ay - cur.eng.positions[2 * k + 1]);
    }
    repacks++;
    tw0 = tween && cur ? performance.now() : -1;
    twK = tw0 >= 0 ? 0 : 1;
    write();
    MX.emit("repack", {reason});
    if (tw0 >= 0) { S.settled = false; MX.emit("positions"); kick(); } else settle();
  }
  function onVisibility() {
    if (!started) return;
    const nv = S.nodeVisible;
    for (let i = 0; i < N; i++) if (nv[i] !== packed[i]) { repack("visibility", true); return; }
  }
  const T = [0.15, 0.5, 1.6];                            // zoom bands T1..T3 (T0 is fit-relative)
  function safeBox() {
    const sr = MX.camera && MX.camera.safeRect ? MX.camera.safeRect() : null;
    return sr ? [sr.r - sr.l, sr.b - sr.t] : [innerWidth, innerHeight];
  }

  const U = MX.universe = {
    C, role, sys: sysOf, sun: sunOf, galaxyOfBody: galOf, radius, memStart, members, galaxies, systems, clusters, appear,
    animate: false,                                      // renderer input: its animation loop runs (orbits advance)
    band: null, glow: false, settleMs: 0,                // renderer-owned status inputs
    roleOf: i => role[i], clusterOf: i => g.group[i], galaxyOf: i => galOf[i], systemOf: i => sysOf[i],
    get spacing() { return sp; }, get t() { return t; }, get tween() { return twK; }, get started() { return started; },
    motionReason, step, instance,
    start() {
      if (started) return;
      started = true; S.alpha = 0; S.layoutMode = "universe";
      const t0 = performance.now();
      repack("start", false);
      U.settleMs = performance.now() - t0;
    },
    repack(reason) { if (started) repack(reason || "relayout", true); },
    setSpacing(v) {
      v = Math.max(0.5, Math.min(3, +v || 1));
      if (v === sp) return;
      sp = v;
      if (started) repack("spacing", true);
    },
    setTime(v) { t = +v || 0; if (cur) { cur.eng.setTime(t); write(); MX.emit("positions"); } },
    bandFor(s, fitAll) {
      const T0 = fitAll > 0 ? Math.min(1.3 * fitAll, T[0]) : T[0];
      return (T0 <= s) + (T[0] <= s) + (T[1] <= s) + (T[2] <= s);
    },
    centerOf(kind, k) {
      if (kind === "body") return k >= 0 && k < N ? [S.x[k], S.y[k], S.z[k]] : null;
      if (!cur) return null;
      const e = cur.eng, L = kind === "cluster" ? cur.cLoc : kind === "galaxy" ? cur.gLoc : kind === "system" ? cur.sLoc : null, j = L ? L[k] : -1;
      if (!(j >= 0)) return null;
      const c = kind === "cluster" ? e.clusterCentre(j) : kind === "galaxy" ? e.galaxyCentre(j) : e.systemCentre(j);
      c[2] *= S.zScale;
      return c;
    },
    radiusOf(kind, k) {
      if (kind === "body") return radius[k] || 0;
      if (!cur) return 0;
      const e = cur.eng;
      if (kind === "cluster") return cur.cLoc[k] >= 0 ? e.clRadius[cur.cLoc[k]] : 0;
      if (kind === "galaxy") return cur.gLoc[k] >= 0 ? e.galRadius[cur.gLoc[k]] : 0;
      return kind === "system" && cur.sLoc[k] >= 0 ? e.sysRadius[cur.sLoc[k]] : 0;
    },
    flyTarget(kind, k) {
      const c = U.centerOf(kind, k);
      if (!c) return null;
      const [w, h] = safeBox();
      const scale = kind === "body" ? Math.max(S.camera.scale, T[1] * 1.15) : 0.88 * Math.min(w, h) / (2 * Math.max(U.radiusOf(kind, k), 1));
      return {x: c[0], y: c[1], z: c[2] || 0, scale};
    },
    // 3D helpers (global indices): z of galaxy k's disc plane at (x, y); system y's orbital-plane slope [dz/dx, dz/dy]
    planeZ(k, x, y) { const j = cur ? cur.gLoc[k] : -1; return j >= 0 ? cur.eng.zPlane(j, x, y) * S.zScale : 0; },
    systemTilt(y) { const j = cur ? cur.sLoc[y] : -1, t = j >= 0 ? cur.eng.systemTilt(j) : [0, 0]; return [t[0] * S.zScale, t[1] * S.zScale]; },
    // 2D / 3D view: every z (bodies, centres, planes, tilts) x k in 0..1 (render.js tweens it); S.z rewritten at once
    setZScale(k) { S.zScale = k; if (cur) { write(); MX.emit("positions"); } },
    // drag API (world coordinates). Overlaps are allowed while dragging; measured once settled.
    dragStart(i, x, y) {
      if (!cur || !(i >= 0 && i < N) || cur.li[i] < 0 || !S.nodeVisible[i]) return false;
      if (tw0 >= 0) { tw0 = -1; twK = 1; write(); }
      cur.eng.motion = motionReason() === "";
      if (!cur.eng.dragStart(cur.li[i], x, y)) return false;
      dragI = i; S.settled = false; lastNow = performance.now(); kick();
      return true;
    },
    dragMove(x, y) { if (dragI >= 0) { cur.eng.dragMove(x, y); kick(); } },
    dragEnd() {
      if (dragI < 0) return;
      dragI = -1;
      cur.eng.motion = motionReason() === "";
      cur.eng.dragEnd();
      if (cur.eng.settled) { write(); settle(); } else kick();
    },
    get dragging() { return dragI; },
    lifted() { const k = cur ? cur.eng.lifted() : -1; return k >= 0 ? cur.gi[k] : -1; },
    overlaps: () => (cur ? cur.eng.overlaps(-1, cur.vis).count : 0),
    meanNN: () => (cur ? cur.eng.meanNN(cur.vis) : 0),
    status() {
      const v = S.nodeVisible, cs = new Uint8Array(CL.length), gs = new Uint8Array(nGal), ss = new Uint8Array(nSys), rc = [0, 0, 0];
      for (let i = 0; i < N; i++) if (v[i]) { rc[role[i]]++; cs[g.group[i]] = 1; gs[galOf[i]] = 1; if (sysOf[i] >= 0) ss[sysOf[i]] = 1; }
      const sum = a => a.reduce((x, y) => x + y, 0), su = S.universe || {}, reason = motionReason(), nm = (arr, k) => (k >= 0 && arr[k] ? arr[k].name : null);
      return {v: 1, band: U.band == null ? null : "U" + U.band, level: su.level || "universe",
        cursor: {cluster: nm(clusters, su.cluster), galaxy: nm(galaxies, su.galaxy), system: nm(systems, su.system)},
        clusters: sum(cs), galaxies: sum(gs), systems: sum(ss), suns: rc[0], planets: rc[1], dust: rc[2],
        overlaps: meas.overlaps, meanNN: meas.meanNN, spacing: sp, sp, t: Math.round(t * 1000) / 1000, settled: !!S.settled,
        repacks, buildMs: cur ? Math.round(cur.eng.buildMs * 10) / 10 : 0,
        motion: {running: !!U.animate && reason === "", reason, frames}, glow: !!U.glow};
    },
  };
  (MX.statusExt || (MX.statusExt = {})).universe = () => U.status();
  MX.module("universe", () => { MX.on("visibility", onVisibility); });

  // ======== self-tests (universe.*) =========================================================================
  const fail = m => { throw new Error(m); };
  // data not in this graph -> "n/a" (MX.selftest.skip, layout.js): empty graph, small graphs (< SMALLT visible bodies:
  // the rotation / spacing / re-pack statistics need a crowd)
  const sk = m => (MX.selftest.skip ? MX.selftest.skip(m) : fail("n/a: " + m)), SMALLT = 500;
  const need = () => { if (!cur) sk("universe not started (empty graph)"); };
  const smallG = () => { let n = 0; for (let i = 0; i < N; i++) n += S.nodeVisible[i] ? 1 : 0; return n < SMALLT; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function settled(ms) { const t1 = performance.now() + (ms || 2000); while (!S.settled && performance.now() < t1) await wait(20); if (!S.settled) fail("not settled"); }
  const allOn = () => new Uint8Array(N).fill(1);

  MX.selftest.add("universe.parents", async () => {
    if (!PU) fail("payload.universe missing");
    need(); await settled();
    if (CL.join() !== (D.groups || []).join() || (!(PU && PU.link) && CL.length !== 4)) fail("clusters != payload.groups");
    for (let k = 1; k < nGal; k++) { const a = galaxies[k - 1], b = galaxies[k]; if (!(a.cluster < b.cluster || (a.cluster === b.cluster && a.type < b.type))) fail("galaxy order at " + k); }
    for (let i = 0; i < N; i++) {
      if (U.systemOf(i) !== PU.sys[i]) fail("system of " + g.id[i]);
      if (U.clusterOf(i) !== galaxies[galOf[i]].cluster || galaxies[galOf[i]].type !== D.types[g.type[i]]) fail("galaxy of " + g.id[i]);
      if ((PU.sys[i] >= 0 && PU.sun[PU.sys[i]] === i) !== (role[i] === 0)) fail("role of " + g.id[i]);
    }
    for (let s = 0; s < nSys; s++) {
      const sun = sunOf[s];
      if (sysOf[sun] !== s || members[memStart[s]] !== sun) fail("sun of system " + s);
      for (let q = memStart[s] + 1; q < memStart[s + 1]; q++) {
        const i = members[q];
        if (galOf[i] !== galOf[sun]) fail("system " + s + " spans galaxies");
        if (g.deg[i] > g.deg[sun]) fail("planet out-ranks its sun in system " + s);
      }
    }
    const lift = U.lifted(), d = (p, c) => Math.hypot(p[0] - c[0], p[1] - c[1]), eps = 1e-2;
    for (let i = 0; i < N; i++) {                       // geometric containment = the same parents
      if (!S.nodeVisible[i] || i === lift) continue;
      const p = [S.x[i], S.y[i]], s = sysOf[i];
      if (role[i] === 1 && d(p, U.centerOf("system", s)) > U.radiusOf("system", s) + eps) fail("planet " + g.id[i] + " outside its system");
      if (role[i] === 2 && d(p, U.centerOf("galaxy", galOf[i])) > U.radiusOf("galaxy", galOf[i]) + eps) fail("dust " + g.id[i] + " outside its galaxy");
    }
    for (let s = 0; s < nSys; s++) if (cur.sLoc[s] >= 0 && d(U.centerOf("system", s), U.centerOf("galaxy", galOf[sunOf[s]])) > U.radiusOf("galaxy", galOf[sunOf[s]]) + eps) fail("system " + s + " outside its galaxy");
    for (let k = 0; k < nGal; k++) if (cur.gLoc[k] >= 0 && d(U.centerOf("galaxy", k), U.centerOf("cluster", galaxies[k].cluster)) > U.radiusOf("cluster", galaxies[k].cluster) + eps) fail("galaxy " + galaxies[k].name + " outside its cluster");
  });

  MX.selftest.add("universe.noOverlap", async () => {
    need(); await settled();
    if (U.overlaps()) fail("page overlaps " + U.overlaps());
    const e = cur.eng, t0 = e.t;
    try { for (const dt of [60, 600, 3600]) { e.setTime(t0 + dt); const c = e.overlaps(-1, cur.vis).count; if (c) fail(c + " overlaps at t+" + dt + " s"); } } finally { e.setTime(t0); }
    for (const s of [0.5, 3]) { const p = instance(allOn(), s, true), c = p.eng.overlaps(-1, p.vis).count; if (c) fail(c + " overlaps, all bodies, sp " + s); }
  });

  MX.selftest.add("universe.rotation", () => {
    need();
    if (smallG()) sk("small graph: rotation statistics need >= " + SMALLT + " bodies");
    const e = cur.eng, rc = e.rotationCurve(e.refGalaxy, 20);
    let vmax = 0, vmin = Infinity;
    for (const p of rc.points) { vmax = Math.max(vmax, p.v); if (p.r >= 0.5 * rc.Rg) vmin = Math.min(vmin, p.v); }
    if (!(vmin / vmax >= 0.8)) fail("rotation curve not flat: " + (vmin / vmax).toFixed(3));
  });

  MX.selftest.add("universe.spacing", async () => {
    need(); await settled();
    if (smallG()) sk("small graph: spacing statistics need >= " + SMALLT + " bodies");
    const F = S.facets;
    if (F && F.sp != null && F.sp !== sp) fail("spacing " + sp + " != facet sp " + F.sp);
    const a = instance(packed, 1, true), b = instance(packed, 2, true), r = b.eng.meanNN(b.vis) / a.eng.meanNN(a.vis);
    if (!(r >= 1.4)) fail("meanNN sp2/sp1 = " + r.toFixed(3) + " < 1.4");  // ideal 2; packing + data shape lower it
    for (let k = 0; k < a.n; k++) if (a.eng.rho[k] !== b.eng.rho[k]) fail("body radius changed with sp");
    for (const s of [0.5, 3]) { const p = instance(packed, s, true), c = p.eng.overlaps(-1, p.vis).count; if (c) fail(c + " overlaps at sp " + s); }
  });

  MX.selftest.add("universe.repack", async () => {
    need(); await settled();
    if (smallG()) sk("small graph: re-pack statistics need >= " + SMALLT + " bodies");
    // pack-visible: a one-galaxy mask uses the freed space (smaller universe) and contains no hidden body but its suns
    const G0 = galOf[members[0] != null ? members[0] : 0], m = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = packed[i] && galOf[i] === G0 ? 1 : 0;
    const p = instance(m, sp, true), ext = q => { let r = 0; const P = q.eng.positions; for (let k = 0; k < q.n; k++) r = Math.max(r, Math.hypot(P[2 * k], P[2 * k + 1])); return r; };
    if (!p) fail("empty one-galaxy pack");
    for (let k = 0; k < p.n; k++) { const i = p.gi[k]; if (!m[i] && role[i] !== 0) fail("hidden non-sun packed: " + g.id[i]); }
    if (p.eng.overlaps(-1, p.vis).count) fail("one-galaxy pack overlaps");
    if (!(ext(p) < ext(cur))) fail("filtered universe did not shrink");
    // page: same mask -> 300 ms tween back to the identical (deterministic) layout, then settled
    const x0 = S.x.slice(), y0 = S.y.slice(), r0 = repacks;
    let ev = null;
    MX.on("repack", d => { ev = d; });
    U.repack("selftest");
    if (repacks !== r0 + 1 || !ev || ev.reason !== "selftest") fail("repack event");
    if (motionReason() === "" && S.settled) fail("no tween with motion on");
    await settled(1500);
    for (let i = 0; i < N; i++) if (packed[i] && (Math.abs(S.x[i] - x0[i]) > 1e-3 || Math.abs(S.y[i] - y0[i]) > 1e-3)) fail("re-pack moved " + g.id[i]);
    const rm0 = S.reducedMotion;                         // reduced motion: instant, settled synchronously
    S.reducedMotion = true;
    try { U.repack("selftest-rm"); if (!S.settled || tw0 >= 0) fail("RM re-pack tweened"); } finally { S.reducedMotion = rm0; }
  });

  MX.selftest.add("universe.dragBounce", () => {
    need();
    const p = instance(packed, sp, true), e = p.eng, P = e.positions;
    let s = -1;
    for (let k = 0; k < e.nSystems && s < 0; k++) if (e.memStart[k + 1] - e.memStart[k] >= 4) s = k;
    if (s < 0) sk("no system with >= 3 planets");
    const base = P.slice(), mine = new Uint8Array(p.n), sun = e.members[e.memStart[s]], dt = 1 / 60;
    for (let q = e.memStart[s]; q < e.memStart[s + 1]; q++) mine[e.members[q]] = 1;
    const x0 = P[2 * sun], y0 = P[2 * sun + 1], R = e.sysRadius[s];
    const moved = k => Math.hypot(P[2 * k] - base[2 * k], P[2 * k + 1] - base[2 * k + 1]);
    e.dragStart(sun, x0, y0);
    for (let f = 1; f <= 36; f++) { e.dragMove(x0 + 0.9 * R * f / 36, y0); e.step(dt, false); }
    let other = 0, planets = 0;
    for (let k = 0; k < p.n; k++) if (mine[k]) { if (k !== sun) planets = Math.max(planets, moved(k)); } else other = Math.max(other, moved(k));
    if (!(moved(sun) > 0.05)) fail("sun did not move");
    if (!(planets > 0.05)) fail("planets did not follow");
    if (other > 1e-4) fail("other systems moved " + other);
    const d0x = P[2 * sun] - x0, d0y = P[2 * sun + 1] - y0;
    e.dragEnd();
    let steps = 0, bounce = false;
    while (!e.settled && steps < 600) { e.step(dt, false); steps++; if ((P[2 * sun] - x0) * d0x + (P[2 * sun + 1] - y0) * d0y < 0) bounce = true; }
    if (!e.settled || steps * dt > 1.5) fail("bounce did not settle in 1.5 s (" + (steps * dt).toFixed(2) + " s)");
    if (!bounce) fail("no overshoot (bounce) on release");
    for (let k = 0; k < p.n; k++) if (moved(k) > 1e-3) fail("residual displacement after settle");
    e.motion = false;                                    // reduced motion: pointer-direct, snap on release, no frames
    const pl = e.members[e.memStart[s] + 1];
    e.dragStart(pl, P[2 * pl], P[2 * pl + 1]); e.dragMove(P[2 * pl] + R, P[2 * pl + 1]); e.step(dt, false);
    if (!(moved(pl) > 0.5 * R)) fail("RM drag did not follow the pointer");
    e.dragEnd();
    if (!e.settled) fail("RM release did not snap");
    for (let k = 0; k < p.n; k++) if (moved(k) > 1e-3) fail("RM residual after snap");
  });
})();
