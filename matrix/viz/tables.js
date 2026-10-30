(function () {
  "use strict";
  // tables.js: one native <table> component. Sort buttons in
  // the header (aria-sort on the active th only), a "Rows a–b of N" pager with
  // Prev/Next, 500 rows a page, and a debounced case-insensitive substring
  // filter over the text columns. Every cell reaches the DOM through MX.esc.
  const MX = window.MX;
  const esc = s => MX.esc(s), fmt = n => MX.fmt(n);
  const coll = new Intl.Collator("en", {numeric: true, sensitivity: "base"});
  const cmp = (a, b) => (typeof a === "number" && typeof b === "number" ? a - b : coll.compare(String(a), String(b)));

  // o: {mount, caption, cols:[{key,label,num?,get(i),cell?(i),text?(i),dir0?,nosort?}], rows:()=>Iterable<int>,
  //     page?, sort?:{key,dir}, filter?, filterInput?, onChange?(state)}
  function make(o) {
    const mount = typeof o.mount === "string" ? document.getElementById(o.mount) : o.mount;
    if (!mount) return null;
    const id = mount.id || "tbl", per = o.page || 500, cols = o.cols;
    const fin = o.filterInput || null, ac = new AbortController();
    const st = {sort: o.sort ? Object.assign({}, o.sort) : null, page: 0,
                filter: o.filter != null ? String(o.filter) : fin ? fin.value : "", rows: 0, total: 0};
    const hayCache = new Map();
    let order = [], dirty = true, fT = 0;
    const colOf = k => cols.find(c => c.key === k);
    const textCols = cols.filter(c => !c.num);
    const txt = (c, i) => String(c.text ? c.text(i) : c.get(i));
    function hay(i) {
      let h = hayCache.get(i);
      if (h === undefined) { h = textCols.map(c => txt(c, i)).join("\u0001").toLowerCase(); hayCache.set(i, h); }
      return h;
    }

    function compute() {
      let rows = Array.from(o.rows());
      st.total = rows.length;
      const f = st.filter.trim().toLowerCase();
      if (f) rows = rows.filter(i => hay(i).includes(f));
      const c = st.sort && colOf(st.sort.key);
      if (c) {                                   // stable: ties keep the rows() order
        const v = rows.map(c.get), pos = rows.map((_, j) => j), s = st.sort.dir === "desc" ? -1 : 1;
        pos.sort((a, b) => s * cmp(v[a], v[b]) || a - b);
        rows = pos.map(j => rows[j]);
      }
      order = rows; st.rows = rows.length;
    }

    function render() {
      if (dirty) { compute(); dirty = false; }
      const n = order.length, pages = Math.max(1, Math.ceil(n / per));
      st.page = Math.max(0, Math.min(st.page, pages - 1));
      const a = st.page * per, b = Math.min(n, a + per);
      const ae = document.activeElement, keep = ae && mount.contains(ae) ?
        (ae.dataset.sort ? `[data-sort="${ae.dataset.sort}"]` : ae.dataset.pg ? `[data-pg="${ae.dataset.pg}"]` : null) : null;
      const sc = st.sort && colOf(st.sort.key);
      const head = cols.map(c => {
        const on = sc === c, cls = c.num ? ' class="num"' : "";
        if (c.nosort) return `<th scope="col"${cls}>${esc(c.label)}</th>`;
        return `<th scope="col"${cls}${on ? ` aria-sort="${st.sort.dir === "desc" ? "descending" : "ascending"}"` : ""}>` +
          `<button type="button" class="sort" data-sort="${esc(c.key)}">${esc(c.label)}` +
          `<span class="sort-ind" aria-hidden="true"></span></button></th>`;   // glyph drawn by CSS from aria-sort
      }).join("");
      let body = "";
      for (let r = a; r < b; r++) {
        const i = order[r], cl = o.rowClass ? o.rowClass(i) : "";
        body += `<tr${cl ? ` class="${esc(cl)}"` : ""}>` + cols.map(c =>
          `<td${c.num ? ' class="num"' : c.cls ? ` class="${c.cls}"` : ""}>` +
          (c.cell ? c.cell(i) : c.num ? fmt(c.get(i)) : esc(c.get(i))) + "</td>").join("") + "</tr>";
      }
      const cap = (typeof o.caption === "function" ? o.caption() : o.caption || "") +
        (sc ? ` — ${fmt(n)} rows, sorted by ${sc.label} ${st.sort.dir === "desc" ? "descending" : "ascending"}` : "");
      mount.innerHTML =
        `<div class="pager"><span class="pager-t">Rows ${n ? fmt(a + 1) + "–" + fmt(b) : "0"} of ${fmt(n)}` +
        (st.total !== n ? ` <span class="meta">(filtered from ${fmt(st.total)})</span>` : "") + `</span>` +
        (pages > 1 ? `<span class="pager-p" aria-hidden="true">${fmt(st.page + 1)} / ${fmt(pages)}</span>` : "") +
        `<button type="button" class="pg" data-pg="-1"${st.page ? "" : " disabled"}>Prev</button>` +
        `<button type="button" class="pg" data-pg="1"${st.page < pages - 1 ? "" : " disabled"}>Next</button></div>` +
        `<table class="tbl"><caption id="${esc(id)}-cap" class="sr-only">${esc(cap)}</caption><thead><tr>${head}</tr></thead>` +
        `<tbody>${body}</tbody></table>` + (n ? "" : `<p class="tbl-empty meta">No rows match.</p>`);
      if (keep) { const el = mount.querySelector(keep); if (el && !el.disabled) el.focus({preventScroll: true}); }
      if (o.onChange) o.onChange(st);
    }

    mount.addEventListener("click", e => {
      const btn = e.target.closest("button[data-sort], button[data-pg]");
      if (!btn || !mount.contains(btn)) return;
      if (btn.dataset.sort) {
        const k = btn.dataset.sort, c = colOf(k);
        st.sort = st.sort && st.sort.key === k ? {key: k, dir: st.sort.dir === "desc" ? "asc" : "desc"}
          : {key: k, dir: c.dir0 || (c.num ? "desc" : "asc")};
        st.page = 0; dirty = true;
      } else st.page += +btn.dataset.pg;
      render();
    }, {signal: ac.signal});
    if (fin) fin.addEventListener("input", () => {
      clearTimeout(fT);
      fT = setTimeout(() => { fT = 0; setFilter(fin.value); }, 120);
    }, {signal: ac.signal});

    function setFilter(v) { st.filter = String(v == null ? "" : v); st.page = 0; dirty = true; render(); }
    render();
    return {
      state: st, render, setFilter,
      refresh() { dirty = true; render(); },
      setPage(p) { st.page = p; render(); },
      setSort(s) { st.sort = s && Object.assign({}, s); st.page = 0; dirty = true; render(); },
      order: () => order,
      matches: (i, f) => hay(i).includes(String(f).toLowerCase()),
      destroy() { clearTimeout(fT); ac.abort(); hayCache.clear(); },
    };
  }

  MX.tables = {make};
  MX.module("tables", () => {});
})();
