"""SysOne-Nano at serving time (171,522 parameters, CPU): an instant terrain + material reading of the selected
Moon or Mars window, and the same reading for Earth candidates. Evidence only, never used for ranking.

Shown questions are those that passed the frozen cross-body test for the body (results_crossbody_mm.json); a question
with several tests must pass all of them. Values are within-body percentiles (the query against 60,000 Moon or 40,000
Mars windows, a candidate against all Earth windows), because the test validated ranking, not cross-body probability."""
import json
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
D = ROOT / 'data/research/sysone_nano'
# question -> (answer columns counted as "yes", label, tests per body)
READS = {
    'rock': ([0], ('像玄武岩地形', 'Reads as basaltic terrain'), {'moon': ['moon_basalt_unit'], 'mars': ['mars_volcanic_unit']}),
    'volcano60': ([1], ('像玄武岩火山背景', 'Reads as a basaltic volcanic setting'), {'moon': ['moon_volcanic_unit'], 'mars': ['mars_volcanic_unit_v60']}),
    'ice': ([1], ('像冰覆蓋', 'Reads as ice-covered'), {'mars': ['mars_ice_unit']}),
    'frozen': ([1], ('像凍土環境', 'Reads as frozen ground'), {'mars': ['mars_ice_unit_frozen', 'mars_swim']}),
    'dunes': ([1], ('像風成沙丘地形', 'Reads as aeolian dune terrain'), {'mars': ['mars_polar_dunes']}),
}


@lru_cache(maxsize=1)
def model():
    import torch
    from .model import SysOneNano, QUESTIONS
    ck = torch.load(D / 'nano_mm.pt', map_location='cpu')
    m = SysOneNano(use_material=True); m.load_state_dict(ck['model']); m.eval()
    return m, ck['temperatures'], [q[0] for q in QUESTIONS], sum(p.numel() for p in m.parameters())


@lru_cache(maxsize=1)
def passing():
    t = json.loads((D / 'results_crossbody_mm.json').read_text())['tests']
    out = {}
    for q, (_, _, tests) in READS.items():
        for body, ids in tests.items():
            res = [t.get(i, {}) for i in ids]
            if res and all(r.get('transfers') for r in res):
                out.setdefault(body, []).append((q, [{'test': i, 'auc': r['auc'], 'ci95': r['ci95']} for i, r in zip(ids, res)]))
    return out


@lru_cache(maxsize=1)
def answers():
    a = np.load(D / 'answers_mm.npz')
    ids = np.load(ROOT / 'data/research/conditions_v1/earth_conditions.npz')['ids']
    yes = lambda key, cols: a[key][:, cols].astype(np.float32).sum(1)
    ref, earth = {}, {}
    for q, (cols, _, _) in READS.items():
        earth[q] = yes(f'earth_{q}', cols)
        ref[('earth', q)] = np.sort(earth[q])
        for body in ('moon', 'mars'):
            ref[(body, q)] = np.sort(yes(f'{body}_{q}', cols))
    return earth, ref, {str(i): n for n, i in enumerate(ids)}


def pct(body, q, v):
    r = answers()[1][(body, q)]
    return round(float(np.searchsorted(r, v, side='right') / len(r)), 3)


def material_axes(body, lat, lon, km):
    sys.path.insert(0, str(ROOT))
    from scripts.material_v5 import material_query as mq
    d = mq.mars_descriptor(lat, lon, km) if body == 'mars' else mq.moon_descriptor(lat, lon, km)
    a = d['axes']
    mafic = d.get('inferred', {}).get('bedrock_mafic') if d.get('dusty') else a.get('mafic')
    v = [a.get('albedo'), a.get('ferric'), mafic, 0.9 if d.get('hydrated') else None]
    return np.array([np.nan if x is None else x for x in v], np.float32)


def query_read(body, lat, lon, km):
    shown = passing().get(body, [])
    if not shown:
        return None
    import torch
    import torch.nn.functional as F
    from scripts.lavatube_c2f.service import query_square
    m, temps, names, n_params = model()
    sq = query_square(body, lat, lon, km).astype(np.float32)
    mat = material_axes(body, lat, lon, km)
    scale = (20, 40, 80).index(min((20, 40, 80), key=lambda s: abs(s - km)))
    with torch.no_grad():
        lg, _, _ = m(torch.from_numpy(sq - np.median(sq))[None], torch.tensor([scale]), torch.from_numpy(mat)[None])
    out = []
    for q, tests in shown:
        i = names.index(q)
        p = float(F.softmax(lg[i] / temps[i], 1)[0, READS[q][0]].sum())
        zh, en = READS[q][1]
        out.append({'id': q, 'label': {'zh': zh, 'en': en}, 'query_percentile': pct(body, q, p), 'validation': tests})
    return {'model': 'SysOne-Nano', 'parameters': n_params, 'used_in_ranking': False,
            'inputs': {'terrain': True, 'material_axes': [k for k, v in zip(('albedo', 'ferric', 'mafic', 'hydroxyl'), mat) if np.isfinite(v)]},
            'questions': out}


def candidate_read(body, row_id):
    shown = passing().get(body, [])
    earth, _, pos = answers()
    i = pos.get(str(row_id))
    if i is None or not shown:
        return None
    return {q: pct('earth', q, float(earth[q][i])) for q, _ in shown}
