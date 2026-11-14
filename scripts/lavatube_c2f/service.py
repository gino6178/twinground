"""PitChain-C2F v2 serving for the TwinGround web server (CPU only; the GPU stays free).

Coarse (E3v2 'gated_cenc_v2'): Earth windows within GATE_KM of a basaltic Holocene volcano (Smithsonian GVP) come first,
ordered by C-Enc v2 terrain cosine; the rest follow by cosine.
Fine, query side: if the Moon/Mars query lies on a high-resolution orthoimage we hold (LROC NAC / HiRISE), F-Net v2
detects pits and skylights in a 3 km square around it.
Fine, Earth side: if a candidate window overlaps a USGS 3DEP lidar site we hold, the analytic DEM detector (the F-Net
teacher) lists collapse pits there. Results are cached in memory; overlays are PNG."""
import io
import json
import math
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'data/research/lavatube_c2f'
TAG = '_v2'
GATE_KM = 60.0
CROP_KM = 3.0
VERSION = 'pitchain-c2f-v2'
_LOCK = threading.Lock()
_JOBS, _OVERLAYS = {}, {}
_POOL = ThreadPoolExecutor(max_workers=2)


# ------------------------------------------------------------------------------------------------- coarse
@lru_cache(maxsize=1)
def encoder():
    from scripts.lavatube_c2f.build_coarse_index import load_encoder
    return load_encoder(TAG, torch.device('cpu'))


@lru_cache(maxsize=1)
def gallery():
    rows = json.loads((DATA / 'earth_gallery/rows.json').read_text())
    return ({r['id']: i for i, r in enumerate(rows)}, np.load(DATA / f'earth_gallery/coarse{TAG}.npy'),
            np.load(DATA / 'earth_gallery/gvp_basaltic_distance_km.npy'))


@lru_cache(maxsize=1)
def volcanoes():
    from scripts.lavatube_c2f.coarse_v2 import BASALTIC, GVP
    f = json.loads(GVP.read_text())['features']
    keep = [x for x in f if x['properties'].get('Major_Rock_Type') in BASALTIC]
    return (np.array([[x['geometry']['coordinates'][1], x['geometry']['coordinates'][0]] for x in keep]),
            [{'name': x['properties'].get('Volcano_Name'), 'number': x['properties'].get('Volcano_Number'),
              'rock': x['properties'].get('Major_Rock_Type'), 'type': x['properties'].get('Primary_Volcano_Type')} for x in keep])


def nearest_volcano(lat, lon):
    xy, info = volcanoes()
    p1, p2 = math.radians(lat), np.radians(xy[:, 0])
    dl = np.radians(xy[:, 1] - lon)
    d = 2 * 6371.0 * np.arcsin(np.sqrt(np.clip(np.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2, 0, 1)))
    k = int(np.argmin(d))
    return dict(info[k], distance_km=round(float(d[k]), 1),
                url=f"https://volcano.si.edu/volcano.cfm?vn={info[k]['number']}" if info[k]['number'] else None)


def query_square(body, lat, lon, km):
    if body == 'moon':
        from lunar_pipeline import moon_patch
        return moon_patch(lat, lon, size=64, patch_km=km)
    from mars_global import patch_at
    return patch_at(lat, lon, km, size=64)


@torch.no_grad()
def query_vector(body, lat, lon, km):
    from scripts.lavatube_c2f.coarse_model import embed_dem
    m, _ = encoder()
    sq = query_square(body, lat, lon, km)
    z = torch.from_numpy((sq - np.median(sq)).astype(np.float32))[None, None]
    return embed_dem(m, z, torch.tensor([km * 1000 / 63]))[0].numpy()


