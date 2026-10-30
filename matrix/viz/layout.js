(function () {
  "use strict";
  // MX.layout shim: MX.universe (universe.js) is the layout and the
  // sole writer of S.x/S.y. Owns the Spacing
  // slider + Re-layout UI (#f-layout) and the #layout-status line.
  let mute = false, statusEl = null, spRaf = 0;
  const U = () => MX.universe;

  function paintSp(v) {
    const s = document.getElementById("spacing"), o = document.getElementById("spacingv");
    const t = (+v).toFixed(Math.round(v * 100) % 10 ? 2 : 1);
    if (s) { if (!spRaf) s.value = String(v); s.setAttribute("aria-valuetext", "spacing " + t + " times"); }
    if (o) o.textContent = t + "×";
  }
  function setStatus() {
    if (statusEl && statusEl.firstChild) statusEl.firstChild.textContent = MX.state.settled ? "Layout settled" : "Layout settling";
  }

  MX.layout = {
    mode: "universe",
    get spacing() { return U() ? U().spacing : 1; },
    // mxstatus.layout extras: visible-body overlaps + mean NN distance, world units, measured when settled
    get stats() { const u = U() && U().status(); return u ? {overlaps: u.overlaps, nnMean: u.meanNN} : null; },
    start() { MX.state.layoutMode = "universe"; if (U()) U().start(); },
    setSpacing(sp) { sp = +sp > 0 ? +sp : 1; paintSp(sp); if (!mute && U()) U().setSpacing(sp); },
    relayout() { if (U()) U().repack("relayout"); },
    drag(i, x, y) { const u = U(); if (!u) return; if (u.dragging === i) u.dragMove(x, y); else u.dragStart(i, x, y); },
    release() { if (U()) U().dragEnd(); },
  };

  MX.module("layout", () => {
    statusEl = document.getElementById("layout-status");
    if (statusEl) { statusEl.textContent = ""; statusEl.appendChild(document.createElement("span")); setStatus(); }
    MX.on("settled", setStatus);
    MX.on("repack", setStatus);
    const s = document.getElementById("spacing"), b = document.getElementById("relayout");
    if (s) {
      s.addEventListener("input", () => {
        paintSp(+s.value);
        if (spRaf) return;
        spRaf = requestAnimationFrame(() => {
          spRaf = 0;
          if (!mute && MX.camera && MX.camera.zoomBy) MX.camera.zoomBy(1);   // user-set view: the repack anchor holds
          if (MX.filter && MX.filter.setFacet) MX.filter.setFacet("sp", +s.value);
          else MX.layout.setSpacing(+s.value);
        });
      });
      paintSp(MX.layout.spacing);
    }
    if (b) b.addEventListener("click", () => MX.layout.relayout());
  });

  // Spacing UI + hash contract (the layout invariants live in universe.spacing / universe.noOverlap).
  MX.selftest.add("layout.spacing", async () => {
    const fail = m => { throw new Error(m); };
    const H = MX.filter.hash, o = H.parse("#deg=5&sp=2").o;
    if (o.sp !== 2 || H.serialize(o) !== "deg=5&sp=2") fail("hash sp roundtrip " + H.serialize(o));
    if (H.parse("#sp=9").o.sp !== 3 || H.parse("#sp=x").warn.length !== 1) fail("hash sp clamp/warn");
    const sl = document.getElementById("spacing"), out = document.getElementById("spacingv");
    const F = MX.state.facets, sp0 = F.sp, rf = document.getElementById("reset-filters");
    if (!sl || !out) fail("no #spacing / #spacingv");
    mute = true;                                          // UI, facet and hash only: the page layout keeps its spacing
    try {
      sl.value = "2.5"; sl.dispatchEvent(new Event("input", {bubbles: true}));
      if (out.textContent !== "2.5×") fail("label not live: " + out.textContent);
      if (!/2\.5/.test(sl.getAttribute("aria-valuetext") || "")) fail("aria-valuetext " + sl.getAttribute("aria-valuetext"));
      await new Promise(res => requestAnimationFrame(() => setTimeout(res, 0)));
      if (F.sp !== 2.5) fail("facet sp " + F.sp);
      if (!/(^|&)sp=2\.5(&|$)/.test(H.serialize(H.state()))) fail("sp not in hash");
      if (rf && rf.hidden) fail("Reset filters hidden with sp set");
      const st = H.state();
      if (rf && !st.type && !st.comm && !st.rel && !st.prov && !st.orphans && !st.deg) {
        rf.click();
        if (F.sp !== 1 || +sl.value !== 1) fail("Reset filters did not reset spacing");
      }
    } finally {
      MX.filter.setFacet("sp", sp0);
      mute = false;
    }
  });
})();
