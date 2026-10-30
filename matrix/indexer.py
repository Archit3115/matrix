"""Matrix knowledge-graph indexer.

Deterministic, local, stdlib-only. Nothing leaves the machine and no model is
called: code is parsed with Python's own AST, everything else with structural
parsers. Every edge is tagged with how it was obtained:

    EXTRACTED  explicit in the source (an import, a CREATE VIEW, a [[link]])
    INFERRED   resolved by this indexer across files (a bare call name, a
               prose mention of a symbol defined elsewhere)
    AMBIGUOUS  more than one candidate matched; kept, but flagged

Usage:
    python indexer.py            # incremental: only re-parses changed files
    python indexer.py --full     # ignore the cache, rebuild from scratch
    python indexer.py --quiet    # only print the summary line
    python indexer.py --config F # use config F (default: see mxconfig.py)
    python indexer.py --force    # build even past the config's max_files cap
"""

from __future__ import annotations

import argparse
import ast
import builtins
import fnmatch
import hashlib
import json
import os
import re
import sys
import warnings
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone

import mxconfig

# Words too common to be worth a cross-reference edge.
STOPWORDS = {
    "index", "config", "setup", "value", "values", "table", "tables", "column",
    "columns", "source", "target", "result", "results", "data", "file", "files",
    "model", "models", "query", "queries", "report", "reports", "output",
    "input", "start", "check", "build", "master", "detail", "record", "records",
    "python", "notebook", "project", "projects", "string", "object", "client",
    "server", "update", "delete", "insert", "select", "create", "common",
}

# Call names too generic to attribute to a user definition. Without this,
# every `.get()` and `.append()` in the tree collapses onto whichever local
# helper happens to share the name, and those become the top god nodes.
COMMON_CALLS = set(dir(builtins)) | {
    "get", "text", "append", "extend", "format", "join", "split", "strip",
    "keys", "values", "items", "read", "write", "close", "open", "update",
    "add", "remove", "pop", "sort", "sorted", "count", "index", "copy",
    "display", "show", "select", "filter", "cast", "alias", "collect",
    "withcolumn", "withColumn", "createOrReplaceTempView", "toPandas",
    "load", "save", "option", "options", "mode", "schema", "table", "sql",
    "start", "stop", "run", "exit", "log", "info", "warning", "error",
    "debug", "replace", "lower", "upper", "encode", "decode", "dumps",
    "loads", "dump", "match", "search", "sub", "findall", "group", "now",
    "today", "strftime", "strptime", "exists", "makedirs", "walk", "listdir",
    "basename", "dirname", "abspath", "getsize", "sleep", "date", "when",
    "lit", "col", "expr", "first", "last", "max", "min", "sum", "mean",
}

# Bump when an extractor's output changes shape: cached payloads from an
# older version are reparsed instead of reused. 2 = node `body` text.
CACHE_V = 2
CLAIMS = True   # cfg["claims"]; set by main()

# A string literal is only mined for table names if it actually looks like SQL.
SQL_HINT = re.compile(
    r"(?is)\b(select\s|insert\s+into\b|update\s+\w+\s+set\b|merge\s+into\b"
    r"|delete\s+from\b|create\s+(?:or\s+(?:alter|replace)\s+)?(?:table|view)\b)")


# --------------------------------------------------------------------------
# graph container
# --------------------------------------------------------------------------

class Graph:
    def __init__(self):
        self.nodes: dict[str, dict] = {}
        self.edges: dict[tuple[str, str, str], dict] = {}

    def add_node(self, nid, ntype, label, **meta):
        node = self.nodes.get(nid)
        if node is None:
            node = {"id": nid, "type": ntype, "label": label}
            node.update(meta)
            self.nodes[nid] = node
        else:
            for k, v in meta.items():
                node.setdefault(k, v)
        return nid

    def add_edge(self, src, dst, rel, provenance, **meta):
        if src == dst:
            return
        key = (src, dst, rel)
        existing = self.edges.get(key)
        if existing is not None:
            # EXTRACTED always wins over a weaker claim about the same pair.
            rank = {"EXTRACTED": 3, "AMBIGUOUS": 2, "INFERRED": 1}
            if rank[provenance] > rank[existing["provenance"]]:
                existing["provenance"] = provenance
            existing["weight"] = existing.get("weight", 1) + 1
            return
        edge = {"src": src, "dst": dst, "rel": rel,
                "provenance": provenance, "weight": 1}
        edge.update(meta)
        self.edges[key] = edge


# --------------------------------------------------------------------------
# discovery
# --------------------------------------------------------------------------

def norm(path):
    return os.path.normpath(path).replace("\\", "/")


def discover(cfg, out_dir):
    """Yield (abs_path, root_label, is_data_dir) for every candidate file."""
    ignore_dirs = set(cfg["ignore_dirs"])
    data_dirs = [norm(d).lower() for d in cfg["data_dirs"]]
    # The generated wiki lives under a root; without this the graph ingests
    # its own output and the wiki articles become the top god nodes.
    # ignore_paths: whole folders (absolute) kept out the same way.
    blocked = [norm(p).lower() for p in [out_dir] + cfg["ignore_paths"]]
    seen = set()

    for root in cfg["roots"]:
        base = norm(root["path"])
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            # junctions (and links) are never followed: they pull in content
            # from outside the root and can loop
            dirnames[:] = sorted(
                d for d in dirnames
                if d not in ignore_dirs and not d.endswith(".egg-info")
                and not is_link(os.path.join(dirpath, d))
            )
            cur = norm(dirpath).lower()
            if any(cur == b or cur.startswith(b + "/") for b in blocked):
                dirnames[:] = []
                continue
            in_data = any(cur == d or cur.startswith(d + "/") for d in data_dirs)
            for name in sorted(filenames):
                if any(fnmatch.fnmatch(name, g) for g in cfg["ignore_globs"]):
                    continue
                full = norm(os.path.join(dirpath, name))
                if full.lower() in seen:
                    continue
                seen.add(full.lower())
                yield full, root["label"], in_data


