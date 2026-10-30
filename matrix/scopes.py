"""Multiverse registry: every Matrix universe (indexed root) of this user.

    python scopes.py list
    python scopes.py add <root> [--name N]
    python scopes.py rename <id> <name>
    python scopes.py remove <id>
    python scopes.py build <id> [--if-stale] [--force]

File: $MATRIX_HOME/scopes.json (MATRIX_HOME = env var, else ~/.claude/matrix),
shared by every install. `home` scopes are folders setup.py installed Matrix
into; `central` scopes keep config + out in $MATRIX_HOME/scopes/<id>/ and
write nothing into the scoped folder. Writes are atomic (tmp + os.replace)
under a lock file; readers never lock. docs/SERVICES.md documents the format.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

import mxconfig

HERE = os.path.dirname(os.path.abspath(__file__))
WARN_FILES = 50_000
WARN_BYTES = 5 * 1024 ** 3
PREFLIGHT_SECONDS = 5.0
PUBLIC_DROP = ("config",)            # never shown to the page
_tlock = threading.RLock()           # in-process writers (serve.py threads)


class ScopeError(Exception):
    pass


# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------

def home():
    return os.path.abspath(os.path.expanduser(
        os.environ.get("MATRIX_HOME") or os.path.join("~", ".claude", "matrix")))


def registry_path():
    return os.path.join(home(), "scopes.json")


def central_dir():
    return os.path.join(home(), "scopes")


def fwd(path):
    """Absolute, resolved (long-name), forward-slash form used on disk."""
    return os.path.realpath(os.path.abspath(os.path.expanduser(path))).replace("\\", "/")


def key(path):
    """Comparison key: one value for every spelling of the same folder."""
    return os.path.normcase(os.path.realpath(os.path.abspath(os.path.expanduser(path))))


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:40] or "root"


def scope_id(name, root):
    return slug(name) + "-" + hashlib.sha1(key(root).encode("utf-8")).hexdigest()[:6]


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def default_name(root):
    r = fwd(root).rstrip("/")
    return os.path.basename(r) or r or "root"


def inside(child, parent):
    """True if child is parent or below it (both resolved)."""
    try:
        c, p = key(child), key(parent)
        return os.path.commonpath([c, p]) == p
    except ValueError:                  # different drives
        return False


# --------------------------------------------------------------------------
# load / save
# --------------------------------------------------------------------------

def _retry(fn, tries=40, delay=0.025):
    """Windows refuses to open/replace a file another process holds open for
    a moment; retry briefly instead of failing."""
    for i in range(tries):
        try:
            return fn()
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(delay)


def load():
    """Registry dict {"version", "scopes"}; empty if the file is absent."""
    path = registry_path()

    def rd():
        with open(path, encoding="utf-8-sig") as fh:
            return fh.read()
    try:
        text = _retry(rd)
    except FileNotFoundError:
        return {"version": 1, "scopes": []}
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise ScopeError(f"registry unreadable: {path} is not valid JSON ({exc}); "
                         "fix or delete it")
    if not isinstance(data, dict) or not isinstance(data.get("scopes"), list):
        raise ScopeError(f"registry unreadable: {path} has no \"scopes\" list; "
                         "fix or delete it")
    data["scopes"] = [s for s in data["scopes"] if isinstance(s, dict) and s.get("id")]
    return data


def save(data):
    path = registry_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            json.dump({"version": 1, "scopes": data["scopes"]}, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        _retry(lambda: os.replace(tmp, path))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


class _Locked:
    """Cross-process lock file around read-modify-write; a lock older than
    STALE seconds is a crashed writer's and is broken."""
    STALE = 30.0

    def __init__(self, timeout=15.0):
        self.timeout = timeout
        self.path = registry_path() + ".lock"

    def __enter__(self):
        _tlock.acquire()
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        end = time.monotonic() + self.timeout
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return self
            except (FileExistsError, PermissionError):
                try:
                    if time.time() - os.path.getmtime(self.path) > self.STALE:
                        os.remove(self.path)
                        continue
                except OSError:
                    pass
                if time.monotonic() > end:
                    _tlock.release()
                    raise ScopeError(f"registry is locked ({self.path}); retry, or delete "
                                     "the lock file if no Matrix process is running")
                time.sleep(0.03)

    def __exit__(self, *exc):
        try:
            os.remove(self.path)
        except OSError:
            pass
        _tlock.release()


