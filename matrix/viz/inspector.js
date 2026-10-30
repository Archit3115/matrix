(function () {
  "use strict";
  // Inspector panel, pins, ego focus and path finder.
  // Sole writer of state.selected / pinned / focus / path.
  const g = MX.g, S = MX.state, D = g.D, N = g.N;
  const panel = document.getElementById("panel");
  const esc = MX.esc, fmt = MX.fmt;
  const PEERS = 25;          // rows per rel group before "Show all"
  const EXPAND = 10;         // hidden neighbours pinned per "Show top N"
  const PATH_CAP = 20;       // hop cap for the path finder
  const EGO_CAP = 2000;      // ego size cap for >= 2 hops
  const DIRS = ["out", "in", "both"];

  // panel-local UI state; reset when the selection changes
  let focusDir = "both", extractedOnly = false, pickerOpen = false;
  let expanded = new Set(), closed = new Set();
  let busy = 0;              // >0 while we emit: our own visibility echo must not re-render

  const nodeHref = i => "#n=" + encodeURIComponent(g.id[i]);
  const link = i => "<a href='" + esc(nodeHref(i)) + "' data-i='" + i + "'>" + esc(g.label[i]) + "</a>";
  const typeName = i => D.types[g.type[i]];
  const links = i => g.adjOff[i + 1] - g.adjOff[i];
  const provBadge = p => "<span class='badge badge--prov-" + p + "'>" + esc(D.provs[p].toLowerCase()) + "</span>";
  const btn = (act, text, extra) => "<button type='button' data-act='" + act + "'" + (extra || "") + ">" + text + "</button>";
  const pressed = on => " aria-pressed='" + (on ? "true" : "false") + "'";
  // provenance as line grammar: a 14px solid / dashed / dotted rule; the word stays for screen readers
  const provMark = p => "<span class='pv' data-prov='" + p + "' title='" + esc(D.provs[p].toLowerCase()) + "' aria-hidden='true'></span>";
  const provSr = p => "<span class='sr-only'>" + esc(D.provs[p].toLowerCase()) + "</span>";

  function emit(evt, d) { busy++; try { MX.emit(evt, d); } finally { busy--; } }

  // file "<root label>/<rest>" -> file:///<root path>/<rest>, per-segment encoded; null if no root
  function fileHref(f) {
    const cut = f.indexOf("/"), root = cut > 0 && D.roots ? D.roots[f.slice(0, cut)] : null;
    if (typeof root !== "string" || !root) return null;
    const segs = (root.replace(/\\/g, "/").replace(/\/+$/, "") + f.slice(cut)).split("/");
    const href = "file:///" + segs.map((s, k) =>
      k === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)).join("/").replace(/^\/+/, "");
    return /^file:\/\/\//.test(href) ? href : null;
  }

  // ---- ego focus (BFS over edges passing prov/rel facets) ----
  function facetKey() {
    const F = S.facets;
    return [...F.prov].sort().join(",") + "|" + (F.rel ? [...F.rel].sort().join(",") : "*");
  }
  function ego(r, hops, dir) {
    const F = S.facets, lvl = new Int8Array(N).fill(-1), order = [r];
    lvl[r] = 0;
    for (let h = 0, from = 0; h < hops; h++) {
      const to = order.length;
      for (let q = from; q < to; q++) {
        const c = order[q];
        for (let a = g.adjOff[c]; a < g.adjOff[c + 1]; a++) {
          const e = g.adjEdge[a];
          if (!F.prov.has(g.prov[e]) || (F.rel && !F.rel.has(g.rel[e]))) continue;
          const out = g.src[e] === c;
          if ((dir === "out" && !out) || (dir === "in" && g.dst[e] !== c)) continue;
          const o = out ? g.dst[e] : g.src[e];
          if (lvl[o] < 0) { lvl[o] = h + 1; order.push(o); }
        }
      }
      from = to;
    }
    let keep = order, truncated = false;
    if (hops >= 2 && order.length > EGO_CAP) {
      truncated = true;
      const near = order.filter(i => lvl[i] <= 1);
      const far = order.filter(i => lvl[i] > 1)
        .sort((a, b) => lvl[a] - lvl[b] || g.deg[b] - g.deg[a] || a - b);
      keep = near.concat(far.slice(0, Math.max(0, EGO_CAP - near.length)));
    }
    const set = new Uint8Array(N);
    for (const i of keep) set[i] = 1;
    return {set, size: keep.length, truncated};
  }

  function setFocus(i, hops) {
    const e = ego(i, hops, focusDir);
    S.focus = {root: i, hops, dir: focusDir, set: e.set, size: e.size, truncated: e.truncated, key: facetKey()};
    emit("focus", S.focus);
    return e;
  }
  function focusOn(i, hops, dir) {
    if (!(i >= 0 && i < N)) return;
    hops = Math.max(1, Math.min(3, +hops || 1));
    if (dir && DIRS.includes(dir)) focusDir = dir;
    const prevSel = S.selected;
    S.path = null;
    S.selected = i;
    if (prevSel !== i) resetPanelState();
    const e = setFocus(i, hops);
    if (prevSel !== i) emit("select", i);
    frame(() => S.focus && S.focus.root === i ? visibleOf(S.focus.set) : null);
    render();
    MX.announce("Focus: " + fmt(e.size) + " nodes within " + hops + (hops > 1 ? " hops" : " hop") +
                " of " + g.label[i] + (e.truncated ? ", truncated" : ""));
    MX.status();
  }

  // Esc semantics: one call leaves both modes (path and focus are exclusive anyway)
  function clearFocus() {
    if (!S.focus && !S.path) return;
    const hadFocus = !!S.focus, hadPath = !!S.path;
    S.focus = null; S.path = null;
    if (hadFocus) emit("focus", null);
    if (hadPath) emit("path", null);
    render();
    MX.announce(hadPath ? "Path cleared" : "Focus cleared");
    MX.status();
  }
  function clearPath() {
    if (!S.path) return;
    S.path = null;
    emit("path", null);
    render();
    MX.announce("Path cleared");
    MX.status();
  }

  // ---- path: mirror of query.py cmd_path ------------------------------------
  // undirected BFS from a, neighbours visited in id order (Python str sort =
  // code-point order), first discovery wins; step label = the last edge in
  // graph order for (u->v), else the last for (v->u) marked reverse.
  let rank = null;
  function cpUnit(c) { return c >= 0xD800 ? (c <= 0xDFFF ? c + 0x2000 : c - 0x800) : c; }
  function cmpId(x, y) {
    const n = Math.min(x.length, y.length);
    for (let k = 0; k < n; k++) {
      const a = x.charCodeAt(k), b = y.charCodeAt(k);
      if (a !== b) return cpUnit(a) - cpUnit(b);
    }
    return x.length - y.length;
  }
  function ranks() {
    if (rank) return rank;
    const ord = Array.from({length: N}, (_, i) => i).sort((a, b) => cmpId(g.id[a], g.id[b]));
    rank = new Uint32Array(N);
    ord.forEach((i, k) => { rank[i] = k; });
    return rank;
  }
  function bfs(a, b, exOnly) {
    const rk = ranks(), parent = new Int32Array(N).fill(-2), depth = new Uint8Array(N);
    const stamp = new Int32Array(N).fill(-1), q = new Int32Array(N);
    let qh = 0, qt = 0;
    parent[a] = -1; q[qt++] = a;
    while (qh < qt) {
      const cur = q[qh++];
      if (cur === b) break;
      if (depth[cur] >= PATH_CAP) continue;
      const nb = [];
      for (let k = g.adjOff[cur]; k < g.adjOff[cur + 1]; k++) {
        const e = g.adjEdge[k];
        if (exOnly && g.prov[e] !== 0) continue;
        const o = g.src[e] === cur ? g.dst[e] : g.src[e];
        if (stamp[o] !== cur) { stamp[o] = cur; nb.push(o); }
      }
      nb.sort((x, y) => rk[x] - rk[y]);
      for (const o of nb) if (parent[o] === -2) { parent[o] = cur; depth[o] = depth[cur] + 1; q[qt++] = o; }
    }
    if (parent[b] === -2) return {nodes: [], edges: [], steps: [], found: false};
    const nodes = [];
    for (let c = b; c !== -1; c = parent[c]) nodes.push(c);
    nodes.reverse();
    const edges = [], steps = [];
    for (let s = 0; s + 1 < nodes.length; s++) {
      const u = nodes[s], v = nodes[s + 1];
      let fwd = -1, rev = -1;
      for (let k = g.adjOff[u]; k < g.adjOff[u + 1]; k++) {
        const e = g.adjEdge[k];
        if (exOnly && g.prov[e] !== 0) continue;
        if (g.src[e] === u && g.dst[e] === v) fwd = e;
        else if (g.src[e] === v && g.dst[e] === u) rev = e;
      }
      const e = fwd >= 0 ? fwd : rev;
      edges.push(e); steps.push({e, reverse: fwd < 0});
    }
    return {nodes, edges, steps, found: true};
  }

  function findPath(a, b, opts) {
    if (!(a >= 0 && a < N && b >= 0 && b < N)) return;
    if (opts && "extracted" in opts) extractedOnly = !!opts.extracted;
    const r = bfs(a, b, extractedOnly), prevSel = S.selected;
    S.focus = null;
    S.selected = -1;
    S.path = {from: a, to: b, nodes: r.nodes, edges: r.edges, steps: r.steps, found: r.found,
              extractedOnly};
    resetPanelState();
    emit("path", S.path);
    if (prevSel !== -1) emit("select", -1);
    if (r.found) frame(() => r.nodes);        // the route's bounding box
    render();
    MX.announce(r.found
      ? "Path: " + (r.nodes.length - 1) + " hops from " + g.label[a] + " to " + g.label[b]
      : "no path between " + g.label[a] + " and " + g.label[b] + " within " + PATH_CAP + " hops");
    MX.status();
  }

  // ---- resolve (mirror of query.py resolve_node) -----------------------------
  function resolve(needle, opts) {
    needle = String(needle == null ? "" : needle);
    const hit = g.idIndex.get(needle);
    if (hit != null) return hit;
    const low = needle.toLowerCase(), exact = [], part = [];
    for (let i = 0; i < N; i++) {
      const l = g.label[i].toLowerCase();
      if (l === low) exact.push(i);
      if (l.includes(low)) part.push(i);
    }
    if (exact.length === 1) return exact[0];
    let cands = exact;
    if (!exact.length) {
      if (part.length === 1) return part[0];
      cands = part;
    }
    if (!opts || opts.show !== false) {
      const top = cands.slice().sort((a, b) => g.deg[b] - g.deg[a] || a - b).slice(0, 15);
      panel.innerHTML = "<h2 id='panel-title'>" + (top.length ? "Which node?" : "No match") + "</h2>" +
        "<div class='sub'>" + (top.length
          ? "“" + esc(needle) + "” matches " + fmt(cands.length) + " nodes" +
            (cands.length > 15 ? "; the 15 with most links:" : ":")
          : "Nothing matches “" + esc(needle) + "”.") + "</div>" +
        (top.length ? "<ul class='disambig'>" + top.map(i => "<li>" + link(i) + " <span class='tag'>" +
          esc(typeName(i)) + " · " + fmt(links(i)) + " links</span></li>").join("") + "</ul>" : "");
    }
    return -1;
  }

  // ---- selection + pins --------------------------------------------------------
  function resetPanelState() { expanded = new Set(); closed = new Set(); pickerOpen = false; }

  // ---- universe: camera framing + place -------------------------------
  const UV = () => MX.universe;
  const ready = () => !!(UV() && UV().started && MX.camera && MX.camera.flyTo);
  // fly to fit ids() (a route or the focus set) once the camera exists; before the first settle ui.js frames it
  function frame(ids) { if (ready()) MX.camera.flyFit(ids()); }
  function visibleOf(set) { const out = []; for (let i = 0; i < N; i++) if (set[i] && S.nodeVisible[i]) out.push(i); return out; }
  const ROLE = ["sun", "planet", "dust"];
  // announcement for a body: "Label, type, N links" + ", sun" | ", planet of <system>" | ", dust"
  function describe(i) {
    const u = UV(), base = g.label[i] + ", " + typeName(i) + ", " + links(i) + " links";
    if (!u) return base;
    const r = u.roleOf(i), s = u.systemOf(i);
    return base + (r === 1 && s >= 0 ? ", planet of " + u.systems[s].name : ", " + ROLE[r]);
  }
  function placeHtml(i) {
    const u = UV();
    if (!u || !u.clusters[u.clusterOf(i)]) return "";
    const c = u.clusterOf(i), k = u.galaxyOf(i), s = u.systemOf(i), r = u.roleOf(i);
    const fb = (kind, v, text) => btn("place", esc(text), " class='chip' data-kind='" + kind + "' data-v='" + v + "' title='Fly to this " + kind + "'");
    let h = "<div class='meta place'>Place " + fb("cluster", c, u.clusters[c].name) + " › " + fb("galaxy", k, u.galaxies[k].name) +
      (s >= 0 ? " › " + fb("system", s, u.systems[s].name) : "") + " <span class='badge'>" + ROLE[r].toUpperCase() + "</span></div>";
    if (r === 0) {
      const a = u.memStart[s] + 1, b = u.memStart[s + 1], cap = Math.min(b, a + 200);
      if (b > a) {
        h += "<details class='planets'><summary>Planets " + fmt(b - a) + "</summary><div class='planet-list'>";
        for (let q = a; q < cap; q++) h += "<div>" + link(u.members[q]) + "</div>";
        h += (b > cap ? "<div class='meta'>… " + fmt(b - cap) + " more</div>" : "") + "</div></details>";
      }
    }
    return h;
  }

  function select(i, opts) {
    opts = opts || {};
    if (!(i >= 0 && i < N)) i = -1;
    const prev = S.selected;
    S.selected = i;
    if (i !== prev) resetPanelState();
    emit("select", i);
    if (i >= 0 && opts.center && ready()) { if (!MX.camera.flyBody(i)) MX.camera.centerOn(i); }
    render();
    if (opts.announce !== false) MX.announce(i >= 0 ? describe(i) : "Selection cleared");
    MX.status();
  }

  function pin(i) {
    if (!(i >= 0 && i < N)) return;
    S.pinned.add(i);
    MX.filter.recompute();
  }

  // ---- panel ---------------------------------------------------------------------
  function groupsOf(i) {
    const map = new Map();
    for (let a = g.adjOff[i]; a < g.adjOff[i + 1]; a++) {
      const e = g.adjEdge[a], out = g.src[e] === i, j = out ? g.dst[e] : g.src[e];
      const key = (out ? "o" : "i") + g.rel[e];
      if (!map.has(key)) map.set(key, {key, out, rel: g.rel[e], rows: []});
      map.get(key).rows.push([j, g.prov[e]]);
    }
    const list = [...map.values()].sort((a, b) => (b.out - a.out) || D.rels[a.rel].localeCompare(D.rels[b.rel]));
    for (const grp of list) {                     // provenance-grouped: extracted, inferred, ambiguous; then degree
      grp.rows.sort((x, y) => x[1] - y[1] || g.deg[y[0]] - g.deg[x[0]] || x[0] - y[0]);
      grp.prov = D.provs.map((_, p) => grp.rows.reduce((n, r) => n + (r[1] === p), 0));
    }
    return list;
  }
  function peerRow([j, p]) {
    return "<div class='peer' data-prov='" + p + "'>" + provMark(p) + link(j) + " <span class='tag'>" + esc(typeName(j)) + "</span>" +
      provSr(p) + (S.nodeVisible[j] ? "" : " <span class='tag'>· hidden</span>") + "</div>";
  }
  function hiddenPeers(i) {
    const seen = new Set(), out = [];
    for (let a = g.adjOff[i]; a < g.adjOff[i + 1]; a++) {
      const e = g.adjEdge[a], j = g.src[e] === i ? g.dst[e] : g.src[e];
      if (j !== i && !seen.has(j)) { seen.add(j); if (!S.nodeVisible[j]) out.push(j); }
    }
    return {total: seen.size, hidden: out.sort((a, b) => g.deg[b] - g.deg[a] || a - b)};
  }

  function pathHtml(titled) {
    const P = S.path, a = P.from, b = P.to;
    let h = "<section class='path-view' aria-label='Path'><h2" + (titled ? " id='panel-title'" : "") + ">Path</h2>" +
      "<div class='sub'>" + link(a) + " → " + link(b) + " · " +
      (P.found ? (P.nodes.length - 1) + (P.nodes.length === 2 ? " hop" : " hops") : "not found") + " · " +
      (P.extractedOnly ? "EXTRACTED edges only" : "any provenance") + "</div>";
    if (P.found) {
      h += "<ol class='pathlist'>" + P.nodes.map((n, s) => {
        let li = "<li class='hop'>" + link(n) + " <span class='tag'>" + esc(typeName(n)) + "</span>";
        const st = P.steps[s];
        if (st) li += "<div class='meta'>" + (st.reverse ? "↑ " : "↓ ") + esc(D.rels[g.rel[st.e]]) +
          (st.reverse ? " (reverse)" : "") + " " + provBadge(g.prov[st.e]) + "</div>";
        return li + "</li>";
      }).join("") + "</ol>";
    } else {
      h += "<p class='nopath'>no path between " + esc(g.label[a]) + " and " + esc(g.label[b]) +
           " within " + PATH_CAP + " hops" + (P.extractedOnly ? " over EXTRACTED edges" : "") + ".</p>";
    }
    h += "<div class='actions'>" + btn("extracted", "EXTRACTED only", pressed(P.extractedOnly)) + " " +
      btn("swap", "Reverse") + " " + btn("clearpath", "Clear path") + "</div></section>";
    return h;
  }

  function focusHtml(titled) {
    const f = S.focus;
    return "<section class='focus-view' aria-label='Focus'><h2" + (titled ? " id='panel-title'" : "") +
      ">Focus</h2><div class='sub'>" + fmt(f.size) + " nodes within " + f.hops +
      (f.hops > 1 ? " hops" : " hop") + " of " + link(f.root) +
      (f.truncated ? " (truncated to " + fmt(EGO_CAP) + " by degree)" : "") + "</div>" +
      "<div class='actions' role='group' aria-label='Focus depth'>Hops " +
      [1, 2, 3].map(k => btn("hops", String(k), " data-v='" + k + "' aria-label='" + k + " hop" +
        (k > 1 ? "s" : "") + "'" + pressed(f.hops === k))).join(" ") + "</div>" +
      "<div class='actions' role='group' aria-label='Focus direction'>" +
      DIRS.map(d => btn("dir", d === "out" ? "Outgoing" : d === "in" ? "Incoming" : "Both",
        " data-v='" + d + "'" + pressed(f.dir === d))).join(" ") + "</div>" +
      "<div class='actions'>" + btn("clearfocus", "Exit focus") + " <span class='kbd'>Esc</span></div></section>";
  }

  function nodeHtml(i) {
    const m = g.meta.get(i) || {}, f = g.file[i], c = g.comm[i], F = S.facets;
    // header: type dot + type · group kicker, the name, the path (middle-truncated), then tier / flag chips
    let h = "<div class='ins-k'><span class='swatch--dot' data-group='" + (g.group[i] & 3) + "' aria-hidden='true'></span>" +
      "<span class='badge'>" + esc(typeName(i)) + "</span><span class='ins-sep' aria-hidden='true'>·</span><span class='badge'>" +
      esc(D.groups[g.group[i]]) + "</span></div><h2 id='panel-title'>" + esc(g.label[i]) + "</h2>";
    if (f) {
      const href = fileHref(f), full = f + (g.line[i] ? ":" + g.line[i] : ""), cut = full.lastIndexOf("/") + 1;
      const txt = "<span class='mid-h'>" + esc(full.slice(0, cut)) + "</span><span class='mid-t'>" + esc(full.slice(cut)) + "</span>";
      h += "<div class='ins-path'><span class='sr-only'>File </span>" + (href ? "<a class='filelink mid' href='" + esc(href) +
        "' target='_blank' rel='noopener' title='" + esc(full) + "'>" + txt + "</a>" : "<span class='mid' title='" + esc(full) + "'>" + txt + "</span>") + "</div>";
    }
    h += "<div class='sub ins-chips'>";
    if (m.tier) h += "<span class='badge badge--tier-" + esc(m.tier) + "'>" + esc(m.tier) + "</span> ";
    for (const k of ["partial", "unresolved", "external"]) if (m[k]) h += "<span class='badge badge--flag'>" + k + "</span> ";
    h += "<span class='ins-links'><b>" + fmt(links(i)) + "</b> links</span></div>";
    if (m.statement) h += "<p class='statement" + (m.tier === "RETRACTED" ? " retracted" : "") + "'>" +
      esc(m.statement) + "</p>";
    if (m.body) h += "<p class='meta excerpt'>" + esc(m.body) + (m.body.length >= 280 ? "…" : "") + "</p>";
    h += "<dl class='kv'>";
    if (c >= 0) {
      const on = !!(F.comm && F.comm.size === 1 && F.comm.has(c));
      h += "<dt>Community</dt><dd>" + btn("comm", esc(D.communities[c]),
        " class='chip' data-v='" + c + "'" + pressed(on) + " title='Show only this community'") + "</dd>";
    }
    h += "<dt>Id</dt><dd class='mono'>" + esc(g.id[i]) + "</dd></dl>" + placeHtml(i);
    const foc = !!(S.focus && S.focus.root === i);
    h += "<div class='actions'>" + btn("focus", "Focus neighbourhood", pressed(foc)) + " " +
      btn("pathpick", "Path to…", " aria-expanded='" + pickerOpen + "'" + (pickerOpen ? " aria-controls='path-picker'" : "")) + "</div>";
    if (pickerOpen) {
      h += "<div class='path-picker' id='path-picker'><input id='path-q' type='search' autocomplete='off' " +
        "placeholder='Path to…' aria-label='Path to node: search'> " +
        btn("extracted", "EXTRACTED only", pressed(extractedOnly)) +
        "<ul id='path-res' class='path-results' aria-label='Path targets'></ul></div>";
    }
    const hp = hiddenPeers(i);
    if (hp.hidden.length) {
      h += "<div class='meta'>" + fmt(hp.hidden.length) + " of " + fmt(hp.total) +
        " neighbours hidden by filters " + btn("expand", "Show top " + Math.min(EXPAND, hp.hidden.length),
        " id='expand-hidden'") + "</div>";
    }
    for (const grp of groupsOf(i)) {
      const n = grp.rows.length, all = expanded.has(grp.key), hid = grp.rows.reduce((s, r) => s + !S.nodeVisible[r[0]], 0);
      const kinds = grp.prov.filter(k => k).length;   // one provenance: its rule alone; mixed: a rule + count per kind
      const mix = grp.prov.map((k, p) => (k ? "<span class='pc'>" + provMark(p) + (kinds > 1 ? fmt(k) : "") + provSr(p) + "</span>" : "")).join("");
      h += "<details class='rel' data-key='" + grp.key + "'" + (closed.has(grp.key) ? "" : " open") + "><summary>" +
        "<span class='dir' aria-hidden='true'>" + (grp.out ? "→" : "←") + "</span><span class='sr-only'>" + (grp.out ? "outgoing" : "incoming") +
        " · </span><span class='rn'>" + esc(D.rels[grp.rel]) + "</span>" + (hid ? " <span class='tag'>" + fmt(hid) + " hidden</span>" : "") +
        "<span class='mix'>" + mix + "</span><span class='count'>" + n + "</span></summary>" +
        "<div class='peers'>" + grp.rows.slice(0, all ? n : PEERS).map(peerRow).join("") + "</div>" +
        (!all && n > PEERS ? btn("showall", "Show all " + fmt(n), " class='show-all' data-key='" + grp.key + "'") : "") +
        "</details>";
    }
    return h;
  }

  function render() {
    const parts = [];
    let titled = S.selected < 0;
    if (S.path) { parts.push(pathHtml(titled)); titled = false; }
    if (S.focus) { parts.push(focusHtml(titled)); titled = false; }
    if (S.selected >= 0) parts.push(nodeHtml(S.selected));
    else if (!S.path && !S.focus) parts.push("<h2 id='panel-title'>Nothing selected</h2><div class='sub'>" +
      "Click a node, or search above. Every relationship shows its provenance: <em>extracted</em> " +
      "is stated in the source, <em>inferred</em> was resolved across files, <em>ambiguous</em> " +
      "matched more than one candidate.</div>");
    if (S.pinned.size) parts.push("<div class='meta'>" + fmt(S.pinned.size) + " pinned " +
      btn("unpin", "Unpin all") + "</div>");
    panel.innerHTML = parts.join("");
  }

  // keep the user's collapsed groups across re-renders of the same node
  panel.addEventListener("toggle", e => {
    const d = e.target;
    if (d.matches && d.matches("details.rel")) { if (d.open) closed.delete(d.dataset.key); else closed.add(d.dataset.key); }
  }, true);

  // ---- path picker ------------------------------------------------------------------
  let pickT = 0, pickHits = [];
  function pickerQuery(q) {
    const ul = document.getElementById("path-res");
    if (!ul) return;
    q = q.trim();
    if (!q) { ul.innerHTML = ""; pickHits = []; return; }
    if (!MX.search.ready) MX.search.build();
    pickHits = Array.from(MX.search.query(q).ids).filter(j => j !== S.selected).slice(0, 8);
    ul.innerHTML = pickHits.length ? pickHits.map(j => "<li>" + btn("pathto", esc(g.label[j]) +
      " <span class='tag'>" + esc(typeName(j)) + "</span>", " data-v='" + j + "'") + "</li>").join("")
      : "<li class='meta'>no matches</li>";
  }

  function onClick(e) {
    const a = e.target.closest("a[data-i]");
    if (a && panel.contains(a)) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;   // let the browser open it
      e.preventDefault();
      const j = +a.dataset.i;
      if (!S.nodeVisible[j]) S.pinned.add(j);          // pinned, not orphans-on
      select(j, {center: true});
      return;
    }
    const b = e.target.closest("button[data-act]");
    if (!b || !panel.contains(b)) return;
    const act = b.dataset.act, v = b.dataset.v, i = S.selected;
    if (act === "focus") { if (S.focus && S.focus.root === i) clearFocus(); else focusOn(i, 1); }
    else if (act === "hops" && S.focus) focusOn(S.focus.root, +v);
    else if (act === "dir" && S.focus) focusOn(S.focus.root, S.focus.hops, v);
    else if (act === "clearfocus") clearFocus();
    else if (act === "clearpath") clearPath();
    else if (act === "swap" && S.path) findPath(S.path.to, S.path.from);
    else if (act === "extracted") {
      extractedOnly = !extractedOnly;
      if (S.path && b.closest(".path-view")) findPath(S.path.from, S.path.to);
      else b.setAttribute("aria-pressed", String(extractedOnly));
    } else if (act === "pathpick") {
      pickerOpen = !pickerOpen; render();
      const inp = document.getElementById("path-q"); if (inp) inp.focus();
    } else if (act === "pathto") findPath(i, +v, {center: true});
    else if (act === "place") {
      const kind = b.dataset.kind;
      if (ready() && /^(cluster|galaxy|system)$/.test(kind) && MX.camera.flyKind(kind, +v)) MX.announce("Flying to " + b.textContent + " " + kind);
    } else if (act === "comm") {
      const c = +v, on = S.facets.comm && S.facets.comm.size === 1 && S.facets.comm.has(c);
      MX.filter.setFacet("comm", on ? null : new Set([c]));
      render();
    } else if (act === "expand") {
      const hp = hiddenPeers(i).hidden.slice(0, EXPAND);
      for (const j of hp) S.pinned.add(j);
      busy++; try { MX.filter.recompute(); } finally { busy--; }
      render();
      const nb = document.getElementById("expand-hidden"); if (nb) nb.focus();
      MX.announce("Showing " + hp.length + " more neighbours");
    } else if (act === "showall") {
      expanded.add(b.dataset.key);
      const grp = groupsOf(i).find(x => x.key === b.dataset.key), box = b.parentNode.querySelector(".peers");
      if (grp && box) box.insertAdjacentHTML("beforeend", grp.rows.slice(PEERS).map(peerRow).join(""));
      b.remove();
    } else if (act === "unpin") {
      S.pinned.clear();
      busy++; try { MX.filter.recompute(); } finally { busy--; }
      render();
    }
  }

  function onKey(e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (e.target && e.target.id === "path-q") {
      e.preventDefault(); e.stopPropagation();
      pickerOpen = false; render();
      const b = panel.querySelector("button[data-act=pathpick]"); if (b) b.focus();
      return;
    }
    if (S.focus || S.path) { e.preventDefault(); e.stopImmediatePropagation(); clearFocus(); }
  }

  MX.select = select;
  MX.pin = pin;
  MX.resolve = resolve;
  MX.focusOn = focusOn;
  MX.clearFocus = clearFocus;
  MX.clearPath = clearPath;
  MX.findPath = findPath;
  MX.describe = describe;

  MX.module("inspector", () => {
    render();
    panel.addEventListener("click", onClick);
    panel.addEventListener("input", e => {
      if (e.target.id !== "path-q") return;
      clearTimeout(pickT);
      pickT = setTimeout(() => pickerQuery(e.target.value), 120);
    });
    panel.addEventListener("keydown", e => {
      if (e.target.id === "path-q" && e.key === "Enter") {
        e.preventDefault(); clearTimeout(pickT); pickerQuery(e.target.value);
        if (pickHits.length) findPath(S.selected, pickHits[0], {center: true});
      }
    });
    document.addEventListener("keydown", onKey);
    MX.on("visibility", () => {
      if (busy) return;
      if (S.focus && S.focus.key !== facetKey()) setFocus(S.focus.root, S.focus.hops);   // facets moved: re-ego
      const ae = document.activeElement;
      if (ae && ae.id === "path-q") return;                   // don't eat the picker while typing
      if (S.selected >= 0 || S.path || S.focus) render();
    });
  });

  // ---- self-tests (inspector.*) ----------------------------------------------
  const fail = m => { throw new Error(m); };
  function topNode() {
    let best = 0;
    for (let i = 1; i < N; i++) if (links(i) > links(best)) best = i;
    return best;
  }
  MX.selftest.add("inspector.showAll", () => {
    const prev = S.selected, i = topNode();
    if (i >= N) MX.selftest.skip("no node to inspect");
    try {
      select(i, {announce: false});
      const sum = [...panel.querySelectorAll(".rel summary .count")].reduce((s, el) => s + +el.textContent, 0);
      if (sum !== links(i)) fail("summary counts " + sum + " != incident " + links(i));
      panel.querySelectorAll(".show-all").forEach(el => el.click());
      const rows = panel.querySelectorAll(".peer").length;
      if (rows !== links(i)) fail("peer rows " + rows + " != incident edges " + links(i));
    } finally { select(prev, {announce: false}); }
  });
  MX.selftest.add("inspector.hiddenPeerPins", () => {
    const F = S.facets, prev = S.selected, saved = F.type, orph = F.orphans, pins = new Set(S.pinned);
    // a node with a neighbour of another type: narrowing to its own type hides that peer
    let i = -1;
    for (let n = 0; n < N && i < 0; n++) {
      for (let a = g.adjOff[n]; a < g.adjOff[n + 1]; a++) {
        const e = g.adjEdge[a], o = g.src[e] === n ? g.dst[e] : g.src[e];
        if (g.type[o] !== g.type[n] && g.deg[n] > 0) { i = n; break; }
      }
    }
    if (i < 0) MX.selftest.skip("no node with a cross-type neighbour");
    try {
      MX.filter.setFacet("type", new Set([g.type[i]]));
      select(i, {announce: false});
      const a = [...panel.querySelectorAll(".peer a[data-i]")].find(el => !S.nodeVisible[+el.dataset.i]);
      if (!a) fail("no hidden peer row rendered");
      const j = +a.dataset.i;
      a.click();
      if (S.selected !== j) fail("peer not selected");
      if (!S.nodeVisible[j]) fail("peer still hidden");
      if (!S.pinned.has(j)) fail("peer not pinned");
      if (F.orphans !== orph) fail("orphans facet changed");
    } finally {
      S.pinned.clear(); for (const p of pins) S.pinned.add(p);
      MX.filter.setFacet("type", saved);
      select(prev, {announce: false});
    }
  });
})();
