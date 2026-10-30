(function () {
  "use strict";
  // Keyboard model + help dialog. S.view is owned by
  // dash.js; ui.js owns S.kbdCursor only. Every DOM lookup is null-safe.
  const g = MX.g, S = MX.state, D = g.D, N = g.N;
  const $ = id => document.getElementById(id);
  const links = i => g.adjOff[i + 1] - g.adjOff[i];
  const say = i => (MX.describe ? MX.describe(i) : g.label[i] + ", " + D.types[g.type[i]] + ", " + links(i) + " links");
  const PAN = 60, HIST = 50, CAM0 = /[#&]cam=(U[0-4]|-?[\d.]+,)/.test(location.hash);  // #cam= (diagnostic / 3D test view) owns the first view
  const ORB = 15 * Math.PI / 180;   // [ ] { }: orbit step

  // ---- selection history (Backspace) -----------------------------------------
  const hist = [];
  let cur = -1, goingBack = false;
  function onSelect(i) {
    if (!goingBack && cur >= 0 && cur !== i) { hist.push(cur); if (hist.length > HIST) hist.shift(); }
    cur = i;
    if (S.kbdCursor !== -1) { S.kbdCursor = -1; MX.requestDraw(); }
    if (U) {
      const u = S.universe;
      if (i >= 0) Object.assign(u, {level: "body", cluster: U.clusterOf(i), galaxy: U.galaxyOf(i), system: U.systemOf(i)});
      else if (u.level === "body") u.level = u.system >= 0 ? "system" : u.galaxy >= 0 ? "galaxy" : "universe";
      canvasLabel();
    }
    tools();
  }
  function offscreen(i) {
    const cv = $("cv"), p = MX.camera.screen(i);
    return !cv || p[0] < 0 || p[1] < 0 || p[0] > cv.clientWidth || p[1] > cv.clientHeight;
  }
  const go = i => MX.select(i, {center: offscreen(i), announce: true});
  function back() {
    while (hist.length && hist[hist.length - 1] === S.selected) hist.pop();
    if (!hist.length) { if (S.selected >= 0 && U) up(); else MX.announce("No previous selection"); return; }
    goingBack = true;
    try { go(hist.pop()); } finally { goingBack = false; }
  }

  // ---- universe drill-down: S.universe = {level, cluster, galaxy, system} -----------------
  // level = the kind of the keyboard cursor (universe | cluster | galaxy | system | body = a selection). Arrows
  // cycle siblings (visible bodies desc) and fly to them, Enter drills into the first child, Backspace climbs.
  const U = MX.universe && MX.universe.clusters ? MX.universe : null;
  const LV = ["universe", "cluster", "galaxy", "system", "body"];
  let vc = null;                           // visible counts, dropped on every visibility / repack
  function counts() {
    if (vc) return vc;
    const nC = U.clusters.length, nG = U.galaxies.length, nS = U.systems.length, nv = S.nodeVisible;
    const cB = new Uint32Array(nC), gB = new Uint32Array(nG), sB = new Uint32Array(nS), cS = new Uint32Array(nC), gS = new Uint32Array(nG);
    for (let i = 0; i < N; i++) if (nv[i]) { cB[U.clusterOf(i)]++; gB[U.galaxyOf(i)]++; const y = U.systemOf(i); if (y >= 0) sB[y]++; }
    for (let y = 0; y < nS; y++) if (sB[y]) { const k = U.systems[y].galaxy; gS[k]++; cS[U.galaxies[k].cluster]++; }
    return (vc = {cB, gB, sB, cS, gS});
  }
  // siblings of a level (indices, visible only, bodies desc then index): clusters | galaxies of c | systems of k
  function siblings(level, u) {
    const v = counts(), by = a => (x, y) => a[y] - a[x] || x - y;
    if (level === "cluster") return U.clusters.map((_, c) => c).filter(c => v.cB[c]).sort(by(v.cB));
    if (level === "galaxy") return u.cluster >= 0 ? U.clusters[u.cluster].galaxies.filter(k => v.gB[k]).sort(by(v.gB)) : [];
    if (level === "system") return u.galaxy >= 0 ? Array.from(U.galaxies[u.galaxy].systems).filter(y => v.sB[y]).sort(by(v.sB)) : [];
    return [];
  }
  const idxOf = (u, level) => (level === "cluster" ? u.cluster : level === "galaxy" ? u.galaxy : u.system);
  function describeAt(level, u) {
    const v = counts(), sib = siblings(level, u), j = sib.indexOf(idxOf(u, level)) + 1, n = sib.length;
    if (level === "cluster") return U.clusters[u.cluster].name + " cluster, " + j + " of " + n + ", " + MX.fmt(v.cB[u.cluster]) + " bodies, " + MX.fmt(v.cS[u.cluster]) + " systems";
    if (level === "galaxy") return U.galaxies[u.galaxy].name + " galaxy, " + j + " of " + n + " in " + U.clusters[u.cluster].name + ", " + MX.fmt(v.gB[u.galaxy]) + " bodies, " + MX.fmt(v.gS[u.galaxy]) + " systems";
    if (level === "system") return "System " + U.systems[u.system].name + ", " + j + " of " + n + ", " + MX.fmt(v.sB[u.system]) + " members";
    return "Universe, " + siblings("cluster", u).length + " clusters, " + MX.fmt(S.nodesShown) + " bodies";
  }
  // move the cursor to (level, index) inside the current parents; flies unless opts.fly === false
  function setLevel(level, k, opts) {
    opts = opts || {};
    const u = S.universe;
    if (S.selected >= 0) MX.select(-1, {announce: false});
    if (level === "universe") Object.assign(u, {level, cluster: -1, galaxy: -1, system: -1});
    else if (level === "cluster") Object.assign(u, {level, cluster: k, galaxy: -1, system: -1});
    else if (level === "galaxy") Object.assign(u, {level, cluster: U.galaxies[k].cluster, galaxy: k, system: -1});
    else if (level === "system") { const k2 = U.systems[k].galaxy; Object.assign(u, {level, cluster: U.galaxies[k2].cluster, galaxy: k2, system: k}); }
    else return false;
    const sun = level === "system" ? U.systems[k].sun : -1;
    S.kbdCursor = sun >= 0 && S.nodeVisible[sun] ? sun : -1;
    if (opts.fly !== false && S.view === "graph") { if (level === "universe") MX.camera.flyFit(null, opts); else MX.camera.flyKind(level, k, opts); }
    if (opts.announce !== false) MX.announce(describeAt(level, u));
    canvasLabel(); MX.requestDraw(); MX.status();
    return true;
  }
  function sibling(step) {
    const u = S.universe, lv = u.level === "universe" ? "cluster" : u.level, sib = siblings(lv, u);
    if (!sib.length) { MX.announce("Nothing visible at this level"); return; }
    const j = u.level === "universe" ? -1 : sib.indexOf(idxOf(u, lv));
    setLevel(lv, sib[j < 0 ? (step > 0 ? 0 : sib.length - 1) : (j + step + sib.length) % sib.length]);
  }
  function drillIn() {
    const u = S.universe, d = LV.indexOf(u.level);
    if (u.level === "system") {            // at system level, select the sun (else the top visible member)
      let i = U.systems[u.system].sun;
      if (!S.nodeVisible[i]) { i = -1; for (let q = U.memStart[u.system]; q < U.memStart[u.system + 1] && i < 0; q++) if (S.nodeVisible[U.members[q]]) i = U.members[q]; }
      if (i >= 0) MX.select(i, {center: true, announce: true});
      return;
    }
    if (d < 0 || d > 2) return;
    const lv = LV[d + 1], sib = siblings(lv, u);
    if (!sib.length) { MX.announce("No visible " + (lv === "galaxy" ? "galaxies" : lv + "s") + " inside"); return; }
    setLevel(lv, sib[0]);
  }
  function up() {
    const u = S.universe;
    if (S.selected >= 0) {
      const y = U.systemOf(S.selected), k = U.galaxyOf(S.selected);
      return y >= 0 ? setLevel("system", y) : setLevel("galaxy", k);
    }
    if (u.level === "system") return setLevel("galaxy", u.galaxy);
    if (u.level === "galaxy") return setLevel("cluster", u.cluster);
    if (u.level === "cluster") return setLevel("universe");
    MX.announce(describeAt("universe", u));
  }
  // nearest centre of `kind` whose radius covers world point (x, y); -1 if none. 3D: with screen point (sx, sy), the
  // projected centre and radius decide (nearest to the camera wins among the covering ones)
  function containerAt(kind, x, y, sx, sy) {
    const v = counts(), on = kind === "cluster" ? v.cB : kind === "galaxy" ? v.gB : v.sB, scr = sx != null && MX.camera && MX.camera.project;
    let best = -1, bd = Infinity;
    for (let k = 0; k < on.length; k++) {
      if (!on[k]) continue;
      const c = U.centerOf(kind, k);
      if (!c) continue;
      if (scr) {
        const q = MX.camera.project(c[0], c[1], c[2] || 0);
        if (!q) continue;
        const d = Math.hypot(q[0] - sx, q[1] - sy), R = U.radiusOf(kind, k) * S.camera.scale * q[2];
        if (d <= R && 1 / q[2] < bd) { bd = 1 / q[2]; best = k; }
        continue;
      }
      const d = Math.hypot(c[0] - x, c[1] - y);
      if (d <= U.radiusOf(kind, k) && d < bd) { bd = d; best = k; }
    }
    return best;
  }
  const bandNow = () => U.bandFor(S.camera.scale, MX.camera.fitAll);   // band of the current camera (no frame needed)
  // pointer hooks (render.js): click on empty space flies to the cluster (U0) / galaxy (U1) under it, else clears
  function clickAt(x, y, sx, sy) {
    if (!U) { MX.select(-1); return false; }
    const b = bandNow(), kind = b <= 0 ? "cluster" : b === 1 ? "galaxy" : "";
    const k = kind ? containerAt(kind, x, y, sx, sy) : -1;
    if (k >= 0) return setLevel(kind, k);
    if (S.selected >= 0) MX.select(-1);
    return false;
  }
  function dblAt(x, y, i, sx, sy) {        // one level in from the current one, at the pointer (a body: select + fly)
    if (i >= 0) { MX.select(i, {center: true, announce: true}); return true; }
    if (!U) return false;
    const d = S.selected >= 0 ? 4 : LV.indexOf(S.universe.level);
    for (let lv = Math.max(1, d + 1); lv <= 3; lv++) { const k = containerAt(LV[lv], x, y, sx, sy); if (k >= 0) return setLevel(LV[lv], k); }
    return false;
  }
  // camera framing of the navigation state: first settle (instant), #comm= changes, Communities "Fly to"
  function commHub(c) {
    let best = -1;
    for (let i = 0; i < N; i++) if (g.comm[i] === c && S.nodeVisible[i] && (best < 0 || g.deg[i] > g.deg[best])) best = i;
    return best;
  }
  function flyComm(c, hub, opts) {
    const h = hub >= 0 && hub < N && S.nodeVisible[hub] && g.comm[hub] === c ? hub : commHub(c);
    if (h < 0) return false;
    return setLevel("galaxy", U.galaxyOf(h), Object.assign({announce: false}, opts));
  }
  const oneComm = () => { const c = S.facets.comm; return c && c.size === 1 ? [...c][0] : -1; };
  let framed = false, commKey = "";
  function frameNav(opts) {
    if (S.path && S.path.found) return MX.camera.flyFit(S.path.nodes, opts);
    if (S.focus) { const ids = []; for (let i = 0; i < N; i++) if (S.focus.set[i]) ids.push(i); return MX.camera.flyFit(ids, opts); }
    if (S.selected >= 0) return MX.camera.flyBody(S.selected, opts);
    const c = oneComm();
    if (c >= 0) return flyComm(c, -1, opts);
    return false;
  }
  function onFirstSettle() {
    if (framed || !U) return;
    framed = true; commKey = String(oneComm());
    if (!CAM0) frameNav({instant: true});
  }
  function onRepack() {
    vc = null;
    if (!framed) return;
    const k = String(oneComm());
    if (k === commKey) return;
    commKey = k;
    if (k !== "-1" && S.selected < 0 && !S.path && !S.focus) flyComm(+k, -1);
  }
  function onFlyReq(d) {
    if (!d || !U || !U.started) return;
    if (d.kind === "community") {
      const c = +d.k;
      if (flyComm(c, d.hub == null ? -1 : +d.hub)) {
        let n = 0; for (let i = 0; i < N; i++) if (g.comm[i] === c && S.nodeVisible[i]) n++;
        MX.announce("Community " + D.communities[c] + ", " + MX.fmt(n) + " bodies shown; " + describeAt("galaxy", S.universe));
      }
    }
    else if (d.kind === "body") MX.select(+d.k, {center: true, announce: true});
    else if (/^(cluster|galaxy|system)$/.test(d.kind) && +d.k >= 0) setLevel(d.kind, +d.k);
  }

  function topVisible() {
    let best = -1;
    for (let i = 0; i < N; i++) if (S.nodeVisible[i] && (best < 0 || g.deg[i] > g.deg[best])) best = i;
    return best;
  }
  function neighbours(i) {                 // visible, deduped, CSR order
    const out = [], seen = new Set([i]);
    for (let a = g.adjOff[i]; a < g.adjOff[i + 1]; a++) {
      const e = g.adjEdge[a], j = g.src[e] === i ? g.dst[e] : g.src[e];
      if (!seen.has(j) && S.nodeVisible[j]) { seen.add(j); out.push(j); }
    }
    return out;
  }
  function cycle(step) {
    const nb = neighbours(S.selected);
    if (!nb.length) { MX.announce("No visible neighbours"); return; }
    const k = nb.indexOf(S.kbdCursor);
    S.kbdCursor = nb[k < 0 ? (step > 0 ? 0 : nb.length - 1) : (k + step + nb.length) % nb.length];
    MX.requestDraw();
    MX.announce(say(S.kbdCursor));
  }
  function planets(step) {                 // PageUp/PageDown: the selected body's system, orbit order
    const y = U.systemOf(S.selected), m = [];
    if (y >= 0) for (let q = U.memStart[y]; q < U.memStart[y + 1]; q++) if (S.nodeVisible[U.members[q]]) m.push(U.members[q]);
    if (m.length < 2) { MX.announce("No other bodies in this system"); return; }
    const k = m.indexOf(S.kbdCursor >= 0 ? S.kbdCursor : S.selected);
    S.kbdCursor = m[k < 0 ? 0 : (k + step + m.length) % m.length];
    MX.requestDraw();
    MX.announce(say(S.kbdCursor));
  }
  function needSel() { if (S.selected >= 0) return true; MX.announce("Select a node first"); return false; }
  function pathPick() {
    if (!needSel()) return;
    const b = document.querySelector("#panel button[data-act=pathpick]");
    if (b) b.click();
  }
  function fit() { MX.camera.fit(0.88); MX.announce("Fit graph"); }

  // ---- canvas keys -------------------------------------------------------------
  const ARROW = {ArrowLeft: [PAN, 0, -1], ArrowUp: [0, PAN, -1], ArrowRight: [-PAN, 0, 1], ArrowDown: [0, -PAN, 1]};
  // AltGr layouts type [ ] { } \ as Ctrl+Alt+<key>: that is the plain character, not a shortcut
  const altGr = e => e.ctrlKey && e.altKey && "[]{}\\".includes(e.key);
  const lower = k => (k.length === 1 ? k.toLowerCase() : k);   // letter keys: case-insensitive (Caps Lock, Shift)
  function onCanvasKey(e) {
    if (e.defaultPrevented || e.metaKey || ((e.ctrlKey || e.altKey) && !altGr(e))) return;
    const k = e.key, a = ARROW[k];
    if (a) {
      if (e.shiftKey || (S.selected < 0 && !U)) MX.camera.panBy(a[0], a[1]);
      else if (S.selected >= 0) cycle(a[2]);
      else sibling(a[2]);
    } else if (k === "Enter") {
      if (S.selected >= 0 || !U) { if (S.kbdCursor >= 0) go(S.kbdCursor); else return; }
      else drillIn();
    } else if ((k === "PageUp" || k === "PageDown") && U && S.selected >= 0) planets(k === "PageDown" ? 1 : -1);
    else if (k === "Home") {
      const i = topVisible(); if (i >= 0) go(i);
    } else if (k === "Backspace") { if (S.selected >= 0 || !U) back(); else up(); }
    else if (k === "+" || k === "=") { MX.camera.zoomBy(1.25); MX.announce("Zoomed in"); }
    else if (k === "-" || k === "_") { MX.camera.zoomBy(0.8); MX.announce("Zoomed out"); }
    else if (k === "0") fit();
    else if ((k === "[" || k === "]" || k === "{" || k === "}") && MX.camera.orbit && S.view3d) {   // orbit the 3D view (2D: nothing)
      if (k === "[" || k === "]") MX.camera.orbit(k === "[" ? -ORB : ORB, 0); else MX.camera.orbit(0, k === "{" ? -ORB : ORB);
      MX.announce("View rotated");
    }
    else if (k === "1" || k === "2") { if (needSel()) MX.focusOn(S.selected, k === "2" ? 2 : 1); }
    else if (lower(k) === "p") pathPick();
    else return;
    e.preventDefault();
  }

  // ---- help dialog: focus-trapped, restores focus ---------------------------
  const HELP = [
    ["/", "Search"], ["?", "This help"], ["g", "Graph / last dashboard tab"],
    ["Esc", "Close help, clear search, clear focus or path, clear selection, back to the whole universe"],
    ["Tab", "Move into the graph"],
    ["← → ↑ ↓", "No selection: next / previous cluster, galaxy or system (flies there). With a selection: cycle its neighbours"],
    ["Enter", "Drill in: cluster → galaxy → system → its sun; with a selection, select the cursor"],
    ["Backspace", "Previous selection, else up one level (system → galaxy → cluster → universe)"],
    ["Page Up / Down", "Cycle the bodies of the selected body's system"],
    ["Shift + arrows", "Pan"], ["Home", "Select the top-degree visible node"],
    ["Click / double-click", "Select a body (double-click flies to it); on empty space fly into the cluster or galaxy under the pointer"],
    ["Drag", "Pan; right- or middle-drag also pans; two fingers pinch-zoom"],
    ["Shift + drag", "Orbit the 3D view (2D: nothing)"],
    ["Scroll / Ctrl + drag", "Zoom toward the pointer (Ctrl-drag up = in, down = out)"],
    ["[ ] / { }", "Orbit (3D): turn left / right, tilt flatter / steeper"],
    ["v", "2D / 3D view: face-on and flat, or tilted with depth"], ["m", "Minimap on / off"],
    ["u", "Multiverse: switch to another universe (indexed folder)"],
    ["f", "Full screen (Esc exits)"], ["Alt + [", "Collapse / expand the sidebar"], ["Alt + ]", "Collapse / expand the inspector"],
    ["\\", "Collapse / expand both panels"],
    ["Drag a body", "Pull its solar system; it springs back"],
    ["+ −", "Zoom"], ["0", "Fit graph"], ["1 / 2", "Focus 1 / 2 hops"], ["p", "Path to…"],
  ];
  let opener = null;
  const helpOpen = () => { const h = $("help"); return !!h && !h.hidden; };
  const focusables = h => [...h.querySelectorAll("button, [href], input, [tabindex]:not([tabindex='-1'])")]
    .filter(el => !el.disabled);
  function openHelp() {
    const h = $("help"); if (!h) return;
    opener = document.activeElement;
    h.hidden = false;
    const b = $("help-btn"); if (b) b.setAttribute("aria-expanded", "true");
    (focusables(h)[0] || h).focus({preventScroll: true});   // the list scrolls: open at its top, not at Close
    h.scrollTop = 0;
  }
  function closeHelp() {
    const h = $("help"); if (!h || h.hidden) return;
    h.hidden = true;
    const b = $("help-btn"); if (b) b.setAttribute("aria-expanded", "false");
    const t = opener && opener.isConnected && opener !== document.body ? opener : b;
    opener = null;
    if (t && t.focus) t.focus();
  }
  const toggleHelp = () => (helpOpen() ? closeHelp() : openHelp());
  function buildHelp() {
    let h = $("help");
    if (!h) {                              // template mid-rearrangement: keep aria-describedby valid
      h = document.createElement("div");
      h.id = "help"; h.className = "popover"; h.hidden = true;
      document.body.appendChild(h);
    }
    h.setAttribute("role", "dialog");
    h.setAttribute("aria-modal", "true");
    if (!h.getAttribute("aria-label")) h.setAttribute("aria-label", "Keyboard help");
    h.tabIndex = -1;
    h.innerHTML = "<p class='meta'>Keyboard: tab into the graph, then</p><dl>" +
      HELP.map(([k, v]) => "<dt><kbd class='kbd'>" + MX.esc(k) + "</kbd></dt><dd>" + MX.esc(v) + "</dd>").join("") +
      "</dl><button type='button' data-act='close-help'>Close</button>";
    h.addEventListener("click", e => { if (e.target.closest("[data-act=close-help]")) closeHelp(); });
    h.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeHelp(); return; }
      if (e.key !== "Tab") return;
      const f = focusables(h);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1], ae = document.activeElement;
      if (e.shiftKey && (ae === first || ae === h)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && ae === last) { e.preventDefault(); first.focus(); }
    });
    document.addEventListener("focusin", e => {
      if (helpOpen() && !h.contains(e.target)) (focusables(h)[0] || h).focus();
    });
    document.addEventListener("pointerdown", e => {
      const b = $("help-btn");
      if (helpOpen() && !h.contains(e.target) && !(b && b.contains(e.target))) { opener = null; closeHelp(); }
    });
    const b = $("help-btn");
    if (b) { b.hidden = false; b.setAttribute("aria-expanded", "false"); b.addEventListener("click", toggleHelp); }
  }

  // ---- global keys ---------------------------------------------------------------
  const typing = t => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  function clearSearch() {
    const inp = $("search");
    if (!inp || !(inp.value || S.q)) return false;
    // filter.js owns the search UI: let its own Esc handler clear it (non-bubbling, no re-entry)
    return !inp.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", cancelable: true}));
  }
  function onGlobalKey(e) {
    if (e.defaultPrevented || e.metaKey) return;
    const k = e.key, gr = altGr(e);
    if (k === "Escape" && !e.ctrlKey && !e.altKey) {
      if (helpOpen()) closeHelp();
      else if (immersive) setImmersive(false);
      else if (clearSearch()) { /* cleared */ }
      else if (S.focus || S.path) MX.clearFocus();
      else if (S.selected >= 0) MX.select(-1);
      else if (U && S.view === "graph" && S.universe.level !== "universe") setLevel("universe");
      else return;
      e.preventDefault();
      return;
    }
    if (typing(e.target)) return;         // before every shortcut, Alt ones included
    if (e.altKey && !gr) {                 // Alt+[ / Alt+]: sidebar / inspector, by physical key (layout-independent)
      const sd = e.code === "BracketLeft" ? "left" : e.code === "BracketRight" ? "right" : "";
      if (sd && !e.ctrlKey) { e.preventDefault(); setPanel(sd, !pstate[sd], {focus: true}); }
      return;
    }
    if (e.ctrlKey && !gr) return;
    const lk = lower(k);
    if (k === "/") {
      const s = $("search"); if (!s) return;
      closeHelp();
      if (!pstate.left) setPanel("left", true);   // a collapsed sidebar is inert: open it first
      s.focus();
    }
    else if (k === "?") toggleHelp();
    else if (lk === "u") { if (!MX.multiverse) return; closeHelp(); MX.multiverse.toggle(); }
    else if (lk === "f") fsToggle();
    else if (k === "\\") { const open = !(pstate.left || pstate.right); setPanel("left", open); setPanel("right", open); }
    else if (lk === "v") viewToggle();
    else if (lk === "g") {
      if (!MX.dash || !MX.dash.setView) return;
      MX.dash.setView(S.view === "graph" ? (S.dash && S.dash.lastTab) || "overview" : "graph");
    } else return;
    e.preventDefault();
  }

  // ---- Focus & path rail (#f-tools, optional) ------------------------------------
  function tools() {
    const st = $("tool-state"), sel = S.selected >= 0, fp = !!(S.focus || S.path);
    if (st) {
      st.textContent = S.path ? (S.path.found ? "Path: " + (S.path.nodes.length - 1) + " hops" : "Path: none found")
        : S.focus ? "Focus: " + MX.fmt(S.focus.size) + " nodes, " + S.focus.hops + (S.focus.hops > 1 ? " hops" : " hop")
        : sel ? "Selected: " + g.label[S.selected] : "Nothing selected";
    }
    for (const id of ["tool-focus1", "tool-focus2", "tool-path"]) { const b = $(id); if (b) b.disabled = !sel; }
    const c = $("tool-clear"); if (c) c.disabled = !fp;
  }
  function canvasLabel() {
    const cv = $("cv");
    if (!cv) return;
    if (!U) { cv.setAttribute("aria-label", "Knowledge graph, " + MX.fmt(S.nodesShown) + " nodes shown"); return; }
    const v = counts(), n = a => a.reduce((t, x) => t + (x ? 1 : 0), 0);
    cv.setAttribute("aria-label", "Knowledge universe: " + n(v.cB) + " clusters, " + MX.fmt(n(v.gB)) + " galaxies, " +
      MX.fmt(n(v.sB)) + " systems; " + MX.fmt(S.nodesShown) + " bodies shown. Level: " + S.universe.level);
  }

  // ---- empty canvas: nothing indexed, or every node an orphan with orphans hidden -> one quiet centred line ----------
  let orphansN = -1;
  function emptySync() {
    const el = $("empty-msg");
    if (!el) return;
    if (orphansN < 0) { orphansN = 0; for (let i = 0; i < N; i++) if (!g.deg[i]) orphansN++; }
    const kind = N === 0 ? "none" : S.nodesShown === 0 && !S.facets.orphans && orphansN === N ? "orphans" : "";
    if (el.dataset.kind === kind) return;
    el.dataset.kind = kind;
    el.hidden = !kind;
    el.innerHTML = kind === "none" ? "<span class='em-t'>Nothing indexed yet · run <code>indexer.py --full</code></span>"
      : kind === "orphans" ? "<span class='em-t'>No linked nodes · orphans hidden —</span><button type='button' data-act='show-orphans'>show orphans</button>"
      : "";
  }

  // ---- skip link: the inspector, or the active dashboard pane while the empty inspector is folded away (dash.css
  // body.dash-wide). Handled here so activating it never writes "#panel" into the URL hash (filter.js would read it as
  // navigation and clear the selection).
  const folded = () => S.view !== "graph" && S.selected < 0 && !S.focus && !S.path;   // = dash.js wide()
  function skipTarget() {
    const tab = folded() && $("tab-" + S.view), p = tab && $(tab.getAttribute("aria-controls"));
    return p || $("panel");
  }
  function skipSync() {
    const a = $("skip"), t = skipTarget();
    if (!a || !t) return;
    if (!t.hasAttribute("tabindex")) t.tabIndex = -1;
    a.setAttribute("href", "#" + t.id);
    a.textContent = t.id === "panel" ? "Skip to inspector" : "Skip to " + ($("tab-" + S.view).textContent || "content");
  }

  MX.module("ui", () => {
    const cv = $("cv");
    if (cv) {
      cv.tabIndex = 0;
      cv.setAttribute("role", "application");
      cv.setAttribute("aria-roledescription", U ? "knowledge universe" : "graph");
      cv.setAttribute("aria-describedby", "help");
      cv.addEventListener("keydown", onCanvasKey);
    }
    buildHelp();
    canvasLabel();
    document.addEventListener("keydown", onGlobalKey);   // after inspector's: it consumes Esc first

    const hint = $("hint");
    if (hint && !/^MXBENCH/.test(hint.textContent)) hint.textContent = hintText(S.view3d);

    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
    on("reset", () => {
      MX.clearFocus();
      MX.select(-1);
      MX.camera.reset(0.88);               // userAdjusted = false: a still-settling layout keeps framing; no reheat
      MX.announce("View reset");
    });
    const zoom = $("zoom"); if (zoom) zoom.hidden = false;
    on("zoom-in", () => MX.camera.zoomBy(1.25));
    on("zoom-out", () => MX.camera.zoomBy(0.8));
    on("zoom-fit", () => { if (!MX.camera.flyFit(null)) MX.camera.fit(0.88); });
    on("tool-focus1", () => { if (needSel()) MX.focusOn(S.selected, 1); });
    on("tool-focus2", () => { if (needSel()) MX.focusOn(S.selected, 2); });
    on("tool-path", pathPick);
    on("tool-clear", () => MX.clearFocus());

    MX.on("select", onSelect);
    MX.on("focus", tools);
    MX.on("path", tools);
    MX.on("visibility", () => { vc = null; canvasLabel(); emptySync(); });
    const em = $("empty-msg");
    if (em) em.addEventListener("click", e => { if (e.target.closest("[data-act=show-orphans]")) MX.filter.setFacet("orphans", true); });
    if (U) { MX.on("repack", onRepack); MX.on("settled", onFirstSettle); MX.on("flyreq", onFlyReq); }
    MX.on("ready", () => { canvasLabel(); tools(); animRestore(); skipSync(); emptySync(); });
    for (const ev of ["view", "select", "focus", "path"]) MX.on(ev, skipSync);
    const skip = $("skip");
    if (skip) skip.addEventListener("click", e => {
      e.preventDefault(); skipSync(); const t = skipTarget();
      if (t && t.id === "panel" && !pstate.right) setPanel("right", true);
      if (t) t.focus();
    });
    skipSync();
    const ab = $("anim");
    if (ab) {
      ab.addEventListener("click", () => { MX.filter.setAnim(!S.anim); animSave(); });
      MX.on("anim", animSync);
      animSync();
    }
    const vb = $("view3d");
    if (vb) { vb.addEventListener("click", viewToggle); MX.on("view3d", viewSync); viewSync(); }
    tools();
    panelsInit();
    MX.camera.fit(0.88);
  });


  // ---- panels: the sidebar (left) and the inspector (right) collapse to a 28 px rail; full screen ---------------------
  // State = body.l-collapsed / body.r-collapsed (app.css moves the plates, the stage chrome and the dashboard panes off
  // --lx / --rx). The safe rect reads the static #reserve-left / #reserve-right (final geometry at once, never a plate
  // mid-slide); "chrome" re-measures; the camera glides by the safe-centre shift (or re-fits an untouched fit-all).
  // localStorage mx.panels = {l, r} (true = open); #panels=left|right|both|fs is a screenshot hook (not stored).
  const PKEY = "mx.panels", PANEL = {left: "side", right: "panel"}, NAME = {left: "Sidebar", right: "Inspector"};
  const pstate = {left: true, right: true};
  let immersive = false, preImm = null, glideRaf = 0, chromeT = 0;
  const motionNow = () => (MX.motionOK ? MX.motionOK() : true);
  const DUR = () => (motionNow() ? 700 : 0);
  function panelsLoad() {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(PKEY) || "null"); } catch (e) { v = null; }
    if (v && typeof v === "object") { if (typeof v.l === "boolean") pstate.left = v.l; if (typeof v.r === "boolean") pstate.right = v.r; }
    else if (matchMedia("(max-width: 1100px)").matches) pstate.left = false;   // narrow screens start with the canvas
  }
  function panelsSave() {
    if (immersive) return;                 // full-screen collapses are not preferences
    try { localStorage.setItem(PKEY, JSON.stringify({l: pstate.left, r: pstate.right})); } catch (e) { /* storage blocked */ }
  }
  function paintPanels() {
    const b = document.body;
    b.classList.toggle("l-collapsed", !pstate.left);
    b.classList.toggle("r-collapsed", !pstate.right);
    for (const sd of ["left", "right"]) {
      const open = pstate[sd], el = $(PANEL[sd]), grip = $("grip-" + sd), rail = $("rail-" + sd), ex = $("expand-" + sd);
      if (el) { el.inert = !open; if (open) el.removeAttribute("aria-hidden"); else el.setAttribute("aria-hidden", "true"); }
      if (grip) { grip.setAttribute("aria-expanded", String(open)); grip.inert = !open; }
      if (ex) ex.setAttribute("aria-expanded", String(open));
      if (rail) rail.inert = open;
    }
  }
  // glide the content by the safe-centre shift (incremental, so a concurrent pan is kept)
  function glide(dx, dy, ms) {
    cancelAnimationFrame(glideRaf);
    const c = S.camera;
    if (!ms) { MX.camera.restore({panX: c.panX + dx, panY: c.panY + dy}); return; }
    const t0 = performance.now(), ease = t => 1 - Math.pow(1 - t, 4);
    let px = 0, py = 0;
    const step = now => {
      const t = Math.min(1, (now - t0) / ms), e = ease(t);
      MX.camera.restore({panX: S.camera.panX + dx * e - px, panY: S.camera.panY + dy * e - py});
      px = dx * e; py = dy * e;
      if (t < 1) glideRaf = requestAnimationFrame(step);
    };
    glideRaf = requestAnimationFrame(step);
  }
  function reflow(ms) {
    const C = MX.camera, sr0 = C && C.safeRect ? C.safeRect() : null;
    MX.emit("chrome");                     // render: safe rect + fit; minimap / cosmos re-measure
    clearTimeout(chromeT);
    if (ms) chromeT = setTimeout(() => MX.emit("chrome"), ms + 40);   // cosmos: plates have landed
    if (!sr0 || S.view !== "graph" || !U || !U.started) return;
    const sr1 = C.safeRect(), dx = (sr1.l + sr1.r - sr0.l - sr0.r) / 2, dy = (sr1.t + sr1.b - sr0.t - sr0.b) / 2;
    if (!dx && !dy) return;
    if (!S.camera.userAdjusted && S.selected < 0 && !S.focus && !S.path) { if (!C.flyFit(null, {instant: !ms})) C.fit(0.88); }
    else glide(dx, dy, ms);
  }
  // setPanel(side, open, {focus, quiet}): focus = keyboard / button origin -> focus follows to the other control
  function setPanel(side, open, opts) {
    opts = opts || {};
    open = !!open;
    if (pstate[side] === open) return false;
    const ae = document.activeElement, el = $(PANEL[side]);
    const inside = ae && ae !== document.body && ((el && el.contains(ae)) || ae === $("grip-" + side) || ae === $("expand-" + side));
    pstate[side] = open;
    if (!opts.quiet) panelsSave();
    paintPanels();
    reflow(DUR());
    if (inside || opts.focus) { const t = $(open ? "grip-" + side : "expand-" + side); if (t && t.focus) t.focus({preventScroll: true}); }
    if (!opts.quiet) MX.announce(NAME[side] + (open ? " expanded" : " collapsed"));
    MX.status();
    return true;
  }

  // full screen: the Fullscreen API on <html>; unavailable / refused -> immersive (both panels collapse, header hides).
  const fsActive = () => !!document.fullscreenElement || immersive;
  function fsSync() {
    const on = fsActive(), b = $("fullscreen"), x = $("fs-exit");
    if (b) { b.setAttribute("aria-pressed", String(on)); b.setAttribute("aria-label", on ? "Exit full screen" : "Full screen"); b.title = on ? "Exit full screen (f or Esc)" : "Full screen (f)"; }
    if (x) x.hidden = !immersive;
    document.body.classList.toggle("is-fs", on);
    MX.status();
  }
  function setImmersive(on) {
    on = !!on;
    if (on === immersive) { fsSync(); return; }
    immersive = on;
    if (on) { preImm = {left: pstate.left, right: pstate.right}; pstate.left = pstate.right = false; }
    else if (preImm) { pstate.left = preImm.left; pstate.right = preImm.right; preImm = null; }
    document.body.classList.toggle("immersive", on);
    paintPanels(); reflow(DUR()); fsSync();
    if (!on) { const b = $("fullscreen"); if (b && document.activeElement === $("fs-exit")) b.focus(); }
    MX.announce(on ? "Full screen" : "Full screen off");
  }
  function fsToggle() {
    if (fsActive()) {
      if (immersive) setImmersive(false);
      else if (document.exitFullscreen) { const q = document.exitFullscreen(); if (q && q.catch) q.catch(fsSync); }
      return;
    }
    const de = document.documentElement;
    if (document.fullscreenEnabled === false || typeof de.requestFullscreen !== "function") { setImmersive(true); return; }
    let q;
    try { q = de.requestFullscreen(); } catch (e) { setImmersive(true); return; }
    if (q && typeof q.then === "function") q.then(fsSync, () => setImmersive(true)); else fsSync();
  }
  MX.statusExt.panels = () => ({left: pstate.left, right: pstate.right, fullscreen: fsActive(), immersive});

  function panelsInit() {
    panelsLoad();
    const hk = (/[#&]panels=(left|right|both|fs)(&|$)/.exec(location.hash) || [])[1];   // screenshot hook, not stored
    if (hk === "left" || hk === "both") pstate.left = false;
    if (hk === "right" || hk === "both") pstate.right = false;
    document.body.classList.add("p-now");                       // first paint: no slide
    paintPanels();
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("p-now")));
    for (const sd of ["left", "right"]) {
      for (const id of ["grip-", "expand-"]) { const b = $(id + sd); if (b) b.addEventListener("click", () => setPanel(sd, !pstate[sd], {focus: true})); }
    }
    const fb = $("fullscreen"), fx = $("fs-exit");
    if (fb) fb.addEventListener("click", fsToggle);
    if (fx) fx.addEventListener("click", fsToggle);
    document.addEventListener("fullscreenchange", () => { fsSync(); MX.emit("chrome"); });
    fsSync();
    if (hk === "fs") setImmersive(true);
    MX.on("ready", () => MX.emit("chrome"));
  }

  MX.ui = {clickAt, dblAt, frame: frameNav, setLevel: (lv, k, o) => (U ? setLevel(lv, k, o) : false),
           setPanel, panels: () => Object.assign({}, pstate), fullscreen: fsToggle};

  // ---- motion toggle (button#anim; localStorage mx.anim, hash anim=0 wins) ---------
  const animSync = () => { const b = $("anim"); if (b) b.setAttribute("aria-pressed", S.anim ? "true" : "false"); };
  const animSave = () => { try { localStorage.setItem("mx.anim", S.anim ? "1" : "0"); } catch (e) {} };
  function hintText(on) { return "drag to pan · " + (on ? "shift-drag to orbit · " : "") + "scroll or ctrl-drag to zoom · double-click to fly in · ? help"; }
  // ---- 2D / 3D toggle (button#view3d, key v; localStorage mx.view, hash view=2d|3d wins at load: render.js) -------
  function viewSync() {
    const b = $("view3d"), on = S.view3d;
    if (!b) return;
    b.textContent = on ? "3D" : "2D";
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", "3D view");   // stable name; the state is aria-pressed (visible text may read 2D)
    const h = $("hint");
    if (h && /^drag to /.test(h.textContent)) h.textContent = hintText(on);
  }
  function viewToggle() {
    if (!MX.camera.setView3d) return;
    MX.camera.setView3d(!S.view3d);
    try { localStorage.setItem("mx.view", S.view3d ? "3d" : "2d"); } catch (e) { /* storage blocked */ }
    MX.announce(S.view3d ? "3D view" : "2D view");
  }
  function animRestore() {
    let v = null; try { v = localStorage.getItem("mx.anim"); } catch (e) {}
    if (v === "0" && S.anim && !/[#&]anim=/.test(location.hash)) MX.filter.setAnim(false);
    animSync();
  }

  // ---- self-tests (kbd.*, live.announce) ------------------------------
  // data a test needs but this graph lacks -> MX.selftest.skip (reported n/a, state.js)
  const fail = m => { throw new Error(m); }, skip = r => MX.selftest.skip(r);
  const press = (el, key, o) => el.dispatchEvent(new KeyboardEvent("keydown",
    Object.assign({key, bubbles: true, cancelable: true}, o || {})));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  function camSave() { return Object.assign({}, S.camera); }
  function camRestore(c) { MX.camera.restore(c); }

  MX.selftest.add("kbd.canvasNav", () => {
    const cv = $("cv"); if (!cv) fail("no #cv");
    const prev = S.selected, cam = camSave();
    try {
      cv.focus();
      if (document.activeElement !== cv) fail("canvas not focusable");
      const top = topVisible();
      if (top < 0 || !neighbours(top).length) skip("no visible node with a visible neighbour");
      press(cv, "Home");
      if (S.selected !== top) fail("Home selected " + S.selected + ", expected " + top);
      press(cv, "ArrowRight");
      const nb = neighbours(top);
      if (S.kbdCursor !== nb[0]) fail("cursor " + S.kbdCursor + " != first neighbour " + nb[0]);
      press(cv, "ArrowRight");
      if (nb.length > 1 && S.kbdCursor !== nb[1]) fail("second ArrowRight did not cycle");
      press(cv, "ArrowLeft");
      if (S.kbdCursor !== nb[0]) fail("ArrowLeft did not cycle back");
      const c = S.kbdCursor;
      press(cv, "Enter");
      if (S.selected !== c) fail("Enter did not select the cursor");
      press(cv, "Backspace");
      if (S.selected !== top) fail("Backspace returned " + S.selected + ", expected " + top);
    } finally {
      S.kbdCursor = -1; MX.select(prev, {announce: false}); camRestore(cam); cv.blur();
    }
  });
  MX.selftest.add("kbd.zoom", () => {
    const cv = $("cv"); if (!cv) fail("no #cv");
    if (!S.nodesShown) skip("nothing shown to fit");
    const cam = camSave();
    try {
      MX.camera.fit(0.88);
      const s0 = S.camera.scale;
      cv.focus();
      press(cv, "+");
      if (!(S.camera.scale > s0)) fail("+ did not raise scale " + s0 + " -> " + S.camera.scale);
      press(cv, "0");
      const s1 = S.camera.scale;
      if (Math.abs(s1 - s0) > 1e-9) fail("0 did not fit: " + s1 + " != " + s0);
    } finally { camRestore(cam); cv.blur(); }
  });
  MX.selftest.add("kbd.slashFocus", () => {
    const s = $("search"); if (!s) fail("no #search");
    const l0 = pstate.left, anim = S.anim;
    try {
      MX.filter.setAnim(false, true);
      for (const folded of [false, true]) {
        setPanel("left", !folded, {quiet: true});
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        press(document.body, "/");
        if (document.activeElement !== s) fail("/ did not focus #search" + (folded ? " (sidebar collapsed)" : ""));
        if (folded && (!pstate.left || $("side").inert)) fail("/ did not expand the collapsed sidebar");
        s.blur();
      }
    } finally { setPanel("left", l0, {quiet: true}); MX.filter.setAnim(anim, true); }
  });
  MX.selftest.add("kbd.skipLink", () => {
    const a = $("skip"); if (!a) fail("no #skip");
    const v0 = S.view, sel = S.selected, h0 = location.hash;
    try {
      if (!MX.dash || !MX.dash.setView) return;
      MX.select(-1, {announce: false});
      MX.dash.setView("overview");
      if (a.getAttribute("href") !== "#pane-overview") fail("dashboard, nothing selected: skip href " + a.getAttribute("href"));
      a.click();
      if (document.activeElement !== $("pane-overview")) fail("skip did not focus the overview pane");
      MX.dash.setView("graph");
      if (a.getAttribute("href") !== "#panel") fail("graph: skip href " + a.getAttribute("href"));
      a.click();
      if (document.activeElement !== $("panel")) fail("skip did not focus #panel");
      if (location.hash !== h0) fail("skip link wrote the hash: " + location.hash);
    } finally { MX.dash.setView(v0); MX.select(sel, {announce: false}); if (document.activeElement) document.activeElement.blur(); }
  });
  MX.selftest.add("anim.toggle", () => {
    const b = $("anim"); if (!b) fail("no #anim");
    const was = S.anim;
    let saved = null; try { saved = localStorage.getItem("mx.anim"); } catch (e) {}
    try {
      b.click();
      if (S.anim !== !was) fail("click did not flip S.anim");
      if (b.getAttribute("aria-pressed") !== String(!was)) fail("aria-pressed " + b.getAttribute("aria-pressed"));
      if (document.documentElement.dataset.anim !== (was ? "0" : undefined)) fail("data-anim not synced");
      b.click();
      if (S.anim !== was || b.getAttribute("aria-pressed") !== String(was)) fail("second click did not restore");
    } finally {
      MX.filter.setAnim(was);
      try { saved == null ? localStorage.removeItem("mx.anim") : localStorage.setItem("mx.anim", saved); } catch (e) {}
      animSync();
    }
  });
  MX.selftest.add("anim.persist", () => {
    const b = $("anim"); if (!b) fail("no #anim");
    const was = S.anim;
    let saved = null; try { saved = localStorage.getItem("mx.anim"); } catch (e) {}
    try {
      if (was) { b.click(); if (localStorage.getItem("mx.anim") !== "0") fail("off not persisted"); b.click(); }
      else { b.click(); if (localStorage.getItem("mx.anim") !== "1") fail("on not persisted"); b.click(); }
      if (localStorage.getItem("mx.anim") !== (was ? "1" : "0")) fail("final state not persisted");
    } finally {
      MX.filter.setAnim(was);
      try { saved == null ? localStorage.removeItem("mx.anim") : localStorage.setItem("mx.anim", saved); } catch (e) {}
      animSync();
    }
  });
  MX.selftest.add("anim.restore", () => {   // reload with a stored mx.anim=0 (the boot path runs animRestore on ready)
    const b = $("anim"); if (!b) fail("no #anim");
    const was = S.anim;
    let saved = null; try { saved = localStorage.getItem("mx.anim"); } catch (e) {}
    try {
      MX.filter.setAnim(true);
      localStorage.setItem("mx.anim", "0");
      animRestore();
      if (S.anim !== false || b.getAttribute("aria-pressed") !== "false" || document.documentElement.dataset.anim !== "0") fail("stored mx.anim=0 not restored");
    } finally {
      MX.filter.setAnim(was);
      try { saved == null ? localStorage.removeItem("mx.anim") : localStorage.setItem("mx.anim", saved); } catch (e) {}
      animSync();
    }
  });
  // 2D / 3D: the button flips to face-on (yaw = pitch = 0, every z x 0, screen = world x / y x scale + pan), orbit keys
  // inert; back to 3D restores depth and the angle; world x / y of the bodies never drift across the round trip
  MX.selftest.add("view.toggle", async () => {
    const b = $("view3d"), cv = $("cv");
    if (!b || !cv || !MX.camera.setView3d) fail("no #view3d");
    if (!U || !U.started) fail("universe not started");
    const was = S.view3d, cam = camSave(), anim = S.anim, sel = S.selected, C = S.camera;
    let saved = null; try { saved = localStorage.getItem("mx.view"); } catch (e) {}
    const landed = async () => { for (let t = 0; MX.camera.tweening && t < 3000; t += 20) await wait(20); if (MX.camera.tweening) fail("view tween still running after 3 s"); };
    const ids = [];
    for (let i = 0; i < N && ids.length < 60; i += Math.max(1, N / 60 | 0)) if (S.nodeVisible[i]) ids.push(i);
    try {
      MX.select(-1, {announce: false});
      if (!was) { MX.camera.setView3d(true); await landed(); }
      const y3 = C.yaw, p3 = C.pitch;
      b.click(); await landed();                                     // -> 2D (tweened when motion is on)
      if (S.view3d || b.getAttribute("aria-pressed") !== "false" || b.textContent !== "2D") fail("button did not switch to 2D");
      if (C.yaw !== 0 || C.pitch !== 0) fail("2D not face-on: yaw " + C.yaw + ", pitch " + C.pitch);
      if (S.zScale !== 0) fail("zScale " + S.zScale + " in 2D");
      const W = cv.clientWidth, H = cv.clientHeight, s = C.scale;
      for (const i of ids) {
        if (S.z[i] !== 0) fail("z of " + g.id[i] + " = " + S.z[i] + " in 2D");
        const p = MX.camera.screen(i), ex = W / 2 + C.panX + S.x[i] * s, ey = H / 2 + C.panY + S.y[i] * s;
        if (Math.abs(p[0] - ex) > 0.5 || Math.abs(p[1] - ey) > 0.5) fail("2D screen of " + g.id[i] + " " + p.slice(0, 2).map(v => v.toFixed(1)) + " != face-on " + [ex.toFixed(1), ey.toFixed(1)]);
      }
      cv.focus(); press(cv, "]"); press(cv, "{"); cv.blur();
      if (C.yaw !== 0 || C.pitch !== 0) fail("orbit keys turned the 2D view");
      b.click(); await landed();                                     // -> 3D
      if (!S.view3d || b.getAttribute("aria-pressed") !== "true" || b.textContent !== "3D") fail("button did not switch back to 3D");
      if (S.zScale !== 1) fail("zScale " + S.zScale + " back in 3D");
      if (Math.abs(Math.atan2(Math.sin(C.yaw - y3), Math.cos(C.yaw - y3))) > 1e-6 || Math.abs(C.pitch - p3) > 1e-6) fail("3D angle not restored");
      MX.filter.setAnim(false, true);                                // frozen clock: instant toggles, exact x / y
      const x0 = ids.map(i => S.x[i]), y0 = ids.map(i => S.y[i]), z0 = ids.map(i => S.z[i]);
      MX.camera.setView3d(false);
      if (MX.camera.tweening || S.zScale !== 0) fail("motion off: 2D not instant");
      MX.camera.setView3d(true);
      if (S.zScale !== 1) fail("motion off: 3D not instant");
      ids.forEach((i, j) => { if (Math.abs(S.x[i] - x0[j]) > 1e-4 || Math.abs(S.y[i] - y0[j]) > 1e-4 || Math.abs(S.z[i] - z0[j]) > 1e-4) fail("layout drift at " + g.id[i]); });
    } finally {
      MX.filter.setAnim(anim, true);
      if (S.view3d !== was) { MX.camera.setView3d(was); await landed(); }
      camRestore(cam); MX.select(sel, {announce: false});
      try { saved == null ? localStorage.removeItem("mx.view") : localStorage.setItem("mx.view", saved); } catch (e) {}
      viewSync();
    }
  }, {timeout: 12000});
  MX.selftest.add("live.announce",async () => {
    const live = $("live"); if (!live) fail("no #live");
    const prev = S.selected, i = topVisible();
    if (i < 0) skip("no visible node");
    try {
      live.textContent = "";
      MX.select(i);
      await wait(450);
      if (live.textContent !== say(i)) fail("#live = '" + live.textContent + "', expected '" + say(i) + "'");
    } finally { MX.select(prev, {announce: false}); }
  });

  // ---- self-tests (universe.flyTo, universe.drill, universe.bounceIdle, kbd.universeNav) ----------
  const frameWait = () => new Promise(r => { let done = false; const f = () => { if (!done) { done = true; setTimeout(r, 0); } }; requestAnimationFrame(f); setTimeout(f, 50); });
  // run fn with instant flights (RM), restoring selection, level, camera, cursor and history
  async function sandbox(fn, rm) {
    if (!S.nodesShown) skip("no visible bodies");
    if (!U || !U.started) fail("universe not started");
    const cam = camSave(), sel = S.selected, lv = Object.assign({}, S.universe), rm0 = S.reducedMotion, h0 = hist.slice(), kc = S.kbdCursor;
    try {
      if (rm !== false) S.reducedMotion = true;
      MX.select(-1, {announce: false});
      return await fn();
    } finally {
      S.reducedMotion = rm0; MX.camera.cancel();
      MX.select(sel, {announce: false}); Object.assign(S.universe, lv); S.kbdCursor = kc;
      hist.length = 0; hist.push(...h0);
      camRestore(cam); canvasLabel();
    }
  }
  MX.selftest.add("universe.flyTo", () => sandbox(async () => {
    let warps = 0, live = true;
    MX.on("flyto", () => { if (live) warps++; });
    try {
      MX.camera.fit(0.88);
      const i = topVisible(), anim = U.motionReason() === "", s0 = MX.camera.thresholds[2] * 1.15;
      MX.select(i, {center: true, announce: false});
      if (anim && (!MX.camera.flying || warps !== 1)) fail("motion on: flying " + MX.camera.flying + ", flyto events " + warps);
      const t0 = performance.now();
      while (MX.camera.flying && performance.now() - t0 < 1500) await wait(20);
      if (MX.camera.flying) fail("flight still running after 1.5 s");
      const st = MX.statusExt.camera();
      if (!(st.centerErrPx <= 2)) fail("selected body " + st.centerErrPx + " px from the safe-rect centre");
      if (!(S.camera.scale >= s0 - 1e-9)) fail("body flight scale " + S.camera.scale + " < " + s0);
      if (anim) { MX.camera.fit(0.88); MX.camera.flyBody(i); MX.camera.zoomBy(1.1); if (MX.camera.flying) fail("zoom did not cancel the flight"); }
      S.reducedMotion = true; warps = 0;                // reduced motion: instant, no effect event
      MX.camera.fit(0.88);
      MX.camera.flyKind("galaxy", U.galaxyOf(i));
      if (MX.camera.flying || warps) fail("RM flight animated");
      if (MX.statusExt.camera().fitOK !== true) fail("galaxy not inside the safe rect after the flight");
      const sr = MX.camera.safeRect(), c = U.centerOf("galaxy", U.galaxyOf(i)), p = MX.camera.project(c[0], c[1], c[2] || 0);   // 3D: projected centre
      if (!p || Math.hypot(p[0] - (sr.l + sr.r) / 2, p[1] - (sr.t + sr.b) / 2) > 2) fail("galaxy not centred");
    } finally { live = false; }
  }, false));
  const cv0 = () => $("cv");
  function firstSystem() {                 // the drill path the tests walk: cluster 0 -> its galaxy 0 -> a system
    const c = siblings("cluster", {})[0], k = c == null ? null : siblings("galaxy", {cluster: c})[0];
    return k != null && siblings("system", {galaxy: k}).length > 0;
  }
  MX.selftest.add("universe.drill", () => sandbox(async () => {
    setLevel("universe", -1, {announce: false});
    MX.camera.fit(0.88);
    if (bandNow() !== 0) { if (N < 500) skip("small graph: fit-all opens at U" + bandNow()); fail("fit-all is U" + bandNow()); }
    if (!firstSystem()) skip("first galaxy of the first cluster has no visible system");
    const c0 = siblings("cluster", S.universe)[0], p = U.centerOf("cluster", c0);
    clickAt(p[0], p[1]);                                  // U0 click on empty space -> that cluster
    if (S.universe.level !== "cluster" || S.universe.cluster !== c0) fail("U0 click: " + JSON.stringify(S.universe));
    if (MX.statusExt.camera().fitOK !== true) fail("cluster not inside the safe rect");
    if (!/^\S.* cluster, 1 of \d+, [\d,]+ bodies, [\d,]+ systems$/.test(describeAt("cluster", S.universe))) fail("cluster announcement: " + describeAt("cluster", S.universe));
    const k0 = siblings("galaxy", S.universe)[0], q = U.centerOf("galaxy", k0);
    dblAt(q[0], q[1], -1);                                // double-click drills one level in
    if (S.universe.level !== "galaxy" || S.universe.galaxy !== k0) fail("dblclick into galaxy: " + JSON.stringify(S.universe));
    if (!/ galaxy, 1 of \d+ in \S.*, [\d,]+ bodies, [\d,]+ systems$/.test(describeAt("galaxy", S.universe))) fail("galaxy announcement: " + describeAt("galaxy", S.universe));
    const y0 = siblings("system", S.universe)[0], r = U.centerOf("system", y0);
    dblAt(r[0], r[1], -1);
    if (S.universe.level !== "system" || S.universe.system !== y0) fail("dblclick into system: " + JSON.stringify(S.universe));
    if (S.nodeVisible[U.systems[y0].sun] && S.kbdCursor !== U.systems[y0].sun) fail("system cursor ring is not on the sun");
    const st = U.status();
    if (st.level !== "system" || st.cursor.system !== U.systems[y0].name || st.cursor.galaxy !== U.galaxies[k0].name) fail("mxstatus cursor " + JSON.stringify(st.cursor));
    if (!/^System \S.*, 1 of \d+, [\d,]+ members$/.test(describeAt("system", S.universe))) fail("system announcement");
    up(); if (S.universe.level !== "galaxy") fail("up -> " + S.universe.level);
    up(); if (S.universe.level !== "cluster") fail("up -> " + S.universe.level);
    up(); if (S.universe.level !== "universe") fail("up -> " + S.universe.level);
    if (!/Level: universe$/.test(cv0().getAttribute("aria-label") || "")) fail("canvas aria-label " + cv0().getAttribute("aria-label"));
    MX.camera.fit(0.88);                                  // a U1 click lands on the galaxy under the pointer
    MX.camera.flyKind("cluster", c0);
    if (bandNow() === 1) { clickAt(q[0], q[1]); if (S.universe.level !== "galaxy" || S.universe.galaxy !== k0) fail("U1 click: " + JSON.stringify(S.universe)); }
  }));
  MX.selftest.add("kbd.universeNav", () => sandbox(async () => {
    const cv = cv0(), live = $("live");
    if (!cv || !live) fail("no #cv / #live");
    setLevel("universe", -1, {fly: false, announce: false});
    hist.length = 0;
    cv.focus();
    const sib = siblings("cluster", S.universe);
    if (!firstSystem()) skip("first galaxy of the first cluster has no visible system");
    press(cv, "ArrowRight");
    if (S.universe.level !== "cluster" || S.universe.cluster !== sib[0]) fail("ArrowRight at universe: " + JSON.stringify(S.universe));
    live.textContent = "";
    await wait(350);
    if (live.textContent !== describeAt("cluster", S.universe) || !/ cluster, 1 of /.test(live.textContent)) fail("#live '" + live.textContent + "'");
    if (sib.length > 1) {
      press(cv, "ArrowRight"); if (S.universe.cluster !== sib[1]) fail("ArrowRight did not cycle clusters");
      press(cv, "ArrowLeft"); if (S.universe.cluster !== sib[0]) fail("ArrowLeft did not cycle back");
    }
    press(cv, "Enter");
    const gs = siblings("galaxy", S.universe);
    if (S.universe.level !== "galaxy" || S.universe.galaxy !== gs[0]) fail("Enter into galaxy: " + JSON.stringify(S.universe));
    if (gs.length > 1) { press(cv, "ArrowDown"); if (S.universe.galaxy !== gs[1]) fail("ArrowDown did not cycle galaxies"); press(cv, "ArrowUp"); }
    press(cv, "Enter");
    const y = S.universe.system;
    if (S.universe.level !== "system" || y !== siblings("system", S.universe)[0]) fail("Enter into system: " + JSON.stringify(S.universe));
    press(cv, "Enter");
    const sun = U.systems[y].sun;
    if (S.nodeVisible[sun] && S.selected !== sun) fail("Enter at system level selected " + S.selected + ", want sun " + sun);
    if (S.universe.level !== "body") fail("level after selecting the sun: " + S.universe.level);
    press(cv, "Backspace");
    if (S.selected !== -1 || S.universe.level !== "system" || S.universe.system !== y) fail("Backspace from body: " + JSON.stringify(S.universe) + " sel " + S.selected);
    press(cv, "Backspace"); press(cv, "Backspace");
    if (S.universe.level !== "cluster") fail("2x Backspace -> " + S.universe.level);
    document.body.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    if (S.universe.level !== "universe") fail("Esc did not climb to the universe: " + S.universe.level);
    press(cv, "ArrowRight", {shiftKey: true});
    if (S.universe.level !== "universe") fail("Shift+arrow changed the level");
    cv.blur();
  }));
  const drag = {};                         // mxstatus.interact.drag: last scripted drag (universe.bounceIdle)
  MX.statusExt.interact = () => ({drag});
  MX.selftest.add("universe.bounceIdle", () => sandbox(async () => {
    const cv = cv0(), nv = S.nodeVisible;
    let y = -1, best = 0;                                 // the visible system with the most visible planets (>= 3)
    for (let k = 0; k < U.systems.length; k++) {
      if (!nv[U.systems[k].sun]) continue;
      let m = 0;
      for (let q = U.memStart[k] + 1; q < U.memStart[k + 1]; q++) m += nv[U.members[q]];
      if (m >= 3 && m > best) { best = m; y = k; }
    }
    if (y < 0) skip("no visible system with >= 3 planets");
    const sun = U.systems[y].sun, mine = new Uint8Array(N);
    for (let q = U.memStart[y]; q < U.memStart[y + 1]; q++) mine[U.members[q]] = 1;
    const run = async rm => {
      S.reducedMotion = rm;
      MX.camera.centerOn(sun, Math.max(1, 0.4 * Math.min(cv.clientWidth, cv.clientHeight) / Math.max(U.radiusOf("system", y), 1)));
      await frameWait();
      // orbits (render motion loop) move every body: the "others" checks need a frozen universe clock
      const sc = S.camera.scale, x0 = S.x.slice(), y0 = S.y.slice(), t0 = U.t, ticking = () => !!MX.render.status().motion || U.t !== t0;
      const px = i => Math.hypot(S.x[i] - x0[i], S.y[i] - y0[i]) * sc, rect = cv.getBoundingClientRect(), [sx, sy] = MX.camera.screen(sun);
      const ev = (type, x, yy) => cv.dispatchEvent(new PointerEvent(type, {clientX: rect.left + x, clientY: rect.top + yy, pointerId: 7, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true, bubbles: true, cancelable: true}));
      ev("pointerdown", sx, sy);
      for (let f = 1; f <= 8; f++) { ev("pointermove", sx + 7 * f, sy + 2 * f); await wait(17); }
      await wait(80);
      let pl = 0, other = 0, orbiting = ticking();
      for (let i = 0; i < N; i++) if (nv[i]) { if (mine[i]) { if (i !== sun) pl = Math.max(pl, px(i)); } else other = Math.max(other, px(i)); }
      if (!(px(sun) > 2)) fail((rm ? "RM: " : "") + "dragged sun moved " + px(sun).toFixed(2) + " px");
      if (!rm && !(pl > 0.5)) fail("planets did not follow (" + pl.toFixed(2) + " px)");
      const m = drag[rm ? "rm" : "motion"] = {sunPx: +px(sun).toFixed(2), planetsPx: +pl.toFixed(2), otherPx: +other.toFixed(4), orbiting, idleMs: null};
      if (!orbiting && other >= 1) fail("bodies of other systems moved " + other.toFixed(2) + " px");
      let pos = 0, live = true;
      MX.on("positions", () => { if (live) pos++; });
      const r0 = S.perf.rafCount, tUp = performance.now();
      ev("pointerup", sx + 56, sy + 16);
      try {
        if (rm) {
          if (!S.settled) fail("RM release did not snap (not settled)");
          const p1 = pos; await wait(300);
          m.postReleasePositions = pos - p1;
          if (pos !== p1) fail("RM: " + (pos - p1) + " position updates after release");
        } else {
          while (!S.settled && performance.now() - tUp < 3000) await wait(20);
          if (!S.settled) fail("bounce still live 3 s after release");
          const p1 = pos, r1 = S.perf.rafCount; await wait(400);
          if (pos !== p1 && !ticking()) fail("positions still emitted after settle");   // orbits (motion on) emit positions by design
          if (!ticking() && S.perf.rafCount - r1 > 1) fail("render frames after settle: " + (S.perf.rafCount - r1));
          m.idleMs = Math.round(performance.now() - 400 - tUp);
          if (m.idleMs > 3000) fail("idle after " + Math.round(performance.now() - 400 - tUp) + " ms");

        }
        orbiting = orbiting || ticking(); m.orbiting = orbiting;
        if (!orbiting) for (let i = 0; i < N; i++) if (nv[i] && px(i) > 1e-2) fail((rm ? "RM: " : "") + "residual displacement " + px(i).toFixed(3) + " px at " + g.id[i]);
      } finally { live = false; }
    };
    await run(false);
    await run(true);
  }, false), {timeout: 15000});
  // ---- self-tests: panels.collapse, ui.fullscreen ------------------------------------------------------------------
  const rectOf = id => { const el = $(id); return el && !el.hidden && el.getClientRects().length ? el.getBoundingClientRect() : null; };
  async function panelSandbox(fn) {
    const st = {l: pstate.left, r: pstate.right}, anim = S.anim, v0 = S.view, cam = camSave(), sel = S.selected;
    let saved = null; try { saved = localStorage.getItem(PKEY); } catch (e) {}
    try {
      MX.filter.setAnim(false, true);                     // Motion off: instant slides, measurable at once
      MX.select(-1, {announce: false});
      if (S.view !== "graph" && MX.dash) MX.dash.setView("graph");
      setPanel("left", true, {quiet: true}); setPanel("right", true, {quiet: true});
      return await fn();
    } finally {
      if (immersive) setImmersive(false);
      setPanel("left", st.l, {quiet: true}); setPanel("right", st.r, {quiet: true});
      try { saved == null ? localStorage.removeItem(PKEY) : localStorage.setItem(PKEY, saved); } catch (e) {}
      if (MX.dash && S.view !== v0) MX.dash.setView(v0);
      MX.filter.setAnim(anim, true); camRestore(cam); MX.select(sel, {announce: false});
    }
  }
  MX.selftest.add("panels.collapse", () => panelSandbox(async () => {
    const C = MX.camera, w = r => r.r - r.l, stored = () => JSON.parse(localStorage.getItem(PKEY) || "{}");
    const sr0 = C.safeRect(), h0 = rectOf("hint"), z0 = rectOf("zoom"), m0 = rectOf("minimap"), ls0 = rectOf("layout-status");
    if (!h0 || !z0) fail("no #hint / #zoom");
    // left: keyboard (Alt+[) collapses; the canvas' usable width grows, the hint follows, the state is stored
    press(document.body, "[", {altKey: true, code: "BracketLeft"});
    if (pstate.left || !document.body.classList.contains("l-collapsed")) fail("Alt+[ did not collapse the sidebar");
    if (!$("side").inert) fail("collapsed sidebar is not inert");
    if (!rectOf("expand-left") || rectOf("expand-left").width < 20) fail("no expand button on the left rail");
    const sr1 = C.safeRect();
    if (!(w(sr1) > w(sr0) + 150) || !(sr1.l < sr0.l - 150)) fail("safe rect did not widen left: " + JSON.stringify([sr0, sr1]));
    if (!(rectOf("hint").left < h0.left - 150)) fail("hint bar did not move left");
    if (stored().l !== false) fail("left state not stored: " + localStorage.getItem(PKEY));
    const sp = $("panel").getBoundingClientRect();
    // right: the button collapses; zoom, layout pill and minimap move right
    $("grip-right").click();
    if (pstate.right || !$("panel").inert) fail("grip did not collapse the inspector");
    const sr2 = C.safeRect();
    if (!(sr2.r > sr1.r + 150)) fail("safe rect did not widen right: " + JSON.stringify([sr1, sr2]));
    if (!(rectOf("zoom").right > z0.right + 150)) fail("zoom buttons did not move right");
    if (ls0 && !(rectOf("layout-status").right > ls0.right + 150)) fail("layout pill did not move right");
    if (m0 && !(rectOf("minimap").right > m0.right + 150)) fail("minimap did not move right");
    if (!(rectOf("minimap") || {}).width && m0) fail("minimap vanished");
    if (!(sp.width > 200) || !(rectOf("rail-right") && rectOf("rail-right").width <= 30)) fail("right rail is not slim");
    if (stored().r !== false) fail("right state not stored");
    // mxstatus camera centre: a flight now centres in the wider rect
    const st = MX.statusExt.panels();
    if (st.left || st.right) fail("mxstatus.panels " + JSON.stringify(st));
    // expand both: the rect is restored
    $("expand-left").click(); press(document.body, "]", {altKey: true, code: "BracketRight"});
    if (!pstate.left || !pstate.right) fail("expand did not reopen both");
    const sr3 = C.safeRect();
    if (Math.abs(sr3.l - sr0.l) > 1 || Math.abs(sr3.r - sr0.r) > 1) fail("safe rect not restored: " + JSON.stringify([sr0, sr3]));
    if (Math.abs(rectOf("zoom").right - z0.right) > 1 || Math.abs(rectOf("hint").left - h0.left) > 1) fail("stage chrome not restored");
    if (stored().l !== true || stored().r !== true) fail("expanded state not stored");
    // dashboard panes widen with the sidebar
    if (MX.dash) {
      MX.dash.setView("overview");
      const p0 = rectOf("pane-overview");
      setPanel("left", false, {quiet: true});
      const p1 = rectOf("pane-overview");
      if (!p0 || !p1 || !(p1.width > p0.width + 150)) fail("overview pane did not widen: " + (p0 && p0.width) + " -> " + (p1 && p1.width));
      MX.dash.setView("graph");
    }
  }));
  MX.selftest.add("ui.fullscreen", () => panelSandbox(async () => {
    const de = document.documentElement, b = $("fullscreen"), hdr = document.querySelector("header");
    if (!b) fail("no #fullscreen");
    const own = Object.prototype.hasOwnProperty.call(de, "requestFullscreen");
    try {
      // 1. API unavailable -> immersive: header hides, both panels collapse, the safe rect gains the header band
      de.requestFullscreen = undefined;
      const sr0 = MX.camera.safeRect();
      b.click();
      if (!immersive || b.getAttribute("aria-pressed") !== "true") fail("fallback: not immersive / aria-pressed " + b.getAttribute("aria-pressed"));
      if (getComputedStyle(hdr).display !== "none") fail("header still shown in immersive mode");
      if (pstate.left || pstate.right) fail("panels not collapsed in immersive mode");
      if (!(MX.camera.safeRect().t < sr0.t - 30)) fail("safe rect top did not rise");
      if ($("fs-exit").hidden) fail("no exit control while the header is hidden");
      setPanel("left", true);                                   // panels still toggle in full screen
      if (!pstate.left || $("side").inert) fail("sidebar did not open in full screen");
      press(document.body, "Escape");
      if (immersive || b.getAttribute("aria-pressed") !== "false") fail("Esc did not leave immersive mode");
      if (!pstate.left || !pstate.right) fail("panels not restored after full screen");
      if (getComputedStyle(hdr).display === "none") fail("header not restored");
      // 2. f key
      press(document.body, "f");
      if (!immersive) fail("f did not enter full screen");
      press(document.body, "f");
      if (immersive) fail("f did not leave full screen");
      // 3. API refuses (headless / permissions) -> immersive
      de.requestFullscreen = () => Promise.reject(new Error("blocked"));
      b.click(); await wait(30);
      if (!immersive) fail("refused API did not fall back to immersive");
      b.click();
      if (immersive) fail("second click did not leave immersive");
      // 4. API works: the button calls it, aria-pressed follows fullscreenchange
      let calls = 0;
      de.requestFullscreen = () => { calls++; return Promise.resolve(); };
      b.click(); await wait(10);
      if (calls !== 1 || immersive) fail("API path: calls " + calls + ", immersive " + immersive);
      Object.defineProperty(document, "fullscreenElement", {configurable: true, get: () => de});
      document.dispatchEvent(new Event("fullscreenchange"));
      if (b.getAttribute("aria-pressed") !== "true") fail("aria-pressed not synced on fullscreenchange");
      delete document.fullscreenElement;
      document.dispatchEvent(new Event("fullscreenchange"));
      if (b.getAttribute("aria-pressed") !== "false") fail("aria-pressed not cleared on exit");
    } finally {
      try { delete document.fullscreenElement; } catch (e) {}
      if (own) { /* never stubbed an own property */ } else delete de.requestFullscreen;
      fsSync();
    }
  }));
})();