def is_link(path):
    """A symlink or an NTFS junction (os.walk follows junctions)."""
    try:
        return os.path.islink(path) or bool(getattr(os.path, "isjunction", None)
                                             and os.path.isjunction(path))
    except OSError:
        return True


def count_files(cfg, out_dir, limit):
    """Files a build would walk; counting stops past limit."""
    n = 0
    for _ in discover(cfg, out_dir):
        n += 1
        if n > limit:
            break
    return n


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


PAYLOAD_KEYS = ("nodes", "edges", "errors", "pending_calls", "pending_tables",
                "pending_links", "pending_adf")


def new_payload():
    return {k: [] for k in PAYLOAD_KEYS}


def merge_payload(dst, src):
    for k in PAYLOAD_KEYS:
        dst[k].extend(src.get(k, ()))


def retarget(payload, old_id, new_id):
    """Rewrite a file's own node id after the fact (doc: -> memory:)."""
    for edge in payload["edges"]:
        if edge["src"] == old_id:
            edge["src"] = new_id
        if edge["dst"] == old_id:
            edge["dst"] = new_id
    payload["pending_links"] = [
        (new_id if s == old_id else s, t, o)
        for s, t, o in payload["pending_links"]
    ]


# --------------------------------------------------------------------------
# extractors -- each returns a list of node dicts and a list of edge dicts
# --------------------------------------------------------------------------

def rel_to_work(path, cfg):
    for root in cfg["roots"]:
        base = norm(root["path"])
        if path.lower().startswith(base.lower() + "/"):
            return root["label"] + "/" + path[len(base) + 1:]
    return path


def extract_python(path, key, text, out):
    """AST walk: definitions, imports, and call sites."""
    src = "\n".join(
        "" if ln.lstrip().startswith(("%", "!")) else ln
        for ln in text.splitlines()
    )
    try:
        # third-party sources trip SyntaxWarning / DeprecationWarning (invalid
        # escapes and the like); they are not ours to report, so keep them
        # out of the build log
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", SyntaxWarning)
            warnings.simplefilter("ignore", DeprecationWarning)
            tree = ast.parse(src)
    except (SyntaxError, ValueError, RecursionError, MemoryError) as exc:
        # Some exported notebooks (Databricks source format and the like) are
        # not valid Python at all (or nest deeper than the parser allows, or
        # hold NUL bytes).
        # Fall back to a structural regex pass so the file still contributes.
        out["errors"].append(f"{key}: syntax error line {getattr(exc, 'lineno', None)}"
                             if isinstance(exc, SyntaxError) else
                             f"{key}: not parsed ({type(exc).__name__})")
        extract_python_fallback(key, src, out)
        return

    module = os.path.splitext(os.path.basename(path))[0]
    scope: list[str] = []

    def qual(name):
        return ".".join([module] + scope + [name])

    class Visitor(ast.NodeVisitor):
        def visit_ClassDef(self, node):
            nid = f"class:{qual(node.name)}"
            out["nodes"].append(dict(id=nid, type="class", label=node.name,
                                     file=key, line=node.lineno))
            out["edges"].append(dict(src=f"file:{key}", dst=nid,
                                     rel="DEFINES", provenance="EXTRACTED"))
            for base in node.bases:
                bname = dotted(base)
                if bname:
                    out["pending_calls"].append((nid, bname, key, "INHERITS"))
            scope.append(node.name)
            self.generic_visit(node)
            scope.pop()

        def _function(self, node):
            nid = f"func:{qual(node.name)}"
            out["nodes"].append(dict(id=nid, type="function", label=node.name,
                                     file=key, line=node.lineno,
                                     scope=".".join(scope) or None))
            parent = f"class:{qual('')[:-1]}" if scope else f"file:{key}"
            out["edges"].append(dict(src=parent, dst=nid, rel="DEFINES",
                                     provenance="EXTRACTED"))
            scope.append(node.name)
            self.generic_visit(node)
            scope.pop()

        visit_FunctionDef = _function
        visit_AsyncFunctionDef = _function

        def visit_Import(self, node):
            for alias in node.names:
                out["edges"].append(dict(src=f"file:{key}",
                                         dst=f"module:{alias.name.split('.')[0]}",
                                         rel="IMPORTS", provenance="EXTRACTED"))
                out["nodes"].append(dict(id=f"module:{alias.name.split('.')[0]}",
                                         type="module",
                                         label=alias.name.split(".")[0]))
            self.generic_visit(node)

        def visit_ImportFrom(self, node):
            if node.module:
                base = node.module.split(".")[0]
                out["nodes"].append(dict(id=f"module:{base}", type="module",
                                         label=base))
                out["edges"].append(dict(src=f"file:{key}", dst=f"module:{base}",
                                         rel="IMPORTS", provenance="EXTRACTED"))
                for alias in node.names:
                    out["pending_calls"].append(
                        (f"file:{key}", alias.name, key, "IMPORTS"))
            self.generic_visit(node)

        def visit_Call(self, node):
            name = dotted(node.func)
            if name:
                leaf = name.split(".")[-1]
                if leaf not in COMMON_CALLS:
                    caller = f"func:{qual('')[:-1]}" if scope else f"file:{key}"
                    out["pending_calls"].append((caller, leaf, key, "CALLS"))
            self.generic_visit(node)

    Visitor().visit(tree)

    # SQL embedded in string literals -- very common in Databricks/ETL code,
    # where the whole statement sits in a dbutils widget default. Only string
    # constants are mined, so `from pyspark.sql.functions import ...` is not
    # mistaken for a SQL FROM clause.
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            harvest_sql(node.value, key, out)


