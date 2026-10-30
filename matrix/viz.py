"""Render the knowledge graph to a single self-contained HTML file.

No CDN, no build step, no dependencies: the graph data is embedded in the page
and the universe layout and WebGL renderer (Canvas2D fallback) are plain JavaScript. Open
`out/graph.html` in any browser, online or not. Keyboard: Tab into the graph, arrows/Enter/Backspace drill
cluster > galaxy > system > body, `?` lists every key; `#selftest=1` runs the page's self-tests.

    python viz.py            # reads out/graph.json, writes out/graph.html
    python viz.py --config F # out_dir and title from config F (see mxconfig.py)
"""

from __future__ import annotations

import argparse
import html as htmlesc
import json
import os
import sqlite3
import sys
from collections import Counter
from pathlib import Path

import mxconfig

HERE = os.path.dirname(os.path.abspath(__file__))

# The 15 node types fold into three groups plus a muted Other.
#
# A node-link diagram is an all-pairs form: any two nodes can end up adjacent,
# so the documented palette's all-pairs cap of three categorical slots applies.
# Fifteen hues would fail it, and would be unreadable regardless. The exact type
# is never lost -- it is in the inspector, the legend, and the table view.
GROUPS = [
    ("Code", ["function", "class", "file", "module", "notebook"]),
    ("Data", ["table", "view", "procedure", "dataset", "pipeline",
              "linkedservice", "trigger", "dataflow"]),
    ("Knowledge", ["memory", "doc", "concept", "claim", "url"]),
]
GROUP_OF = {t: i for i, (_name, types) in enumerate(GROUPS) for t in types}
OTHER = len(GROUPS)


def load(graph=None, config=None):
    cfg = mxconfig.load(config)
    out_dir = cfg["out_dir"]
    with open(graph or os.path.join(out_dir, "graph.json"), encoding="utf-8") as fh:
        return out_dir, cfg, json.load(fh)


def build_payload(data, cfg=None):
    nodes, edges = data["nodes"], data["edges"]
    index = {n["id"]: i for i, n in enumerate(nodes)}

    types = sorted({n["type"] for n in nodes})
    type_idx = {t: i for i, t in enumerate(types)}
    comms = sorted({n["community"] for n in nodes if n.get("community")})
    comm_idx = {c: i for i, c in enumerate(comms)}
    rels = sorted({e["rel"] for e in edges})
    rel_idx = {r: i for i, r in enumerate(rels)}
    provs = ["EXTRACTED", "INFERRED", "AMBIGUOUS"]
    prov_idx = {p: i for i, p in enumerate(provs)}

    packed_nodes = [[
        n["label"],
        type_idx[n["type"]],
        n.get("degree", 0),
        comm_idx.get(n.get("community"), -1),
        n.get("file") or "",
        n.get("line") or 0,
        n.get("group", GROUP_OF.get(n["type"], OTHER)),   # combine.py sets group per universe
        n["id"],
    ] for n in nodes]

    meta = []
    for i, n in enumerate(nodes):
        m = {k: n[k] for k in ("tier", "statement") if n.get(k)}
        if n["type"] in ("memory", "doc") and n.get("body"):
            m["body"] = n["body"][:280]
        m.update({k: 1 for k in ("partial", "unresolved", "external") if n.get(k)})
        if m:
            meta.append([i, m])

    packed_edges = [[
        index[e["src"]], index[e["dst"]],
        rel_idx[e["rel"]], prov_idx.get(e["provenance"], 0), e.get("weight", 1),
    ] for e in edges if e["src"] in index and e["dst"] in index]

    return {
        "version": 2,
        "generated": data.get("generated", ""),
        "types": types,
        "communities": comms,
        "rels": rels,
        "provs": provs,
        "groups": [g[0] for g in GROUPS] + ["Other"],
        "groupTypes": [g[1] for g in GROUPS],
        "roots": {r["label"]: r["path"] for r in (cfg or {}).get("roots", [])},
        "nodes": packed_nodes,
        "meta": meta,
        "edges": packed_edges,
    }


SUN_MIN_DEG = 2   # a sun needs at least this many distinct neighbours


