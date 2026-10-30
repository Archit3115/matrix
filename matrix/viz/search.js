(function () {
  "use strict";
  // Client search: ASCII camel-aware tokenizer + BM25F-lite index,
  // built at load from the payload, never shipped. Boolean AND over query
  // tokens; a token matches a doc token exactly, as a prefix, or (len >= 3)
  // as an infix. A doc matches when every query token does.
  const PART = /[A-Za-z0-9]+/g;
  const CAMEL = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g;
  const K1 = 1.2, B = 0.75;
  const KIND = {exact: 1.0, prefix: 0.7, infix: 0.4};

  function tokenize(s, doc) {
    const out = [], parts = String(s == null ? "" : s).match(PART) || [];
    for (const p of parts) {
      const pieces = p.replace(CAMEL, " ").split(" ");
      for (const x of pieces) out.push(x.toLowerCase());
      if (doc && pieces.length > 1) out.push(p.toLowerCase());
    }
    if (doc) return out;
    return [...new Set(out)].filter(t => t.length >= 2);
  }

  // index: vocab (sorted terms) -> postings {docs:Int32Array, wtf:Float32Array}
  let vocab = null, post = null, dlen = null, avglen = 1;

  function build() {
    if (MX.search.ready) return;
    const g = MX.g, N = g.N;
    const termId = new Map(), pDocs = [], pTf = [];
    dlen = new Float32Array(N);
    let total = 0;
    for (let i = 0; i < N; i++) {
      const m = g.meta.get(i), f = g.file[i] || "";
      const fields = [
        [g.label[i], 3], [f.slice(f.lastIndexOf("/") + 1), 1],
        [m && m.statement, 2], [m && m.body, 1],
      ];
      const tf = new Map();
      let len = 0;
      for (const [text, w] of fields) {
        if (!text) continue;
        for (const t of tokenize(text, true)) {
          if (t.length < 2) continue;          // a query token (len >= 2) can never match it
          tf.set(t, (tf.get(t) || 0) + w); len += w;
        }
      }
      dlen[i] = len; total += len;
      for (const [t, v] of tf) {
        let k = termId.get(t);
        if (k === undefined) { k = pDocs.length; termId.set(t, k); pDocs.push([]); pTf.push([]); }
        pDocs[k].push(i); pTf[k].push(v);
      }
    }
    avglen = total / Math.max(N, 1) || 1;
    vocab = [...termId.keys()].sort();
    post = vocab.map(t => {
      const k = termId.get(t);
      return {docs: Int32Array.from(pDocs[k]), wtf: Float32Array.from(pTf[k])};
    });
    MX.search.ready = true;
  }

  function lowerBound(t) {
    let lo = 0, hi = vocab.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (vocab[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const EMPTY = () => ({ids: new Int32Array(0), scores: new Float32Array(0)});

  function query(q) {
    const toks = tokenize(q, false);
    if (!toks.length) return EMPTY();
    build();
    const g = MX.g, N = g.N;
    const score = new Float64Array(N), hits = new Uint8Array(N);
    const tf = new Float64Array(N);
    for (const t of toks) {
      const touched = [];
      const add = (j, kw) => {
        const p = post[j];
        for (let a = 0; a < p.docs.length; a++) {
          const d = p.docs[a];
          if (tf[d] === 0) touched.push(d);
          tf[d] += kw * p.wtf[a];
        }
      };
      for (let j = lowerBound(t); j < vocab.length && vocab[j].startsWith(t); j++)
        add(j, vocab[j] === t ? KIND.exact : KIND.prefix);
      if (t.length >= 3)
        for (let j = 0; j < vocab.length; j++) {
          const d = vocab[j];
          if (d.includes(t) && !d.startsWith(t)) add(j, KIND.infix);
        }
      const df = touched.length;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const d of touched) {
        const x = tf[d];
        score[d] += idf * x * (K1 + 1) / (x + K1 * (1 - B + B * dlen[d] / avglen));
        hits[d]++;
        tf[d] = 0;
      }
    }
    const need = toks.length, ql = q.trim().toLowerCase(), ids = [];
    for (let i = 0; i < N; i++) {
      if (hits[i] !== need) continue;
      let s = score[i] * (1 + 0.1 * Math.log(1 + g.deg[i]));
      if (g.label[i].toLowerCase() === ql) s *= 2;
      const m = g.meta.get(i);
      if (m && m.tier === "RETRACTED") s *= 0.6;
      score[i] = s; ids.push(i);
    }
    ids.sort((a, b) => score[b] - score[a] || g.deg[b] - g.deg[a] || a - b);
    return {ids: Int32Array.from(ids), scores: Float32Array.from(ids, i => score[i])};
  }

  MX.search = {ready: false, build, query, tokenize};
})();
