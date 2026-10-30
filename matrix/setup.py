"""Install Matrix into a project (idempotent; rerun to update).

    python setup.py <target> [--config FILE] [--memory DIR] [--python EXE]
                    [--migrate-from OLD_DIR] [--replace-section HEADING]
                    [--no-build] [--no-launcher] [--launcher-dir DIR] [--dry-run]

Installs to <target>/.claude/matrix: copies the code, writes config.json,
owns two hooks in <target>/.claude/settings.json (SessionStart brief, Stop
rebuild), a marked block in <target>/CLAUDE.md and the `matrix` skill,
registers the target as a `home` universe in the Multiverse registry
($MATRIX_HOME/scopes.json, see scopes.py), installs the one-word `matrix`
launcher (matrix.cmd + a sh script on Windows, a sh script elsewhere) into
the first writable of ~/.local/bin (if on PATH) and
%LOCALAPPDATA%\\Programs\\matrix\\bin (Windows) / ~/.local/bin, recording this
install in $MATRIX_HOME/launcher.json, then builds the graph. PATH is never
edited: setup prints the one-liner when the folder is not on it.
Everything is computed before anything is written; a settings.json,
CLAUDE.md or config.json that changes is backed up first to *.matrix-bak
(never overwritten: later backups get a timestamp suffix), and a failed write
rolls back the files already written.
"""

from __future__ import annotations

import argparse
import codecs
import difflib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

import mxconfig

HERE = os.path.dirname(os.path.abspath(__file__))
BEGIN, END = "<!-- matrix:begin -->", "<!-- matrix:end -->"
SCRIPTS = ("indexer.py", "session_brief.py")


class SetupError(Exception):
    pass


def read(path):
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except FileNotFoundError:
        return None


def decode(raw, path):
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SetupError(f"{path} is not UTF-8 ({exc}); nothing was changed")


def eol_of(text):
    return "\r\n" if "\r\n" in text else "\n"


def same_dir(a, b):
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


# --------------------------------------------------------------------------
# code, config, memory
# --------------------------------------------------------------------------

def code_files(src):
    """Relative paths of the Matrix code: top-level *.py, viz/, templates/."""
    for name in sorted(os.listdir(src)):
        if name.endswith(".py") and os.path.isfile(os.path.join(src, name)):
            yield name
    for sub in ("viz", "templates"):
        for dirpath, dirnames, filenames in os.walk(os.path.join(src, sub)):
            dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
            for name in sorted(filenames):
                if not name.endswith(".pyc"):
                    yield os.path.relpath(os.path.join(dirpath, name), src)


def find_memory(target):
    """Claude Code's per-project memory folder for target, if it exists."""
    base = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    want = {re.sub(r"[:\\/]", "-", target).lower(),
            re.sub(r"[^A-Za-z0-9]", "-", target).lower()}
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return None
    for name in names:
        mem = os.path.join(base, name, "memory")
        if name.lower() in want and os.path.isdir(mem):
            return mem
    return None


def load_json_obj(raw, path):
    text = decode(raw, path).lstrip("\ufeff")

    def no_dupes(pairs):
        seen = set()
        for key, _value in pairs:
            if key in seen:
                raise SetupError(f"{path} has duplicate JSON key {key!r} (only one would "
                                 "survive a rewrite); fix it and rerun - nothing was changed")
            seen.add(key)
        return dict(pairs)

    try:
        data = json.loads(text, object_pairs_hook=no_dupes) if text.strip() else {}
    except ValueError as exc:
        raise SetupError(f"{path} is not valid JSON ({exc}); fix it and rerun - "
                         "nothing was changed")
    if not isinstance(data, dict):
        raise SetupError(f"{path} must hold a JSON object; nothing was changed")
    return data


# --------------------------------------------------------------------------
# settings.json hooks
# --------------------------------------------------------------------------

# a shell word: adjacent quoted / bare pieces ("$DIR"/x.py is one word); bare
# pieces end at whitespace or ; & | so a trailing `;cmd` / `&& cmd` is separate
TOKEN = re.compile(r'(?:"[^"]*"|\'[^\']*\'|[^\s"\';&|]+)+')


