"""Multiverse engine: serve every registered universe on 127.0.0.1.

    python serve.py [--port 8765] [--open] [--scope <id>] [--verbose] [--allow-unc]

Binds 127.0.0.1 only (next free port if the one asked for is taken) with a
random per-run API token and a separate random page key. Pages live under
/s/<key>/ only (the startup URL); every page served there carries the token
in window.MX_SERVER, which the page sends as X-Matrix-Token on /api/*. No
cookies: browsers share cookies across ports, so a cookie would reach every
other server on 127.0.0.1. Host must be 127.0.0.1:<port> / localhost:<port>;
an Origin header must be this server's own. /s/<key>/u/<id>/ serves files of
that scope's out dir only. The running engine is recorded in
$MATRIX_HOME/engine.json (the `matrix` launcher reads it) and removed on a
clean shutdown. docs/SERVICES.md documents the API.
"""

from __future__ import annotations

import argparse
import hmac
import html as htmlesc
import json
import math
import mimetypes
import os
import re
import secrets
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit

import scopes

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8765
MAX_BODY = 64 * 1024
MAX_BUILDS = 2                 # concurrent builds across scopes; more wait as "queued"
MAX_DIRS = 5000
MAX_LOG = 2000                 # job log lines kept in memory (the file keeps all)
BUILD_TIMEOUT = 4 * 3600       # a build running longer than this is killed
ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,80}")
WIN_HIDDEN = 0x2 | 0x4         # FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
PROGRESS = re.compile(r"^progress: (\d+)/(\d+)")
SCAN = re.compile(r"^scan: (\d+) files")
CSP = ("frame-ancestors 'none'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
       "form-action 'none'")


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def say(line):
    """One engine log line on stderr (state changes and errors only)."""
    try:
        sys.stderr.write(f"{time.strftime('%H:%M:%S')} {line}\n")
        sys.stderr.flush()
    except (OSError, ValueError, AttributeError):
        pass


def kill_tree(p, grace=3.0):
    """Stop a build and everything it started. Windows: taskkill /T /F (the
    venv python.exe is a launcher with the real interpreter as its child);
    posix: SIGTERM to its process group, SIGKILL after the grace period."""
    if p.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=NO_WINDOW, timeout=30)
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(p.pid, sig)
            except OSError:
                break
            try:
                p.wait(grace)
                break
            except subprocess.TimeoutExpired:
                continue
    try:
        p.wait(10)
    except subprocess.TimeoutExpired:
        p.kill()


# --------------------------------------------------------------------------
# build jobs
# --------------------------------------------------------------------------

class _Cancelled(Exception):
    pass