def public(scope):
    return {k: v for k, v in scope.items() if k not in PUBLIC_DROP}


def embed(current=None, building=None, strict=False):
    """The MX_SCOPES object: registry entries without config (+ building).
    strict: an unreadable registry raises ScopeError instead of listing none."""
    out = []
    for s in (load()["scopes"] if strict else all_scopes()):
        p = public(s)
        if building is not None:
            p["building"] = s["id"] in building
        out.append(p)
    return {"current": current, "scopes": out}


def script_json(obj):
    """JSON safe inside an inline <script>: no '<' (so no </script> or <!--),
    no U+2028/9 line separators, and '/' as '\\/' so no text in it can match
    a viz.py template placeholder (//__JS__, /*__CSS__*/)."""
    return (json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
            .replace("<", "\\u003c").replace("/", "\\/")
            .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


def all_scopes():
    try:
        return load()["scopes"]
    except ScopeError:
        return []


def get(sid):
    return next((s for s in load()["scopes"] if s["id"] == sid), None)


def find_root(root, scopes=None):
    k = key(root)
    return next((s for s in (load()["scopes"] if scopes is None else scopes)
                 if key(s["root"]) == k), None)


def scope_for_out(out_dir):
    k = key(out_dir)
    return next((s for s in all_scopes() if s.get("out") and key(s["out"]) == k), None)


# --------------------------------------------------------------------------
# operations
# --------------------------------------------------------------------------

def _new_id(name, root, scopes):
    sid = scope_id(name, root)
    if any(s["id"] == sid for s in scopes):          # same slug + hash prefix
        sid = slug(name) + "-" + hashlib.sha1(key(root).encode("utf-8")).hexdigest()[:12]
    return sid


def is_unc(path):
    """\\\\server\\share, //server/share and \\\\?\\ paths: opening one makes Windows
    send the user's NTLM credentials to that host. Mapped drive letters are fine."""
    return isinstance(path, str) and path.strip()[:2] in ("\\\\", "//", "\\/", "/\\")


def add(root, name=None, python=None, allow_unc=False):
    """(scope, existing). A root already registered (any spelling) is returned
    as is; else a new central scope with its generated config."""
    if not isinstance(root, str) or not root.strip():
        raise ScopeError("Enter a folder path (or use Browse).")
    if is_unc(root) and not allow_unc:
        raise ScopeError("network (UNC) paths are refused: map the share to a drive "
                         "letter, or start the engine with --allow-unc")
    root = os.path.expanduser(root.strip())
    if re.fullmatch(r"[A-Za-z]:", root):          # "C:" alone is the drive's cwd: mean its root
        root += os.sep
    if not os.path.isabs(root):
        raise ScopeError(f"Use a full path, e.g. C:\\path\\to\\folder (got {root!r})")
    if not os.path.isdir(root):
        raise ScopeError(f"No such folder: {root}")
    if name is not None:
        name = clean_name(name)
    with _Locked():
        data = load()
        hit = find_root(root, data["scopes"])
        if hit:
            return hit, True
        name = name or default_name(root)
        sid = _new_id(name, root, data["scopes"])
        folder = os.path.join(central_dir(), sid)
        scope = {"id": sid, "name": name, "root": fwd(root), "kind": "central",
                 "install": HERE.replace("\\", "/"),
                 "config": os.path.join(folder, "config.json").replace("\\", "/"),
                 "out": os.path.join(folder, "out").replace("\\", "/"),
                 "python": (python or sys.executable).replace("\\", "/"),
                 "added": now(), "built": None, "nodes": None, "edges": None,
                 "communities": None}
        write_config(scope, data["scopes"])
        data["scopes"].append(scope)
        save(data)
        return scope, False


def clean_name(name):
    if not isinstance(name, str):
        raise ScopeError("name must be a string")
    name = " ".join(name.split())
    if not name or len(name) > 100 or any(ord(c) < 32 for c in name):
        raise ScopeError("name must be 1-100 printable characters")
    return name


def rename(sid, name):
    name = clean_name(name)
    with _Locked():
        data = load()
        s = next((s for s in data["scopes"] if s["id"] == sid), None)
        if not s:
            raise KeyError(sid)
        s["name"] = name
        if s["kind"] == "central":
            write_config(s, data["scopes"])
        save(data)
        return s


def remove(sid):
    """Unregister. central: also delete $MATRIX_HOME/scopes/<id>/ - only after
    proving that folder is a direct child of $MATRIX_HOME/scopes. home: the
    install is never touched."""
    with _Locked():
        data = load()
        s = next((s for s in data["scopes"] if s["id"] == sid), None)
        if not s:
            raise KeyError(sid)
        folder = None
        if s["kind"] == "central":
            folder = safe_central_folder(sid)
        data["scopes"] = [x for x in data["scopes"] if x["id"] != sid]
        save(data)
    if folder and os.path.isdir(folder):
        shutil.rmtree(folder, onerror=lambda f, p, e: (os.chmod(p, 0o700), f(p)))
    return s


def safe_central_folder(sid):
    """$MATRIX_HOME/scopes/<sid>, refused unless it resolves to a direct child
    of $MATRIX_HOME/scopes (no '..', separators, links out, or the base itself)."""
    if not isinstance(sid, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,80}", sid):
        raise ScopeError(f"refusing to delete: bad scope id {sid!r}")
    base = os.path.realpath(central_dir())
    folder = os.path.realpath(os.path.join(base, sid))
    if (os.path.normcase(os.path.dirname(folder)) != os.path.normcase(base)
            or os.path.normcase(os.path.basename(folder)) != os.path.normcase(sid)):
        raise ScopeError(f"refusing to delete {folder}: not inside {base}")
    return folder


def out_of(scope):
    """The out dir to serve: a central scope's is always derived from its id."""
    if scope.get("kind") == "home":
        return scope.get("out")
    return os.path.join(safe_central_folder(scope["id"]), "out")


def register_home(install_dir, config, root=None, name=None, python=None):
    """Add or update the `home` scope of a setup.py install (idempotent; a
    rerun refreshes install/config/out/python, keeps id, name and stats)."""
    install_dir = os.path.abspath(install_dir)
    root = root or os.path.dirname(os.path.dirname(install_dir))
    out = mxconfig.load(config)["out_dir"]
    orphan = None
    with _Locked():
        data = load()
        s = find_root(root, data["scopes"])
        if s is not None and s.get("kind") == "central":
            orphan = safe_central_folder(s["id"])   # its central config + out
        if s is None:
            n = name or default_name(root)
            s = {"id": _new_id(n, root, data["scopes"]), "name": n, "added": now(),
                 "built": None, "nodes": None, "edges": None, "communities": None}
            data["scopes"].append(s)
        s.update({"root": fwd(root), "kind": "home", "install": fwd(install_dir),
                  "config": fwd(config), "out": fwd(out),
                  "python": fwd(python or sys.executable)})
        save(data)
    if orphan and os.path.isdir(orphan):
        shutil.rmtree(orphan, onerror=lambda f, p, e: (os.chmod(p, 0o700), f(p)))
    return s


def update_stats(out_dir, nodes, edges, communities, built=None, timeout=3.0):
    """Record build stats on the scope whose out is out_dir. No registry or
    no match -> nothing (never creates the file)."""
    if not os.path.isfile(registry_path()):
        return None
    with _Locked(timeout):
        data = load()
        k = key(out_dir)
        s = next((s for s in data["scopes"] if s.get("out") and key(s["out"]) == k), None)
        if not s:
            return None
        s.update({"built": built or now(), "nodes": nodes, "edges": edges,
                  "communities": communities})
        save(data)
        return s


# --------------------------------------------------------------------------
# central config, preflight, build
# --------------------------------------------------------------------------

def matrix_dirs(scopes):
    """Folders a universe must never index: MATRIX_HOME and every install."""
    dirs = [fwd(home()), fwd(HERE)]
    dirs += [fwd(s["install"]) for s in scopes if s.get("kind") == "home" and s.get("install")]
    out = []
    for d in dirs:
        if d.lower() not in (o.lower() for o in out):
            out.append(d)
    return out


# A whole drive (C:\\, /) skips the OS and program folders by default.
DRIVE_IGNORE_PATHS = ["Windows", "Program Files", "Program Files (x86)", "ProgramData",
                      "$Recycle.Bin", "$RECYCLE.BIN", "System Volume Information", "Recovery",
                      "PerfLogs", "$WinREAgent", "MSOCache"]
POSIX_IGNORE_PATHS = ["proc", "sys", "dev", "run", "tmp", "var", "usr", "bin", "sbin", "lib",
                      "lib64", "boot", "snap", "opt", "System", "Library", "private", "Volumes",
                      "cores"]
DRIVE_IGNORE_DIRS = ["AppData", "$RECYCLE.BIN", "$Recycle.Bin", "System Volume Information"]


def is_drive_root(root):
    r = fwd(root)
    return bool(re.fullmatch(r"[A-Za-z]:/?", r)) or r == "/"


def ignores(root):
    """(ignore_dirs, ignore_paths) a central scope of root gets by default."""
    dirs = list(mxconfig.DEFAULTS["ignore_dirs"])
    paths = []
    if is_drive_root(root):
        base = fwd(root).rstrip("/")
        names = POSIX_IGNORE_PATHS if base == "" else DRIVE_IGNORE_PATHS
        paths = [f"{base}/{n}" for n in names]
        extra = DRIVE_IGNORE_DIRS
    else:
        extra = ["$RECYCLE.BIN", "System Volume Information"]
    dirs += [d for d in extra if d not in dirs]
    return dirs, paths


def log_path(scope):
    """Where a build's full log is kept: central -> $MATRIX_HOME/scopes/<id>/,
    home -> the install's out dir."""
    if scope.get("kind") == "home":
        return os.path.join(scope.get("out") or "", "last_build.log")
    return os.path.join(safe_central_folder(scope["id"]), "last_build.log")


def write_config(scope, scopes=None):
    """(Re)write a central scope's config.json; refreshed before each build so
    installs registered later are ignored too."""
    scopes = all_scopes() if scopes is None else scopes
    folder = safe_central_folder(scope["id"])     # never a path read from the registry
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "config.json")
    root = scope["root"]
    dirs, paths = ignores(root)
    cfg = {"title": scope["name"],
           "roots": [root],                       # label = folder name, as for a home
           "ignore_dirs": dirs,
           "ignore_paths": matrix_dirs(scopes) + paths,
           "out_dir": "out"}
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(cfg, fh, indent=2)
        fh.write("\n")
    _retry(lambda: os.replace(tmp, path))


