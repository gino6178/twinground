# Architecture notes

Maintainer notes for the TwinGround code. For what the project does and the method behind it, see the [README](../README.md) and the [Methods paper](https://twinground.theminimallab.com/technology/paper-en.html).

## Layout

| Path | What it is |
|---|---|
| `web_server.py` | Entry point |
| `server/` | HTTP server: config, query validation, resource loading, routes, search pipeline |
| `src/` | Data access and models (DEM sampling, lunar and Martian observations, terrain encoder) |
| `scripts/` | Ranking and evidence modules (ten-facet rules, conditions, physical match, lava tubes, material, ...), chat search (`scripts/chat_search/`) and the site assistant (`scripts/assistant/`) |
| `web/` | React + Three.js front end (Vite); static pages, including the Methods paper, live in `web/public/` |
| `tools/compare_servers.py` | JSON parity check between two running servers |
| `deploy/systemd/` | systemd user units for the live VM (see [deployment](deployment.md)) |

## Server

- `server/` holds config, query validation (`params.py`), resource loading (`resources.py`), routes and the search pipeline (`search.py`). Search runs in five steps, with one ranking function per purpose:
  1. read the query window (DEM, display mesh, observations);
  2. score every Earth window of the same size by terrain-embedding cosine similarity;
  3. re-score for the chosen purpose (ten facets, conditions, physical match, lava tubes, or terrain + material);
  4. combine scores with fixed weights and group neighbouring windows into candidates;
  5. build an evidence record for each candidate.
- The model SHA-256 is computed once per process; every Earth index is checked against it at startup, so a stale index fails loudly instead of returning wrong rankings.
- Missing or invalid query parameters return 400.
- Lunar Prospector bins are looked up through a grid index (about 2 ms for 3,000 points).
- `POST /api/chat-search` (language model to search spec) and the image-search POST share one handler.
- `POST /api/assistant` turns the search result the page already holds into a text brief (`scripts/assistant/site_brief.py`) and forwards it to the assistant service. See [assistant](assistant.md).
- The server serves the built front end from `web/dist`.

## Front end

- Results-only code (condition art, process scenes) is lazy-loaded with the results page.
- React, Motion and three.js are separate vendor chunks (`web/vite.config.js`), so they stay cached across deploys.
- The Vite dev server (`npm run dev`, port 5173) proxies `/api` to `http://localhost:8765`.
- The published site is English-only.

## Testing a deployment

`tools/compare_servers.py` sends 32 requests (every search purpose on the Moon and Mars, the observation endpoints, chat search through the language model, and the error cases) to two running servers and reports any JSON difference, ignoring timing fields. Use it to check a deployment against a known-good server:

```bash
python tools/compare_servers.py http://localhost:8765 http://localhost:8766
```
