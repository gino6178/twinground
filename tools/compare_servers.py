"""Send the same API requests to two servers and report any JSON differences.

Usage: python tools/compare_servers.py http://localhost:8765 http://localhost:8766
"""
import gzip
import json
import sys
import urllib.error
import urllib.request

VOLATILE = {"fine_job", "elapsed_ms", "elapsed_s", "generated_at", "job", "started_at"}

REQUESTS = [
    "/api/status",
    "/api/mars-sites",
    "/api/known-analogs",
    "/api/window?lat=8.7&lon=27.4&size_km=40",
    "/api/mars-window?lat=18.4&lon=77.7&size_km=40",
    "/api/search?lat=8.7&lon=27.4&size_km=20&surface=any&rock=any&limit=5",
    "/api/search?lat=-89&lon=0&size_km=40&purpose=facets&facet_use=overall&limit=5",
    "/api/search?lat=26.1&lon=3.6&size_km=40&purpose=facets&facet_use=overall&limit=8&offset=5",
    "/api/search?lat=8.7&lon=27.4&size_km=80&purpose=conditions&limit=5",
    "/api/search?lat=8.7&lon=27.4&size_km=40&purpose=physical&use=isru&limit=5",
    "/api/search?lat=8.7&lon=27.4&size_km=40&purpose=maxmatch&limit=5",
    "/api/search?lat=8.7&lon=27.4&size_km=40&purpose=material&limit=5",
    "/api/search?lat=14.1&lon=-56.0&size_km=40&purpose=lavatube&limit=5",
    "/api/mars-search?lat=18.4&lon=77.7&size_km=40&surface=any&rock=any&limit=5",
    "/api/mars-search?lat=18.4&lon=77.7&size_km=40&purpose=facets&limit=5",
    "/api/mars-search?site=jezero&size_km=40&purpose=maxmatch&limit=5",
    "/api/moon-minerals?lat=8.7&lon=27.4&size_km=40",
    "/api/moon-material-model?lat=8.7&lon=27.4&size_km=40",
    "/api/earth-environment?lat=36.1&lon=-112.1",
    "/api/explore-dem?body=moon&lat=8.7&lon=27.4&km=40",
    "/api/microterrain/sites",
    "/api/tokens/query?body=moon&lat=8.7&lon=27.4&size_km=40",
    "/api/maxmatch/check?body=moon&qlat=8.7&qlon=27.4&lat=35.0&lon=-111.0",
    "/api/biology?lat=35.0&lon=-111.0&body=mars",
    "/api/search?lat=8.7&lon=27.4&size_km=33",
    "/api/search?lat=95&lon=0",
    "/api/nope",
]


def fetch(base, path):
    req = urllib.request.Request(base + path, headers={"Accept-Encoding": "gzip"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            code, body, enc = r.status, r.read(), r.headers.get("Content-Encoding")
    except urllib.error.HTTPError as e:
        code, body, enc = e.code, e.read(), e.headers.get("Content-Encoding")
    if enc == "gzip":
        body = gzip.decompress(body)
    try:
        return code, json.loads(body)
    except ValueError:
        return code, {"<bytes>": len(body)}


def diff(a, b, path="$", out=None):
    out = [] if out is None else out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k in VOLATILE:
                continue
            if k not in a or k not in b:
                out.append(f"{path}.{k}: only in {'new' if k in b else 'old'}")
            else:
                diff(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: length {len(a)} != {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, f"{path}[{i}]", out)
    elif isinstance(a, float) and isinstance(b, float):
        if abs(a - b) > 1e-6 * max(1.0, abs(a)):
            out.append(f"{path}: {a} != {b}")
    elif a != b:
        out.append(f"{path}: {str(a)[:80]} != {str(b)[:80]}")
    return out


def main(old, new):
    failures = 0
    for path in REQUESTS:
        (ca, a), (cb, b) = fetch(old, path), fetch(new, path)
        problems = ([f"status {ca} != {cb}"] if ca != cb else []) + diff(a, b)
        print(("OK  " if not problems else "DIFF") + f" {ca} {path}")
        for p in problems[:8]:
            print("     ", p)
        failures += bool(problems)
    print(f"{len(REQUESTS) - failures}/{len(REQUESTS)} identical")
    return failures


if __name__ == "__main__":
    sys.exit(1 if main(*sys.argv[1:3]) else 0)