def coarse_scores(body, lat, lon, km, rows, row_indices):
    """Ranking score aligned with row_indices, in [-1, 1] because the context ranker clips (s+1)/2 to [0, 1]:
    gated windows map to [0, 1] and the rest to [-1, 0], each keeping its cosine order."""
    pos, vec, dist = gallery()
    q = query_vector(body, lat, lon, km)
    idx = np.array([pos.get(rows[int(i)]['id'], -1) for i in row_indices])
    ok = idx >= 0
    cos = np.full(len(row_indices), -1.0, np.float32)
    cos[ok] = vec[idx[ok]].astype(np.float32) @ q
    gate = np.zeros(len(row_indices), bool)
    gate[ok] = dist[idx[ok]] <= GATE_KM
    _, sha = encoder()
    return np.where(gate, 0.5 * cos + 0.5, 0.5 * cos - 0.5).astype(np.float32), cos, {'model': 'C-Enc v2 terrain cosine, gated by basaltic Holocene volcanoes (GVP)', 'model_sha256': sha,
                                   'gate_km': GATE_KM, 'gated_windows': int(gate.sum()), 'gallery_coverage': round(float(ok.mean()), 4)}


# ------------------------------------------------------------------------------------------------- fine
@lru_cache(maxsize=1)
def fnet():
    from scripts.lavatube_c2f.fine_model_v2 import FNet2
    ckpt = torch.load(DATA / 'fnet_v2.pt', map_location='cpu')
    m = FNet2().eval()
    m.load_state_dict(ckpt['model'])
    return m, float(ckpt.get('threshold', 0.5))


@lru_cache(maxsize=1)
def fine_sites():
    out = []
    for d in sorted((DATA / 'fine_v2').iterdir()):
        mp = d / 'meta.json'
        if mp.exists():
            meta = json.loads(mp.read_text())
            out.append((d, meta))
    return out


def _locate(meta, lat, lon, radius):
    from affine import Affine
    from rasterio.warp import transform as warp
    t = Affine(*meta['transform']); h, w = meta['shape']
    src = 'EPSG:4326' if radius is None else f'+proj=longlat +R={radius} +no_defs'
    try:
        x, y = warp(src, meta['crs'], [lon], [lat])
    except Exception:  # noqa: BLE001
        return None
    col, row = ~t * (x[0], y[0])
    return (row, col) if 0 <= col < w and 0 <= row < h else None


def _crop(d, meta, row, col, key, kind):
    half = int(CROP_KM * 500 / meta['res_m'])
    h, w = meta['shape']
    r0, r1, c0, c1 = max(0, int(row) - half), min(h, int(row) + half), max(0, int(col) - half), min(w, int(col) + half)
    return slice(r0, r1), slice(c0, c1)


def _png(img, valid, pits, color=(255, 214, 10)):
    from PIL import Image, ImageDraw
    g = np.where(valid, img, np.nan)
    lo, hi = np.nanpercentile(g, [1, 99]) if np.isfinite(g).any() else (0, 1)
    base = (np.nan_to_num(np.clip((g - lo) / max(hi - lo, 1e-6), 0, 1)) * 255).astype(np.uint8)
    im = Image.fromarray(base).convert('RGB')
    scale = 480 / max(im.size)
    im = im.resize((max(1, int(im.size[0] * scale)), max(1, int(im.size[1] * scale))), Image.BILINEAR)
    dr = ImageDraw.Draw(im)
    for i, p in enumerate(pits[:25]):
        r = max(4.0, p['diameter_px'] * scale / 2 + 3)
        color_i = (255, 60, 60) if i == 0 and color == (255, 214, 10) else color
        dr.ellipse([p['col'] * scale - r, p['row'] * scale - r, p['col'] * scale + r, p['row'] * scale + r], outline=color_i, width=3 if i == 0 else 2)
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def _to_lonlat(meta, rows, cols, radius):
    from affine import Affine
    from rasterio.warp import transform as warp
    if not len(rows):
        return [], []
    t = Affine(*meta['transform'])
    xs, ys = zip(*[t * (c + 0.5, r + 0.5) for r, c in zip(rows, cols)])
    lons, lats = warp(meta['crs'], 'EPSG:4326' if radius is None else f'+proj=longlat +R={radius} +no_defs', list(xs), list(ys))
    return lats, lons