class Jobs:
    """One background thread per build, at most one live build per scope.
    Every line of a build is kept in memory (last MAX_LOG) and in the scope's
    last_build.log."""

    def __init__(self):
        self.lock = threading.Lock()
        self.jobs = {}                    # job id -> job dict
        self.live = {}                    # scope id -> job id (queued/running)
        self.last = {}                    # scope id -> job id of the latest job
        self.slots = threading.Semaphore(MAX_BUILDS)
        self.procs = {}                   # job id -> Popen

    def building(self):
        with self.lock:
            return {sid for sid, jid in self.live.items() if self.jobs[jid]["state"] in ("queued", "running")}

    def live_job(self, sid):
        """The scope's queued/running job id (a job that just ended is not live)."""
        with self.lock:
            jid = self.live.get(sid)
            return jid if jid and self.jobs[jid]["state"] in ("queued", "running") else None

    def last_job(self, sid):
        with self.lock:
            j = self.jobs.get(self.last.get(sid))
            return {k: j[k] for k in ("id", "state", "phase", "over")} if j else None

    def start(self, sid, if_stale=False, force=False, full=True):
        with self.lock:
            if sid in self.live:
                return self.live[sid]
            jid = secrets.token_hex(8)
            self.jobs[jid] = {"id": jid, "scope": sid, "state": "queued", "phase": "queued",
                              "progress": None, "log": deque(maxlen=MAX_LOG), "n": 0,
                              "ended": None, "started": stamp(), "cancel": False,
                              "over": False, "graph": False, "timeout": False}
            self.live[sid] = jid
            self.last[sid] = jid
            done = sorted((j for j in self.jobs.values() if j["ended"]), key=lambda j: j["ended"])
            for j in done[:-50]:
                del self.jobs[j["id"]]
        say(f"job {jid} {sid}: started" + (" (if stale)" if if_stale else "")
            + (" (forced past max_files)" if force else ""))
        threading.Thread(target=self._run, args=(jid, if_stale, force, full), daemon=True).start()
        return jid

    def view(self, jid, since=None):
        with self.lock:
            j = self.jobs.get(jid)
            if not j:
                return None
            v = {k: j[k] for k in ("state", "phase", "progress", "started", "ended", "over", "graph")}
            lines = list(j["log"])
            first = j["n"] - len(lines)                  # index of lines[0]
            if since is None:
                v["log"] = lines[-20:]
            else:
                v["log"] = lines[max(0, since - first):]
            v["next"], sid = j["n"], j["scope"]
        if v["ended"]:
            v["ended"] = datetime.fromtimestamp(v["ended"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        s = scopes.get(sid)
        v["scope"] = dict(scopes.public(s), building=v["state"] in ("queued", "running")) if s else None
        return v

    def cancel(self, jid):
        """True if the job was live; its process tree is killed."""
        with self.lock:
            j = self.jobs.get(jid)
            if not j or j["state"] not in ("queued", "running"):
                return False
            j["cancel"] = True
            p = self.procs.get(jid)
        if p is not None:
            kill_tree(p)
        return True

    def _set(self, j, **kw):
        with self.lock:
            j.update(kw)

    def _line(self, j, fh, line):
        with self.lock:
            j["log"].append(line)
            j["n"] += 1
        if fh:
            try:
                fh.write(line + "\n")
                fh.flush()
            except OSError:
                pass

    def _run(self, jid, if_stale, force, full=True):
        j = self.jobs[jid]
        rc, fh, s, timer = None, None, None, None
        try:
            with self.slots:
                if j["cancel"]:
                    raise _Cancelled()
                self._set(j, state="running", phase="preparing")
                s = scopes.prepare(j["scope"])
                cmd = scopes.build_cmd(s, if_stale, force=force, full=full)
                try:
                    lp = scopes.log_path(s)
                    os.makedirs(os.path.dirname(lp), exist_ok=True)
                    fh = open(lp, "w", encoding="utf-8", newline="\n")
                    fh.write(f"# Matrix build of {s['id']} ({s['root']}) started {j['started']}\n"
                             f"# {subprocess.list2cmdline(cmd)}\n")
                except (OSError, scopes.ScopeError) as exc:
                    self._line(j, None, f"(build log not saved: {exc})")
                self._set(j, phase="checking" if if_stale else "starting")
                p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL, text=True, encoding="utf-8",
                                     errors="replace", env=scopes.build_env(),
                                     creationflags=NO_WINDOW, start_new_session=os.name != "nt")
                with self.lock:
                    self.procs[jid] = p
                if j["cancel"]:                      # cancelled while starting
                    kill_tree(p)
                timer = threading.Timer(BUILD_TIMEOUT, self._timeout, (jid, p))
                timer.daemon = True
                timer.start()
                summary = None
                for line in p.stdout:
                    line = line.rstrip()
                    if not line:
                        continue
                    self._line(j, fh, line)
                    m = PROGRESS.match(line)
                    if m:
                        i, n = int(m.group(1)), max(int(m.group(2)), 1)
                        self._set(j, phase=f"parsing {i:,} / {n:,} files",
                                  progress=round(0.05 + 0.85 * min(i / n, 1.0), 3))
                    elif SCAN.match(line):
                        self._set(j, phase=f"parsing {int(SCAN.match(line).group(1)):,} files",
                                  progress=0.05)
                    elif "up to date" in line:
                        self._set(j, phase="up to date")
                    elif line.startswith("wrote ") and "graph.html" in line:
                        self._set(j, phase="rendered", progress=0.95)
                    elif "(max_files)" in line:
                        self._set(j, over=True)
                    m = scopes.SUMMARY.search(line)
                    if m:
                        summary = m
                        self._set(j, phase="written", progress=0.98)
                rc = p.wait()
                timer.cancel()
                with self.lock:
                    self.procs.pop(jid, None)
                if j["cancel"]:
                    raise _Cancelled()
                if rc == 0 and summary:      # older indexers do not update the registry
                    try:
                        scopes.update_stats(scopes.out_of(s), *map(int, summary.groups()))
                    except Exception as exc:
                        self._line(j, fh, f"(registry stats not updated: {exc})")
            graph = os.path.isfile(os.path.join(scopes.out_of(s), "graph.html"))
            if rc == 0 and graph:
                self._set(j, state="done", progress=1.0, graph=True,
                          phase="up to date" if j["phase"] == "up to date" else "done")
            elif rc == 0:
                self._line(j, fh, "graph.html was not written (see the visualizer line above)")
                self._set(j, state="failed", phase="failed: no graph.html written")
            elif j["over"]:
                self._set(j, state="failed", phase="refused: over the max_files cap")
            elif j["timeout"]:
                self._set(j, state="failed", phase=f"failed: over {BUILD_TIMEOUT // 3600} h, stopped")
            else:
                self._set(j, state="failed", phase=f"failed (exit {rc})")
        except _Cancelled:
            self._set(j, state="cancelled", phase="cancelled", progress=None)
        except KeyError:
            self._set(j, state="failed", phase="failed: universe was removed")
        except Exception as exc:
            self._line(j, fh, f"{type(exc).__name__}: {exc}")
            self._set(j, state="failed", phase="failed")
        finally:
            if timer:
                timer.cancel()
            with self.lock:
                p = self.procs.pop(jid, None)
                j["ended"] = time.time()
                if self.live.get(j["scope"]) == jid:
                    del self.live[j["scope"]]
            if p is not None:
                kill_tree(p)
            if fh:
                try:
                    fh.write(f"# {j['state']}: {j['phase']} at {stamp()}\n")
                    fh.close()
                except OSError:
                    pass
            say(f"job {jid} {j['scope']}: {j['state']}"
                + (f" ({j['phase']})" if j["phase"] not in (j["state"], "") else ""))

    def _timeout(self, jid, p):
        with self.lock:
            j = self.jobs.get(jid)
            if j:
                j["timeout"] = True
        kill_tree(p)

    def kill_all(self):
        with self.lock:
            items = list(self.procs.items())
            for jid, _p in items:
                self.jobs[jid]["cancel"] = True
        for _jid, p in items:
            kill_tree(p)


# --------------------------------------------------------------------------
# pages
# --------------------------------------------------------------------------

def galaxy_svg(m=5):
    """Static redraw of the Matrix galaxy mark (viz/hairline.js `galaxy`, same
    geometry ideas): the 2:1 iso view, a dim disc with dashed orbits, two
    tapered spiral arms carrying round tiles, a stepped core with the one
    bright dot. Monochrome: every stroke is a hairline grey token."""
    c, kz = math.sqrt(0.5), math.sqrt(0.75)

    def P(x, y, z=0.0):
        return (x * c - y * c, (x * c + y * c) * 0.5 - z * kz)

    def ring(r, z=0.0, cx=0.0, cy=0.0, n=40):
        return [P(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n), z)
                for i in range(n)]

    def d(pts):
        return "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts) + " Z"

    def hull(pts):
        pts = sorted(set((round(x, 2), round(y, 2)) for x, y in pts))

        def cross(o, a, b):
            return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
        lo, up = [], []
        for p in pts:
            while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
                lo.pop()
            lo.append(p)
        for p in reversed(pts):
            while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
                up.pop()
            up.append(p)
        return lo[:-1] + up[:-1]

    def prism(r, z0, z1, cx=0.0, cy=0.0):           # silhouette bright outside, crease dim inside
        sil = hull(ring(r, z0, cx, cy) + ring(r, z1, cx, cy))
        crease = ring(max(r - max(r * 0.18, 0.9), 0.5), z1, cx, cy)
        return f'<path class="sil" d="{d(sil)}"/><path class="lo" d="{d(crease)}"/>'

    def lerp(a, b, u):
        return a + (b - a) * u
    RD, R0, R1, TURN = 100, 21, 96, math.radians(270)
    B = math.log(R1 / R0) / TURN
    GH = [1, 0.78, 1.12, 0.84, 1.06, 0.7, 0.94, 0.8]   # uneven rest heights

    def at(a, th, off=0.0):
        r, t = R0 * math.exp(B * th), a * math.pi + th + off
        return r * math.cos(t), r * math.sin(t)

    back = [f'<path class="lo" d="{d(ring(RD, n=72))}"/>']
    back += [f'<path class="dash" d="{d(ring(r, n=60))}"/>' for r in (38, 70)]
    for a in range(2):
        for f in (0.42, 0.7, 0.9):
            sx, sy = P(*at(a, TURN * f, 1.7))
            back.append(f'<ellipse class="off" cx="{sx:.1f}" cy="{sy:.1f}" rx="1.4" ry="0.7"/>')
    for a in range(2):                               # arm: a band tapering to a point at the tip
        out, inn = [], []
        for k in range(41):
            t = k / 40
            x, y = at(a, -0.5 + (TURN + 0.5) * t)
            r = math.hypot(x, y)
            f = min(r * 0.3, 9.0) * (1 - t) ** 0.8 / r
            out.append(P(x * (1 + f), y * (1 + f)))
            inn.insert(0, P(x * (1 - f), y * (1 - f)))
        back.append(f'<path class="arm" d="{d(out + inn)}"/>')
    tiles = []
    for a in range(2):
        for j in range(m):
            u = j / (m - 1)
            x, y = at(a, math.log(lerp(34, 84, u) / R0) / B)
            tiles.append((x + y, prism(lerp(8, 4, u), 0, lerp(6, 2, u) * GH[(j + 3 * a) % 8], x, y)))
    sx, sy = P(0, 0, 11)
    tiles.append((0.0, prism(15, 0, 3) + prism(9, 3, 11)
                  + f'<ellipse class="dot" cx="{sx:.1f}" cy="{sy:.1f}" rx="2.6" ry="1.3"/>'))
    tiles.sort(key=lambda t: t[0])                   # paint back to front
    rim = [P(RD * math.cos(t / 20), RD * math.sin(t / 20)) for t in range(126)]
    x0, x1 = min(p[0] for p in rim) - 3, max(p[0] for p in rim) + 3
    y0, y1 = min(p[1] for p in rim) - 16, max(p[1] for p in rim) + 3
    return (f'<svg class="mark" viewBox="{x0:.0f} {y0:.0f} {x1 - x0:.0f} {y1 - y0:.0f}" '
            'aria-hidden="true" focusable="false">' + "".join(back)
            + "".join(t for _k, t in tiles) + "</svg>")


MARK = galaxy_svg()

