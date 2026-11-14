"""Max-match (2026-11-14): rank Earth windows by how many measured properties agree with the Moon or Mars window.

One feature model, nothing learned and no geologic rule: the same 12 physical properties are read on both sides
(features.py), each compared within a fixed physical tolerance (the tolerances of physmatch v5.2 and protocol p12).
  match      Earth value measured and within tolerance
  miss       Earth value measured and outside tolerance
  unmeasured no Earth measurement at this window (chemistry uses measured values only)
A property no Earth window matches is an Earth limit (e.g. lunar night temperature).
Ranking: most matches first; then fewer misses; then the smallest mean gap (|difference| / tolerance) over the measured
properties. The claim is descriptive ("matches k of n measured properties"); p12 showed that agreement on some
properties does not predict agreement on the others, so nothing is inferred about unmeasured ones.
Speed: every Earth 40 km window is scored in one vectorised pass (about 10 ms); reading the query takes ~0.3-1.5 s."""
from functools import lru_cache

import numpy as np

from . import features as F

VERSION = 'maxmatch-1.0'
PROPS = ['roughness', 'feo', 'tio2', 'k', 'th', 't_mean', 't_max', 't_min', 'ice_frac', 'dust_tau', 'wind', 'albedo']
TOL = {'roughness': 1.0, 'feo': 3.0, 'tio2': 1.5, 'k': 0.2, 'th': 2.0, 't_mean': 20.0, 't_max': 20.0, 't_min': 20.0,
       'ice_frac': 0.2, 'dust_tau': 0.2, 'wind': 2.0, 'albedo': 0.05}
LABEL = {'roughness': ('地表坡度（1.85 km）', 'Slope at 1.85 km', '°'), 'feo': ('FeO', 'FeO', 'wt%'),
         'tio2': ('TiO₂', 'TiO₂', 'wt%'), 'k': ('鉀 K', 'Potassium', 'wt%'), 'th': ('釷 Th', 'Thorium', 'ppm'),
         't_mean': ('地表平均溫度', 'Mean surface temperature', 'K'), 't_max': ('地表最高溫度', 'Maximum surface temperature', 'K'),
         't_min': ('地表最低溫度', 'Minimum surface temperature', 'K'), 'ice_frac': ('近地表地下冰比例', 'Near-surface ground ice share', ''),
         'dust_tau': ('大氣塵光學厚度', 'Dust optical depth', ''), 'wind': ('風速', 'Wind speed', 'm/s'),
         'albedo': ('反照率', 'Albedo', '')}
SOURCE = {
    'moon': {'roughness': 'LOLA', 'feo': 'Lunar Prospector GRS', 'tio2': 'Lunar Prospector GRS', 'k': 'Lunar Prospector GRS',
             'th': 'Lunar Prospector GRS', 't_mean': 'LRO Diviner', 't_max': 'LRO Diviner', 't_min': 'LRO Diviner',
             'ice_frac': 'LRO Diviner ice stability'},
    'mars': {'roughness': 'MOLA', 'feo': 'Mars Odyssey GRS', 'k': 'Mars Odyssey GRS', 'th': 'Mars Odyssey GRS',
             't_mean': 'Mars Climate Database', 't_max': 'Mars Climate Database', 't_min': 'Mars Climate Database',
             'ice_frac': 'SWIM', 'dust_tau': 'Mars Climate Database', 'wind': 'Mars Climate Database', 'albedo': 'MGS TES'},
    'earth': {'roughness': 'ETOPO 2022', 'feo': 'soil geochemistry surveys', 'tio2': 'soil geochemistry surveys',
              'k': 'airborne gamma-ray surveys', 'th': 'airborne gamma-ray surveys', 't_mean': 'MODIS LST', 't_max': 'MODIS LST',
              't_min': 'MODIS LST', 'ice_frac': 'ESA CCI permafrost', 'dust_tau': 'NASA POWER', 'wind': 'NASA POWER',
              'albedo': 'GLASS'}}


def earth_values(body, p):
    E = F.earth(body)
    return E['measured_chem'][p] if p in F.CHEM else E['X'][:, F.COL[p]]


