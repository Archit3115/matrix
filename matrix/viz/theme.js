(function () {
  "use strict";
  // Canvas colours come from a hidden probe span: computed colour is always
  // an rgb colour, even in forced colours. Every key below is defined in app.css's token block
  // (hairline token sheet + the universe inks); the var() fallbacks only guard a missing token.
  const TOKENS = {
    g0: "--g0", g1: "--g1", g2: "--g2", g3: "--g3",
    surface: "--surface-1", text: "--text-primary", muted: "--muted",
    edgeIdle: "var(--edge-idle, var(--muted))",
    prov: "var(--prov-extracted, var(--muted))",
    accent: "var(--accent, var(--text-primary))",
    accentStroke: "var(--accent-stroke, var(--text-primary))",
    pathHalo: "var(--path-halo, var(--baseline))",
    searchHit: "var(--search-hit-ring, var(--accent-stroke, var(--text-primary)))",
    focusRing: "var(--focus-ring, var(--accent-stroke, var(--text-primary)))",
    selRing: "var(--selection-ring, var(--accent-stroke, var(--text-primary)))",
    // glass node sprites (render.js); fall back to existing tokens until app.css carries them
    nodeShadow: "var(--node-shadow, var(--text-primary))",
    nodeHi: "var(--node-highlight, var(--surface-1))",
    nodeRim: "var(--node-rim, var(--surface-1))",
    // universe: glow inks, threads, CMB ramp, labels. Fallbacks keep old sheets working.
    glowG0: "var(--glow-g0, var(--g0))", glowG1: "var(--glow-g1, var(--g1))",
    glowG2: "var(--glow-g2, var(--g2))", glowG3: "var(--glow-g3, var(--g3))",
    corona: "var(--glow-corona, var(--border))", halo: "var(--glow-halo, var(--border))",
    thread: "var(--glow-thread, var(--edge-idle, var(--muted)))", threadHot: "var(--glow-thread-hot, var(--muted))",
    particle: "var(--glow-particle, var(--text-primary))", glowState: "var(--glow-state, var(--accent-stroke, var(--text-primary)))",
    cmb0: "var(--cmb-0, var(--page))", cmb1: "var(--cmb-1, var(--surface-1))", cmb2: "var(--cmb-2, var(--muted))",
    orbitRing: "var(--orbit-ring, var(--border))", pathStroke: "var(--path-stroke, var(--accent-stroke, var(--text-primary)))",
    labelInk: "var(--label-ink, var(--text-primary))", labelInk2: "var(--label-ink-2, var(--text-secondary))",
    labelHalo: "var(--label-halo, var(--surface-1))",
    // v5 aurora gas: per-group gas core/rim inks, filament peak, backdrop gradient stops, sun-corona flag (alpha 0 = off)
    gasG0: "var(--gas-g0, var(--glow-g0))", gasG1: "var(--gas-g1, var(--glow-g1))", gasG2: "var(--gas-g2, var(--glow-g2))", gasG3: "var(--gas-g3, var(--glow-g3))",
    gasB0: "var(--gas-g0-b, var(--glow-g0))", gasB1: "var(--gas-g1-b, var(--glow-g1))", gasB2: "var(--gas-g2-b, var(--glow-g2))", gasB3: "var(--gas-g3-b, var(--glow-g3))",
    filament: "var(--glow-filament, var(--glow-thread-hot, var(--muted)))",
    backdrop1: "var(--backdrop-1, var(--page))", backdrop2: "var(--backdrop-2, var(--page))",
    sunCorona: "var(--sun-corona, var(--glow-corona, var(--border)))",
  };
  // computed colour -> [r, g, b, a] in 0..1 (rgb/rgba channels are 0..255, color(srgb ...) channels 0..1)
  function toRgba(s) {
    const v = String(s).match(/-?[\d.]+(e-?\d+)?/g) || [], k = /^\s*color\(/.test(s) ? 1 : 255;
    return [+v[0] / k || 0, +v[1] / k || 0, +v[2] / k || 0, v.length > 3 ? +v[3] : 1];
  }
  const LEGACY_FONT = "Consolas, monospace";   // app.css --font missing (template mid-edit)
  const root = document.documentElement;

  function probe() {
    const th = MX.state.theme, el = document.getElementById("mx-probe");
    const c = {}, q = {};
    for (const k in TOKENS) {
      const t = TOKENS[k];
      el.style.color = t.startsWith("var(") ? t : "var(" + t + ")";
      c[k] = getComputedStyle(el).color;
      q[k] = toRgba(c[k]);
    }
    th.colors = c;
    th.rgba = q;                                          // render.js / gl.js inks (no literals in JS)
    const rs = getComputedStyle(root);
    th.font = rs.getPropertyValue("--font").trim() || rs.getPropertyValue("--font-sans").trim() || LEGACY_FONT;   // labels.js canvas text
    th.forced = matchMedia("(forced-colors: active)").matches;
    th.blend = !th.forced && rs.getPropertyValue("--glow-blend").trim() === "lighter" ? "lighter" : "source-over";
    const attr = root.dataset.theme;
    th.name = attr || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const hd = document.querySelector("header"), hs = hd ? getComputedStyle(hd) : null;
    th.glass = {
      backdrop: !!(window.CSS && CSS.supports("backdrop-filter", "blur(1px)")),
      reducedTransparency: matchMedia("(prefers-reduced-transparency: reduce)").matches,
      chromeBg: hs ? hs.backgroundColor : null,
      chromeBlur: hs ? hs.backdropFilter || "none" : null,
    };
  }

  function refreshColors() {
    probe();
    const b = document.getElementById("theme");
    if (b) b.setAttribute("aria-pressed", String(MX.state.theme.name === "dark"));
    MX.emit("theme"); MX.status();
  }
  MX.theme = {refreshColors};

  MX.module("theme", () => {
    refreshColors();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refreshColors);
    matchMedia("(forced-colors: active)").addEventListener("change", refreshColors);
    matchMedia("(prefers-reduced-transparency: reduce)").addEventListener("change", refreshColors);
    const tb = document.getElementById("theme");
    if (tb) tb.addEventListener("click", () => {
      const eff = MX.state.theme.name;
      const next = eff === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("mx.theme", next); } catch (e) { /* storage blocked */ }
      MX.state.theme.source = "toggle";
      refreshColors();
    });
    let stored = null;
    try { stored = localStorage.getItem("mx.theme"); } catch (e) { /* storage blocked */ }
    MX.state.theme.source = /[#&]theme=(light|dark)(&|$)/.test(location.hash) ? "hash"     // test hook (template.html)
      : stored === "dark" || stored === "light" ? "stored" : "default";                    // default = dark
    refreshColors();
    if (MX.selftest) {
      MX.selftest.add("theme.toggle", () => {
        const btn = document.getElementById("theme"), before = MX.state.theme.name;
        btn.click();
        const after = MX.state.theme.name;
        btn.click();
        if (before === after) throw new Error("toggle did not flip " + before);
        if (MX.state.theme.name !== before) throw new Error("second click did not restore");
      });
      MX.selftest.add("theme.persist", () => {
        const btn = document.getElementById("theme");
        btn.click();
        let v = null;
        try { v = localStorage.getItem("mx.theme"); } catch (e) { /* blocked: skip */ }
        const want = MX.state.theme.name;
        btn.click();
        if (v !== null && v !== want) throw new Error("stored " + v + " != " + want);
      });
    }
  });
})();