PAGE_CSS = """
:root{--font:Consolas,"Cascadia Mono","Cascadia Code","SF Mono",Menlo,"DejaVu Sans Mono","Liberation Mono",monospace;
color-scheme:light;--bg:#fbfbfa;--surface:#fff;--surface-2:#f4f4f4;--line-hi:#232327;--line-edge:#a4a4ac;
--line-mid:#c3c3c9;--line-lo:#e0e0e4;--rule:rgba(0,0,0,.07);--ring:#e3e3e6;--ring-strong:#c9c9cf;--text:#0a0a0a;
--text-2:#525252;--text-3:#6b6b6b;--text-4:#a3a3a3;--focus:#0a0a0a;--warn:#8a611f;--err:#a04a34;
--lift:0 1px 2px rgb(0 0 0/.03),0 10px 28px -16px rgb(0 0 0/.14);--ease:cubic-bezier(.32,.72,0,1)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#08090a;--surface:#0e0f11;--surface-2:#17181b;
--line-hi:#d0d6e0;--line-edge:#5b5d64;--line-mid:#3e3e44;--line-lo:#29292d;--rule:rgba(255,255,255,.06);
--ring:rgba(255,255,255,.09);--ring-strong:rgba(255,255,255,.18);--text:#e8eaee;--text-2:#b4b7bf;--text-3:#9a9ca4;
--text-4:#6e7078;--focus:#d0d6e0;--warn:#dcb06a;--err:#e4937c;--lift:0 24px 56px -28px rgb(0 0 0/.7)}}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;min-height:100vh;color:var(--text);font:13px/1.65 var(--font);display:flex;flex-direction:column;
align-items:center;padding:8vh 20px 40px;font-variant-numeric:tabular-nums}
main{width:100%;max-width:560px;background:var(--surface);border-radius:12px;padding:32px 36px 30px;
box-shadow:inset 0 0 0 1px var(--ring),var(--lift)}
.mark{display:block;width:184px;height:auto;margin:0 auto 14px;overflow:visible}
.mark path,.mark ellipse{fill:var(--surface);stroke:var(--line-mid);stroke-width:.9;vector-effect:non-scaling-stroke;
stroke-linejoin:round;stroke-linecap:round}
.mark .lo{fill:none;stroke:var(--line-lo)}.mark .dash{fill:none;stroke:var(--line-mid);stroke-dasharray:1 3}
.mark .sil{stroke:var(--line-edge)}.mark .off{fill:var(--line-lo);stroke:none}.mark .dot{fill:var(--line-hi);stroke:none}
h1{font-size:15px;font-weight:500;letter-spacing:.01em;margin:0;text-align:center}
h1 i{font-style:normal;color:var(--text-4);padding:0 .45em}
.lede{color:var(--text-3);text-align:center;margin:6px auto 0;max-width:46ch}
section{margin-top:26px;padding-top:22px;border-top:1px solid var(--rule)}
.lbl{display:block;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin:0 0 8px}
.lbl small{font-size:inherit;text-transform:none;letter-spacing:0;color:var(--text-4);padding-left:.6em}
p{margin:0 0 10px}.dim{color:var(--text-3)}.faint{color:var(--text-4)}
code{font:inherit;color:var(--text-2);word-break:break-all}
a{color:inherit;text-decoration:none}
input{font:inherit;color:inherit;background:var(--surface);border:0;border-radius:9px;height:36px;padding:0 12px;
width:100%;box-shadow:inset 0 0 0 1px var(--ring);transition:box-shadow .15s}
input:hover{box-shadow:inset 0 0 0 1px var(--ring-strong)}input::placeholder{color:var(--text-4)}
input:focus{outline:none;box-shadow:inset 0 0 0 1px var(--line-hi)}
.field{display:flex;gap:8px;margin-bottom:16px}.field input{flex:1;min-width:0}
button{font:inherit;color:var(--text);background:var(--surface);border:0;border-radius:9px;height:36px;padding:0 14px;
cursor:pointer;white-space:nowrap;box-shadow:inset 0 0 0 1px var(--ring);transition:box-shadow .15s,background .15s,transform .16s}
button:hover:not(:disabled){box-shadow:inset 0 0 0 1px var(--ring-strong);background:var(--surface-2)}
button:active:not(:disabled){transform:scale(.97)}button:disabled{opacity:.45;cursor:default}
button.primary{background:var(--text);color:var(--surface);box-shadow:none}
button.primary:hover:not(:disabled){background:var(--text-2)}
button.quiet{box-shadow:none;color:var(--text-3);padding:0 10px}button.quiet:hover:not(:disabled){color:var(--text)}
:focus-visible{outline:1.5px solid var(--focus);outline-offset:2px}
.acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:4px}
.acts .grow{flex:1}
ul.list{list-style:none;margin:0;padding:0}
ul.list li+li{border-top:1px solid var(--rule)}
ul.list a{display:grid;grid-template-columns:1fr auto;gap:2px 16px;padding:10px 8px;margin:0 -8px;border-radius:8px}
ul.list a:hover{background:var(--surface-2)}
ul.list b{font-weight:500}ul.list .r{grid-column:1;color:var(--text-3);font-size:12px;word-break:break-all}
ul.list .n{grid-row:1/3;grid-column:2;align-self:center;color:var(--text-3);font-size:12px;text-align:right}
.fs{margin:-6px 0 16px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--ring);padding:10px}
.crumbs{display:flex;gap:0 4px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.crumbs button{height:24px;padding:0 8px;font-size:12px;box-shadow:none;color:var(--text-3)}
.crumbs button[aria-current]{color:var(--text)}.crumbs i{color:var(--text-4);font-style:normal}
.dirs{list-style:none;margin:0;padding:4px 0 0;max-height:220px;overflow:auto;border-top:1px solid var(--rule)}
.dirs button{display:block;width:100%;text-align:left;height:30px;box-shadow:none;border-radius:6px;padding:0 8px;
overflow:hidden;text-overflow:ellipsis}
.dirs button.hid{color:var(--text-4)}.dirs .empty{color:var(--text-4);padding:8px}
.fs .acts{margin-top:10px}
.stat{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 12px;color:var(--text-2)}
.stat b{font-weight:500;color:var(--text)}
.warn{border-radius:10px;padding:12px 14px;margin:0 0 12px;box-shadow:inset 0 0 0 1px var(--ring);color:var(--text-2)}
.warn .t{color:var(--warn)}
.tip{color:var(--text-3);font-size:12px;margin:0 0 14px}
.err{color:var(--err)}
.alert{margin:14px 0 0;color:var(--err)}
.alert:empty{display:none}
.phase{display:flex;justify-content:space-between;gap:12px;margin-bottom:10px}
.phase span:last-child{color:var(--text-3)}
.bar{position:relative;height:1px;background:var(--line-lo);overflow:hidden;margin:0 0 14px}
.bar>span{position:absolute;left:0;top:0;bottom:0;width:0;background:var(--line-hi);transition:width .7s var(--ease)}
.bar.indet>span{width:26%;animation:slide 1.7s var(--ease) infinite}
@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(390%)}}
@media (prefers-reduced-motion:reduce){.bar.indet>span{animation:none;width:100%;background:var(--line-mid)}
*{transition:none!important}}
details.log{margin-top:10px}
details.log summary{cursor:pointer;color:var(--text-3);font-size:12px;list-style:none;padding:4px 0;width:max-content}
details.log summary::-webkit-details-marker{display:none}
details.log summary::before{content:"+ ";color:var(--text-4)}details.log[open] summary::before{content:"\\2212  "}
details.log summary:hover{color:var(--text)}
pre.log{margin:6px 0 0;padding:10px 12px;border-radius:8px;box-shadow:inset 0 0 0 1px var(--rule);color:var(--text-3);
font:11.5px/1.6 var(--font);white-space:pre-wrap;word-break:break-all;height:calc(12 * 1.6em + 20px);overflow:auto}
pre.log .note{color:var(--text-4)}pre.log .bad{color:var(--err)}
pre.tail{height:auto;max-height:8.6em;margin:0 0 12px}
.loghead{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px;color:var(--text-4);font-size:12px}
.loghead button{height:28px;font-size:12px}
footer{margin-top:22px;color:var(--text-4);font-size:11.5px;text-align:center;max-width:560px}
[hidden]{display:none!important}
section:has(> #add[hidden]):has(> #pre[hidden]){display:none}
"""