def preflight(root, max_files=None, max_seconds=PREFLIGHT_SECONDS, cap=None):
    """Bounded count of what a build would walk: {files, bytes, warn, cap,
    partial}. Counting stops just past the max_files cap (or at max_files, or
    after max_seconds); counts are then lower bounds and partial is true."""
    cap = mxconfig.DEFAULTS["max_files"] if cap is None else cap
    limit = max_files or (cap + 1 if cap else WARN_FILES + 1)
    dirs, paths = ignores(root)
    ign_dirs = set(dirs)
    globs = mxconfig.DEFAULTS["ignore_globs"]
    blocked = [key(d) for d in matrix_dirs(all_scopes()) + paths]
    files = size = 0
    end = time.monotonic() + max_seconds
    stack, cut = [root], None
    while stack:
        d = stack.pop()
        if key(d) in blocked:
            continue
        try:
            with os.scandir(d) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            if (e.name not in ign_dirs and not e.name.endswith(".egg-info")
                                    and not e.is_symlink()
                                    and not (hasattr(e, "is_junction") and e.is_junction())):
                                stack.append(e.path)
                        elif e.is_file() and not any(fnmatch.fnmatch(e.name, g) for g in globs):
                            files += 1
                            size += e.stat().st_size
                    except OSError:
                        continue
        except OSError:
            continue
        if files >= limit:
            cut = "files"
            break
        if time.monotonic() > end:
            cut = "time"
            break
    gb = f"{size / 1024 ** 3:.1f} GB"
    capt = f"cap {cap:,} files" if cap else "no file cap"
    warn = None
    if cap and files > cap:
        warn = (f"{files:,}+ files, over the max_files cap of {cap:,}: a build would be "
                "slow and the graph too large to read")
    elif cut == "time":
        warn = (f"{files:,}+ files and ≥ {gb} counted in {max_seconds:.0f}s (stopped "
                f"counting; {capt}): a build may take a long time")
    elif cut or files > WARN_FILES:
        warn = (f"{files:,}{'+' if cut else ''} files ({capt}): a build may take a long "
                "time and a large graph")
    elif size > WARN_BYTES:
        warn = f"{files:,} files, {gb} ({capt}): a build may take a long time"
    return {"files": files, "bytes": size, "warn": warn, "cap": cap, "partial": bool(cut),
            "over": bool(cap and files > cap)}


