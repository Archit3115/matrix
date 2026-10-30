"""End-to-end smoke test: install Matrix into a throwaway folder and query it.

    python tests/smoke.py [--keep]

Stdlib only, any Python 3.10+, any OS. Everything happens under one temp
folder: a small sample corpus (Python, SQL, Markdown with cross references),
a sandboxed MATRIX_HOME and a sandboxed HOME / USERPROFILE, so the real
user's registry, launcher folder and Claude Code settings are never touched.

Checks: setup.py installs and builds; graph.json has nodes and edges;
graph.html exists and loads nothing from the network; query.py find / stats
work; scopes.py list shows the new universe; the Python source imports only
the standard library. Exits non-zero on the first failure.

tests/selftest.py reuses make_corpus() and install() from this file.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
from html.parser import HTMLParser

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "matrix")

# The page self-test searches for "Sales" and needs at least two hits, so the
# corpus keeps several sales-named nodes. Its camera tests are sensitive to the
# graph's shape: this corpus is known to pass all of them in webgl and nogl.
CORPUS = {
    "README.md": """
        # Sample shop

        A tiny sample project: models, reports and a SQL schema. See [[architecture]].
        """,
    "app/models.py": '''
        """Order and customer models."""


        class Customer:
            def __init__(self, name):
                self.name = name


        class Order:
            def __init__(self, customer, total):
                self.customer = customer
                self.total = total

            def apply_discount(self, pct):
                return round_total(self.total * (1 - pct))


        def round_total(value):
            return round(value, 2)
        ''',
    "app/reports.py": '''
        """Sales reporting."""
        from app.models import Order, round_total

        SALES_SQL = """
        SELECT o.order_id, o.total
        FROM sales.Orders o
        JOIN sales.Customers c ON c.customer_id = o.customer_id
        """


        def monthly_sales(rows):
            return round_total(sum(r.total for r in rows))


        def load_sales_orders(conn):
            return [Order(None, r[1]) for r in conn.execute(SALES_SQL)]
        ''',
    "app/service.py": """
        from app.reports import monthly_sales, load_sales_orders


        class UserService:
            def sales_summary(self, conn):
                return monthly_sales(load_sales_orders(conn))
        """,
    "docs/architecture.md": """
        # Architecture

        The [[UserService]] reads orders through `load_sales_orders` and rolls them up
        with `monthly_sales`. See [the schema](../sql/schema.sql).

        ## Sales reporting

        Monthly sales come from the MonthlySales view over sales.Orders.

        ### [MEASURED] APP-API-014 - sales.Orders retains inactive rows

        Cancelled orders stay in [[Orders]] with a zero total.
        """,
    "sql/schema.sql": """
        CREATE TABLE sales.Customers (customer_id INT PRIMARY KEY, name NVARCHAR(100));
        CREATE TABLE sales.Orders (order_id INT PRIMARY KEY, customer_id INT, total DECIMAL(10,2));
        CREATE VIEW sales.MonthlySales AS
        SELECT customer_id, SUM(total) AS total FROM sales.Orders GROUP BY customer_id;
        """,
}


class Fail(Exception):
    pass


def check(cond, msg):
    if not cond:
        raise Fail(msg)


def make_corpus(folder):
    """Write the sample corpus into folder (created if missing)."""
    for rel, text in CORPUS.items():
        path = os.path.join(folder, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(textwrap.dedent(text).lstrip("\n"))


def sandbox_env(base):
    """Environment that keeps every per-user path inside base."""
    user = os.path.join(base, "user")
    home = os.path.join(base, "matrix_home")
    for d in (user, home):
        os.makedirs(d, exist_ok=True)
    env = dict(os.environ, MATRIX_HOME=home, HOME=user, USERPROFILE=user,
               PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
    for k in ("LOCALAPPDATA", "APPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME"):
        if k in env:
            env[k] = user
    return env


def run(args, env, timeout=600):
    """Run a script with this interpreter (never -I: the scripts import their siblings)."""
    p = subprocess.run([sys.executable, *args], env=env, capture_output=True,
                       text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if p.returncode != 0:
        raise Fail(f"{os.path.basename(args[0])} {' '.join(args[1:])} exited {p.returncode}\n"
                   f"--- stdout\n{p.stdout}\n--- stderr\n{p.stderr}")
    return p.stdout


def install(base):
    """Corpus + sandboxed install under base. Returns (target, install dir, env)."""
    target = os.path.join(base, "sample")
    make_corpus(target)
    env = sandbox_env(base)
    out = run([os.path.join(SRC, "setup.py"), target, "--no-launcher",
               "--python", sys.executable], env)
    mx = os.path.join(target, ".claude", "matrix")
    check(os.path.isfile(os.path.join(mx, "query.py")), f"setup.py did not install into {mx}\n{out}")
    return target, mx, env


class Offline(HTMLParser):
    """Collects every attribute or inline style that would load from the network."""

    REMOTE = re.compile(r"\s*(https?:)?//", re.I)
    URL = re.compile(r"url\(\s*['\"]?(https?:)?//", re.I)

    def __init__(self):
        super().__init__()
        self.bad, self.in_style = [], False

    def handle_starttag(self, tag, attrs):
        self.in_style = tag == "style"
        for k, v in attrs:
            if not v:
                continue
            if k in ("src", "href", "srcset", "data") and self.REMOTE.match(v):
                if not (tag == "a" and k == "href"):     # plain links are fine
                    self.bad.append(f"<{tag} {k}={v[:80]}>")
            elif k == "style" and self.URL.search(v):
                self.bad.append(f"<{tag} style=url(...)>")

    def handle_endtag(self, tag):
        self.in_style = False

    def handle_data(self, data):
        if self.in_style and self.URL.search(data):
            self.bad.append("<style> url(remote)")


def stdlib_only():
    """Imports in matrix/*.py and tests/*.py that are neither stdlib nor local."""
    local = set()
    files = []
    for folder in (SRC, os.path.join(REPO, "tests")):
        for name in sorted(os.listdir(folder)):
            if name.endswith(".py"):
                local.add(name[:-3])
                files.append(os.path.join(folder, name))
    allowed = set(sys.stdlib_module_names) | local | {"__future__"}
    bad = []
    for path in files:
        with open(path, encoding="utf-8") as fh:
            tree = ast.parse(fh.read(), path)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                mods = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
                mods = [node.module]
            else:
                continue
            for m in mods:
                if m.split(".")[0] not in allowed:
                    bad.append(f"{os.path.relpath(path, REPO)}:{node.lineno}: {m}")
    return bad


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--keep", action="store_true", help="keep the temp folder")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")

    base = tempfile.mkdtemp(prefix="matrix-smoke-")
    steps = 0

    def ok(msg):
        nonlocal steps
        steps += 1
        print(f"ok   {msg}", flush=True)

    try:
        bad = stdlib_only()
        check(not bad, "non-stdlib imports:\n  " + "\n  ".join(bad))
        ok("python source imports the standard library only")

        target, mx, env = install(base)
        ok(f"setup.py installed into {os.path.relpath(mx, base)}")

        with open(os.path.join(mx, "config.json"), encoding="utf-8") as fh:
            out_dir = os.path.normpath(os.path.join(mx, json.load(fh).get("out_dir") or "out"))
        with open(os.path.join(out_dir, "graph.json"), encoding="utf-8") as fh:
            graph = json.load(fh)
        nodes, edges = graph.get("nodes") or [], graph.get("edges") or graph.get("links") or []
        check(len(nodes) > 0 and len(edges) > 0, f"graph.json: {len(nodes)} nodes, {len(edges)} edges")
        ok(f"graph.json has {len(nodes)} nodes and {len(edges)} edges")

        labels = json.dumps(nodes).lower()
        for want in ("monthly_sales", "sales.orders", "userservice", "architecture"):
            check(want in labels, f"graph.json has no node for {want!r}")
        ok("graph.json has the sample's functions, tables and docs")

        html_path = os.path.join(out_dir, "graph.html")
        check(os.path.isfile(html_path) and os.path.getsize(html_path) > 0, f"missing {html_path}")
        parser = Offline()
        with open(html_path, encoding="utf-8", errors="replace") as fh:
            parser.feed(fh.read())
        parser.close()
        check(not parser.bad, "graph.html loads from the network: " + ", ".join(parser.bad[:5]))
        ok("graph.html exists and is offline (no remote src/href/url())")

        sys.path.insert(0, mx)
        import combine
        pair = [("a", graph), ("b", graph)]
        merged, names, link = combine.merge(pair)
        shared = [e for e in merged["edges"] if e["rel"] == "SHARED"]
        check(shared and link[0][1] == len(shared) and len(merged["nodes"]) == 2 * len(nodes),
              f"combine: {len(shared)} SHARED edges, link {link}")
        parser = Offline()
        parser.feed(combine.render(pair))
        parser.close()
        check(not parser.bad, "combined page loads from the network: " + ", ".join(parser.bad[:5]))
        ok(f"combine.py links two universes ({len(shared)} shared names) into one offline page")

        query = os.path.join(mx, "query.py")
        found = run([query, "find", "sales"], env)
        check("sales" in found.lower(), f"query.py find sales returned nothing:\n{found}")
        ok("query.py find sales")
        stats = run([query, "stats"], env)
        m = re.search(r"nodes:\s*(\d+)\s+edges:\s*(\d+)", stats)
        check(m and int(m.group(1)) > 0 and int(m.group(2)) > 0, f"query.py stats:\n{stats}")
        ok(f"query.py stats ({m.group(0).split()[1]} nodes)")
        run([query, "explain", "UserService"], env)
        ok("query.py explain UserService")

        listing = run([os.path.join(mx, "scopes.py"), "list"], env)
        reg = os.path.join(env["MATRIX_HOME"], "scopes.json")
        check(os.path.isfile(reg), f"no registry at {reg}")
        with open(reg, encoding="utf-8") as fh:
            scopes = json.load(fh).get("scopes") or []
        same = lambda p: os.path.normcase(os.path.realpath(p))   # noqa: E731
        home = [s for s in scopes if s.get("kind") == "home" and same(s.get("root", "")) == same(target)]
        check(home, f"registry has no home universe for {target}: {scopes}")
        check(home[0]["id"] in listing, f"scopes.py list does not show {home[0]['id']}:\n{listing}")
        ok(f"scopes.py list ({len(scopes)} universe(s) in the sandboxed registry)")
    except Fail as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        print(f"(temp folder kept: {base})", file=sys.stderr)
        return 1
    except Exception:
        import traceback
        traceback.print_exc()
        print(f"(temp folder kept: {base})", file=sys.stderr)
        return 1
    if args.keep:
        print(f"kept {base}")
    else:
        shutil.rmtree(base, ignore_errors=True)
    print(f"smoke: {steps} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