def harvest_sql(text, key, out):
    """Pull table definitions and references out of a SQL string."""
    if len(text) < 20 or not SQL_HINT.search(text):
        return
    for m in TABLE_DEF.finditer(text):
        tbl = clean_table(m.group(2))
        if not tbl:
            continue
        kind = m.group(1).lower()
        ntype = "view" if kind == "view" else "table"
        out["nodes"].append(dict(id=f"table:{tbl.lower()}", type=ntype,
                                 label=tbl, file=key))
        out["edges"].append(dict(src=f"file:{key}", dst=f"table:{tbl.lower()}",
                                 rel="DEFINES", provenance="EXTRACTED"))
    for m in TABLE_REF.finditer(text):
        tbl = clean_table(m.group(2))
        if tbl:
            verb = "WRITES" if m.group(1).lower().startswith(
                ("into", "update", "merge")) else "READS"
            out["pending_tables"].append((f"file:{key}", tbl, verb))


DEF_LINE = re.compile(r"(?m)^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)")
STRING_LIT = re.compile(r"(?s)\"(.*?)\"|'(.*?)'")


def extract_python_fallback(key, src, out):
    """Structural extraction for files the Python parser rejects."""
    module = os.path.splitext(os.path.basename(key))[0]
    for m in DEF_LINE.finditer(src):
        kind, name = m.group(1), m.group(2)
        nid = f"{'class' if kind == 'class' else 'func'}:{module}.{name}"
        out["nodes"].append(dict(id=nid,
                                 type="class" if kind == "class" else "function",
                                 label=name, file=key,
                                 line=src[:m.start()].count("\n") + 1,
                                 partial=True))
        out["edges"].append(dict(src=f"file:{key}", dst=nid, rel="DEFINES",
                                 provenance="EXTRACTED"))
    for m in STRING_LIT.finditer(src):
        harvest_sql(m.group(1) or m.group(2) or "", key, out)


def dotted(node):
    """Flatten an ast expression like a.b.c into 'a.b.c'."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def extract_notebook(path, key, text, out):
    try:
        nb = json.loads(text)
    except json.JSONDecodeError:
        out["errors"].append(f"{key}: unreadable notebook")
        return
    code, md = [], []
    for cell in nb.get("cells", []):
        source = "".join(cell.get("source", []))
        if cell.get("cell_type") == "code":
            code.append(source)
        elif cell.get("cell_type") == "markdown":
            md.append(source)
    if code:
        extract_python(path, key, "\n".join(code), out)
    if md:
        extract_markdown(path, key, "\n".join(md), out, headings_only=True)


TABLE_DEF = re.compile(
    r"(?is)\bcreate\s+(?:or\s+(?:alter|replace)\s+)?"
    r"(table|view|procedure|proc|function)\s+([\[\]\w.]{3,120})")
TABLE_REF = re.compile(r"(?is)\b(from|join|into|update|merge\s+into)\s+([\[\]\w.]{3,120})")


def clean_table(raw):
    name = raw.replace("[", "").replace("]", "").strip().strip(";,()")
    if not name or name.lower() in {"select", "where", "on", "as", "set"}:
        return None
    if not re.fullmatch(r"[\w.]+", name):
        return None
    parts = [p for p in name.split(".") if p]
    if not parts:
        return None
    return ".".join(parts[-2:]) if len(parts) > 1 else parts[0]


def extract_sql(path, key, text, out):
    for m in TABLE_DEF.finditer(text):
        tbl = clean_table(m.group(2))
        if not tbl:
            continue
        kind = m.group(1).lower()
        ntype = "view" if kind == "view" else ("table" if kind == "table" else "procedure")
        nid = f"table:{tbl.lower()}"
        out["nodes"].append(dict(id=nid, type=ntype, label=tbl, file=key,
                                 line=text[:m.start()].count("\n") + 1))
        out["edges"].append(dict(src=f"file:{key}", dst=nid, rel="DEFINES",
                                 provenance="EXTRACTED"))
    for m in TABLE_REF.finditer(text):
        tbl = clean_table(m.group(2))
        if tbl:
            verb = "WRITES" if m.group(1).lower().startswith(("into", "update", "merge")) else "READS"
            out["pending_tables"].append((f"file:{key}", tbl, verb))


HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.M)
WIKILINK = re.compile(r"\[\[([^\]|#]+)")
MDLINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)")


CLAIM_HEADING = re.compile(
    r"(?m)^#{2,4}\s*\[(MEASURED|SOURCE|INFERRED|RETRACTED|EXTERNAL)\]\s*"
    r"([A-Z]{2,4}-[A-Z]{2,4}-[A-Z0-9]+)\s*[-\u2014\u2013]+\s*(.+?)\s*$")
FENCE = re.compile(r"(?s)```.*?```")
NONNEWLINE = re.compile("[^" + chr(10) + "]")
FENCE_LINE = re.compile(r"(?m)^[ \t]*```.*$")
MD_LINK_TEXT = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
MD_NOISE = re.compile(r"\[\[|\]\]|[#*`|>]|(?<!\w)_+|_+(?!\w)|-{3,}|={3,}")
FRONTMATTER = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*(?:\n|\Z)", re.S)
BODY_CAP = {"doc": 2000, "concept": 400, "claim": 600}


def md_clean(text, keep_code=False):
    """Markdown -> plain searchable text: fences, link syntax and markup
    stripped, whitespace collapsed. keep_code keeps a fence's contents."""
    text = FENCE_LINE.sub(" ", text) if keep_code else FENCE.sub(" ", text)
    text = MD_LINK_TEXT.sub(r"\1", text)
    text = MD_NOISE.sub(" ", text)
    return " ".join(text.split())


def doc_body(text):
    """Body for a memory/doc node: frontmatter description, then the text."""
    desc = ""
    m = FRONTMATTER.match(text)
    if m:
        d = re.search(r"(?m)^description:[ \t]*(.+)$", m.group(1))
        if d:
            desc = d.group(1).strip().strip("'\"").replace('\\"', '"')
        text = text[m.end():]
    return md_clean(desc + "\n" + text[:8000], keep_code=True)[:BODY_CAP["doc"]]