def evaluate(body, x):
    """match matrix (properties x windows; 1, 0 or NaN), gaps, ranking score and Earth limits for a query vector x."""
    props = [p for p in PROPS if np.isfinite(x[F.COL[p]])]
    n = len(F.earth(body)['lat'])
    M = np.full((len(props), n), np.nan, np.float32)
    G = np.full((len(props), n), np.nan, np.float32)
    for k, p in enumerate(props):
        ev = earth_values(body, p)
        ok = np.isfinite(ev)
        gap = np.abs(ev - x[F.COL[p]]) / TOL[p]
        G[k, ok] = np.minimum(gap[ok], 10.0)
        M[k, ok] = (gap[ok] <= 1.0).astype(np.float32)
    matched = np.nansum(M, 0)
    measured = np.isfinite(M).sum(0)
    missed = measured - matched
    mean_gap = np.where(measured > 0, np.nansum(G, 0) / np.maximum(measured, 1), 10.0)
    # lexicographic: matches, then fewer misses, then mean gap; packed into one float for the shared ranking code
    score = matched * 1e4 - missed * 1e2 - mean_gap
    limits = [p for k, p in enumerate(props) if not np.nanmax(np.nan_to_num(M[k], nan=0)) > 0]
    return {'props': props, 'M': M, 'G': G, 'matched': matched, 'measured': measured, 'score': score, 'limits': limits}


@lru_cache(maxsize=32)
def _query(body, lat, lon):
    return F.query(body, lat, lon)


def query(body, lat, lon):
    return _query(body, round(float(lat), 4), round(float(lon), 4))


_MAP = {}


def scale_positions(rows, row_indices, km):
    """position in the 40 km property table of every search row (nearest 40 km window within 30 km, else -1)."""
    key = (int(km), len(row_indices))
    if key not in _MAP:
        from sklearn.neighbors import BallTree
        E = F.earth('moon')
        ids40 = {s: i for i, s in enumerate(E['ids'].tolist())}
        direct = np.array([ids40.get(rows[int(i)]['id'], -1) for i in row_indices])
        if (direct >= 0).mean() > 0.99:
            _MAP[key] = direct
        else:
            tree = BallTree(np.radians(np.c_[E['lat'], E['lon']]), metric='haversine')
            c = np.radians([[rows[int(i)]['center']['latitude'], rows[int(i)]['center']['longitude_east']] for i in row_indices])
            d, j = tree.query(c, k=1)
            _MAP[key] = np.where(d[:, 0] * 6371.0 <= 30.0, j[:, 0], -1)
    return _MAP[key]


def rank_rows(body, lat, lon, rows, row_indices, km):
    """ranking score aligned with a search index (rows without a 40 km property window rank last), plus the evaluation."""
    x = query(body, lat, lon)
    ev = evaluate(body, x)
    pos = scale_positions(rows, row_indices, km)
    s = np.where(pos >= 0, ev['score'][np.maximum(pos, 0)], -1e9)
    order = np.argsort(np.argsort(-s, kind='stable'), kind='stable')
    scaled = (1.0 - 2.0 * order / max(len(s) - 1, 1)).astype(np.float32)  # rank-preserving, in [-1, 1]
    return scaled, x, ev, pos


def candidate(body, x, ev, i, zh=True):
    """per-property block of one Earth window (40 km table position i) for display."""
    if i is None or i < 0:
        return None
    items = []
    for k, p in enumerate(ev['props']):
        m = ev['M'][k, i]
        ev_val = earth_values(body, p)[i]
        status = 'unmeasured' if not np.isfinite(m) else 'match' if m == 1 else 'miss'
        items.append({'id': p, 'label': list(LABEL[p][:2]), 'unit': LABEL[p][2], 'tolerance': TOL[p],
                      'query': round(float(x[F.COL[p]]), 3), 'earth': None if not np.isfinite(ev_val) else round(float(ev_val), 3),
                      'status': status, 'earth_limit': p in ev['limits'],
                      'source_query': SOURCE[body].get(p), 'source_earth': SOURCE['earth'].get(p)})
    return {'matched': int(ev['matched'][i]), 'measured': int(ev['measured'][i]), 'properties': len(ev['props']),
            'items': items}


def summary(body, ev, zh=True):
    return {'version': VERSION, 'properties': len(ev['props']),
            'earth_limits': [{'id': p, 'label': list(LABEL[p][:2])} for p in ev['limits']],
            'best_matched': int(np.max(ev['matched'])) if len(ev['matched']) else 0,
            'windows_matching_all': int(((ev['matched'] == len(ev['props'])) & (ev['measured'] == len(ev['props']))).sum()),
            'ranking': 'most measured properties within tolerance; then fewer misses; then smallest mean gap'}
