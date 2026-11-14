"""E3 of the frozen protocol: coarse retrieval of Earth lava-tube fields from lunar/Martian pit queries.

Methods: random (simulated), production TinyTerrainEncoder cosine, C-Enc (four canonical suns). Primary scale 40 km,
secondary 20/80 km. Refuses to run without the frozen protocol."""
import hashlib
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))  # append: a stale lunar_pipeline.py sits in the repo root
sys.path.insert(0, str(ROOT / 'src'))
from scripts.lavatube_c2f import sites  # noqa: E402
from scripts.lavatube_c2f.build_coarse_index import load_encoder  # noqa: E402
from scripts.lavatube_c2f.coarse_model import embed_dem  # noqa: E402

DATA = ROOT / 'data/research/lavatube_c2f'
GALLERY = DATA / 'earth_gallery'
KS = (200, 1000)


def haversine(lat1, lon1, lat2, lon2):
    return sites.haversine_km(lat1, lon1, lat2, lon2, 6371.0)


def production_vectors():
    parts = []
    for name in ['etopo_15s_20_40km_index', 'etopo_80km_index', 'etopo_80km_supplement']:
        p = ROOT / f'data/earth_global/{name}.npz'
        if p.exists():
            parts.append(np.load(p)['vectors'].astype(np.float32))
    return np.concatenate(parts)


def query_squares(q, km):
    from lunar_pipeline import moon_patch
    from mars_global import patch_at
    if q['body'] == 'moon':
        return moon_patch(q['lat'], q['lon'], size=64, patch_km=km), moon_patch(q['lat'], q['lon'], patch_km=km)
    return patch_at(q['lat'], q['lon'], km, size=64), patch_at(q['lat'], q['lon'], km)


def relevance(rows_lat, rows_lon, km, protocol, teacher_centres):
    fields = {f['id']: f for f in protocol['earth_relevance']['fields']}
    pos_ids = protocol['earth_relevance']['evaluation_positives']
    radius = km / 2 + 20
    field_of = np.full(len(rows_lat), -1)
    for j, fid in enumerate(pos_ids):
        f = fields[fid]
        field_of[haversine(rows_lat, rows_lon, f['lat'], f['lon']) <= radius] = j
    ignored = np.zeros(len(rows_lat), bool)
    for fid in protocol['earth_relevance']['ignored_in_primary_metrics']:
        f = fields[fid]
        ignored |= haversine(rows_lat, rows_lon, f['lat'], f['lon']) <= radius
    for lat, lon in teacher_centres:
        ignored |= haversine(rows_lat, rows_lon, lat, lon) <= 30
    ignored &= field_of < 0
    return field_of, ignored, len(pos_ids)


def metrics(order, field_of, n_fields):
    f = field_of[order]
    rel = f >= 0
    out = {}
    for k in KS:
        out[f'field_recall@{k}'] = len(set(f[:k][rel[:k]].tolist())) / n_fields
    hits = np.flatnonzero(rel)
    out['first_relevant_rank'] = int(hits[0]) + 1 if len(hits) else None
    if len(hits):
        prec = np.arange(1, len(hits) + 1) / (hits + 1)
        out['ap'] = float(prec.mean())
    else:
        out['ap'] = 0.0
    return out


def bootstrap(values, draws=1000, seed=0):
    v = np.asarray(values, float)
    rng = np.random.default_rng(seed)
    means = [v[rng.integers(0, len(v), len(v))].mean() for _ in range(draws)]
    return {'mean': round(float(v.mean()), 4), 'ci95': [round(float(np.percentile(means, 2.5)), 4), round(float(np.percentile(means, 97.5)), 4)], 'n': len(v)}


def teacher_centres():
    from affine import Affine
    from rasterio.warp import transform as warp
    out = []
    for p in sorted((DATA / 'teacher').glob('earth_*.json')):
        if p.name.endswith('.inputs.json'):
            continue
        m = json.loads(p.read_text())
        t = Affine(*m['transform']); h, w = m['shape']
        x, y = t * (w / 2, h / 2)
        lon, lat = warp(m['crs'], 'EPSG:4326', [x], [y])
        out.append((lat[0], lon[0]))
    return out


