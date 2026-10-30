"""`matrix`: the one-word launcher for the Multiverse engine.

    matrix [open] [--no-browser]   open the Multiverse (starts the engine if needed)
    matrix stop                    stop the engine
    matrix status                  is the engine running, and what is it building
    matrix list                    the registered universes
    matrix add <folder> [--name N] [--build] [--force]
    matrix build <id|name> [--full] [--force]
    matrix stop-build <id|name>
    matrix help

The running engine is $MATRIX_HOME/engine.json {pid, port, url, token,
install}, written by serve.py. One that is gone or does not answer a token-
authenticated /api/scopes is stale and treated as absent. setup.py installs
`matrix` / `matrix.cmd` scripts that run this file through
$MATRIX_HOME/launcher.json (the most recently registered install).
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import subprocess
import sys
import time
import webbrowser

import scopes

HERE = os.path.dirname(os.path.abspath(__file__))
START_WAIT = 25.0


class LaunchError(Exception):
    pass


# --------------------------------------------------------------------------
# engine.json
# --------------------------------------------------------------------------

def engine_path():
    return os.path.join(scopes.home(), "engine.json")


def pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":                      # os.kill(pid, 0) would TerminateProcess on Windows
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000, False, pid)          # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ctypes.GetLastError() == 5            # access denied: it exists
        try:
            code = ctypes.c_ulong()
            return bool(k32.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def call(eng, method, path, body=None, timeout=5.0):
    """(status, json) from the engine with its token; raises OSError if it does not answer."""
    c = http.client.HTTPConnection("127.0.0.1", int(eng["port"]), timeout=timeout)
    try:
        data = json.dumps(body).encode() if body is not None else None
        h = {"X-Matrix-Token": eng["token"]}
        if data is not None:
            h["Content-Type"] = "application/json"
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        raw = r.read()
        try:
            return r.status, json.loads(raw or b"{}")
        except ValueError:
            return r.status, {}
    finally:
        c.close()


def engine(clean=True):
    """The live engine's record, else None (a stale engine.json is removed)."""
    path = engine_path()
    try:
        with open(path, encoding="utf-8") as fh:
            eng = json.load(fh)
        ok = isinstance(eng, dict) and all(k in eng for k in ("pid", "port", "url", "token"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):             # unreadable: stale
        eng, ok = None, False
    if ok and pid_alive(eng.get("pid")):
        try:
            st, js = call(eng, "GET", "/api/scopes", timeout=3.0)
            if st == 200 and isinstance(js.get("scopes"), list):
                return eng
        except (OSError, http.client.HTTPException):
            pass
    if clean:                                 # stale: the pid is gone or it does not answer
        try:
            os.remove(path)
        except OSError:
            pass
    return None


def interpreter(windowless):
    """This interpreter; on Windows its pythonw.exe twin for a detached engine
    (a console python.exe started without a console opens a window)."""
    py = sys.executable
    if windowless and os.name == "nt":
        w = os.path.join(os.path.dirname(py), "pythonw.exe")
        if os.path.isfile(w):
            return w
    return py


def start_engine():
    """serve.py detached from this terminal; returns its engine record."""
    home = scopes.home()
    os.makedirs(home, exist_ok=True)
    log = open(os.path.join(home, "engine.log"), "ab")
    kw = {"stdin": subprocess.DEVNULL, "stdout": log, "stderr": log, "cwd": HERE,
          "close_fds": True, "env": dict(os.environ, MATRIX_HOME=home, PYTHONIOENCODING="utf-8")}
    if os.name == "nt":
        kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    else:
        kw["start_new_session"] = True
    try:
        p = subprocess.Popen([interpreter(True), os.path.join(HERE, "serve.py")], **kw)
    finally:
        log.close()
    end = time.monotonic() + START_WAIT
    while time.monotonic() < end:
        eng = engine(clean=False)
        if eng:
            return eng
        if p.poll() is not None:
            break
        time.sleep(0.2)
    tail = ""
    try:
        with open(os.path.join(home, "engine.log"), encoding="utf-8", errors="replace") as fh:
            tail = "".join(fh.readlines()[-8:])
    except OSError:
        pass
    raise LaunchError("the engine did not start" + (f"; engine.log ends:\n{tail}" if tail else ""))


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

def resolve(ref):
    ss = scopes.load()["scopes"]
    hit = [s for s in ss if s["id"] == ref] or [s for s in ss if s["name"].lower() == ref.lower()] \
        or [s for s in ss if s["id"].startswith(ref.lower())]
    if len(hit) == 1:
        return hit[0]
    if not hit:
        raise LaunchError(f"no universe {ref!r} (see: matrix list)")
    raise LaunchError(f"{ref!r} matches {', '.join(s['id'] for s in hit)}; use the id")


def cmd_open(args):
    eng = engine()
    started = False
    if not eng:
        print("starting the Matrix engine ...", flush=True)
        eng = start_engine()
        started = True
    print(f"Matrix Multiverse {'started' if started else 'running'} on 127.0.0.1:{eng['port']} "
          f"(pid {eng['pid']})")
    print(f"open: {eng['url']}")
    if not args.no_browser:
        webbrowser.open(eng["url"])
    return 0


def cmd_stop(args):
    eng = engine()
    if not eng:
        print("Matrix engine: not running")
        return 0
    try:
        call(eng, "POST", "/api/shutdown", {})
    except (OSError, http.client.HTTPException):
        pass
    end = time.monotonic() + 15
    while time.monotonic() < end and pid_alive(eng["pid"]):
        time.sleep(0.2)
    if pid_alive(eng["pid"]):
        raise LaunchError(f"engine pid {eng['pid']} did not stop; end it from the task manager")
    try:
        os.remove(engine_path())              # serve.py removes it; a crash may not have
    except OSError:
        pass
    print(f"Matrix engine stopped (pid {eng['pid']})")
    return 0


def cmd_status(args):
    eng = engine()
    ss = scopes.load()["scopes"]
    if not eng:
        print(f"Matrix engine: not running  ({len(ss)} universe(s) registered; start: matrix)")
        return 1
    _st, js = call(eng, "GET", "/api/scopes")
    busy = [s["name"] for s in js.get("scopes", []) if s.get("building")]
    print(f"Matrix engine: running on 127.0.0.1:{eng['port']} (pid {eng['pid']}, since {eng.get('started')})")
    print(f"  install  {eng.get('install')}")
    print(f"  {len(ss)} universe(s)" + (f"; building: {', '.join(busy)}" if busy else ""))
    return 0


def cmd_list(args):
    eng = engine()
    busy = set()
    if eng:
        _st, js = call(eng, "GET", "/api/scopes")
        busy = {s["id"] for s in js.get("scopes", []) if s.get("building")}
    ss = scopes.load()["scopes"]
    print(f"{len(ss)} universe(s) in {scopes.registry_path()}")
    for s in ss:
        st = ("building" if s["id"] in busy else
              f"{s['nodes']:,} nodes, built {s['built']}" if s.get("built") else "not built")
        print(f"  {s['id']:<28} {s['kind']:<8} {s['name']}\n  {'':<37}{s['root']}  ({st})")
    return 0


def cmd_add(args):
    pf = scopes.preflight(args.folder)
    s, existing = scopes.add(args.folder, args.name)
    print(("already registered: " if existing else "added: ") + f"{s['id']}  {s['root']}")
    print(f"  {'>= ' if pf['partial'] else ''}{pf['files']:,} files, "
          f"{'>= ' if pf['partial'] else ''}{pf['bytes'] / 1024 ** 2:,.0f} MB"
          + (f"\n  warning: {pf['warn']}" if pf["warn"] else ""))
    if args.build:
        if pf["over"] and not args.force:
            print(f"  not building: over the max_files cap; rerun with --force, or: matrix build {s['id']} --force")
            return 3
        return build(s, full=True, force=args.force)
    print(f"  build it: matrix build {s['id']}")
    return 0


def build(s, full, force):
    eng = engine()
    if eng:                                   # the engine builds it (one build per universe)
        st, js = call(eng, "POST", f"/api/scopes/{s['id']}/build", {"force": force, "full": full})
        if st != 200:
            raise LaunchError(js.get("error") or f"HTTP {st}")
        job, since = js["job"], 0
        print(f"building {s['id']} in the engine (job {job}; stop: matrix stop-build {s['id']})", flush=True)
        while True:
            st, v = call(eng, "GET", f"/api/jobs/{job}?since={since}")
            if st != 200:
                raise LaunchError(v.get("error") or f"HTTP {st}")
            for line in v.get("log", []):
                print("  " + line, flush=True)
            since = v.get("next", since)
            if v["state"] in ("done", "failed", "cancelled"):
                print(f"{v['state']}: {v['phase']}")
                return 0 if v["state"] == "done" else 1
            time.sleep(1.0)
    s = scopes.prepare(s["id"])
    rc = subprocess.call(scopes.build_cmd(s, full=full, force=force), env=scopes.build_env())
    if rc:
        print(f"matrix: build failed (exit {rc})", file=sys.stderr)
    return 1 if rc else 0


def cmd_build(args):
    return build(resolve(args.ref), args.full, args.force)


def cmd_stop_build(args):
    s = resolve(args.ref)
    eng = engine()
    if not eng:
        print("Matrix engine: not running, so nothing is building")
        return 1
    st, js = call(eng, "POST", f"/api/scopes/{s['id']}/cancel", {})
    if st != 200:
        raise LaunchError(js.get("error") or f"HTTP {st}")
    print(f"stopped the build of {s['id']}" if js.get("cancelled") else f"{s['id']} is not building")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="matrix", description="Matrix Multiverse launcher.",
                                 epilog="no command = open")
    sub = ap.add_subparsers(dest="cmd")
    o = sub.add_parser("open", help="open the Multiverse (starts the engine if needed)")
    for p in (ap, o):
        p.add_argument("--no-browser", action="store_true", help="print the URL only")
    sub.add_parser("stop", help="stop the engine")
    sub.add_parser("status", help="engine state")
    sub.add_parser("list", help="registered universes")
    a = sub.add_parser("add", help="register a folder as a universe")
    a.add_argument("folder")
    a.add_argument("--name")
    a.add_argument("--build", action="store_true")
    a.add_argument("--force", action="store_true", help="build past the max_files cap")
    b = sub.add_parser("build", help="build a universe")
    b.add_argument("ref", metavar="id|name")
    b.add_argument("--full", action="store_true", help="ignore the cache")
    b.add_argument("--force", action="store_true", help="build past the max_files cap")
    sb = sub.add_parser("stop-build", help="stop a running build")
    sb.add_argument("ref", metavar="id|name")
    sub.add_parser("help", help="this text")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")
    if args.cmd == "help":
        ap.print_help()
        return 0
    fn = {None: cmd_open, "open": cmd_open, "stop": cmd_stop, "status": cmd_status, "list": cmd_list,
          "add": cmd_add, "build": cmd_build, "stop-build": cmd_stop_build}[args.cmd]
    try:
        return fn(args)
    except (LaunchError, scopes.ScopeError) as exc:
        print(f"matrix: error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