SUPERSEDES = re.compile(r"(?im)^\*\*(?:Supersedes|Replaced by):\*\*\s*(.+)$")
CLAIM_REF = re.compile(r"[A-Z]{2,4}-[A-Z]{2,4}-[A-Z0-9]+")


def extract_markdown(path, key, text, out, headings_only=False):
    """Markdown -> concept nodes, plus claim nodes for knowledge-base pages.

    A claim heading looks like

        ### [MEASURED] APP-API-014 - sales.Orders retains inactive rows

    and becomes a `claim:` node carrying its tier. Wikilinks inside a claim's
    section attach to the CLAIM rather than the containing document, so
    `query.py explain APP-API-014` shows what that one claim touches instead of
    everything its page mentions. Off when the config sets "claims": false.
    """
    stem = os.path.splitext(os.path.basename(path))[0]
    doc_id = f"doc:{key}"

    # Claim sections first: each runs to the next claim heading, or EOF.
    # Fenced blocks are blanked (length-preserving, so offsets stay valid)
    # so a worked EXAMPLE of a claim inside a code fence in a schema or
    # how-to page does not register as a real claim and collide with the
    # genuine one.
    scan = FENCE.sub(lambda mm: NONNEWLINE.sub(' ', mm.group(0)), text)
    claims = []
    for m in CLAIM_HEADING.finditer(scan) if CLAIMS else ():
        claims.append({"start": m.start(), "body": m.end(),
                       "tier": m.group(1), "cid": m.group(2).strip(),
                       "title": m.group(3).strip()})
    for i, c in enumerate(claims):
        c["end"] = claims[i + 1]["start"] if i + 1 < len(claims) else len(text)
        nid = "claim:" + c["cid"]
        body = md_clean(scan[c["body"]:c["end"]])[:BODY_CAP["claim"]]
        out["nodes"].append(dict(id=nid, type="claim", label=c["cid"],
                                 tier=c["tier"], statement=c["title"][:300],
                                 file=key,
                                 line=text[:c["start"]].count("\n") + 1,
                                 **({"body": body} if body else {})))
        out["edges"].append(dict(src=doc_id, dst=nid, rel="ASSERTS",
                                 provenance="EXTRACTED"))
        for sup in SUPERSEDES.finditer(text[c["body"]:c["end"]]):
            for ref in CLAIM_REF.findall(sup.group(1)):
                out["edges"].append(dict(src=nid, dst="claim:" + ref,
                                         rel="SUPERSEDES",
                                         provenance="EXTRACTED"))

    def owner(offset):
        for c in claims:
            if c["start"] <= offset < c["end"]:
                return "claim:" + c["cid"]
        return doc_id

    claim_starts = set(c["start"] for c in claims)
    heads = list(HEADING.finditer(scan))
    for i, m in enumerate(heads):
        if m.start() in claim_starts:
            continue
        title = m.group(2).strip().strip("#").strip()
        if len(title) < 3 or len(title) > 120:
            continue
        cid = f"concept:{slug(title)}"
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        body = md_clean(scan[m.end():end])[:BODY_CAP["concept"]]
        out["nodes"].append(dict(id=cid, type="concept", label=title, file=key,
                                 line=text[:m.start()].count("\n") + 1,
                                 **({"body": body} if body else {})))
        out["edges"].append(dict(src=doc_id, dst=cid, rel="DEFINES",
                                 provenance="EXTRACTED"))
    if headings_only:
        return
    for m in WIKILINK.finditer(text):
        out["pending_links"].append((owner(m.start()), m.group(1).strip(), stem))
    for m in MDLINK.finditer(text):
        target = m.group(1)
        if target.startswith(("http://", "https://", "#", "mailto:")):
            if target.startswith("http"):
                out["nodes"].append(dict(id=f"url:{target}", type="url",
                                         label=target))
                out["edges"].append(dict(src=doc_id, dst=f"url:{target}",
                                         rel="CITES", provenance="EXTRACTED"))
            continue
        out["pending_links"].append((doc_id, os.path.splitext(os.path.basename(target))[0], stem))


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:80]


NOTEBOOK_PATH = re.compile(r"(?im)^\s*(?:notebook_path|path|file_path)\s*:\s*[\"']?([^\"'\s]+)")


def extract_yaml(path, key, text, out):
    doc_id = f"config:{key}"
    out["nodes"].append(dict(id=doc_id, type="config",
                             label=os.path.basename(path), file=key))
    for m in NOTEBOOK_PATH.finditer(text):
        target = m.group(1)
        out["pending_links"].append(
            (doc_id, os.path.splitext(os.path.basename(target))[0], None))
    for m in re.finditer(r"(?im)^\s{0,6}([a-z_][a-z0-9_]{2,40})\s*:\s*$", text):
        name = m.group(1)
        if name in {"resources", "targets", "jobs", "tasks", "pipelines", "clusters"}:
            continue
        out["nodes"].append(dict(id=f"resource:{name}", type="resource", label=name))
        out["edges"].append(dict(src=doc_id, dst=f"resource:{name}",
                                 rel="DECLARES", provenance="EXTRACTED"))


ADF_KIND = {"dataset": "dataset", "pipeline": "pipeline",
            "linkedservice": "linkedservice", "trigger": "trigger",
            "dataflow": "dataflow"}


def extract_adf(path, key, text, out):
    """Azure Data Factory / Synapse artifact JSON."""
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return
    if not isinstance(obj, dict) or "properties" not in obj:
        return
    parent = os.path.basename(os.path.dirname(path)).lower()
    kind = ADF_KIND.get(parent)
    if kind is None:
        return
    name = obj.get("name") or os.path.splitext(os.path.basename(path))[0]
    nid = f"{kind}:{name.lower()}"
    out["nodes"].append(dict(id=nid, type=kind, label=name, file=key))
    for ref in find_references(obj.get("properties", {})):
        out["pending_adf"].append((nid, ref))


