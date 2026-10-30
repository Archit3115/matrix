"""Compact orientation printed into context at the start of every session.

Deliberately small. This runs on every session start, so it costs context
every time -- it gives the shape of the Matrix graph and how to query it,
never the contents. Anything more specific is one `query.py` call away.

    python session_brief.py [--config F]

Never fails a session start: any problem is reported as a one-line note.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone

import mxconfig

HERE = os.path.dirname(os.path.abspath(__file__))
TOP_COMMUNITIES = 8


def main(argv=None):
    ap = argparse.ArgumentParser(description="Matrix session-start brief.")
    ap.add_argument("--config", help="config file (default: <install>/config.json)")
    args = ap.parse_args(argv)

    def cmd(script, *extra):
        conf = ["--config", os.path.abspath(args.config)] if args.config else []
        return subprocess.list2cmdline(
            [sys.executable, os.path.join(HERE, script), *conf, *extra])

    try:
        cfg = mxconfig.load(args.config)
        out_dir = cfg["out_dir"]
        with open(os.path.join(out_dir, "graph.json"), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError, KeyError) as exc:
        print("Matrix knowledge graph: unavailable "
              f"({type(exc).__name__}). Rebuild with: " + cmd("indexer.py", "--full"))
        return

    nodes, edges = data["nodes"], data["edges"]
    age = ""
    try:
        stamp = datetime.strptime(data["generated"], "%Y-%m-%d %H:%M UTC").replace(
            tzinfo=timezone.utc)
        hours = (datetime.now(timezone.utc) - stamp).total_seconds() / 3600
        age = "just now" if hours < 1 else (
            f"{hours:.0f}h ago" if hours < 48 else f"{hours / 24:.0f}d ago")
    except (ValueError, KeyError):
        age = data.get("generated", "unknown")

    comms = Counter(n["community"] for n in nodes if n.get("community"))
    memory = [n for n in nodes if n["type"] == "memory"]
    prov = Counter(e["provenance"] for e in edges)

    print("## Matrix knowledge graph")
    print()
    print(f"{len(nodes)} nodes, {len(edges)} edges, {len(comms)} communities. "
          f"Built {age}.")
    print(f"Edges: {prov['EXTRACTED']} extracted, {prov['INFERRED']} inferred, "
          f"{prov['AMBIGUOUS']} ambiguous.")
    print()
    print("Largest areas: " + ", ".join(
        f"{name} ({count})" for name, count in comms.most_common(TOP_COMMUNITIES)))
    print()
    if memory:
        print(f"{len(memory)} memory notes are indexed as graph nodes, linked to the "
              "code and tables they describe.")
        print()
    print("**Query this before reading source files.** Use the `matrix` skill, or:")
    print()
    print("```")
    print(cmd("query.py") + " find|explain|path|neighbors|stats")
    print("```")
    print()
    print(f"Overview: `{os.path.normpath(os.path.join(out_dir, 'INDEX.md'))}` and "
          "`GRAPH_REPORT.md` beside it. "
          "Cite edge provenance (extracted vs inferred) when you rely on it.")


if __name__ == "__main__":
    main()
