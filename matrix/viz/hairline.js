(function () {
  "use strict";
  // hairline.js: hairline's figure kernel (inlined verbatim below, MIT) + the Matrix 'galaxy' (header mark,
  // inspector empty state) and 'nexus' (loading card) figures, a mount shim modelled on
  // hairline-create/bench.html, and the page wiring (MX.hl).
  // Figures are monochrome by rule (the hairline grammar): they read only --hairline-* tokens (app.css).
  /*
   * hairline kernel: github.com/lucasmarkes/hairline, skills/hairline-create/kernel.js
   *
   * MIT License
   *
   * Copyright (c) 2026 Lucas Marques
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   */
/* hairline kernel sha256:346b48bdef2cdfafd5343eba01494255cf75f9c078e6fcd1aafc62bab62980a1 */
/*
 * HL: everything a figure may call. Read this index; the code under it is the
 * package's src/core, unchanged, and a figure should not need to read it.
 *
 * Every figure is drawn in a 400 × 320 viewBox. World space is x/y on the
 * ground and z up. Plates are filled with the ground colour and painted back
 * to front, so a nearer one covers a farther one: append in that order. At
 * the default camera, Cam(45, 0.5, S), +x runs down to the right and +y down
 * to the left, so the corner with the largest x and y is nearest the viewer:
 * append by ascending x + y, from the far corner (smallest x and y) to it.
 *
 * Camera
 *   Cam(azDeg, k, S)                       a camera: azimuth in degrees, k = sin(elevation) (0.5 is the 2:1 view), S = scale
 *   fit(C, points, cx, cy)                 centres the box of [x, y, z] points on (cx, cy); call it once, before proj
 *                                          it only centres, it never scales: choose S by trying values, with the most extreme pose in points.
 *                                          The six figures use S 1.42 to 2.12; the boxes they fit come out 230 to 310 wide and 180 to 245 tall
 *   proj(C)                                returns P(x, y, z), which gives [sx, sy]
 *   unproj(C, sx, sy, z)                   the world [x, y] under a screen point, on the plane at height z
 *   facing(C)                              returns front(sample): whether a ring sample faces the camera
 * Rounded solids
 *   rrect(u0, v0, u1, v1, r, n)            a rounded rectangle, as a ring of samples {u, v, nu, nv}
 *   circ(R, n)                             a circle, as a ring
 *   rings(x0, y0, x1, y1, r, b)            [ring, inner]: a rounded footprint and its crease ring, inset by b
 *                                          r, the corner radius, is cut to half the shorter side. b, the crease's inset in world units
 *                                          (0.6 to 2.2 in the figures), must stay under half the shorter side or the crease turns inside out
 *   prism(P, front, ring, inner, z0, z1)   {sil, crease}: a solid standing from z0 to z1, as two path strings
 *   ringAt(P, ring, z)                     the ring's points, projected at height z
 *   run(ring, keep)                        the one cyclic run of samples that pass keep
 *   hull(points)                           the convex hull of screen points
 *   extremes(P, ring)                      [left, right, nearest] samples: where dashed drops fall from
 *   fillet(points, radii, n)               rounds every vertex of a closed polygon; returns the new points
 *                                          radii is an array, one radius per vertex, each cut to half its shorter edge; a single number gives NaN.
 *                                          n is the steps round each corner, default 4: each vertex becomes n + 1 points
 *   ghost(P, front, ring, z0, depth)       a reflection's path {d, y0, y1}; reflect() draws it for you
 * Paths and numbers
 *   poly(points)                           a closed path string
 *   open(points)                           an open polyline string
 *   seg(a, b)                              one segment between two screen points [sx, sy], as its own subpath; project world points with P first
 *   clamp(v, a, b)
 *   lerp(a, b, t)
 *   rad(deg)
 *   r2(n)                                  two decimals
 * The continuous clock: one spring per moving number
 *   spring(x, opts)                        at rest on x; write .t to retarget; opts {k, c, m, eps}, default k 100, c 18, m 1
 *   stepS(sp, dt)                          advances by dt seconds; returns whether it is still moving
 * The discrete clock: a 700ms tween on (.32, .72, 0, 1)
 *   tween(v, dur)                          at rest on v; dur defaults to 700 (ms)
 *   tset(tw, to, now, delay)               retargets from where it is, after delay ms: the stagger
 *                                          the same target again does nothing, so calling it on every pointer move is safe
 *   tval(tw, now)                          its value at now
 *   tdone(tw, now)                         whether it has landed
 *   bezier(x1, y1, x2, y2)                 a CSS cubic-bezier, as a function of progress
 *   EASE_LIFT                              the lift curve itself
 *   reducedMotion()                        true when the reader asked for less motion; springs and tweens already land at once
 *   setReducedMotion(on)                   the loop's business, not a figure's
 * Drawing
 *   mk(tag, attrs, parent)                 one svg element: the only way a figure makes a node
 *   solid(parent)                          {g, sil, cr}: a group holding a silhouette path and a crease path
 *   put(solid, paths)                      writes prism()'s {sil, crease} into solid()'s {sil, cr}: sil into sil, crease into cr
 *   flatDot(parent, C, r, cls)             a dot lying on the ground plane; cls is "dot", "dot m" or "dot off"
 *   place(el, point)                       moves a dot or a circle to [sx, sy]
 *   reflect(svg, parent, P, front, ring, z0, depth)   a fading mirror under a solid
 *   fade(svg, y0, y1, a0)                  a vertical fade, as a mask; returns the value for a mask attribute
 * Life
 *   register(stage, tick)                  joins the one frame loop; tick(dt in seconds, now in ms) returns true to ask for another frame; gives {wake, unregister}
 *   pointer(stage, handlers)               {move(point), down(point), leave()}, points in viewBox units; returns its disposer
 *   disposer()                             {add, on, dispose}: collects tear-down, so destroy is bag.dispose
 * The bench's business, not a figure's
 *   css(lightDark)
 *   inject(root)
 *   tour(stage, stops, onStop)             an unseen pointer that walks the stops, [x, y] in viewBox units or null to leave, and gives way to a real one; onStop(i) on each arrival; returns {stop}
 *   LAP                                    the default stops: a diamond around the centre, then a leave
 *
 * Classes, on path, polygon, ellipse and line. They are the whole palette; a
 * figure sets no colour, width or fill of its own.
 *     (none)   filled with the ground colour, medium stroke
 *     sil      the silhouette's stroke        hi    the bright stroke: the only highlight
 *     lo       the dim stroke                 nf    no fill        fo   fill only, no stroke
 *     dash     a dashed guide
 *     dot      a bright dot                   dot m   a medium dot     dot off   a dim dot
 */
var HL = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // packages/hairline/src/core/kernel.ts
  var kernel_exports = {};
  __export(kernel_exports, {
    Cam: () => Cam,
    EASE_LIFT: () => EASE_LIFT,
    LAP: () => LAP,
    bezier: () => bezier,
    circ: () => circ,
    clamp: () => clamp,
    css: () => css,
    disposer: () => disposer,
    extremes: () => extremes,
    facing: () => facing,
    fade: () => fade,
    fillet: () => fillet,
    fit: () => fit,
    flatDot: () => flatDot,
    ghost: () => ghost,
    hull: () => hull,
    inject: () => inject,
    lerp: () => lerp,
    mk: () => mk,
    open: () => open,
    place: () => place,
    pointer: () => pointer,
    poly: () => poly,
    prism: () => prism,
    proj: () => proj,
    put: () => put,
    r2: () => r2,
    rad: () => rad,
    reducedMotion: () => reducedMotion,
    reflect: () => reflect,
    register: () => register,
    ringAt: () => ringAt,
    rings: () => rings,
    rrect: () => rrect,
    run: () => run,
    seg: () => seg,
    setReducedMotion: () => setReducedMotion,
    solid: () => solid,
    spring: () => spring,
    stepS: () => stepS,
    tdone: () => tdone,
    tour: () => tour,
    tset: () => tset,
    tval: () => tval,
    tween: () => tween,
    unproj: () => unproj
  });

  // packages/hairline/src/core/iso.ts
  var clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  var lerp = (a, b, t) => a + (b - a) * t;
  var rad = (d) => d * Math.PI / 180;
  var r2 = (n) => Math.round(n * 100) / 100;
  var poly = (pts) => "M" + pts.map((p) => r2(p[0]) + " " + r2(p[1])).join("L") + "Z";
  var seg = (a, b) => `M${r2(a[0])} ${r2(a[1])}L${r2(b[0])} ${r2(b[1])}`;
  var open = (pts) => pts.length < 2 ? "" : "M" + pts.map((p) => r2(p[0]) + " " + r2(p[1])).join("L");
  var Cam = (azDeg, k, S) => ({ az: rad(azDeg), k, S, ox: 0, oy: 0 });
  function proj(C) {
    const c = Math.cos(C.az), s = Math.sin(C.az), zf = Math.sqrt(1 - C.k * C.k);
    return (x, y, z) => {
      const X = x * c - y * s, Y = x * s + y * c;
      return [C.ox + C.S * X, C.oy + C.S * (Y * C.k - z * zf)];
    };
  }
  function unproj(C, sx, sy, z) {
    const c = Math.cos(C.az), s = Math.sin(C.az), zf = Math.sqrt(1 - C.k * C.k);
    const X = (sx - C.ox) / C.S, Y = ((sy - C.oy) / C.S + z * zf) / C.k;
    return [X * c + Y * s, -X * s + Y * c];
  }
  function fit(C, pts, cx, cy) {
    C.ox = 0;
    C.oy = 0;
    const P = proj(C);
    let a = 1e9, b = -1e9, c = 1e9, d = -1e9;
    for (const p of pts) {
      const q = P(p[0], p[1], p[2]);
      a = Math.min(a, q[0]);
      b = Math.max(b, q[0]);
      c = Math.min(c, q[1]);
      d = Math.max(d, q[1]);
    }
    C.ox = cx - (a + b) / 2;
    C.oy = cy - (c + d) / 2;
  }
  function rrect(u0, v0, u1, v1, r, n = 4) {
    r = Math.max(0, Math.min(r, (u1 - u0) / 2, (v1 - v0) / 2));
    const out = [];
    for (const [cu, cv, a0] of [[u1 - r, v1 - r, 0], [u0 + r, v1 - r, 90], [u0 + r, v0 + r, 180], [u1 - r, v0 + r, 270]])
      for (let k = 0; k <= n; k++) {
        const a = rad(a0 + 90 * k / n), ca = Math.cos(a), sa = Math.sin(a);
        out.push({ u: cu + r * ca, v: cv + r * sa, nu: ca, nv: sa });
      }
    return out;
  }
  function circ(R, n = 96) {
    const out = [];
    for (let k = 0; k < n; k++) {
      const a = k / n * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      out.push({ u: R * ca, v: R * sa, nu: ca, nv: sa });
    }
    return out;
  }
  function hull(input) {
    const pts = input.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const x = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) {
      while (lo.length > 1 && x(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
      lo.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (up.length > 1 && x(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
      up.push(p);
    }
    lo.pop();
    up.pop();
    return lo.concat(up);
  }
  var ringAt = (P, ring, z) => ring.map((q) => P(q.u, q.v, z));
  var facing = (C) => {
    const s = Math.sin(C.az), c = Math.cos(C.az);
    return (q) => q.nu * s + q.nv * c >= -1e-6;
  };
  function run(ring, keep) {
    const n = ring.length;
    let s = -1;
    for (let i = 0; i < n; i++) if (keep(ring[i]) && !keep(ring[(i + n - 1) % n])) {
      s = i;
      break;
    }
    if (s < 0) return keep(ring[0]) ? ring.slice() : [];
    const out = [];
    for (let k = 0; k < n && keep(ring[(s + k) % n]); k++) out.push(ring[(s + k) % n]);
    return out;
  }
  function prism(P, front, ring, inner, z0, z1) {
    return {
      sil: poly(hull(ringAt(P, ring, z1).concat(ringAt(P, ring, z0)))),
      crease: inner ? open(ringAt(P, run(inner, front), z1)) : ""
    };
  }
  var rings = (x0, y0, x1, y1, r, b) => [
    rrect(x0, y0, x1, y1, r),
    rrect(x0 + b, y0 + b, x1 - b, y1 - b, Math.max(0.3, r - b))
  ];
  function extremes(P, ring) {
    const pr = ring.map((q) => P(q.u, q.v, 0));
    let a = 0, b = 0, c = 0;
    pr.forEach((p, k) => {
      if (p[0] < pr[a][0]) a = k;
      if (p[0] > pr[b][0]) b = k;
      if (p[1] > pr[c][1]) c = k;
    });
    return [ring[a], ring[b], ring[c]];
  }
  function fillet(pts, rs, n = 4) {
    const m = pts.length, out = [];
    for (let i = 0; i < m; i++) {
      const a = pts[(i + m - 1) % m], p = pts[i], b = pts[(i + 1) % m];
      const la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
      const t = Math.min(rs[i], la / 2, lb / 2);
      const p1 = [p[0] + (a[0] - p[0]) / la * t, p[1] + (a[1] - p[1]) / la * t];
      const p2 = [p[0] + (b[0] - p[0]) / lb * t, p[1] + (b[1] - p[1]) / lb * t];
      for (let k = 0; k <= n; k++) {
        const s = k / n, w = 1 - s;
        out.push([w * w * p1[0] + 2 * w * s * p[0] + s * s * p2[0], w * w * p1[1] + 2 * w * s * p[1] + s * s * p2[1]]);
      }
    }
    return out;
  }
  function ghost(P, front, ring, z0, depth) {
    const f = run(ring, front), lowP = ringAt(P, f, z0 - depth);
    return {
      d: open(lowP) + [f[0], f[f.length - 1]].map((q) => seg(P(q.u, q.v, z0), P(q.u, q.v, z0 - depth))).join(""),
      y0: Math.min(...ringAt(P, f, z0).map((p) => p[1])),
      y1: Math.max(...lowP.map((p) => p[1])) + 2
    };
  }

  // packages/hairline/src/core/motion.ts
  var reduced = false;
  var setReducedMotion = (on) => {
    reduced = on;
  };
  var reducedMotion = () => reduced;
  function spring(x, o = {}) {
    return { x, v: 0, t: x, k: o.k ?? 100, c: o.c ?? 18, m: o.m ?? 1, eps: o.eps ?? 0.01 };
  }
  function stepS(sp, dt) {
    if (reduced) {
      sp.x = sp.t;
      sp.v = 0;
      return false;
    }
    const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = (-sp.k * (sp.x - sp.t) - sp.c * sp.v) / sp.m;
      sp.v += a * h;
      sp.x += sp.v * h;
    }
    if (Math.abs(sp.x - sp.t) < sp.eps && Math.abs(sp.v) < sp.eps * 10) {
      sp.x = sp.t;
      sp.v = 0;
      return false;
    }
    return true;
  }
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = (u) => ((ax * u + bx) * u + cx) * u;
    const Y = (u) => ((ay * u + by) * u + cy) * u;
    const dX = (u) => (3 * ax * u + 2 * bx) * u + cx;
    return (t) => {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      let u = t;
      for (let i = 0; i < 8; i++) {
        const e = X(u) - t;
        if (Math.abs(e) < 1e-5) break;
        const d = dX(u);
        if (Math.abs(d) < 1e-6) break;
        u -= e / d;
      }
      if (!(u >= 0 && u <= 1) || Math.abs(X(u) - t) > 1e-4) {
        let lo = 0, hi = 1;
        u = t;
        for (let i = 0; i < 24; i++) {
          if (X(u) < t) lo = u;
          else hi = u;
          u = (lo + hi) / 2;
        }
      }
      return Y(u);
    };
  }
  var EASE_LIFT = bezier(0.32, 0.72, 0, 1);
  var tween = (v, dur = 700) => ({ from: v, to: v, t0: -1e9, dur });
  var tval = (tw, now) => {
    const p = clamp((now - tw.t0) / tw.dur, 0, 1);
    return tw.from + (tw.to - tw.from) * (reduced ? 1 : EASE_LIFT(p));
  };
  var tset = (tw, to, now, delay) => {
    if (tw.to === to) return;
    tw.from = tval(tw, now);
    tw.to = to;
    tw.t0 = now + delay;
  };
  var tdone = (tw, now) => reduced || now >= tw.t0 + tw.dur;

  // packages/hairline/src/core/stage.ts
  var NS = "http://www.w3.org/2000/svg";
  function mk(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  }
  function solid(parent) {
    const g = mk("g", {}, parent);
    return { g, sil: mk("path", { class: "sil" }, g), cr: mk("path", { class: "nf lo" }, g) };
  }
  var put = (el, s) => {
    el.sil.setAttribute("d", s.sil);
    el.cr.setAttribute("d", s.crease);
  };
  var flatDot = (parent, C, r, cls) => mk("ellipse", { rx: r2(r * C.S), ry: r2(r * C.S * C.k), class: cls }, parent);
  var place = (el, q) => {
    el.setAttribute("cx", String(r2(q[0])));
    el.setAttribute("cy", String(r2(q[1])));
  };
  var fid = 0;
  function fade(svg, y0, y1, a0 = 0.7) {
    const id = "hl-fd" + ++fid, defs = mk("defs", {}, svg);
    const lg = mk("linearGradient", { id: id + "g", gradientUnits: "userSpaceOnUse", x1: 0, y1: r2(y0), x2: 0, y2: r2(y1) }, defs);
    mk("stop", { offset: 0, "stop-color": "#fff", "stop-opacity": a0 }, lg);
    mk("stop", { offset: 1, "stop-color": "#fff", "stop-opacity": 0 }, lg);
    const m = mk("mask", { id, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 400, height: 320 }, defs);
    mk("rect", { x: 0, y: 0, width: 400, height: 320, fill: `url(#${id}g)` }, m);
    return `url(#${id})`;
  }
  function reflect(svg, parent, P, front, ring, z0, depth) {
    const r = ghost(P, front, ring, z0, depth);
    const gh = mk("g", { class: "ghost", mask: fade(svg, r.y0, r.y1) }, parent);
    mk("path", { d: r.d }, gh);
  }
  var boards = [];
  var byStage = /* @__PURE__ */ new Map();
  var raf = 0;
  var last = 0;
  var io = null;
  var rm = null;
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1e3));
    last = now;
    let any = false;
    for (const b of boards.slice()) if (b.vis && b.awake) {
      try {
        b.awake = !!b.tick(dt, now);
      } catch (err) {
        b.awake = false;
        setTimeout(() => {
          throw err;
        });
      }
      any = any || b.awake;
    }
    raf = any ? requestAnimationFrame(frame) : 0;
  }
  function wake(b) {
    b.awake = true;
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }
  var onMotion = () => {
    setReducedMotion(!!rm?.matches);
    boards.forEach(wake);
  };
  function start() {
    if (io) return;
    io = new IntersectionObserver((es) => {
      for (const e of es) {
        const set = byStage.get(e.target);
        if (!set) continue;
        for (const b of set) {
          b.vis = e.isIntersecting;
          if (b.vis) wake(b);
        }
      }
    }, { rootMargin: "80px" });
    rm = matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(rm.matches);
    rm.addEventListener("change", onMotion);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    io?.disconnect();
    io = null;
    rm?.removeEventListener("change", onMotion);
    rm = null;
  }
  function register(stage, tick) {
    start();
    const b = { stage, tick, vis: false, awake: true };
    boards.push(b);
    const peers = byStage.get(stage);
    if (peers) {
      for (const p of peers) b.vis = p.vis;
      peers.add(b);
      if (b.vis) wake(b);
    } else {
      byStage.set(stage, /* @__PURE__ */ new Set([b]));
      io.observe(stage);
    }
    tick(0, performance.now());
    let gone = false;
    return {
      wake: () => {
        if (!gone) wake(b);
      },
      unregister: () => {
        if (gone) return;
        gone = true;
        boards = boards.filter((x) => x !== b);
        const set = byStage.get(stage);
        if (set) {
          set.delete(b);
          if (!set.size) {
            byStage.delete(stage);
            io?.unobserve(stage);
          }
        }
        if (!boards.length) stop();
      }
    };
  }
  var handlers = /* @__PURE__ */ new WeakMap();
  var touring = /* @__PURE__ */ new WeakMap();
  function pointer(stage, on) {
    handlers.set(stage, on);
    let tm = 0;
    const pt = (e) => {
      const r = stage.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width * 400, (e.clientY - r.top) / r.height * 320];
    };
    const move = (e) => {
      clearTimeout(tm);
      touring.get(stage)?.hold();
      on.move(pt(e), e);
    };
    const down = (e) => {
      clearTimeout(tm);
      touring.get(stage)?.hold();
      if (e.pointerType !== "mouse") stage.releasePointerCapture?.(e.pointerId);
      if (on.down) on.down(pt(e), e);
      else on.move(pt(e), e);
    };
    const leave = (e) => {
      clearTimeout(tm);
      tm = window.setTimeout(() => {
        on.leave(e);
        touring.get(stage)?.release();
      }, e.pointerType === "mouse" ? 0 : 1400);
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerdown", down);
    stage.addEventListener("pointerleave", leave);
    return () => {
      clearTimeout(tm);
      if (handlers.get(stage) === on) handlers.delete(stage);
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerdown", down);
      stage.removeEventListener("pointerleave", leave);
    };
  }
  var LAP = [[128, 150], [200, 118], [272, 150], [200, 206], null];
  var TRAVEL = 900;
  var DWELL = 1200;
  var REST = 1800;
  var RESUME = 1200;
  var STAGGER = 450;
  var GHOST = { pointerType: "ghost" };
  var started = 0;
  function entry([x, y]) {
    const dx = x - 200, dy = y - 160;
    if (!dx && !dy) return [200, 320];
    const k = Math.min(dx ? (dx > 0 ? 200 : -200) / dx : Infinity, dy ? (dy > 0 ? 160 : -160) / dy : Infinity);
    return [200 + dx * k, 160 + dy * k];
  }
  function tour(stage, stops, onStop) {
    let i = 0;
    let wait = RESUME + STAGGER * (started++ % 4);
    let t = -1;
    let at = null;
    let origin = [200, 320];
    let hand = false, keys = stage.contains(stage.ownerDocument.activeElement);
    let gone = false;
    const leave = () => {
      at = null;
      t = -1;
      handlers.get(stage)?.leave(GHOST);
    };
    const tick = (dt) => {
      if (hand || keys || !stops.length) return false;
      if (reducedMotion()) {
        if (at) leave();
        return false;
      }
      if (wait > 0) {
        wait -= dt * 1e3;
        return true;
      }
      const stop2 = stops[i];
      if (stop2 === null) {
        if (at) leave();
        onStop?.(i);
        i = (i + 1) % stops.length;
        wait = REST;
        return true;
      }
      const h = handlers.get(stage);
      if (!h) return true;
      if (t < 0) {
        origin = at ?? entry(stop2);
        t = 0;
      }
      t = Math.min(TRAVEL, t + dt * 1e3);
      const k = EASE_LIFT(t / TRAVEL);
      at = [origin[0] + (stop2[0] - origin[0]) * k, origin[1] + (stop2[1] - origin[1]) * k];
      h.move(at, GHOST);
      if (t < TRAVEL) return true;
      onStop?.(i);
      i = (i + 1) % stops.length;
      t = -1;
      wait = DWELL;
      return true;
    };
    const take = () => {
      at = null;
      t = -1;
    };
    const give = () => {
      if (hand || keys) return;
      i = 0;
      t = -1;
      wait = RESUME;
      board.wake();
    };
    const me = {
      hold: () => {
        hand = true;
        take();
      },
      release: () => {
        if (!hand) return;
        hand = false;
        give();
      }
    };
    const focusIn = () => {
      keys = true;
      take();
    };
    const focusOut = (e) => {
      if (keys && !stage.contains(e.relatedTarget)) {
        keys = false;
        give();
      }
    };
    stage.addEventListener("focusin", focusIn);
    stage.addEventListener("focusout", focusOut);
    touring.set(stage, me);
    const board = register(stage, tick);
    return {
      stop: () => {
        if (gone) return;
        gone = true;
        board.unregister();
        stage.removeEventListener("focusin", focusIn);
        stage.removeEventListener("focusout", focusOut);
        if (touring.get(stage) === me) touring.delete(stage);
        if (at) leave();
      }
    };
  }
  function disposer() {
    let fns = [];
    return {
      add: (fn) => {
        fns.push(fn);
      },
      on: (target, type, fn, opts) => {
        const h = fn;
        target.addEventListener(type, h, opts);
        fns.push(() => target.removeEventListener(type, h, opts));
      },
      dispose: () => {
        const run2 = fns;
        fns = [];
        for (let i = run2.length - 1; i >= 0; i--) run2[i]();
      }
    };
  }

  // packages/hairline/src/core/styles.ts
  var LIGHT = { plate: "#ffffff", hi: "#232327", edge: "#a4a4ac", mid: "#c3c3c9", lo: "#e0e0e4" };
  var DARK = { plate: "#08090a", hi: "#d0d6e0", edge: "#5b5d64", mid: "#3e3e44", lo: "#29292d" };
  var KEYS = ["plate", "hi", "edge", "mid", "lo"];
  var vars = (p) => KEYS.map((k) => `--hl-${k}:var(--hairline-${k},${p[k]});`).join("");
  var EASE = "cubic-bezier(0.5,0,0.1,1)";
  var SVG = ":where([data-hairline]>svg)";
  function css(lightDark) {
    const both = Object.fromEntries(KEYS.map((k) => [k, `light-dark(${LIGHT[k]},${DARK[k]})`]));
    return [
      // the box, and the palette: light unless something below says otherwise
      `:where([data-hairline]){display:block;position:relative;aspect-ratio:5/4;touch-action:pan-y;user-select:none;-webkit-user-select:none;--hl-sw:var(--hairline-stroke,0.9);${vars(LIGHT)}}`,
      // the page's color-scheme
      lightDark ? `:where([data-hairline]){${vars(both)}}` : "",
      // an ancestor that says dark
      `:where(.dark,[data-theme="dark"]) :where([data-hairline]){${vars(DARK)}}`,
      // the figure's own theme option
      `:where([data-hairline][data-hairline-theme="light"]){${vars(LIGHT)}}`,
      `:where([data-hairline][data-hairline-theme="dark"]){${vars(DARK)}}`,
      `:where([data-hairline]:focus-visible){outline:1.5px solid var(--hl-hi);outline-offset:2px}`,
      `${SVG}{position:absolute;inset:0;width:100%;height:100%;display:block}`,
      // Riffle's live region: read, not seen
      `:where([data-hairline]>[data-hairline-live]){position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}`,
      // the drawing: plates are filled with the plate colour and painted back to front
      `${SVG} :where(path,polygon,ellipse,line){fill:var(--hl-plate);stroke:var(--hl-mid);stroke-width:var(--hl-sw);vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round;transition:stroke 260ms ${EASE}}`,
      `${SVG} :where(.nf){fill:none}`,
      `${SVG} :where(.fo){stroke:none}`,
      `${SVG} :where(.sil){stroke:var(--hl-edge)}`,
      `${SVG} :where(.hi){stroke:var(--hl-hi)}`,
      `${SVG} :where(.lo){stroke:var(--hl-lo)}`,
      `${SVG} :where(.dash){stroke-dasharray:1 3}`,
      `${SVG} :where(.dot){stroke:none;fill:var(--hl-hi);transition:fill 260ms ${EASE}}`,
      `${SVG} :where(.dot.m){fill:var(--hl-edge)}`,
      `${SVG} :where(.dot.off){fill:var(--hl-lo)}`,
      `${SVG} :where(.ghost path){fill:none;stroke:var(--hl-mid)}`
    ].join("");
  }
  var done = /* @__PURE__ */ new WeakSet();
  function inject(root) {
    if (done.has(root)) return;
    done.add(root);
    const doc = root.nodeType === 9 ? root : root.ownerDocument;
    const win = doc.defaultView;
    const text = css(!!win?.CSS?.supports?.("color", "light-dark(#000,#fff)"));
    if (win && "adoptedStyleSheets" in root) {
      try {
        const sheet = new win.CSSStyleSheet();
        sheet.replaceSync(text);
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        return;
      } catch {
      }
    }
    const style = doc.createElement("style");
    style.setAttribute("data-hairline-style", "");
    style.textContent = text;
    (root.nodeType === 9 ? doc.head ?? doc.documentElement : root).appendChild(style);
  }
  return __toCommonJS(kernel_exports);
})();
/* /hairline kernel */

  // ======================================================================================
  // Nexus (authored for Matrix on the kernel above, in the hairline-create figure shape):
  // a hub tile on a round plinth, n satellite tiles around it on dashed ground links. At
  // rest the tiles stand at uneven heights and one bright dot sits on the hub's lid. The
  // tile under the pointer rises, its link turns solid and bright, and its neighbours rise
  // a little after it, staggered by distance. Hit test: the RESTING tile tops (rule 01).
  // value = the number of satellites (3 for the header mark, 7 for empty states); opts.plinth = false
  // drops the plinth (the header mark is drawn at 50px, where a plinth would be all you see).
  // ======================================================================================
  const {
    Cam, fit, proj, facing, rings, rrect, prism, solid, put, mk, flatDot, place, seg,
    tween, tset, tval, tdone, register, pointer, disposer,
  } = HL;

  const HEIGHTS = [10, 16, 7, 13, 6, 18, 9, 12];
  /** share of the lift at k steps round the ring from the chosen tile: 1 -> .31 -> .09 (rule 03) */
  const reach = (k) => (k === 0 ? 1 : k === 1 ? 0.31 : k === 2 ? 0.09 : 0);

  function nexus({ stage, svg, read }, value, opts) {
    const bag = disposer();
    const n = Math.max(3, Math.min(8, Math.round(value))), plinth = !opts || opts.plinth !== false;
    const small = n <= 4;
    const R = small ? 36 : 56, SAT = small ? 28 : 22, HUB = small ? 34 : 30;
    const HH = small ? 26 : 24, LIFT = small ? 14 : 22, PB = 6, PL = R + SAT * 0.75 + 9;
    const EXT = plinth ? PL : R + SAT * 0.72;
    const S = (plinth ? 336 : 372) / (2 * EXT);
    const C = Cam(45, 0.5, S);
    fit(C, [[-EXT, -EXT, -PB], [EXT, EXT, -PB], [EXT, -EXT, -PB], [-EXT, EXT, -PB], [0, 0, 18 + LIFT]], 200, 166);
    const P = proj(C), front = facing(C);

    const g = mk("g", {}, svg);
    // plinth: a disc, built from two 14-step rings (rule 09, large round)
    if (plinth) {
      const pr = rrect(-PL, -PL, PL, PL, PL, 14), pi = rrect(-PL + 2.2, -PL + 2.2, PL - 2.2, PL - 2.2, PL - 2.2, 14);
      put(solid(g), prism(P, front, pr, pi, -PB, 0));
    }

    const A0 = small ? -100 : -96;
    const sats = [];
    for (let i = 0; i < n; i++) {
      const a = ((A0 + (i * 360) / n) * Math.PI) / 180;
      const cx = R * Math.cos(a), cy = R * Math.sin(a), h0 = HEIGHTS[i % 8] * (small ? 0.8 : 1);
      const [ring, inner] = rings(cx - SAT / 2, cy - SAT / 2, cx + SAT / 2, cy + SAT / 2, small ? 5 : 4, small ? 1.6 : 1.3);
      sats.push({ i, cx, cy, h0, ring, inner, z: tween(0), drawn: NaN, el: null, link: null });
    }
    // links on the plinth's top, painted before every tile so the tiles cover them (rule 06)
    for (const s of sats) s.link = mk("path", { class: "nf dash", d: seg(P(0, 0, 0), P(s.cx, s.cy, 0)) }, g);

    // tiles back to front by x + y (the hub sits at the origin)
    const hub = { cx: 0, cy: 0, hub: true };
    const order = sats.concat([hub]).sort((p, q) => p.cx + p.cy - (q.cx + q.cy));
    let dot = null;
    for (const t of order) {
      if (t.hub) {
        const [ring, inner] = rings(-HUB / 2, -HUB / 2, HUB / 2, HUB / 2, small ? 7 : 6, 1.8);
        put(solid(g), prism(P, front, ring, inner, 0, HH));
        dot = flatDot(g, C, small ? 3.4 : 2.6, "dot");
        place(dot, P(0, 0, HH));
      } else t.el = solid(g);
    }

    function draw(s, now) {
      const h = s.h0 + tval(s.z, now);
      if (h === s.drawn) return;
      s.drawn = h;
      put(s.el, prism(P, front, s.ring, s.inner, 0, h));
    }
    const B = register(stage, (_dt, now) => {
      let moving = false;
      for (const s of sats) { draw(s, now); if (!tdone(s.z, now)) moving = true; }
      return moving;
    });
    bag.add(B.unregister);

    // hit: the nearest RESTING tile top on screen; these points never move
    const tops = sats.map((s) => P(s.cx, s.cy, s.h0));
    const HIT = SAT * S * 1.25 + 10;
    function hit([x, y]) {
      let best = -1, bd = HIT;
      tops.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
      return best;
    }

    let act = -1;
    function setActive(a) {
      if (a === act) return;
      const now = performance.now(), from = a >= 0 ? a : act;
      act = a;
      for (const s of sats) {
        const k = Math.min(Math.abs(s.i - from), n - Math.abs(s.i - from));
        tset(s.z, a < 0 ? 0 : LIFT * reach(k), now, k * 40);   // stagger by distance (rule 02)
        const on = s.i === a;
        s.el.sil.classList.toggle("hi", on);
        s.link.classList.toggle("dash", !on);
        s.link.classList.toggle("hi", on);
      }
      dot.setAttribute("class", a < 0 ? "dot" : "dot m");
      read.textContent = a < 0 ? "rest" : "node " + (a + 1) + " · 0";
      B.wake();
    }
    bag.add(pointer(stage, { move: (p) => setActive(hit(p)), leave: () => setActive(-1) }));
    bag.add(() => svg.replaceChildren());

    /** settle: drop every tile in from above, staggered round the ring (the loading state) */
    function settle() {
      const now = performance.now();
      for (const s of sats) { s.z = tween(LIFT * 1.4); tset(s.z, 0, now, 120 + s.i * 60); }
      B.wake();
    }
    return {
      set: () => {},
      settle,
      stops: [tops[0], tops[Math.floor(n / 2)], tops[n - 1], null],
      destroy: bag.dispose,
    };
  }

  // ======================================================================================
  // Galaxy (the Matrix mark, same kernel and figure shape): a thin dim disc in the 2:1 view
  // with dashed orbit guides on it, a round core tile carrying the one bright dot (the
  // universe's sun symbol: a ring and its centre dot), and two logarithmic spiral arms, each
  // a flat tapered plate carrying round tiles that shrink and flatten outward. The tile under the pointer rises and its edge
  // turns bright; the tiles beside it on the same arm follow, staggered by distance. The
  // disc drifts slowly round, arms trailing, unless motion is off. Hit test: the RESTING
  // tile tops at the current drift angle; lifting never moves them (rule 01).
  // value = tiles per arm on each of two arms (3: header mark, no guides; 8: empty state).
  // ======================================================================================
  const { clamp, lerp, rad, circ, ringAt, poly, reducedMotion } = HL;
  const GH = [1, 0.78, 1.12, 0.84, 1.06, 0.7, 0.94, 0.8];   // uneven rest heights (rule 05)
  const DRIFT = rad(360 / 240), DQ = rad(0.3);                 // one turn in 4 min; redraw per 0.3 deg

  function galaxy({ stage, svg, read }, value) {
    const bag = disposer();
    const m = clamp(Math.round(value), 3, 8), small = m <= 4, na = 2;
    const RD = 100, R0 = small ? 22 : 20, R1 = 96, TURN = rad(small ? 250 : 290);
    const B = Math.log(R1 / R0) / TURN;                          // arm: r = R0 e^(B th)
    const CR = small ? 17 : 15, CT = small ? 11 : 9, CH = small ? 9 : 8, LIFT = small ? 10 : 14;
    const S = 384 / (2 * RD + 6);
    const C = Cam(45, 0.5, S);
    fit(C, [[-RD, -RD, 0], [RD, RD, 0], [RD, -RD, 0], [-RD, RD, 0], [-0.7 * R1, -0.7 * R1, 12 + LIFT]], 200, 166);
    const P = proj(C), front = facing(C);

    // painted before the tiles (rule 06): disc rim, dashed orbits, loose stars, then the arm plates over them
    const gg = mk("g", {}, svg), gt = mk("g", {}, svg);
    mk("path", { class: "nf lo", d: poly(ringAt(P, circ(RD), 0)) }, gg);
    if (!small) for (const r of [38, 70]) mk("path", { class: "nf dash", d: poly(ringAt(P, circ(r), 0)) }, gg);
    const arms = [], specks = [];
    if (!small) for (let a = 0; a < na; a++) for (const f of [0.42, 0.7, 0.9])
      specks.push({ a, th: TURN * f, off: 1.7, el: flatDot(gg, C, 1.4, "dot off") });
    for (let a = 0; a < na; a++) arms.push(mk("path", { class: small ? "sil" : "" }, gg));

    const els = [];
    for (let a = 0; a < na; a++) for (let j = 0; j < m; j++) {
      const u = j / (m - 1), w = lerp(small ? 10 : 6, small ? 7 : 3, u);
      els.push({ a, j, th: Math.log(lerp(small ? 36 : 32, small ? 80 : 86, u) / R0) / B,   // even steps in r: even spacing along the arm
        w, b: clamp(w * 0.18, 0.9, 1.6),
        h0: lerp(small ? 5 : 6, small ? 2.5 : 1.4, u) * GH[(j + 3 * a) % 8],
        z: tween(0), el: solid(gt), x: 0, y: 0, key: "" });
    }
    // core: a ring stack, a low wide bulge under a raised hub whose lid holds the dot
    const core = { x: 0, y: 0, el: { g: mk("g", {}, gt) } };
    const disk = (r, b) => rrect(-r + b, -r + b, r - b, r - b, r - b, 14);
    put(solid(core.el.g), prism(P, front, disk(CR, 0), disk(CR, 1.4), 0, 3));
    put(solid(core.el.g), prism(P, front, disk(CT, 0), disk(CT, 1.6), 3, 3 + CH));
    const dot = flatDot(core.el.g, C, small ? 3.8 : 2.4, "dot");
    place(dot, P(0, 0, 3 + CH));

    let phi = 0, phiQ = NaN, tops = [], last = null;
    const at = (a, th, off = 0) => {
      const r = R0 * Math.exp(B * th), t = phi + (a * 2 * Math.PI) / na + th + off;
      return [r * Math.cos(t), r * Math.sin(t)];
    };
    function draw(e, now) {
      const h = e.h0 + tval(e.z, now), key = h + "/" + phiQ;
      if (key === e.key) return;
      e.key = key;
      const [ring, inner] = rings(e.x - e.w, e.y - e.w, e.x + e.w, e.y + e.w, e.w, e.b);
      put(e.el, prism(P, front, ring, inner, 0, h));
    }
    // place everything at the current drift angle; paint order by depth x + y, groups moved not redrawn (rule 06)
    function layout() {
      phiQ = Math.round(phi / DQ) * DQ;
      for (const e of els) [e.x, e.y] = at(e.a, e.th);
      for (const s of specks) place(s.el, P(...at(s.a, s.th, s.off), 0));
      arms.forEach((el, a) => {                          // band r +- hw, tapering to a point at the tip
        const out = [], inn = [];
        for (let k = 0; k <= 40; k++) {
          const t = k / 40, th = -0.5 + (TURN + 0.5) * t, [x, y] = at(a, th), r = Math.hypot(x, y);
          const hw = Math.min(r * 0.3, small ? 7.5 : 10) * Math.pow(1 - t, 0.8), f = hw / r;
          out.push(P(x * (1 + f), y * (1 + f), 0)); inn.unshift(P(x * (1 - f), y * (1 - f), 0));
        }
        el.setAttribute("d", poly(out.concat(inn)));
      });
      els.concat([core]).sort((p, q) => p.x + p.y - (q.x + q.y)).forEach((e) => gt.appendChild(e.el.g));
      tops = els.map((e) => P(e.x, e.y, e.h0));
    }
    layout();

    // frames only while a lift tween runs; the drift is a 200 ms timer (one 0.3 deg step = 200 ms at DRIFT), so a
    // turning galaxy costs ~5 redraws/s, not a 60 Hz loop. The timer stops when the figure is off-screen, detached,
    // the page hidden, or motion off / reduced; wake() (motion toggle) and the observers restart it.
    const Bd = register(stage, (dt, now) => {
      let moving = false;
      for (const e of els) { draw(e, now); if (!tdone(e.z, now)) moving = true; }
      return moving;
    });
    bag.add(Bd.unregister);
    let dT = 0, dLast = 0;
    const onScreen = () => {                                  // laid out, inside the viewport, not in a folded panel
      const r = stage.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && !stage.closest("[inert]");
    };
    const driftOK = () => stage.isConnected && !document.hidden && !reducedMotion() && onScreen();
    function driftStep() {
      dT = 0;
      if (!driftOK()) return;
      const now = performance.now();
      phi -= DRIFT * Math.min(1, (now - dLast) / 1e3);       // arms trail: the disc turns against their unwinding
      dLast = now;
      if (Math.round(phi / DQ) * DQ !== phiQ) { layout(); if (last) setActive(hit(last)); Bd.wake(); }
      dT = setTimeout(driftStep, 200);
    }
    function driftWake() { if (!dT && driftOK()) { dLast = performance.now(); dT = setTimeout(driftStep, 200); } }
    const vio = new IntersectionObserver(driftWake);          // scrolled / shown again: a wake source only
    vio.observe(stage);
    bag.on(document, "visibilitychange", driftWake);
    bag.add(() => { vio.disconnect(); clearTimeout(dT); dT = 0; });

    // hit: the nearest RESTING tile top on screen, within reach of its own size
    function hit([x, y]) {
      let best = -1, bd = Infinity;
      tops.forEach((p, i) => {
        const r = els[i].w * S, d = Math.hypot(p[0] - x, p[1] - y);
        if (d < r * 1.6 + 8 && d - r < bd) { bd = d - r; best = i; }
      });
      return best;
    }

    let act = -1;
    function setActive(i) {
      if (i === act) return;
      const now = performance.now(), from = els[i >= 0 ? i : act];
      act = i;
      for (const e of els) {
        const k = e.a === from.a ? Math.abs(e.j - from.j) : 9;
        tset(e.z, i < 0 ? 0 : LIFT * reach(k), now, Math.min(k, 4) * 40);   // stagger by distance along the arm (rule 02)
        e.el.sil.classList.toggle("hi", e === els[i]);
      }
      dot.setAttribute("class", i < 0 ? "dot" : "dot m");
      read.textContent = i < 0 ? "rest" : "arm " + (from.a + 1) + " · " + (from.j + 1);
      Bd.wake();
    }
    bag.add(pointer(stage, {
      move: (p) => { last = p; setActive(hit(p)); },
      leave: () => { last = null; setActive(-1); },
    }));
    bag.add(() => svg.replaceChildren());

    const pick = (a, j) => tops[a * m + j];
    return {
      set: () => {},
      wake: () => { Bd.wake(); driftWake(); },
      settle: () => {},
      drifting: () => !!dT,
      stops: [pick(0, 1), pick(1 % na, m - 2), pick(na - 1, 2), null],
      destroy: bag.dispose,
    };
  }

  // ======================================================================================
  // Mount shim (modelled on bench.html's hairline()): host + svg 400 x 320 + read-out.
  // o.fig: "galaxy" (default) | "nexus".
  // ======================================================================================
  const FIGS = { galaxy, nexus };
  function mountFig(host, o) {
    HL.inject(document);
    const name = FIGS[o.fig] ? o.fig : "galaxy";
    host.setAttribute("data-hairline", name);
    if (o.label) { host.setAttribute("role", "img"); host.setAttribute("aria-label", o.label); }
    else host.setAttribute("aria-hidden", "true");
    const svg = mk("svg", { viewBox: "0 0 400 320", "aria-hidden": "true", focusable: "false" }, host);
    let text = null;
    const read = {
      get textContent() { return text; },
      set textContent(v) { text = v == null ? "" : String(v); if (o.read) o.read.textContent = text; },
    };
    const fig = FIGS[name]({ stage: host, svg, read }, o.n, o);
    if (text === null) read.textContent = "rest";
    let tour = null;
    const api = {
      host, fig,
      play(on) {
        if (on && !tour) tour = HL.tour(host, fig.stops, null);
        else if (!on && tour) { tour.stop(); tour = null; }
      },
      destroy() { api.play(false); fig.destroy(); svg.remove(); host.removeAttribute("data-hairline"); },
    };
    return api;
  }

  // ======================================================================================
  // Matrix wiring: header mark, inspector empty state, loading card. Motion toggle and
  // reduced motion both land springs/tweens at once (the kernel's own reduced-motion path).
  // ======================================================================================
  const S = MX.state;
  const motionOff = () => document.documentElement.getAttribute("data-anim") === "0" || S.anim === false;
  const rmq = matchMedia("(prefers-reduced-motion: reduce)");
  function syncMotion() {
    HL.setReducedMotion(rmq.matches || motionOff());
    for (const k in figs) if (figs[k] && figs[k].fig.wake) figs[k].fig.wake();   // resume (or land) the drift
  }
  const figs = { mark: null, empty: null, loading: null };

  function emptyState(panel) {
    const title = document.getElementById("panel-title");
    const empty = !!title && panel.contains(title) && title.textContent === "Nothing selected";
    if (empty) {
      if (!figs.empty) {
        const wrap = document.createElement("div");
        wrap.className = "hl-empty";
        const host = document.createElement("div"), ro = document.createElement("span");
        host.className = "hl-fig"; ro.className = "hl-read"; ro.setAttribute("aria-hidden", "true");
        wrap.append(host, ro);
        figs.empty = mountFig(host, { n: 8, read: ro, label: "Empty selection: a galaxy with no star picked" });
        figs.empty.wrap = wrap;
      }
      if (panel.firstChild !== figs.empty.wrap) {
        panel.insertBefore(figs.empty.wrap, panel.firstChild);
        figs.empty.fig.wake();          // re-inserted in the same task: the observer may see no change, restart here
      }
    }
    const sel = S.selected;
    panel.classList.toggle("has-sel", sel >= 0);
    if (sel >= 0) panel.style.setProperty("--sel-acc", "var(--g" + (MX.g.group[sel] & 3) + ")");
    else panel.style.removeProperty("--sel-acc");
  }

  function loading() {
    const card = document.getElementById("hl-loading");
    if (!card) return;
    const hold = /[#&]hl=loading(&|$)/.test(location.hash);
    const show = () => {
      if (!figs.loading) {
        figs.loading = mountFig(card.querySelector(".hl-fig"), { fig: "nexus", n: 7, read: card.querySelector(".hl-read") });
        figs.loading.fig.settle();
        if (!rmq.matches && !motionOff()) figs.loading.play(true);
      }
      card.hidden = false;
      requestAnimationFrame(() => card.classList.add("in"));
    };
    const hide = () => {
      if (hold || card.hidden) return;
      card.classList.remove("in");
      setTimeout(() => {
        card.hidden = true;
        if (figs.loading) { figs.loading.destroy(); figs.loading = null; }
      }, rmq.matches ? 0 : 700);
    };
    if (hold) { show(); return; }
    // only when settling is slow enough to notice: a flash of a card would be noise
    const t = setTimeout(() => { if (!S.settled && S.view === "graph") show(); }, 400);
    MX.on("settled", () => { clearTimeout(t); hide(); });
  }

  // watercolour drift: one transform write every 2 s on a slow-fast-slow 64 s swing (max 2vmax). Motion off, reduced
  // motion or a hidden page stop the timer (no re-arming while static); the anim / visibility / reduced-motion
  // events restart it. Nothing animates between writes.
  let washT = 0;
  function drift() {
    const el = document.getElementById("wash");
    if (!el || washT || !MX.motionOK()) return;
    const T = 64000, t0 = drift.t0 || (drift.t0 = performance.now());
    const step = () => {
      washT = 0;
      if (!MX.motionOK()) return;
      const u = ((performance.now() - t0) % (2 * T)) / T, p = (1 - Math.cos(Math.PI * (u > 1 ? 2 - u : u))) / 2;
      el.style.transform = "translate3d(" + (2 * p).toFixed(3) + "vmax," + (-1.5 * p).toFixed(3) + "vmax,0) scale(" + (1 + 0.03 * p).toFixed(4) + ")";
      washT = setTimeout(step, 2000);
    };
    washT = setTimeout(step, 2000);
  }

  MX.hl = { mount: mountFig, figs };
  MX.module("hairline", () => {
    syncMotion();
    rmq.addEventListener("change", () => { syncMotion(); drift(); });
    MX.on("anim", () => { syncMotion(); drift(); });
    const wakeFigs = () => setTimeout(() => { for (const k in figs) if (figs[k] && figs[k].fig.wake) figs[k].fig.wake(); }, 60);
    MX.on("chrome", wakeFigs);          // a panel opened / closed, a tab switched: drift resumes (or stays stopped)
    MX.on("view", wakeFigs);
    document.addEventListener("visibilitychange", drift);
    const mh = document.getElementById("hl-mark");
    if (mh) figs.mark = mountFig(mh, { n: 3 });
    const panel = document.getElementById("panel");
    if (panel) {
      new MutationObserver(() => emptyState(panel)).observe(panel, { childList: true });
      emptyState(panel);
    }
    loading();
    drift();
    MX.statusExt.hairline = () => ({
      figures: Object.keys(figs).filter((k) => figs[k]).length,
      reduced: HL.reducedMotion(),
      drift: {wash: !!washT, mark: !!(figs.mark && figs.mark.fig.drifting && figs.mark.fig.drifting()),
              empty: !!(figs.empty && figs.empty.fig.drifting && figs.empty.fig.drifting())},
    });
    MX.selftest.add("hairline.figures", () => {
      const fail = (m) => { throw new Error(m); };
      if (!figs.mark || !document.querySelector("#hl-mark > svg path")) fail("header mark not drawn");
      if (figs.mark.host.getAttribute("data-hairline") !== "galaxy") fail("header mark is not the galaxy");
      const st = getComputedStyle(document.querySelector("#hl-mark svg path"));
      if (st.vectorEffect !== "non-scaling-stroke") fail("hairline stylesheet not injected");
      if (S.selected < 0 && !S.path && !S.focus && !document.querySelector("#panel .hl-empty [data-hairline] svg")) fail("empty-state figure missing");
    });
    MX.selftest.add("hairline.motionGate", () => {
      const root = document.documentElement, prev = root.getAttribute("data-anim");
      try {
        root.setAttribute("data-anim", "0"); syncMotion();
        if (!HL.reducedMotion()) throw new Error("Motion off did not land the figures");
      } finally {
        if (prev === null) root.removeAttribute("data-anim"); else root.setAttribute("data-anim", prev);
        syncMotion();
      }
      if (HL.reducedMotion() !== (rmq.matches || motionOff())) throw new Error("motion gate not restored");
    });
  });
})();
