"""Combine two or more universes into one page.

Each universe becomes a top-level cluster of its own. Nodes that carry the
same name in two universes (a module, class, function, table, view, dataset,
pipeline or URL) are joined by a SHARED edge, tagged INFERRED. The number of
names each pair of universes shares is the page's measure of relatedness: it
seats related universes together and unrelated ones apart.

    python combine.py <id> <id> [...] [--out F]   # write the combined page to F
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import mxconfig
import scopes
import viz
from indexer import COMMON_CALLS, STOPWORDS

LINK_TYPES = {"module", "class", "function", "table", "view", "procedure",
              "dataset", "pipeline", "url"}
MAX_BYTES = 300_000_000   # total graph.json size a combine will load


def shared_key(n):
    """(type, lowercased label) for a name worth linking across universes, else None."""
    label = n["label"]
    if n["type"] not in LINK_TYPES or len(label) < 5 or label.startswith("_"):
        return None       # private helpers and dunders say nothing about relatedness
    low = label.lower()
    if low in STOPWORDS or label in COMMON_CALLS or low in COMMON_CALLS:
        return None
    if n["type"] == "module" and low.split(".")[0] in sys.stdlib_module_names:
        return None       # every Python project imports the standard library
    return n["type"], low


def merge(universes):
    """[(name, graph.json dict)] -> (merged graph dict, cluster names, link matrix).

    Ids, types and communities are namespaced per universe, so nothing from two
    universes is ever merged into one node; they are only linked."""
    names, seen = [], set()
    for name, _ in universes:              # cluster names must be unique (the page keys on them)
        nm, k = name, 2
        while nm in seen:
            nm, k = f"{name} ({k})", k + 1
        seen.add(nm)
        names.append(nm)
    nodes, edges, keys = [], [], []
    for u, ((_, data), name) in enumerate(zip(universes, names)):
        best = {}
        for n in data["nodes"]:
            m = dict(n, id=f"{u}|{n['id']}", type=f"{n['type']} · {name}", group=u)
            if n.get("community"):
                m["community"] = f"{name}: {n['community']}"
            nodes.append(m)
            k = shared_key(n)
            if k and (k not in best or m.get("degree", 0) > best[k].get("degree", 0)):
                best[k] = m
        edges += [dict(e, src=f"{u}|{e['src']}", dst=f"{u}|{e['dst']}") for e in data["edges"]]
        keys.append(best)
    link = [[0] * len(names) for _ in names]   # shared-name counts
    for a in range(len(names)):
        for b in range(a + 1, len(names)):
            common = sorted(keys[a].keys() & keys[b].keys())
            for k in common:
                na, nb = keys[a][k], keys[b][k]
                edges.append({"src": na["id"], "dst": nb["id"], "rel": "SHARED",
                              "provenance": "INFERRED", "weight": 1})
                na["degree"] = na.get("degree", 0) + 1
                nb["degree"] = nb.get("degree", 0) + 1
            link[a][b] = link[b][a] = len(common)
    generated = max((d.get("generated", "") for _, d in universes), default="")
    return {"generated": generated, "nodes": nodes, "edges": edges}, names, link


def render(universes, roots=None, pre_js=""):
    """The combined page for [(name, graph.json dict)]."""
    data, names, link = merge(universes)
    payload = viz.build_payload(data, {"roots": roots or []})
    payload["groups"] = names
    payload["groupTypes"] = [sorted({n["type"] for n in data["nodes"] if n["group"] == u})
                             for u in range(len(names))]
    payload["stats"] = {"v": 1, "build": None, "out": {}, "searchDb": None}
    payload["universe"] = dict(viz.build_universe(data), clusters=names, link=link)
    return viz.page_html(payload, " + ".join(names), pre_js)


def load(ss):
    """Registry scopes -> ([(name, graph.json dict)], roots). ValueError when one
    is not built or the graphs are too big to combine."""
    paths = [os.path.join(scopes.out_of(s), "graph.json") for s in ss]
    missing = [s["name"] for s, p in zip(ss, paths) if not os.path.isfile(p)]
    if missing:
        raise ValueError("not built yet: " + ", ".join(missing))
    total = sum(os.path.getsize(p) for p in paths)
    if total > MAX_BYTES:
        raise ValueError(f"these graphs hold {total / 1e6:,.0f} MB; a combine loads at most "
                         f"{MAX_BYTES / 1e6:,.0f} MB")
    universes, roots = [], []
    for s, p in zip(ss, paths):
        with open(p, encoding="utf-8") as fh:
            universes.append((s["name"], json.load(fh)))
        try:
            roots += mxconfig.load(s.get("config"))["roots"]
        except Exception:   # roots only make file links absolute; never fail the page
            pass
    return universes, roots


def main(argv=None):
    ap = argparse.ArgumentParser(description="Combine universes into one page.")
    ap.add_argument("ids", nargs="+", help="two or more universe ids (see scopes.py list)")
    ap.add_argument("--out", default="combined.html")
    args = ap.parse_args(argv)
    ids = list(dict.fromkeys(args.ids))
    if len(ids) < 2:
        ap.error("give two or more different universe ids")
    ss = [scopes.get(i) for i in ids]
    unknown = [i for i, s in zip(ids, ss) if s is None]
    if unknown:
        ap.error("unknown universe id(s): " + ", ".join(unknown))
    try:
        universes, roots = load(ss)
    except ValueError as exc:
        print(f"combine: {exc}", file=sys.stderr)
        return 2
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(render(universes, roots))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
