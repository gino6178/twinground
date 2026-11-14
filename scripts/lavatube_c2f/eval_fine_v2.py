"""PitChain-C2F v2 blind evaluation (protocol_v2.json must exist; written by --freeze before any test result).

E1v2  pixel average precision against the DEM teacher on every test site (Moon blind DTMs, Earth held-out sites,
      Mars zero-shot), F-Net v2 vs a multi-scale Laplacian-of-Gaussian darkness baseline on the same image.
E2v2  recall of expert-catalogued pits (LROC pit atlas, MGC3) inside test footprints at fixed detection budgets of
      1, 3 and 10 detections per km2 (thresholds set per method and site by the budget, so both methods are compared
      at equal false-alarm cost), plus F-Net at its dev-selected operating threshold."""
import csv
import hashlib
import io
import json
import math
import os
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from affine import Affine
from rasterio.warp import transform as warp
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))
from scripts.lavatube_c2f import sites as site_lists  # noqa: E402
from scripts.lavatube_c2f.fine_model import rotate_batch  # noqa: E402
from scripts.lavatube_c2f.fine_model_v2 import FNet2, render_top, stretch  # noqa: E402
from scripts.lavatube_c2f.train_fine import average_precision  # noqa: E402

DATA = ROOT / 'data/research/lavatube_c2f'
V2 = DATA / 'fine_v2'
PROTOCOL = DATA / 'protocol_v2.json'
BUDGETS = (1, 3, 10)
TILE, OVERLAP = 768, 64
DEV = torch.device(os.environ.get('LT_DEVICE', 'cuda:1'))


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def load_model():
    ckpt = torch.load(DATA / 'fnet_v2.pt', map_location=DEV)
    m = FNet2().to(DEV).eval()
    m.load_state_dict(ckpt['model'])
    return m, ckpt.get('threshold')


@torch.no_grad()
def predict(m, img, valid, sun_az):
    """Tiled, sun-on-top inference; returns pit probability in the original orientation."""
    h, w = img.shape
    out = np.zeros((h, w), np.float32)
    step = TILE - 2 * OVERLAP
    a = torch.tensor([math.radians(sun_az)], device=DEV)
    for y0 in range(0, h, step):
        for x0 in range(0, w, step):
            ya, xa, yb, xb = max(0, y0 - OVERLAP), max(0, x0 - OVERLAP), min(h, y0 + step + OVERLAP), min(w, x0 + step + OVERLAP)
            t = torch.from_numpy(np.stack([img[ya:yb, xa:xb], valid[ya:yb, xa:xb]]).astype(np.float32))[None].to(DEV)
            th, tw = t.shape[-2:]
            side = int(math.ceil(math.hypot(th, tw))) + 2
            side += (-side) % 8
            py, px = (side - th) // 2, (side - tw) // 2
            t = F.pad(t, (px, side - tw - px, py, side - th - py))
            r = rotate_batch(t, a)
            x = stretch(r[:, 0:1], (r[:, 1:2] > 0.5).float())
            logit, _ = m(x)
            p = rotate_batch(torch.sigmoid(logit)[:, None], -a)[0, 0, py:py + th, px:px + tw].cpu().numpy()
            cy0, cx0 = y0 - ya, x0 - xa
            hh, ww = min(step, h - y0), min(step, w - x0)
            out[y0:y0 + hh, x0:x0 + ww] = p[cy0:cy0 + hh, cx0:cx0 + ww]
    return np.where(valid > 0, out, 0)


def log_darkness(img, valid, res):
    g = np.where(valid > 0, img, np.nanmean(img[valid > 0]) if (valid > 0).any() else 0).astype(np.float32)
    # pit-sized scales: 4, 8 and 16 m radius in pixels
    return np.where(valid > 0, np.max([ndimage.gaussian_laplace(g, s / res) * (s / res) ** 2 for s in (4.0, 8.0, 16.0)], axis=0), -np.inf)


def peaks(score, valid):
    finite = np.where(np.isfinite(score), score, -1e9)
    pk = (finite == ndimage.maximum_filter(finite, size=7)) & (valid > 0) & (finite > -1e8)
    ys, xs = np.nonzero(pk)
    return ys, xs, finite[ys, xs]


