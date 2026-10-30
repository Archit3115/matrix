"""Full-text search over the knowledge graph (stdlib sqlite3 FTS5).

Shared by indexer.py (build), query.py (find) and any other reader that
puts this folder on sys.path (search.open_ro / search.search / vocab_df).
Nothing runs as a server: indexer.py writes out/search.db next to graph.json,
readers open it read-only and fall back when it is missing or stale.

Two FTS5 tables over the same rows (rowid = position in graph.json nodes):
    w   porter/unicode61 words, bm25 weighted label > alias > body > path > ctx
    t   trigram, so substrings and 3-char codes (api, sku, md5) still match
Their rankings are fused by reciprocal rank (k=60, Cormack et al. 2009) and
then nudged by small priors: all-terms coverage, log degree, claim tier and
node type. Community names are never searched; half the graph shares one.
"""

import math
import os
import re
import sqlite3
import time
from pathlib import Path

SCHEMA = "2"
SEP = re.compile(r"[_./\\-]+")
TIER = {"MEASURED": 1.0, "SOURCE": 1.0, "INFERRED": 0.85, "RETRACTED": 0.6}
TYPE = {"memory": 1.3, "claim": 1.15, "doc": 1.15, "pipeline": 1.1,
        "table": 1.1, "view": 1.1, "procedure": 1.1, "notebook": 1.1,
        "module": 0.9, "function": 0.9, "dataset": 0.85, "file": 0.9,
        "url": 0.8}
BARE_CONCEPT = 0.85       # a heading with no text under it: often a code comment
CTX_MAX_NEIGHBOURS = 60   # hubs get no ctx column, or they match everything
CTX_TAKE = 25


def split_ident(s):
    """OrderLineNo -> Order Line No; order_line.v2 -> order line v2."""
    s = SEP.sub(" ", s or "")
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", s)
    return re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", s)


def _rows(nodes, edges):
    idx = {n["id"]: i for i, n in enumerate(nodes)}
    nbr = [[] for _ in nodes]
    for e in edges:
        a, b = idx.get(e["src"]), idx.get(e["dst"])
        if a is None or b is None or e.get("provenance") == "AMBIGUOUS":
            continue                       # AMBIGUOUS edges are leads, not facts
        nbr[a].append(b)
        nbr[b].append(a)
    for i, n in enumerate(nodes):
        lab = n.get("label") or ""
        body = ((n.get("statement") or "") + " " + (n.get("body") or "")).strip()
        path = split_ident(n.get("file") or "")
        peers = set(nbr[i])
        ctx = ""
        if len(peers) <= CTX_MAX_NEIGHBOURS:
            near = sorted(peers, key=lambda j: (nodes[j].get("degree", 0), j))
            ctx = " ".join(split_ident(nodes[j].get("label") or "")
                           for j in near[:CTX_TAKE])
        alias = split_ident(lab)
        texts = f"{alias} {lab} {body} {path}".lower()
        typ = n.get("type")
        prior = ((1 + 0.05 * math.log1p(n.get("degree") or 0))
                 * TIER.get(n.get("tier"), 1.0) * TYPE.get(typ, 1.0)
                 * (BARE_CONCEPT if typ == "concept" and not n.get("body") else 1.0))
        yield i, n, lab, alias, body, path, ctx, texts, prior


def build_db(nodes, edges, path, graph_mtime):
    """Build the index. ':memory:' returns the open connection; a file path is
    written to path+'.tmp' and swapped in atomically (returns None)."""
    mem = path == ":memory:"
    tmp = path if mem else path + ".tmp"
    if not mem and os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript("""
        CREATE VIRTUAL TABLE w USING fts5(label, alias, body, path, ctx,
            tokenize='porter unicode61 remove_diacritics 2', prefix='2 3');
        CREATE VIRTUAL TABLE t USING fts5(label, body, tokenize='trigram');
        CREATE VIRTUAL TABLE w_v USING fts5vocab(w, row);
        CREATE TABLE docs(rowid INTEGER PRIMARY KEY, id TEXT UNIQUE, label TEXT,
            type TEXT, degree INTEGER, tier TEXT, file TEXT, line INTEGER,
            community TEXT, texts TEXT, prior REAL);
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    """)
    w, t, d = [], [], []
    for i, n, lab, alias, body, pth, ctx, texts, prior in _rows(nodes, edges):
        w.append((i, lab, alias, body, pth, ctx))
        t.append((i, lab, body))
        d.append((i, n["id"], lab, n.get("type"), n.get("degree", 0),
                  n.get("tier"), n.get("file"), n.get("line"),
                  n.get("community"), texts, prior))
    db.executemany("INSERT INTO w(rowid,label,alias,body,path,ctx) VALUES (?,?,?,?,?,?)", w)
    db.executemany("INSERT INTO t(rowid,label,body) VALUES (?,?,?)", t)
    db.executemany("INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?,?,?)", d)
    db.executemany("INSERT INTO meta VALUES (?,?)", [
        ("schema", SCHEMA), ("graph_mtime", repr(float(graph_mtime))),
        ("built", repr(time.time()))])
    db.execute("INSERT INTO w(w) VALUES ('optimize')")
    db.execute("INSERT INTO t(t) VALUES ('optimize')")
    db.commit()
    if mem:
        return db
    db.execute("VACUUM")
    db.close()
    # Windows refuses the swap while a reader (e.g. query.py) holds the old
    # file open. Retry briefly; failing that keep the old db - readers see it
    # as stale by its graph_mtime stamp and fall back on their own.
    for attempt in range(3):
        try:
            os.replace(tmp, path)
            return None
        except OSError as exc:
            err = exc
            time.sleep(0.2)
    try:
        os.remove(tmp)
    except OSError:
        pass
    os.write(2, f"  (search.db not replaced, old copy kept: {err})\n".encode())
    return None