def build_cmd(scope, if_stale=False, python=None, force=False, full=True):
    """argv of the indexer run for a scope: a home scope uses its own install's
    indexer (the one its hooks run), a central one this install's. force:
    past the max_files cap (the user confirmed); full=False: incremental."""
    indexer = os.path.join(scope.get("install") or HERE, "indexer.py")
    if scope.get("kind") != "home" or not os.path.isfile(indexer):
        indexer = os.path.join(HERE, "indexer.py")
    config = scope["config"]
    if scope.get("kind") != "home":
        config = os.path.join(safe_central_folder(scope["id"]), "config.json")
    py = python or sys.executable
    if scope.get("kind") == "home" and scope.get("python") and os.path.isfile(scope["python"]):
        py = scope["python"]
    mode = ["--if-stale"] if if_stale else ["--full"] if full else []
    return [py, indexer, "--config", config, *mode] + (["--force"] if force else [])


def prepare(sid):
    """Scope ready to build (central config refreshed); KeyError if unknown."""
    s = get(sid)
    if not s:
        raise KeyError(sid)
    if s["kind"] == "central":
        write_config(s)
    elif not os.path.isfile(s.get("config") or ""):
        raise ScopeError(f"home install config missing: {s.get('config')}")
    return s


SUMMARY = re.compile(r"knowledge graph: (\d+) nodes, (\d+) edges, (\d+) communities")


