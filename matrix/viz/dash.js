(function () {
  "use strict";
  // dash.js: side tabs + dashboard panels.
  // Sole writer of S.view and S.dash. Every number comes from MX.g and
  // MX.filter.counts(); payload.stats only for build facts. Text goes through
  // MX.esc; node links are <a href="#n=<encodeURIComponent(id)>">.
  const g = MX.g, S = MX.state, D = g.D, N = g.N, M = g.M;
  const NP = D.provs.length, NT = D.types.length, NC = D.communities.length;
  const F = S.facets, $ = id => document.getElementById(id);
  const esc = MX.esc, fmt = MX.fmt, E = encodeURIComponent;
  const VIEWS = ["graph", "overview", "claims", "communities", "tables"];
  const PANE = {overview: "pane-overview", claims: "pane-claims", communities: "pane-communities", tables: "tableview"};
  const TIERS = ["SOURCE", "MEASURED", "INFERRED", "RETRACTED"];          // trust order (tiles)
  const RANK = {RETRACTED: 0, INFERRED: 1, MEASURED: 2, SOURCE: 3};       // table order
  const T_CLAIM = D.types.indexOf("claim"), T_FILE = D.types.indexOf("file");
  const canon = v => (v === "table" ? "tables" : v);
  const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);                    // code-unit order
  const nodeLink = i => `<a href="#n=${esc(E(g.id[i]))}" title="${esc(g.label[i])}">${esc(g.label[i])}</a>`;
  const commName = c => (c >= 0 ? D.communities[c] : "—");
  const fx = () => MX.filter;
  // ---- universe hierarchy (MX.universe, universe.js): cluster = group, galaxy = type, system = sun's bound set
  const ROLE = ["sun", "planet", "dust"];
  const uni = () => MX.universe && MX.universe.systems ? MX.universe : null;
  const roleOf = i => { const u = uni(); return u ? ROLE[u.roleOf(i)] : "—"; };
  const sunOfNode = i => { const u = uni(), s = u ? u.systemOf(i) : -1; return s >= 0 ? u.sun[s] : -1; };
  const sysLabel = i => { const s = sunOfNode(i); return s >= 0 ? g.label[s] : "—"; };
  // middle truncation in CSS (.mid): the folder head shrinks into "…" first, the file name holds; full path in the title
  const pathCell = (f, line) => {
    if (!f) return "";
    const full = f + (line ? ":" + line : ""), cut = full.lastIndexOf("/") + 1;
    return `<span class="mid" title="${esc(full)}"><span class="mid-h">${esc(full.slice(0, cut))}</span><span class="mid-t">${esc(full.slice(cut))}</span></span>`;
  };
  const secHead = (kicker, title, extra) => `<div class="card-head"><div class="sec-h"><span class="sec-k">${esc(kicker)}</span>` +
    `<h3 class="card-title">${esc(title)}</h3></div>${extra || ""}</div>`;
  const ratio = (a, b) => (b > 0 ? a / b : null);
  // .card:empty is display:none in app.css: give empty mounts a body first so charts measure the real width
  const prime = ids => ids.forEach(id => { const el = $(id); if (el && !el.firstChild) el.innerHTML = "<div class='chart-ph'></div>"; });

  // ---- global stats, memoised once ---------------------------------------
  function folder(f) {
    const p = f.split("/"), d = p.slice(0, -1).slice(0, 3);
    return d.length ? d.join("/") : p[0];
  }
  let memo = null;
  function stats() {
    if (memo) return memo;
    const typeCount = new Uint32Array(NT), commSize = new Uint32Array(NC), commClaims = new Uint32Array(NC);
    const commType = new Uint32Array(NC * NT), commHub = new Int32Array(NC).fill(-1);
    const tierOf = new Array(N).fill(""), folderOf = new Array(N).fill(""), claimTier = {};
    const typeGroup = new Int8Array(NT).fill(-1);
    let orphans = 0;
    for (let i = 0; i < N; i++) {
      const t = g.type[i], c = g.comm[i];
      typeCount[t]++; typeGroup[t] = g.group[i];
      if (g.deg[i] === 0) orphans++;
      if (t === T_CLAIM) {
        const m = g.meta.get(i), tr = (m && m.tier) || "";
        tierOf[i] = tr; claimTier[tr] = (claimTier[tr] || 0) + 1;
      }
      if (t === T_FILE && g.file[i]) folderOf[i] = folder(g.file[i]);
      if (c >= 0) {
        commSize[c]++; commType[c * NT + t]++;
        if (t === T_CLAIM) commClaims[c]++;
        if (commHub[c] < 0 || g.deg[i] > g.deg[commHub[c]]) commHub[c] = i;
      }
    }
    D.types.forEach((t, k) => {                 // types without nodes: groupTypes, else Other
      if (typeGroup[k] >= 0) return;
      const j = D.groupTypes.findIndex(l => l.includes(t));
      typeGroup[k] = j < 0 ? D.groups.length - 1 : j;
    });
    const groupTypes = D.groups.map((_, j) => {
      const ord = D.groupTypes[j] || [], at = k => { const x = ord.indexOf(D.types[k]); return x < 0 ? 99 : x; };
      return D.types.map((_, k) => k).filter(k => typeGroup[k] === j).sort((a, b) => at(a) - at(b) || a - b);
    });
    const commTopTypes = [];
    for (let c = 0; c < NC; c++) {
      const ts = [];
      for (let t = 0; t < NT; t++) if (commType[c * NT + t]) ts.push(t);
      ts.sort((a, b) => commType[c * NT + b] - commType[c * NT + a] || a - b);
      commTopTypes.push(ts.slice(0, 3).map(t => D.types[t] + " " + fmt(commType[c * NT + t])).join(", "));
    }
    memo = {
      kpis: {nodes: N, edges: M, orphans, claims: T_CLAIM < 0 ? 0 : typeCount[T_CLAIM],
             communities: NC, files: T_FILE < 0 ? 0 : typeCount[T_FILE]},
      typeCount, typeGroup, groupTypes, commSize, commClaims, commHub, commTopTypes, claimTier, tierOf, folderOf,
    };
    return memo;
  }

  // ---- live (facet-aware) slices over S.nodeVisible -------------------------------
  function hubs(k) {
    const v = [];
    for (let i = 0; i < N; i++) if (S.nodeVisible[i]) v.push(i);
    return v.sort((a, b) => g.deg[b] - g.deg[a] || a - b).slice(0, k);
  }
  function folders() {
    const fo = stats().folderOf, m = new Map();
    for (let i = 0; i < N; i++) if (S.nodeVisible[i] && fo[i]) m.set(fo[i], (m.get(fo[i]) || 0) + 1);
    const rows = [...m].sort((a, b) => b[1] - a[1] || byStr(a[0], b[0]));
    const head = rows.slice(0, 10), tail = rows.slice(10);
    if (tail.length) head.push(["Other", tail.reduce((s, r) => s + r[1], 0)]);
    return head;
  }
  function claimRows() {
    const tierOf = stats().tierOf, rows = [], tiers = {};
    for (let i = 0; i < N; i++) if (S.nodeVisible[i] && g.type[i] === T_CLAIM) {
      rows.push(i); tiers[tierOf[i]] = (tiers[tierOf[i]] || 0) + 1;
    }
    rows.sort((a, b) => byStr(g.id[a], g.id[b]));
    return {rows, tiers};
  }
  const binLabel = b => { const lo = fx().binLow(b), hi = b ? Math.pow(2, b) - 1 : 0; return lo === hi ? String(lo) : lo + "–" + hi; };

  // ---- shared pane chrome: scope line (what the slice is) ----------------------------
  function facetParts() {
    const p = [], list = (set, names) => { const a = [...set].sort((x, y) => x - y).map(k => names[k]); return a.length > 3 ? a.slice(0, 3).join(", ") + " +" + (a.length - 3) : a.join(", "); };
    if (S.q) p.push("Search: " + S.q);
    if (F.prov.size < NP) p.push("Provenance: " + list(F.prov, D.provs));
    if (F.type) p.push("Type: " + list(F.type, D.types));
    if (F.rel) p.push("Relationship: " + list(F.rel, D.rels));
    if (F.comm) p.push("Community: " + list(F.comm, D.communities));
    if (F.orphans) p.push("Orphans shown");
    if (F.deg) p.push("Degree ≥ " + F.deg);
    return p;
  }
  function scope(pane) {
    let el = pane.querySelector(".dash-scope");
    if (!el) {
      el = document.createElement("div"); el.className = "dash-scope";
      const h = pane.querySelector("h2"); if (h) h.after(el); else pane.prepend(el);
    }
    const p = facetParts(), facets = p.filter(x => !x.startsWith("Search: "));
    el.innerHTML = `<span>${fmt(S.nodesShown)} of ${fmt(N)} nodes · ${fmt(S.edgesShown)} of ${fmt(M)} edges</span>` +
      (p.length ? p.map(x => `<span class="badge">${esc(x)}</span>`).join("") : `<span class="meta">No filters: the whole graph</span>`) +
      (S.q ? `<button type="button" class="btn-sm" data-act="clear-search">Clear search</button>` : "") +
      (facets.length ? `<button type="button" class="btn-sm" data-act="reset-filters">Reset filters</button>` : "");
  }
  function note(pane, text) {
    if (pane.querySelector(".dash-note")) return;
    const p = document.createElement("p"); p.className = "dash-note meta"; p.textContent = text;
    pane.querySelector(".dash-scope").after(p);
  }

  // ---- Overview ------------------------------------------------------------------------
  function renderOverview(pane) {
    const st = stats(), c = fx().counts(), k = st.kpis, typeOn = t => !!F.type && F.type.has(t);
    scope(pane);
    const um = universeMounts();
    prime(["ov-types", "ov-prov", "ov-rels", "ov-degree", "ov-folders"].concat(um ? ["ov-ucl"] : []));
    note(pane, "Every bar, segment, bin and tile below is a filter: it narrows the graph and every tab. Rows open the node in the inspector.");
    MX.charts.tiles("ov-kpis", [
      {key: "nodes", label: "Nodes", value: k.nodes, sub: fmt(S.nodesShown) + " shown", hero: true, ratio: ratio(S.nodesShown, k.nodes)},
      {key: "edges", label: "Edges", value: k.edges, sub: fmt(S.edgesShown) + " shown", ratio: ratio(S.edgesShown, k.edges)},
      {key: "orphans", label: "Orphans", value: k.orphans, sub: F.orphans ? "shown · degree 0" : "hidden · degree 0",
       pressed: F.orphans, onActivate: () => fx().setFacet("orphans", !F.orphans), ratio: ratio(k.orphans, k.nodes)},
      {key: "claims", label: "Claims", value: k.claims, sub: "filter type = claim", pressed: typeOn(T_CLAIM),
       onActivate: () => fx().toggle("type", T_CLAIM), ratio: ratio(k.claims, k.nodes)},
      {key: "communities", label: "Communities", value: k.communities, sub: "open the tab",
       onActivate: () => setView("communities", {focus: true})},
      {key: "files", label: "Files", value: k.files, sub: "filter type = file", pressed: typeOn(T_FILE),
       onActivate: () => fx().toggle("type", T_FILE), ratio: ratio(k.files, k.nodes)},
    ]);
    if (um) renderUniverse();
    MX.charts.bar({mount: "ov-types", kicker: "Composition", title: "Nodes by type", unit: "nodes", facet: "type", labelHead: "Type", valueHead: "Nodes",
      desc: `${NT} types in ${D.groups.length} groups; counts ignore the type filter so every type stays clickable`,
      groups: st.groupTypes.map((ts, j) => ({label: D.groups[j], swatch: j,
        rows: ts.map(t => ({key: D.types[t], label: D.types[t], value: c.type[t], pressed: typeOn(t), t}))})).filter(x => x.rows.length),
      onActivate: r => fx().toggle("type", r.t)});
    MX.charts.stacked({mount: "ov-prov", kicker: "Provenance", title: "Edges by provenance", unit: "edges", facet: "prov", labelHead: "Provenance", valueHead: "Edges",
      segs: D.provs.map((p, k) => ({key: p, label: p, value: c.prov[k], pattern: Math.min(k, 2), pressed: F.prov.size < NP && F.prov.has(k), k})),
      onActivate: s => fx().toggle("prov", s.k)});
    const rels = D.rels.map((_, r) => r).sort((a, b) => c.rel[b] - c.rel[a] || a - b);
    MX.charts.bar({mount: "ov-rels", kicker: "Relationships", title: "Edges by relationship", unit: "edges", facet: "rel", labelHead: "Relationship", valueHead: "Edges",
      rows: rels.map(r => ({key: D.rels[r], label: D.rels[r], value: c.rel[r], pressed: !!F.rel && F.rel.has(r), r,
        segs: D.provs.map((p, k) => ({key: p, label: p, value: c.relProv[r * NP + k], pattern: Math.min(k, 2)}))})),
      onActivate: x => fx().toggle("rel", x.r)});
    const thr = F.deg > 0 ? fx().degBin(F.deg) : -1;
    MX.charts.hist({mount: "ov-degree", kicker: "Connectivity", title: "Degree distribution (powers-of-two bins)", unit: "nodes", labelHead: "Degree", valueHead: "Nodes",
      bins: Array.from(c.degBin, (v, b) => ({key: String(b), label: binLabel(b), value: v, b,
        dim: b === 0 ? !F.orphans : Math.pow(2, b) - 1 < F.deg, pressed: b === 0 ? F.orphans : b === thr,
        href: b === 0 ? "#orphans=1" : "#deg=" + fx().binLow(b)})),
      onActivate: x => (x.b === 0 ? fx().setFacet("orphans", !F.orphans) : fx().setFacet("deg", x.pressed ? 0 : fx().binLow(x.b)))});
    MX.charts.bar({mount: "ov-folders", kicker: "Files", title: "Files by folder (top 10)", unit: "files", toggle: false, labelHead: "Folder", valueHead: "Files",
      rows: folders().map(([f, v]) => ({key: f, label: f, value: v, href: "#view=tables"})), onActivate: r => openFolder(r.key)});
    const hb = hubs(20);
    $("ov-hubs").innerHTML = secHead("Hubs", "Top 20 hubs") + `<table class="tbl"><caption class="sr-only">Top 20 visible nodes by degree</caption>` +
      `<thead><tr><th scope="col" class="num">#</th><th scope="col">Node</th><th scope="col">Type</th><th scope="col" class="num">Degree</th><th scope="col">Community</th></tr></thead><tbody>` +
      hb.map((i, r) => `<tr><td class="num rank">${r + 1}</td><td class="wrap">${nodeLink(i)}</td><td>${esc(D.types[g.type[i]])}</td>` +
        `<td class="num">${fmt(g.deg[i])}</td><td class="wrap">${esc(commName(g.comm[i]))}</td></tr>`).join("") + "</tbody></table>";
    renderBuild();
  }
  // Universe tile row + per-cluster bar. Mounts are created here (template.html belongs to another node)
  // unless the template already has them.
  function universeMounts() {
    if (!uni()) return false;
    if (!$("ov-universe")) { const t = document.createElement("div"); t.id = "ov-universe"; t.className = "tiles"; $("ov-kpis").after(t); }
    if (!$("ov-ucl")) { const c = document.createElement("div"); c.id = "ov-ucl"; c.className = "card"; $("ov-folders").before(c); }
    return true;
  }
  const clusterTypes = c => stats().groupTypes[c] || [];
  const clusterOn = c => { const ts = clusterTypes(c); return !!F.type && ts.length > 0 && F.type.size === ts.length && ts.every(t => F.type.has(t)); };
  function pickCluster(c) { fx().setFacet("type", clusterOn(c) ? null : new Set(clusterTypes(c))); }
  function universeCounts() {                       // totals from the payload hierarchy; shown = under the current facets
    const u = uni(), nv = S.nodeVisible, nc = D.groups.length;
    const tot = {sun: 0, planet: 0, dust: 0}, vis = {sun: 0, planet: 0, dust: 0};
    const cl = Array.from({length: nc}, () => [0, 0, 0]), cs = new Set(), gs = new Set(), ss = new Set(), gAll = new Set();
    for (let i = 0; i < N; i++) {
      const r = u.roleOf(i);
      tot[ROLE[r]]++; gAll.add(u.galaxyOf(i));
      if (!nv[i]) continue;
      vis[ROLE[r]]++; cs.add(g.group[i]); gs.add(u.galaxyOf(i)); if (u.systemOf(i) >= 0) ss.add(u.systemOf(i));
      if (g.group[i] < nc) cl[g.group[i]][r]++;
    }
    return {tot, vis, cl, clusters: u.clusters.length, galaxies: u.galaxies.length, systems: u.systems.length,
            shown: {clusters: cs.size, galaxies: gs.size, systems: ss.size}};
  }
  function renderUniverse() {
    const c = universeCounts(), sub = (v, w) => fmt(v) + " shown" + (w ? " · " + w : "");
    MX.charts.tiles("ov-universe", [
      {key: "clusters", label: "Clusters", value: c.clusters, sub: sub(c.shown.clusters, "groups"), ratio: ratio(c.shown.clusters, c.clusters)},
      {key: "galaxies", label: "Galaxies", value: c.galaxies, sub: sub(c.shown.galaxies, "types"), ratio: ratio(c.shown.galaxies, c.galaxies)},
      {key: "systems", label: "Solar systems", value: c.systems, sub: sub(c.shown.systems, "suns"), ratio: ratio(c.shown.systems, c.systems)},
      {key: "planets", label: "Planets", value: c.tot.planet, sub: sub(c.vis.planet), ratio: ratio(c.vis.planet, c.tot.planet)},
      {key: "dust", label: "Dust", value: c.tot.dust, sub: sub(c.vis.dust, "unbound"), ratio: ratio(c.vis.dust, c.tot.dust)},
    ]);
    MX.charts.bar({mount: "ov-ucl", kicker: "Universe", title: "Bodies by cluster (visible)", unit: "bodies", labelHead: "Cluster", valueHead: "Bodies",
      desc: `${c.clusters} clusters; each bar splits suns, planets and dust; a click shows only that cluster's galaxies`,
      rows: D.groups.map((name, j) => ({key: name, label: name, value: c.cl[j][0] + c.cl[j][1] + c.cl[j][2], pressed: clusterOn(j), c: j,
        segs: [{key: "suns", label: "Suns", value: c.cl[j][0], pattern: 0},
               {key: "planets", label: "Planets", value: c.cl[j][1], pattern: 1},
               {key: "dust", label: "Dust", value: c.cl[j][2], pattern: 2}]})),
      onActivate: r => pickCluster(r.c)});
  }
  function renderBuild() {
    const s = D.stats || {}, b = s.build, o = s.out || {}, sd = s.searchDb;
    const num = v => (typeof v === "number" ? [String(v), fmt(v)] : ["", "—"]);
    const size = v => (typeof v === "number" ? [String(v), v >= 1048576 ? (v / 1048576).toFixed(1) + " MB" : (v / 1024).toFixed(1) + " KB"] : ["", "—"]);
    const when = sd && typeof sd.built === "number" ?
      [String(Math.round(sd.built)), new Date(sd.built * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" + (sd.fresh ? " · fresh" : " · stale")] : ["", "—"];
    const rows = [["generated", "Graph generated", ["", D.generated || "—"]],
      ["files_scanned", "Files scanned", num(b && b.files_scanned)], ["files_parsed", "Files parsed", num(b && b.files_parsed)],
      ["files_cached", "Files from cache", num(b && b.files_cached)], ["search_docs", "Search documents", num(sd && sd.docs)],
      ["search_built", "Search index built", when], ["size_graph_json", "graph.json", size(o["graph.json"])],
      ["size_search_db", "search.db", size(o["search.db"])], ["size_cache_json", "cache.json", size(o["cache.json"])]];
    $("ov-build").innerHTML = secHead("Build", "Build facts") + `<dl class="facts">` + rows.map(([k, l, [v, t]]) =>
      `<dt>${esc(l)}</dt><dd data-key="${k}" data-value="${esc(v)}">${esc(t)}</dd>`).join("") + "</dl>";
  }

  // ---- Claims ----------------------------------------------------------------------------
  let clT = null;
  function setTier(t) { S.dash.tier = t; renderPanel("claims", true); MX.status(); }
  function renderClaims(pane) {
    const st = stats(), cl = claimRows();
    scope(pane);
    const none = !st.kpis.claims, tl = $("cl-tiers");
    if (tl) tl.hidden = none;
    if (none) {
      $("cl-table").innerHTML = secHead("Ledger", "No claims") + `<p class="dash-note">Nothing indexed as a claim yet. ` +
        `Claims are markdown headings of the form <code>### [TIER] ABC-DEF-001 - statement</code>.</p>`;
      return;
    }
    MX.charts.tiles("cl-tiers", [{key: "all", label: "All claims", value: cl.rows.length, sub: "of " + fmt(st.kpis.claims) + " total",
      pressed: !S.dash.tier, onActivate: () => setTier(null), ratio: ratio(cl.rows.length, st.kpis.claims)}].concat(TIERS.map(t => ({key: t, label: t, value: cl.tiers[t] || 0,
      sub: "of " + fmt(st.claimTier[t] || 0) + " total", pressed: S.dash.tier === t, onActivate: () => setTier(S.dash.tier === t ? null : t),
      ratio: ratio(cl.tiers[t] || 0, cl.rows.length)}))));
    const box = $("cl-table");
    if (!clT) {
      box.innerHTML = secHead("Ledger", "Claims", `<input id="cl-filter" type="search" aria-label="Filter claims" placeholder="Filter claims…">`) + `<div id="cl-tbl"></div>`;
      const tier = i => st.tierOf[i], meta = i => g.meta.get(i) || {};
      clT = MX.tables.make({mount: "cl-tbl", caption: () => "Claims" + (S.dash.tier ? " · " + S.dash.tier : ""),
        filterInput: $("cl-filter"), sort: {key: "tier", dir: "asc"}, rows: () => claimRows().rows.filter(i => !S.dash.tier || tier(i) === S.dash.tier),
        rowClass: i => (tier(i) === "RETRACTED" ? "row-retracted" : ""),
        cols: [
          {key: "claim", label: "Claim", get: i => g.label[i], cell: nodeLink, cls: "nowrap mono"},
          {key: "tier", label: "Tier", get: i => (tier(i) in RANK ? RANK[tier(i)] : 9), text: tier, dir0: "asc",
           cell: i => (tier(i) ? `<span class="badge badge--tier-${esc(tier(i))}">${esc(tier(i))}</span>` : "")},
          {key: "statement", label: "Statement", cls: "stmt", get: i => meta(i).statement || "",
           cell: i => `<span class="stmt-t${tier(i) === "RETRACTED" ? " retracted" : ""}">${esc(meta(i).statement || "")}</span>`},
          {key: "file", label: "File:line", cls: "path", get: i => (g.file[i] || "") + (g.line[i] ? ":" + g.line[i] : ""),
           cell: i => pathCell(g.file[i], g.line[i])},
          {key: "degree", label: "Degree", num: 1, get: i => g.deg[i]},
        ]});
    } else clT.refresh();
  }

  // ---- Communities -------------------------------------------------------------------------
  let cmT = null, cmCounts = null;
  function renderCommunities(pane) {
    const st = stats(), c = fx().counts();
    cmCounts = c.comm;
    scope(pane);
    prime(["cm-sizes"]);
    note(pane, "Bars filter by community; a community name shows it alone in the graph.");
    const top = D.communities.map((_, k) => k).sort((a, b) => c.comm[b] - c.comm[a] || st.commSize[b] - st.commSize[a] || a - b).slice(0, 20);
    MX.charts.bar({mount: "cm-sizes", kicker: "Distribution", title: "Largest communities (top 20 by shown nodes)", unit: "nodes", facet: "comm", cap: true,
      labelHead: "Community", valueHead: "Nodes shown",
      rows: top.map(k => ({key: D.communities[k], label: D.communities[k], value: c.comm[k], pressed: !!F.comm && F.comm.has(k), k})),
      onActivate: r => fx().toggle("comm", r.k)});
    if (!cmT) {
      $("cm-table").innerHTML = secHead("Index", "All communities", `<input id="cm-filter" type="search" aria-label="Filter communities" placeholder="Filter communities…">`) + `<div id="cm-tbl"></div>`;
      cmT = MX.tables.make({mount: "cm-tbl", caption: "All communities", filterInput: $("cm-filter"), sort: {key: "size", dir: "desc"},
        rows: () => D.communities.map((_, k) => k),
        cols: [
          {key: "name", label: "Community", get: k => D.communities[k], cls: "wrap",
           cell: k => `<a href="#comm=${esc(E(D.communities[k]))}" title="Show in graph: ${esc(D.communities[k])}">${esc(D.communities[k])}</a>`},
          {key: "size", label: "Size", num: 1, get: k => st.commSize[k]},
          {key: "shown", label: "Shown", num: 1, get: k => cmCounts[k]},
          {key: "claims", label: "Claims", num: 1, get: k => st.commClaims[k]},
          {key: "types", label: "Top types", get: k => st.commTopTypes[k], cls: "wrap soft"},
          {key: "hub", label: "Hub", get: k => (st.commHub[k] >= 0 ? g.label[st.commHub[k]] : ""), cls: "wrap",
           cell: k => (st.commHub[k] >= 0 ? nodeLink(st.commHub[k]) : "—")},
          {key: "fly", label: "Graph", nosort: 1, get: () => "", text: () => "",
           cell: k => `<button type="button" class="btn-sm" data-act="fly-comm" data-k="${k}" aria-label="Fly to community ${esc(D.communities[k])} in the graph">Fly to</button>`},
        ]});
    } else cmT.refresh();
  }

  // ---- Tables (Nodes / Edges) ---------------------------------------------------------------
  let tbT = null, tbKind = "";
  const memoSort = {nodes: {key: "degree", dir: "desc"}, edges: {key: "weight", dir: "desc"}};
  function nodeRows() {
    const out = [], q = !!S.q, mm = S.matchMask, nv = S.nodeVisible;
    for (let i = 0; i < N; i++) if (nv[i] && (!q || mm[i])) out.push(i);
    return out;
  }
  function edgeRows() {
    const out = [], q = !!S.q, mm = S.matchMask, ev = S.edgeVisible;
    for (let k = 0; k < M; k++) if (ev[k] && (!q || mm[g.src[k]] || mm[g.dst[k]])) out.push(k);
    return out;
  }
  const NODE_COLS = [
    {key: "node", label: "Node", get: i => g.label[i], cell: nodeLink, cls: "wrap"},
    {key: "cluster", label: "Cluster", get: i => D.groups[g.group[i]] || "", cls: "nowrap",
     cell: i => `<span class="swatch--dot" data-group="${g.group[i] & 3}"></span> ${esc(D.groups[g.group[i]] || "")}`},
    {key: "galaxy", label: "Galaxy", get: i => D.types[g.type[i]], cls: "nowrap soft"},
    {key: "system", label: "System", get: sysLabel, cls: "wrap", cell: i => { const s = sunOfNode(i); return s >= 0 ? nodeLink(s) : "—"; }},
    {key: "role", label: "Role", get: roleOf, cls: "nowrap soft"},
    {key: "degree", label: "Degree", num: 1, get: i => g.deg[i]},
    {key: "community", label: "Community", get: i => commName(g.comm[i]), cls: "wrap soft"},
    {key: "file", label: "File", get: i => g.file[i] || "", cls: "path", cell: i => pathCell(g.file[i])},
    {key: "tier", label: "Tier", get: i => stats().tierOf[i],
     cell: i => { const t = stats().tierOf[i]; return t ? `<span class="badge badge--tier-${esc(t)}">${esc(t)}</span>` : ""; }},
  ];
  const EDGE_COLS = [
    {key: "src", label: "Source", get: k => g.label[g.src[k]], cell: k => nodeLink(g.src[k]), cls: "wrap"},
    {key: "rel", label: "Rel", get: k => D.rels[g.rel[k]], cls: "nowrap mono"},
    {key: "dst", label: "Target", get: k => g.label[g.dst[k]], cell: k => nodeLink(g.dst[k]), cls: "wrap"},
    {key: "prov", label: "Provenance", get: k => D.provs[g.prov[k]], cls: "nowrap",
     cell: k => `<span class="badge badge--prov-${g.prov[k]}">${esc(D.provs[g.prov[k]])}</span>`},
    {key: "weight", label: "Weight", num: 1, get: k => g.w[k]},
  ];
  function renderTables(pane) {
    scope(pane);
    const kind = S.dash.table === "edges" ? "edges" : "nodes";
    for (const [id, k] of [["tb-nodes", "nodes"], ["tb-edges", "edges"]]) { const b = $(id); if (b) b.setAttribute("aria-pressed", String(k === kind)); }
    const fin = $("tb-filter");
    if (fin && fin.value !== S.dash.filter) fin.value = S.dash.filter;
    if (!tbT || tbKind !== kind) {
      if (tbT) tbT.destroy();
      tbKind = kind;
      tbT = MX.tables.make({mount: "tb-table", caption: kind === "nodes" ? "Nodes" : "Edges", filterInput: fin, filter: S.dash.filter,
        sort: memoSort[kind], rows: kind === "nodes" ? nodeRows : edgeRows, cols: kind === "nodes" ? NODE_COLS : EDGE_COLS,
        onChange: s => { memoSort[kind] = s.sort; Object.assign(S.dash, {table: kind, sort: s.sort, page: s.page, filter: s.filter, rows: s.rows}); MX.status(); }});
    } else if (tbT.state.filter !== S.dash.filter) tbT.setFilter(S.dash.filter);
    else tbT.refresh();
  }
  function setTable(kind) { S.dash.table = kind; S.dash.page = 0; renderPanel("tables", true); }
  function openFolder(f) {
    const was = S.view;
    S.dash.table = "nodes"; S.dash.filter = f === "Other" ? "" : f + "/";
    setView("tables", {focus: true});
    if (was === "tables") renderPanel("tables", true);
  }

  // ---- panel dispatch: re-render only when the slice changed ------------------------------
  const RENDER = {overview: renderOverview, claims: renderClaims, communities: renderCommunities, tables: renderTables};
  let visGen = 0;
  const last = {};
  const sig = v => [visGen, [...F.prov].join(), F.type && [...F.type].join(), F.comm && [...F.comm].join(),
    F.rel && [...F.rel].join(), F.orphans, F.deg, v === "tables" || v === "claims" ? S.q + "|" + S.dash.tier : ""].join("/");
  function renderPanel(v, force) {
    const pane = PANE[v] && $(PANE[v]);
    if (!pane || !MX.charts || !MX.tables) return;
    const s = sig(v);
    if (!force && s === last[v]) return;
    last[v] = s;
    const ae = document.activeElement, host = ae && pane.contains(ae) ? ae.closest("[id]") : null;
    const sel = host && ae !== host ? (ae.dataset.key != null ? `[data-key="${CSS.escape(ae.dataset.key)}"]`
      : ae.dataset.act ? `[data-act="${ae.dataset.act}"]` : ae.getAttribute("href") ? `a[href="${CSS.escape(ae.getAttribute("href"))}"]` : null) : null;
    RENDER[v](pane);
    markSel();
    if (sel && !ae.isConnected) { const el = host.querySelector(sel); if (el) el.focus({preventScroll: true}); }
  }

  // ---- selected row: a 1px ring on rows whose first node link is the selection (no re-render)
  function markSel() {
    const pane = PANE[S.view] && $(PANE[S.view]);
    if (!pane) return;
    for (const tr of pane.querySelectorAll("tr.is-sel")) tr.classList.remove("is-sel");
    if (S.selected < 0) return;
    const href = "#n=" + E(g.id[S.selected]);
    for (const a of pane.querySelectorAll(`tbody tr > td:first-child a[href="${CSS.escape(href)}"], tbody tr > td.rank + td a[href="${CSS.escape(href)}"]`)) a.closest("tr").classList.add("is-sel");
  }

  // ---- wide mode: an empty inspector folds away on dashboard tabs ("the inspector opens" on select).
  // Charts are re-rendered at once at the new width, so their ResizeObserver has nothing to redo.
  function wide() {
    const on = S.view !== "graph" && S.selected < 0 && !S.focus && !S.path;
    if (document.body.classList.contains("dash-wide") === on) return;
    document.body.classList.toggle("dash-wide", on);
    if (S.view !== "graph") renderPanel(S.view, true);
  }

  // ---- tabs (APG vertical tablist, automatic activation) -----------------------------------
  const tabOf = v => $("tab-" + v);
  function setView(v, opts) {
    v = canon(String(v == null ? "graph" : v));
    if (!VIEWS.includes(v)) { MX.warn("view: unknown " + v); v = "graph"; }
    const focus = () => { if (opts && opts.focus) { const t = tabOf(v); if (t) t.focus(); } };
    if (v === S.view) { focus(); return; }
    S.view = v;
    if (v !== "graph") S.dash.lastTab = v;
    for (const w of VIEWS) {
      const t = tabOf(w);
      if (t) { t.setAttribute("aria-selected", String(w === v)); t.tabIndex = w === v ? 0 : -1; }
      const p = PANE[w] && $(PANE[w]);
      if (p) p.hidden = w !== v;
    }
    const pg = $("pane-graph");
    if (pg) pg.inert = v !== "graph";
    document.body.classList.toggle("dash-wide", v !== "graph" && S.selected < 0 && !S.focus && !S.path);
    if (v !== "graph") renderPanel(v, true);
    focus();
    MX.emit("view");
    MX.status();
  }
  function bindTabs() {
    const list = $("view");
    if (!list) return;
    list.addEventListener("click", e => { const t = e.target.closest("[role=tab]"); if (t) setView(t.id.slice(4), {focus: true}); });
    list.addEventListener("keydown", e => {
      const t = e.target.closest("[role=tab]");
      if (!t || e.altKey || e.ctrlKey || e.metaKey) return;
      const tabs = [...list.querySelectorAll("[role=tab]")], i = tabs.indexOf(t);
      const j = {ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1}[e.key];
      if (j === undefined) return;
      e.preventDefault();
      setView(tabs[(j + tabs.length) % tabs.length].id.slice(4), {focus: true});
    });
  }
  // Communities "Fly to": show the community alone, open the graph, then ask the camera owner to fly to its hub
  // ("flyreq" is a request; the renderer answers with its own "flyto" effect event).
  function flyComm(k) {
    fx().setFacet("comm", new Set([k]));
    setView("graph");
    MX.emit("flyreq", {kind: "community", k, hub: stats().commHub[k]});
  }
  function bindChrome() {
    const btn = $("filters-toggle"), rail = $("filters");
    if (btn && rail) {
      const open = on => {
        rail.hidden = !on; btn.setAttribute("aria-expanded", String(on)); MX.emit("chrome");
        if (S.view !== "graph") renderPanel(S.view, true);
      };
      if (matchMedia("(max-width: 1100px)").matches) open(false);
      btn.addEventListener("click", () => open(rail.hidden));
    }
    const main = document.querySelector("main");
    if (main) main.addEventListener("click", e => {
      const b = e.target.closest("[data-act]");
      if (!b) {                                   // a click on a row's blank space opens its node, like its link
        const tr = e.target.closest(".pane tbody tr");
        if (!tr || e.target.closest("a, button, input, summary") || e.button !== 0 || (getSelection() + "")) return;
        const a = tr.querySelector('a[href^="#n="]');
        if (a) a.click();
        return;
      }
      if (b.dataset.act === "fly-comm") flyComm(+b.dataset.k);
      else if (b.dataset.act === "reset-filters") { const r = $("reset-filters"); if (r) r.click(); }
      else if (b.dataset.act === "clear-search") {
        const s = $("search"); if (s) s.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", cancelable: true}));
      }
    });
    const tn = $("tb-nodes"), te = $("tb-edges");
    if (tn) tn.addEventListener("click", () => setTable("nodes"));
    if (te) te.addEventListener("click", () => setTable("edges"));
  }

  MX.dash = {setView, stats, refresh: () => renderPanel(S.view, true)};
  MX.module("dash", () => {
    bindTabs();
    bindChrome();
    MX.on("visibility", () => { visGen++; });
    for (const ev of ["select", "focus", "path"]) MX.on(ev, wide);
    MX.on("select", markSel);
    MX.on("facets", () => renderPanel(S.view, false));
    MX.on("query", () => { if (S.view === "tables" || S.view === "claims") renderPanel(S.view, false); });
  });

  // ---- self-tests (tabs.*, charts.*, tables.*) ------------------------------
  const fail = m => { throw new Error(m); }, skip = r => MX.selftest.skip(r);   // skip: data absent -> n/a
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const press = (el, key) => el.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles: true, cancelable: true}));
  const click = el => el.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, button: 0}));
  const marks = id => [...$(id).querySelectorAll("a.mark")].map(a => [a.dataset.key, +a.dataset.value, a]);
  function guard(fn) {
    return async () => {
      const v = S.view, t = S.dash.table, f = S.dash.filter, tier = S.dash.tier;
      try { await fn(); } finally {
        S.dash.tier = tier;
        if (S.dash.table !== t || S.dash.filter !== f) { S.dash.table = t; S.dash.filter = f; if (S.view === "tables") renderPanel("tables", true); }
        setView(v);
      }
    };
  }
  MX.selftest.add("tabs.switch", guard(async () => {
    for (const v of VIEWS) {
      tabOf(v).click();
      if (S.view !== v) fail("click " + v + " -> view " + S.view);
      for (const w of VIEWS) {
        if (tabOf(w).getAttribute("aria-selected") !== String(w === v)) fail("aria-selected " + w);
        if (tabOf(w).tabIndex !== (w === v ? 0 : -1)) fail("tabindex " + w);
        if (PANE[w] && $(PANE[w]).hidden !== (w !== v)) fail("hidden " + w + " on " + v);
      }
      if ($("pane-graph").inert !== (v !== "graph")) fail("inert on " + v);
      const h = fx().hash.serialize(fx().hash.state());
      if (v === "graph" ? /view=/.test(h) : !new RegExp("(^|&)view=" + v + "($|&)").test(h)) fail("hash " + h);
    }
    tabOf("claims").click();
    await wait(220);
    if (!/(^#|&)view=claims(&|$)/.test(location.hash)) fail("location.hash " + location.hash);
    setView("table");
    if (S.view !== "tables") fail("alias table -> " + S.view);
  }));
  MX.selftest.add("tabs.keys", guard(() => {
    setView("graph");
    tabOf("graph").focus();
    const step = (k, want) => {
      press(document.activeElement, k);
      if (S.view !== want || document.activeElement !== tabOf(want)) fail(k + " -> " + S.view + " / " + (document.activeElement || {}).id);
    };
    step("ArrowDown", "overview"); step("End", "tables"); step("Home", "graph"); step("ArrowUp", "tables"); step("ArrowDown", "graph");
  }));
  MX.selftest.add("charts.values", guard(() => {
    setView("overview");
    const c = fx().counts(), k = stats().kpis;
    const check = (id, arr, n, key) => {
      const ms = marks(id);
      if (n != null && ms.length !== n) fail(id + " marks " + ms.length + " != " + n);
      for (const [kk, v] of ms) if (v !== arr[key(kk)]) fail(id + " " + kk + " " + v + " != " + arr[key(kk)]);
    };
    check("ov-types", c.type, NT, x => D.types.indexOf(x));
    check("ov-prov", c.prov, NP, x => D.provs.indexOf(x));
    check("ov-rels", c.rel, D.rels.length, x => D.rels.indexOf(x));
    check("ov-degree", c.degBin, c.degBin.length, x => +x);
    for (const [kk, v, a] of marks("ov-rels")) {
      const s = [...a.querySelectorAll("[data-n]")].reduce((t, p) => t + +p.dataset.n, 0);
      if (s !== v) fail("rel " + kk + " segments " + s + " != " + v);
    }
    for (const t of $("ov-kpis").querySelectorAll("[data-key]")) if (+t.dataset.value !== k[t.dataset.key]) fail("kpi " + t.dataset.key);
    setView("communities");
    check("cm-sizes", c.comm, Math.min(20, NC), x => D.communities.indexOf(x));
  }));
  MX.selftest.add("charts.filterClick", guard(() => {
    const saved = F.type && new Set(F.type);
    try {
      if (F.type) fx().setFacet("type", null);
      setView("overview");
      const prov = () => marks("ov-prov").map(m => m[1]), before = prov().join();
      const mark = () => $("ov-types").querySelector('a.mark[data-key="claim"]');
      if (!mark()) skip("no claim nodes to filter by");
      click(mark());
      if (!F.type || F.type.size !== 1 || !F.type.has(T_CLAIM)) fail("F.type " + (F.type && [...F.type]));
      if (mark().getAttribute("aria-pressed") !== "true") fail("claim mark not pressed");
      const after = prov(), c = fx().counts();
      if (after.join() !== Array.from(c.prov).join()) fail("prov " + after + " != " + Array.from(c.prov));
      if (after.join() === before) fail("prov unchanged under type=claim");
      click(mark());
      if (F.type) fail("second click left F.type " + [...F.type]);
      if (mark().getAttribute("aria-pressed") !== "false" || prov().join() !== before) fail("second click did not restore");
    } finally { if (saved) fx().setFacet("type", saved); }
  }));
  function onNodes() {
    S.dash.filter = ""; setView("tables");
    if (S.dash.table !== "nodes") setTable("nodes"); else renderPanel("tables", true);
    if (tbT.state.filter) tbT.setFilter("");
    return tbT;
  }
  const bodyRows = () => $("tb-table").querySelectorAll("tbody tr");
  MX.selftest.add("tables.sort", guard(() => {
    const t = onNodes();
    t.setSort({key: "degree", dir: "desc"});
    const btn = () => $("tb-table").querySelector('button[data-sort="degree"]');
    const mono = dir => { const o = t.order(); for (let r = 1; r < o.length; r++) if (dir * (g.deg[o[r]] - g.deg[o[r - 1]]) < 0) fail(dir + " order at " + r); };
    for (const [dir, aria] of [[1, "ascending"], [-1, "descending"]]) {
      click(btn());
      const ths = $("tb-table").querySelectorAll("th[aria-sort]");
      if (ths.length !== 1 || ths[0].getAttribute("aria-sort") !== aria || !/Degree/.test(ths[0].textContent)) fail("aria-sort " + aria);
      mono(dir);
    }
  }));
  MX.selftest.add("tables.filter", guard(async () => {
    const t = onNodes(), rows = nodeRows(), lbl = g.label[t.order()[0]] || "a";
    if (rows.length < 2) skip("fewer than 2 node rows to narrow");
    const sub = lbl.slice(0, Math.min(5, lbl.length)).toLowerCase();
    const want = rows.filter(i => NODE_COLS.some(c => !c.num && String(c.get(i)).toLowerCase().includes(sub))).length;
    const inp = $("tb-filter");
    inp.value = sub; inp.dispatchEvent(new Event("input", {bubbles: true}));
    await wait(220);
    if (t.state.rows !== want) fail("rows " + t.state.rows + " != " + want + " for '" + sub + "'");
    if (bodyRows().length !== Math.min(500, want)) fail("tbody " + bodyRows().length);
    if (want >= rows.length) fail("filter did not narrow");
    inp.value = ""; inp.dispatchEvent(new Event("input", {bubbles: true}));
    await wait(220);
    if (t.state.rows !== rows.length) fail("clear did not restore");
  }));
  MX.selftest.add("tables.page", guard(() => {
    const t = onNodes();
    if (t.state.rows <= 500) skip("needs > 500 rows, have " + t.state.rows);
    click($("tb-table").querySelector('button[data-pg="1"]'));
    const pt = $("tb-table").querySelector(".pager").textContent, first = bodyRows()[0].querySelector("a");
    if (!pt.includes("Rows 501–" + fmt(Math.min(1000, t.state.rows)))) fail("pager " + pt);
    if (first.getAttribute("href") !== "#n=" + E(g.id[t.order()[500]])) fail("row 501 " + first.getAttribute("href"));
    click($("tb-table").querySelector('button[data-pg="-1"]'));
    if (t.state.page !== 0) fail("prev");
  }));
  MX.selftest.add("tables.total", guard(() => {
    const total = (kind, want) => {
      if (kind !== tbKind) setTable(kind);
      tbT.setFilter(""); tbT.setPage(0);
      let sum = bodyRows().length, nx;
      while ((nx = $("tb-table").querySelector('button[data-pg="1"]')) && !nx.disabled) { click(nx); sum += bodyRows().length; }
      if (sum !== want) fail(kind + " rows " + sum + " != " + want);
    };
    onNodes();
    total("nodes", S.q ? nodeRows().length : S.nodesShown);
    total("edges", S.q ? edgeRows().length : S.edgesShown);
    setTable("nodes");
  }));
  // payload.universe recomputed here from MX.g + D.universe only (never through MX.universe)
  const PU = () => D.universe && D.universe.sys && D.universe.sys.length === N ? D.universe : null;
  const puRole = (pu, i) => (pu.sys[i] < 0 ? "dust" : pu.sun[pu.sys[i]] === i ? "sun" : "planet");
  MX.selftest.add("dash.universeTiles", guard(() => {
    const pu = PU();
    if (!N) skip("no nodes");
    if (!pu) fail("no payload.universe");
    setView("overview");
    const sys = pu.sun.length, planets = pu.sys.reduce((a, s) => a + (s >= 0 ? 1 : 0), 0) - sys, dust = pu.sys.reduce((a, s) => a + (s < 0 ? 1 : 0), 0);
    const gal = new Set(); for (let i = 0; i < N; i++) gal.add(g.group[i] + "/" + g.type[i]);
    const want = {clusters: pu.clusters.length, galaxies: gal.size, systems: sys, planets, dust};
    const tiles = $("ov-universe").querySelectorAll("[data-key]");
    if (tiles.length !== 5) fail("tiles " + tiles.length);
    for (const t of tiles) if (+t.dataset.value !== want[t.dataset.key]) fail(t.dataset.key + " " + t.dataset.value + " != " + want[t.dataset.key]);
    if (sys + planets + dust !== N) fail("roles do not partition the nodes");
    const vis = D.groups.map(() => 0);
    for (let i = 0; i < N; i++) if (S.nodeVisible[i]) vis[g.group[i]]++;
    const ms = marks("ov-ucl");
    if (ms.length !== D.groups.length) fail("cluster marks " + ms.length);
    for (const [k, v] of ms) if (v !== vis[D.groups.indexOf(k)]) fail("cluster " + k + " " + v + " != " + vis[D.groups.indexOf(k)]);
    for (const [k, v, a] of ms) {
      const sum = [...a.querySelectorAll("[data-n]")].reduce((t, p) => t + +p.dataset.n, 0);
      if (sum !== v) fail("cluster " + k + " segments " + sum + " != " + v);
    }
    const saved = F.type && new Set(F.type);
    try {                                          // a click shows exactly that cluster's types, a second click restores
      fx().setFacet("type", null);
      const j = vis.findIndex(v => v > 0);
      if (j < 0) skip("no visible cluster to click");
      click($("ov-ucl").querySelector(`a.mark[data-key="${D.groups[j]}"]`));
      const ts = stats().groupTypes[j];
      if (!F.type || F.type.size !== ts.length || !ts.every(t => F.type.has(t))) fail("cluster click facet");
      click($("ov-ucl").querySelector(`a.mark[data-key="${D.groups[j]}"]`));
      if (F.type) fail("second click left F.type");
    } finally { fx().setFacet("type", saved); }
  }));
  MX.selftest.add("tables.universeCols", guard(() => {
    const pu = PU();
    if (!N) skip("no nodes");
    if (!pu) fail("no payload.universe");
    const t = onNodes();
    if (!t.state.rows) skip("no node rows shown");
    const heads = [...$("tb-table").querySelectorAll("thead th")].map(th => th.textContent.replace(/[▲▼]/g, "").trim());
    for (const h of ["Cluster", "Galaxy", "System", "Role"]) if (!heads.includes(h)) fail("missing column " + h + " in " + heads);
    if (heads.includes("Group") || heads.includes("Type")) fail("old column names remain: " + heads);
    const cell = (tr, h) => tr.children[heads.indexOf(h)].textContent.trim();
    const check = (tr, i) => {
      const sun = pu.sys[i] >= 0 ? g.label[pu.sun[pu.sys[i]]] : "—";
      const got = [cell(tr, "Cluster"), cell(tr, "Galaxy"), cell(tr, "System"), cell(tr, "Role")].join("|");
      const exp = [D.groups[g.group[i]], D.types[g.type[i]], sun, puRole(pu, i)].join("|");
      if (got !== exp) fail("row " + g.id[i] + ": " + got + " != " + exp);
    };
    t.setSort({key: "degree", dir: "desc"});
    const rows = bodyRows(), o = t.order();
    for (let r = 0; r < Math.min(rows.length, 5); r++) check(rows[r], o[r]);
    t.setSort({key: "role", dir: "asc"});
    const o2 = t.order(), rank = i => puRole(pu, i);
    for (let r = 1; r < o2.length; r++) if (rank(o2[r - 1]) > rank(o2[r])) fail("role order at " + r);
    check(bodyRows()[0], o2[0]);
    const dust = o2.find(i => rank(i) === "dust");
    if (dust != null && sysLabel(dust) !== "—") fail("dust system label");
    t.setSort({key: "system", dir: "asc"});
    const o3 = t.order();
    for (let r = 1; r < o3.length; r++) if (coll_(sysLabel(o3[r - 1]), sysLabel(o3[r])) > 0) fail("system order at " + r);
    const sun = o3.find(i => puRole(pu, i) === "sun");
    if (sun != null) {                              // text filter reaches the new columns
      t.setFilter(g.label[sun]);
      if (!t.order().includes(sun)) fail("filter by system label lost the sun");
    }
  }));
  const coll_ = new Intl.Collator("en", {numeric: true, sensitivity: "base"}).compare;
})();