def catalog(meta):
    radius = {'moon': 1737400, 'mars': 3396190}.get(meta['body'])
    if radius is None:
        return []
    root = ROOT / site_lists.CATALOG_DIR
    if meta['body'] == 'moon':
        rows = list(csv.DictReader(open(root / 'LUNAR_PIT_LOCATIONS.CSV', encoding='utf-8', errors='replace')))
        cand = []
        for r in rows:
            d = []
            for k in ('Inner Max Diam', 'Funnel Max Diam'):
                try:
                    d.append(float(r[k]))
                except ValueError:
                    pass
            cand.append((float(r['Latitude']), float(r['Longitude_180']), r['Name'], d[0] if d else 0.0))
    else:
        z = zipfile.ZipFile(root / 'mars_cave_catalog.zip')
        rows = list(csv.DictReader(io.TextIOWrapper(z.open('miscellaneous/Mars_Cave_Catalog_shapefile.csv'), encoding='utf-8', errors='replace')))
        cand = []
        for r in rows:
            if r['TypeCode:string'].strip() in ('sky', 'APC', 'pit'):
                try:
                    d = float(r['APC_Diameter:string'])
                except ValueError:
                    d = 0.0
                cand.append((float(r['latitude']), (float(r['longitude']) + 180) % 360 - 180, r['Label:string'], d))
    t = Affine(*meta['transform']); h, w = meta['shape']
    out = []
    for lat, lon, name, d in cand:
        try:
            x, y = warp(f'+proj=longlat +R={radius} +no_defs', meta['crs'], [lon], [lat])
        except Exception:  # noqa: BLE001
            continue
        col, row = ~t * (x[0], y[0])
        if 0 <= col < w and 0 <= row < h:
            out.append({'name': name, 'row': row, 'col': col, 'diameter_m': d})
    return out


def freeze():
    if PROTOCOL.exists():
        raise SystemExit(f'protocol_v2 already frozen sha256={sha(PROTOCOL)}')
    test = []
    for d in sorted(V2.iterdir()):
        if (d / 'meta.json').exists():
            m = json.loads((d / 'meta.json').read_text())
            if m['split'] in ('test', 'test_zeroshot'):
                test.append({'key': m['key'], 'split': m['split'], 'image': m['image'], 'sun_fit': m['sun_fit'],
                             'catalog_points': len(catalog(m))})
    protocol = {
        'name': 'PitChain-C2F fine stage v2 blind protocol', 'frozen_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'follows': {'v1_protocol_sha256': sha(DATA / 'protocol.json'), 'v1_results': ['results_E3_v2.json', 'results_E1_E2.json']},
        'why_v2': 'v1 fine stage on a 10 m grid could not resolve 10-100 m pits; v2 works at the native 1-5 m grid on images',
        'model': {'file': 'fnet_v2.pt', 'sha256': sha(DATA / 'fnet_v2.pt') if (DATA / 'fnet_v2.pt').exists() else None,
                  'selection': 'dev pixel AP (APOLLO15, Jordan Craters tile, Big Pine crop)', 'seed': 20261019},
        'test_sites': test,
        'sun_rule': 'photometric fit on native 512 px windows; HiRISE sites without a clean window use the median of the other HiRISE fits',
        'render_sites_rule': 'Earth lidar test tiles rendered once with sun on top, elevation 35 deg, seed 0',
        'E1v2': 'pixel average precision vs teacher pit mask dilated by 1 pixel, per site and pooled per body; F-Net v2 vs multi-scale LoG darkness',
        'E2v2': {'truth': 'LROC pit atlas / MGC3 sky+APC+pit points inside test footprints',
                 'hit': 'a detection peak within max(20 m, catalog diameter) of the point',
                 'budgets_per_km2': BUDGETS, 'operating_point': 'F-Net threshold chosen on dev (F1-optimal pixels)'},
        'code_sha256': {p.name: sha(p) for p in sorted((ROOT / 'scripts/lavatube_c2f').glob('*.py'))},
        'claims_policy': 'reported whether favourable or not; Mars is zero-shot (no Mars data in training)',
    }
    PROTOCOL.write_text(json.dumps(protocol, indent=1))
    print(json.dumps({'protocol_v2_sha256': sha(PROTOCOL), 'test_sites': len(test), 'catalog_points': sum(t['catalog_points'] for t in test)}))


