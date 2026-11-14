"""Terrain + material search: shared scoring (used by the evaluation and the web server) and on-demand Sentinel-2
observation of shortlisted Earth windows.

Material similarity between a Moon/Mars window and an Earth window = 1 - weighted mean |query percentile - Earth
percentile| over the target axes (material_query.target_axes): albedo<->albedo, ferric<->ferric (B4/B2),
mafic<->ferrous index, hydrated<->hydroxyl (B11/B12), and dryness (aridity). Earth percentiles come from the observed
spectrum when the ground is visible, otherwise from the occlusion-robust inference (material_infer)."""
import json
import math
import queue
import sqlite3
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))
DATA = ROOT / 'data/research/material_v5'
# amendment 3: Earth mafic = share of basic volcanic + basic plutonic rock in the geologic map (GLiM vb + pb); Sentinel-2
# has no ~1 um band and its 'ferrous index' did not separate basalt fields (kept for display only)
EARTH_AXIS = {'albedo': 'albedo', 'ferric': 'ferric', 'mafic': 'glim_mafic', 'hydroxyl': 'hydroxyl'}
LABELS = {'albedo': '亮度（反照率）', 'ferric': '鐵氧化物（紅土、赤鐵）', 'mafic': '鐵鎂礦物（玄武岩質）', 'hydroxyl': '含水／黏土礦物', 'dryness': '乾燥程度'}
_LOCK = threading.Lock()
_JOBS = {}
_POOL = ThreadPoolExecutor(max_workers=2)


DOMAIN_PENALTY = 0.2


@lru_cache(maxsize=1)
def inferred():
    d = np.load(DATA / 'earth_material_inferred.npz')
    c = np.load(DATA / 'earth_covariates.npz')
    names = list(c['names'])
    # applicability domain (amendment 2): occluding cover above the 95th percentile of the training sample
    occ = sum(np.nan_to_num(c['X'][:, names.index(f'worldcover_{k}')]) for k in ('tree', 'snow_ice', 'water', 'wetland_mangrove'))
    limit = float(np.percentile(occ[d['observed_rows']], 95))
    mafic = np.clip(np.nan_to_num(c['X'][:, names.index('glim_vb')]) + np.nan_to_num(c['X'][:, names.index('glim_pb')]), 0, 1)
    return {'pos': {w: i for i, w in enumerate(d['ids'])}, 'pct': d['percentile'], 'q10': d['q10'], 'q90': d['q90'], 'est': d['estimate'],
            'dryness': d['dryness'], 'axes': list(d['axes']), 'sorted': d['observed_sorted'], 'occ': occ.astype(np.float32),
            'outside': occ > limit, 'occ_limit': limit, 'glim_mafic': mafic.astype(np.float32)}


def earth_percentiles_from_observation(record, window_id=None):
    """Earth axis percentiles from a Sentinel-2 record, or None when too little ground is visible. The mafic axis is not
    observable by Sentinel-2; it comes from the geologic map when the window id is given."""
    m = record.get('mineral') if record else None
    if not m or m.get('n', 0) < 30 or record['fractions']['mineral'] < 0.1:
        return None
    inf = inferred()
    vals = {'albedo': m['albedo'][1], 'ferric': math.log(max(m['ferric'], 1e-3)), 'ferrous': math.log(max(m['ferrous'], 1e-3)),
            'hydroxyl': math.log(max(m['hydroxyl'], 1e-3))}
    out = {a: float(np.searchsorted(inf['sorted'][:, j], vals[a]) / len(inf['sorted'])) for j, a in enumerate(inf['axes'])}
    i = inf['pos'].get(window_id) if window_id else None
    if i is not None:
        out['glim_mafic'] = float(inf['glim_mafic'][i])
    return out