PAGE_JS = r"""
(function () {
  "use strict";
  var S = window.MX_SERVER, PG = window.MX_PAGE || {}, base = S.base || "";
  var $ = function (id) { return document.getElementById(id); };
  var st = {scope: PG.scope || null, pre: null, job: null, force: false, lines: [], next: 0, t0: 0, timer: 0, browse: null};
  var WARNLINE = /\b(SyntaxWarning|DeprecationWarning|ResourceWarning|UserWarning|FutureWarning)\b|^\s*warning:/i;
  function api(method, url, body) {
    var o = {method: method, headers: {"X-Matrix-Token": S.token}};
    if (body !== undefined) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
    return fetch(base + url, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) throw new Error("This page's engine has restarted. Run `matrix` again to open it.");
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; });
    }, function (e) { throw new Error("engine unreachable (" + e.message + ")"); });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]; }); }
  function fmtN(n) { return Number(n || 0).toLocaleString("en-US"); }
  function fmtB(b) { var u = ["B", "KB", "MB", "GB", "TB"], i = 0, v = +b || 0;
    while (v >= 1024 && i < 4) { v /= 1024; i++; } return (i ? v.toFixed(v < 10 ? 1 : 0) : v) + " " + u[i]; }
  function alert_(msg) { var a = $("alert"); if (a) a.textContent = msg || ""; }
  function show(id, on) { var e = $(id); if (e) e.hidden = !on; }

  // ---- folder browser (/api/fs: directory names only) ----
  function browse(path) {
    var box = $("fs"); box.hidden = false; $("browse").setAttribute("aria-expanded", "true");
    $("dirs").innerHTML = "<li class='empty'>Loading\u2026</li>";
    api("GET", "/api/fs" + (path ? "?path=" + encodeURIComponent(path) : "")).then(function (j) {
      st.browse = j; drawFs();
    }).catch(function (e) { $("dirs").innerHTML = "<li class='empty err'>" + esc(e.message) + "</li>"; });
  }
  function child(p, name) { if (!p) return name; return p.replace(/[\\/]+$/, "") + "/" + name; }
  function native(p) { return /^[A-Za-z]:/.test(p) ? p.replace(/\//g, "\\") : p; }
  function drawFs() {
    var j = st.browse, P = j.path || "", parts = P.split("/").filter(Boolean), acc = "", c = [];
    c.push("<button type='button' data-go=''" + (P ? "" : " aria-current='location'") + ">Computer</button>");
    if (P && P.charAt(0) === "/") c.push("<i>/</i>");
    parts.forEach(function (seg, i) {
      acc = i === 0 && /^[A-Za-z]:$/.test(seg) ? seg + "/" : acc.replace(/\/$/, "") + "/" + seg;
      c.push((i ? "<i>/</i>" : "<i>\u203a</i>") + "<button type='button' data-go='" + esc(acc) + "'" +
        (i === parts.length - 1 ? " aria-current='location'" : "") + ">" + esc(seg) + "</button>");
    });
    $("crumbs").innerHTML = c.join("");
    var dirs = (j.dirs || []).map(function (d) { return typeof d === "string" ? {name: d} : d; });
    $("dirs").innerHTML = dirs.length ? dirs.map(function (d) {
      return "<li><button type='button' data-into='" + esc(d.name) + "'" + (d.hidden ? " class='hid'" : "") + ">" + esc(d.name) + "</button></li>";
    }).join("") : "<li class='empty'>No folders here</li>";
    $("fs-up").disabled = !P; $("fs-use").disabled = !P;
  }

  // ---- preflight -> confirm -> build ----
  function check() {
    alert_("");
    var root = ($("root") ? $("root").value : (st.scope && st.scope.root) || "").trim();
    if (!root) { alert_("Enter a folder path, or Browse to one."); if ($("root")) $("root").focus(); return; }
    var body = {root: root}, nm = $("name") && $("name").value.trim();
    if (nm) body.name = nm;
    busy(true);
    api("POST", "/api/scopes", body).then(function (r) {
      st.scope = r.scope; st.pre = r; busy(false); drawPre();
      if (!r.preflight.warn && !(r.existing && r.scope.built)) build(false);
      else { var b = $("pre-go"); if (b) b.focus(); }
    }).catch(function (e) { busy(false); alert_(e.message); });
  }
  function busy(on) { ["check", "go"].forEach(function (id) { var b = $(id); if (b) b.disabled = on; }); }
  function drawPre() {
    var r = st.pre, p = r.preflight, s = r.scope, warn = !!p.warn, ge = p.partial ? "\u2265 " : "";
    var h = "<span class='lbl'>" + (r.existing ? "Already a universe" : "Ready to index") + "</span>" +
      "<p><b>" + esc(s.name) + "</b> <span class='dim'>" + esc(native(s.root)) + "</span></p>" +
      "<p class='stat'><span><b>" + ge + fmtN(p.files) + "</b> files</span>" +
      "<span><b>" + ge + fmtB(p.bytes) + "</b>" + (p.partial ? " <span class='faint'>(stopped counting)</span>" : "") + "</span>" +
      (p.cap ? "<span class='faint'>cap " + fmtN(p.cap) + " files</span>" : "") + "</p>";
    if (warn) h += "<p class='warn' role='note'><span class='t'>Large folder.</span> " + esc(p.warn) + "</p>" +
      "<p class='tip'>Tip: a narrower folder, such as one project or one source tree, builds in seconds and gives a graph you can read.</p>";
    h += "<div class='acts'>";
    if (r.existing && s.built) h += "<button type='button' class='primary' id='pre-go'>Open</button><button type='button' id='pre-re'>Rebuild</button>";
    else h += "<button type='button' class='primary' id='pre-go'>" + (warn ? "Index anyway" : "Index") + "</button>";
    h += "<span class='grow'></span><button type='button' class='quiet' id='pre-x'>Choose another folder</button></div>";
    $("pre").innerHTML = h; show("pre", true); show("add", false); show("prog", false);
    $("pre-go").addEventListener("click", function () {
      if (r.existing && s.built) location.href = base + "/u/" + encodeURIComponent(s.id) + "/";
      else build(warn);
    });
    if ($("pre-re")) $("pre-re").addEventListener("click", function () { build(warn); });
    $("pre-x").addEventListener("click", cancelPre);
  }
  function cancelPre() {
    var r = st.pre; st.pre = null; show("pre", false); show("add", true);
    if (r && !r.existing) api("DELETE", "/api/scopes/" + encodeURIComponent(r.scope.id)).catch(function () {});
    if ($("root")) $("root").focus();
  }
  function build(force) {
    st.force = !!force; alert_("");
    show("pre", false); show("add", false); show("prog", true); show("fail", false); show("go", false);
    show("viewlog", false); show("state", false);
    st.lines = []; st.next = 0; drawLog(); phase("starting", null); $("logwhen").textContent = "";
    api("POST", "/api/scopes/" + encodeURIComponent(st.scope.id) + "/build", {force: st.force}).then(function (r) {
      attach(r.job);
    }).catch(function (e) { failed({state: "failed", phase: e.message, log: []}); });
  }
  function attach(job) {
    st.job = job; st.t0 = Date.now(); show("prog", true); show("add", false); show("stop", true); show("go", false);
    $("stop").disabled = false; poll();
  }
  function poll() {
    clearTimeout(st.timer);
    api("GET", "/api/jobs/" + encodeURIComponent(st.job) + "?since=" + st.next).then(function (j) {
      addLines(j.log || []); st.next = j.next || st.next;
      phase(j.phase || j.state, j.progress);
      if (j.state === "done" && j.graph) { phase("done \u00b7 opening", 1); location.href = base + "/u/" + encodeURIComponent(st.scope.id) + "/"; return; }
      if (j.state === "done") { failed({state: "failed", phase: "the build finished but wrote no graph.html"}); return; }
      if (j.state === "failed" || j.state === "cancelled") { failed(j); return; }
      st.timer = setTimeout(poll, Date.now() - st.t0 > 30000 ? 2000 : 1000);
    }).catch(function (e) { failed({phase: e.message, state: "failed"}); });
  }
  function stop() {
    $("stop").disabled = true; phase("stopping\u2026", null);
    api("POST", "/api/jobs/" + encodeURIComponent(st.job) + "/cancel", {}).catch(function (e) { alert_(e.message); $("stop").disabled = false; });
  }
  function phase(t, p) {
    var bar = $("bar"), pct = p == null ? null : Math.round(Math.max(0, Math.min(1, p)) * 100);
    $("phase").textContent = t || "";
    $("pct").textContent = pct == null ? "" : pct + "%";
    bar.className = "bar" + (pct == null ? " indet" : "");
    bar.firstChild.style.width = pct == null ? "" : pct + "%";
    if (pct == null) bar.removeAttribute("aria-valuenow"); else bar.setAttribute("aria-valuenow", pct);
    bar.setAttribute("aria-valuetext", (t || "") + (pct == null ? "" : " " + pct + "%"));
  }
  function addLines(ls) { if (!ls.length) return; st.lines = st.lines.concat(ls).slice(-2000); drawLog(); }
  function drawLog() {
    var pre = $("log"), stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    pre.innerHTML = st.lines.map(function (l) {
      return WARNLINE.test(l) ? "<span class='note'>note: " + esc(l) + "</span>" :
        /Traceback|Error\b|error:/.test(l) ? "<span class='bad'>" + esc(l) + "</span>" : esc(l);
    }).join("\n");
    $("logn").textContent = st.lines.length ? " \u00b7 " + fmtN(st.lines.length) + (st.lines.length === 1 ? " line" : " lines") : "";
    if (stick) pre.scrollTop = pre.scrollHeight;
  }
  function failed(j) {
    clearTimeout(st.timer); show("stop", false); show("prog", true);
    var cancelled = j.state === "cancelled";
    $("bar").className = "bar"; $("bar").firstChild.style.width = "0";
    $("phase").textContent = cancelled ? "Build stopped" : "Build failed"; $("pct").textContent = "";
    var tail = st.lines.filter(function (l) { return !WARNLINE.test(l); }).slice(-4).join("\n");
    $("fail-msg").innerHTML = "<span class='" + (cancelled ? "dim" : "err") + "'>" + esc(cancelled ?
      "Stopped before it finished. The last good graph, if there was one, is untouched." : (j.phase || "failed")) + "</span>";
    $("fail-tail").textContent = tail; show("fail-tail", !!tail);
    $("retry").textContent = j.over ? "Index anyway" : "Retry";
    $("retry").onclick = function () { build(j.over || st.force); };
    show("fail", true); $("logbox").open = true; drawLog();
    show("go", false); show("viewlog", false); show("state", false);   // the build block says it once
    $("retry").focus();
  }
  function viewLog() {
    if (!st.scope) return;
    api("GET", "/api/scopes/" + encodeURIComponent(st.scope.id) + "/log?tail=500").then(function (r) {
      st.lines = r.log || []; drawLog(); show("prog", true); $("logbox").open = true;
      $("logwhen").textContent = r.built ? "build log of " + r.built.replace("T", " ").replace("Z", " UTC") : "no build log yet";
      var pre = $("log"); pre.scrollTop = pre.scrollHeight;
      if (!st.job && $("fail").hidden) { $("phase").textContent = "Last build"; $("bar").className = "bar"; }
      if (st.lines.length && !$("fail").hidden) {
        var tail = st.lines.filter(function (l) { return !WARNLINE.test(l) && l.charAt(0) !== "#"; }).slice(-4).join("\n");
        $("fail-tail").textContent = tail; show("fail-tail", !!tail);
      }
    }).catch(function (e) { alert_(e.message); });
  }
  function copyLog(btn) {
    var t = st.lines.join("\n"), done = function (m) { btn.textContent = m; setTimeout(function () { btn.textContent = "Copy"; }, 1600); };
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { done("Copied"); }, function () {
      var r = document.createRange(); r.selectNodeContents($("log")); var s = getSelection(); s.removeAllRanges(); s.addRange(r);
      done("Selected"); });
  }

  // ---- wiring ----
  var form = $("add");
  if (form) form.addEventListener("submit", function (ev) { ev.preventDefault(); check(); });
  if ($("browse")) $("browse").addEventListener("click", function () {
    if (!$("fs").hidden) { $("fs").hidden = true; this.setAttribute("aria-expanded", "false"); return; }
    var v = $("root").value.trim(); browse(/^([A-Za-z]:|\/)/.test(v) ? v : "");
  });
  if ($("fs")) {
    $("fs").addEventListener("click", function (ev) {
      var b = ev.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-go")) browse(b.getAttribute("data-go"));
      else if (b.hasAttribute("data-into")) browse(child(st.browse.path, b.getAttribute("data-into")));
      else if (b.id === "fs-up") browse(st.browse.parent || "");
      else if (b.id === "fs-use") { $("root").value = native(st.browse.path); $("fs").hidden = true; $("browse").setAttribute("aria-expanded", "false"); $("check").focus(); }
      else if (b.id === "fs-x") { $("fs").hidden = true; $("browse").setAttribute("aria-expanded", "false"); $("browse").focus(); }
    });
    $("fs").addEventListener("keydown", function (ev) { if (ev.key === "Escape") { $("fs").hidden = true; $("browse").focus(); } });
  }
  if ($("go")) $("go").addEventListener("click", check);
  if ($("viewlog")) $("viewlog").addEventListener("click", viewLog);
  $("stop").addEventListener("click", stop);
  $("copylog").addEventListener("click", function () { copyLog(this); });
  $("viewlog2").addEventListener("click", viewLog);
  if (PG.job) attach(PG.job);
  else if (PG.last && (PG.last.state === "failed" || PG.last.state === "cancelled")) {
    failed({state: PG.last.state, phase: PG.last.phase, over: PG.last.over}); viewLog();
  }
})();
"""