def main():
    if not PROTOCOL.exists():
        raise SystemExit('freeze first: python -m scripts.lavatube_c2f.eval_fine_v2 --freeze')
    m, thr = load_model()
    out = {'protocol_v2_sha256': sha(PROTOCOL), 'model_sha256': sha(DATA / 'fnet_v2.pt'), 'operating_threshold': thr, 'sites': [], 'pooled': {}}
    pooled = {}
    for d in sorted(V2.iterdir()):
        mp = d / 'meta.json'
        if not mp.exists():
            continue
        meta = json.loads(mp.read_text())
        if meta['split'] not in ('test', 'test_zeroshot'):
            continue
        valid = np.load(d / 'valid.npy')
        pit = np.load(d / 'pit.npy')
        if (d / 'img.npy').exists():
            img = np.load(d / 'img.npy').astype(np.float32)
            valid = valid & np.load(d / 'img_valid.npy')
            sun = meta['sun_fit'][0]
        else:
            torch.manual_seed(0)
            dem = np.load(d / 'dem.npy')
            z = torch.from_numpy(dem - np.median(dem))[None, None].to(DEV)
            img = render_top(z, torch.tensor([meta['res_m']], device=DEV), torch.tensor([35.0], device=DEV))[0, 0].cpu().numpy()
            sun = 0.0
        t0 = time.time()
        p = predict(m, img, valid, sun)
        lg = log_darkness(img, valid, meta['res_m'])
        label = ndimage.binary_dilation(pit > 0, iterations=1)
        v = valid > 0
        site = {'key': meta['key'], 'split': meta['split'], 'image': meta['image'], 'res_m': meta['res_m'], 'positives': int(label[v].sum()),
                'area_km2': round(float(v.sum()) * meta['res_m'] ** 2 / 1e6, 3)}
        if site['positives']:
            site['ap'] = {'fnet_v2': round(average_precision(p[v], label[v].astype(float)), 4),
                          'log_darkness': round(average_precision(lg[v], label[v].astype(float)), 4), 'base_rate': round(float(label[v].mean()), 6)}
            key = meta['body'] + ('_zeroshot' if meta['split'] == 'test_zeroshot' else '')
            pooled.setdefault(key, {'fnet_v2': [], 'log_darkness': [], 'label': []})
            sub = np.flatnonzero(v.ravel())
            if len(sub) > 20_000_000:
                sub = np.random.default_rng(0).choice(sub, 20_000_000, replace=False)
            pooled[key]['fnet_v2'].append(p.ravel()[sub]); pooled[key]['log_darkness'].append(lg.ravel()[sub]); pooled[key]['label'].append(label.ravel()[sub])
        cat = catalog(meta)
        site['catalog'] = []
        if cat:
            res = meta['res_m']
            dets = {'fnet_v2': peaks(p, valid), 'log_darkness': peaks(lg, valid)}
            for c in cat:
                c['radius_px'] = max(20.0, c['diameter_m']) / res
            for method, (ys, xs, sc) in dets.items():
                order = np.argsort(-sc)
                for b in BUDGETS:
                    n = max(1, int(round(b * site['area_km2'])))
                    keep = order[:n]
                    for c in cat:
                        c[f'{method}@{b}'] = bool(np.any(np.hypot(ys[keep] - c['row'], xs[keep] - c['col']) <= c['radius_px']))
                if method == 'fnet_v2' and thr is not None:
                    keep = sc >= thr
                    site['fnet_v2_operating_detections_per_km2'] = round(float(keep.sum()) / max(site['area_km2'], 1e-6), 3)
                    for c in cat:
                        c['fnet_v2@operating'] = bool(np.any(np.hypot(ys[keep] - c['row'], xs[keep] - c['col']) <= c['radius_px']))
            site['catalog'] = [{k: (round(v, 1) if isinstance(v, float) else v) for k, v in c.items()} for c in cat]
        site['seconds'] = round(time.time() - t0, 1)
        out['sites'].append(site)
        print(json.dumps({k: site[k] for k in site if k != 'catalog'} | {'catalog_n': len(cat)}), flush=True)
    for key, d in pooled.items():
        lab = np.concatenate(d['label']).astype(float)
        out['pooled'][key] = {mth: round(average_precision(np.concatenate(d[mth]), lab), 4) for mth in ('fnet_v2', 'log_darkness')}
        out['pooled'][key]['base_rate'] = round(float(lab.mean()), 6)
    e2 = {}
    for s in out['sites']:
        body = s['key'].split('_')[0]
        for c in s['catalog']:
            for k, v in c.items():
                if '@' in k:
                    e2.setdefault(body, {}).setdefault(k, []).append(v)
    out['E2v2'] = {b: {k: f'{sum(v)}/{len(v)}' for k, v in sorted(d.items())} for b, d in e2.items()}
    (DATA / 'results_v2_fine.json').write_text(json.dumps(out, indent=1))
    print(json.dumps({'pooled_AP': out['pooled'], 'E2v2': out['E2v2']}), flush=True)


if __name__ == '__main__':
    freeze() if '--freeze' in sys.argv else main()