def open_ro(db_path, graph_path):
    """Read-only connection, or None if the db is missing, stale or unreadable."""
    if not os.path.exists(db_path):
        return None
    conn = None
    try:
        conn = sqlite3.connect(Path(os.path.abspath(db_path)).as_uri() + "?mode=ro",
                               uri=True)
        meta = dict(conn.execute("SELECT key, value FROM meta"))
        if meta.get("schema") != SCHEMA:
            raise sqlite3.Error("schema")
        if abs(float(meta["graph_mtime"]) - os.path.getmtime(graph_path)) > 1.0:
            raise sqlite3.Error("stale")
        return conn
    except (sqlite3.Error, OSError, KeyError, ValueError):
        if conn is not None:
            conn.close()
        return None


def vocab_df(conn, term):
    """Number of rows whose word index holds `term` (porter-stemmed form)."""
    row = conn.execute("SELECT doc FROM w_v WHERE term = ?", (term,)).fetchone()
    return row[0] if row else 0


def _quote(term):
    return '"' + term.replace('"', '""') + '"'


def search(conn, text, k=20):
    """Ranked nodes for free text. Never interprets user text as FTS syntax."""
    terms = [x for x in re.split(r"\W+", split_ident(text).lower()) if x]
    raw = [x for x in re.split(r"\W+", (text or "").lower()) if x]
    if not terms:
        return []
    word = " OR ".join(_quote(x) + "*" for x in dict.fromkeys(terms))
    tri = " OR ".join(_quote(x) for x in dict.fromkeys(raw) if len(x) >= 3)
    lists = [conn.execute(
        "SELECT rowid FROM w WHERE w MATCH ? "
        "ORDER BY bm25(w, 10.0, 6.0, 3.0, 1.5, 0.7) LIMIT 300", (word,)).fetchall()]
    if tri:
        lists.append(conn.execute(
            "SELECT rowid FROM t WHERE t MATCH ? "
            "ORDER BY bm25(t, 5.0, 1.0) LIMIT 300", (tri,)).fetchall())
    fused = {}
    for ranked in lists:
        for r, (rid,) in enumerate(ranked):
            fused[rid] = fused.get(rid, 0.0) + 1.0 / (60 + r + 1)
    if not fused:
        return []

    want = set(raw) | set(terms)
    docs = {}
    ids = list(fused)
    for s in range(0, len(ids), 900):
        chunk = ids[s:s + 900]
        for row in conn.execute(
                "SELECT rowid, id, label, type, degree, tier, file, line, texts, prior "
                "FROM docs WHERE rowid IN (%s)" % ",".join("?" * len(chunk)), chunk):
            docs[row[0]] = row
    scored = []
    for rid, s in fused.items():
        texts, prior = docs[rid][8], docs[rid][9]
        cov = sum(1 for x in want if x[:5] in texts) / len(want)
        s *= (0.4 + 0.6 * cov * cov) * prior       # reward matching every term
        scored.append((-s, rid))
    scored.sort()

    out, seen = [], set()
    for neg, rid in scored:
        _, nid, lab, typ, deg, tier, f, line = docs[rid][:8]
        key = ((lab or "").lower(), typ)
        if key in seen:
            continue
        seen.add(key)
        out.append({"id": nid, "label": lab, "type": typ, "tier": tier,
                    "file": f, "line": line, "degree": deg or 0,
                    "score": round(-neg, 6), "snippet": "", "_rid": rid})
        if len(out) >= k:
            break
    if out:
        rids = [r["_rid"] for r in out]
        snip = dict(conn.execute(
            "SELECT rowid, snippet(w, 2, '[', ']', '…', 12) FROM w "
            "WHERE w MATCH ? AND rowid IN (%s)" % ",".join("?" * len(rids)),
            [word] + rids))
        for r in out:
            r["snippet"] = snip.get(r.pop("_rid")) or ""
    return out