def similarity(target, weights, earth_pct, dryness):
    """1 - weighted mean absolute percentile gap; per-axis gap and verdict for display."""
    gaps, total, wsum = {}, 0.0, 0.0
    for axis, t in target.items():
        e = dryness if axis == 'dryness' else earth_pct.get(EARTH_AXIS[axis])
        if e is None or t is None or not np.isfinite(e):
            continue
        g = abs(float(t) - float(e))
        gaps[axis] = {'query': round(float(t), 3), 'earth': round(float(e), 3), 'gap': round(g, 3),
                      'verdict': 'support' if g <= 0.15 else 'partial' if g <= 0.3 else 'conflict'}
        total += weights.get(axis, 1.0) * g
        wsum += weights.get(axis, 1.0)
    return (round(1 - total / wsum, 4) if wsum else None), gaps


def inferred_similarity_array(target, weights, gallery_index):
    """Vectorised similarity from the inferred percentiles for many Earth windows (gallery indices; -1 = unknown)."""
    inf = inferred()
    total = np.zeros(len(gallery_index)); wsum = 0.0
    ok = gallery_index >= 0
    gi = np.where(ok, gallery_index, 0)
    for axis, t in target.items():
        if axis == 'dryness':
            e = inf['dryness'][gi]
        elif axis == 'mafic':
            e = inf['glim_mafic'][gi]
        else:
            e = inf['pct'][gi, inf['axes'].index(EARTH_AXIS[axis])]
        total += weights.get(axis, 1.0) * np.abs(float(t) - e)
        wsum += weights.get(axis, 1.0)
    sim = 1 - total / max(wsum, 1e-9) - DOMAIN_PENALTY * inf['outside'][gi]
    return np.where(ok, sim, np.nan)


def inferred_detail(window_id, target, weights):
    inf = inferred()
    i = inf['pos'].get(window_id)
    if i is None:
        return None
    pct = {a: float(inf['pct'][i, j]) for j, a in enumerate(inf['axes'])}
    pct['glim_mafic'] = float(inf['glim_mafic'][i])
    sim, gaps = similarity(target, weights, pct, float(inf['dryness'][i]))
    est = {a: round(float(math.exp(inf['est'][i, j]) if a != 'albedo' else inf['est'][i, j]), 4) for j, a in enumerate(inf['axes'])}
    band = {a: [round(float(math.exp(inf['q10'][i, j]) if a != 'albedo' else inf['q10'][i, j]), 4),
                round(float(math.exp(inf['q90'][i, j]) if a != 'albedo' else inf['q90'][i, j]), 4)] for j, a in enumerate(inf['axes'])}
    outside = bool(inf['outside'][i])
    return {'similarity': (round(sim - DOMAIN_PENALTY, 4) if outside and sim is not None else sim), 'axes': gaps, 'estimate': est,
            'interval_10_90': band, 'source': 'inferred', 'low_confidence': outside, 'occluding_cover': round(float(inf['occ'][i]), 3),
            'occluding_cover_limit': round(inf['occ_limit'], 3)}


# ------------------------------------------------------------------------------------------- observation
def observe(window_ids, workers=6):
    """Sentinel-2 records for the given window ids (cached in earth_s2.sqlite; missing ones are measured now)."""
    from scripts.material_v5 import earth_s2
    out, todo = {}, []
    with earth_s2.connect() as c:
        for i in range(0, len(window_ids), 900):
            chunk = window_ids[i:i + 900]
            for row in c.execute(f'SELECT id, key, lat, lon, region, scale, known, status, record FROM windows WHERE id IN ({",".join("?" * len(chunk))})', chunk):
                if row[7] in ('ready', 'no_clear_scene'):
                    out[row[0]] = json.loads(row[8]) if row[8] else None
                else:
                    todo.append(row[:7])
    if todo:
        groups = {}
        for r in todo:
            groups.setdefault(r[4], []).append(r)
        results = queue.Queue()
        with ThreadPoolExecutor(workers) as pool:
            list(pool.map(lambda kv: _safe_region(earth_s2, kv[0], kv[1], results), groups.items()))
        batch = []
        while not results.empty():
            batch.append(results.get())
        with earth_s2.connect() as c:
            c.executemany('UPDATE windows SET status = ?, record = ?, error = ?, updated = ? WHERE id = ?',
                          [(s, json.dumps(r) if r else None, e, time.time(), wid) for wid, s, r, e in batch])
        for wid, s, r, e in batch:
            out[wid] = r if s == 'ready' else None
    return out


