# TwinGround

**Finding Earth’s twins of the Moon and Mars.**

NASA Space Apps Challenge 2026 — *Identify Earth Locations that Analog the Permanent Moon Base Locations and Mars*.

Pick a window on the Moon or Mars, read its conditions from NASA orbital data, and rank Earth windows
(about 484,000 across 20/40/80 km scales) as analog candidates. Each candidate shows which conditions hold
and which do not, side-by-side 3D terrain, and an astronaut explorer for walking the site.

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
ln -s /path/to/twinground-data data
```

```bash
pip install -r requirements.txt
cd web && npm ci && npm run build && cd ..
ATLAS_PORT=8765 python web_server.py
```

Environment variables: `ATLAS_PORT` (default 8765), `ATLAS_HOST` (default 0.0.0.0), `ATLAS_TORCH_THREADS` (default 4).

## Design notes

**Server**
- `server/` holds config, query validation, resource loading, routes and the search pipeline. Search runs in
  five steps, with one ranking function per purpose.
- The model SHA-256 is computed once per process; every Earth index is checked against it at startup.
- Missing or invalid query parameters return 400.
- Lunar Prospector bins are looked up through a grid index (about 2 ms for 3,000 points).
- `POST /api/chat-search` (language model to search spec) and the image-search POST share one handler.

**Front end**
- Results-only code (condition art, process scenes) is lazy-loaded with the results page.
- React, Motion and three.js are separate vendor chunks so they stay cached across deploys.
- First-load JavaScript is about 184 KB gzipped.

**Testing**
`tools/compare_servers.py` sends 32 requests (every search purpose on the Moon and Mars, the observation
endpoints, chat search through the language model, and the error cases) to two running servers and reports
any JSON difference. Use it to check a deployment against a known-good server.

## Deployment (GCP VM)

The site runs on a GCP `g2-standard-8` VM with an NVIDIA L4 as systemd user services (`deploy/systemd/`):
the web server, the fine-tuned Llama 3.2 1B that turns a chat message into a search spec (`/api/chat-search`),
and a Cloudflare quick tunnel. The quick-tunnel address changes whenever the tunnel restarts.

```bash
cp deploy/systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now twinground-web twinground-tunnel
journalctl --user -u twinground-tunnel | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1
```

Chat search also needs `transformers` and the LoRA-merged model weights in `~/llm/serve` (not in this repository).
