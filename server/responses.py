"""Response helpers and static-file serving with cached gzip."""
from __future__ import annotations

import gzip
import json
import threading
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

from . import config

GZIP_TYPES = {
    ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
    ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
    ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
}
_gzip_cache: dict[str, tuple[int, bytes]] = {}
_gzip_lock = threading.Lock()


def _cache_control(path: str) -> str | None:
    if path.startswith("/api/"):
        return None
    if path.endswith("/") or path.endswith(".html"):
        return "no-cache, max-age=0"
    if path.startswith(("/assets/nasa3d/", "/assets/draco/")):
        return "public, max-age=604800"  # 3D models are reused by every explorer opening
    name = path.rsplit("/", 1)[-1]
    if path.startswith("/assets/") and name.rsplit(".", 1)[-1] in ("js", "css") and "-" in name:
        return "public, max-age=31536000, immutable"  # content-hashed Vite bundles
    return None


NOT_FOUND_PAGE = "404.html"  # web/public/404.html, copied into web/dist by the build


class BaseHandler(SimpleHTTPRequestHandler):
    # Explicit types: the server's mimetypes table may lack these (e.g. .webp came out as application/octet-stream).
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".json": "application/json",
        ".geojson": "application/geo+json", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
        ".vtt": "text/vtt", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm",
        ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
        ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(config.WEB_DIST), **kwargs)

    def translate_path(self, path):
        if urlparse(path).path == "/favicon.ico":  # browsers ask for it by default; the site icon is an SVG
            path = "/favicon.svg"
        return super().translate_path(path)

    def send_error(self, code, message=None, explain=None):
        """Static 404s get the site's styled page (status stays 404); API and other errors keep the default."""
        path = urlparse(self.path).path
        page = config.WEB_DIST / NOT_FOUND_PAGE
        if code != 404 or path.startswith("/api/") or self.command not in ("GET", "HEAD") or not page.is_file():
            return super().send_error(code, message, explain)
        try:
            body = page.read_bytes()
        except OSError:
            return super().send_error(code, message, explain)
        self.log_error("code %d, message %s", code, message or "Not Found")
        self.send_response(404, message)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def accepts_gzip(self) -> bool:
        return "gzip" in self.headers.get("Accept-Encoding", "")

    def end_headers(self):
        policy = _cache_control(urlparse(self.path).path)
        if policy:
            self.send_header("Cache-Control", policy)
        super().end_headers()

    def send_json(self, value, code=200):
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        compressed = len(body) > 1024 and self.accepts_gzip()
        if compressed:
            body = gzip.compress(body, compresslevel=1, mtime=0)
        self.send_response(code)
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, body: bytes, content_type: str, max_age: int):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", f"public, max-age={max_age}")
        self.end_headers()
        self.wfile.write(body)

    def serve_static_gzip(self, path: str) -> bool:
        """Text assets go out gzip-compressed once per file version."""
        if not self.accepts_gzip():
            return False
        rel = path.lstrip("/")
        if rel == "" or rel.endswith("/"):
            rel += "index.html"
        content_type = GZIP_TYPES.get(Path(rel).suffix.lower())
        if not content_type:
            return False
        root = config.WEB_DIST.resolve()
        try:
            file = (root / rel).resolve()
        except (OSError, ValueError):
            return False
        if root not in file.parents or not file.is_file():
            return False
        stat = file.stat()
        if stat.st_size < 1024:
            return False
        key = str(file)
        cached = _gzip_cache.get(key)
        if not cached or cached[0] != stat.st_mtime_ns:
            with _gzip_lock:
                cached = _gzip_cache.get(key)
                if not cached or cached[0] != stat.st_mtime_ns:
                    cached = (stat.st_mtime_ns, gzip.compress(file.read_bytes(), compresslevel=9, mtime=0))
                    _gzip_cache[key] = cached
        body = cached[1]
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
        self.end_headers()
        self.wfile.write(body)
        return True
