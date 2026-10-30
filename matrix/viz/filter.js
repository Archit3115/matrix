(function () {
  "use strict";
  // Facets, visible masks, search results list and the URL-hash codec/router
  // (base, edgeVis, nodeVis). The only writer of nodeVisible /
  // edgeVisible / facets / q / results / matchMask / hiddenMatches.
  const g = MX.g, S = MX.state, D = g.D, N = g.N, M = g.M;
  const NP = D.provs.length, NR = D.rels.length, NT = D.types.length, NC = D.communities.length;
  const $ = id => document.getElementById(id);
  const esc = MX.esc, fmt = MX.fmt;
  const F = S.facets;

  // type -> group: from the nodes themselves, groupTypes for types without nodes
  const typeGroup = new Int8Array(NT).fill(-1);
  for (let i = 0; i < N; i++) typeGroup[g.type[i]] = g.group[i];
  D.types.forEach((t, k) => {
    if (typeGroup[k] >= 0) return;
    const j = D.groupTypes.findIndex(l => l.includes(t));
    typeGroup[k] = j < 0 ? D.groups.length - 1 : j;
  });
  const groupTypes = D.groups.map((_, j) => {
    const order = D.groupTypes[j] || [];
    return D.types.map((_, k) => k).filter(k => typeGroup[k] === j)
      .sort((a, b) => {
        const ia = order.indexOf(D.types[a]), ib = order.indexOf(D.types[b]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a - b;
      });
  });
  let deg0 = 0;
  for (let i = 0; i < N; i++) if (g.deg[i] === 0) deg0++;
  const commSize = new Uint32Array(NC);
  for (let i = 0; i < N; i++) if (g.comm[i] >= 0) commSize[g.comm[i]]++;

  // ---- masks ---------------------------------------------------------------
  const base = new Uint8Array(N), tmp = new Uint8Array(N), touch = new Uint8Array(N);
  const nv = new Uint8Array(N), ev = new Uint8Array(M);
  // degree bins: 0, 1, 2-3, 4-7 ... (log2); slider runs 0..min(50, maxDeg)
  let maxDeg = 0;
  for (let i = 0; i < N; i++) if (g.deg[i] > maxDeg) maxDeg = g.deg[i];
  const SLMAX = Math.min(50, maxDeg);
  const degBin = d => d <= 0 ? 0 : 32 - Math.clz32(d);
  const binLow = b => b <= 0 ? 0 : Math.pow(2, b - 1);
  const binOf = new Uint8Array(N);
  for (let i = 0; i < N; i++) binOf[i] = degBin(g.deg[i]);
  const cnt = {prov: new Uint32Array(NP), rel: new Uint32Array(NR), relProv: new Uint32Array(NR * NP),
               type: new Uint32Array(NT), comm: new Uint32Array(NC), degBin: new Uint32Array(degBin(maxDeg) + 1)};
  // layout spacing (#sp=, 0.5..3, default 1): a facet for hash/reset only, never touches masks
  const SP_MIN = 0.5, SP_MAX = 3;
  if (F.sp == null) F.sp = 1;
  const clampSp = (v, quiet) => {
    v = Math.round(+v * 100) / 100;
    if (!(v > 0)) return 1;
    const c = Math.min(SP_MAX, Math.max(SP_MIN, v));
    if (c !== v && !quiet) MX.warn("hash: sp clamped " + v + " -> " + c);
    return c;
  };
  const tellSp = () => { if (MX.layout && MX.layout.setSpacing) MX.layout.setSpacing(F.sp); };
  const clampDeg = (n, quiet) => {
    n = Math.floor(+n);
    if (!(n >= 0)) return 0;
    if (n > maxDeg) { if (!quiet) MX.warn("hash: deg clamped " + n + " -> " + maxDeg); return maxDeg; }
    return n;
  };

  function lut(set, n) {
    if (!set) return null;
    const a = new Uint8Array(n);
    for (const v of set) if (v >= 0 && v < n) a[v] = 1;
    return a;
  }
  // base(i) = typeOK and commOK and (orphans or deg>0) and deg>=F.deg and focusOK
  // noDeg: drop the orphans and deg terms (degree-histogram counts)
  function baseInto(out, tl, cl, noDeg) {
    const foc = S.focus && S.focus.set, orph = F.orphans || noDeg, md = noDeg ? 0 : F.deg;
    for (let i = 0; i < N; i++) {
      const c = g.comm[i];
      out[i] = (!tl || tl[g.type[i]]) && (!cl || (c >= 0 && cl[c])) &&
               (orph || g.deg[i] > 0) && g.deg[i] >= md && (!foc || foc[i]) ? 1 : 0;
    }
  }
  // disjunctive node count for one dimension (type or comm), ignoring that dimension
  function nodeCounts(b, pl, rl, narrow, out, key) {
    out.fill(0); touch.fill(0);
    if (narrow) for (let k = 0; k < M; k++) {
      const s = g.src[k], d = g.dst[k];
      if (b[s] && b[d] && pl[g.prov[k]] && (!rl || rl[g.rel[k]])) { touch[s] = 1; touch[d] = 1; }
    }
    for (let i = 0; i < N; i++)
      if (b[i] && (!narrow || touch[i] || g.deg[i] === 0)) out[key[i]]++;
  }

  function recompute() {
    const pl = lut(F.prov, NP), rl = lut(F.rel, NR), tl = lut(F.type, NT), cl = lut(F.comm, NC);
    const narrow = F.prov.size < NP || !!F.rel;
    baseInto(base, tl, cl);
    touch.fill(0); cnt.prov.fill(0); cnt.rel.fill(0); cnt.relProv.fill(0);
    let edges = 0;
    for (let k = 0; k < M; k++) {
      const s = g.src[k], d = g.dst[k];
      if (!base[s] || !base[d]) { ev[k] = 0; continue; }
      const p = g.prov[k], r = g.rel[k], pOK = pl[p], rOK = !rl || rl[r];
      if (rOK) cnt.prov[p]++;
      if (pOK) { cnt.rel[r]++; cnt.relProv[r * NP + p]++; }
      if (pOK && rOK) { ev[k] = 1; edges++; touch[s] = 1; touch[d] = 1; } else ev[k] = 0;
    }
    const forced = new Set(S.pinned);
    if (S.selected >= 0) forced.add(S.selected);
    if (S.focus) forced.add(S.focus.root);
    if (S.path && S.path.nodes) for (const i of S.path.nodes) forced.add(i);
    let shown = 0;
    for (let i = 0; i < N; i++) {
      nv[i] = base[i] && (!narrow || touch[i] || g.deg[i] === 0) ? 1 : 0;
    }
    for (const i of forced) if (i >= 0 && i < N) nv[i] = 1;
    for (let i = 0; i < N; i++) shown += nv[i];
    baseInto(tmp, null, cl); nodeCounts(tmp, pl, rl, narrow, cnt.type, g.type);
    baseInto(tmp, tl, null); nodeCounts(tmp, pl, rl, narrow, cnt.comm, g.comm);
    baseInto(tmp, tl, cl, true); nodeCounts(tmp, pl, rl, narrow, cnt.degBin, binOf);

    let changed = false;
    for (let i = 0; i < N && !changed; i++) if (S.nodeVisible[i] !== nv[i]) changed = true;
    for (let k = 0; k < M && !changed; k++) if (S.edgeVisible[k] !== ev[k]) changed = true;
    S.nodeVisible.set(nv); S.edgeVisible.set(ev);
    S.nodesShown = shown; S.edgesShown = edges;
    let hidden = 0;
    for (const i of S.results) if (!nv[i]) hidden++;
    S.hiddenMatches = hidden;
    paintFacets(); paintHeadline(); paintResults();
    if (changed) MX.emit("visibility");
    MX.emit("facets");
    MX.status();
  }

  // ---- query ---------------------------------------------------------------
  function setQuery(q, quiet) {
    q = String(q == null ? "" : q).trim();
    S.q = q;
    const res = q ? MX.search.query(q).ids : new Int32Array(0);
    const mask = new Uint8Array(N);
    let hidden = 0;
    for (const i of res) { mask[i] = 1; if (!S.nodeVisible[i]) hidden++; }
    S.matchMask = mask; S.results = res; S.hiddenMatches = hidden;
    active = res.length ? 0 : -1;
    open = !!q;
    paintResults();
    if (q) MX.announce(fmt(res.length - hidden) + " matches, " + fmt(hidden) + " hidden by filters");
    if (!quiet) { MX.emit("query"); hashSync(); }
    MX.status();
  }

  // motion toggle: not a facet (Reset filters keeps it). Writer of S.anim; cosmos/universe gate on the event.
  function setAnim(on, quiet) {
    on = on !== false;
    if (S.anim === on) return;
    S.anim = on;
    if (on) delete document.documentElement.dataset.anim; else document.documentElement.dataset.anim = "0";
    MX.emit("anim", on);
    if (!quiet) hashSync();
    MX.status();
  }

  function setFacet(dim, val) {
    if (dim === "anim") { setAnim(val); return; }
    if (dim === "orphans") F.orphans = !!val;
    else if (dim === "deg") F.deg = clampDeg(val);
    else if (dim === "sp") { F.sp = clampSp(val); tellSp(); paintFacets(); hashSync(); return; }
    else if (dim === "prov") F.prov = val && val.size ? new Set(val) : new Set(D.provs.map((_, k) => k));
    else if (dim === "type" || dim === "comm" || dim === "rel") F[dim] = val && val.size ? new Set(val) : null;
    else { MX.warn("unknown facet " + dim); return; }
    recompute();
    hashSync();
  }

  // ---- min-degree slider (null-safe: #mindeg lives in template.html) --------------
  let degRaf = 0;
  function paintDeg(v) {
    const s = $("mindeg"), o = $("mindegv");
    if (s) s.setAttribute("aria-valuetext", "minimum degree " + v);
    if (o) o.textContent = (v > SLMAX ? "\u2265 " : "") + v;
  }
  function wireDeg() {
    const s = $("mindeg");
    if (!s) return;
    s.min = "0"; s.max = String(SLMAX); s.step = "1";
    s.addEventListener("input", () => {
      paintDeg(+s.value);
      if (degRaf) return;
      degRaf = requestAnimationFrame(() => { degRaf = 0; setFacet("deg", +s.value); });
    });
    paintDeg(F.deg);
  }

  // ---- facets UI: one sidebar, collapsible sections (mono label + count + chevron), open state in localStorage --------
  const PROV_TIP = ["stated in the source", "resolved across files", "matched more than one candidate"];
  const chip = (dim, v, inner, cls) =>
    "<button type='button' class='chip" + (cls ? " " + cls : "") + "' data-dim='" + dim + "' data-v='" + v +
    "' aria-pressed='false'>" + inner + " <span class='count'></span></button>";
  const SEC_KEY = "mx.side.sec";
  const CHEV = "<svg class='sec-chev' viewBox='0 0 10 10' aria-hidden='true'><path d='M2 3.75l3 3 3-3'/></svg>";
  let secOpen = {};
  try { secOpen = JSON.parse(localStorage.getItem(SEC_KEY) || "{}") || {}; } catch (e) { secOpen = {}; }
  const isOpen = (id, dflt) => (typeof secOpen[id] === "boolean" ? secOpen[id] : dflt);
  const sec = (id, label, body, dflt) => "<details class='facet sec' data-sec='" + id + "'" + (isOpen(id, dflt) ? " open" : "") +
    "><summary><span class='sec-lbl'>" + label + "</span><span class='sec-n'></span>" + CHEV + "</summary>" + body + "</details>";
  // static sections (template.html): chevron + stored state
  function adoptSec(el, id, dflt) {
    if (!el) return;
    el.dataset.sec = id;
    const sm = el.querySelector("summary");
    if (sm && !sm.querySelector(".sec-chev")) sm.insertAdjacentHTML("beforeend", CHEV);
    el.open = isOpen(id, dflt);
  }
  function wireSecs(root) {
    root.addEventListener("toggle", e => {   // toggle does not bubble: capture
      const d = e.target;
      if (!d || !d.dataset || !d.dataset.sec) return;
      secOpen[d.dataset.sec] = d.open;
      try { localStorage.setItem(SEC_KEY, JSON.stringify(secOpen)); } catch (er) { /* storage blocked */ }
    }, true);
  }
  // hairline sliders: the run left of the thumb is the bright stroke (--p)
  const fillRange = el => { if (el && el.max !== el.min) el.style.setProperty("--p", ((+el.value - +el.min) / (+el.max - +el.min) * 100).toFixed(2) + "%"); };

  function buildFacets() {
    const fp = $("f-prov"), fg = $("f-group"), fr = $("f-rel"), fc = $("f-comm"), fo = $("f-orphans");
    if (fp) fp.innerHTML = sec("prov", "Provenance", "<div class='pgrid'>" +
      D.provs.map((p, k) => chip("prov", k, "<span class='swatch swatch--line' data-prov='" + k +
        "'></span><span class='tl' title='" + esc(PROV_TIP[k] || "") + "'>" + esc(p.toLowerCase()) + "</span>", "trow")).join("") +
      "</div><div class='meta'>dash visible when zoomed in</div>", true);
    if (fg) fg.innerHTML = sec("type", "Type",
      D.groups.map((name, j) => "<div class='tgroup' style='--type-acc:var(--g" + (j & 3) + ")'>" +
        chip("group", j, "<span class='tdot'></span><span class='tl'>" + esc(name) + "</span>", "tg-head") +
        "<div class='tgrid'>" + groupTypes[j].map(k => chip("type", k, "<span class='tdot'></span><span class='tl'>" + esc(D.types[k]) + "</span>", "trow")).join("") +
        "</div></div>").join(""), true);
    if (fr) fr.innerHTML = sec("rel", "Relationship", "<div class='tgrid'>" +
      D.rels.map((r, k) => chip("rel", k, "<span class='tl'>" + esc(r.toLowerCase()) + "</span>", "trow")).join("") + "</div>", false);
    if (fc) {
      const order = D.communities.map((_, k) => k).sort((a, b) => commSize[b] - commSize[a] || a - b);
      fc.innerHTML = sec("comm", "Community",
        "<input type='search' class='comm-filter' aria-label='Filter communities' placeholder='Filter…'>" +
        "<div class='facet-list'>" + order.map(k =>
          "<div><input type='checkbox' id='fc-" + k +
          "' data-dim='comm' data-v='" + k + "'> <label for='fc-" + k + "'>" + esc(D.communities[k]) +
          " <span class='count'></span></label></div>").join("") + "</div>", false);
      const inp = fc.querySelector(".comm-filter");
      inp.addEventListener("input", () => {
        const t = inp.value.trim().toLowerCase();
        fc.querySelectorAll(".facet-list > div").forEach(row => {
          row.hidden = !!t && !row.querySelector("label").firstChild.nodeValue.toLowerCase().includes(t);
        });
      });
    }
    if (fo) fo.innerHTML = "<button type='button' class='chip trow' id='orphans-toggle' aria-pressed='false'>" +
      "<span class='tl'>Show orphans</span> <span class='count'>" + fmt(deg0) + "</span></button>";
    adoptSec($("f-degree"), "degree", true);
    adoptSec($("f-tools"), "tools", false);

    wireDeg();
    const side = $("side") || $("filters");
    if (side) {
      wireSecs(side);
      side.addEventListener("input", e => { if (e.target.type === "range") fillRange(e.target); });
    }
    const root = $("filters") || $("facets");
    if (!root) return;
    root.addEventListener("click", e => {
      const x = e.target.closest("[data-ai]");
      if (x) {
        const f = actives[+x.dataset.ai];
        if (f) { const next = x.nextElementSibling || x.previousElementSibling; f.off(); if (next && next.isConnected) next.focus(); else { const r = $("search"); if (r) r.focus(); } }
        return;
      }
      const b = e.target.closest("button.chip[data-dim], #orphans-toggle, #reset-filters");
      if (!b) return;
      if (b.id === "orphans-toggle") return setFacet("orphans", !F.orphans);
      if (b.id === "reset-filters") return resetFacets();
      toggle(b.dataset.dim, +b.dataset.v);
    });
    root.addEventListener("change", e => {
      const c = e.target;
      if (c.matches && c.matches("input[type=checkbox][data-dim=comm]")) {
        const s = new Set(F.comm || []);
        if (c.checked) s.add(+c.dataset.v); else s.delete(+c.dataset.v);
        setFacet("comm", s);
      }
    });
  }

  // facet-filter model: nothing selected = all; selecting values narrows to them
  function toggle(dim, v) {
    if (dim === "prov") {
      let s = F.prov.size < NP ? new Set(F.prov) : new Set();
      if (s.has(v)) s.delete(v); else s.add(v);
      if (s.size === NP) s = null;
      return setFacet("prov", s);
    }
    if (dim === "group") {
      const ts = groupTypes[v], s = new Set(F.type || []);
      const all = ts.length && ts.every(k => s.has(k));
      for (const k of ts) if (all) s.delete(k); else s.add(k);
      return setFacet("type", s);
    }
    const s = new Set(F[dim] || []);
    if (s.has(v)) s.delete(v); else s.add(v);
    setFacet(dim, s);
  }

  function isDefault() {
    return F.prov.size === NP && !F.type && !F.comm && !F.rel && !F.orphans && !F.deg && F.sp === 1;
  }
  function resetFacets() {
    F.prov = new Set(D.provs.map((_, k) => k)); F.type = F.comm = F.rel = null; F.orphans = false; F.deg = 0;
    F.sp = 1; tellSp();
    recompute(); hashSync();
  }

  // ---- active-filter summary: one removable chip per narrowing (a whole group = one chip), one Clear -----------
  let actives = [];
  function activeList() {
    const out = [], add = (label, off) => out.push({label, off});
    if (F.prov.size < NP) for (const k of [...F.prov].sort()) add("prov " + D.provs[k].toLowerCase(), () => toggle("prov", k));
    if (F.type) {
      const left = new Set(F.type);
      groupTypes.forEach((ts, j) => {
        if (ts.length && ts.every(k => left.has(k))) { ts.forEach(k => left.delete(k)); add("type " + D.groups[j].toLowerCase(), () => toggle("group", j)); }
      });
      for (const k of [...left].sort((a, b) => a - b)) add("type " + D.types[k], () => toggle("type", k));
    }
    if (F.rel) for (const k of [...F.rel].sort((a, b) => a - b)) add("rel " + D.rels[k].toLowerCase(), () => toggle("rel", k));
    if (F.comm) for (const k of [...F.comm].sort((a, b) => a - b)) add("comm " + D.communities[k], () => toggle("comm", k));
    if (F.deg) add("degree \u2265 " + F.deg, () => setFacet("deg", 0));
    if (F.orphans) add("orphans shown", () => setFacet("orphans", false));
    if (F.sp !== 1) add("spacing " + F.sp + "\u00d7", () => setFacet("sp", 1));
    return out;
  }
  const XMARK = "<svg viewBox='0 0 10 10' aria-hidden='true'><path d='M2.5 2.5l5 5M7.5 2.5l-5 5'/></svg>";
  function paintActive() {
    const box = $("f-active"), list = $("f-active-chips"), n = $("f-active-n");
    actives = activeList();
    if (!box) return;
    box.hidden = !actives.length;
    if (n) n.textContent = actives.length ? String(actives.length) : "";
    if (!list) return;
    const MAXA = 8, key = actives.map(a => a.label).join("\u0001");
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    list.innerHTML = actives.slice(0, MAXA).map((a, i) => "<button type='button' class='chip achip' data-ai='" + i +
      "' aria-label='Remove filter: " + esc(a.label) + "'><span class='tl'>" + esc(a.label) + "</span>" + XMARK + "</button>").join("") +
      (actives.length > MAXA ? "<span class='a-more'>+" + (actives.length - MAXA) + " more</span>" : "");
  }
  function secCount(id, on, total) {
    const el = document.querySelector("[data-sec='" + id + "'] > summary .sec-n");
    if (!el) return;
    el.textContent = on ? on + " of " + total : total == null ? "" : String(total);
    el.classList.toggle("on", !!on);
  }

  function paintFacets() {
    const root = $("facets");
    if (!root) return;
    const provNarrow = F.prov.size < NP;
    root.querySelectorAll("button.chip[data-dim]").forEach(b => {
      const dim = b.dataset.dim, v = +b.dataset.v;
      let on, n;
      if (dim === "prov") { on = provNarrow && F.prov.has(v); n = cnt.prov[v]; }
      else if (dim === "rel") { on = !!F.rel && F.rel.has(v); n = cnt.rel[v]; }
      else if (dim === "type") { on = !!F.type && F.type.has(v); n = cnt.type[v]; }
      else {
        const ts = groupTypes[v];
        on = !!F.type && ts.length > 0 && ts.every(k => F.type.has(k));
        n = ts.reduce((a, k) => a + cnt.type[k], 0);
      }
      b.setAttribute("aria-pressed", String(on));
      const c = b.querySelector(".count");
      if (c) c.textContent = fmt(n);
    });
    root.querySelectorAll("input[type=checkbox][data-dim=comm]").forEach(c => {
      const v = +c.dataset.v;
      c.checked = !!F.comm && F.comm.has(v);
      const el = c.parentNode.querySelector(".count");
      if (el) el.textContent = fmt(cnt.comm[v]);
    });
    const o = $("orphans-toggle");
    if (o) o.setAttribute("aria-pressed", String(F.orphans));
    const sl = $("mindeg");
    if (sl && !degRaf) sl.value = String(Math.min(F.deg, SLMAX));
    if (!degRaf) paintDeg(F.deg);
    fillRange(sl); fillRange($("spacing"));
    const r = $("reset-filters");
    if (r) r.hidden = isDefault();
    secCount("prov", provNarrow ? F.prov.size : 0, NP);
    secCount("type", F.type ? F.type.size : 0, NT);
    secCount("rel", F.rel ? F.rel.size : 0, NR);
    secCount("comm", F.comm ? F.comm.size : 0, NC);
    const dg = document.querySelector("[data-sec='degree'] > summary .sec-n");
    if (dg) { dg.textContent = F.deg ? "\u2265 " + F.deg + (F.orphans ? " + orphans" : "") : F.orphans ? "orphans" : "all"; dg.classList.toggle("on", !!(F.deg || F.orphans)); }
    paintActive();
  }

  function paintHeadline() {
    const h = $("headline");
    if (h) h.textContent = fmt(S.nodesShown) + " of " + fmt(N) + " nodes · " +
      fmt(S.edgesShown) + " of " + fmt(M) + " edges · built " + D.generated;
  }

  // ---- results list (combobox) -------------------------------------------------
  let active = -1, open = false, inputT = 0;
  const MAXR = 50;

  function paintResults() {
    const ul = $("results"), cnt$ = $("results-count"), inp = $("search");
    if (!ul) return;
    const res = S.results, n = Math.min(res.length, MAXR);
    let h = "";
    for (let k = 0; k < n; k++) {
      const i = res[k], hid = !S.nodeVisible[i], m = g.meta.get(i);
      h += "<li role='option' id='res-" + k + "' class='result" + (hid ? " result--hidden" : "") +
        "' aria-selected='" + (k === active) + "' data-k='" + k + "'><div class='result-label'>" +
        esc(g.label[i]) + (m && m.tier ? " <span class='badge badge--tier-" + esc(m.tier) + "'>" +
        esc(m.tier) + "</span>" : "") + (hid ? " <span class='badge'>hidden by filters</span>" : "") +
        "</div><div class='result-meta'>" + esc(D.types[g.type[i]]) +
        (g.comm[i] >= 0 ? " · " + esc(D.communities[g.comm[i]]) : "") +
        " · " + fmt(g.deg[i]) + (g.deg[i] === 1 ? " link" : " links") + "</div></li>";
    }
    ul.innerHTML = h;
    const show = open && !!S.q;
    ul.hidden = !show;
    if (cnt$) cnt$.textContent = S.q ? fmt(res.length - S.hiddenMatches) + " matches · " +
      fmt(S.hiddenMatches) + " hidden by filters" : "";
    if (inp) {
      inp.setAttribute("aria-expanded", String(show));
      if (show && active >= 0 && active < n) inp.setAttribute("aria-activedescendant", "res-" + active);
      else inp.removeAttribute("aria-activedescendant");
    }
  }

  function setActive(k) {
    const n = Math.min(S.results.length, MAXR);
    if (!n) return;
    active = Math.max(0, Math.min(n - 1, k));
    open = true;
    paintResults();
    const el = $("res-" + active);
    if (el && el.scrollIntoView) el.scrollIntoView({block: "nearest"});
  }

  function choose(k) {
    const i = S.results[k];
    if (i == null) return;
    open = false; paintResults();
    if (!S.nodeVisible[i]) MX.pin(i);
    MX.select(i, {center: true, announce: true});
  }

  function flushInput() {
    if (!inputT) return;
    clearTimeout(inputT); inputT = 0;
    setQuery($("search").value);
  }

  function clearSearch() {
    clearTimeout(inputT); inputT = 0;
    $("search").value = "";
    open = false;
    setQuery("");
  }

  function wireSearch() {
    const inp = $("search"), ul = $("results");
    if (!inp || !ul) return;
    inp.setAttribute("role", "combobox");
    inp.setAttribute("aria-autocomplete", "list");
    inp.setAttribute("aria-controls", "results");
    inp.setAttribute("aria-expanded", "false");
    inp.addEventListener("input", () => {
      clearTimeout(inputT);
      inputT = setTimeout(() => { inputT = 0; setQuery(inp.value); }, 120);
    });
    inp.addEventListener("keydown", e => {
      const k = e.key;
      if (k === "ArrowDown" || k === "ArrowUp") {
        flushInput(); e.preventDefault();
        setActive(open ? active + (k === "ArrowDown" ? 1 : -1) : Math.max(active, 0));
      } else if (k === "Enter") {
        flushInput(); e.preventDefault();
        if (S.results.length) choose(active >= 0 ? active : 0);
      } else if (k === "Escape") {
        if (inp.value || S.q || open) { e.preventDefault(); e.stopPropagation(); clearSearch(); }
      }
    });
    inp.addEventListener("focus", () => { if (S.q && !open) { open = true; paintResults(); } });
    inp.addEventListener("blur", () => { if (open) { open = false; paintResults(); } });
    ul.addEventListener("mousedown", e => e.preventDefault());   // keep focus in the combobox
    ul.addEventListener("click", e => {
      const li = e.target.closest("li[data-k]");
      if (li) choose(+li.dataset.k);
    });
  }

  // ---- URL hash -------------------------------------------------------
  const KEYS = ["q", "type", "comm", "rel", "prov", "orphans", "deg", "sp", "n", "hops", "path", "view", "anim", "cam", "gl"];
  const VIEWS = ["graph", "overview", "claims", "communities", "tables"];
  const canonView = v => v === "table" ? "tables" : v;
  const FACET_KEYS = new Set(["q", "type", "comm", "rel", "prov", "orphans", "deg", "sp", "view"]);
  const DIAG = new Set(["layout", "bench", "selftest", "theme", "hl", "panels"]);   // theme/hl: page test hooks (template.html, hairline.js)
  const diag = (k, raw) => DIAG.has(k) || (k === "view" && /^[23]d$/.test(raw));   // view=2d|3d: render.js hook, not a tab
  const E = encodeURIComponent;

  // o: {q, type, comm, rel, prov: names|null (null = all), orphans, deg, sp, n: id|null, hops, path: [a,b]|null, view}
  function serialize(o) {
    const p = [];
    if (o.q) p.push("q=" + E(o.q));
    for (const k of ["type", "comm", "rel"]) if (o[k] && o[k].length) p.push(k + "=" + o[k].map(E).join(","));
    if (o.prov && o.prov.length < NP) p.push("prov=" + o.prov.map(s => E(String(s).toUpperCase())).join(","));
    if (o.orphans) p.push("orphans=1");
    if (o.deg) p.push("deg=" + o.deg);
    if (o.sp != null && o.sp !== 1) p.push("sp=" + o.sp);
    if (o.n != null) { p.push("n=" + E(o.n)); if (o.hops) p.push("hops=" + o.hops); }
    if (o.path) p.push("path=" + o.path.map(E).join("|"));
    if (o.view && o.view !== "graph") p.push("view=" + canonView(o.view));
    if (o.anim === false) p.push("anim=0");           // motion is on by default; only the off state is written
    return p.join("&");
  }

  function parse(h) {
    const o = {q: "", type: null, comm: null, rel: null, prov: null, orphans: false,
               deg: 0, sp: 1, n: null, hops: 0, path: null, view: "graph"};
    const warn = [], keys = new Set();
    h = String(h || "").replace(/^#/, "");
    for (const kv of h ? h.split("&") : []) {
      if (!kv) continue;
      const eq = kv.indexOf("="), k = eq < 0 ? kv : kv.slice(0, eq), raw = eq < 0 ? "" : kv.slice(eq + 1);
      if (diag(k, raw)) continue;
      if (!KEYS.includes(k)) { warn.push("hash: unknown key " + k); continue; }
      const list = () => raw.split(/[,|]/).map(decodeURIComponent);
      try {
        if (k === "q") o.q = decodeURIComponent(raw);
        else if (k === "type" || k === "comm" || k === "rel" || k === "prov") o[k] = raw ? list() : null;
        else if (k === "orphans") o.orphans = raw === "1" || raw === "true";
        else if (k === "deg") {
          if (/^\d+$/.test(raw)) o.deg = +raw; else { warn.push("hash: bad deg " + raw); continue; }
        } else if (k === "sp") {
          if (/^\d+(\.\d+)?$/.test(raw)) o.sp = clampSp(raw, true); else { warn.push("hash: bad sp " + raw); continue; }
          if (o.sp !== Math.round(+raw * 100) / 100) warn.push("hash: sp clamped " + raw + " -> " + o.sp);
        } else if (k === "n") o.n = decodeURIComponent(raw) || null;
        else if (k === "hops") {
          if (raw === "1" || raw === "2" || raw === "3") o.hops = +raw; else { warn.push("hash: bad hops " + raw); continue; }
        } else if (k === "path") {
          const l = list();
          if (l.length === 2 && l[0] && l[1]) o.path = l; else { warn.push("hash: bad path"); continue; }
        } else if (k === "anim") {
          if (raw === "0") o.anim = false; else { warn.push("hash: bad anim " + raw); continue; }
        } else if (k === "view") {
          const v = canonView(raw);
          if (VIEWS.includes(v)) o.view = v; else { warn.push("hash: bad view " + raw); continue; }
        }
        keys.add(k);
      } catch (e) {
        warn.push("hash: malformed value for " + k);
      }
    }
    return {o, warn, keys};
  }

  const names = (set, list) => set ? [...set].sort((a, b) => a - b).map(k => list[k]) : null;
  function stateObj() {
    const o = {q: S.q, type: names(F.type, D.types), comm: names(F.comm, D.communities),
               rel: names(F.rel, D.rels), prov: F.prov.size < NP ? names(F.prov, D.provs) : null,
               orphans: F.orphans, deg: F.deg, sp: F.sp, n: null, hops: 0, path: null,
               view: VIEWS.includes(canonView(S.view)) ? canonView(S.view) : "graph"};
    if (S.path && S.path.from >= 0 && S.path.to >= 0) o.path = [g.id[S.path.from], g.id[S.path.to]];
    else if (S.focus && S.focus.root >= 0) { o.n = g.id[S.focus.root]; o.hops = S.focus.hops || 0; }
    else if (S.selected >= 0) o.n = g.id[S.selected];
    if (S.anim === false) o.anim = false;             // last key: parse() adds it in the same order
    return o;
  }

  // exact name first, then case-insensitive (prov is case-insensitive)
  function toSet(list, all, dim) {
    if (!list) return null;
    const s = new Set();
    for (const name of list) {
      let k = all.indexOf(name);
      if (k < 0) { const l = name.toLowerCase(); k = all.findIndex(x => x.toLowerCase() === l); }
      if (k < 0) { MX.warn("hash: unknown " + dim + " " + name); continue; }
      s.add(k);
    }
    return s.size ? s : null;
  }

  function resolveId(v) {
    if (v == null) return -1;
    const hit = g.idIndex.get(v);
    if (hit != null) return hit;
    const r = MX.resolve ? MX.resolve(v) : -1;
    if (typeof r === "number" && r >= 0) return r;
    MX.warn("hash: unresolved node " + v);
    return -1;
  }

  let lastHash = null, syncT = 0, booted = false;

  function applyHash(h, opts) {
    const fromEvent = !!(opts && opts.fromEvent);
    const {o, warn, keys} = parse(h);
    warn.forEach(w => MX.warn(w));
    const navOnly = fromEvent && ![...keys].some(k => FACET_KEYS.has(k));
    if (!navOnly || keys.has("anim")) setAnim(o.anim !== false, true);
    if (!navOnly) {
      const pv = toSet(o.prov, D.provs, "prov");
      F.prov = pv || new Set(D.provs.map((_, k) => k));
      F.type = toSet(o.type, D.types, "type");
      F.comm = toSet(o.comm, D.communities, "comm");
      F.rel = toSet(o.rel, D.rels, "rel");
      F.orphans = o.orphans;
      F.deg = clampDeg(o.deg);
      F.sp = o.sp; tellSp();
      const inp = $("search");
      if (inp) inp.value = o.q;
      recompute();
      setQuery(o.q, true);
      MX.emit("query");
      if (o.view !== canonView(S.view)) {
        const sv = MX.dash && MX.dash.setView || MX.ui && MX.ui.setView;
        if (sv) sv(o.view);
      }
    }
    if (o.path) {
      const a = resolveId(o.path[0]), b = resolveId(o.path[1]);
      if (a >= 0 && b >= 0) MX.findPath(a, b);
    } else if (o.n != null) {
      const i = resolveId(o.n);
      if (i >= 0) {
        if (o.hops) MX.focusOn(i, o.hops);
        else {
          if (S.focus) MX.clearFocus();
          MX.select(i, {center: fromEvent, announce: fromEvent});
        }
      }
    } else if (fromEvent && (!navOnly || !keys.size)) {
      if (S.focus || S.path) MX.clearFocus();
      if (S.selected >= 0) MX.select(-1);
    }
    booted = true;
    hashSync();
  }

  function writeHash() {
    syncT = 0;
    const h = serialize(stateObj());
    lastHash = h;
    if (h !== location.hash.replace(/^#/, "")) {
      try { history.replaceState(null, "", h ? "#" + h : location.pathname + location.search); }
      catch (e) { location.replace("#" + h); }
    }
    MX.status();
  }
  function hashSync() {
    if (!booted) return;
    clearTimeout(syncT);
    syncT = setTimeout(writeHash, 150);
  }

  MX.filter = {recompute, setFacet, setAnim, setQuery, applyHash, toggle, maxDeg, degBin, binLow,
               counts: () => cnt,
               hash: {sync: hashSync, serialize, parse, state: stateObj}};

  MX.module("filter", () => {
    buildFacets();
    wireSearch();
    recompute();
    const onNav = () => { recompute(); hashSync(); };
    MX.on("select", onNav);
    MX.on("focus", onNav);
    MX.on("path", onNav);
    MX.on("view", hashSync);
    window.addEventListener("hashchange", () => {
      const h = location.hash.replace(/^#/, "");
      if (h === lastHash) return;
      applyHash(location.hash, {fromEvent: true});
    });
    // index: synchronous when #q is present (applyHash), else idle after the first frame
    if (!/(^#|&)q=./.test(location.hash)) {
      const idle = window.requestIdleCallback || (f => setTimeout(f, 50));
      requestAnimationFrame(() => idle(() => MX.search.build()));
    }
  });

  // ---- self-tests (search_filter) --------------------------
  function snapshot() {
    return {prov: new Set(F.prov), type: F.type && new Set(F.type), comm: F.comm && new Set(F.comm),
            rel: F.rel && new Set(F.rel), orphans: F.orphans, deg: F.deg, q: S.q, sel: S.selected};
  }
  function restore(s) {
    clearTimeout(inputT); inputT = 0;
    F.prov = s.prov; F.type = s.type; F.comm = s.comm; F.rel = s.rel; F.orphans = s.orphans; F.deg = s.deg;
    const inp = $("search"); if (inp) inp.value = s.q;
    open = false;
    if (S.selected !== s.sel) MX.select(s.sel);
    recompute(); setQuery(s.q);
  }
  function defaults() {
    F.prov = new Set(D.provs.map((_, k) => k)); F.type = F.comm = F.rel = null; F.orphans = false; F.deg = 0;
    recompute();
  }
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true}));
  const typeInto = (el, text) => { el.focus(); el.value = text; el.dispatchEvent(new Event("input", {bubbles: true})); };
  const fail = m => { throw new Error(m); }, skip = r => MX.selftest.skip(r);   // skip: data absent -> n/a

  MX.selftest.add("search.keys", () => {
    const s = snapshot();
    try {
      const inp = $("search");
      typeInto(inp, "Sales");
      key(inp, "ArrowDown");
      const ad = inp.getAttribute("aria-activedescendant");
      if (S.results.length < 2) skip("fewer than 2 results for Sales in this graph");
      if (ad !== "res-1" || !$(ad)) fail("aria-activedescendant=" + ad);
      if ($(ad).getAttribute("aria-selected") !== "true") fail("active option not aria-selected");
      const want = S.results[1];
      key(inp, "Enter");
      if (S.selected !== want) fail("selected " + S.selected + " != results[1] " + want);
    } finally { restore(s); }
  });

  MX.selftest.add("search.escClears", () => {
    const s = snapshot();
    try {
      const inp = $("search");
      typeInto(inp, "Sales");
      key(inp, "ArrowDown");
      if ($("results").hidden) fail("results not shown before Esc");
      key(inp, "Escape");
      if (inp.value !== "") fail("input not empty");
      if (!$("results").hidden) fail("results still shown");
      if (S.q !== "" || S.results.length) fail("query not cleared");
    } finally { restore(s); }
  });

  MX.selftest.add("facets.provChip", () => {
    const s = snapshot();
    try {
      defaults();
      const a = D.provs.indexOf("AMBIGUOUS");
      const want = D.edges.reduce((n, e) => n + (e[3] === a ? 1 : 0), 0);
      const b = document.querySelector("#f-prov .chip[data-dim=prov][data-v='" + a + "']");
      if (!b) fail("no AMBIGUOUS chip");
      b.click();
      if (b.getAttribute("aria-pressed") !== "true") fail("chip not aria-pressed");
      if (S.edgesShown !== want) fail("edgesShown " + S.edgesShown + " != " + want);
    } finally { restore(s); }
  });

  MX.selftest.add("orphans.toggle", () => {
    const s = snapshot();
    try {
      defaults();
      const b = $("orphans-toggle");
      if (!b) fail("no orphans toggle");
      if (!b.textContent.includes(fmt(deg0))) fail("orphans count missing");
      b.click();
      if (b.getAttribute("aria-pressed") !== "true") fail("toggle not aria-pressed");
      if (S.nodesShown !== N) fail("nodesShown " + S.nodesShown + " != " + N);
    } finally { restore(s); }
  });

  MX.selftest.add("facets.degSlider", async () => {
    const s = snapshot();
    try {
      defaults();
      const sl = $("mindeg");
      if (!sl) fail("no #mindeg");
      if (+sl.max !== SLMAX) fail("slider max " + sl.max + " != " + SLMAX);
      if (SLMAX < 5) skip("max degree " + maxDeg + " < 5");
      sl.value = "5"; sl.dispatchEvent(new Event("input", {bubbles: true}));
      const ov = $("mindegv");
      if (ov && ov.textContent.trim() !== "5") fail("label not live: " + ov.textContent);
      if (!/5/.test(sl.getAttribute("aria-valuetext") || "")) fail("aria-valuetext " + sl.getAttribute("aria-valuetext"));
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
      if (F.deg !== 5) fail("F.deg " + F.deg);
      const keep = new Set(S.pinned);
      if (S.selected >= 0) keep.add(S.selected);
      if (S.focus) keep.add(S.focus.root);
      let shown = 0;
      for (let i = 0; i < N; i++) if (S.nodeVisible[i]) {
        shown++;
        if (g.deg[i] < 5 && !keep.has(i)) fail("node " + i + " deg " + g.deg[i] + " visible");
      }
      if (shown !== S.nodesShown) fail("nodesShown " + S.nodesShown + " != " + shown);
      if (!/(^|&)deg=5(&|$)/.test(serialize(stateObj()))) fail("deg not in hash");
      resetFacets();
      if (F.deg !== 0 || +sl.value !== 0) fail("reset did not clear deg");
    } finally { restore(s); }
  }, {timeout: 10000});   // one rAF under a busy WebGL frame loop can take seconds headless

  MX.selftest.add("hash.deg", () => {
    const s = snapshot();
    try {
      const o = parse("#orphans=1&deg=5").o;
      if (o.deg !== 5 || !o.orphans) fail("parse deg " + o.deg);
      if (serialize(o) !== "orphans=1&deg=5") fail("serialize " + serialize(o));
      if (serialize({q: "", deg: 0, view: "graph"}) !== "") fail("deg=0 not omitted");
      if (parse("#deg=x").warn.length !== 1) fail("bad deg not warned");
      if (parse("#view=table").o.view !== "tables") fail("table alias");
      if (parse("#n=a&hops=3").o.hops !== 3) fail("hops 3");
      const w = MX.errors.length, nw = MX.warnings.length;
      setFacet("deg", maxDeg + 1000);
      if (F.deg !== maxDeg) fail("not clamped " + F.deg);
      if (MX.errors.length !== w) fail("clamp raised error");
      if (MX.warnings.length !== nw + 1) fail("no clamp warning");
      MX.warnings.length = nw;
    } finally { restore(s); }
  });

  MX.selftest.add("hash.anim", () => {
    const w = MX.warnings.length, was = S.anim, snap = snapshot(), sp0 = F.sp;
    try {
      if (parse("#anim=0").o.anim !== false) fail("anim=0 not parsed");
      if (parse("#sp=2").o.anim !== undefined) fail("anim default not omitted");
      if (serialize({q: "", deg: 0, sp: 2, view: "graph", anim: false}) !== "sp=2&anim=0") fail("serialize order");
      if (serialize({q: "", deg: 0, view: "tables", anim: false}) !== "view=tables&anim=0") fail("anim after view");
      if (serialize({q: "", deg: 0, view: "graph", anim: true}) !== "") fail("anim=true written");
      if (parse("#anim=1").warn.length !== 1 || parse("#anim=1").o.anim !== undefined) fail("anim=1 accepted");
      let evs = 0; const on = () => { evs++; }; MX.on("anim", on);
      setAnim(false, true);
      if (S.anim !== false || document.documentElement.dataset.anim !== "0") fail("setAnim(false) state");
      if (serialize(stateObj()).split("&").pop() !== "anim=0") fail("stateObj anim");
      resetFacets();
      if (S.anim !== false) fail("Reset filters changed anim");
      setAnim(true, true);
      if (S.anim !== true || "anim" in document.documentElement.dataset) fail("setAnim(true) state");
      if (serialize(stateObj()).includes("anim")) fail("anim written when on");
      if (evs !== 2) fail("anim events " + evs);
    } finally { setAnim(was, true); restore(snap); F.sp = sp0; tellSp(); MX.warnings.length = w; }
  });

  MX.selftest.add("hash.roundtrip", () => {
    if (!NT || !D.communities.length || !D.rels.length) skip("no types / communities / relationships to encode");
    const weird = ["a & b", "x#y=z", "100% done", "p|q r", "c:dbo.T a&b#c=d%e|f"];
    const cases = [
      {q: "big sales & co #1 = 100%", type: [D.types[0], D.types[NT - 1]], comm: [D.communities[0]],
       rel: [D.rels[0]], prov: ["AMBIGUOUS"], orphans: true, deg: 7, sp: 2.5, n: weird[4], hops: 3, path: null, view: "tables"},
      {q: "", type: null, comm: null, rel: null, prov: ["EXTRACTED", "INFERRED"], orphans: false,
       deg: 0, sp: 0.5, n: null, hops: 0, path: [weird[0], weird[3]], view: "graph"},
      ...weird.map(id => ({q: id, type: null, comm: null, rel: null, prov: null, orphans: false,
                           deg: 0, sp: 1, n: id, hops: 0, path: null, view: "graph"})),
      {q: "", type: null, comm: null, rel: null, prov: null, orphans: false,
       deg: 0, sp: 2, n: null, hops: 0, path: null, view: "tables", anim: false},
      stateObj(),
    ];
    const real = g.id.find(id => /[ &#=%]/.test(id));
    if (real) cases.push({q: "", type: null, comm: null, rel: null, prov: null, orphans: false,
                          deg: 2, sp: 1.25, n: real, hops: 1, path: null, view: "graph"});
    for (const c of cases) {
      const h = serialize(c), r = parse(h);
      if (r.warn.length) fail("warnings for " + h + ": " + r.warn.join("; "));
      const a = JSON.stringify(c), b = JSON.stringify(r.o);
      if (a !== b) fail("roundtrip " + h + ": " + a + " != " + b);
      if (serialize(r.o) !== h) fail("reserialise " + h);
    }
    if (parse("#q=%E0%A4%A&prov=AMBIGUOUS").o.prov[0] !== "AMBIGUOUS") fail("malformed % not isolated");
  });
})();