def main():
    protocol_path = Path(os.environ.get('LT_PROTOCOL', DATA / 'protocol.json'))
    if not protocol_path.exists():
        raise SystemExit('freeze the protocol first (protocol.py)')
    protocol = json.loads(protocol_path.read_text())
    tag = os.environ.get('LT_TAG', '_v2')
    device = torch.device(os.environ.get('LT_DEVICE', 'cuda:1'))
    rows = json.loads((GALLERY / 'rows.json').read_text())
    lat = np.array([r['lat'] for r in rows]); lon = np.array([r['lon'] for r in rows]); km = np.array([r['km'] for r in rows])
    ok = np.load(GALLERY / 'ok.npy')
    cenc = np.load(GALLERY / f'coarse{tag}.npy').astype(np.float32)
    prod = production_vectors()
    assert len(prod) == len(rows) == len(cenc), (len(prod), len(rows), len(cenc))
    m, sha = load_encoder(tag, device)
    from lunar_pipeline import embed, load_model
    tiny = load_model()
    centres = teacher_centres()
    rng = np.random.default_rng(20261018)
    results = {'protocol_sha256': hashlib.sha256(protocol_path.read_bytes()).hexdigest(), 'coarse_model_sha256': sha, 'scales': {}}
    for scale in [int(x) for x in os.environ.get('LT_SCALES', '40,20,80').split(',')]:
        sel = np.flatnonzero((km == scale) & ok)
        field_of, ignored, n_fields = relevance(lat[sel], lon[sel], scale, protocol, centres)
        keep = ~ignored
        sel, field_of = sel[keep], field_of[keep]
        per = {'random': [], 'tiny_terrain_encoder': [], 'cenc': []}
        detail = []
        rand = [metrics(rng.permutation(len(sel)), field_of, n_fields) for _ in range(200)]
        for q in protocol['queries']['list']:
            sq64, sq32 = query_squares(q, scale)
            z = torch.from_numpy((sq64 - np.median(sq64)).astype(np.float32))[None, None].to(device)
            e = embed_dem(m, z, torch.tensor([scale * 1000 / 63], device=device)).cpu().numpy()[0]
            mc = metrics(np.argsort(-(cenc[sel] @ e), kind='stable'), field_of, n_fields)
            mt = metrics(np.argsort(-(prod[sel] @ embed(tiny, sq32)), kind='stable'), field_of, n_fields)
            per['cenc'].append(mc); per['tiny_terrain_encoder'].append(mt)
            detail.append({'query': q['id'], 'body': q['body'], 'cenc': mc, 'tiny_terrain_encoder': mt})
        summary = {'gallery_windows': int(len(sel)), 'relevant_windows': int((field_of >= 0).sum()),
                   'fields_with_relevant_windows': int(len(set(field_of[field_of >= 0].tolist()))), 'by_body': {}}
        summary['random'] = {k: round(float(np.mean([r[k] for r in rand])), 4) for k in [f'field_recall@{k}' for k in KS] + ['ap']}
        for body in ('moon', 'mars', 'all'):
            idx = [i for i, d in enumerate(detail) if body == 'all' or d['body'] == body]
            if not idx:
                continue
            b = {}
            for method in ('cenc', 'tiny_terrain_encoder'):
                b[method] = {k: bootstrap([per[method][i][k] for i in idx]) for k in [f'field_recall@{k}' for k in KS] + ['ap']}
            b['cenc_minus_tiny'] = {k: bootstrap([per['cenc'][i][k] - per['tiny_terrain_encoder'][i][k] for i in idx]) for k in [f'field_recall@{k}' for k in KS] + ['ap']}
            summary['by_body'][body] = b
        results['scales'][str(scale)] = {'summary': summary, 'queries': detail}
        print(json.dumps({'scale': scale, 'summary': summary}, ensure_ascii=False)[:2500], flush=True)
    (DATA / f"results_E3{tag}{os.environ.get('LT_SUFFIX', '')}.json").write_text(json.dumps(results, indent=1, ensure_ascii=False))


if __name__ == '__main__':
    main()
