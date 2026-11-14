"""HTTP entry point: routes API requests and serves the built front end."""
from __future__ import annotations

import sys
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse

from . import config  # noqa: F401  (sets up sys.path for src/ modules)
from . import routes, search
from .params import Query
from .resources import resources  # noqa: F401  (re-exported for warmup and offline tools)
from .responses import BaseHandler

from scripts.visual_geology_v1.runtime import VisualMixin

SEARCH_PATHS = {
    "/api/window": (search.window, False),
    "/api/mars-window": (search.window, True),
    "/api/search": (search.search, False),
    "/api/mars-search": (search.search, True),
}


def resolve(path):
    if path in SEARCH_PATHS:
        fn, is_mars = SEARCH_PATHS[path]
        return (lambda h, q: fn(q, is_mars)), True
    if path in routes.EXACT:
        return routes.EXACT[path], path in routes.KEEP_BLANK
    for prefix, fn in routes.PREFIX:
        if path.startswith(prefix):
            return fn, False
    return None, False


class Handler(VisualMixin, BaseHandler):
    json_response = BaseHandler.send_json  # name used by VisualMixin

    def do_GET(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            if not self.serve_static_gzip(parsed.path):
                super().do_GET()
            return
        if parsed.path.startswith("/api/visual-geology/"):
            return self.visual_get(parsed.path)
        self.api_path = parsed.path
        route, keep_blank = resolve(parsed.path)
        if route is None:
            return self.send_json({"error": "Unknown path"}, 404)
        try:
            result = route(self, Query(parsed.query, keep_blank))
            if result is not None:
                self.send_json(result)
        except (ValueError, TypeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            print("Request error:", repr(exc), flush=True)
            self.send_json({"error": "Local model unavailable"}, 500)


def main():
    import torch
    from lunar_pipeline import MODEL_PATH
    torch.set_num_threads(config.TORCH_THREADS)
    if not config.WEB_DIST.exists():
        raise SystemExit("Build the frontend first: cd web && npm run build")
    if not MODEL_PATH.exists():
        raise SystemExit("Model weights missing: link the data directory (see README)")
    from scripts.search_latency_v1.warmup import warm
    warm(sys.modules[__name__])
    server = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    server.daemon_threads = True
    print(f"Analog Atlas: http://localhost:{config.PORT}/", flush=True)
    server.serve_forever()