def _safe_region(earth_s2, region, rows, results):
    try:
        earth_s2.region_work(region, rows, results)
    except Exception as e:  # noqa: BLE001 - one region failing must not stop the others
        for r in rows:
            results.put((r[0], 'read_error', None, str(e)[:200]))


@lru_cache(maxsize=1)
def evaluation_summary():
    """Headline numbers of the pre-registered evaluation (both site languages), once the result files exist."""
    try:
        cv = json.loads((DATA / 'results_material_cv.json').read_text())
        se = json.loads((DATA / 'results_material_search.json').read_text())['by_class']['all']
    except (OSError, KeyError, ValueError):
        return None
    rho = {a: cv['axes'][a]['gbm_full']['rho'] for a in cv['axes']}
    nn = {a: cv['axes'][a]['nearest_neighbour']['rho'] for a in cv['axes']}
    t, m = se['terrain']['observed_distance']['mean'], se['terrain_material']['observed_distance']['mean']
    zh = (f"材質推估（空間分區交叉驗證，{cv['n_observed_targets']} 個實測窗格）Spearman ρ：亮度 {rho['albedo']:.2f}、鐵氧化物 {rho['ferric']:.2f}、"
          f"鐵鎂 {rho['ferrous']:.2f}、含水 {rho['hydroxyl']:.2f}（最近鄰基線 {nn['albedo']:.2f}／{nn['ferric']:.2f}／{nn['ferrous']:.2f}／{nn['hydroxyl']:.2f}）；"
          f"搜尋：前 10 名的實測材質差距 只看地形 {t:.3f} → 地形＋材質 {m:.3f}，地形相似度保留 {se['cosine_ratio'] * 100:.0f}%。")
    en = (f"Material inference (spatial-block CV, {cv['n_observed_targets']} observed windows) Spearman rho: albedo {rho['albedo']:.2f}, ferric {rho['ferric']:.2f}, "
          f"mafic {rho['ferrous']:.2f}, hydrated {rho['hydroxyl']:.2f} (nearest-neighbour baseline {nn['albedo']:.2f}/{nn['ferric']:.2f}/{nn['ferrous']:.2f}/{nn['hydroxyl']:.2f}); "
          f"search: observed material gap of the top 10, terrain only {t:.3f} -> terrain + material {m:.3f}, terrain similarity kept {se['cosine_ratio'] * 100:.0f}%.")
    return {'zh': zh, 'en': en}


# ------------------------------------------------------------------------------------------- web jobs
def start_observation(target, weights, candidates):
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {'id': job_id, 'created': time.time(), 'total': len(candidates), 'done': 0, 'results': {}}

    def run():
        for c in candidates:
            try:
                rec = observe([c])[c]
                pct = earth_percentiles_from_observation(rec, c)
                if pct is None:
                    r = {'state': 'not_visible', 'fractions': rec['fractions'] if rec else None,
                         'note': 'ground not visible enough (vegetation, water, snow or cloud); the inferred material is used'}
                else:
                    inf = inferred()
                    i = inf['pos'].get(c)
                    sim, gaps = similarity(target, weights, pct, float(inf['dryness'][i]) if i is not None else None)
                    r = {'state': 'observed', 'similarity': sim, 'axes': gaps, 'fractions': rec['fractions'], 'scene': rec.get('item_id'),
                         'date': (rec.get('datetime') or '')[:10]}
            except Exception as e:  # noqa: BLE001
                r = {'state': 'error', 'error': str(e)[:200]}
            with _LOCK:
                _JOBS[job_id]['results'][c] = r
                _JOBS[job_id]['done'] += 1
    _POOL.submit(run)
    for k in sorted(_JOBS, key=lambda k: _JOBS[k]['created'])[:-200]:
        _JOBS.pop(k, None)
    return job_id


def job_status(job_id):
    job = _JOBS.get(job_id)
    if job is None:
        raise ValueError('Unknown or expired material job')
    with _LOCK:
        return {k: (dict(v) if isinstance(v, dict) else v) for k, v in job.items()}
