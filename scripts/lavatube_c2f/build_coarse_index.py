"""Embed every Earth gallery window with a C-Enc checkpoint (illumination-marginalised, four canonical suns)."""
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))  # append: a stale lunar_pipeline.py sits in the repo root
from scripts.lavatube_c2f.coarse_model import CoarseEncoder, embed_dem  # noqa: E402

DATA = ROOT / 'data/research/lavatube_c2f'
GALLERY = DATA / 'earth_gallery'


def load_encoder(tag, device):
    path = DATA / f'coarse_encoder{tag}.pt'
    ckpt = torch.load(path, map_location=device)
    m = CoarseEncoder().to(device).eval()
    m.load_state_dict(ckpt['model'])
    return m, hashlib.sha256(path.read_bytes()).hexdigest()


@torch.no_grad()
def embed_squares(m, dem, km, device, chunk=4096):
    out = np.zeros((len(dem), 128), np.float16)
    for i in range(0, len(dem), chunk):
        z = torch.from_numpy(np.asarray(dem[i:i + chunk], np.float32))[:, None].to(device)
        sp = torch.from_numpy(np.asarray(km[i:i + chunk], np.float32) * 1000 / 63).to(device)
        out[i:i + chunk] = embed_dem(m, z, sp).cpu().numpy().astype(np.float16)
    return out


def main():
    tag = os.environ.get('LT_TAG', '_v2')
    device = torch.device(os.environ.get('LT_DEVICE', 'cuda:1'))
    m, sha = load_encoder(tag, device)
    rows = json.loads((GALLERY / 'rows.json').read_text())
    dem = np.load(GALLERY / 'dem.npy', mmap_mode='r')
    km = np.array([r['km'] for r in rows], np.float32)
    t0 = time.time()
    vec = embed_squares(m, dem, km, device)
    np.save(GALLERY / f'coarse{tag}.npy', vec)
    (GALLERY / f'coarse{tag}.json').write_text(json.dumps({'model_sha256': sha, 'rows': len(rows), 'seconds': round(time.time() - t0, 1)}))
    print(json.dumps({'rows': len(rows), 'seconds': round(time.time() - t0, 1)}))


if __name__ == '__main__':
    main()