def canon(path):
    return os.path.normcase(os.path.realpath(path))


def runs(command, folder, script, target):
    """True if a hook command runs folder/script: any path-like token (quoted
    or bare, / or \\, absolute or relative to the project/$CLAUDE_PROJECT_DIR,
    8.3 or long form) whose basename is script and which resolves to it."""
    c = command
    for var in ("${CLAUDE_PROJECT_DIR}", "$CLAUDE_PROJECT_DIR", "%CLAUDE_PROJECT_DIR%"):
        c = c.replace(var, target)
    want = os.path.join(folder, script)
    for m in TOKEN.finditer(c):
        tok = m.group().replace('"', "").replace("'", "")
        for t in (tok, tok.split("=", 1)[-1]):      # also --opt=path
            if not t or os.path.basename(t.replace("\\", "/")).lower() != script.lower():
                continue
            p = os.path.join(target, os.path.expanduser(t))   # no-op if t is absolute
            if os.path.exists(p) and os.path.exists(want):
                if os.path.samefile(p, want):
                    return True
            elif canon(p) == canon(want):
                return True
    return False


def update_hooks(data, py, mx, old_dir, target, path):
    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise SetupError(f'{path}: "hooks" is not an object; nothing was changed')

    def entry(script, timeout, extra=""):
        cmd = f'"{py}" "{os.path.join(mx, script)}"' + extra
        return {"type": "command", "command": cmd, "timeout": timeout}

    ours = {
        "SessionStart": ("session_brief.py", {
            "matcher": "startup|resume|clear",
            "hooks": [entry("session_brief.py", 30)]}),
        "Stop": ("indexer.py", {
            "hooks": [entry("indexer.py", 180, " --if-stale --quiet")]}),
    }
    for event in ours:
        if event in hooks and not isinstance(hooks[event], list):
            raise SetupError(f'{path}: "hooks.{event}" is not a list; fix it and rerun '
                             "- nothing was changed")

    def owned(event, hook):
        cmd = hook.get("command") if isinstance(hook, dict) else None
        if not isinstance(cmd, str):
            return False
        if old_dir and any(runs(cmd, old_dir, s, target) for s in SCRIPTS):
            return True
        return event in ours and runs(cmd, mx, ours[event][0], target)

    placed = set()
    for event in list(hooks):
        groups = hooks[event]
        if not isinstance(groups, list):
            continue
        new, removed = [], False
        for group in groups:
            hs = group.get("hooks") if isinstance(group, dict) else None
            if not isinstance(hs, list):
                new.append(group)
                continue
            kept = [h for h in hs if not owned(event, h)]
            if len(kept) == len(hs):
                new.append(group)
                continue
            removed = True
            if event in ours and event not in placed:
                new.append(ours[event][1])          # in place of the first owned
                placed.add(event)
            if kept:
                new.append({**group, "hooks": kept})
        if removed:
            if new:
                hooks[event] = new
            else:
                del hooks[event]
    for event, (_script, group) in ours.items():
        if event not in placed:
            hooks.setdefault(event, []).append(group)


def indent_of(text):
    """The file's JSON indent (a string such as "    " or "\\t"), else 2."""
    m = re.search(r"\A\s*[{\[][ \t]*\r?\n([ \t]+)\S", text)
    return m.group(1) if m else 2


def plan_settings(path, py, mx, old_dir, target):
    raw = read(path)
    bom, eol, indent, data = b"", "\n", 2, {}
    if raw is not None:
        bom = codecs.BOM_UTF8 if raw.startswith(codecs.BOM_UTF8) else b""
        data = load_json_obj(raw, path)
        text = decode(raw, path).lstrip("\ufeff")
        eol, indent = eol_of(text), indent_of(text)
    update_hooks(data, py, mx, old_dir, target, path)
    text = json.dumps(data, indent=indent, ensure_ascii=False) + "\n"
    return bom + text.replace("\n", eol).encode("utf-8")


