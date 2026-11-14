"""Facets v7 display services (2026-11-13). Nothing here enters ranking.

nearest_any(lat, lon): the nearest catalogued analog site of any body, and whether the candidate is off-catalogue
  (>= 100 km from every catalogued site and outside Antarctica, the Atacama, Iceland and Hawaii).
biology(lat, lon, body, qlat, qlon): for one Earth candidate, the biosignature-preservation settings the window offers,
  the microbiome samples (MGnify) within 50 km by environment class, and for Mars the settings the target window offers."""
import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
V7 = ROOT / 'data/research/facets_v7'
OFF_KM = 100.0
NAMED = [('Antarctica', -90, -60, -180, 180), ('Atacama', -28, -18, -72, -66), ('Iceland', 63, 67, -25, -13), ('Hawaii', 18, 23, -161, -154)]
CLASS_TEXT = {'hydrothermal': ('溫泉與火山熱液', 'hot springs and volcanic heat'), 'saline_evaporite': ('鹽湖與鹼湖', 'salt and soda lakes'),
              'cryo': ('冰川與凍土', 'glaciers and permafrost'), 'arid_soil': ('沙漠土壤', 'desert soil'),
              'subsurface_rock': ('地下、洞穴、礦坑與岩石表面', 'deep subsurface, caves, mines and rock surfaces')}
PRES = ['pres_lacustrine', 'pres_hydrothermal', 'pres_cryo', 'pres_subsurface', 'pres_arid']


def _hav(la1, lo1, la2, lo2):
    p1, p2 = np.radians(la1), np.radians(la2)
    dl = np.radians((np.asarray(lo2) - lo1 + 180) % 360 - 180)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * 6371.0 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


@lru_cache(maxsize=1)
def _catalogue():
    c = json.loads((ROOT / 'data/research/known_analogs/catalogue.json').read_text(encoding='utf-8'))
    s = c['sites'] if isinstance(c, dict) else c
    return s, np.array([x['lat'] for x in s]), np.array([x['lon'] for x in s])


def named_region(lat, lon):
    return next((n for n, a, b, c, d in NAMED if a <= lat <= b and c <= lon <= d), None)


def nearest_any(lat, lon):
    try:
        s, la, lo = _catalogue()
    except (OSError, ValueError, KeyError):
        return None
    d = _hav(lat, lon, la, lo); k = int(np.argmin(d))
    region = named_region(lat, lon)
    return {'id': s[k]['id'], 'name': s[k]['name'], 'name_zh': s[k].get('name_zh'), 'distance_km': round(float(d[k]), 1),
            'named_region': region, 'off_catalogue': bool(d[k] >= OFF_KM and not region)}


@lru_cache(maxsize=1)
def _microbes():
    d = json.loads((V7 / 'mgnify_samples.json').read_text(encoding='utf-8'))['samples']
    return (np.array([x['lat'] for x in d]), np.array([x['lon'] for x in d]), np.array([x['cls'] for x in d]))


def microbiome(lat, lon, radius=50.0):
    try:
        la, lo, cls = _microbes()
    except (OSError, ValueError, KeyError):
        return {'available': False}
    box = np.abs(la - lat) <= radius / 111.0 + 0.05
    d = _hav(lat, lon, la[box], lo[box]); c = cls[box]
    near = d <= radius
    by = {k: int((near & (c == k)).sum()) for k in CLASS_TEXT}
    return {'available': True, 'radius_km': radius, 'total': int(near.sum()), 'by_class': by,
            'labels': {k: {'zh': z, 'en': e} for k, (z, e) in CLASS_TEXT.items()}}


@lru_cache(maxsize=1)
def _earth_xyz():
    from scripts.facets_v7 import service as S
    F = S.earth()
    la, lo = np.radians(F['lat'].astype(float)), np.radians(F['lon'].astype(float))
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], 1).astype(np.float32)


def earth_settings(lat, lon):
    from scripts.facets_v7 import service as S
    from scripts.conditions_v1 import service as C
    xyz = _earth_xyz()
    p = np.array([math.cos(math.radians(lat)) * math.cos(math.radians(lon)), math.cos(math.radians(lat)) * math.sin(math.radians(lon)),
                  math.sin(math.radians(lat))], np.float32)
    i = int(np.argmax(xyz @ p))
    F, e = S.earth(), C.earth()
    g = lambda k: F[k][[i]]
    ge = lambda k: e[k][[i]]
    out = {}
    for t in PRES:
        _, s = S.MARS_MEASURES[t](g, ge)
        v = float(s[0])
        out[t] = None if not np.isfinite(v) else v
    return out


@lru_cache(maxsize=256)
def target_settings(qlat, qlon):
    from scripts.facets_v7 import service as S
    from scripts.conditions_v1 import service as C
    cp = C.query_profile('mars', qlat, qlon, 40)
    prof = S.profile_mars(qlat, qlon, 40, cp)
    return {'kinds': prof['kinds'], 'settings': [t['id'] for t in prof['tokens'] if t['id'] in PRES],
            'measured': prof.get('mars_measured', {})}


def biology(lat, lon, body, qlat=None, qlon=None):
    from scripts.facets_v7 import service as S
    out = {'labels': {k: {'zh': S.PRESERVATION[k][0], 'en': S.PRESERVATION[k][1]} for k in PRES},
           'earth': earth_settings(lat, lon), 'microbiome': microbiome(lat, lon), 'body': body}
    if body == 'mars' and qlat is not None and qlon is not None:
        out['target'] = target_settings(round(float(qlat), 3), round(float(qlon), 3))
    return out