def build_universe(data):
    """payload.universe: the cluster / galaxy / system hierarchy. Indices = payload order.

    deg = distinct neighbours. Per galaxy (cluster, type): suns = independent set
    over members by (-deg, id) with deg >= SUN_MIN_DEG. Each non-sun binds to the
    galaxy sun minimising (-direct edges, -shared neighbours, -deg, id) among suns
    with deg >= its own; none -> dust. Planetless suns are demoted, then re-bound
    once by the same rule against the surviving suns (2-hop fallback). Systems are
    ordered by (cluster, type, -deg(sun), id(sun)).
    """
    nodes = data["nodes"]
    n = len(nodes)
    index = {x["id"]: i for i, x in enumerate(nodes)}
    ids = [x["id"] for x in nodes]
    adj = [Counter() for _ in range(n)]
    for e in data["edges"]:
        a, b = index.get(e["src"]), index.get(e["dst"])
        if a is None or b is None or a == b:
            continue
        adj[a][b] += 1
        adj[b][a] += 1
    deg = [len(x) for x in adj]
    cl = [x.get("group", GROUP_OF.get(x["type"], OTHER)) for x in nodes]
    gal = {}
    for i, x in enumerate(nodes):
        gal.setdefault((cl[i], x["type"]), []).append(i)

    def bind(i, sunset, by_nbr):
        direct = {s: c for s, c in adj[i].items() if s in sunset}
        shared = Counter(s for nb in adj[i] for s in by_nbr.get(nb, ()))
        cands = [s for s in set(direct) | set(shared) if deg[s] >= deg[i]]
        return min(cands, key=lambda s: (-direct.get(s, 0), -shared[s], -deg[s], ids[s]),
                   default=None)

    def nbr_index(suns):
        by_nbr = {}
        for s in suns:
            for nb in adj[s]:
                by_nbr.setdefault(nb, []).append(s)
        return by_nbr

    owner = [None] * n
    members = {}
    for key in sorted(gal):
        mem = sorted(gal[key], key=lambda i: (-deg[i], ids[i]))
        suns = []
        for i in mem:
            if deg[i] < SUN_MIN_DEG:
                break
            if not any(s in adj[i] for s in suns):
                suns.append(i)
        sunset = set(suns)
        for s in suns:
            owner[s], members[s] = s, 1
        by_nbr = nbr_index(suns)
        for i in mem:
            if i not in sunset:
                s = owner[i] = bind(i, sunset, by_nbr)
                if s is not None:
                    members[s] += 1
        lone = [s for s in suns if members[s] == 1]
        for s in lone:
            del members[s]
            owner[s] = None
        alive = [s for s in suns if s in members]
        aset, by_nbr = set(alive), nbr_index(alive)
        for i in lone:
            s = owner[i] = bind(i, aset, by_nbr)
            if s is not None:
                members[s] += 1
    order = sorted(members, key=lambda s: (cl[s], nodes[s]["type"], -deg[s], ids[s]))
    sidx = {s: k for k, s in enumerate(order)}
    return {"v": 1, "minDeg": SUN_MIN_DEG,
            "clusters": [g[0] for g in GROUPS] + ["Other"],
            "sys": [-1 if s is None else sidx[s] for s in owner],
            "sun": order}


def build_stats(data, cfg, out_dir):
    """Facts the page cannot compute itself (for the dashboard)."""
    st = data.get("stats")
    build = {k: st[k] for k in ("generated", "files_scanned", "files_parsed",
                                "files_cached") if k in st} if st else None
    sizes = {f: os.path.getsize(os.path.join(out_dir, f))
             for f in ("graph.json", "search.db", "cache.json")
             if os.path.isfile(os.path.join(out_dir, f))}
    sdb = None
    db = os.path.join(out_dir, "search.db")
    if os.path.isfile(db):
        try:
            con = sqlite3.connect(Path(db).resolve().as_uri() + "?mode=ro", uri=True)
            try:
                docs = con.execute("select count(*) from docs").fetchone()[0]
                meta = dict(con.execute("select key, value from meta").fetchall())
            finally:
                con.close()
            gm = float(meta.get("graph_mtime", 0))
            gp = os.path.join(out_dir, "graph.json")
            sdb = {"docs": docs, "built": float(meta.get("built", 0)), "graph_mtime": gm,
                   "fresh": os.path.isfile(gp) and abs(gm - os.path.getmtime(gp)) <= 1.0}
        except (sqlite3.Error, ValueError):
            sdb = None
    return {"v": 1, "build": build, "out": sizes, "searchDb": sdb}