def page(title, body, server=None, data=None, status=""):
    """A self-contained hairline page (no external resources)."""
    js = ""
    if server:
        js = (f"<script>window.MX_SERVER = {scopes.script_json(server)};"
              f"window.MX_PAGE = {scopes.script_json(data or {})};</script><script>{PAGE_JS}</script>")
    foot = status or "engine on 127.0.0.1 only \u00b7 nothing leaves this machine"
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<meta name="referrer" content="no-referrer"><link rel="icon" href="data:,">'
            f"<title>{htmlesc.escape(title)}</title><style>{PAGE_CSS}</style></head>"
            f"<body><main>{MARK}<h1>Matrix<i>\u00b7</i>Multiverse</h1>{body}</main>"
            f"<footer>{htmlesc.escape(foot)}</footer>{js}</body></html>")


LEDE = ('<p class="lede">A universe is one folder, indexed into a knowledge graph of its code, '
        'notebooks, SQL and docs that you can explore and switch between.</p>')

PROGRESS_HTML = (
    '<section id="prog" hidden aria-live="polite">'
    '<span class="lbl">Build</span>'
    '<div class="phase"><span id="phase">starting</span><span id="pct"></span></div>'
    '<div class="bar indet" id="bar" role="progressbar" aria-label="Build progress" aria-valuemin="0" '
    'aria-valuemax="100"><span></span></div>'
    '<div id="fail" hidden><p id="fail-msg" role="alert"></p><pre class="log tail" id="fail-tail" hidden>'
    '</pre><div class="acts"><button type="button" class="primary" id="retry">Retry</button>'
    '<button type="button" id="viewlog2">View log</button></div></div>'
    '<div class="acts"><button type="button" id="stop">Stop build</button></div>'
    '<details class="log" id="logbox"><summary>Log<span id="logn"></span></summary>'
    '<pre class="log" id="log" tabindex="0" aria-label="Build log"></pre>'
    '<div class="loghead"><span id="logwhen"></span><button type="button" class="quiet" id="copylog">Copy'
    '</button></div></details></section>'
    '<p class="alert" id="alert" role="alert"></p>')