def build_env():
    return dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1",
                MATRIX_HOME=home())


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _fmt(s):
    st = (f"{s['nodes']} nodes, {s['edges']} edges, built {s['built']}"
          if s.get("built") else "not built")
    return f"{s['id']:<28} {s['kind']:<8} {s['name']}\n{'':<38}{s['root']}  ({st})"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Matrix Multiverse registry.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    a = sub.add_parser("add")
    a.add_argument("root")
    a.add_argument("--name")
    r = sub.add_parser("rename")
    r.add_argument("id")
    r.add_argument("name")
    d = sub.add_parser("remove")
    d.add_argument("id")
    b = sub.add_parser("build")
    b.add_argument("id")
    b.add_argument("--if-stale", action="store_true")
    b.add_argument("--force", action="store_true", help="build past the max_files cap")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")
    try:
        if args.cmd == "list":
            scopes = load()["scopes"]
            print(f"{registry_path()}: {len(scopes)} universe(s)")
            for s in scopes:
                print(_fmt(s))
        elif args.cmd == "add":
            pf = preflight(args.root)
            s, existing = add(args.root, args.name)
            print(("already registered: " if existing else "added: ") + _fmt(s))
            print(f"preflight: {pf['files']:,}{'+' if pf['partial'] else ''} files, "
                  f"{'>= ' if pf['partial'] else ''}{pf['bytes'] / 1024 ** 2:,.0f} MB"
                  + (f"  WARNING: {pf['warn']}" if pf["warn"] else ""))
            print(f'build it: "{sys.executable}" "{os.path.join(HERE, "scopes.py")}" build {s["id"]}')
        elif args.cmd == "rename":
            print("renamed: " + _fmt(rename(args.id, args.name)))
        elif args.cmd == "remove":
            s = remove(args.id)
            print(f"removed {s['id']}" + (" (install left untouched)" if s["kind"] == "home" else ""))
        elif args.cmd == "build":
            s = prepare(args.id)
            rc = subprocess.call(build_cmd(s, args.if_stale, force=args.force), env=build_env())
            if rc:
                print(f"scopes: error: build failed (exit {rc})", file=sys.stderr)
                return 1
    except KeyError as exc:
        print(f"scopes: error: no such universe {exc}", file=sys.stderr)
        return 2
    except ScopeError as exc:
        print(f"scopes: error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