def nms_detections(prob, thr, res, radius_m=60.0, max_px=48, valid=None, margin=12):
    """One detection per pit: greedy non-maximum suppression over local maxima, diameter from the connected region
    (prob >= 0.5) around each peak inside a small window (display only; evaluation used plain peaks)."""
    from scipy import ndimage
    pk = (prob == ndimage.maximum_filter(prob, size=5)) & (prob >= thr)
    inner = np.ones_like(pk) if valid is None else valid.astype(bool)
    inner = ndimage.binary_fill_holes(inner)  # holes such as DTM gaps inside deep pits must not suppress the pit
    inner = ndimage.binary_erosion(np.pad(inner, 1), iterations=margin)[1:-1, 1:-1]  # only the outer edge is excluded
    pk &= inner
    ys, xs = np.nonzero(pk)
    order = np.argsort(-prob[ys, xs])[:2000]
    h, w = prob.shape

    def diameter(y, x):
        y0, y1, x0, x1 = max(0, y - max_px), min(h, y + max_px + 1), max(0, x - max_px), min(w, x + max_px + 1)
        lab, _ = ndimage.label(prob[y0:y1, x0:x1] >= 0.5)
        k = lab[y - y0, x - x0]
        area = float((lab == k).sum()) if k else 1.0
        return min(2 * math.sqrt(area / math.pi), 2 * max_px)

    base = max(5.0, radius_m / res)
    kept = []  # (y, x, diameter_px); a kept pit suppresses peaks within max(radius, its own diameter)
    for i in order:
        y, x = ys[i], xs[i]
        if all((y - a) ** 2 + (x - b) ** 2 > max(base, dk) ** 2 for a, b, dk in kept):
            kept.append((y, x, diameter(y, x)))
        if len(kept) >= 200:
            break
    rows = [k[0] for k in kept]; cols = [k[1] for k in kept]; sizes = [k[2] for k in kept]
    return np.array(rows, int), np.array(cols, int), np.array(sizes, float)


@torch.no_grad()
def query_fine(body, lat, lon):
    """F-Net v2 on our NAC / HiRISE orthoimage around the query point (None when we hold no such image there)."""
    from scipy import ndimage
    from scripts.lavatube_c2f.eval_fine_v2 import predict
    radius = {'moon': 1737400, 'mars': 3396190}[body]
    for d, meta in fine_sites():
        if meta['body'] != body or not (d / 'img.npy').exists():
            continue
        rc = _locate(meta, lat, lon, radius)
        if rc is None:
            continue
        rs, cs = _crop(d, meta, *rc, None, None)
        img = np.load(d / 'img.npy', mmap_mode='r')[rs, cs].astype(np.float32)
        valid = (np.load(d / 'img_valid.npy', mmap_mode='r')[rs, cs] > 0) & (np.load(d / 'valid.npy', mmap_mode='r')[rs, cs] > 0)
        if valid.mean() < 0.3:
            continue
        m, thr = fnet()
        import scripts.lavatube_c2f.eval_fine_v2 as ev
        ev.DEV = torch.device('cpu')
        prob = predict(m, img, valid.astype(np.uint8), meta['sun_fit'][0] or 0.0)
        img_ok = np.load(d / 'img_valid.npy', mmap_mode='r')[rs, cs] > 0
        rows, cols, sizes = nms_detections(prob, thr, meta['res_m'], valid=img_ok)
        lats, lons = _to_lonlat(meta, rows + rs.start, cols + cs.start, radius)
        pits = [{'lat': round(a, 5), 'lon': round(b, 5), 'p': round(float(prob[r, c]), 3), 'row': int(r), 'col': int(c),
                 'diameter_px': float(dpx), 'diameter_m': round(float(dpx) * meta['res_m'], 1)}
                for r, c, dpx, a, b in zip(rows, cols, sizes, lats, lons)]
        pits.sort(key=lambda p: -p['p'])
        key = f'q:{body}:{lat:.4f}:{lon:.4f}'
        _OVERLAYS[key] = _png(img, valid, pits)
        area = float(valid.sum()) * meta['res_m'] ** 2 / 1e6
        return {'overlay': key, 'site': meta['name'], 'split': meta['split'], 'image': meta['image'], 'res_m': round(meta['res_m'], 2), 'area_km2': round(area, 2),
                'pit_count': len(pits), 'pits': [{k: v for k, v in p.items() if k not in ('row', 'col', 'diameter_px')} for p in pits[:40]],
                'threshold': thr, 'detector': 'F-Net v2 (image-only, sun on top)'}
    return None


