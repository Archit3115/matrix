(function () {
  "use strict";
  // multiverse.js: the Multiverse window. Lists the registered universes (scopes),
  // switches the page to one of them, and, with the engine (serve.py) running, adds / rebuilds / renames / removes.
  // Server mode = window.MX_SERVER present (page served by serve.py); file mode = window.MX_SCOPES only (file://).
  // Older builds without MX_SCOPES: the current universe alone + the command that starts the engine.
  const MX = window.MX, $ = id => document.getElementById(id);
  const POLL_MS = 1000, POLL_SLOW_MS = 2000, POLL_SLOW_AFTER = 30000, ROOT_MAX = 58, LOG_KEEP = 2000;
  const WARNLINE = /\b(SyntaxWarning|DeprecationWarning|ResourceWarning|UserWarning|FutureWarning)\b|^\s*warning:/i;

  // ---- paths -------------------------------------------------------------------------------------------------------
  const winPath = p => /^[A-Za-z]:[\\/]?/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  const norm = p => {                                      // compare key: "/" separators, no trailing "/", case per OS
    let s = String(p || "").replace(/\\/g, "/");
    if (s.length > 1) s = s.replace(/\/+$/, "");
    if (s === "/") s = "";
    return winPath(p) ? s.toLowerCase() : s;
  };
  const inside = (child, parent) => {                      // strictly inside: never a path vs itself
    const c = norm(child) + "/", p = norm(parent) + "/";
    return c !== p && c.startsWith(p);
  };
  const disp = p => {                                      // native look: D:\Code, C:\, /home/x
    const s = String(p || "");
    if (!winPath(s)) return s;
    const b = s.replace(/\//g, "\\");
    return /^[A-Za-z]:$/.test(b) ? b + "\\" : b;
  };
  function midEllipsis(s, max) {
    if (s.length <= max) return s;
    const head = Math.ceil((max - 1) * 0.42), tail = max - 1 - head;
    return s.slice(0, head) + "\u2026" + s.slice(s.length - tail);
  }
  function fileUrl(out) {                                  // file:///C:/a%20b/out/graph.html (segments encoded)
    let p = String(out).replace(/\\/g, "/").replace(/\/+$/, "") + "/graph.html";
    let pre = "file:///";
    if (/^\/\/[^/]/.test(p)) { pre = "file://"; p = p.slice(2); } else p = p.replace(/^\/+/, "");
    return pre + p.split("/").map((seg, i) => i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)).join("/");
  }
  function pageDir(levels) {                               // filesystem dir of this page, n levels up (file:// only)
    if (location.protocol !== "file:") return null;
    let p = decodeURIComponent(location.pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    if (location.host) p = "//" + location.host + p;
    const parts = p.split("/"); parts.pop();               // graph.html
    for (let i = 0; i < levels; i++) parts.pop();
    return parts.join("/") || "/";
  }
  function parseTime(t) {
    if (!t) return NaN;
    const s = String(t).replace(/ UTC$/, "Z").replace(/^(\d{4}-\d\d-\d\d) /, "$1T");
    return Date.parse(s);
  }
  function ago(t) {
    const ms = parseTime(t);
    if (!isFinite(ms)) return t ? String(t) : "not built";
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
    return new Date(ms).toISOString().slice(0, 10);
  }
  const fmtN = n => n == null ? "\u2013" : MX.fmt(+n);
  function fmtBytes(b) {
    if (b == null) return "";
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0, v = +b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i ? v.toFixed(v < 10 ? 1 : 0) : v) + " " + u[i];
  }

  // ---- data --------------------------------------------------------------------------------------------------------
  const server = () => window.MX_SERVER && typeof window.MX_SERVER === "object" ? window.MX_SERVER : null;
  let live = null;                                         // last /api/scopes answer (server mode)
  function data() {
    const src = server() && live ? live : window.MX_SCOPES;
    const here = server() && server().current;           // the page's own universe beats the engine's default
    const ok = src && Array.isArray(src.scopes);
    const d = {legacy: !ok, current: ok && (here || src.current) || null, scopes: ok ? src.scopes : [], python: ok && src.python};
    d.count = d.scopes.length;
    if (!d.scopes.some(s => s.id === d.current)) {       // older build, or this page is not in the registry: list it anyway
      const st = MX.g && MX.g.D && MX.g.D.stats;
      d.scopes = [{id: PAGE, name: document.title || "This universe", root: "", kind: "", out: pageDir(0),
                   nodes: MX.g ? MX.g.N : null, edges: MX.g ? MX.g.M : null,
                   built: st && st.build && st.build.generated || null}].concat(d.scopes);
      d.current = PAGE;
    }
    return d;
  }
  const PAGE = "~page";                                  // never a registry id (ids are slug-hash)
  function sorted(d) {
    return d.scopes.slice().sort((a, b) => (b.id === d.current) - (a.id === d.current) ||
      (norm(a.root) < norm(b.root) ? -1 : norm(a.root) > norm(b.root) ? 1 : 0));
  }
  function nesting(sc, all) {                              // "contains Code" / "inside C:\" (nearest parent)
    if (!sc.root) return "";
    all = all.filter(o => o.root);
    const kids = all.filter(o => o !== sc && inside(o.root, sc.root));
    const pars = all.filter(o => o !== sc && inside(sc.root, o.root)).sort((a, b) => norm(b.root).length - norm(a.root).length);
    const nm = o => o.name || disp(o.root);
    const h = [];
    if (pars.length) h.push("inside " + nm(pars[0]));
    if (kids.length) h.push("contains " + (kids.length > 2 ? kids.length + " universes" : kids.map(nm).join(", ")));
    return h.join(" \u00b7 ");
  }
  function command(d) {
    const cur = d.scopes.find(s => s.id === d.current);
    const home = d.scopes.find(s => s.kind === "home" && s.install);
    let install = cur && cur.install || home && home.install || pageDir(1);
    const py = cur && cur.python || home && home.python || d.python || "";   // scopes.py stores the interpreter per scope
    const q = s => '"' + disp(s) + '"';
    if (!install) install = "<install>";
    const sep = winPath(install) ? "\\" : "/";
    return (py ? q(py) : "python") + " " + q(String(install).replace(/[\\/]+$/, "") + sep + "serve.py") + " --open";
  }

  // ---- API (server mode) -------------------------------------------------------------------------------------------
  async function api(method, path, body) {
    const sv = server();
    if (!sv) throw new Error("engine not running");
    const o = {method, headers: {"X-Matrix-Token": String(sv.token || "")}};
    if (body !== undefined) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
    let r;
    try { r = await window.fetch((sv.base || "") + path, o); }
    catch (e) { throw new Error("engine unreachable: " + (e && e.message || e)); }
    let j = null;
    try { j = await r.json(); } catch (e) { /* non-JSON */ }
    if (r.status === 401) throw new Error("The engine no longer accepts this page (it was restarted?). Open it again from the engine's open: link.");
    if (!r.ok) throw new Error(j && j.error || "HTTP " + r.status);
    return j || {};
  }

  // ---- view state --------------------------------------------------------------------------------------------------
  let opener = null, pollTimer = 0, pollSeq = 0;
  const ui = {renaming: null, removing: null, add: null, browse: null, job: null, err: ""};
  // ui.add: {root, name, pre: null|{scope, existing, preflight}, busy}; ui.browse: {path, parent, dirs, hidden}
  // ui.job: {id, scope, name, state, phase, progress, log, next, open, t0, over, force, logOpen, logWhen, kind}
  //   kind "log": a persisted last_build.log shown in the same panel (no job running)
  const isOpen = () => { const el = $("mv"); return !!el && !el.hidden; };
  const M = MX.multiverse = {open, close, toggle, isOpen, reload: render, _nav: url => location.assign(url),
                             _norm: norm, _inside: inside, _fileUrl: fileUrl, _command: () => command(data())};

  // ---- render ------------------------------------------------------------------------------------------------------
  const ICO_X = "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M4 4l8 8M12 4l-8 8'/></svg>";
  const ICO_UP = "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M8 13V3.5M4 7.5l4-4 4 4'/></svg>";
  const ICO_DIR = "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z'/></svg>";

  function rowHtml(sc, d, all, srv) {
    const e = MX.esc, cur = sc.id === d.current, page = sc.id === PAGE, hint = nesting(sc, all);
    const root = page ? "not registered" + (sc.out ? " · " + disp(sc.out) : "") : disp(sc.root);
    const busy = !!sc.building || ui.job && ui.job.scope === sc.id && /queued|running/.test(ui.job.state);
    const dis = srv && !page ? "" : " disabled";
    const tip = srv ? "" : " title='Needs the engine'";
    let name = "<span class='mv-name'>" + e(sc.name || sc.id) + "</span>";
    if (ui.renaming === sc.id) {
      name = "<input type='text' class='mv-rename' data-id='" + e(sc.id) + "' value='" + e(sc.name || "") +
        "' aria-label='New name for " + e(sc.name || sc.id) + "' spellcheck='false'>";
    }
    let tail;
    if (ui.removing === sc.id) {
      tail = "<span class='mv-confirm' role='group' aria-label='Confirm remove'><span class='mv-cq'>" +
        (sc.kind === "home" ? "Unregister only, files untouched." : "Deletes its index; the folder is untouched.") +
        "</span><button type='button' class='btn-quiet mv-danger' data-act='remove-yes' data-id='" + e(sc.id) + "'>Remove</button>" +
        "<button type='button' class='btn-quiet' data-act='remove-no'>Keep</button></span>";
    } else {
      tail = "<span class='mv-acts'>" +
        "<button type='button' class='btn-quiet' data-act='rebuild' data-id='" + e(sc.id) + "'" + (busy ? " disabled" : dis) + tip + ">Rebuild</button>" +
        "<button type='button' class='btn-quiet' data-act='log' data-id='" + e(sc.id) + "'" + dis + tip + ">Log</button>" +
        "<button type='button' class='btn-quiet' data-act='rename' data-id='" + e(sc.id) + "'" + dis + tip + ">Rename</button>" +
        "<button type='button' class='btn-quiet' data-act='remove' data-id='" + e(sc.id) + "'" +
        (cur && srv && !page ? " disabled title='You are here: switch first'" : busy ? " disabled title='Building'" : dis + tip) + ">Remove</button></span>";
    }
    return "<li class='mv-row" + (cur ? " is-current" : "") + "' data-id='" + e(sc.id) + "'>" +
      "<button type='button' class='mv-pick' data-act='pick' data-id='" + e(sc.id) + "' aria-label='" +
        e((cur ? "Current universe: " : "Open universe ") + (sc.name || sc.id) + ", " + root) + "'" + (cur ? " aria-current='true'" : "") + ">" +
        "<span class='mv-orb' aria-hidden='true'></span>" +
        "<span class='mv-id'>" + name +
          "<span class='mv-chip' data-kind='" + e(sc.kind || "") + "'>" + e(page ? "this page" : sc.kind || "scope") + "</span>" +
          (cur ? "<span class='mv-here'>you are here</span>" : "") +
          (busy ? "<span class='mv-here'>building\u2026</span>" : "") +
          "<span class='mv-root' title='" + e(root) + "'>" + e(midEllipsis(root, ROOT_MAX)) + "</span>" +
          (hint ? "<span class='mv-nest'>" + e(hint) + "</span>" : "") + "</span>" +
        "<span class='mv-ne'>" + (sc.nodes == null && sc.edges == null ? "<i>\u2013</i>"
          : fmtN(sc.nodes) + "<i> \u00b7 </i>" + fmtN(sc.edges)) + "</span>" +
        "<span class='mv-ago' title='" + e(sc.built || "never built") + "'>" + e(ago(sc.built)) + "</span>" +
      "</button>" + tail + "</li>";
  }

  function addHtml() {
    const e = MX.esc, a = ui.add;
    if (!a) return "";
    if (a.pre) {
      const p = a.pre.preflight || {}, s = a.pre.scope || {};
      return "<div class='mv-add' role='group' aria-label='Confirm new universe'>" +
        "<p class='mv-lbl'>" + (a.pre.existing ? "Already registered" : "Ready to index") + "</p>" +
        "<p class='mv-pre'><b>" + e(s.name || s.id) + "</b> <span>" + e(disp(s.root)) + "</span></p>" +
        "<p class='mv-pre mv-num'>" + (p.files != null ? (p.partial ? "\u2265 " : "") + fmtN(p.files) + " files" : "") +
          (p.bytes != null ? " \u00b7 " + (p.partial ? "\u2265 " : "") + e(fmtBytes(p.bytes)) + (p.partial ? " (stopped counting)" : "") : "") +
          (p.cap ? " \u00b7 cap " + fmtN(p.cap) + " files" : "") + "</p>" +
        (p.warn ? "<p class='mv-warn' role='note'>" + e(p.warn) + "</p>" : "") +
        "<div class='mv-row-btns'><button type='button' data-act='add-build'" + (a.busy ? " disabled" : "") + ">" +
          (a.pre.existing && s.built ? "Open" : p.warn ? "Index anyway" : "Build and open") + "</button>" +
        "<button type='button' class='btn-quiet' data-act='add-cancel'>Cancel</button></div></div>";
    }
    let br = "";
    const b = ui.browse;
    if (b) {
      const crumbs = [["", "Computer"]], P = b.path || "";
      if (P) {
        const win = winPath(P), parts = P.replace(/\\/g, "/").split("/").filter(Boolean);
        let acc = win ? "" : "";
        parts.forEach((seg, i) => {
          acc = win ? (i === 0 ? seg + "\\" : acc.replace(/\\$/, "") + "\\" + seg) : acc + "/" + seg;
          crumbs.push([acc, i === 0 && win ? seg + "\\" : seg]);
        });
        if (!win) crumbs.splice(1, 0, ["/", "/"]);
      }
      const dirs = (b.dirs || []).map(x => typeof x === "string" ? {name: x, hidden: false} : x)
        .filter(x => b.hidden || !x.hidden);
      br = "<div class='mv-browse' role='group' aria-label='Folder browser'>" +
        "<div class='mv-crumbs'>" +
          "<button type='button' class='btn-ico mv-up' data-act='fs-up' aria-label='Up one folder'" +
            (b.parent == null && !P ? " disabled" : "") + ">" + ICO_UP + "</button>" +
          "<nav aria-label='Path'>" + crumbs.map(([p, l], i) =>
            "<button type='button' class='mv-crumb' data-act='fs-go' data-path='" + e(p) + "'" +
            (i === crumbs.length - 1 ? " aria-current='location'" : "") + ">" + e(l) + "</button>").join("<i aria-hidden='true'>/</i>") +
          "</nav>" +
          "<button type='button' class='btn-quiet mv-hid' data-act='fs-hidden' aria-pressed='" + !!b.hidden + "'>Hidden</button>" +
        "</div>" +
        "<ul class='mv-dirs' aria-label='Folders'>" + (b.loading ? "<li class='mv-empty'>Loading\u2026</li>" :
          dirs.length ? dirs.map(x => "<li><button type='button' data-act='fs-into' data-name='" + e(x.name) + "'" +
            (x.hidden ? " class='is-hidden'" : "") + ">" + ICO_DIR + "<span>" + e(x.name) + "</span></button></li>").join("")
          : "<li class='mv-empty'>No folders here</li>") + "</ul>" +
        (b.truncated ? "<p class='mv-note'>Long folder: only the first " + MX.fmt((b.dirs || []).length) + " are listed. Type the path instead.</p>" : "") +
        "<div class='mv-row-btns'><button type='button' data-act='fs-use'" + (P ? "" : " disabled") + ">Use this folder</button>" +
        "<button type='button' class='btn-quiet' data-act='fs-close'>Close browser</button></div></div>";
    }
    return "<form class='mv-add' data-act='add-form' novalidate>" +
      "<p class='mv-lbl'>Add universe</p>" +
      "<div class='mv-field'><label for='mv-root'>Folder</label>" +
        "<input id='mv-root' type='text' spellcheck='false' autocomplete='off' placeholder='C:\\path\\to\\folder' value='" + e(a.root || "") + "'>" +
        "<button type='button' data-act='fs-open' aria-expanded='" + !!b + "'>Browse</button>" +
        "<label for='mv-name'>Name</label>" +
        "<input id='mv-name' type='text' spellcheck='false' autocomplete='off' placeholder='optional' value='" + e(a.name || "") + "'><span></span></div>" +
      br +
      "<div class='mv-row-btns'><button type='submit' data-act='add-submit'" + (a.busy ? " disabled" : "") + ">Add</button>" +
      "<button type='button' class='btn-quiet' data-act='add-cancel'>Cancel</button></div></form>";
  }

  const live_ = j => /queued|running/.test(j.state);
  function logLines(lines) {                               // python warnings dimmed as notes, never the headline
    const e = MX.esc;
    return (lines || []).map(l => WARNLINE.test(l) ? "<span class='mv-note'>note: " + e(l) + "</span>"
      : /Traceback|Error\b|error:/.test(l) ? "<span class='mv-bad'>" + e(l) + "</span>" : e(l)).join("\n");
  }
  function logPanel(j) {
    const e = MX.esc, n = (j.log || []).length;
    return "<details class='mv-logbox'" + (j.logOpen ? " open" : "") + "><summary>Log" + (n ? " \u00b7 " + fmtN(n) + (n === 1 ? " line" : " lines") : "") + "</summary>" +
      "<pre class='mv-log' tabindex='0' aria-label='Build log'>" + logLines(j.log) + "</pre>" +
      "<div class='mv-loghead'><span>" + e(j.logWhen ? "build log of " + String(j.logWhen).replace("T", " ").replace("Z", " UTC") : "") + "</span>" +
      "<button type='button' class='btn-quiet' data-act='log-copy'>Copy</button></div></details>";
  }
  function jobHtml() {
    const j = ui.job, e = MX.esc;
    if (!j) return "";
    if (j.kind === "log") {
      return "<div class='mv-job' data-state='log'>" +
        "<div class='mv-job-head'><span>Last build \u00b7 " + e(j.name) + "</span>" +
        "<button type='button' class='btn-quiet' data-act='job-close'>Close</button></div>" +
        (j.log && j.log.length ? "" : "<p class='mv-note'>No build log yet.</p>") + logPanel(j) + "</div>";
    }
    const pct = j.progress == null ? null : Math.round(Math.max(0, Math.min(1, j.progress)) * 100);
    const done = j.state === "done", failed = j.state === "failed", cancelled = j.state === "cancelled", over = failed || cancelled;
    const tail = (j.log || []).filter(l => !WARNLINE.test(l) && l.charAt(0) !== "#").slice(-4).join("\n");
    return "<div class='mv-job' data-state='" + e(j.state) + "'>" +
      "<div class='mv-job-head'><span>" + (failed ? "Build failed" : cancelled ? "Build stopped" : done ? "Built" : "Building") + " \u00b7 " + e(j.name) + "</span>" +
        "<span class='mv-num'>" + e(over ? "" : j.phase || j.state) + (pct == null || over ? "" : " \u00b7 " + pct + "%") + "</span></div>" +
      "<div class='mv-bar" + (pct == null && !done && !over ? " is-indet" : "") + "' role='progressbar' aria-label='Build progress'" +
        " aria-valuemin='0' aria-valuemax='100'" + (pct == null ? "" : " aria-valuenow='" + pct + "'") +
        (j.phase ? " aria-valuetext='" + e(j.phase + (pct == null ? "" : " " + pct + "%")) + "'" : "") + ">" +
        "<span style='width:" + (done ? 100 : pct == null || over ? 0 : pct) + "%'></span></div>" +
      (over ? "<p class='mv-err mv-job-err' role='alert'><span>" + e(cancelled ? "Stopped before it finished; the last good graph, if any, is untouched."
          : j.phase || "failed") + "</span></p>" + (tail ? "<pre class='mv-log mv-tail'>" + e(tail) + "</pre>" : "") : "") +
      "<div class='mv-row-btns mv-job-acts'>" +
        (live_(j) ? "<button type='button' class='btn-quiet' data-act='job-stop'" + (j.id && !j.stopping ? "" : " disabled") + ">" + (j.stopping ? "Stopping\u2026" : "Stop build") + "</button>" : "") +
        (over ? "<button type='button' data-act='job-retry'>" + (j.over ? "Index anyway" : "Retry") + "</button>" +
          "<button type='button' class='btn-quiet' data-act='job-log'>View log</button>" +
          "<button type='button' class='btn-quiet' data-act='job-close'>Dismiss</button>" : "") +
      "</div>" + logPanel(j) + "</div>";
  }

  function updateJob() {
    const el = $("mv") && $("mv").querySelector(".mv-job");
    if (!el || !ui.job || ui.job.kind === "log" || !live_(ui.job)) { render(); return; }
    const tmp = document.createElement("div"); tmp.innerHTML = jobHtml();
    const nu = tmp.firstChild, bar = el.querySelector(".mv-bar"), nb = nu.querySelector(".mv-bar");
    el.setAttribute("data-state", nu.getAttribute("data-state"));
    el.querySelector(".mv-job-head").replaceWith(nu.querySelector(".mv-job-head"));
    for (const a of ["class", "aria-valuenow", "aria-valuetext"]) {
      if (nb.hasAttribute(a)) bar.setAttribute(a, nb.getAttribute(a)); else bar.removeAttribute(a);
    }
    bar.firstChild.style.width = nb.firstChild.style.width;
    const ja = el.querySelector(".mv-job-acts"), na = nu.querySelector(".mv-job-acts");
    if (ja && na && ja.innerHTML !== na.innerHTML) ja.innerHTML = na.innerHTML;
    fillLog(el);
  }
  function fillLog(el) {                                   // in place: keeps scroll, sticks to the end unless scrolled up
    const pre = el.querySelector(".mv-logbox .mv-log"), sum = el.querySelector(".mv-logbox summary"), j = ui.job;
    if (!pre || !j) return;
    const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    pre.innerHTML = logLines(j.log);
    if (sum) sum.textContent = "Log" + (j.log && j.log.length ? " \u00b7 " + fmtN(j.log.length) + (j.log.length === 1 ? " line" : " lines") : "");
    if (stick) pre.scrollTop = pre.scrollHeight;
  }

  function render() {
    const root = $("mv");
    if (!root || root.hidden) return;
    const d = data(), srv = !!server(), list = sorted(d), e = MX.esc;
    const n = d.count;
    let sub = n + (n === 1 ? " universe" : " universes");
    if (d.current === PAGE) sub += d.legacy ? " \u00b7 older page" : " \u00b7 this page is not registered";
    sub += srv ? " \u00b7 engine connected" : " \u00b7 static file";
    const empty = d.scopes.length <= 1 ? "<p class='mv-note'>" + (d.legacy
      ? "This page predates the Multiverse. Rebuild it with the current Matrix to list universes."
      : "Only one universe so far. Each folder you index becomes a universe; a parent folder shows the bigger graph that contains this one. " +
        (srv ? "Use Add universe below." : "Start the engine, then use Add universe.")) + "</p>" : "";
    const fileFoot = srv ? "" : "<div class='mv-foot'><p class='mv-lbl'>Add, rebuild, rename and remove need the engine</p>" +
      "<div class='mv-cmd'><code id='mv-cmd'>" + e(command(d)) + "</code>" +
      "<button type='button' class='btn-quiet' data-act='copy'>Copy</button></div>" +
      "<p class='mv-note'>Run it in a terminal; it opens this page served from 127.0.0.1 with the actions enabled.</p></div>";
    const actRow = "<div class='mv-tools'>" + (ui.add ? "" :
      "<button type='button' data-act='add'" + (srv ? "" : " disabled title='Needs the engine'") + ">Add universe</button>") +
      (srv ? "<button type='button' class='btn-quiet' data-act='refresh'>Refresh</button>" : "") + "</div>";
    const focusKey = document.activeElement && root.contains(document.activeElement) ? focusSig(document.activeElement) : null;
    let sh = root.querySelector(".mv-sheet");
    if (!sh) {                                             // shell once per open: the entrance plays once, scroll survives
      root.innerHTML = "<div class='mv-scrim' data-act='close'></div>" +
        "<div class='mv-sheet' role='dialog' aria-modal='true' aria-labelledby='mv-title' aria-describedby='mv-sub' tabindex='-1'></div>";
      sh = root.querySelector(".mv-sheet");
    }
    const scroll = sh.scrollTop;
    sh.innerHTML = "<div class='mv-head'><svg class='mv-mark' viewBox='0 0 16 16' aria-hidden='true'>" + ORBITS + "</svg>" +
        "<div><h2 id='mv-title'>Multiverse</h2><p id='mv-sub' class='meta'>" + e(sub) + "</p></div>" +
        "<button type='button' class='btn-ico mv-x' data-act='close' aria-label='Close Multiverse' title='Close (Esc)'>" + ICO_X + "</button></div>" +
      (ui.err ? "<p class='mv-err' role='alert'><span>" + e(ui.err) + "</span><button type='button' class='btn-quiet' data-act='err-x'>Dismiss</button></p>" : "") +
      "<ul class='mv-list' aria-label='Universes'>" + list.map(sc => rowHtml(sc, d, list, srv)).join("") + "</ul>" +
      empty + jobHtml() + addHtml() + (ui.add ? "" : actRow) + fileFoot;
    sh.scrollTop = scroll;
    const lb = sh.querySelector(".mv-logbox");
    if (lb) {
      lb.addEventListener("toggle", () => { if (ui.job) ui.job.logOpen = lb.open; if (lb.open) { const p = lb.querySelector(".mv-log"); p.scrollTop = p.scrollHeight; } });
      const p = lb.querySelector(".mv-log"); p.scrollTop = p.scrollHeight;
    }
    const crumbs = sh.querySelector(".mv-crumbs nav");
    if (crumbs) crumbs.scrollLeft = crumbs.scrollWidth;   // a deep path shows its end: the folder you are in
    if (focusKey) refocus(focusKey);
  }
  const ORBITS = "<circle cx='8' cy='8' r='1.3'/><ellipse cx='8' cy='8' rx='6.5' ry='2.6'/><ellipse cx='8' cy='8' rx='2.6' ry='6.5'/>";
  // keep focus across re-renders: the same action on the same id, else the same input
  function focusSig(el) {
    return {id: el.id, act: el.getAttribute("data-act"), did: el.getAttribute("data-id"), name: el.getAttribute("data-name"),
            path: el.getAttribute("data-path"), cls: el.classList.contains("mv-rename") ? "mv-rename" : ""};
  }
  function refocus(k) {
    const root = $("mv");
    let el = k.id && $(k.id);
    if (!el && k.cls) el = root.querySelector("." + k.cls);
    if (!el && k.act) {
      el = [...root.querySelectorAll("[data-act='" + k.act + "']")].find(x =>
        x.getAttribute("data-id") === k.did && x.getAttribute("data-name") === k.name && x.getAttribute("data-path") === k.path);
    }
    if (el && !el.disabled) el.focus({preventScroll: true});
    else (focusables()[0] || root.querySelector(".mv-sheet")).focus({preventScroll: true});
  }
  const focusables = () => {
    const root = $("mv");
    return root ? [...root.querySelectorAll("button, [href], input, [tabindex]:not([tabindex='-1'])")]
      .filter(el => !el.disabled && el.offsetParent !== null) : [];
  };
  function setErr(msg) { ui.err = msg ? String(msg) : ""; render(); if (msg) MX.announce("Multiverse: " + msg); }

  // ---- open / close ------------------------------------------------------------------------------------------------
  function open() {
    const root = $("mv");
    if (!root || !root.hidden) return;
    opener = document.activeElement;
    root.hidden = false;
    document.body.classList.add("mv-open");
    const b = $("mv-btn"); if (b) b.setAttribute("aria-expanded", "true");
    ui.err = ""; render();
    const cur = root.querySelector(".mv-row.is-current .mv-pick") || focusables()[0];
    (cur || root.querySelector(".mv-sheet")).focus({preventScroll: true});
    if (server()) refresh();
  }
  function close() {
    const root = $("mv");
    if (!root || root.hidden) return;
    root.hidden = true; root.innerHTML = "";
    document.body.classList.remove("mv-open");
    stopPoll();
    Object.assign(ui, {renaming: null, removing: null, add: null, browse: null, err: ""});
    if (ui.job && !/queued|running/.test(ui.job.state)) ui.job = null;
    const b = $("mv-btn"); if (b) b.setAttribute("aria-expanded", "false");
    const t = opener && opener.isConnected && opener !== document.body ? opener : b;
    opener = null;
    if (t && t.focus) t.focus();
  }
  function toggle() { isOpen() ? close() : open(); }

  async function refresh() {
    try { live = await api("GET", "/api/scopes"); render(); }
    catch (e) { setErr(e.message); }
  }

  // ---- select / build ----------------------------------------------------------------------------------------------
  function go(sc) {
    const sv = server();
    if (sv) { M._nav((sv.base || "") + "/u/" + encodeURIComponent(sc.id) + "/"); return; }
    if (sc.built && sc.out) { M._nav(fileUrl(sc.out)); return; }
    setErr((sc.name || sc.id) + " is not built yet. Start the engine (command below) and select it there to build it.");
  }
  function pick(id) {
    const d = data(), sc = d.scopes.find(s => s.id === id);
    if (!sc) return;
    if (id === d.current) { close(); return; }
    if (server() && (!sc.built || sc.stale === true)) build(sc, true);
    else go(sc);
  }
  function stopPoll() { clearTimeout(pollTimer); pollTimer = 0; pollSeq++; }
  async function build(sc, thenOpen, force) {
    stopPoll();
    const seq = pollSeq;
    ui.err = "";
    ui.job = {id: null, scope: sc.id, name: sc.name || sc.id, state: "queued", phase: "starting", progress: null, log: [], next: 0,
              open: !!thenOpen, t0: Date.now(), force: !!force, logOpen: false, sc};
    render(); MX.announce("Building " + ui.job.name);
    let r;
    try { r = await api("POST", "/api/scopes/" + encodeURIComponent(sc.id) + "/build", force ? {force: true} : {ifStale: true}); }
    catch (e) { ui.job.state = "failed"; ui.job.phase = "not started: " + e.message; ui.job.logOpen = true; render(); MX.announce("Build not started"); return; }
    if (seq !== pollSeq) return;
    if (!r.job) { ui.job.state = "done"; finish(sc); return; }   // fresh already: nothing to build
    ui.job.id = r.job;
    poll(seq, sc);
  }
  async function poll(seq, sc) {
    if (seq !== pollSeq || !ui.job) return;
    let j;
    try { j = await api("GET", "/api/jobs/" + encodeURIComponent(ui.job.id) + "?since=" + (ui.job.next || 0)); }
    catch (e) { if (seq === pollSeq) { ui.job.state = "failed"; ui.job.phase = e.message; ui.job.logOpen = true; render(); } return; }
    if (seq !== pollSeq || !ui.job) return;
    const was = ui.job.phase;
    let log = ui.job.log;
    if (Array.isArray(j.log)) log = typeof j.next === "number" ? log.concat(j.log).slice(-LOG_KEEP) : j.log;   // older engines: last lines only
    Object.assign(ui.job, {state: j.state || "running", phase: j.phase || "", progress: j.progress == null ? null : +j.progress,
                           log, next: typeof j.next === "number" ? j.next : ui.job.next, over: !!j.over});
    if (j.state === "done" && j.graph === false) Object.assign(ui.job, {state: "failed", phase: "the build finished but wrote no graph.html"});
    if (j.scope && live && Array.isArray(live.scopes)) {
      const k = live.scopes.findIndex(s => s.id === j.scope.id);
      if (k >= 0) live.scopes[k] = Object.assign({}, live.scopes[k], j.scope);
    }
    if (ui.job.phase && ui.job.phase !== was) MX.announce(ui.job.phase);
    if (ui.job.state === "done") { render(); finish(Object.assign({}, sc, j.scope || {})); return; }
    if (ui.job.state === "failed" || ui.job.state === "cancelled") {
      ui.job.logOpen = true; render(); MX.announce((ui.job.state === "failed" ? "Build failed: " : "Build stopped: ") + ui.job.name); return;
    }
    updateJob();
    pollTimer = setTimeout(() => poll(seq, sc), Date.now() - (ui.job.t0 || 0) > POLL_SLOW_AFTER ? POLL_SLOW_MS : POLL_MS);
  }
  function finish(sc) {
    const open = ui.job && ui.job.open;
    MX.announce((sc.name || sc.id) + " built");
    if (open) go(sc);
    else { ui.job = null; refresh(); }
  }

  async function stopBuild() {
    const j = ui.job;
    if (!j || !j.id || !live_(j)) return;
    j.stopping = true; updateJob(); MX.announce("Stopping the build");
    try { await api("POST", "/api/jobs/" + encodeURIComponent(j.id) + "/cancel", {}); }
    catch (e) { j.stopping = false; setErr(e.message); }
  }
  async function showLog(id) {
    const sc = data().scopes.find(s => s.id === id);
    if (!sc) return;
    let r;
    try { r = await api("GET", "/api/scopes/" + encodeURIComponent(id) + "/log?tail=500"); }
    catch (e) { setErr(e.message); return; }
    if (ui.job && live_(ui.job) && ui.job.scope === id) { ui.job.logOpen = true; render(); return; }   // the live panel already has it
    if (ui.job && live_(ui.job)) { setErr("A build is running; its log is in the panel."); return; }
    stopPoll();
    ui.job = {kind: "log", id: null, scope: id, name: sc.name || id, state: "log", log: r.log || [], logWhen: r.built || null, logOpen: true};
    render();
    const pre = $("mv").querySelector(".mv-logbox .mv-log"); if (pre) pre.focus({preventScroll: true});
  }
  async function jobLog() {                                // a finished job: the persisted file has every line
    const j = ui.job;
    if (!j) return;
    try {
      const r = await api("GET", "/api/scopes/" + encodeURIComponent(j.scope) + "/log?tail=500");
      if (r.log && r.log.length) { j.log = r.log; j.logWhen = r.built; }
    } catch (e) { /* keep the lines we have */ }
    j.logOpen = true; render();
  }
  async function copyLog(btn) {
    const txt = (ui.job && ui.job.log || []).join("\n");
    let ok = false;
    try { await navigator.clipboard.writeText(txt); ok = true; }
    catch (e) {
      try { const pre = $("mv").querySelector(".mv-logbox .mv-log"), rg = document.createRange(); rg.selectNodeContents(pre);
            const s = getSelection(); s.removeAllRanges(); s.addRange(rg); ok = document.execCommand("copy"); } catch (e2) { ok = false; }
    }
    btn.textContent = ok ? "Copied" : "Select + Ctrl+C";
    setTimeout(() => { if (btn.isConnected) btn.textContent = "Copy"; }, 1600);
  }

  // ---- add / browse ------------------------------------------------------------------------------------------------
  function readAdd() {
    const r = $("mv-root"), n = $("mv-name");
    if (ui.add && r) ui.add.root = r.value;
    if (ui.add && n) ui.add.name = n.value;
  }
  async function browse(path) {
    readAdd();
    const hid = ui.browse ? ui.browse.hidden : false;
    ui.browse = {path: path || "", parent: null, dirs: [], hidden: hid, loading: true};
    render();
    try {
      const j = await api("GET", "/api/fs" + (path ? "?path=" + encodeURIComponent(path) : ""));
      if (!ui.browse) return;
      Object.assign(ui.browse, {path: j.path || "", parent: j.parent == null ? null : j.parent, dirs: j.dirs || [], truncated: !!j.truncated, loading: false});
      render();
    } catch (e) { if (ui.browse) ui.browse.loading = false; setErr(e.message); }
  }
  function childPath(p, name) {
    if (!p) return name;                                   // drive roots: the entry is the path
    const sep = p.includes("\\") ? "\\" : "/";
    return p.replace(/[\\/]+$/, "") + sep + name;
  }
  async function addSubmit() {
    readAdd();
    const a = ui.add, root = (a.root || "").trim();
    if (!root) { setErr("Enter a folder path, or Browse to one."); const r = $("mv-root"); if (r) r.focus(); return; }
    a.busy = true; ui.err = ""; render();
    try {
      const body = {root}; if ((a.name || "").trim()) body.name = a.name.trim();
      const r = await api("POST", "/api/scopes", body);
      a.pre = {scope: r.scope || {}, existing: !!r.existing, preflight: r.preflight || {}};
      ui.browse = null; a.busy = false;
      if (r.scope && live && Array.isArray(live.scopes) && !live.scopes.some(s => s.id === r.scope.id)) live.scopes.push(r.scope);
      render();
      const f = $("mv").querySelector("[data-act='add-build']"); if (f) f.focus();
      MX.announce(a.pre.existing ? "Already registered" : "Ready to index" + (a.pre.preflight.warn ? ": " + a.pre.preflight.warn : ""));
    } catch (e) { a.busy = false; setErr(e.message); }
  }
  async function addCancel() {
    const a = ui.add; ui.add = null; ui.browse = null;
    if (a && a.pre && !a.pre.existing && a.pre.scope && a.pre.scope.id) {   // undo a registration nobody built
      try { await api("DELETE", "/api/scopes/" + encodeURIComponent(a.pre.scope.id)); } catch (e) { setErr(e.message); }
      if (live && Array.isArray(live.scopes)) live.scopes = live.scopes.filter(s => s.id !== a.pre.scope.id);
    }
    render();
    const b = $("mv") && $("mv").querySelector("[data-act='add']"); if (b) b.focus();
  }

  // ---- rename / remove ---------------------------------------------------------------------------------------------
  async function renameSave(input) {
    const id = input.getAttribute("data-id"), name = input.value.trim();
    const sc = data().scopes.find(s => s.id === id);
    ui.renaming = null;
    if (!sc || !name || name === sc.name) { render(); refocusAct("rename", id); return; }
    try {
      const r = await api("PATCH", "/api/scopes/" + encodeURIComponent(id), {name});
      if (live && Array.isArray(live.scopes)) {
        const k = live.scopes.findIndex(s => s.id === id);
        if (k >= 0) live.scopes[k] = Object.assign({}, live.scopes[k], r.scope || {name});
      }
      ui.err = ""; render(); refocusAct("rename", id); MX.announce("Renamed to " + name);
    } catch (e) { setErr(e.message); }
  }
  function refocusAct(act, id) {
    const el = $("mv") && [...$("mv").querySelectorAll("[data-act='" + act + "']")].find(x => x.getAttribute("data-id") === id);
    if (el) el.focus();
  }
  async function removeYes(id) {
    ui.removing = null;
    try {
      await api("DELETE", "/api/scopes/" + encodeURIComponent(id));
      if (live && Array.isArray(live.scopes)) live.scopes = live.scopes.filter(s => s.id !== id);
      ui.err = ""; render(); MX.announce("Universe removed");
      const f = focusables()[0]; if (f) f.focus();
    } catch (e) { setErr(e.message); }
  }

  // ---- events ------------------------------------------------------------------------------------------------------
  function onClick(ev) {
    const t = ev.target.closest("[data-act]");
    if (!t || !$("mv").contains(t)) return;
    const act = t.getAttribute("data-act"), id = t.getAttribute("data-id");
    if (act === "add-form") return;
    const d = data(), sc = id && d.scopes.find(s => s.id === id);
    switch (act) {
      case "close": close(); break;
      case "err-x": setErr(""); { const f = focusables()[0]; if (f) f.focus(); } break;
      case "pick": pick(id); break;
      case "rebuild": if (sc) build(sc, false); break;
      case "rename": ui.renaming = id; ui.removing = null; render(); { const i = $("mv").querySelector(".mv-rename"); if (i) { i.focus(); i.select(); } } break;
      case "remove": ui.removing = id; ui.renaming = null; render(); { const k = $("mv").querySelector("[data-act='remove-no']"); if (k) k.focus(); } break;
      case "remove-no": { const rid = ui.removing; ui.removing = null; render(); refocusAct("remove", rid); } break;
      case "remove-yes": removeYes(id); break;
      case "refresh": refresh(); break;
      case "add": ui.add = {root: "", name: "", pre: null, busy: false}; ui.err = ""; render(); { const r = $("mv-root"); if (r) r.focus(); } break;
      case "add-cancel": addCancel(); break;
      case "add-build": if (ui.add && ui.add.pre) {
        const s = ui.add.pre.scope, warn = !!(ui.add.pre.preflight || {}).warn;
        if (ui.add.pre.existing && s.built) { ui.add = null; go(s); break; }
        ui.add = null; build(s, true, warn);
      } break;
      case "job-stop": stopBuild(); break;
      case "job-retry": if (ui.job && ui.job.sc) build(ui.job.sc, ui.job.open, ui.job.over || ui.job.force); break;
      case "job-log": jobLog(); break;
      case "job-close": stopPoll(); ui.job = null; render(); break;
      case "log": if (id) showLog(id); break;
      case "log-copy": copyLog(t); break;
      case "fs-open": if (ui.browse) { readAdd(); ui.browse = null; render(); } else browse(((ui.add && $("mv-root").value) || "").trim()); break;
      case "fs-close": readAdd(); ui.browse = null; render(); { const b = $("mv").querySelector("[data-act='fs-open']"); if (b) b.focus(); } break;
      case "fs-go": browse(t.getAttribute("data-path")); break;
      case "fs-up": if (ui.browse) browse(ui.browse.parent == null ? "" : ui.browse.parent); break;
      case "fs-into": if (ui.browse) browse(childPath(ui.browse.path, t.getAttribute("data-name"))); break;
      case "fs-hidden": if (ui.browse) { readAdd(); ui.browse.hidden = !ui.browse.hidden; render(); } break;
      case "fs-use": if (ui.browse && ui.add) { readAdd(); ui.add.root = disp(ui.browse.path); ui.browse = null; render(); { const r = $("mv-root"); if (r) r.focus(); } } break;
      case "copy": copyCmd(t); break;
    }
  }
  async function copyCmd(btn) {
    const txt = ($("mv-cmd") || {}).textContent || "";
    let ok = false;
    try { await navigator.clipboard.writeText(txt); ok = true; }
    catch (e) {
      try {                                                // file:// or no permission: select + execCommand
        const r = document.createRange(); r.selectNodeContents($("mv-cmd"));
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        ok = document.execCommand("copy");
      } catch (e2) { ok = false; }
    }
    btn.textContent = ok ? "Copied" : "Select + Ctrl+C";
    MX.announce(ok ? "Command copied" : "Copy blocked; the command is selected");
    setTimeout(() => { if (btn.isConnected) btn.textContent = "Copy"; }, 1600);
  }
  function onKey(ev) {
    const root = $("mv");
    if (ev.target.classList && ev.target.classList.contains("mv-rename")) {
      if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); renameSave(ev.target); return; }
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); const id = ui.renaming; ui.renaming = null; render(); refocusAct("rename", id); return; }
    }
    if (ev.key === "Escape") {
      ev.preventDefault(); ev.stopPropagation();
      if (ui.removing) { const rid = ui.removing; ui.removing = null; render(); refocusAct("remove", rid); }
      else if (ui.browse) { readAdd(); ui.browse = null; render(); const b = root.querySelector("[data-act='fs-open']"); if (b) b.focus(); }
      else close();
      return;
    }
    if (ev.key === "Tab") {
      const f = focusables();
      if (!f.length) { ev.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1], ae = document.activeElement;
      if (ev.shiftKey && (ae === first || !root.contains(ae) || ae.classList.contains("mv-sheet"))) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && ae === last) { ev.preventDefault(); first.focus(); }
      ev.stopPropagation();
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
    if (!typing && (ev.key === "u" || ev.key === "U") && !ev.ctrlKey && !ev.altKey && !ev.metaKey) { ev.preventDefault(); close(); }
    ev.stopPropagation();                                  // the page behind takes no keys while the sheet is open
  }

  MX.module("multiverse", () => {
    let root = $("mv");
    if (!root) { root = document.createElement("div"); root.id = "mv"; root.hidden = true; document.body.appendChild(root); }
    root.classList.add("mv");
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKey);
    root.addEventListener("submit", ev => { ev.preventDefault(); addSubmit(); });
    document.addEventListener("focusin", ev => {
      if (isOpen() && !root.contains(ev.target)) (focusables()[0] || root.querySelector(".mv-sheet")).focus({preventScroll: true});
    });
    const b = $("mv-btn");
    if (b) { b.hidden = false; b.setAttribute("aria-expanded", "false"); b.addEventListener("click", toggle); }
    MX.statusExt.multiverse = () => {
      const d = data();
      return {mode: server() ? "server" : "file", legacy: d.legacy, count: d.scopes.length, current: d.current, open: isOpen()};
    };
  });

  // ---- self-tests ----------------------------------------------------------------------------------------------------
  const fail = m => { throw new Error(m); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true}));
  // run fn with window globals swapped, everything restored (sheet closed, nav real, fetch real)
  async function sandbox(globals, fn) {
    const saved = {}, had = {}, nav = M._nav, f = window.fetch, lv = live, job = ui.job;
    for (const k in globals) {
      had[k] = Object.prototype.hasOwnProperty.call(window, k); saved[k] = window[k];
      if (globals[k] === undefined) delete window[k]; else window[k] = globals[k];
    }
    live = null; ui.job = null;
    try { return await fn(); }
    finally {
      close();
      for (const k in globals) { if (had[k]) window[k] = saved[k]; else delete window[k]; }
      M._nav = nav; window.fetch = f; live = lv; ui.job = job; stopPoll();
      const b = $("mv-btn"); if (b) b.blur();
    }
  }
  const SYN = () => ({current: "t-code", python: "C:/Py/python.exe", scopes: [
    {id: "t-other", name: "Proj", root: "D:/proj", kind: "central", out: "C:/Users/x/.claude/matrix/scopes/t-other/out",
     built: null, nodes: null, edges: null},
    {id: "t-drive", name: "Drive C", root: "C:/", kind: "central", out: "C:/Users/x/.claude/matrix/scopes/t-drive/out",
     built: new Date(Date.now() - 2 * 3600e3).toISOString(), nodes: 250000, edges: 900000},
    {id: "t-code", name: "Code", root: "c:\\CODE\\", kind: "home", install: "C:/Code/.claude/matrix",
     out: "C:/Code/.claude/matrix/out", built: new Date(Date.now() - 5 * 60e3).toISOString(), nodes: 11051, edges: 39248}]});

  MX.selftest.add("multiverse.open", () => sandbox({}, async () => {
    const b = $("mv-btn"); if (!b) fail("no #mv-btn");
    b.focus(); b.click();
    if (!isOpen() || b.getAttribute("aria-expanded") !== "true") fail("click did not open");
    if (!$("mv").contains(document.activeElement)) fail("focus not moved into the sheet");
    if (!/^Multiverse$/.test($("mv-title").textContent)) fail("title");
    key(document.activeElement, "Escape");
    if (isOpen()) fail("Esc did not close");
    if (document.activeElement !== b) fail("focus not restored to the button");
    key(document.body, "u");
    if (!isOpen()) fail("u did not open");
    const f = focusables(), last = f[f.length - 1];
    last.focus(); key(last, "Tab");
    if (!$("mv").contains(document.activeElement)) fail("Tab escaped the sheet");
    key(document.activeElement, "Escape");
    if (isOpen()) fail("Esc after u did not close");
  }));

  MX.selftest.add("multiverse.list", () => sandbox({MX_SCOPES: SYN(), MX_SERVER: undefined}, async () => {
    open();
    const rows = [...$("mv").querySelectorAll(".mv-row")];
    if (rows.length !== 3) fail("rows " + rows.length + " != 3");
    if (rows[0].getAttribute("data-id") !== "t-code" || !rows[0].classList.contains("is-current")) fail("current not first / marked");
    if (!/you are here/.test(rows[0].textContent)) fail("no 'you are here'");
    if (rows[1].getAttribute("data-id") !== "t-drive" || rows[2].getAttribute("data-id") !== "t-other") fail("not sorted by root");
    const nest = id => ($("mv").querySelector(".mv-row[data-id='" + id + "'] .mv-nest") || {}).textContent || "";
    if (!/contains Code/.test(nest("t-drive"))) fail("parent hint: '" + nest("t-drive") + "'");
    if (!/inside Drive C/.test(nest("t-code"))) fail("child hint: '" + nest("t-code") + "'");
    if (nest("t-other")) fail("unrelated scope has a hint");
    if (!/3 universes/.test($("mv-sub").textContent)) fail("subtitle count");
    if (!/250,000/.test(rows[1].querySelector(".mv-ne").textContent)) fail("nodes · edges");
    if (!/2 h ago/.test(rows[1].querySelector(".mv-ago").textContent)) fail("built-ago");
    if (inside("C:/Code", "c:\\code\\") || !inside("C:/Code/a", "c:\\CODE") || inside("C:/Codebase", "C:/Code")) fail("inside()");
    if (fileUrl("C:/My Docs/#1/out") !== "file:///C:/My%20Docs/%231/out/graph.html") fail("fileUrl " + fileUrl("C:/My Docs/#1/out"));
    let nav = null; M._nav = u => { nav = u; };
    $("mv").querySelector(".mv-row[data-id='t-drive'] .mv-pick").click();
    if (nav !== "file:///C:/Users/x/.claude/matrix/scopes/t-drive/out/graph.html") fail("file nav " + nav);
    nav = null;
    $("mv").querySelector(".mv-row[data-id='t-other'] .mv-pick").click();
    if (nav || !$("mv").querySelector(".mv-err")) fail("unbuilt pick must explain, not navigate");
  }));

  MX.selftest.add("multiverse.fileMode", () => sandbox({MX_SCOPES: SYN(), MX_SERVER: undefined}, async () => {
    open();
    const r = $("mv"), add = r.querySelector("[data-act='add']");
    if (!add || !add.disabled) fail("Add universe not disabled");
    for (const a of ["rebuild", "rename", "remove"]) {
      const bs = r.querySelectorAll("[data-act='" + a + "']");
      if (!bs.length || [...bs].some(x => !x.disabled)) fail(a + " not disabled");
    }
    const cmd = ($("mv-cmd") || {}).textContent || "";
    if (cmd !== '"C:\\Py\\python.exe" "C:\\Code\\.claude\\matrix\\serve.py" --open') fail("command: " + cmd);
    // no MX_SCOPES at all (older build): this page alone + a command
    delete window.MX_SCOPES; render();
    if (r.querySelectorAll(".mv-row").length !== 1) fail("legacy: rows != 1");
    if (!/serve\.py" --open$/.test(($("mv-cmd") || {}).textContent || "")) fail("legacy: no command");
  }));

  MX.selftest.add("multiverse.serverMock", () => sandbox({MX_SCOPES: SYN(), MX_SERVER: {token: "tk-1", base: "", current: "t-code"}}, async () => {
    const calls = [];
    let polls = 0;
    const reg = SYN();
    const NEW = {id: "big-abc123", name: "Big", root: "E:/big", kind: "central", out: "x", built: null, nodes: null, edges: null};
    window.fetch = async (url, o) => {
      o = o || {};
      const m = (o.method || "GET").toUpperCase();
      calls.push(m + " " + url);
      const tok = o.headers && o.headers["X-Matrix-Token"];
      const res = (st, j) => ({ok: st < 400, status: st, json: async () => j});
      if (tok !== "tk-1") return res(403, {error: "bad token"});
      if (m === "GET" && url === "/api/scopes") return res(200, reg);
      if (m === "GET" && url.startsWith("/api/fs")) {
        const p = decodeURIComponent((url.split("path=")[1] || ""));
        return res(200, p ? {path: p, parent: p.length > 3 ? "E:\\" : null, dirs: ["big", {name: ".git", hidden: true}]}
                          : {path: "", parent: null, dirs: ["C:\\", "E:\\"]});
      }
      if (m === "POST" && url === "/api/scopes") {
        const b = JSON.parse(o.body);
        if (b.root !== "E:\\big") return res(400, {error: "unexpected root " + b.root});
        reg.scopes.push(NEW);
        return res(200, {scope: NEW, existing: false, preflight: {files: 61000, bytes: 6e9, warn: "61,000 files, 5.6 GB: the first build will be slow"}});
      }
      if (m === "POST" && url === "/api/scopes/big-abc123/build") return res(200, {job: "j1"});
      if (m === "GET" && url.split("?")[0] === "/api/jobs/j1") {
        polls++;
        return res(200, polls < 3 ? {state: "running", phase: "parsing", progress: polls * 0.4, log: ["scan 61000 files", "parse " + polls]}
                                  : {state: "done", phase: "done", progress: 1, log: ["wrote graph.html"], scope: Object.assign({}, NEW, {built: "2026-10-28T10:00:00Z"})});
      }
      return res(404, {error: "no route " + m + " " + url});
    };
    let nav = null; M._nav = u => { nav = u; };
    open(); await wait(20);
    const r = $("mv");
    if (!/engine connected/.test($("mv-sub").textContent)) fail("not in server mode");
    if (r.querySelector("[data-act='rename']").disabled) fail("rename disabled in server mode");
    r.querySelector("[data-act='add']").click();
    r.querySelector("[data-act='fs-open']").click(); await wait(20);
    const dir = [...r.querySelectorAll("[data-act='fs-into']")].find(x => x.getAttribute("data-name") === "E:\\");
    if (!dir) fail("drive roots not listed");
    dir.click(); await wait(20);
    if (r.querySelector("[data-name='.git']")) fail("hidden dir shown by default");
    r.querySelector("[data-act='fs-hidden']").click();
    if (!r.querySelector("[data-name='.git']")) fail("hidden toggle did not show .git");
    r.querySelector("[data-act='fs-into'][data-name='big']").click(); await wait(20);
    r.querySelector("[data-act='fs-use']").click();
    if ($("mv-root").value !== "E:\\big") fail("use folder: " + $("mv-root").value);
    r.querySelector("[data-act='add-submit']").click(); await wait(20);
    if (!r.querySelector(".mv-warn")) fail("preflight warning not shown");
    r.querySelector("[data-act='add-build']").click(); await wait(20);
    if (!r.querySelector(".mv-job [role='progressbar']")) fail("no progress line");
    for (let i = 0; i < 40 && !nav; i++) await wait(100);
    if (nav !== "/u/big-abc123/") fail("navigation " + nav + "; calls " + calls.join(", "));
    if (polls < 3) fail("polled " + polls);
    if (calls.some(c => !/^(GET|POST|PATCH|DELETE) \/api\//.test(c))) fail("unexpected call");
  }), {timeout: 9000});

  // log panel: a row's persisted log; a live build streams lines (?since), Stop build cancels, failed opens the log
  MX.selftest.add("multiverse.logPanel", () => sandbox({MX_SCOPES: SYN(), MX_SERVER: {token: "tk-2", base: "/s/k", current: "t-code"}}, async () => {
    const calls = [];
    let polls = 0, cancelled = false, failNext = false;
    window.fetch = async (url, o) => {
      o = o || {};
      const m = (o.method || "GET").toUpperCase();
      calls.push(m + " " + url);
      const res = (st, j) => ({ok: st < 400, status: st, json: async () => j});
      if (!url.startsWith("/s/k/api/")) return res(404, {error: "no base"});
      url = url.slice(4);
      if (m === "GET" && url === "/api/scopes") return res(200, SYN());
      if (m === "GET" && url === "/api/scopes/t-drive/log?tail=500")
        return res(200, {log: ["# Matrix build of t-drive", "scan: 3 files", "<unknown>:44: SyntaxWarning: invalid escape sequence '\\d'",
                               "knowledge graph: 3 nodes, 2 edges, 1 communities"], built: "2026-10-28T10:00:00Z"});
      if (m === "POST" && url === "/api/scopes/t-other/build") return res(200, {job: "j9"});
      if (m === "POST" && url === "/api/jobs/j9/cancel") { cancelled = true; return res(200, {cancelled: true}); }
      if (m === "GET" && url.startsWith("/api/jobs/j9?since=")) {
        polls++;
        const since = +url.split("since=")[1];
        if (cancelled) return res(200, {state: "cancelled", phase: "cancelled", progress: null, log: [], next: since});
        if (failNext) return res(200, {state: "failed", phase: "failed (exit 1)", progress: null, log: ["Traceback (most recent call last):", "MemoryError"], next: since + 2});
        return res(200, {state: "running", phase: "parsing", progress: 0.3, log: ["line " + since, "line " + (since + 1)], next: since + 2});
      }
      return res(404, {error: "no route " + m + " " + url});
    };
    open(); await wait(20);
    const r = $("mv");
    r.querySelector("[data-act='log'][data-id='t-drive']").click(); await wait(30);
    const box = r.querySelector(".mv-logbox");
    if (!box || !box.open) fail("log panel not open for the row log");
    if (!r.querySelector(".mv-logbox .mv-note")) fail("python warning not dimmed as a note");
    if (!/build log of 2026-10-28 10:00:00 UTC/.test(r.querySelector(".mv-loghead").textContent)) fail("log timestamp");
    if (!r.querySelector("[data-act='log-copy']")) fail("no Copy");
    r.querySelector("[data-act='job-close']").click();
    // a live build: lines accumulate by since, Stop build cancels
    r.querySelector("[data-act='rebuild'][data-id='t-other']").click();
    for (let i = 0; i < 30 && polls < 2; i++) await wait(100);
    await wait(60);
    if (ui.job.log.join("|") !== "line 0|line 1|line 2|line 3") fail("since accumulation: " + ui.job.log.join("|"));
    if (!calls.some(c => /\/api\/jobs\/j9\?since=2$/.test(c))) fail("since not sent: " + calls.join(", "));
    const stop = r.querySelector("[data-act='job-stop']");
    if (!stop || stop.disabled) fail("no Stop build");
    stop.click();
    for (let i = 0; i < 40 && ui.job.state !== "cancelled"; i++) await wait(100);
    if (!cancelled || ui.job.state !== "cancelled") fail("not cancelled: " + ui.job.state);
    if (!/Build stopped/.test(r.querySelector(".mv-job-head").textContent)) fail("cancelled head");
    if (!r.querySelector(".mv-logbox").open) fail("log not opened on cancel");
    // failed: hairline error + last lines + View log + Retry, log panel open, no navigation
    let nav = null; M._nav = u => { nav = u; };
    cancelled = false; failNext = true; polls = 0;
    r.querySelector("[data-act='job-retry']").click();
    for (let i = 0; i < 40 && ui.job.state !== "failed"; i++) await wait(100);
    if (ui.job.state !== "failed") fail("not failed: " + ui.job.state);
    if (!r.querySelector(".mv-job-err") || !/exit 1/.test(r.querySelector(".mv-job-err").textContent)) fail("no failed error line");
    if (!/MemoryError/.test((r.querySelector(".mv-tail") || {}).textContent || "")) fail("no last log lines");
    if (!r.querySelector("[data-act='job-log']") || !r.querySelector("[data-act='job-retry']")) fail("no View log / Retry");
    if (!r.querySelector(".mv-logbox").open) fail("log not opened on failure");
    if (nav) fail("navigated on failure: " + nav);
  }), {timeout: 12000});
})();
