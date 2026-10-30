"""Run graph.html's built-in self-test in headless Chrome, in webgl and nogl modes.

    python tests/selftest.py [--html PATH] [--modes webgl,nogl] [--chrome EXE] [--keep]

Without --html it builds the tests/smoke.py sample corpus into a temp folder
(sandboxed MATRIX_HOME and HOME) and tests that graph.html. Chrome is found
via --chrome, the CHROME environment variable, PATH, or the usual install
locations on Windows, macOS and Linux; any Chromium-based browser works.

Each mode gets a fresh Chrome with a throwaway profile, driven over the
DevTools protocol (stdlib only: a minimal websocket client is included).
webgl uses SwiftShader (software GL) and must really render with WebGL;
nogl loads the page with ?nogl=1 (the Canvas2D renderer). The page is
loaded with a #selftest= hash so it boots in test mode, then the test suite
is run once and its results are read from the page's #mxstatus element.
Exit 0 only if every test passes (n/a tests count as passed) in every mode.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # works under -I too
sys.dont_write_bytecode = True                                    # no tests/__pycache__
import smoke  # noqa: E402

# Timing-sensitive tests. A run whose only failures are these, or test timeouts
# (a symptom of a busy machine), is retried once in a fresh browser.
FLAKY = {"facets.degSlider", "minimap.track", "camera.fly", "universe.flyTo"}
BOOT_TIMEOUT = 90          # seconds for the page to report ready (and WebGL to link)
RUN_TIMEOUT = 900          # seconds for the whole suite in one mode
VIRTUAL_BUDGET_MS = 3_600_000   # page clock budget; far more than boot + suite need


# --------------------------------------------------------------------------
# Chrome
# --------------------------------------------------------------------------

def rmtree(path, seconds=15):
    """Remove path, retrying while Windows still holds files of an exiting browser."""
    end = time.monotonic() + seconds
    while True:
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.exists(path) or time.monotonic() > end:
            return
        time.sleep(0.25)


def find_chrome(explicit=None):
    cands = [explicit, os.environ.get("CHROME")]
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
                 "chrome", "msedge"):
        cands.append(shutil.which(name))
    if sys.platform == "win32":
        for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            root = os.environ.get(env)
            if root:
                cands.append(os.path.join(root, "Google", "Chrome", "Application", "chrome.exe"))
                cands.append(os.path.join(root, "Chromium", "Application", "chrome.exe"))
        for env in ("PROGRAMFILES(X86)", "PROGRAMFILES"):
            root = os.environ.get(env)
            if root:
                cands.append(os.path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"))
    elif sys.platform == "darwin":
        for app in ("Google Chrome", "Chromium", "Microsoft Edge"):
            for base in ("/Applications", os.path.expanduser("~/Applications")):
                cands.append(f"{base}/{app}.app/Contents/MacOS/{app}")
    else:
        cands += ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
                  "/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
                  "/snap/bin/chromium"]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


class Browser:
    """One headless Chrome with a private profile and a DevTools port."""

    def __init__(self, exe, profile):
        self.profile = profile
        args = [exe, "--headless=new", "--remote-debugging-port=0",
                "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
                "--disable-extensions", "--disable-background-networking", "--disable-sync",
                "--disable-component-update", "--disable-default-apps",
                "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows", "--window-size=1600,1000",
                "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        if sys.platform.startswith("linux") and (os.environ.get("CI") or os.geteuid() == 0):
            args.append("--no-sandbox")    # CI containers lack the user namespaces it needs
        args.append("about:blank")
        tmp = os.path.join(profile, "tmp")        # keep the browser's temp files in the profile
        os.makedirs(tmp, exist_ok=True)
        env = dict(os.environ, TMP=tmp, TEMP=tmp, TMPDIR=tmp)
        self.proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, env=env)
        self.port = self._port()

    def _port(self):
        path = os.path.join(self.profile, "DevToolsActivePort")
        end = time.monotonic() + 60
        while time.monotonic() < end:
            if self.proc.poll() is not None:
                raise RuntimeError(f"browser exited early (code {self.proc.returncode})")
            try:
                with open(path, encoding="utf-8") as fh:
                    first, self.browser_path = fh.readline().strip(), fh.readline().strip()
                if first.isdigit() and self.browser_path:
                    return int(first)
            except OSError:
                pass
            time.sleep(0.1)
        raise RuntimeError("browser did not open a DevTools port within 60 s")

    def page_ws(self):
        url = f"http://127.0.0.1:{self.port}/json/list"
        end = time.monotonic() + 30
        while time.monotonic() < end:
            with urllib.request.urlopen(url, timeout=10) as r:
                for t in json.load(r):
                    if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                        return t["webSocketDebuggerUrl"]
            time.sleep(0.2)
        raise RuntimeError("no page target")

    def close(self):
        if self.proc.poll() is None:
            try:                                  # graceful: lets every child process exit
                ws = WebSocket(f"ws://127.0.0.1:{self.port}{self.browser_path}", timeout=10)
                ws.send(json.dumps({"id": 1, "method": "Browser.close"}))
                self.proc.wait(15)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.terminate()
                try:
                    self.proc.wait(10)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(10)
        rmtree(self.profile)


# --------------------------------------------------------------------------
# minimal websocket client (RFC 6455, client side, text frames) + CDP
# --------------------------------------------------------------------------

class WebSocket:
    def __init__(self, url, timeout=RUN_TIMEOUT):
        assert url.startswith("ws://"), url
        hostport, _, path = url[5:].partition("/")
        host, _, port = hostport.rpartition(":")
        self.sock = socket.create_connection((host, int(port)), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                           f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("websocket handshake: connection closed")
            head += chunk
        head, self.buf = head.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise ConnectionError("websocket handshake refused: " + head.split(b"\r\n", 1)[0].decode())

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(max(65536, n - len(self.buf)))
            if not chunk:
                raise ConnectionError("websocket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send(self, opcode, data):
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack("!Q", n)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def send(self, text):
        self._send(0x1, text.encode("utf-8"))

    def recv(self):
        message = b""
        while True:
            b0, b1 = self._read(2)
            fin, opcode, n = b0 & 0x80, b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            data = self._read(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x8:
                raise ConnectionError("websocket closed by peer")
            if opcode == 0x9:
                self._send(0xA, data)
                continue
            if opcode in (0x0, 0x1, 0x2):
                message += data
                if fin:
                    return message.decode("utf-8")

    def close(self):
        try:
            self._send(0x8, b"")
        except OSError:
            pass
        self.sock.close()


class CDP:
    def __init__(self, ws_url):
        self.ws, self.next_id = WebSocket(ws_url), 0

    def call(self, method, **params):
        self.next_id += 1
        mid = self.next_id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def eval(self, expr, await_promise=False):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=await_promise)
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise RuntimeError("page: " + str((d.get("exception") or {}).get("description") or d.get("text")))
        return (r.get("result") or {}).get("value")


# --------------------------------------------------------------------------
# self-test
# --------------------------------------------------------------------------

STATUS = "(() => { const e = document.getElementById('mxstatus'); return e ? e.textContent : ''; })()"
# The page booted with a #selftest= hash that matches no test (so it is in test
# mode, but runs nothing); run the suite once here and resolve with the final status.
RUN = """(async () => {
  await MX.selftest.run("1");
  MX.status();
  await new Promise(r => setTimeout(r, 100));
  return document.getElementById("mxstatus").textContent;
})()"""


def status(cdp):
    raw = cdp.eval(STATUS)
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {}


def run_mode(exe, html, mode, scratch):
    url = pathlib.Path(html).resolve().as_uri() + ("?nogl=1" if mode == "nogl" else "") + "#selftest=-"
    profile = tempfile.mkdtemp(prefix=f"chrome-{mode}-", dir=scratch)
    browser = Browser(exe, profile)
    cdp = None
    try:
        cdp = CDP(browser.page_ws())
        cdp.call("Page.enable")
        cdp.call("Page.navigate", url=url)
        end, st = time.monotonic() + BOOT_TIMEOUT, {}
        while time.monotonic() < end:
            st = status(cdp)
            renderer = (st.get("render") or {}).get("renderer")
            if st.get("ready") and (mode == "nogl" or renderer == "webgl"):
                break
            time.sleep(0.25)
        else:
            r = st.get("render") or {}
            return {}, [f"page not ready in {BOOT_TIMEOUT}s (ready={st.get('ready')}, "
                        f"renderer={r.get('renderer')}, reason={r.get('glReason')!r})"], st
        # Virtual time (what --virtual-time-budget uses): from here on page timers and frames
        # run on a simulated clock that jumps ahead whenever the page is idle, so the
        # timing-sensitive tests depend far less on how loaded the machine is.
        cdp.call("Emulation.setVirtualTimePolicy", policy="pauseIfNetworkFetchesPending",
                 budget=VIRTUAL_BUDGET_MS)
        st = json.loads(cdp.eval(RUN, await_promise=True))
        renderer = (st.get("render") or {}).get("renderer")
        tests = st.get("selftest") or {}
        fails = [f"{k}: {str(v.get('msg'))[:160]}" for k, v in tests.items() if not v.get("pass")]
        if mode == "webgl" and renderer != "webgl":
            fails.append(f"renderer is {renderer!r} after the run, expected webgl")
        if mode == "nogl" and renderer != "canvas":
            fails.append(f"renderer is {renderer!r} with ?nogl=1, expected canvas")
        return tests, fails, st
    finally:
        if cdp:
            cdp.ws.close()
        browser.close()


def timing_only(failure):
    name, _, msg = failure.partition(": ")
    return name in FLAKY or msg.startswith("timeout ")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--html", help="graph.html to test (default: build the smoke sample)")
    ap.add_argument("--modes", default="webgl,nogl")
    ap.add_argument("--chrome", help="browser executable (default: $CHROME, PATH, usual places)")
    ap.add_argument("--keep", action="store_true", help="keep the temp folder")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(errors="replace")

    exe = find_chrome(args.chrome)
    if not exe:
        print("FAIL no Chrome/Chromium found: set CHROME or pass --chrome", file=sys.stderr)
        return 2
    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    bad_mode = [m for m in modes if m not in ("webgl", "nogl")]
    if bad_mode or not modes:
        print(f"FAIL unknown mode(s) {bad_mode}; use webgl and/or nogl", file=sys.stderr)
        return 2

    base = tempfile.mkdtemp(prefix="matrix-selftest-")
    good = True
    try:
        if args.html:
            html = os.path.abspath(args.html)
        else:
            try:
                _target, mx, _env = smoke.install(base)
            except smoke.Fail as exc:
                print(f"FAIL building the sample: {exc}", file=sys.stderr)
                return 1
            with open(os.path.join(mx, "config.json"), encoding="utf-8") as fh:
                html = os.path.join(mx, json.load(fh).get("out_dir") or "out", "graph.html")
        if not os.path.isfile(html):
            print(f"FAIL missing {html}", file=sys.stderr)
            return 1
        print(f"browser: {exe}\npage:    {html}", flush=True)
        for mode in modes:
            t0 = time.monotonic()
            tests, fails, st = run_mode(exe, html, mode, base)
            flake = []
            if fails and tests and all(timing_only(f) for f in fails):
                flake = fails
                tests, fails, st = run_mode(exe, html, mode, base)   # one retry, fresh browser
            na = sum(1 for v in tests.values() if v.get("na"))
            errors = st.get("errors") or []
            ok = bool(tests) and not fails
            good &= ok
            print(f"{'PASS' if ok else 'FAIL'} {mode}: {len(tests) - len(fails)}/{len(tests)} passed"
                  f" ({na} n/a) in {time.monotonic() - t0:.0f}s"
                  f", renderer={(st.get('render') or {}).get('renderer')}"
                  + (", after one retry" if flake else ""), flush=True)
            for f in flake:
                print(f"     first run: {f}")
            for f in fails:
                print(f"     {f}")
            for e in errors[:10]:
                print(f"     page error: {str(e)[:200]}")
            if not tests and not fails:
                print("     no test results")
    finally:
        if args.keep:
            print(f"kept {base}")
        else:
            rmtree(base)
    print("selftest: " + ("all modes passed" if good else "FAILED"))
    return 0 if good else 1


if __name__ == "__main__":
    sys.exit(main())