def find_references(obj, acc=None):
    """Every referenceName in an ADF artifact, at any depth."""
    acc = [] if acc is None else acc
    if isinstance(obj, dict):
        ref = obj.get("referenceName")
        if isinstance(ref, str):
            acc.append(ref)
        for v in obj.values():
            find_references(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            find_references(v, acc)
    return acc


EXTRACTORS = {
    ".py": extract_python,
    ".ipynb": extract_notebook,
    ".sql": extract_sql,
    ".md": extract_markdown,
    ".txt": extract_markdown,
    ".rst": extract_markdown,
    ".yml": extract_yaml,
    ".yaml": extract_yaml,
    ".json": extract_adf,
}


# --------------------------------------------------------------------------
# resolution: turn pending name references into edges
# --------------------------------------------------------------------------

def resolve(graph, pending_calls, pending_tables, pending_links, pending_adf):
    by_label = defaultdict(list)
    for nid, node in graph.nodes.items():
        if node["type"] in {"function", "class", "concept", "memory", "table",
                            "view", "procedure", "dataset", "pipeline",
                            "linkedservice", "doc", "notebook"}:
            by_label[node["label"].lower()].append(nid)

    for caller, name, key, rel in pending_calls:
        if caller not in graph.nodes:
            continue
        cands = [c for c in by_label.get(name.lower(), []) if c != caller]
        if not cands:
            continue
        same_file = [c for c in cands if graph.nodes[c].get("file") == key]
        if len(same_file) == 1:
            graph.add_edge(caller, same_file[0], rel, "EXTRACTED")
        elif len(cands) == 1:
            graph.add_edge(caller, cands[0], rel, "INFERRED")
        else:
            for c in cands[:4]:
                graph.add_edge(caller, c, rel, "AMBIGUOUS")

    for src, tbl, verb in pending_tables:
        nid = f"table:{tbl.lower()}"
        if nid in graph.nodes:
            graph.add_edge(src, nid, verb, "EXTRACTED")
        elif "." in tbl:
            # Schema-qualified, so it is a table even though nothing here
            # defines it -- it lives in a database this corpus does not hold.
            graph.add_node(nid, "table", tbl, external=True)
            graph.add_edge(src, nid, verb, "INFERRED")
        # A bare name nothing defines is far more likely to be prose than a
        # table ("read from Databricks"), so it is dropped rather than guessed.

    # Tables are materialised by the pending_tables pass above, i.e. AFTER
    # by_label was first built, so a [[wikilink]] naming a table could never
    # resolve and always fell through to an unresolved concept node. Refresh.
    by_label = defaultdict(list)
    for nid, node in graph.nodes.items():
        if node["type"] in {"function", "class", "concept", "memory", "table",
                            "view", "procedure", "dataset", "pipeline",
                            "linkedservice", "doc", "notebook", "claim"}:
            by_label[node["label"].lower()].append(nid)

    for src, target, _origin in pending_links:
        cands = by_label.get(target.lower(), [])
        cands += [n for n in graph.nodes
                  if n.startswith(("doc:", "memory:")) and n.rsplit("/", 1)[-1]
                  .removesuffix(".md").lower() == target.lower()]
        cands = [c for c in dict.fromkeys(cands) if c != src]
        if len(cands) == 1:
            graph.add_edge(src, cands[0], "LINKS", "EXTRACTED")
        elif cands:
            for c in cands[:3]:
                graph.add_edge(src, c, "LINKS", "AMBIGUOUS")
        else:
            nid = f"concept:{slug(target)}"
            graph.add_node(nid, "concept", target, unresolved=True)
            graph.add_edge(src, nid, "LINKS", "INFERRED")

    for src, ref in pending_adf:
        cands = [c for c in by_label.get(ref.lower(), []) if c != src]
        if len(cands) == 1:
            graph.add_edge(src, cands[0], "USES", "EXTRACTED")
        elif cands:
            for c in cands[:3]:
                graph.add_edge(src, c, "USES", "AMBIGUOUS")


def cross_reference(graph, doc_texts):
    """INFERRED edges from prose that names a symbol defined elsewhere.

    This is what connects the memory notes to the code and tables they are
    actually about -- the edges no single file states explicitly.
    """
    targets = {}
    for nid, node in graph.nodes.items():
        label = node["label"]
        if node["type"] not in {"function", "class", "table", "view",
                                "procedure", "dataset", "pipeline"}:
            continue
        if len(label) < 5 or label.lower() in STOPWORDS:
            continue
        if label in COMMON_CALLS or label.lower() in COMMON_CALLS:
            continue
        if not re.fullmatch(r"[\w.]+", label):
            continue
        targets.setdefault(label.lower(), []).append(nid)

    for doc_id, text in doc_texts.items():
        low = text.lower()
        for label, nids in targets.items():
            if label not in low:
                continue
            if not re.search(r"(?<![\w.])" + re.escape(label) + r"(?![\w])", low):
                continue
            for nid in nids[:3]:
                if nid != doc_id and graph.nodes[nid].get("file") != \
                        graph.nodes.get(doc_id, {}).get("file"):
                    graph.add_edge(doc_id, nid, "MENTIONS", "INFERRED")


# --------------------------------------------------------------------------
# analysis
# --------------------------------------------------------------------------

def adjacency(graph):
    adj = defaultdict(set)
    for (src, dst, _rel) in graph.edges:
        if src in graph.nodes and dst in graph.nodes:
            adj[src].add(dst)
            adj[dst].add(src)
    return adj


def communities(graph, adj, rounds=12):
    """Deterministic label propagation."""
    labels = {nid: nid for nid in graph.nodes}
    order = sorted(graph.nodes)
    for _ in range(rounds):
        changed = False
        for nid in order:
            neigh = adj.get(nid)
            if not neigh:
                continue
            counts = Counter(labels[n] for n in neigh if n in labels)
            if not counts:
                continue
            best = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
            if labels[nid] != best:
                labels[nid] = best
                changed = True
        if not changed:
            break
    groups = defaultdict(list)
    for nid, lab in labels.items():
        groups[lab].append(nid)
    return {k: sorted(v) for k, v in groups.items() if len(v) > 1}


def shortest_path(graph, adj, a, b):
    if a not in graph.nodes or b not in graph.nodes:
        return None
    seen, q = {a: None}, deque([a])
    while q:
        cur = q.popleft()
        if cur == b:
            path = []
            while cur is not None:
                path.append(cur)
                cur = seen[cur]
            return list(reversed(path))
        for nxt in sorted(adj.get(cur, ())):
            if nxt not in seen:
                seen[nxt] = cur
                q.append(nxt)
    return None


# --------------------------------------------------------------------------
# reporting
# --------------------------------------------------------------------------

STRUCTURAL = ("table", "view", "class", "pipeline", "memory", "notebook",
              "linkedservice", "dataset", "doc", "concept")


def community_name(graph, members, adj=None):
    """Name a community after its most connected, most nameable member.

    Markdown headings make terrible titles ("1. Inspect what WOULD be
    copied..."), so short structural labels are strongly preferred.
    """
    def score(nid):
        node = graph.nodes[nid]
        try:
            type_rank = STRUCTURAL.index(node["type"])
        except ValueError:
            type_rank = len(STRUCTURAL)
        too_long = len(node["label"]) > 45
        degree = len(adj.get(nid, ())) if adj else 0
        return (too_long, type_rank, -degree, nid)

    best = min(members, key=score)
    label = graph.nodes[best]["label"]
    return label if len(label) <= 60 else label[:57].rstrip() + "..."


def write_report(graph, adj, comms, stats, out_dir):
    deg = {n: len(adj.get(n, ())) for n in graph.nodes}
    gods = sorted(deg.items(), key=lambda kv: (-kv[1], kv[0]))[:20]
    prov = Counter(e["provenance"] for e in graph.edges.values())
    rels = Counter(e["rel"] for e in graph.edges.values())
    types = Counter(n["type"] for n in graph.nodes.values())

    cross = [e for e in graph.edges.values()
             if e["rel"] == "MENTIONS" and e["src"].startswith("memory:")]

    lines = [
        "# Knowledge graph report",
        "",
        f"_Generated {stats['generated']} - {stats['files_scanned']} files "
        f"scanned, {stats['files_parsed']} parsed, "
        f"{stats['files_cached']} unchanged (reused from cache)._",
        "",
        f"**{len(graph.nodes)} nodes, {len(graph.edges)} edges, "
        f"{len(comms)} communities**",
        "",
        "## Provenance",
        "",
        "| Tag | Edges | Meaning |",
        "|---|--:|---|",
        f"| EXTRACTED | {prov['EXTRACTED']} | stated explicitly in the source |",
        f"| INFERRED | {prov['INFERRED']} | resolved across files by the indexer |",
        f"| AMBIGUOUS | {prov['AMBIGUOUS']} | several candidates matched |",
        "",
        "## God nodes",
        "",
        "Highest-degree nodes - what everything else connects through.",
        "",
        "| Node | Type | Degree |",
        "|---|---|--:|",
    ]
    for nid, d in gods:
        if d == 0:
            continue
        node = graph.nodes[nid]
        lines.append(f"| `{node['label']}` | {node['type']} | {d} |")

    lines += ["", "## Node types", "", "| Type | Count |", "|---|--:|"]
    for t, c in types.most_common():
        lines.append(f"| {t} | {c} |")

    lines += ["", "## Relationships", "", "| Relation | Count |", "|---|--:|"]
    for r, c in rels.most_common():
        lines.append(f"| {r} | {c} |")

    if cross:
        lines += ["", "## Memory-to-code connections", "",
                  "Edges linking a memory note to the code or table it is about. "
                  "These are `INFERRED` - the note never names the file.", "",
                  "| Memory note | connects to | Type |", "|---|---|---|"]
        for e in sorted(cross, key=lambda e: e["src"])[:40]:
            s, d = graph.nodes[e["src"]], graph.nodes[e["dst"]]
            lines.append(f"| {s['label']} | `{d['label']}` | {d['type']} |")

    lines += ["", "## Communities", "", "| Community | Nodes |", "|---|--:|"]
    for lab, members in sorted(comms.items(), key=lambda kv: -len(kv[1]))[:25]:
        lines.append(f"| {community_name(graph, members, adj)} | {len(members)} |")

    if stats["errors"]:
        lines += ["", "## Parse errors", ""]
        lines += [f"- {e}" for e in stats["errors"][:25]]

    write(os.path.join(out_dir, "GRAPH_REPORT.md"), "\n".join(lines) + "\n")


def write_wiki(graph, adj, comms, out_dir):
    """Markdown a session can navigate by reading, without parsing JSON."""
    wiki = os.path.join(out_dir, "wiki")
    os.makedirs(wiki, exist_ok=True)
    for old in os.listdir(wiki):
        if old.endswith(".md"):
            os.remove(os.path.join(wiki, old))

    ranked = sorted(comms.items(), key=lambda kv: -len(kv[1]))
    index = ["# Knowledge base index", "",
             "One article per community. Read the article, not the source files.",
             "", "Visual explorer: [graph.html](graph.html) (single offline file; open in a browser).",
             "", "| Article | Nodes | Contains |", "|---|--:|---|"]

    for lab, members in ranked[:40]:
        name = community_name(graph, members, adj)
        fname = slug(name) or slug(lab)
        preview = ", ".join(
            f"`{graph.nodes[m]['label']}`" for m in
            sorted(members, key=lambda m: -len(adj.get(m, ())))[:5])
        index.append(f"| [{name}](wiki/{fname}.md) | {len(members)} | {preview} |")

        art = [f"# {name}", "", f"_{len(members)} nodes._", ""]
        by_type = defaultdict(list)
        for m in members:
            by_type[graph.nodes[m]["type"]].append(m)
        for t in sorted(by_type):
            art += [f"## {t}", ""]
            for m in sorted(by_type[t], key=lambda m: -len(adj.get(m, ())))[:60]:
                node = graph.nodes[m]
                loc = f" - `{node['file']}`" + (f":{node['line']}" if node.get("line") else "") \
                    if node.get("file") else ""
                art.append(f"- **{node['label']}**{loc}")
                out_edges = [e for e in graph.edges.values() if e["src"] == m][:6]
                for e in out_edges:
                    tgt = graph.nodes.get(e["dst"])
                    if tgt:
                        art.append(f"  - {e['rel'].lower()} `{tgt['label']}` "
                                   f"({e['provenance'].lower()})")
            art.append("")
        write(os.path.join(wiki, f"{fname}.md"), "\n".join(art) + "\n")

    write(os.path.join(out_dir, "INDEX.md"), "\n".join(index) + "\n")


def write(path, content):
    """Atomic: a build killed mid-write never leaves a truncated file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


SCOPES_BLOCK = re.compile(r'<script id="mx-scopes">.*?</script>', re.S)


def own_scope_only(html_path, out_dir):
    """embed_scopes: false - graph.html keeps only its own universe (no other
    roots, no install or python paths)."""
    import scopes
    cur = scopes.scope_for_out(out_dir)
    keep = ("id", "name", "root", "kind", "built", "nodes", "edges", "communities")
    obj = {"current": cur["id"] if cur else None,
           "scopes": [{k: cur.get(k) for k in keep}] if cur else []}
    block = f'<script id="mx-scopes">window.MX_SCOPES = {scopes.script_json(obj)};</script>'
    with open(html_path, encoding="utf-8") as fh:
        text = fh.read()
    write(html_path, SCOPES_BLOCK.sub(lambda _m: block, text, count=1))


def build_search(out_dir, graph_path, nodes=None, edges=None, if_stale=False):
    """out/search.db (FTS5, see search.py). A broken search index must not fail
    the graph build: readers fall back to graph.json on their own."""
    try:
        import search
        db_path = os.path.join(out_dir, "search.db")
        if if_stale:
            conn = search.open_ro(db_path, graph_path)
            if conn is not None:
                conn.close()
                return
        if nodes is None:
            with open(graph_path, encoding="utf-8") as fh:
                g = json.load(fh)
            nodes, edges = g["nodes"], g["edges"]
        search.build_db(nodes, edges, db_path, os.path.getmtime(graph_path))
    except Exception as exc:
        print(f"  (search index skipped: {type(exc).__name__}: {exc})")


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Build the Matrix knowledge graph.")
    ap.add_argument("--config", help="config file (default: <install>/config.json)")
    ap.add_argument("--full", action="store_true", help="ignore the cache")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--if-stale", action="store_true",
                    help="exit immediately unless something is newer than the "
                         "graph (cheap enough to run after every turn)")
    ap.add_argument("--force", action="store_true",
                    help="build even when the roots hold more than max_files files")
    args = ap.parse_args()

    global CLAIMS
    cfg = mxconfig.load(args.config)
    CLAIMS = bool(cfg["claims"])
    # Claim parsing changes payloads, so toggling it must not reuse the cache.
    cache_v = CACHE_V if CLAIMS else f"{CACHE_V}-noclaims"
    out_dir = norm(cfg["out_dir"])
    os.makedirs(out_dir, exist_ok=True)
    cache_path = os.path.join(out_dir, "cache.json")

    graph_path = os.path.join(out_dir, "graph.json")
    html_path = os.path.join(out_dir, "graph.html")
    if (args.if_stale and not args.full and os.path.exists(graph_path)
            and os.path.exists(html_path)
            and os.path.getmtime(html_path) >= os.path.getmtime(graph_path)):
        built = os.path.getmtime(graph_path)
        for path, _label, _in_data in discover(cfg, out_dir):
            try:
                if os.path.getmtime(path) > built:
                    break
            except OSError:
                continue
        else:
            build_search(out_dir, graph_path, if_stale=True)
            print("knowledge graph: up to date")
            return 0

    # Huge roots (a whole drive): refuse a build from scratch past the cap
    # unless asked to; an existing graph is updated incrementally regardless.
    cap = int(cfg.get("max_files") or 0)
    total = None
    if args.full or not os.path.exists(graph_path):
        total = count_files(cfg, out_dir, cap if cap > 0 else 10 ** 9)
        if cap > 0 and total > cap and not args.force:
            print(f"indexer: error: the roots hold more than {cap:,} files (max_files); "
                  "narrow the roots or add ignores, or rerun with --force "
                  "(max_files: 0 in the config removes the cap)", file=sys.stderr)
            return 3
        if not args.quiet:
            print(f"scan: {total} files", flush=True)

    cache = {}
    if not args.full and os.path.exists(cache_path):
        try:
            with open(cache_path, encoding="utf-8") as fh:
                cache = json.load(fh)
        except json.JSONDecodeError:
            cache = {}

    graph = Graph()
    out = new_payload()
    doc_texts = {}
    new_cache = {}
    scanned = parsed = cached = 0
    # A cache entry is only usable if last run's graph actually survived.
    have_graph = not args.full and os.path.exists(
        os.path.join(out_dir, "graph.json"))

    data_exts = set(cfg["data_exts"])

    for path, root_label, in_data in discover(cfg, out_dir):
        scanned += 1
        if total and not args.quiet and scanned % 500 == 0:
            print(f"progress: {scanned}/{total}", flush=True)
        ext = os.path.splitext(path)[1].lower()
        key = rel_to_work(path, cfg)
        try:
            size = os.path.getsize(path)
        except OSError:
            continue

        if ext in data_exts or size > cfg["max_file_bytes"]:
            graph.add_node(f"dataset:{key}", "dataset", os.path.basename(path),
                           file=key, bytes=size)
            continue
        if ext not in EXTRACTORS:
            continue
        if ext == ".json" and not cfg.get("adf_json", True):
            continue
        if in_data and ext in {".json", ".yml", ".yaml"}:
            continue

        try:
            digest = sha256(path)
        except OSError:
            continue

        ntype = {"md": "doc", "ipynb": "notebook"}.get(ext.lstrip("."), "file")
        prefix = {"doc": "doc:", "notebook": "file:"}.get(ntype, "file:")
        if ext in {".md", ".txt", ".rst"}:
            is_memory = root_label == "memory"
            nid = f"memory:{key}" if is_memory else f"doc:{key}"
            graph.add_node(nid, "memory" if is_memory else "doc",
                           os.path.splitext(os.path.basename(path))[0],
                           file=key)
        else:
            graph.add_node(f"{prefix}{key}", ntype, os.path.basename(path),
                           file=key)

        try:
            text = read_text(path)
        except OSError as exc:
            out["errors"].append(f"{key}: {exc}")
            continue

        # Prose is always kept, cached or not: cross_reference runs over the
        # whole corpus at the end, so it needs every document's text.
        is_doc = ext in {".md", ".txt", ".rst"}
        doc_id = None
        if is_doc:
            doc_id = f"memory:{key}" if root_label == "memory" else f"doc:{key}"
            doc_texts[doc_id] = text
        elif ext == ".ipynb":
            doc_texts.setdefault(f"file:{key}", text[:200000])

        entry = cache.get(key)
        if (have_graph and isinstance(entry, dict) and entry.get("digest") == digest
                and entry.get("v") == cache_v):
            payload = entry["payload"]
            cached += 1
        else:
            payload = new_payload()
            if is_doc:
                # extract_markdown keys off doc:<key>; memory notes need their
                # own namespace so they stay distinguishable in the graph.
                extract_markdown(path, key, text, payload)
                if root_label == "memory":
                    retarget(payload, f"doc:{key}", doc_id)
            else:
                try:
                    EXTRACTORS[ext](path, key, text, payload)
                except Exception as exc:    # one odd file never fails the build
                    payload = new_payload()
                    payload["errors"].append(f"{key}: not parsed ({type(exc).__name__}: "
                                             f"{str(exc)[:120]})")
            parsed += 1

        merge_payload(out, payload)
        new_cache[key] = {"v": cache_v, "digest": digest, "payload": payload}

    # Non-destructive: these dicts are also the cache payload, so popping
    # their keys here would write a cache with no ids in it.
    for node in out["nodes"]:
        meta = {k: v for k, v in node.items()
                if k not in ("id", "type", "label")}
        graph.add_node(node["id"], node["type"], node["label"], **meta)
    for edge in out["edges"]:
        graph.add_edge(edge["src"], edge["dst"], edge["rel"], edge["provenance"])

    resolve(graph, out["pending_calls"], out["pending_tables"],
            out["pending_links"], out["pending_adf"])
    cross_reference(graph, doc_texts)

    # Memory notes and docs reach search by their text, not just a file stem.
    for doc_id, text in doc_texts.items():
        if doc_id.startswith(("memory:", "doc:")) and doc_id in graph.nodes:
            body = doc_body(text)
            if body:
                graph.nodes[doc_id]["body"] = body

    # Drop dangling edges so the graph is internally consistent.
    for key_ in [k for k, e in graph.edges.items()
                 if e["src"] not in graph.nodes or e["dst"] not in graph.nodes]:
        del graph.edges[key_]

    adj = adjacency(graph)
    comms = communities(graph, adj)

    stats = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "files_scanned": scanned,
        "files_parsed": parsed,
        "files_cached": cached,
        "errors": out["errors"],
    }

    comm_of = {}
    for lab, members in comms.items():
        name = community_name(graph, members, adj)
        for m in members:
            comm_of[m] = name
    for nid, node in graph.nodes.items():
        node["degree"] = len(adj.get(nid, ()))
        node["community"] = comm_of.get(nid)

    payload = {
        "version": 1,
        "generated": stats["generated"],
        "stats": {k: v for k, v in stats.items() if k != "errors"},
        "nodes": [graph.nodes[n] for n in sorted(graph.nodes)],
        "edges": sorted(graph.edges.values(),
                        key=lambda e: (e["src"], e["dst"], e["rel"])),
    }
    write(os.path.join(out_dir, "graph.json"),
          json.dumps(payload, indent=1, ensure_ascii=False))
    write(cache_path, json.dumps(new_cache, indent=1))
    build_search(out_dir, graph_path, payload["nodes"], payload["edges"])

    write_report(graph, adj, comms, stats, out_dir)
    write_wiki(graph, adj, comms, out_dir)

    # Multiverse registry: record this build on the scope whose out is ours
    # (before viz, so the page embeds fresh stats). Never fails the build.
    try:
        import scopes
        scopes.update_stats(out_dir, len(graph.nodes), len(graph.edges), len(comms))
    except Exception as exc:
        print(f"  (registry not updated: {type(exc).__name__}: {exc})")

    # Regenerate the browser view from the graph just written, so the HTML can
    # never drift out of step with graph.json.
    # Written to a temp file and swapped in: a killed build never leaves a
    # half-written page in place of the last good one.
    tmp_html = f"{html_path}.{os.getpid()}.tmp"
    try:
        import viz
        viz.main(mxconfig.argv(cfg) + ["--out", tmp_html])
        if not cfg.get("embed_scopes", True):
            own_scope_only(tmp_html, out_dir)
        os.replace(tmp_html, html_path)
    except Exception as exc:  # a broken visualizer must not fail the index
        print(f"  (visualizer skipped: {type(exc).__name__}: {exc})")
    finally:
        if os.path.exists(tmp_html):
            os.remove(tmp_html)

    summary = (f"knowledge graph: {len(graph.nodes)} nodes, "
               f"{len(graph.edges)} edges, {len(comms)} communities "
               f"({parsed} files parsed, {cached} from cache)")
    if not args.quiet:
        print(summary)
        print(f"  -> {out_dir}/graph.json")
        print(f"  -> {out_dir}/GRAPH_REPORT.md")
        print(f"  -> {out_dir}/INDEX.md + wiki/")
    else:
        print(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