ADD_HTML = (
    '<form id="add" novalidate><span class="lbl">New universe</span>'
    '<label class="lbl" for="root" style="margin-top:16px">Folder</label>'
    '<div class="field"><input id="root" autocomplete="off" spellcheck="false" '
    'placeholder="C:\\path\\to\\folder"><button type="button" id="browse" aria-expanded="false" '
    'aria-controls="fs">Browse</button></div>'
    '<div class="fs" id="fs" hidden role="group" aria-label="Folder browser">'
    '<nav class="crumbs" id="crumbs" aria-label="Path"></nav><ul class="dirs" id="dirs" aria-label="Folders"></ul>'
    '<div class="acts"><button type="button" id="fs-up">Up</button><button type="button" id="fs-use">'
    'Use this folder</button><span class="grow"></span><button type="button" class="quiet" id="fs-x">Close'
    '</button></div></div>'
    '<label class="lbl" for="name">Name<small>optional</small></label>'
    '<div class="field"><input id="name" autocomplete="off" spellcheck="false" placeholder="defaults to the '
    'folder name"></div>'
    '<div class="acts"><button type="submit" class="primary" id="check">Check folder</button>'
    '<span class="faint">counts the files first, then builds</span></div></form>'
    '<div id="pre" hidden aria-live="polite"></div>')


def list_html(ss, base, skip=None):
    rows = []
    for s in ss:
        if s["id"] == skip:
            continue
        n = (f"{s['nodes']:,} nodes" if s.get("built") and s.get("nodes") is not None
             else "building" if s.get("building") else "not built")
        rows.append(f'<li><a href="{base}/u/{quote(s["id"])}/"><b>{htmlesc.escape(s["name"])}</b>'
                    f'<span class="n">{htmlesc.escape(n)}</span>'
                    f'<span class="r">{htmlesc.escape(s["root"])}</span></a></li>')
    return (f'<section><span class="lbl">Universes</span><ul class="list">{"".join(rows)}</ul></section>'
            if rows else "")


SCOPES_BLOCK = re.compile(r'<script id="mx-scopes">.*?</script>', re.S)


def inject(html, server, scopes_obj):
    """graph.html + MX_SERVER (and a fresh MX_SCOPES) before </head>."""
    fresh = f'<script id="mx-scopes">window.MX_SCOPES = {scopes.script_json(scopes_obj)};</script>'
    head = f"<script>window.MX_SERVER = {scopes.script_json(server)};</script>"
    html, n = SCOPES_BLOCK.subn(lambda _m: fresh, html, count=1)
    if not n:
        head += fresh
    i = html.lower().find("</head>")
    return html[:i] + head + html[i:] if i >= 0 else head + html


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False         # on Windows SO_REUSEADDR allows port stealing

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        socketserver.TCPServer.server_bind(self)   # skip HTTPServer's reverse-DNS getfqdn
        self.server_name, self.server_port = "127.0.0.1", self.server_address[1]