VIZ = os.path.join(HERE, "viz")
JS_FILES = ["state.js", "theme.js", "search.js", "layout.js", "gl.js", "universe.js",
            "scene.js", "nebula.js", "labels.js", "render.js", "filter.js", "inspector.js", "ui.js", "dash.js", "charts.js",
            "tables.js", "cosmos.js", "minimap.js", "hairline.js", "multiverse.js"]
CSS_FILES = ["app.css", "dash.css", "cosmos.css"]
STUBS = {"universe.js": '(function () {\n  "use strict";\n'
                        '  // MX.universe: placeholder, universe.js is missing.\n})();\n',
         **{n + ".js": '(function () {\n  "use strict";\n  window.MX.module("' + n + '", () => {});\n})();\n'
            for n in ("scene", "nebula", "labels")}}


def ensure_stubs():
    """Create missing optional viz files as valid no-ops; never overwrite."""
    for name, body in STUBS.items():
        path = os.path.join(VIZ, name)
        if not os.path.exists(path):
            with open(path, "x", encoding="utf-8", newline="\n") as fh:
                fh.write(body)


def read(name):
    with open(os.path.join(VIZ, name), encoding="utf-8", newline="") as fh:
        return fh.read()


def mark(name):
    return f"/* == viz/{name} == */\n" + read(name)


def scopes_script(out_dir):
    """`<script id="mx-scopes">window.MX_SCOPES = ...</script>` (multiverse
    contract): the registry without configs, current = the scope whose out is
    out_dir. serve.py swaps this block for a fresh one. Never fails."""
    try:
        import scopes
        cur = scopes.scope_for_out(out_dir)
        js = scopes.script_json(scopes.embed(cur["id"] if cur else None))
    except Exception:  # an unreadable registry must not fail the render
        js = '{"current":null,"scopes":[]}'
    return f'<script id="mx-scopes">window.MX_SCOPES = {js};</script>\n'


def assemble(blob, title="Matrix", pre_js=""):
    """Inline viz/* into template.html. Placeholders are replaced once, in
    order TITLE, CSS, JS, PAYLOAD, so payload text can never be re-scanned.
    pre_js (a whole <script> element) goes right before the app script."""
    html = read("template.html").replace("__MATRIX_TITLE__", htmlesc.escape(title))
    for ph in ("/*__CSS__*/", "//__JS__", "__PAYLOAD__"):
        assert html.count(ph) == 1, ph
    if pre_js:
        at = html.rfind("<script", 0, html.index("//__JS__"))
        html = html[:at] + pre_js + html[at:]
    ensure_stubs()
    css = "".join(mark(f) for f in CSS_FILES)
    js = "".join(mark(f) for f in JS_FILES)
    for src in (css, js):
        assert not any(t in src.lower() for t in ("__payload__", "</script", "</style", "<!--")), "bad source"
    html = html.replace("/*__CSS__*/", css, 1).replace("//__JS__", js, 1)
    return html.replace("__PAYLOAD__", blob, 1)



def page_html(payload, title="Matrix", pre_js=""):
    """The whole page for a payload (universe budget warned, payload escaped)."""
    usize = len(json.dumps(payload["universe"], separators=(",", ":")))
    if usize > 120_000:   # universe hierarchy budget
        print(f"warning: payload.universe is {usize} bytes (> 120,000 B)", file=sys.stderr)
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    blob = blob.replace("<", "\\u003c").replace("\u2028", "\\u2028") \
               .replace("\u2029", "\\u2029")
    return assemble(blob, title, pre_js)


def main(argv=()):
    ap = argparse.ArgumentParser(description="Render graph.html from graph.json.")
    ap.add_argument("--config", help="config file (default: <install>/config.json)")
    ap.add_argument("--graph")
    ap.add_argument("--out")
    args = ap.parse_args(argv)
    out_dir, cfg, data = load(args.graph, args.config)
    payload = build_payload(data, cfg)
    payload["stats"] = build_stats(data, cfg, out_dir)
    payload["universe"] = build_universe(data)
    html = page_html(payload, cfg["title"], scopes_script(out_dir))
    path = args.out or os.path.join(out_dir, "graph.html")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(html)
    size = len(html.encode("utf-8"))
    if size > 3_800_000:   # large-graph warning threshold
        print(f"warning: graph.html is {size} bytes (> 3.8 MB)", file=sys.stderr)
    print(f"wrote {path}  ({len(html) / 1024:.0f} KB, "
          f"{len(payload['nodes'])} nodes, {len(payload['edges'])} edges)")


if __name__ == "__main__":
    main(sys.argv[1:])
