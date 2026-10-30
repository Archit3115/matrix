(function () {
  "use strict";
  // ---- error capture: installed first, before anything can throw --------
  const errors = [], warnings = [];
  const fmtErr = a => Array.prototype.map.call(a, v =>
    v instanceof Error ? v.stack || v.message : typeof v === "string" ? v : JSON.stringify(v)).join(" ");
  window.addEventListener("error", e => {
    errors.push((e.message || "error") + (e.filename ? " @" + e.filename + ":" + e.lineno : ""));
    MX.status();
  });
  window.addEventListener("unhandledrejection", e => {
    errors.push("unhandledrejection: " + fmtErr([e.reason])); MX.status();
  });
  const nativeError = console.error;
  console.error = function () { errors.push(fmtErr(arguments)); nativeError.apply(console, arguments); MX.status(); };

  const MX = window.MX = {errors, warnings, statusExt: {}};   // statusExt: module-owned mxstatus keys

  // ---- bus ---------------------------------------------------------------
  const handlers = Object.create(null);
  MX.on = (evt, fn) => { (handlers[evt] || (handlers[evt] = [])).push(fn); };
  MX.emit = (evt, detail) => { for (const fn of handlers[evt] || []) fn(detail); };

  // ---- helpers -----------------------------------------------------------
  const ESC = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"};
  MX.esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ESC[c]);   // the only escaper
  MX.fmt = n => n.toLocaleString("en-US");
  MX.warn = msg => { warnings.push(String(msg)); MX.status(); };
  let liveTimer = 0;
  MX.announce = msg => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      const el = document.getElementById("live");
      if (el) el.textContent = el.textContent === msg ? msg + "\u00a0" : msg;   // a repeat must still change the region
    }, 300);
  };

  // ---- module registry + boot --------------------------------------------
  const mods = [];
  MX.module = (name, init) => { mods.push([name, init]); };

  // requestDraw: queued until render.js replaces it.
  MX.requestDraw = () => { MX._drawPending = true; };

  // ---- read-only graph MX.g ----------------------------------------------
  const D = JSON.parse(document.getElementById("payload").textContent);
  const N = D.nodes.length, M = D.edges.length;
  const g = MX.g = {
    N, M, D,
    label: new Array(N), id: new Array(N), file: new Array(N),
    idIndex: new Map(), meta: new Map(),
    type: new Uint8Array(N), group: new Uint8Array(N), deg: new Uint32Array(N),
    comm: new Int16Array(N), line: new Uint32Array(N),
    src: new Int32Array(M), dst: new Int32Array(M),
    rel: new Uint8Array(M), prov: new Uint8Array(M), w: new Uint16Array(M),
    adjOff: new Uint32Array(N + 1), adjEdge: null, provEdges: null,
  };
  for (let i = 0; i < N; i++) {
    const n = D.nodes[i];
    g.label[i] = n[0]; g.type[i] = n[1]; g.deg[i] = n[2]; g.comm[i] = n[3];
    g.file[i] = n[4]; g.line[i] = n[5]; g.group[i] = n[6];
    g.id[i] = n[7] == null ? "" : n[7];
    g.idIndex.set(g.id[i], i);
  }
  for (const [i, m] of D.meta || []) g.meta.set(i, m);
  const cnt = new Uint32Array(N), pc = [0, 0, 0];
  for (let k = 0; k < M; k++) {
    const e = D.edges[k];
    g.src[k] = e[0]; g.dst[k] = e[1]; g.rel[k] = e[2]; g.prov[k] = e[3];
    g.w[k] = Math.min(e[4] == null ? 1 : e[4], 65535);
    cnt[e[0]]++; if (e[1] !== e[0]) cnt[e[1]]++;
    pc[e[3]]++;
  }
  for (let i = 0; i < N; i++) g.adjOff[i + 1] = g.adjOff[i] + cnt[i];
  g.adjEdge = new Uint32Array(g.adjOff[N]);
  g.provEdges = pc.map(c => new Uint32Array(c));
  const fill = g.adjOff.slice(0, N), pf = [0, 0, 0];
  for (let k = 0; k < M; k++) {            // ascending edge id per node
    const s = g.src[k], d = g.dst[k];
    g.adjEdge[fill[s]++] = k; if (d !== s) g.adjEdge[fill[d]++] = k;
    g.provEdges[g.prov[k]][pf[g.prov[k]]++] = k;
  }

  // ---- mutable state (one writer per field, see docs/ARCHITECTURE.md) ----------------
  const rmq = matchMedia("(prefers-reduced-motion: reduce)");
  MX.state = {
    x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N),   // z: depth off the disc plane (universe.js)
    alpha: 1, settled: false, layoutMode: "main",
    nodeVisible: new Uint8Array(N), edgeVisible: new Uint8Array(M),
    nodesShown: 0, edgesShown: 0, hiddenMatches: 0,
    facets: {prov: new Set([0, 1, 2]), rel: null, type: null, comm: null, orphans: false, deg: 0},
    q: "", results: new Int32Array(0), matchMask: new Uint8Array(N),
    selected: -1, pinned: new Set(), focus: null, path: null,
    hover: -1, kbdCursor: -1,
    // 3D orbit camera (render.js): scale/pan act in the view plane through the target exactly like the old 2D camera;
    // yaw spins about world z, pitch tilts off face-on (0 = the old 2D view), fz = target depth along the view axis
    camera: {scale: 0.55, panX: 0, panY: 0, userAdjusted: false, yaw: 0, pitch: 0, fz: 0},
    view3d: true, zScale: 1,   // 2D / 3D view (writer: render.js setView3d); zScale x every z (universe.js write)
    view: "graph",   // graph|overview|claims|communities|tables (writer: MX.dash.setView)
    dash: {table: "nodes", sort: null, page: 0, filter: "", tier: null, lastTab: "overview", rows: 0},
    theme: {name: "light", source: "os", colors: {}, font: "", forced: false},
    reducedMotion: rmq.matches,
    universe: {level: "universe", cluster: -1, galaxy: -1, system: -1},   // writer: ui.js via MX.universe drill calls
    anim: true,                                                           // writer: filter.js (#anim=0 / setAnim)
    get spacing() { return this.facets.sp == null ? 1 : this.facets.sp; }, // alias of facets.sp (writer: filter.js)
    perf: {rafCount: 0, frames: 0, frameMs: [], lastSegs: 0, lastLabels: [], firstPaintMs: 0},
    bench: null, errors, warnings,
  };
  MX.motionOK = () => MX.state.anim !== false && !MX.state.reducedMotion && !document.hidden;
  rmq.addEventListener("change", () => { MX.state.reducedMotion = rmq.matches; MX.status(); });

  // ---- #mxstatus (schema 3.4), coalesced ----------------------------------
  let statusPending = false, ready = false, selftestResults = null;
  function names(set, list) { return set ? [...set].map(i => list[i]) : null; }
  function buildStatus() {
    const S = MX.state, f = S.facets, th = S.theme;
    const out = {
      v: 1, ready, errors, warnings,
      theme: th.name, themeSource: th.source,
      reducedMotion: S.reducedMotion, anim: S.anim !== false, spacing: S.spacing, forcedColors: th.forced, colors: th.colors,
      view: S.view === "table" ? "tables" : S.view, dash: S.dash, glass: S.theme.glass || null,
      nodesTotal: N, edgesTotal: M, nodesShown: S.nodesShown, edgesShown: S.edgesShown,
      orphansTotal: g.deg.reduce((a, d) => a + (d === 0 ? 1 : 0), 0),
      facets: {prov: names(f.prov, D.provs), type: names(f.type, D.types),
               comm: names(f.comm, D.communities), rel: names(f.rel, D.rels), orphans: f.orphans, deg: f.deg},
      q: S.q, resultCount: S.results.length - S.hiddenMatches, hiddenMatches: S.hiddenMatches,
      results: Array.from(S.results.subarray(0, 50), i => g.id[i]),
      selected: S.selected >= 0 ? g.id[S.selected] : null,
      focus: S.focus ? {root: g.id[S.focus.root], hops: S.focus.hops, size: S.focus.size,
                        truncated: !!S.focus.truncated} : null,
      path: S.path ? {from: g.id[S.path.from], to: g.id[S.path.to],
                      ids: S.path.found ? S.path.nodes.map(i => g.id[i]) : null,
                      found: !!S.path.found} : null,
      layout: Object.assign({mode: S.layoutMode, alpha: S.alpha, settled: S.settled}, MX.layout && MX.layout.stats),
      hash: location.hash.slice(1), selftest: selftestResults, bench: S.bench,
    };
    for (const k in MX.statusExt) out[k] = MX.statusExt[k]();
    if (!("cosmos" in out) && MX.cosmos && MX.cosmos.stats) out.cosmos = MX.cosmos.stats();
    return out;
  }
  function writeStatus() {
    statusPending = false;
    const el = document.getElementById("mxstatus");
    if (!el) return;
    const json = JSON.stringify(buildStatus());
    el.textContent = json;
    if (ready && !MX._logged) { MX._logged = true; console.log("MXSTATUS " + json); }
  }
  MX.status = () => { if (!statusPending) { statusPending = true; setTimeout(writeStatus, 0); } };

  // ---- selftest runner: sequential, 5 s timeout, restores hash ------------
  // A test that cannot apply to this graph (data absent: no claims, < 500 rows, no 3-planet system ...) skips:
  // `MX.selftest.skip("reason")` throws a Skip, or the test resolves to {skip: "reason"}. Reported as
  // {pass: true, na: true, msg: "n/a: reason"}: not a failure, but visibly not a pass either.
  class Skip extends Error {}
  const tests = [];
  MX.selftest = {
    add(name, fn, o) { tests.push([name, fn, o && o.timeout || 5000]); },
    Skip,
    skip(reason) { throw new Skip(String(reason || "not applicable")); },
    async run(prefix) {
      selftestResults = {};
      for (const [name, fn, tmo] of tests) {
        if (prefix && prefix !== "1" && !name.startsWith(prefix)) continue;
        const saved = location.hash;
        try {
          const r = await Promise.race([Promise.resolve().then(fn),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + tmo / 1000 + "s")), tmo))]);
          selftestResults[name] = r && typeof r === "object" && r.skip ? {pass: true, na: true, msg: "n/a: " + r.skip} : {pass: true, msg: ""};
        } catch (e) {
          selftestResults[name] = e instanceof Skip ? {pass: true, na: true, msg: "n/a: " + e.message}
            : {pass: false, msg: String(e && e.message || e)};
        }
        if (location.hash !== saved) {
          try { history.replaceState(null, "", saved || location.pathname); } catch (e) { /* ignore */ }
        }
        MX.status();
      }
    },
  };
  MX.selftest.add("core.smoke", () => {
    if (g.adjOff[N] !== g.adjEdge.length) throw new Error("CSR size");
    if (MX.esc("<&\"'>") !== "&lt;&amp;&quot;&#39;&gt;") throw new Error("esc");
  });

  MX.boot = function () {
    for (const [, init] of mods) init();
    MX.filter.applyHash(location.hash);
    MX.layout.start();
    MX.requestDraw();
    ready = true;
    MX.emit("ready");
    MX.status();
    const m = /[#&]selftest=([^&]*)/.exec(location.hash);
    if (m) MX.selftest.run(decodeURIComponent(m[1])).then(MX.status);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", MX.boot);
  else setTimeout(MX.boot, 0);
})();
