"""Query the Matrix knowledge graph without opening the source files.

    python query.py find "auth token"             # ranked text search (--json)
    python query.py explain UserService           # a node and everything it touches
    python query.py path OrderController Database # how two things connect
    python query.py neighbors UserService -d 2    # local subgraph
    python query.py stats                         # graph shape and provenance
    python query.py --config F stats              # another config (see mxconfig.py)

Node names are matched loosely: exact id, then exact label, then substring.
Every relationship printed carries its provenance tag, so an inferred link is
never mistaken for one the source actually states.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict, deque

import mxconfig

GRAPH_PATH = None


def load(config=None):
    global GRAPH_PATH
    out_dir = mxconfig.load(config)["out_dir"]
    path = GRAPH_PATH = os.path.join(out_dir, "graph.json")
    if not os.path.exists(path):
        sys.exit(f"no graph at {path} - run: python indexer.py")
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    nodes = {n["id"]: n for n in data["nodes"]}
    return data, nodes, data["edges"]


def resolve_node(nodes, needle):
    """Loosest match that is still unambiguous, else a disambiguation list."""
    if needle in nodes:
        return needle, []
    low = needle.lower()
    exact = [n for n, d in nodes.items() if d["label"].lower() == low]
    if len(exact) == 1:
        return exact[0], []
    if exact:
        return None, exact
    partial = [n for n, d in nodes.items() if low in d["label"].lower()]
    if len(partial) == 1:
        return partial[0], []
    return None, sorted(partial, key=lambda n: -nodes[n].get("degree", 0))[:15]


def describe(nodes, nid):
    node = nodes[nid]
    loc = ""
    if node.get("file"):
        loc = f"  [{node['file']}" + (f":{node['line']}" if node.get("line") else "") + "]"
    return f"{node['label']} ({node['type']}){loc}"


def cmd_find(args, nodes, edges):
    """Ranked FTS5 search (search.py) over labels, identifiers split into
    words, claim statements, memory/doc/concept text and file paths.
    Community names are display-only: half the graph shares one."""
    import search
    conn = search.open_ro(os.path.join(os.path.dirname(GRAPH_PATH), "search.db"),
                          GRAPH_PATH)
    if conn is None:
        print("(search.db stale; built in memory)", file=sys.stderr)
        conn = search.build_db(args._data["nodes"], edges, ":memory:", 0)
    hits = search.search(conn, args.text, args.limit)
    conn.close()
    if args.json:
        print(json.dumps(hits, ensure_ascii=False, indent=1))
        return
    if not hits:
        print(f"nothing matches {args.text!r}")
        return
    print(f"{len(hits)} best match(es) for {args.text!r}\n")
    for h in hits:
        loc = ""
        if h["file"]:
            loc = f"  [{h['file']}" + (f":{h['line']}" if h["line"] else "") + "]"
        comm = (nodes.get(h["id"]) or {}).get("community")
        comm = f"  ~ {comm}" if comm else ""
        print(f"  {h['label']} ({h['type']}){loc}   deg={h['degree']}{comm}")
        if h["snippet"] or h["tier"]:
            tier = f"{h['tier']}  " if h["tier"] else ""
            print(f"      {tier}{h['snippet']}")


def cmd_explain(args, nodes, edges):
    nid, cands = resolve_node(nodes, args.node)
    if nid is None:
        return ambiguous(nodes, args.node, cands)
    node = nodes[nid]
    print(f"# {node['label']}")
    print(f"\ntype: {node['type']}   degree: {node.get('degree', 0)}")
    if node.get("file"):
        print(f"file: {node['file']}" + (f":{node['line']}" if node.get("line") else ""))
    if node.get("community"):
        print(f"community: {node['community']}")
    if node.get("external"):
        print("note: referenced but never defined in this corpus")
    if node.get("partial"):
        print("note: recovered by fallback parse (file is not valid Python)")

    out_e = [e for e in edges if e["src"] == nid]
    in_e = [e for e in edges if e["dst"] == nid]
    for title, group, other in (("outgoing", out_e, "dst"), ("incoming", in_e, "src")):
        if not group:
            continue
        print(f"\n## {title} ({len(group)})")
        by_rel = defaultdict(list)
        for e in group:
            by_rel[e["rel"]].append(e)
        for rel in sorted(by_rel):
            print(f"\n  {rel}")
            for e in sorted(by_rel[rel], key=lambda e: e[other])[:args.limit]:
                peer = nodes.get(e[other])
                if peer:
                    print(f"    - {describe(nodes, e[other])}  <{e['provenance'].lower()}>")
            if len(by_rel[rel]) > args.limit:
                print(f"    ... {len(by_rel[rel]) - args.limit} more")


def cmd_path(args, nodes, edges):
    a, ca = resolve_node(nodes, args.source)
    if a is None:
        return ambiguous(nodes, args.source, ca)
    b, cb = resolve_node(nodes, args.target)
    if b is None:
        return ambiguous(nodes, args.target, cb)

    adj = defaultdict(set)
    label = {}
    for e in edges:
        adj[e["src"]].add(e["dst"])
        adj[e["dst"]].add(e["src"])
        label[(e["src"], e["dst"])] = (e["rel"], e["provenance"])

    seen, q = {a: None}, deque([a])
    while q:
        cur = q.popleft()
        if cur == b:
            break
        for nxt in sorted(adj.get(cur, ())):
            if nxt not in seen:
                seen[nxt] = cur
                q.append(nxt)
    if b not in seen:
        print(f"no path between {nodes[a]['label']} and {nodes[b]['label']}")
        return

    chain = []
    cur = b
    while cur is not None:
        chain.append(cur)
        cur = seen[cur]
    chain.reverse()

    print(f"{len(chain) - 1} hops\n")
    for i, nid in enumerate(chain):
        print(f"  {describe(nodes, nid)}")
        if i + 1 < len(chain):
            fwd = label.get((nid, chain[i + 1]))
            rev = label.get((chain[i + 1], nid))
            rel, prov = fwd if fwd else (rev[0] + " (reverse)", rev[1])
            print(f"      |  {rel.lower()}  <{prov.lower()}>")


def cmd_neighbors(args, nodes, edges):
    nid, cands = resolve_node(nodes, args.node)
    if nid is None:
        return ambiguous(nodes, args.node, cands)
    adj = defaultdict(set)
    for e in edges:
        adj[e["src"]].add(e["dst"])
        adj[e["dst"]].add(e["src"])
    seen = {nid: 0}
    q = deque([nid])
    while q:
        cur = q.popleft()
        if seen[cur] >= args.depth:
            continue
        for nxt in sorted(adj.get(cur, ())):
            if nxt not in seen:
                seen[nxt] = seen[cur] + 1
                q.append(nxt)
    print(f"{len(seen) - 1} nodes within {args.depth} hop(s) of "
          f"{nodes[nid]['label']}\n")
    by_depth = defaultdict(list)
    for n, d in seen.items():
        if d:
            by_depth[d].append(n)
    for d in sorted(by_depth):
        print(f"  depth {d}:")
        for n in sorted(by_depth[d], key=lambda n: -nodes[n].get("degree", 0))[:args.limit]:
            print(f"    - {describe(nodes, n)}")
        if len(by_depth[d]) > args.limit:
            print(f"    ... {len(by_depth[d]) - args.limit} more")


def cmd_stats(args, nodes, edges):
    data = args._data
    print(f"generated: {data['generated']}")
    print(f"nodes: {len(nodes)}   edges: {len(edges)}\n")
    for title, counter in (
        ("node types", Counter(n["type"] for n in nodes.values())),
        ("relations", Counter(e["rel"] for e in edges)),
        ("provenance", Counter(e["provenance"] for e in edges)),
    ):
        print(f"  {title}")
        for k, c in counter.most_common():
            print(f"    {k:<16} {c}")
        print()


def ambiguous(nodes, needle, cands):
    if not cands:
        print(f"no node matches {needle!r}")
        return
    print(f"{needle!r} is ambiguous - {len(cands)} candidates:\n")
    for c in cands:
        print(f"  {describe(nodes, c)}")


def main():
    # cp1252 consoles cannot encode labels like "env ∈ dev"; never crash on one.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    # -l and --config are shared, and accepted on either side of the subcommand.
    common = argparse.ArgumentParser(add_help=False)
    # SUPPRESS: a subcommand must not reset a -l / --config given before it.
    common.add_argument("-l", "--limit", type=int, default=argparse.SUPPRESS)
    common.add_argument("--config", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    ap.add_argument("-l", "--limit", type=int, default=20)
    ap.add_argument("--config", help="config file (default: <install>/config.json)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("find", parents=[common], help="nodes matching a phrase")
    p.add_argument("text")
    p.add_argument("--json", action="store_true", help="machine-readable hits")
    p.set_defaults(fn=cmd_find)

    p = sub.add_parser("explain", parents=[common],
                       help="a node and everything it touches")
    p.add_argument("node")
    p.set_defaults(fn=cmd_explain)

    p = sub.add_parser("path", parents=[common], help="how two nodes connect")
    p.add_argument("source")
    p.add_argument("target")
    p.set_defaults(fn=cmd_path)

    p = sub.add_parser("neighbors", parents=[common], help="local subgraph")
    p.add_argument("node")
    p.add_argument("-d", "--depth", type=int, default=1)
    p.set_defaults(fn=cmd_neighbors)

    p = sub.add_parser("stats", parents=[common],
                       help="graph shape and provenance")
    p.set_defaults(fn=cmd_stats)

    args = ap.parse_args()
    data, nodes, edges = load(args.config)
    args._data = data
    args.fn(args, nodes, edges)


if __name__ == "__main__":
    main()
