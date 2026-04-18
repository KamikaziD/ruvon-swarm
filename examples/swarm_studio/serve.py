#!/usr/bin/env python3
"""
Compressed static server for the Ruvon browser demo.

Drop-in replacement for `python -m http.server`:

    python examples/browser_demo/serve.py [port]   # default 8080

Negotiates brotli (if installed) or gzip compression for text-based assets,
reducing the ruvon-sdk wheel transfer size by ~25–35%.

CDN proxy (/pyodide/*)
    Proxies Pyodide CDN resources through localhost so COEP: require-corp
    is satisfied without depending on the CDN's own CORP headers.
    Responses are cached in ./pyodide-cache/ after the first download.

Optional brotli support:
    pip install brotli
"""

import gzip
import http.server
import os
import socketserver
import sys
import threading
import urllib.request
import urllib.error
from pathlib import Path

COMPRESSIBLE = {".whl", ".js", ".mjs", ".html", ".css", ".json", ".txt", ".py", ".yaml", ".yml"}

PYODIDE_VERSION = "v0.26.4"
PYODIDE_CDN_BASE = f"https://cdn.jsdelivr.net/pyodide/{PYODIDE_VERSION}/full/"
PYODIDE_PREFIX   = "/pyodide/"   # local URL prefix

# Disk cache so the 30 MB WASM is only downloaded once
DEMO_DIR   = Path(__file__).resolve().parent
CACHE_DIR  = DEMO_DIR / "pyodide-cache"

# (path, encoding, mtime) → compressed bytes
_cache: dict = {}
_cache_lock = threading.Lock()

try:
    import brotli as _brotli
    _HAS_BROTLI = True
except ImportError:
    _HAS_BROTLI = False


def _fetch_pyodide_resource(rel_path: str) -> tuple[bytes, str]:
    """
    Fetch a Pyodide resource: from disk cache first, then CDN.
    Returns (data, content_type).
    """
    CACHE_DIR.mkdir(exist_ok=True)
    # Flatten any sub-path into a safe filename
    safe_name = rel_path.replace("/", "_")
    cache_file = CACHE_DIR / safe_name

    if cache_file.exists():
        data = cache_file.read_bytes()
    else:
        cdn_url = PYODIDE_CDN_BASE + rel_path
        print(f"  [proxy] fetching {cdn_url}", flush=True)
        try:
            req = urllib.request.Request(cdn_url, headers={"User-Agent": "ruvon-serve/1.0"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
        except urllib.error.URLError as exc:
            raise RuntimeError(f"CDN fetch failed: {exc}") from exc
        cache_file.write_bytes(data)
        print(f"  [proxy] cached {safe_name} ({len(data)//1024} KB)", flush=True)

    # Guess content type
    if rel_path.endswith(".wasm"):
        ct = "application/wasm"
    elif rel_path.endswith(".js") or rel_path.endswith(".mjs"):
        ct = "application/javascript"
    elif rel_path.endswith(".json"):
        ct = "application/json"
    else:
        ct = "application/octet-stream"
    return data, ct


class CompressedHandler(http.server.SimpleHTTPRequestHandler):

    def do_GET(self):
        # ── Pyodide CDN proxy ──────────────────────────────────────────────
        if self.path.startswith(PYODIDE_PREFIX):
            rel = self.path[len(PYODIDE_PREFIX):]
            # Strip query strings if any
            rel = rel.split("?")[0]
            if not rel:
                self.send_error(400, "Missing Pyodide resource path")
                return
            try:
                data, ct = _fetch_pyodide_resource(rel)
            except Exception as exc:
                self.send_error(502, str(exc))
                return
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()   # adds COOP/COEP/CORP via override
            self.wfile.write(data)
            return

        # ── Redirect bare root to the demo page ───────────────────────────
        if self.path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", "/index.html")
            self.end_headers()
            return

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().do_GET()

        ext = Path(path).suffix.lower()
        if ext not in COMPRESSIBLE:
            return super().do_GET()

        accept = self.headers.get("Accept-Encoding", "")
        encoding = None
        if _HAS_BROTLI and "br" in accept:
            encoding = "br"
        elif "gzip" in accept:
            encoding = "gzip"

        if encoding is None:
            return super().do_GET()

        mtime = os.path.getmtime(path)
        cache_key = (path, encoding, mtime)
        with _cache_lock:
            if cache_key not in _cache:
                data = Path(path).read_bytes()
                if encoding == "br":
                    _cache[cache_key] = _brotli.compress(data, quality=6)
                else:
                    _cache[cache_key] = gzip.compress(data, compresslevel=6)
            compressed = _cache[cache_key]

        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Encoding", encoding)
        self.send_header("Content-Length", str(len(compressed)))
        self.send_header("Vary", "Accept-Encoding")
        self.end_headers()   # _send_security_headers called here via override
        self.wfile.write(compressed)

    def _send_security_headers(self):
        """Required for SharedArrayBuffer → wllama multi-thread WASM (2-4× faster)."""
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")

    def end_headers(self):
        self._send_security_headers()
        super().end_headers()

    def log_message(self, fmt, *args):
        # Suppress 200/304 noise; still show errors
        if len(args) >= 2 and args[1] in ("200", "304"):
            return
        super().log_message(fmt, *args)


PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8081
mode = "brotli + gzip" if _HAS_BROTLI else "gzip"

print(f"Serving on http://localhost:{PORT}  [{mode} compression]")
print(f"Pyodide proxy: {PYODIDE_PREFIX} → {PYODIDE_CDN_BASE}")
print(f"Cache dir: {CACHE_DIR}")
print("Press Ctrl-C to stop.")
print()

os.chdir(DEMO_DIR)


class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


httpd = ThreadedTCPServer(("", PORT), CompressedHandler)
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    httpd.shutdown()
    httpd.server_close()
    print("\nStopped.")
    sys.exit(0)
