"""Matrix configuration: one dict shared by every script.

Resolution: an explicit path (the `--config` flag) else <install>/config.json
else the built-in defaults below. Matrix installs at <target>/.claude/matrix,
so the default root is <target>. Relative paths resolve against the config
file's directory (the install dir when there is no file).

    roots        [{"path", "label"}] or bare path strings (label = folder name)
    memory       optional notes dir, indexed as root "memory" (memory nodes)
    ignore_paths folders (not names) never walked; out_dir and the install
                 dir (this folder) always are, whatever the config says
    data_dirs    walked for source/doc files only; big/data files -> dataset
    out_dir      generated graph, wiki, search.db, graph.html
    adf_json     parse *.json as Azure Data Factory / Synapse artifacts
    claims       parse "### [TIER] ABC-DEF-001 - ..." claim headings
    title        browser title of graph.html
    max_files    a build from scratch refuses to start when the roots hold
                 more files than this (0 = no cap; indexer --force overrides)
    embed_scopes graph.html lists every registered universe (name, root,
                 install, python) for the Multiverse switcher; false keeps
                 only this one
"""

from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.dirname(os.path.dirname(HERE))

DEFAULTS = {
    "roots": [TARGET],
    "memory": None,
    "ignore_dirs": [
        ".venv", "venv", "typings", "node_modules", ".git", "__pycache__",
        ".mypy_cache", ".pytest_cache", ".ipynb_checkpoints", ".databricks",
        ".vscode", "dist", "build", ".egg-info",
    ],
    "ignore_globs": ["*.min.js", "*.lock", "*.log"],
    "ignore_paths": [],
    "data_dirs": [],
    "data_exts": [".csv", ".parquet", ".xlsx", ".xls", ".zip", ".7z", ".gz",
                  ".pptx", ".docx", ".bak", ".png", ".jpg", ".jpeg", ".gif",
                  ".webp", ".svg", ".pdf"],
    "max_file_bytes": 2000000,
    "adf_json": False,
    "claims": True,
    "out_dir": "out",
    "title": "Matrix",
    "max_files": 60000,
    "embed_scopes": True,
}


def load(path=None):
    """Config dict with absolute, forward-slash paths and every key present.
    `_path` is the file it came from (None = defaults), so callers can hand
    the same config on to another script."""
    if path is None and os.path.isfile(os.path.join(HERE, "config.json")):
        path = os.path.join(HERE, "config.json")
    cfg = dict(DEFAULTS)
    base = HERE
    if path:
        path = os.path.abspath(path)
        with open(path, encoding="utf-8-sig") as fh:   # tolerate a BOM
            cfg.update(json.load(fh))
        base = os.path.dirname(path)

    def absp(p):
        return os.path.normpath(os.path.join(base, os.path.expanduser(p))).replace("\\", "/")

    roots = []
    for r in cfg["roots"]:
        r = {"path": r} if isinstance(r, str) else dict(r)
        r["path"] = absp(r["path"])
        r.setdefault("label", os.path.basename(r["path"]).lower() or "root")
        roots.append(r)
    if cfg.get("memory"):
        cfg["memory"] = absp(cfg["memory"])
        if not any(r["label"] == "memory" for r in roots):
            roots.append({"path": cfg["memory"], "label": "memory"})
    cfg["roots"] = roots
    cfg["data_dirs"] = [absp(d) for d in cfg["data_dirs"]]
    # Matrix never indexes its own code: the install dir is always ignored,
    # under both its given and resolved (long-name) spellings.
    ign = [absp(d) for d in cfg["ignore_paths"]]
    for d in (HERE, os.path.realpath(HERE)):
        d = absp(d)
        if d.lower() not in (i.lower() for i in ign):
            ign.append(d)
    cfg["ignore_paths"] = ign
    cfg["out_dir"] = absp(cfg["out_dir"])
    cfg["_path"] = path
    return cfg


def argv(cfg):
    """The `--config` argument that reproduces cfg in a child script."""
    return ["--config", cfg["_path"]] if cfg.get("_path") else []
