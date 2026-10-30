(function () {
  "use strict";
  // charts.js: dependency-free SVG chart primitives, drawn in the hairline grammar:
  // thin neutral bars at low alpha with a 1px cap at the data end, provenance as line grammar
  // (p0 solid fill, p1 dashed outline, p2 dotted outline), tabular mono values, faint scale rules;
  // hover = bright ink + a crosshair rule, never a colour flood.
  // Pure functions over the rows they are given; no knowledge of MX.g.
  // Colours come only from CSS classes in dash.css (/* == charts == */).
  // Every string reaches the DOM through MX.esc (markup) or textContent (tooltip).
  const MX = window.MX;
  const esc = s => MX.esc(s);
  const fmt = v => (typeof v === "number" && isFinite(v) ? MX.fmt(v) : "—");
  const raw = v => (typeof v === "number" && isFinite(v) ? String(v) : "");
  const n1 = v => Math.round(v * 10) / 10;
  const ROW = 22, BAR = 7, GH = 26, GAP = 2, FS = 12, MS = 11, LS = 0.06;
  const reg = new WeakMap();       // figure -> {cb, items}
  const hosts = new WeakMap();     // mount element -> {W, draw}
  const roving = new Map();        // mount id -> key of the mark holding tabindex=0
  let ctx = null, font = "", mono = "", tipEl = null, ro = null, installed = false;

  // ---- text measurement (canvas, same fonts as the page) ------------------
  function tw(s, px, m) {
    if (!ctx) ctx = document.createElement("canvas").getContext("2d");
    s = String(s);
    ctx.font = (px || FS) + "px " + (m ? mono || "monospace" : font);
    return Math.ceil(ctx.measureText(s).width + (m === 2 ? s.length * (px || FS) * LS : 0));
  }
  // middle truncation: long identifiers keep their head and their tail
  function fit(s, w, px, m) {
    s = String(s == null ? "" : s);
    if (tw(s, px, m) <= w) return s;
    const cut = k => s.slice(0, Math.ceil(k / 2)) + "…" + s.slice(s.length - Math.floor(k / 2));
    let lo = 0, hi = s.length;
    while (lo < hi) { const k = (lo + hi + 1) >> 1; if (tw(cut(k), px, m) <= w) lo = k; else hi = k - 1; }
    return cut(lo);
  }
  function nice(x) {
    if (!(x > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return Math.max(1, m * p);
    return 10 * p;
  }
  const up = s => String(s == null ? "" : s).toUpperCase();

  // ---- shared pieces --------------------------------------------------------
  // provenance key: a 16px line in the series' grammar (solid / dashed / dotted) + mono caps name
  const lineSw = (p, x, y) => `<line class="lsw p${p | 0}" x1="${x}" x2="${x + 16}" y1="${y}" y2="${y}"/>`;
  function legend(keys, y) {
    let x = 0, out = "";
    for (const k of keys) {
      const t = up(k.label);
      out += lineSw(k.pattern, x, y + 6.5) + `<text class="key" x="${x + 22}" y="${y + 10}">${esc(t)}</text>`;
      x += 22 + tw(t, 10.5, 2) + 22;
    }
    return `<g class="legend" aria-hidden="true">${out}</g>`;
  }
  function mark(o, i, r, aria, tip, inner) {
    const href = r.href || (o.facet ? "#" + o.facet + "=" + encodeURIComponent(r.key) : "#" + o.mount);
    const toggle = o.toggle !== false;
    return `<a class="mark" href="${esc(href)}"${toggle ? ` role="button" aria-pressed="${!!r.pressed}"` : ""} tabindex="-1"` +
      ` aria-label="${esc(aria)}" data-key="${esc(r.key)}" data-value="${raw(r.value)}" data-i="${i}" data-tip="${esc(tip)}">${inner}</a>`;
  }
  function table(caption, head, rows) {
    const th = head.map(h => `<th scope="col"${h.num ? ' class="num"' : ""}>${esc(h.label)}</th>`).join("");
    const tr = rows.map(c => "<tr>" + c.map((v, j) => (j ? `<td${head[j].num ? ' class="num"' : ""}>` : '<th scope="row">') + esc(v) + (j ? "</td>" : "</th>")).join("") + "</tr>").join("");
    return `<details class="chart-data"><summary>Data table</summary><table><caption>${esc(caption)}</caption><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></details>`;
  }
  const unitOf = o => o.unit || "";
  const ariaOf = (o, label, v, extra) => `${label}: ${fmt(v)}${unitOf(o) ? " " + unitOf(o) : ""}${extra || ""}`;
  const tipOf = (o, label, extra) => `${unitOf(o) ? unitOf(o) + " · " : ""}${label}${extra || ""}`;
  function autoDesc(o, items, noun) {
    let top = null;
    for (const r of items) if (typeof r.value === "number" && (!top || r.value > top.value)) top = r;
    return `${items.length} ${noun}` + (top ? `; largest ${top.label} ${fmt(top.value)}${unitOf(o) ? " " + unitOf(o) : ""}` : "");
  }

  // ---- render: one figure per mount, replaced in one go -------------------
  // figcaption = section head: mono micro-label (o.kicker) over a quiet sans title
  function render(o, kind, items, draw) {
    install();
    const host = o.mount && document.getElementById(o.mount);
    const cs0 = getComputedStyle(host || document.body);
    font = cs0.fontFamily || "sans-serif";
    mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";
    let W = o.width || 0;
    if (!W && host) W = host.clientWidth - (parseFloat(cs0.paddingLeft) || 0) - (parseFloat(cs0.paddingRight) || 0);
    W = Math.max(280, Math.round(W > 0 ? W : 480));
    const d = draw(W);
    const m = esc(o.mount);
    const fig = document.createElement("figure");
    fig.className = "chart chart--" + kind;
    fig.dataset.mount = o.mount || "";
    fig.innerHTML = `<figcaption>${o.kicker ? `<span class="sec-k">${esc(o.kicker)}</span>` : ""}<span class="sec-t">${esc(o.title)}</span>` +
      (d.aside ? `<span class="sec-a">${esc(d.aside)}</span>` : "") + `</figcaption>` +
      `<svg role="group" aria-labelledby="${m}-title" aria-describedby="${m}-desc" viewBox="0 0 ${W} ${Math.ceil(d.H)}" width="100%" preserveAspectRatio="xMinYMin meet">` +
      `<title id="${m}-title">${esc(o.title)}</title><desc id="${m}-desc">${esc(o.desc || d.desc)}</desc>${d.body}</svg>` +
      table(o.title, d.head, d.rows);
    reg.set(fig, {cb: o.onActivate || o.onSelect || null, items});
    if (host) {
      const act = document.activeElement, had = host.contains(act) && act.matches("a.mark");
      host.replaceChildren(fig);
      hosts.set(host, {W, draw: () => render(o, kind, items, draw)});
      if (ro) ro.observe(host);
      rove(fig, had ? act.dataset.key : roving.get(o.mount), had);
    } else rove(fig, null, false);
    return fig;
  }
  function rove(fig, key, focus) {
    const marks = fig.querySelectorAll("a.mark");
    if (!marks.length) return;
    let t = marks[0];
    for (const a of marks) if (a.dataset.key === key) t = a;
    t.setAttribute("tabindex", "0");
    if (focus) t.focus({preventScroll: true});
  }

  // ---- MX.charts.bar: horizontal hairline bars (optionally split by provenance) ---
  // o.cap: when one bar dwarfs the rest (> 4x the runner-up) the scale is capped just above the
  // runner-up; overflowing bars run to the end with break marks and an annotated note.
  function bar(o) {
    const groups = o.groups || [{rows: o.rows || []}];
    const items = [].concat(...groups.map(gp => gp.rows));
    const segKeys = [], seen = new Set();
    for (const r of items) for (const s of r.segs || []) if (!seen.has(s.key)) { seen.add(s.key); segKeys.push(s); }
    return render(o, "bar", items, W => {
      const vs = items.map(r => r.value || 0).sort((a, b) => b - a), max = vs[0] || 1;
      const cap = o.cap && vs.length > 2 && vs[1] > 0 && max > 4 * vs[1] ? nice(vs[1] * 1.15) : max;
      const over = items.filter(r => (r.value || 0) > cap).length;
      const ind = o.groups ? 12 : 0;
      const labW = Math.min(Math.round(W * 0.3), ind + items.reduce((a, r) => Math.max(a, tw(r.label)), 40)) + 16;
      const valW = tw(fmt(max), MS, 1) + 14, plotW = Math.max(40, W - labW - valW);
      const sx = v => Math.min(v, cap) / cap * plotW;
      let y = 0, body = "";
      if (segKeys.length) { body += legend(segKeys, 0); y = 24; }
      const ay = y + 9;
      y += 18;
      const nGrp = groups.filter(gp => gp.label != null && gp.rows.length).length;
      const top = y, bot = y + nGrp * GH + items.length * ROW;
      const step = nice(cap / 4);
      for (let t = 0; t <= cap + 1e-9; t += step) {
        const x = n1(labW + sx(t)) + 0.5;
        if (t) body += `<line class="grid" x1="${x}" x2="${x}" y1="${top - 4}" y2="${bot}"/>`;
        body += `<text class="tick" x="${x}" y="${ay}" text-anchor="${t ? "middle" : "start"}">${fmt(t)}</text>`;
      }
      let i = 0;
      for (const gp of groups) {
        if (gp.label != null && gp.rows.length) {
          body += `<g class="grp" aria-hidden="true"><circle class="sw g${(gp.swatch | 0) & 3}" cx="3" cy="${y + GH - 9.5}" r="3"/>` +
            `<text class="grp-t" x="${ind}" y="${y + GH - 6}">${esc(up(gp.label))}</text></g>`;
          y += GH;
        }
        for (const r of gp.rows) {
          const v = r.value || 0, L = v > 0 ? Math.max(1.5, sx(v)) : 0, cy = y + ROW / 2, by = cy - BAR / 2, x0 = labW;
          let ink = "", extra = "";
          if (r.segs) {
            const segs = r.segs.filter(s => s.value > 0);
            let x = x0;
            segs.forEach((s, j) => {
              const w = v ? s.value / v * L : 0, last = j === segs.length - 1, ww = Math.max(1, last ? w : w - GAP);
              ink += `<rect class="seg p${s.pattern | 0}" data-seg="${esc(s.key)}" data-n="${raw(s.value)}" x="${n1(x) + 0.5}" y="${by + 0.5}" width="${n1(Math.max(0.5, ww - 1))}" height="${BAR - 1}" rx="1"/>`;
              x += w;
            });
            extra = " (" + r.segs.map(s => `${s.label} ${fmt(s.value)}`).join(" · ") + ")";
          } else if (L) ink = `<rect class="bar${r.dim ? " dim" : ""}" x="${x0}" y="${by}" width="${n1(L)}" height="${BAR}" rx="1"/>`;
          const ex = n1(x0 + L) - 0.5;
          if (L) ink += `<line class="cap" x1="${ex}" x2="${ex}" y1="${by - 2}" y2="${by + BAR + 2}"/>`;
          if (v > cap) {
            const bx = n1(x0 + plotW - 18);
            ink += `<rect class="brk-gap" x="${bx}" y="${by - 3}" width="5" height="${BAR + 6}"/>` +
              `<path class="brk" d="M${bx - 1.5} ${by + BAR + 3}l3 ${-(BAR + 6)}M${bx + 3.5} ${by + BAR + 3}l3 ${-(BAR + 6)}"/>`;
          }
          body += mark(o, i++, r, ariaOf(o, r.label, r.value, extra), tipOf(o, r.label, extra),
            `<rect class="hit" x="0" y="${y}" width="${W}" height="${ROW}"/>` +
            (L ? `<line class="xh" x1="${ex}" x2="${ex}" y1="${top - 4}" y2="${bot}"/>` : "") +
            `<text class="lbl" x="${ind}" y="${cy + 4}">${esc(fit(r.label, labW - ind - 14))}</text>${ink}` +
            `<text class="val${v > cap ? " over" : ""}" x="${n1(x0 + L + 7)}" y="${cy + 4}">${fmt(r.value)}</text>`);
          y += ROW;
        }
      }
      body += `<line class="axis" x1="${labW + 0.5}" x2="${labW + 0.5}" y1="${top - 4}" y2="${bot}"/>`;
      let H = bot + 4;
      if (over) {
        body += `<text class="note" x="${labW}" y="${bot + 18}">Scale capped at ${fmt(cap)} · ${over} bar${over > 1 ? "s" : ""} off scale, break-marked, true value shown</text>`;
        H = bot + 24;
      }
      const head = [{label: o.labelHead || "Label"}].concat(o.groups ? [{label: "Group"}] : [], [{label: o.valueHead || "Value", num: 1}], segKeys.map(s => ({label: s.label, num: 1})));
      const rows = [];
      for (const gp of groups) for (const r of gp.rows) {
        const segv = segKeys.map(k => { const s = (r.segs || []).find(z => z.key === k.key); return fmt(s ? s.value : 0); });
        rows.push([r.label].concat(o.groups ? [gp.label] : [], [fmt(r.value)], segv));
      }
      return {H, body, head, rows, desc: autoDesc(o, items, "bars") + (over ? `; scale capped at ${fmt(cap)}` : ""),
        aside: over ? "capped scale" : ""};
    });
  }

  // ---- MX.charts.hist: hairline columns with a linear y axis -----------------
  function hist(o) {
    const bins = o.bins || [];
    return render(o, "hist", bins, W => {
      const vmax = bins.reduce((a, b) => Math.max(a, b.value || 0), 0), step = nice(vmax / 3);
      const ymax = Math.max(step, Math.ceil(vmax / step) * step);
      const axW = tw(fmt(ymax), 10, 1) + 12, top = 14, plotH = 150, base = top + plotH;
      const band = (W - axW) / Math.max(1, bins.length), cw = n1(Math.max(2, Math.min(10, band * 0.42)));
      const lw = bins.reduce((a, b) => Math.max(a, tw(b.label, 10, 1)), 0), every = Math.max(1, Math.ceil((lw + 8) / band));
      let body = "";
      for (let t = step; t <= ymax + 1e-9; t += step) {
        const ty = n1(base - t / ymax * plotH) + 0.5;
        body += `<line class="grid" x1="${axW}" x2="${W}" y1="${ty}" y2="${ty}"/>`;
      }
      for (let t = 0; t <= ymax + 1e-9; t += step) body += `<text class="tick" x="${axW - 8}" y="${n1(base - t / ymax * plotH + 3.5)}" text-anchor="end">${fmt(t)}</text>`;
      const imax = bins.findIndex(b => (b.value || 0) === vmax && vmax > 0);
      bins.forEach((b, i) => {
        const v = b.value || 0, h = v / ymax * plotH, bx = axW + i * band, cx = n1(bx + (band - cw) / 2), ty = n1(base - Math.max(1, h)) + 0.5;
        const lab = i === imax || b.pressed;
        body += mark(o, i, b, ariaOf(o, b.label, b.value), tipOf(o, b.label),
          `<rect class="hit" x="${n1(bx)}" y="0" width="${n1(band)}" height="${base + 22}"/>` +
          (h > 0 ? `<line class="xh" x1="${axW}" x2="${W}" y1="${ty}" y2="${ty}"/>` +
            `<rect class="bar${b.dim ? " dim" : ""}" x="${cx}" y="${n1(base - Math.max(1, h))}" width="${cw}" height="${n1(Math.max(1, h))}" rx="1"/>` +
            `<line class="cap" x1="${n1(cx - 1.5)}" x2="${n1(cx + cw + 1.5)}" y1="${ty}" y2="${ty}"/>` : "") +
          (lab ? `<text class="val" x="${n1(bx + band / 2)}" y="${n1(base - h - 7)}" text-anchor="middle">${fmt(v)}</text>` : "") +
          (i % every === 0 ? `<text class="xl" x="${n1(bx + band / 2)}" y="${base + 16}" text-anchor="middle">${esc(b.label)}</text>` : ""));
      });
      body += `<line class="axis" x1="${axW}" x2="${W}" y1="${base + 0.5}" y2="${base + 0.5}"/>`;
      return {H: base + 22, body, head: [{label: o.labelHead || "Bin"}, {label: o.valueHead || "Value", num: 1}],
        rows: bins.map(b => [b.label, fmt(b.value)]), desc: autoDesc(o, bins, "bins")};
    });
  }

  // ---- MX.charts.stacked: one thin 100% rule in line grammar + a key row of figures ----
  function stacked(o) {
    const segs = o.segs || [];
    const total = segs.reduce((a, s) => a + (s.value || 0), 0);
    const pct = v => (total ? (v > 0 && v / total < 0.01 ? "<1%" : Math.round(v / total * 100) + "%") : "0%");
    return render(o, "stacked", segs, W => {
      const TY = 4, TH = 8, colW = W / Math.max(1, segs.length), ly = TY + TH + 30;
      let x = 0, body = "";
      const live = segs.filter(s => s.value > 0), lastLive = live[live.length - 1];
      segs.forEach((s, i) => {
        const w = total ? (s.value || 0) / total * W : 0, last = s === lastLive, lx = n1(i * colW), p = s.pattern | 0;
        const big = fmt(s.value);
        body += mark(o, i, s, ariaOf(o, s.label, s.value, ` (${pct(s.value || 0)})`), tipOf(o, s.label, ` (${pct(s.value || 0)})`),
          `<rect class="hit" x="${n1(x)}" y="0" width="${n1(Math.max(w, 2))}" height="${TY * 2 + TH}"/>` +
          `<rect class="hit" x="${lx}" y="${ly - 14}" width="${n1(colW - 8)}" height="48"/>` +
          (w > 0 ? `<rect class="seg p${p}" data-seg="${esc(s.key)}" data-n="${raw(s.value)}" x="${n1(x) + 0.5}" y="${TY + 0.5}" width="${n1(Math.max(0.5, (last ? w : w - GAP) - 1))}" height="${TH - 1}" rx="1"/>` +
            `<line class="xh" x1="${n1(x + w / 2)}" x2="${n1(x + w / 2)}" y1="${TY + TH + 3}" y2="${ly - 16}"/>` : "") +
          lineSw(p, lx, ly - 4) + `<text class="key" x="${n1(lx + 22)}" y="${ly}">${esc(fit(up(s.label), colW - 30, 10.5, 2))}</text>` +
          `<text class="big" x="${lx}" y="${ly + 26}">${big}</text>` +
          `<text class="pct" x="${n1(lx + tw(big, 20) + 8)}" y="${ly + 26}">${pct(s.value || 0)}</text>`);
        x += w;
      });
      return {H: ly + 34, body,
        head: [{label: o.labelHead || "Segment"}, {label: o.valueHead || "Value", num: 1}, {label: "Share", num: 1}],
        rows: segs.map(s => [s.label, fmt(s.value), pct(s.value || 0)]),
        desc: `${segs.length} segments of ${fmt(total)}${unitOf(o) ? " " + unitOf(o) : ""}: ` + segs.map(s => `${s.label} ${pct(s.value || 0)}`).join(", ")};
    });
  }

  // ---- MX.charts.tiles: KPI strip, one hairline-divided row (headline numbers are not a chart) --
  // t.ratio (0..1, optional) draws a faint 1px ratio rule under the figure
  function tiles(mount, items) {
    let host = typeof mount === "string" ? document.getElementById(mount) : mount;
    if (!host) host = document.createElement("div");
    host.classList.add("tiles");
    host.style.setProperty("--n", String(items.length));
    host.innerHTML = items.map((t, i) => {
      const tag = t.onActivate ? "button" : "div";
      const pressed = t.onActivate && typeof t.pressed === "boolean" ? ` aria-pressed="${t.pressed}"` : "";
      const r = typeof t.ratio === "number" && isFinite(t.ratio) ? Math.max(0, Math.min(1, t.ratio)) : null;
      return `<${tag} class="tile${t.hero ? " tile--hero" : ""}"${tag === "button" ? ' type="button"' : ""}${pressed} data-key="${esc(t.key)}" data-value="${raw(t.value)}" data-i="${i}">` +
        `<span class="tile-label">${esc(t.label)}</span><span class="tile-value">${fmt(t.value)}</span>` +
        (t.sub != null ? `<span class="tile-sub">${esc(t.sub)}</span>` : "") +
        (r != null ? `<span class="tile-ratio" aria-hidden="true"><i style="width:${(r * 100).toFixed(1)}%"></i></span>` : "") + `</${tag}>`;
    }).join("");
    host.onclick = e => {
      const b = e.target.closest("button.tile");
      const t = b && host.contains(b) ? items[+b.dataset.i] : null;
      if (t && t.onActivate) t.onActivate(t, e);
    };
    return host;
  }

  // ---- #chart-tip: one tooltip, value first, textContent only --------------
  const tip = {
    show(a) {
      if (!tipEl) {
        tipEl = document.createElement("div");
        tipEl.id = "chart-tip"; tipEl.className = "chart-tip glass-strong";
        tipEl.setAttribute("role", "tooltip"); tipEl.hidden = true;
        document.body.appendChild(tipEl);
      }
      const b = document.createElement("b");
      b.textContent = fmt(a.dataset.value === "" ? NaN : +a.dataset.value);
      tipEl.replaceChildren(b, document.createTextNode(" " + (a.dataset.tip || "")));
      tipEl.hidden = false;
      const ink = a.querySelectorAll(".bar, .seg"), anc = ink[ink.length - 1] || a.querySelector(".hit") || a;
      const r = anc.getBoundingClientRect(), tr = tipEl.getBoundingClientRect();
      const left = Math.max(8, Math.min(innerWidth - tr.width - 8, r.right - tr.width / 2));
      const top = r.top - tr.height - 8 < 8 ? r.bottom + 8 : r.top - tr.height - 8;
      tipEl.style.left = left + "px"; tipEl.style.top = top + "px";
    },
    hide() { if (tipEl) tipEl.hidden = true; },
    get visible() { return !!tipEl && !tipEl.hidden; },
  };

  // ---- delegated interaction: activation, roving focus, tooltip ------------
  const markOf = t => (t && t.closest ? t.closest("figure.chart a.mark") : null);
  function activate(a, e) {
    const st = reg.get(a.closest("figure.chart"));
    if (st && st.cb) { e.preventDefault(); st.cb(st.items[+a.dataset.i], +a.dataset.i, e); }
    else if (e.type === "keydown") { e.preventDefault(); location.hash = a.getAttribute("href"); }
  }
  function setRove(a) {
    const fig = a.closest("figure.chart");
    for (const m of fig.querySelectorAll("a.mark")) m.setAttribute("tabindex", m === a ? "0" : "-1");
    roving.set(fig.dataset.mount, a.dataset.key);
  }
  function install() {
    if (installed) return;
    installed = true;
    document.addEventListener("click", e => {
      const a = markOf(e.target);
      if (a && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) activate(a, e);
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && tip.visible) { tip.hide(); e.preventDefault(); return; }
      const a = markOf(e.target);
      if (!a) return;
      if (e.key === "Enter" || e.key === " ") { activate(a, e); return; }
      const marks = [...a.closest("figure.chart").querySelectorAll("a.mark")], i = marks.indexOf(a);
      const j = {ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: marks.length - 1}[e.key];
      if (j === undefined) return;
      e.preventDefault();
      const t = marks[Math.max(0, Math.min(marks.length - 1, j))];
      setRove(t); t.focus();
    });
    document.addEventListener("focusin", e => {
      const a = markOf(e.target);
      if (a) { setRove(a); tip.show(a); }
    });
    document.addEventListener("focusout", e => { if (markOf(e.target)) tip.hide(); });
    document.addEventListener("pointerover", e => { const a = markOf(e.target); if (a) tip.show(a); });
    document.addEventListener("pointerout", e => {
      const a = markOf(e.target);
      if (a && !a.contains(e.relatedTarget) && document.activeElement !== a) tip.hide();
    });
    // redraw in the next frame, coalesced per host: a synchronous redraw inside the callback resizes the observed
    // host again ("ResizeObserver loop completed with undelivered notifications")
    const due = new Set();
    let raf = 0;
    const flush = () => {
      raf = 0;
      const els = [...due]; due.clear();
      for (const el of els) { const h = hosts.get(el); if (h && el.isConnected) h.draw(); }
    };
    if (window.ResizeObserver) ro = new ResizeObserver(entries => {
      for (const en of entries) {
        const h = hosts.get(en.target), w = en.contentRect.width;
        if (h && w > 50 && Math.abs(w - h.W) > 24) due.add(en.target);
      }
      if (due.size && !raf) raf = requestAnimationFrame(flush);
    });
  }

  MX.charts = {bar, hist, stacked, tiles, tip};
  MX.module("charts", install);
})();
