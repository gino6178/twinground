# Analog Atlas

NASA Space Apps Challenge 2026 — *Identify Earth Locations that Analog the Permanent Moon Base Locations and Mars*.

Pick a window on the Moon or Mars, read its conditions from NASA orbital data, and rank Earth windows
(about 484,000 across 20/40/80 km scales) as analog candidates. Each candidate shows which conditions hold
and which do not, side-by-side 3D terrain, and an astronaut explorer for walking the site.

This repository is a rebuild of our team's pre-event prototype: the runtime code was carried over, restructured
and optimized (see *Changes from the prototype*). The datasets and trained weights are reused as-is.

## Layout

| Path | What it is |
|---|---|
| `web_server.py` | Entry point |
| `server/` | HTTP server: config, query validation, resource loading, routes, search pipeline |
| `src/` | Data access and models (DEM sampling, lunar/Mars observations, terrain encoder) |
| `scripts/` | Ranking and evidence modules (ten-facet rules v6, conditions, physical match, lava tubes, material, …) |
| `web/` | React + Three.js front end (Vite) |
| `tools/compare_servers.py` | JSON parity check between two running servers |

## Run

The data directory (~71 GB) is not in the repository. Link it as `./data`:

```bash
ln -s /path/to/analog-atlas-data data
```

```bash
pip install -r requirements.txt
cd web && npm ci && npm run build && cd ..
ATLAS_PORT=8765 python web_server.py
```

Environment variables: `ATLAS_PORT` (default 8765), `ATLAS_HOST` (default 0.0.0.0), `ATLAS_TORCH_THREADS` (default 4).

## Changes from the prototype

**Server**
- The 936-line `web_server.py` is split into the `server/` package. Search is a five-step pipeline, with one
  ranking function per purpose instead of one long branch.
- Six copy-pasted orthophoto handlers are now a single table-driven route.
- The model SHA-256 is computed once per process instead of on every search.
- Missing required query parameters return 400 instead of 500.
- Lunar Prospector bin lookup uses a grid index instead of a linear scan: 8 s → 2 ms for 3,000 points,
  verified identical on random points. First searches at a new location are 2–3× faster
  (e.g. 1.2 s → 0.36 s).
- Removed hard-coded absolute paths and `sys.path` hacks; the server reads the data directory through a symlink.

**Front end**
- The selection-page reading card and the procedural rock mesh have their own modules, so the results-only
  condition art loads with the results page instead of on the cover.
- React and Motion are separate vendor chunks that stay cached across app deploys.
- First-load JavaScript: 209.5 KB → 183.7 KB gzipped.

**Verification**
`tools/compare_servers.py` sends 29 requests (every search purpose on the Moon and Mars, the observation
endpoints and the error cases) to the prototype and to this rebuild. All responses are identical.