# --------------------------------------------------------------------------
# CLAUDE.md block
# --------------------------------------------------------------------------

def heading_level(line):
    m = re.match(r"(#{1,6})(?:\s|$)", line)
    return len(m.group(1)) if m else 0


def split_lines(text):
    """Lines with their endings, split on \\n only (offsets stay countable)."""
    return [s for s in re.split(r"(?<=\n)", text) if s]


def unfenced(lines):
    """Indices of lines outside ``` / ~~~ code fences (fence lines excluded)."""
    out, fence = [], None
    for i, line in enumerate(lines):
        st = line.lstrip()
        if fence:
            if st.startswith(fence):
                fence = None
        elif st.startswith(("```", "~~~")):
            fence = st[:3]
        else:
            out.append(i)
    return out


def markers(text, path):
    """(begin, end) offsets of the one marker pair, None if absent; markers
    inside code fences are examples, not live."""
    lines = split_lines(text)
    offs = [0]
    for line in lines:
        offs.append(offs[-1] + len(line))
    live = unfenced(lines)
    begins = [offs[i] for i in live if lines[i].startswith(BEGIN)]
    ends = [offs[i] for i in live if lines[i].startswith(END)]
    if not begins and not ends:
        return None
    if len(begins) != 1 or len(ends) != 1 or ends[0] < begins[0]:
        raise SetupError(f"{path}: expected exactly one {BEGIN} ... {END} pair, "
                         f"found {len(begins)} begin / {len(ends)} end; fix it by "
                         "hand and rerun - nothing was changed")
    return begins[0], ends[0]


def find_section(lines, want, skip=range(0)):
    """(start, end) line indices of the first section whose heading is `want`
    or `want` followed by a space or "(" - outside code fences and the `skip`
    lines, which also end a section - else None."""
    level = heading_level(want)
    start, fence = None, None
    for i, line in enumerate(lines):
        if i in skip:
            if start is not None:
                return start, i
            continue
        s = line.rstrip("\r\n")
        st = s.lstrip()
        if fence:
            if st.startswith(fence):
                fence = None
            continue
        if st.startswith(("```", "~~~")):
            fence = st[:3]
            continue
        if start is None:
            s = s.rstrip()
            if s == want or (s.startswith(want) and s[len(want)] in " \t("):
                start = i
        elif 0 < heading_level(s) <= level:
            return start, i
    return None if start is None else (start, len(lines))


def plan_claude_md(path, block, heading):
    """New CLAUDE.md text; bytes outside the replaced region are untouched.
    A marker block is replaced in place (and a legacy `heading` section still
    present elsewhere is removed); else the `heading` section is replaced;
    else, without --replace-section, the block is appended."""
    raw = read(path)
    text = decode(raw, path) if raw is not None else ""
    bom = "\ufeff" if text.startswith("\ufeff") else ""
    text = text[len(bom):]
    eol = eol_of(text)
    blk = block.replace("\n", eol)
    want = heading.strip() if heading else None
    if want and not heading_level(want):
        raise SetupError(f"--replace-section {heading!r} is not a markdown heading")

    pair = markers(text, path)
    if pair:
        note = "replaced block"
        if want:
            lines = split_lines(text)
            b = text.count("\n", 0, pair[0])
            e = text.count("\n", 0, pair[1])
            sec = find_section(lines, want, skip=range(b, e + 1))
            if sec:
                start, end = sec
                head = lines[:start]
                if end == len(lines):                  # section ran to EOF
                    while head and not head[-1].strip():
                        head.pop()
                text = "".join(head + lines[end:])
                pair = markers(text, path)
                note += f"; removed legacy section {lines[start].strip()!r}"
        return bom + text[:pair[0]] + blk + text[pair[1] + len(END):], note

    if want:
        lines = split_lines(text)
        sec = find_section(lines, want)
        if not sec:
            raise SetupError(f"--replace-section {want!r}: no such heading and no "
                             f"{BEGIN} block in {path}; nothing was changed")
        start, end = sec
        while end > start + 1 and not lines[end - 1].strip():
            end -= 1                                  # keep the blank separator
        last = lines[end - 1]
        tail = last[len(last.rstrip("\r\n")):]
        return (bom + "".join(lines[:start]) + blk + tail + "".join(lines[end:]),
                f"replaced section {lines[start].strip()!r}")

    if not text:
        return bom + blk + eol, "created"
    if not text.endswith("\n"):
        text += eol
    if not text.endswith(("\n\n", "\n\r\n")):
        text += eol
    return bom + text + blk + eol, "appended"


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def absolutize(cfg, base):
    """Make relative roots / memory / ignore_paths / data_dirs absolute against
    base (the source config's folder), so the copy still points at the same
    folders; out_dir stays install-relative. Returns [(key, old, new)]."""
    done = []

    def fix(key, p):
        if not isinstance(p, str) or not p or os.path.isabs(os.path.expanduser(p)):
            return p
        new = os.path.normpath(os.path.join(base, p)).replace("\\", "/")
        done.append((key, p, new))
        return new

    if isinstance(cfg.get("roots"), list):
        cfg["roots"] = [{**r, "path": fix("roots", r.get("path"))} if isinstance(r, dict)
                        else fix("roots", r) for r in cfg["roots"]]
    if "memory" in cfg:
        cfg["memory"] = fix("memory", cfg["memory"])
    for key in ("ignore_paths", "data_dirs"):
        if isinstance(cfg.get(key), list):
            cfg[key] = [fix(key, p) for p in cfg[key]]
    return done