def earth_fine(window_id, lat, lon, km):
    """Analytic lidar pit detections (the F-Net teacher) where a held USGS 3DEP site overlaps the candidate window."""
    best = None
    for d, meta in fine_sites():
        if meta['body'] != 'earth':
            continue
        rc = _locate(meta, lat, lon, None)
        if rc is None:
            # also accept sites whose centre lies inside the window
            continue
        best = (d, meta, rc)
        break
    if best is None:
        return None
    d, meta, (row, col) = best
    rs, cs = _crop(d, meta, row, col, None, None)
    dem = np.load(d / 'dem.npy', mmap_mode='r')[rs, cs].astype(np.float32)
    valid = np.load(d / 'valid.npy', mmap_mode='r')[rs, cs] > 0
    pit = np.load(d / 'pit.npy', mmap_mode='r')[rs, cs] > 0
    from scipy import ndimage
    from scripts.lavatube_c2f.fine_data import hillshade
    lab, n = ndimage.label(pit)
    objs = ndimage.find_objects(lab)
    pits = []
    for k, sl in enumerate(objs, 1):
        if sl is None:
            continue
        area = float((lab[sl] == k).sum())
        cy, cx = ndimage.center_of_mass(lab == k) if area < 5000 else ((sl[0].start + sl[0].stop) / 2, (sl[1].start + sl[1].stop) / 2)
        pits.append({'row': cy, 'col': cx, 'diameter_px': 2 * math.sqrt(area / math.pi), 'diameter_m': round(2 * math.sqrt(area / math.pi) * meta['res_m'], 1)})
    lats, lons = _to_lonlat(meta, [p['row'] + rs.start for p in pits], [p['col'] + cs.start for p in pits], None)
    for p, a, b in zip(pits, lats, lons):
        p['lat'], p['lon'] = round(a, 5), round(b, 5)
    pits.sort(key=lambda p: -p['diameter_m'])
    key = f'e:{window_id}'
    _OVERLAYS[key] = _png(hillshade(dem, meta['res_m'], 315, 35), valid, pits, color=(255, 120, 40))
    return {'overlay': key, 'site': meta['name'], 'source': 'USGS 3DEP lidar 1 m (teacher at 2 m)', 'pit_count': len(pits),
            'pits': [{k: v for k, v in p.items() if k not in ('row', 'col', 'diameter_px')} for p in pits[:40]],
            'area_km2': round(float(valid.sum()) * meta['res_m'] ** 2 / 1e6, 2), 'detector': 'analytic closed-depression teacher (d/D >= 0.25)'}


