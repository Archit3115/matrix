(function () {
  "use strict";
  // MX.labels: hierarchical label level of detail, placement on a screen grid, draw on the 2D overlay (all renderers,
  // 2D and 3D: render.js hands screen-space proxies). cand = {id, kind 0 cluster|1 galaxy|2 sun|3 planet|4 dust, x, y,
  // r (world), text, sub?, pri (deg), force? (neighbour / hit / path: bright, always offered), must? (the selection),
  // tip? (hover: full name + type on a hairline plate), dim? (a selection is active and this is not part of it), type?}
  // cam = {scale, panX, panY}; screen = pan + (W/2, H/2) + world * scale (render.js convention).
  // Bands (render.js decides who is offered): U0 clusters (NAME + count line), U1 galaxies ("type · count"), U2 the sun
  // of each system only, U3+ suns + the planets of systems >= 120 px on screen; dust only hovered / selected.
  // Safety net under the bands: junk names never drawn (punctuation / separators only, bare numbers, < 2 visible
  // characters); markdown leads ("- ", "* ", "# ") trimmed; names > MAXCH get a middle ellipsis (the hover tip shows the
  // full name); unforced body labels <= budget = min(CAP, view area / AREA), forced <= FCAP; claim ids (XX-NN-123) rank
  // below named bodies; padded boxes (PAD px a side) never overlap each other or a labelled body's disc; a body label
  // tries 8 spots (above, right, left, below, diagonals) before it is dropped. Selection: dimmed labels at DIM alpha.
  // Labels fade over FADE ms when the selection / hover changes (opts.fade); instant otherwise and under reduced motion.
  // Type (hairline): the chrome's --font family (mono), re-read on theme / chrome; clusters 11.5 px caps tracked .06em,
  // galaxies / suns 11.5 px --label-ink, planets / dust 10.5 px --muted, the selection 12 px / 500; every label a 3 px
  // round-join halo in the page colour (--label-halo), no plate except the hover tip, no colour glow.
  const CELL = 100, MAXCH = 28, TIPCH = 64, HALO = 3, PAD = 3, AREA = 52000, CAP = 36, FCAP = 44, DIM = 0.25, FADE = 150;
  const FONT0 = 'Consolas, "Cascadia Mono", "SF Mono", Menlo, "DejaVu Sans Mono", monospace';
  // style per kind: [weight, px, letter-spacing px, line height, sub px, sub offset, gap to rim]
  const ST = {cl: ["400", 11.5, 0.7, 15, 11, 16, 20], gal: ["400", 11.5, 0, 14, 11, 13, 8], sun: ["400", 11.5, 0, 14, 10.5, 13, 4],
    body: ["400", 10.5, 0, 13, 10, 12, 4], sel: ["500", 12, 0, 15, 10.5, 14, 5], tip: ["500", 11.5, 0, 15, 10.5, 14, 8]};
  const mc = document.createElement("canvas").getContext("2d"), wc = new Map(), FA = new Map();   // FA: id -> fade state
  let cache = null, ghosts = [], fam = "";

  const readFam = () => { fam = (getComputedStyle(document.documentElement).getPropertyValue("--font") || "").trim() || FONT0; };
  // label text: markdown lead trimmed; junk -> ""
  function clean(t) {
    const s = String(t == null ? "" : t).replace(/^\s*(?:[-*#>+]+\s+)+/, "").trim();
    if (s.replace(/\s/g, "").length < 2 || /^[\p{P}\p{S}\s]+$/u.test(s) || /^[-+]?[\d.,:%\s]+$/.test(s)) return "";
    return s;
  }
  const ell = (s, n) => (s.length > n ? s.slice(0, Math.ceil((n - 1) / 2)) + "…" + s.slice(s.length - Math.floor((n - 1) / 2)) : s);
  const CLAIM = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+$/;
  const fontOf = (w, px) => w + " " + px + "px " + fam;
  function width(t, f, ls) {
    const k = f + "|" + ls + "|" + t;
    let w = wc.get(k);
    if (w === undefined) {
      mc.font = f; mc.letterSpacing = ls + "px";
      w = mc.measureText(t).width; wc.size > 5000 && wc.clear(); wc.set(k, w);
    }
    return w;
  }
  const rank = c => (c.tip ? -1 : c.must ? 0 : c.force ? 1 : 2 + c.kind + (c.claim ? 0.5 : 0)) * 1e9 - c.pri;
  // is the candidate in this band's set? forced ones always are
  function allowed(c, band, s) {
    if (c.force || c.must || c.tip) return true;
    switch (c.kind) {
      case 0: return band === 0;
      case 1: return band === 1 && c.r * s >= 24;
      case 2: return band >= 2;
      case 3: return band >= 3;
      default: return false;
    }
  }
  const budget = (W, H) => Math.min(CAP, Math.max(4, Math.floor(W * H / AREA)));

  // opts: {fade, now}
  function place(cam, band, cands, view, opts) {
    if (!fam) readFam();
    const W = view.W, H = view.H, s = cam.scale, now = opts && opts.now != null ? opts.now : performance.now();
    const sig = band + "|" + s + "|" + W + "|" + H + "|" + fam + "|" + cands.length + "|" +
      cands.reduce((a, c) => (c.force || c.must || c.tip) ? a + c.id + "," : a, "");
    if (cache && cache.sig === sig && cache.cands === cands &&
        Math.abs(cam.panX - cache.px) < W / 2 && Math.abs(cam.panY - cache.py) < H / 2) {
      cache.dx = cam.panX - cache.px; cache.dy = cam.panY - cache.py;
      return cache.boxes;                         // panning: reuse, translate in draw
    }
    const cols = Math.max(1, Math.ceil(W / CELL)), rows = Math.max(1, Math.ceil(H / CELL));
    const occ = new Array(cols * rows), boxes = [];
    const cc = v => Math.max(0, Math.min(cols - 1, Math.floor(v / CELL)));
    const cr = v => Math.max(0, Math.min(rows - 1, Math.floor(v / CELL)));
    const free = (x, y, w, h) => {                // padded: PAD px a side on both boxes
      x -= PAD; y -= PAD; w += 2 * PAD; h += 2 * PAD;
      for (let r = cr(y); r <= cr(y + h); r++) for (let c = cc(x); c <= cc(x + w); c++) {
        const l = occ[r * cols + c];
        if (l) for (const b of l) if (x < b.x + b.w && b.x < x + w && y < b.y + b.h && b.y < y + h) return false;
      }
      return true;
    };
    const take = (x, y, w, h, pad) => {
      const b = {x: x - pad, y: y - pad, w: w + 2 * pad, h: h + 2 * pad};
      for (let r = cr(b.y); r <= cr(b.y + b.h); r++) for (let k = cc(b.x); k <= cc(b.x + b.w); k++)
        (occ[r * cols + k] || (occ[r * cols + k] = [])).push(b);
    };
    const ox = cam.panX + W / 2, oy = cam.panY + H / 2, cap = budget(W, H);
    const list = [];
    for (const c of cands) {
      if (!allowed(c, band, s)) continue;
      const t = c.kind < 2 ? String(c.text) : clean(c.text);
      if (!t && !c.tip && !c.must) continue;      // junk: never labelled (the selection keeps its raw name)
      list.push(Object.assign({}, c, {t: t || String(c.text), claim: c.kind >= 2 && CLAIM.test(t)}));
    }
    list.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
    let nFree = 0, nForced = 0;
    for (const c of list) {
      const sx = ox + c.x * s, sy = oy + c.y * s, r = Math.max(2, c.r * s), body = c.kind >= 2, forced = c.force || c.must || c.tip;
      if (sx < -200 || sx > W + 200 || sy < -50 - r || sy > H + 50 + r) continue;
      if (body && !forced && nFree >= cap) continue;
      if (body && c.force && !c.must && !c.tip && nForced >= FCAP) continue;
      const st = c.tip ? ST.tip : c.must ? ST.sel : c.kind === 0 ? ST.cl : c.kind === 1 ? ST.gal : c.kind === 2 || c.force ? ST.sun : ST.body;
      const f = fontOf(st[0], st[1]), fs = fontOf("400", st[4]);
      const t = c.kind === 0 ? c.t.toUpperCase() : c.tip ? ell(c.t, TIPCH) : body ? ell(c.t, MAXCH) : ell(c.t, 34);
      const sub = c.tip ? (c.type ? String(c.type) : "") : c.sub ? ell(String(c.sub), 40) : "";
      const w = Math.max(width(t, f, st[2]), sub ? width(sub, fs, 0) : 0) + 2 * HALO + (c.tip ? 12 : 0);
      const h = (sub ? st[5] + st[4] + 2 : st[3]) + (c.tip ? 8 : 0), gap = st[6];
      let spots;
      if (!body) {   // clusters / galaxies slide into the view; cluster below the rim, else above; galaxy above, else below
        const x = Math.max(0, Math.min(W - w, sx - w / 2));
        const ys = c.kind === 0 ? [sy + r + gap, sy - r - gap - h, Math.max(0, Math.min(H - h, sy + r + gap)), Math.max(0, Math.min(H - h, sy - r - gap - h))]
          : [sy - r - gap - h, sy + r + gap];
        spots = ys.map(y => [x, y]);
      } else {       // 8 spots around the disc: above, right, left, below, then the diagonals
        const d = r * 0.71 + gap;
        spots = [[sx - w / 2, sy - r - gap - h], [sx + r + gap, sy - h / 2], [sx - r - gap - w, sy - h / 2], [sx - w / 2, sy + r + gap],
          [sx + d, sy - d - h], [sx - d - w, sy - d - h], [sx + d, sy + d], [sx - d - w, sy + d]];
      }
      const inV = p => p[0] >= 0 && p[0] + w <= W && p[1] >= 0 && p[1] + h <= H;
      let p = spots.find(q => inV(q) && free(q[0], q[1], w, h));
      if (!p) { if (!c.must && !c.tip) continue; p = spots[0]; }
      const ink = c.kind === 1 && band > 1 ? 1 : body && !forced && c.kind > 2 ? 2 : 0;
      const b = {id: c.id, x: p[0], y: p[1], w, h, t, sub, f, fs, ls: st[2], lh: st[5], ink, a: c.dim && !forced ? DIM : 1, tip: !!c.tip};
      boxes.push(b);
      take(b.x, b.y, w, h, PAD);
      if (body) take(sx - r, sy - r, 2 * r, 2 * r, 0);   // its disc: no other label covers a labelled body
      if (body && !forced) nFree++; else if (body && !c.must && !c.tip) nForced++;
    }
    // fades: new / changed labels tween from their current alpha; vanished ones linger as ghosts (opts.fade only)
    const fade = !!(opts && opts.fade), ids = new Set(boxes.map(b => b.id)), prev = cache ? cache.boxes : [];
    ghosts = fade ? ghosts.filter(g => alphaOf(g, now) > 0.01 && !ids.has(g.id)) : [];
    if (fade) for (const b of prev) if (!ids.has(b.id)) {
      const a = alphaOf(b, now), gh = Object.assign({}, b, {x: b.x + cache.dx, y: b.y + cache.dy, ghost: true});
      FA.set("~" + b.id, {from: a, to: 0, t0: now}); gh.fk = "~" + b.id; ghosts.push(gh);
    }
    for (const b of boxes) {
      const old = FA.get(b.id), a0 = old && prev.some(q => q.id === b.id) ? alphaOf(b, now) : 0;
      FA.set(b.id, fade ? {from: a0, to: b.a, t0: now} : {from: b.a, to: b.a, t0: 0});
    }
    if (FA.size > 4000) { const keep = new Set(boxes.map(b => b.id).concat(ghosts.map(g => g.fk))); for (const k of FA.keys()) if (!keep.has(k)) FA.delete(k); }
    cache = {sig, cands, boxes, px: cam.panX, py: cam.panY, dx: 0, dy: 0, nFree, nForced, cap};
    return boxes;
  }
  function alphaOf(b, now) {
    const q = FA.get(b.fk || b.id);
    if (!q) return b.a == null ? 1 : b.a;
    const k = Math.max(0, Math.min(1, (now - q.t0) / FADE));
    return q.from + (q.to - q.from) * k;
  }

  // -> true while a fade is still running (render.js keeps frames coming)
  function draw(ctx, now) {
    if (!cache) return false;
    now = now == null ? performance.now() : now;
    const C = MX.state.theme.colors, dx = cache.dx, dy = cache.dy, inks = [C.labelInk, C.labelInk2, C.muted || C.labelInk2];
    let busy = false;
    ctx.save();
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.shadowBlur = 0; ctx.setLineDash([]);
    ctx.lineJoin = "round";
    let cf = "", cl = -1;
    const font = (f, ls) => { if (f !== cf) { ctx.font = cf = f; } if (ls !== cl) { ctx.letterSpacing = (cl = ls) + "px"; } };
    const all = ghosts.concat(cache.boxes).sort((a, b) => (a.tip ? 1 : 0) - (b.tip ? 1 : 0) || (a.a || 1) - (b.a || 1));
    for (const b of all) {
      const a = alphaOf(b, now), q = FA.get(b.fk || b.id);
      if (q && now - q.t0 < FADE) busy = true;
      if (a <= 0.01) continue;
      const g = b.ghost ? 0 : 1, x = b.x + dx * g + b.w / 2, y = b.y + dy * g + (b.tip ? 5 : 1);
      ctx.globalAlpha = a;
      if (b.tip) {   // hover: hairline plate
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(b.x + dx + 0.5, b.y + dy + 0.5, b.w - 1, b.h - 1, 6) : ctx.rect(b.x + dx + 0.5, b.y + dy + 0.5, b.w - 1, b.h - 1);
        ctx.fillStyle = C.labelHalo; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = C.muted || C.labelInk2; ctx.globalAlpha = a * 0.6; ctx.stroke(); ctx.globalAlpha = a;
      }
      ctx.lineWidth = HALO; ctx.strokeStyle = C.labelHalo;
      font(b.f, b.ls);
      if (!b.tip) ctx.strokeText(b.t, x, y);
      ctx.fillStyle = inks[b.ink || 0]; ctx.fillText(b.t, x, y);
      if (!b.sub) continue;
      font(b.fs, 0);
      if (!b.tip) ctx.strokeText(b.sub, x, y + b.lh);
      ctx.fillStyle = C.labelInk2; ctx.fillText(b.sub, x, y + b.lh);
    }
    ctx.restore();
    if (!busy) ghosts = [];
    return busy;
  }

  MX.labels = {place, draw, clean, budget, invalidate() { cache = null; }, get boxes() { return cache ? cache.boxes : []; },
    get stats() { return cache ? {free: cache.nFree, forced: cache.nForced, budget: cache.cap, shown: cache.boxes.length} : null; }};

  MX.module("labels", () => {
    const reset = () => { wc.clear(); cache = null; fam = ""; };
    MX.on && MX.on("theme", reset);
    MX.on && MX.on("chrome", reset);
    const synth = () => {
      const a = [];
      for (let c = 0; c < 4; c++) a.push({id: "c" + c, kind: 0, x: c * 3000, y: 0, r: 900, text: "Cluster " + c, sub: "100 bodies · 5 galaxies", pri: 1e6});
      for (let g = 0; g < 8; g++) a.push({id: "g" + g, kind: 1, x: g * 1500, y: 300, r: 700, text: "galaxy " + g, pri: 1e5});
      for (let i = 0; i < 400; i++) a.push({id: "s" + i, kind: 2, x: (i * 37) % 4000, y: (i * 91) % 900, r: 10, text: "sun " + i, pri: 400 - i});
      for (let i = 0; i < 400; i++) a.push({id: "p" + i, kind: 3, x: (i * 53) % 4000, y: (i * 29) % 900, r: 3, text: "planet " + i, pri: i});
      for (let i = 0; i < 400; i++) a.push({id: "d" + i, kind: 4, x: (i * 71) % 4000, y: (i * 17) % 900, r: 1, text: "dust " + i, pri: i});
      return a;
    };
    const run = (band, s, extra) => { MX.labels.invalidate(); return place({scale: s, panX: -2000 * s, panY: -300 * s}, band, synth().concat(extra || []), {W: 1200, H: 800}); };
    const kinds = b => new Set(b.map(x => x.id[0]));
    const overlap = b => {
      for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
        const u = b[i], v = b[j];
        if (u.x < v.x + v.w && v.x < u.x + u.w && u.y < v.y + v.h && v.y < u.y + u.h) return u.id + " / " + v.id;
      }
      return "";
    };
    MX.selftest && MX.selftest.add("labels.bands", () => {
      const k0 = kinds(run(0, 0.1)), k1 = kinds(run(1, 0.05)), k2 = kinds(run(2, 0.3));
      MX.labels.invalidate();
      const k4 = kinds(place({scale: 2, panX: -4000, panY: -600}, 4, synth().filter(c => c.kind >= 3), {W: 1200, H: 800}));   // suns would fill the budget
      if (k0.size !== 1 || !k0.has("c")) throw new Error("U0 not clusters only: " + [...k0]);
      if (k2.size !== 1 || !k2.has("s")) throw new Error("U2 wants suns only: " + [...k2]);
      if (!k1.has("g") || k1.has("c")) throw new Error("U1 wants galaxy labels and no cluster labels: " + [...k1]);
      if (!k4.has("p") || k4.has("d")) throw new Error("U4 wants planets, never unforced dust: " + [...k4]);
    });
    MX.selftest && MX.selftest.add("labels.rim", () => {  // U0 cluster 20 px below its rim; U1 galaxy 8 px above
      const s0 = 0.1, b0 = run(0, s0).find(b => b.id === "c0"), sy0 = -300 * s0 + 400;
      if (!b0 || Math.abs(b0.y - (sy0 + 900 * s0 + ST.cl[6])) > 0.01) throw new Error("U0 cluster label not 20 px below the rim: " + (b0 && b0.y));
      if (!b0.sub || b0.t !== "CLUSTER 0") throw new Error("U0 cluster label wants NAME + count line");
      const s1 = 0.05, b1 = run(1, s1).find(b => b.id === "g0"), sy1 = (300 - 300) * s1 + 400;
      if (!b1 || Math.abs(b1.y + b1.h - (sy1 - 700 * s1 - ST.gal[6])) > 0.01) throw new Error("U1 galaxy label not 8 px above the rim: " + (b1 && b1.y));
    });
    MX.selftest && MX.selftest.add("labels.noOverlap", () => {
      for (const [bd, s] of [[0, 0.1], [2, 0.3], [3, 1], [4, 2]]) { const o = overlap(run(bd, s)); if (o) throw new Error("overlap U" + bd + " " + o); }
    });
    // safety net (synthetic): junk never labelled, markdown lead trimmed, middle ellipsis, budget, forced neighbours kept
    MX.selftest && MX.selftest.add("labels.junk", () => {
      for (const j of ["==========", "----", "200", "16", "1.5", "x", " - ", "# ", "**"]) if (clean(j)) throw new Error("junk kept: '" + j + "'");
      if (clean("- APP_ETL_Sales_Facts") !== "APP_ETL_Sales_Facts" || clean("# Notes") !== "Notes") throw new Error("markdown lead not trimmed");
      const junk = [];
      for (let i = 0; i < 30; i++) junk.push({id: "j" + i, kind: 2, x: 1000 + i * 90, y: 450, r: 10, text: ["====", "200", "-", "16"][i & 3], pri: 1e9});
      const b = run(3, 1, junk.concat([{id: "L", kind: 2, x: 2000, y: 200, r: 10, text: "a_really_long_pipeline_name_that_goes_on_and_on", pri: 1e9}]));
      if (b.some(x => x.id[0] === "j")) throw new Error("junk label drawn");
      const L = b.find(x => x.id === "L");
      if (!L || L.t.length !== MAXCH || L.t.indexOf("…") < 0) throw new Error("long name not middle-ellipsised: " + (L && L.t));
      const free = b.filter(x => /^[spd]/.test(x.id)).length;
      if (free > budget(1200, 800)) throw new Error("free body labels " + free + " > budget " + budget(1200, 800));
      const nb = [];
      for (let i = 0; i < 12; i++) nb.push({id: "n" + i, kind: 3, x: 1400 + (i % 4) * 300, y: 300 + Math.floor(i / 4) * 200, r: 3, text: "nb " + i, pri: 1, force: true});
      const b2 = run(3, 1, nb);
      if (b2.filter(x => x.id[0] === "n").length !== 12) throw new Error("forced neighbours dropped");
      const o = overlap(b2);
      if (o) throw new Error("overlap " + o);
    });
  });
})();