def backup_path(path):
    """path.matrix-bak if free, else a timestamped name; never an existing file."""
    bak = path + ".matrix-bak"
    stamp, n = time.strftime("%Y%m%d-%H%M%S"), 0
    while os.path.exists(bak):
        n += 1
        bak = f"{path}.matrix-bak.{stamp}" + (f"-{n - 1}" if n > 1 else "")
    return bak


def write_bytes(path, data, like=None):
    """Atomic replace via a temp file, keeping like's permission bits."""
    tmp = path + ".matrix-tmp"
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
        if like is not None:
            shutil.copymode(like, tmp)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.chmod(tmp, 0o600)                    # copymode may have made it read-only
            os.remove(tmp)


def render(template, subs):
    with open(template, encoding="utf-8") as fh:
        text = fh.read()
    if os.sep == "/":
        text = text.replace("\\", "/")
    for key, value in subs.items():
        text = text.replace("{" + key + "}", value)
    return text


# --------------------------------------------------------------------------
# `matrix` launcher
# --------------------------------------------------------------------------

# $MATRIX_HOME/launcher/matrix_entry.py: the stable entry the scripts run. It
# follows launcher.json, so the most recently registered install wins.
ENTRY = '''"""Matrix launcher entry (written by setup.py): runs matrix.py of the install
recorded in $MATRIX_HOME/launcher.json with the interpreter recorded there."""
import json, os, runpy, subprocess, sys

home = os.environ.get("MATRIX_HOME") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ["MATRIX_HOME"] = home
try:
    with open(os.path.join(home, "launcher.json"), encoding="utf-8") as fh:
        rec = json.load(fh)
    script = os.path.join(rec["install"], "matrix.py")
except (OSError, ValueError, KeyError, TypeError) as exc:
    sys.exit(f"matrix: no install recorded in {home}/launcher.json ({exc}); rerun setup.py")
if not os.path.isfile(script):
    sys.exit(f"matrix: {script} is gone (install moved or removed); rerun setup.py")
py = rec.get("python") or sys.executable
if os.path.isfile(py) and os.path.normcase(os.path.abspath(py)) != os.path.normcase(sys.executable):
    sys.exit(subprocess.call([py, script, *sys.argv[1:]]))
sys.path.insert(0, rec["install"])
sys.argv = [script, *sys.argv[1:]]
runpy.run_path(script, run_name="__main__")
'''


def on_path(folder):
    want = os.path.normcase(os.path.realpath(folder))
    return any(os.path.normcase(os.path.realpath(p)) == want
               for p in os.environ.get("PATH", "").split(os.pathsep) if p)