class Handler(BaseHTTPRequestHandler):
    server_version = "Matrix"
    sys_version = ""
    timeout = 60
    # set by make_server
    token = ""
    key = ""
    port = 0
    current = None
    jobs = None
    verbose = False
    allow_unc = False

    # -- plumbing ----------------------------------------------------------
    def log_message(self, fmt, *args):
        pass

    def log_request(self, code="-", size="-"):
        """Quiet by default: errors and changes only (no polls, no page GETs)."""
        try:
            c = int(code)
        except (TypeError, ValueError):
            c = 0
        path = self.path.split("?", 1)[0]
        keyed = bool(self.key) and path.startswith(f"/s/{self.key}")
        if keyed:
            path = "/s/*" + path[3 + len(self.key):]                # never log the page key
        if self.command in ("GET", "HEAD"):
            # pages and polls are not news; an unbuilt universe's page is a 404 by contract
            loud = c >= 500 if keyed and not path.startswith("/s/*/api/") else c >= 400
        else:
            loud = True
        if self.verbose or loud:
            say(f"{self.command} {path} {code}")

    def send(self, status, body, ctype, extra=()):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def json(self, obj, status=200):
        self.send(status, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def html(self, text, status=200):
        self.send(status, text, "text/html; charset=utf-8", [("Content-Security-Policy", CSP)])

    def redirect(self, where, status=302):
        self.send_response(status)
        self.send_header("Location", where)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()

    def same(self, a, b=None):
        b = self.token if b is None else b
        return isinstance(a, str) and hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))

    @property
    def base(self):
        return f"/s/{self.key}"

    def body(self):
        if self.headers.get("Transfer-Encoding"):
            raise HttpError(411, "send a Content-Length body")
        n = self.headers.get("Content-Length")
        if n is None:
            return {}
        try:
            n = int(n)
        except ValueError:
            raise HttpError(400, "bad Content-Length")
        if n < 0 or n > MAX_BODY:
            self.close_connection = True
            raise HttpError(413, f"body over {MAX_BODY} bytes")
        raw = self.rfile.read(n) if n else b""
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise HttpError(400, "body is not JSON")
        if not isinstance(data, dict):
            raise HttpError(400, "body must be a JSON object")
        return data

    # -- dispatch ----------------------------------------------------------
    def do_GET(self):
        self.route("GET")

    def do_HEAD(self):
        self.route("HEAD")

    def do_POST(self):
        self.route("POST")

    def do_PATCH(self):
        self.route("PATCH")

    def do_DELETE(self):
        self.route("DELETE")

    def do_PUT(self):
        self.route("PUT")

    def do_OPTIONS(self):                # no CORS, ever
        self.route("OPTIONS")

    def route(self, method):
        is_page = False
        try:
            hosts = self.headers.get_all("Host") or []
            if len(hosts) != 1 or hosts[0].strip().lower() not in (
                    f"127.0.0.1:{self.port}", f"localhost:{self.port}"):
                raise HttpError(421, "bad Host header")
            origin = self.headers.get_all("Origin") or []
            if origin and (len(origin) != 1
                           or origin[0].strip().lower() != "http://" + hosts[0].strip().lower()):
                raise HttpError(403, "cross-origin request refused")
            raw = self.path
            if not raw.startswith("/") or raw.startswith("//"):
                raise HttpError(400, "bad request target")
            u = urlsplit(raw)
            path, keyed = u.path, False
            m = re.match(r"/s/([^/]*)(/.*)?$", path)
            if m and self.same(m.group(1), self.key):
                keyed, path = True, m.group(2) or ""
            if path.startswith("/api/") or path == "/api":
                if not self.same(self.headers.get("X-Matrix-Token")):
                    raise HttpError(401, "missing or wrong X-Matrix-Token")
                if self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
                    raise HttpError(403, "cross-site request refused")
                return self.api(method, path, parse_qs(u.query))
            if method not in ("GET", "HEAD"):
                raise HttpError(405, "method not allowed")
            if path == "/favicon.ico":
                return self.send(204, b"", "image/x-icon")
            if not keyed:
                return self.html(self.locked_page(), 401)
            if path == "":
                return self.redirect(self.base + "/")
            is_page = True
            return self.pages(path)
        except HttpError as exc:
            if is_page and exc.status == 404:
                self.html(page("Matrix \u00b7 not found", LEDE + "<section><p>Nothing here: "
                               f"{htmlesc.escape(str(exc))}.</p><p><a href='{self.base}/new'>"
                               "<button type='button' tabindex='-1'>All universes</button></a></p>"
                               "</section>"), 404)
            else:
                self.json({"error": str(exc)}, exc.status)
        except scopes.ScopeError as exc:            # unreadable registry and the like
            msg = str(exc)
            if is_page:
                self.html(page("Matrix \u00b7 error", f"<section><span class='lbl'>Error</span>"
                               f"<p class='err' role='alert'>{htmlesc.escape(msg)}</p></section>"), 500)
            else:
                self.json({"error": msg}, 500)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as exc:             # never leak a traceback to the client
            say(f"serve: {type(exc).__name__}: {exc}")
            try:
                self.json({"error": f"internal error: {type(exc).__name__}"}, 500)
            except OSError:
                pass

    def locked_page(self):
        return page("Matrix \u00b7 open the start link", (
            LEDE + "<section><span class='lbl'>This link has no key</span>"
            "<p>The engine serves pages only under the start link it printed, which carries a "
            "key made fresh on every run, so links from an earlier run stop working.</p>"
            "<p class='dim'>Open Matrix from any terminal with</p>"
            "<p><code style='color:var(--text)'>matrix</code></p>"
            "<p class='dim'>or open the <code>open:</code> URL that <code>serve.py</code> printed.</p>"
            "</section>"))

    # -- pages -------------------------------------------------------------
    def pages(self, path):
        if path in ("/", "/new"):
            sid = self.default_id() if path == "/" else None
            if sid:
                return self.redirect(f"{self.base}/u/{quote(sid)}/")
            ss = [self.pub(s) for s in scopes.load()["scopes"]]
            return self.html(page("Matrix \u00b7 Multiverse", LEDE + list_html(ss, self.base)
                                  + "<section>" + ADD_HTML + "</section>" + PROGRESS_HTML,
                                  self.server_info(None), {"kind": "landing"}))
        m = re.fullmatch(r"/u/([^/]+)(/.*)?", path)
        if not m:
            raise HttpError(404, "no such page")
        sid = unquote(m.group(1))
        s = scopes.get(sid) if ID_RE.fullmatch(sid) else None
        if not s:
            raise HttpError(404, f"unknown universe {sid!r}")
        rest = m.group(2)
        if rest is None:
            return self.redirect(f"{self.base}/u/{quote(sid)}/", 301)
        if rest in ("/", "/graph.html"):
            return self.graph(s)
        return self.static(s, rest[1:])

    def server_info(self, sid):
        return {"token": self.token, "base": self.base, "current": sid}

    def default_id(self):
        ss = scopes.load()["scopes"]
        ids = [s["id"] for s in ss]
        if self.current in ids:
            return self.current
        here = scopes.key(HERE)
        for test in (lambda s: s["kind"] == "home" and bool(s.get("install"))
                     and scopes.key(s["install"]) == here,
                     lambda s: s["kind"] == "home", lambda s: True):
            hit = next((s["id"] for s in ss if test(s)), None)
            if hit:
                return hit
        return None

    def graph(self, s):
        path = os.path.join(scopes.out_of(s), "graph.html")
        if not os.path.isfile(path):
            return self.unbuilt(s)
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        self.html(inject(text, self.server_info(s["id"]),
                         scopes.embed(s["id"], self.jobs.building(), strict=True)))

    def unbuilt(self, s):
        job, last = self.jobs.live_job(s["id"]), self.jobs.last_job(s["id"])
        try:
            has_log = os.path.isfile(scopes.log_path(s))
        except scopes.ScopeError:
            has_log = False
        if job:
            state = "<p>A build is <b>running</b>; progress below.</p>"
        elif last and last["state"] == "failed":
            state = f"<p class='err'>The last build failed: {htmlesc.escape(last['phase'])}.</p>"
        elif last and last["state"] == "cancelled":
            state = "<p>The last build was <b>stopped</b> before it finished.</p>"
        elif has_log:
            state = "<p>Not built: an earlier build did not finish (its log is kept).</p>"
        else:
            state = "<p class='dim'>Not built yet.</p>"
        body = (LEDE + "<section><span class='lbl'>Universe</span>"
                f"<p><b>{htmlesc.escape(s['name'])}</b> <span class='dim'>{htmlesc.escape(s['root'])}</span></p>"
                f"<div id='state'>{state}</div><div class='acts'><button type=\"button\" class=\"primary\" id=\"go\""
                f"{' hidden' if job else ''}>Build</button>"
                + ("<button type='button' id='viewlog'>View log</button>" if has_log and not job else "")
                + f"<span class='grow'></span><a href='{self.base}/new' tabindex='-1'><button type='button' "
                "class='quiet'>Add another folder</button></a></div></section>"
                + '<div id="pre" hidden aria-live="polite"></div>' + PROGRESS_HTML
                + list_html([self.pub(x) for x in scopes.load()["scopes"]], self.base, skip=s["id"]))
        data = {"kind": "unbuilt", "scope": self.pub(s), "job": job, "last": last}
        return self.html(page(f"Matrix \u00b7 {s['name']}", body, self.server_info(s["id"]), data), 404)

    def static(self, s, rel):
        """A file inside the scope's out dir; anything else is 404."""
        rel = unquote(rel)
        if (not rel or any(c in rel for c in "\\:\x00") or
                any(seg in ("", ".", "..") for seg in rel.split("/"))):
            raise HttpError(404, "not found")
        out = os.path.realpath(scopes.out_of(s))
        full = os.path.realpath(os.path.join(out, *rel.split("/")))
        try:
            ok = os.path.commonpath([os.path.normcase(full), os.path.normcase(out)]) \
                == os.path.normcase(out) and full != out
        except ValueError:
            ok = False
        if not ok or not os.path.isfile(full):      # no directory listing
            raise HttpError(404, "not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or full.endswith((".md", ".json", ".log")):
            ctype = ("text/plain" if full.endswith((".md", ".log")) else ctype) + "; charset=utf-8"
        with open(full, "rb") as fh:
            data = fh.read()
        self.send(200, data, ctype, [("Content-Security-Policy", CSP)])

    # -- API ---------------------------------------------------------------
    def api(self, method, path, q):
        parts = path.split("/")[2:]        # after /api/
        if parts == ["scopes"]:
            if method == "GET":
                return self.json(scopes.embed(self.default_id(), self.jobs.building(), strict=True))
            if method == "POST":
                b = self.body()
                try:
                    s, existing = scopes.add(b.get("root"), b.get("name"), allow_unc=self.allow_unc)
                except scopes.ScopeError as exc:
                    raise HttpError(400, str(exc))
                pf = scopes.preflight(s["root"])
                return self.json({"scope": self.pub(s), "existing": existing, "preflight": pf})
        elif parts == ["shutdown"]:
            if method != "POST":
                raise HttpError(405, "method not allowed")
            self.json({"stopping": True})
            say("shutdown requested")
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return None
        elif len(parts) in (2, 3) and parts[0] == "scopes":
            sid = unquote(parts[1])
            if not ID_RE.fullmatch(sid):
                raise HttpError(404, "unknown universe")
            if len(parts) == 3 and parts[2] == "build" and method == "POST":
                b = self.body()
                if not scopes.get(sid):
                    raise HttpError(404, f"unknown universe {sid!r}")
                return self.json({"job": self.jobs.start(sid, bool(b.get("ifStale")),
                                                         bool(b.get("force")),
                                                         b.get("full", True) is not False)})
            if len(parts) == 3 and parts[2] == "cancel" and method == "POST":
                jid = self.jobs.live_job(sid)
                return self.json({"cancelled": bool(jid and self.jobs.cancel(jid)), "job": jid})
            if len(parts) == 3 and parts[2] == "log" and method == "GET":
                s = scopes.get(sid)
                if not s:
                    raise HttpError(404, f"unknown universe {sid!r}")
                return self.json(read_log(s, q.get("tail", ["500"])[0]))
            if len(parts) == 2 and method == "PATCH":
                b = self.body()
                try:
                    return self.json({"scope": self.pub(scopes.rename(sid, b.get("name")))})
                except KeyError:
                    raise HttpError(404, f"unknown universe {sid!r}")
                except scopes.ScopeError as exc:
                    raise HttpError(400, str(exc))
            if len(parts) == 2 and method == "DELETE":
                if sid in self.jobs.building():
                    raise HttpError(409, "a build of this universe is running")
                try:
                    s = scopes.remove(sid)
                except KeyError:
                    raise HttpError(404, f"unknown universe {sid!r}")
                except scopes.ScopeError as exc:
                    raise HttpError(400, str(exc))
                return self.json({"removed": sid, "scope": scopes.public(s)})
        elif len(parts) == 2 and parts[0] == "jobs" and method == "GET":
            since = q.get("since", [None])[0]
            try:
                since = None if since is None else max(0, int(since))
            except ValueError:
                raise HttpError(400, "since must be a number")
            v = self.jobs.view(parts[1], since)
            if v is None:
                raise HttpError(404, "unknown job")
            return self.json(v)
        elif len(parts) == 3 and parts[0] == "jobs" and parts[2] == "cancel" and method == "POST":
            if self.jobs.view(parts[1]) is None:
                raise HttpError(404, "unknown job")
            return self.json({"cancelled": self.jobs.cancel(parts[1]), "job": parts[1]})
        elif parts == ["fs"] and method == "GET":
            return self.json(list_dirs(q.get("path", [""])[0], self.allow_unc))
        else:
            raise HttpError(404, "no such endpoint")
        raise HttpError(405, "method not allowed")

    def pub(self, s):
        return dict(scopes.public(s), building=s["id"] in self.jobs.building())


def read_log(s, tail):
    """The tail of a scope's persisted last_build.log + its time."""
    try:
        tail = min(max(int(tail), 1), 5000)
    except ValueError:
        raise HttpError(400, "tail must be a number")
    try:
        path = scopes.log_path(s)
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = deque((ln.rstrip("\n") for ln in fh), maxlen=tail)
        built = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (OSError, scopes.ScopeError):
        return {"log": [], "built": None}
    return {"log": list(lines), "built": built}


def list_dirs(path, allow_unc=False):
    """Directory NAMES under path (no files, no contents); no path -> roots."""
    if not path:
        if os.name == "nt":
            drives = os.listdrives() if hasattr(os, "listdrives") else [
                f"{c}:\\" for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if os.path.isdir(f"{c}:\\")]
            drives = [d for d in drives if not scopes.is_unc(d)]
            return {"path": "", "parent": None, "dirs": [d.replace("\\", "/") for d in drives]}
        return {"path": "", "parent": None, "dirs": ["/", os.path.expanduser("~")]}
    if "\x00" in path:
        raise HttpError(400, "bad path")
    if scopes.is_unc(path) and not allow_unc:
        raise HttpError(400, "network (UNC) paths are refused; use a mapped drive letter")
    if re.fullmatch(r"[A-Za-z]:", path):
        path += "/"
    path = os.path.expanduser(path)
    if not os.path.isabs(path):
        raise HttpError(400, "path must be absolute")
    path = os.path.abspath(path)
    if not os.path.isdir(path):
        raise HttpError(404, "no such folder")
    dirs = []
    try:
        with os.scandir(path) as it:
            for e in it:
                try:
                    if not e.is_dir():
                        continue
                    attrs = getattr(e.stat(follow_symlinks=False), "st_file_attributes", 0)
                except OSError:
                    continue
                hidden = e.name.startswith(".") or bool(attrs & WIN_HIDDEN)
                dirs.append({"name": e.name, "hidden": True} if hidden else e.name)
    except PermissionError:
        raise HttpError(403, "access denied")
    except OSError as exc:
        raise HttpError(400, f"cannot list folder ({exc.strerror})")
    dirs.sort(key=lambda d: (d if isinstance(d, str) else d["name"]).lower())
    parent = os.path.dirname(path)
    res = {"path": path.replace("\\", "/"),
           "parent": parent.replace("\\", "/") if parent != path else None,
           "dirs": dirs[:MAX_DIRS]}
    if len(dirs) > MAX_DIRS:
        res["truncated"] = True
    return res


# --------------------------------------------------------------------------
# engine.json (read by the `matrix` launcher)
# --------------------------------------------------------------------------

def engine_path():
    return os.path.join(scopes.home(), "engine.json")


def write_engine(info):
    """Atomic, owner-only where the OS allows it (posix 0600; on Windows the
    user profile's ACLs already keep it to this user)."""
    path = engine_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(info, fh, indent=2)
            fh.write("\n")
        scopes._retry(lambda: os.replace(tmp, path))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def remove_engine(pid):
    """Delete engine.json if it still describes this process."""
    path = engine_path()
    try:
        with open(path, encoding="utf-8") as fh:
            if json.load(fh).get("pid") != pid:
                return
        os.remove(path)
    except (OSError, ValueError):
        pass


def make_server(port=DEFAULT_PORT, current=None, verbose=False, allow_unc=False):
    """Bound server (port falls back to a free one) with a fresh token and page key."""
    try:
        srv = Server(("127.0.0.1", port), Handler)
    except OSError:
        srv = Server(("127.0.0.1", 0), Handler)
    attrs = {"token": secrets.token_urlsafe(32), "key": secrets.token_urlsafe(18),
             "port": srv.server_address[1], "current": current, "jobs": Jobs(),
             "verbose": verbose, "allow_unc": allow_unc}
    srv.RequestHandlerClass = type("BoundHandler", (Handler,), attrs)
    srv.jobs, srv.token, srv.key = attrs["jobs"], attrs["token"], attrs["key"]
    return srv


def main(argv=None):
    ap = argparse.ArgumentParser(description="Matrix Multiverse engine (127.0.0.1 only).")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--open", action="store_true", help="open the browser")
    ap.add_argument("--scope", help="universe id to open first")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    ap.add_argument("--allow-unc", action="store_true",
                    help="allow \\\\server\\share folders (Windows sends your credentials to that host)")
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    if args.scope and not scopes.get(args.scope):
        print(f"serve: error: no such universe {args.scope!r} "
              f"(see: python scopes.py list)", file=sys.stderr)
        return 2
    srv = make_server(args.port, args.scope, args.verbose, args.allow_unc)
    port = srv.server_address[1]
    url = f"http://127.0.0.1:{port}/s/{srv.key}/"
    try:
        write_engine({"pid": os.getpid(), "port": port, "url": url, "token": srv.token,
                      "install": HERE.replace("\\", "/"), "python": sys.executable.replace("\\", "/"),
                      "started": stamp()})
    except OSError as exc:
        print(f"serve: engine.json not written ({exc}); `matrix` will not find this engine",
              file=sys.stderr)
    print(f"Matrix multiverse engine on http://127.0.0.1:{port}/  (Ctrl+C or `matrix stop` stops)")
    print(f"open: {url}", flush=True)
    if args.open:
        threading.Timer(0.3, webbrowser.open, (url,)).start()
    try:
        srv.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        srv.jobs.kill_all()
        srv.server_close()
        remove_engine(os.getpid())
        say("engine stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