@lru_cache(maxsize=1)
def evaluation_summary():
    """Headline numbers from the pre-registered evaluations, in both site languages, including the baselines that beat
    the deployed version."""
    try:
        coarse = json.loads((DATA / 'results_E3v2_coarse.json').read_text())['scales']
        c, c80 = coarse['40']['all_fields']['moon'], coarse['80']['all_fields']['moon']
        f = json.loads((DATA / 'results_v2_fine.json').read_text())['pooled']
    except (OSError, KeyError, ValueError):
        return None
    r = lambda m: f"{100 * c[m]['field_recall@200']['mean']:.1f}"
    r80 = lambda m: f"{100 * c80[m]['field_recall@50']['mean']:.1f}"
    zh = (f"粗檢索（40 km、18 個已知熔岩管區、月球天窗坑查詢）前 200 名召回：上線版本（火山篩選＋地形編碼器）{r('gated_cenc_v2')}%，"
          f"只用火山距離 {r('gvp_basaltic_distance')}%，只用地形編碼器 {r('cenc_v2')}%，隨機 {r('random')}%。"
          f"主要訊號來自玄武岩火山背景：只用火山距離時，每個查詢都得到同一份清單；上線版本會依查詢地形調整排序。"
          f"上線版本占優的是 80 km 前 50 名：{r80('gated_cenc_v2')}% 對只用火山距離 {r80('gvp_basaltic_distance')}%。"
          f"F-Net v2 盲測像素 AP：月球 {f['moon']['fnet_v2']}（LoG 基線 {f['moon']['log_darkness']}），火星零樣本 {f['mars_zeroshot']['fnet_v2']}"
          f"（LoG {f['mars_zeroshot']['log_darkness']}），地球保留區 {f['earth']['fnet_v2']}（LoG {f['earth']['log_darkness']}，F-Net 較低）。")
    en = (f"Coarse stage (40 km, 18 known lava-tube fields, lunar skylight queries), recall@200: deployed (volcano gate + terrain encoder) "
          f"{r('gated_cenc_v2')}%, volcano distance alone {r('gvp_basaltic_distance')}%, terrain encoder alone {r('cenc_v2')}%, random {r('random')}%. "
          f"Most of the signal comes from the basaltic-volcano setting: volcano distance alone gives every query the same list, while the "
          f"deployed ranking adapts to the query terrain. The deployed version leads at 80 km recall@50: {r80('gated_cenc_v2')}% vs "
          f"{r80('gvp_basaltic_distance')}% for volcano distance alone. F-Net v2 blind pixel AP: Moon {f['moon']['fnet_v2']} (LoG baseline "
          f"{f['moon']['log_darkness']}), Mars zero-shot {f['mars_zeroshot']['fnet_v2']} (LoG {f['mars_zeroshot']['log_darkness']}), held-out "
          f"Earth {f['earth']['fnet_v2']} (LoG {f['earth']['log_darkness']}, F-Net lower).")
    return {'zh': zh, 'en': en}


def overlay(key):
    return _OVERLAYS.get(key)


def _run(job_id, body, lat, lon, km, candidates):
    job = _JOBS[job_id]
    try:
        job['query_fine'] = query_fine(body, lat, lon)
    except Exception as e:  # noqa: BLE001
        job['query_error'] = str(e)[:200]
    job['query_done'] = True
    for c in candidates:
        try:
            r = earth_fine(c['id'], c['lat'], c['lon'], km)
        except Exception as e:  # noqa: BLE001
            r = {'error': str(e)[:200]}
        with _LOCK:
            job['earth'][c['id']] = r
            job['done'] += 1


def start_fine(body, lat, lon, km, candidates):
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {'id': job_id, 'created': time.time(), 'total': len(candidates), 'done': 0, 'earth': {}, 'query_fine': None, 'query_done': False}
    _POOL.submit(_run, job_id, body, lat, lon, km, candidates)
    for k in sorted(_JOBS, key=lambda k: _JOBS[k]['created'])[:-200]:
        _JOBS.pop(k, None)
    return job_id


def fine_status(job_id):
    job = _JOBS.get(job_id)
    if job is None:
        raise ValueError('Unknown or expired fine-stage job')
    with _LOCK:
        return {k: (dict(v) if isinstance(v, dict) else v) for k, v in job.items()} | {'version': VERSION}