def writable_dir(folder):
    try:
        os.makedirs(folder, exist_ok=True)
        probe = os.path.join(folder, f".matrix-probe-{os.getpid()}")
        with open(probe, "w"):
            pass
        os.remove(probe)
        return True
    except OSError:
        return False


def launcher_dir(override=None, check=writable_dir):
    """Where `matrix` goes: --launcher-dir, else the first writable of
    ~/.local/bin (only if on PATH) and the per-OS default."""
    if override:
        return os.path.abspath(os.path.expanduser(override))
    local = os.path.join(os.path.expanduser("~"), ".local", "bin")
    cands = [local] if on_path(local) else []
    if os.name == "nt":
        cands.append(os.path.join(os.environ.get("LOCALAPPDATA")
                                  or os.path.join(os.path.expanduser("~"), "AppData", "Local"),
                                  "Programs", "matrix", "bin"))
    else:
        cands.append(local)
    for c in cands:
        if check(c):
            return c
    raise SetupError("no writable folder for the `matrix` launcher: " + ", ".join(cands))


def path_hint(folder):
    if os.name == "nt":
        return ('powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable(\'Path\', '
                "[Environment]::GetEnvironmentVariable('Path', 'User') + ';" + folder
                + "', 'User')\"   (then open a new terminal)")
    return f"echo 'export PATH=\"{folder}:$PATH\"' >> ~/.profile   (then open a new terminal)"


def launcher_files(py, mx, folder):
    """{path: bytes} of the launcher: scripts in folder, entry + record in $MATRIX_HOME."""
    import scopes
    home = scopes.home()
    entry = os.path.join(home, "launcher", "matrix_entry.py")
    fs = lambda p: p.replace("\\", "/")            # noqa: E731 - Git Bash / sh take C:/x paths
    sh = f'#!/bin/sh\n# Matrix launcher (setup.py)\nexec "{fs(py)}" "{fs(entry)}" "$@"\n'
    files = {entry: ENTRY.encode("utf-8"),
             os.path.join(home, "launcher.json"): (json.dumps(
                 {"python": py, "install": mx, "registered": time.strftime("%Y-%m-%dT%H:%M:%S")},
                 indent=2) + "\n").encode("utf-8"),
             os.path.join(folder, "matrix"): sh.encode("utf-8")}
    if os.name == "nt":
        files[os.path.join(folder, "matrix.cmd")] = (
            f'@echo off\r\nrem Matrix launcher (setup.py)\r\n"{py}" "{entry}" %*\r\n').encode("utf-8")
    return files


def install_launcher(py, mx, folder):
    for path, data in launcher_files(py, mx, folder).items():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write_bytes(path, data)
        if os.path.basename(path) == "matrix":
            os.chmod(path, 0o755)
    return folder


