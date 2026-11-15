# Deployment

How the live site (https://twinground.theminimallab.com) is served. Back to the [README](../README.md).

## Overview

The site runs on one GCP `g2-standard-8` VM with an NVIDIA L4 GPU (`analog-atlas-l4`, zone `asia-northeast3-a`), as systemd **user** services. The repository is checked out at `~/nasa_2026/comp1`, and the web server serves the built front end from `~/nasa_2026/comp1/web/dist`.

| Service (`deploy/systemd/`) | Port | What it does |
|---|---|---|
| `twinground-web` | 8766 | `web_server.py`: API, search and the built front end |
| `twinground-llm` | 8790 | Fine-tuned Llama 3.2 1B that turns a chat message into a search spec (`/api/chat-search`) |
| `twinground-assistant` | 8791 | Site assistant: retrieval + fine-tuned Llama 3.2 1B (see [assistant](assistant.md)) |
| `twinground-tunnel-domain` | – | Named Cloudflare tunnel that maps `twinground.theminimallab.com` to port 8766 |

The prepared data directory (about 71 GB) and the model weights are not in the repository. The server expects the data at `data/` in the checkout (a symlink is fine); on the VM the chat-search model is in `~/llm/serve`, the assistant model in `~/llm/assistant`, and the e5 retriever in `~/llm/e5`.

`deploy/systemd/twinground-tunnel.service` is the old Cloudflare quick tunnel (random `trycloudflare.com` address). It is no longer used; keep it disabled.

## Install or update the services

```bash
cp deploy/systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now twinground-web twinground-llm twinground-assistant twinground-tunnel-domain
systemctl --user status 'twinground-*'
```

The named tunnel reads its token from `~/.cloudflared/twinground.env` (`TUNNEL_TOKEN=...`, from the Cloudflare dashboard). Never commit that file. The public hostname and its target (`http://127.0.0.1:8766`) are configured on the tunnel in the Cloudflare dashboard.

## Deploy a front-end change

Build locally, copy the build to the VM, and swap it into place:

```bash
npm --prefix web run build
tar -czf dist.tgz -C web dist
gcloud compute scp dist.tgz analog-atlas-l4:/tmp/ --zone asia-northeast3-a
```

On the VM:

```bash
cd ~/nasa_2026/comp1/web
rm -rf dist.new && mkdir dist.new && tar -xzf /tmp/dist.tgz -C dist.new --strip-components=1
rm -rf dist.bak && mv dist dist.bak && mv dist.new dist
curl -s localhost:8766/ | grep -o 'main-[^"]*\.js'   # must match the hash of the local build
```

Deploy only to `~/nasa_2026/comp1/web/dist`; other checkouts on the VM are not served. Static files are read from disk, so a front-end change needs no restart.

## Deploy a server change

Update the Python files in `~/nasa_2026/comp1`, then restart and check against a known-good server (see [architecture](architecture.md#testing-a-deployment)):

```bash
systemctl --user restart twinground-web
journalctl --user -u twinground-web -n 50
```

## Environment variables

| Variable | Default | Used by |
|---|---|---|
| `ATLAS_PORT` | `8765` (the unit sets `8766`) | web server port |
| `ATLAS_HOST` | `0.0.0.0` | web server bind address |
| `ATLAS_TORCH_THREADS` | `4` | PyTorch CPU threads in the web server |
| `ANALOG_LLM_URL` | `http://127.0.0.1:8790/spec` | chat-search spec writer |
| `ANALOG_ASSISTANT_URL` | `http://127.0.0.1:8791/ask` | site assistant service |
| `ANALOG_CHAT_MAXMATCH` | `1` | chat search: use the measured-match ranking when the spec names a target (`0` turns it off) |