def main(argv=None):
    ap = argparse.ArgumentParser(description="Install Matrix into a project.")
    ap.add_argument("target", help="project folder")
    ap.add_argument("--config", help="config file to install as <install>/config.json")
    ap.add_argument("--memory", help="notes folder to index (default: Claude Code's "
                                     "memory folder for the target, if any)")
    ap.add_argument("--python", help="interpreter for hooks and build "
                                     "(default: this one)")
    ap.add_argument("--migrate-from", metavar="OLD_DIR",
                    help="remove hooks running OLD_DIR's indexer.py / session_brief.py")
    ap.add_argument("--replace-section", metavar="HEADING",
                    help='CLAUDE.md section to replace with the Matrix block, e.g. "## Knowledge '
                         'store" (also matches "## Knowledge store (...)"); an error if '
                         'neither it nor a Matrix block is found')
    ap.add_argument("--no-build", action="store_true", help="skip the initial graph build")
    ap.add_argument("--no-launcher", action="store_true",
                    help="do not install the one-word `matrix` launcher")
    ap.add_argument("--launcher-dir", metavar="DIR",
                    help="folder for the `matrix` launcher (default: see above)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, write nothing")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")      # diffs may hold non-ASCII text

    try:
        target = os.path.abspath(args.target)
        if not os.path.isdir(target):
            raise SetupError(f"target {target} is not a folder")
        mx = os.path.join(target, ".claude", "matrix")
        py = (os.path.abspath(shutil.which(args.python) or args.python) if args.python
              else sys.executable)
        if not os.path.isfile(py):
            raise SetupError(f"--python {args.python or py}: not on PATH and no such file")
        old_dir = os.path.abspath(args.migrate_from) if args.migrate_from else None
        changes = []  # (path, new bytes, old bytes or None, backup?)

        def plan(path, new, backup=False):
            old = read(path)
            if old != new:
                changes.append((path, new, old, backup))

        # 1. code
        n_code = 0
        if not (os.path.isdir(mx) and same_dir(HERE, mx)):
            for rel in code_files(HERE):
                before = len(changes)
                plan(os.path.join(mx, rel), read(os.path.join(HERE, rel)))
                n_code += len(changes) - before

        # 2. config
        cfg_path = os.path.join(mx, "config.json")
        rewritten = []
        if args.config:
            raw = read(args.config)
            if raw is None:
                raise SetupError(f"--config {args.config} not found")
            cfg = load_json_obj(raw, args.config)
            rewritten = absolutize(cfg, os.path.dirname(os.path.abspath(args.config)))
            if rewritten:                          # else copy the bytes verbatim
                text = decode(raw, args.config).lstrip("﻿")
                raw = (json.dumps(cfg, indent=indent_of(text), ensure_ascii=False)
                       + "\n").replace("\n", eol_of(text)).encode("utf-8")
            plan(cfg_path, raw, backup=True)
        elif os.path.isfile(cfg_path):
            cfg = load_json_obj(read(cfg_path), cfg_path)
        else:
            memory = os.path.abspath(args.memory) if args.memory else find_memory(target)
            cfg = {"title": "Matrix", "roots": [target.replace("\\", "/")]}
            if memory:
                cfg["memory"] = memory.replace("\\", "/")
            cfg["ignore_paths"] = ["."]               # keep Matrix's own code out
            cfg["out_dir"] = "out"
            plan(cfg_path, (json.dumps(cfg, indent=2) + "\n").encode("utf-8"))
        out = os.path.normpath(os.path.join(mx, os.path.expanduser(
            cfg.get("out_dir") or mxconfig.DEFAULTS["out_dir"])))
        graph_html = os.path.join(out, "graph.html")

        # 3-6. templates, CLAUDE.md, skill, settings
        # one opener for every OS and shell (PowerShell needs a leading `& `)
        opener = f'"{py}" -m webbrowser "{pathlib.Path(graph_html).as_uri()}"'
        subs = {"PY": py, "MX": mx, "CONFIG": cfg_path, "OUT": out, "OPEN": opener}
        templates = os.path.join(HERE, "templates")
        block = render(os.path.join(templates, "claude_md_section.md"), subs).rstrip("\r\n")
        claude_md = os.path.join(target, "CLAUDE.md")
        new_md, md_note = plan_claude_md(claude_md, block, args.replace_section)
        plan(claude_md, new_md.encode("utf-8"), backup=True)
        plan(os.path.join(target, ".claude", "skills", "matrix", "SKILL.md"),
             render(os.path.join(templates, "SKILL.md"), subs).encode("utf-8"))
        settings = os.path.join(target, ".claude", "settings.json")
        plan(settings, plan_settings(settings, py, mx, old_dir, target), backup=True)
        bin_dir = None if args.no_launcher else launcher_dir(args.launcher_dir)
    except SetupError as exc:
        print(f"setup: error: {exc}", file=sys.stderr)
        return 2

    # report / apply
    def show(path):
        return os.path.relpath(path, target)

    other = [c for c in changes if not (c[0].startswith(mx + os.sep) and c[0] != cfg_path)]
    for key, old_p, new_p in rewritten:
        print(f"  config: {key} {old_p!r} -> {new_p!r} (relative to {args.config})")
    if args.dry_run:
        print(f"Matrix setup plan for {target} (dry run, nothing written)")
        if n_code:
            print(f"  copy    {n_code} code file(s) -> {show(mx)}")
        for path, new, old, backup in other:
            print(f"  {'create' if old is None else 'update'}  {show(path)}"
                  + (f" (+ backup {show(backup_path(path))})"
                     if backup and old is not None else ""))
            if path in (settings, claude_md):
                a = (old or b"").decode("utf-8", "replace").splitlines(keepends=True)
                b = new.decode("utf-8", "replace").splitlines(keepends=True)
                sys.stdout.writelines("      " + line.rstrip("\r\n") + "\n" for line in
                                      difflib.unified_diff(a, b, show(path), show(path)))
        if not changes:
            print("  nothing to change")
        print(f"  CLAUDE.md: {md_note}")
        if bin_dir:
            for path in launcher_files(py, mx, bin_dir):
                print(f"  launcher {path}")
        if not args.no_build:
            print(f"  build   {py} {os.path.join(mx, 'indexer.py')} --full --quiet")
        return 0

    written, backups = [], {}                       # (path, old bytes) / path -> backup
    try:
        for path, new, old, backup in changes:      # settings.json is last
            os.makedirs(os.path.dirname(path), exist_ok=True)
            if backup and old is not None:
                bak = backup_path(path)
                with open(bak, "xb") as fh:         # "x": never overwrite a backup
                    fh.write(old)
                backups[path] = bak
            write_bytes(path, new, like=path if old is not None else None)
            written.append((path, old))
    except BaseException as exc:
        failed = []
        for path, old in reversed(written):         # put back what we changed
            try:
                if old is None:
                    os.remove(path)
                else:
                    write_bytes(path, old, like=path)
            except OSError as exc2:
                failed.append(f"{path} ({exc2})")
        print(f"setup: error: writing failed ({exc!r}); "
              + (f"rolled back {len(written)} file(s)" if not failed else
                 "COULD NOT roll back " + ", ".join(failed) + " - restore from "
                 "the .matrix-bak file(s)"), file=sys.stderr)
        if not isinstance(exc, Exception):
            raise
        return 1

    print(f"Matrix installed in {mx}")
    if n_code:
        print(f"  copied  {n_code} code file(s)")
    for path, _new, old, backup in other:
        print(f"  {'created' if old is None else 'updated'} {show(path)}"
              + (f" (backup: {show(backups[path])})" if path in backups else ""))
    if not changes:
        print("  no file changes")
    print(f"  CLAUDE.md: {md_note}")
    try:                                          # multiverse registry: never fails setup
        import scopes
        home = scopes.register_home(mx, cfg_path, root=target, python=py)
        print(f"  universe {home['id']} (home) in {scopes.registry_path()}")
    except Exception as exc:
        print(f"  (multiverse registry not updated: {type(exc).__name__}: {exc})")
    launcher = None
    if bin_dir:                                   # never fails setup either
        try:
            launcher = install_launcher(py, mx, bin_dir)
            print(f"  launcher `matrix` in {launcher}")
        except Exception as exc:
            print(f"  (launcher not installed: {type(exc).__name__}: {exc})")

    if not args.no_build:
        print("Building the graph ...", flush=True)
        rc = subprocess.call([py, os.path.join(mx, "indexer.py"), "--full", "--quiet"])
        if rc:
            print(f"setup: error: graph build failed (exit {rc}); rerun "
                  f'"{py}" "{os.path.join(mx, "indexer.py")}" --full', file=sys.stderr)
            return 1
    print(f"Universe: {graph_html}")
    if launcher:
        print("Open the Multiverse from any terminal with:  matrix")
        if not on_path(launcher):
            print(f"  {launcher} is not on PATH yet; add it with:\n    {path_hint(launcher)}")
    print(f'Multiverse engine: "{py}" "{os.path.join(mx, "serve.py")}" --open')
    return 0


if __name__ == "__main__":
    sys.exit(main())
