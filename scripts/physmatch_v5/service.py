"""Physical match v5 (route v5.2): token-level comparison of a Moon or Mars window with Earth windows.

Query side (orbital, same reading as protocol p3): Lunar Prospector GRS FeO, TiO2, K, Th and LROC WAC 643 nm albedo
(Moon); Mars Odyssey GRS Fe -> FeO, K, Th (5 deg) and TES albedo (Mars); roughness from the query DEM window (~1.88 km
median absolute slope, the same operation as on Earth). Day and night temperature are known only for Mars p3 queries
and are otherwise absent.
Earth side: data/research/pat_v1/earth_props_v1.npz (measured values; GBT estimates only inside the p7b envelope;
estimates enter scoring only where p8 V2 passed for that property and support).
Scoring: score.py (p = Pr(|q - e| <= tau); use score = weighted mean over the query's available properties).
Nothing here changes the other purposes' rankings; the 'physical' purpose ranks by the use score."""
import glob
import json
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import score as S

ROOT = Path(__file__).resolve().parents[2]
PAT = ROOT / 'data/research/pat_v1'
P3SRC = ROOT / 'data/research/physmatch_p3/sources'
VERSION = 'physmatch-v5.0'
SUPPORT = {'moon': 'window', 'mars': 'foot220'}
CHEM = ('feo', 'tio2', 'k', 'th')
PHYS = ('roughness', 'albedo', 't_day', 't_night')
MEDIUM_EARTH = {'feo': 'topsoil', 'tio2': 'topsoil', 'k': 'airborne_gamma', 'th': 'airborne_gamma', 'roughness': 'surface',
                'albedo': 'snow_free', 't_day': 'surface', 't_night': 'surface'}
PROV_EARTH = {'feo': 'USGS DS801 / GA NGSA / FOREGS', 'tio2': 'USGS DS801 / GA NGSA / FOREGS', 'k': 'Radmap v4 2019 / NAMrad 2005',
              'th': 'Radmap v4 2019 / NAMrad 2005', 'roughness': 'ETOPO 2022 15 arcsec', 'albedo': 'GLASS snow-free albedo',
              't_day': 'MODIS MOD11A2', 't_night': 'MODIS MOD11A2'}
PROV_QUERY = {'moon': {'feo': 'Lunar Prospector GRS', 'tio2': 'Lunar Prospector GRS', 'k': 'Lunar Prospector GRS',
                       'th': 'Lunar Prospector GRS', 'albedo': 'LROC WAC 643 nm', 'roughness': 'LOLA'},
              'mars': {'feo': 'Mars Odyssey GRS', 'k': 'Mars Odyssey GRS', 'th': 'Mars Odyssey GRS', 'albedo': 'TES',
                       'roughness': 'MOLA', 't_day': 'Mars Climate Database', 't_night': 'Mars Climate Database'}}
R_KM = {'moon': 1737.4, 'mars': 3389.5}


# ------------------------------------------------------------------ Earth side
@lru_cache(maxsize=1)
def earth():
    z = np.load(PAT / 'earth_props_v1.npz')
    E = {k: z[k] for k in z.files}
    p8 = json.loads((PAT / 'results_p8.json').read_text(encoding='utf-8'))
    allow = p8['decisions']['estimates_in_scoring']
    E['allow'] = {('moon', k): bool(allow.get(f'moon:{k}', False)) for k in CHEM}
    E['allow'].update({('mars', k): bool(allow.get(f'mars:{k}', False)) for k in CHEM})
    E['v4'] = p8['v4']['summary']
    E['p8_sha'] = p8['protocol_sha256']
    est = json.loads((PAT / 'estimates_v1.json').read_text(encoding='utf-8'))
    E['est_sha'] = est['sha256']['estimates_v1.npz']
    from sklearn.neighbors import BallTree
    E['tree'] = BallTree(np.radians(np.c_[E['lat'], E['lon']]), metric='haversine')
    return E


def props(body, scoring=True):
    """property arrays over the 75,860 Earth windows for a query of `body`; estimates kept for display (scoring=False)
    or only where p8 allowed them (scoring=True)."""
    E = earth()
    out = {}
    for k in CHEM:
        s = SUPPORT[body]
        src = E[f'{s}_{k}_src'].copy()
        if scoring and not E['allow'][(body, k)]:
            src = np.where(src == 2, 0, src)
        out[k] = {'value': E[f'{s}_{k}_value'], 'lo': E[f'{s}_{k}_lo'], 'hi': E[f'{s}_{k}_hi'], 'src': src}
    for k in PHYS:
        out[k] = {f: E[f'window_{k}_{f}'] for f in ('value', 'lo', 'hi', 'src')}
    return out


def window_index(lat, lon, max_km=30.0):
    """nearest bundle40 window to a centre, or -1."""
    E = earth()
    d, j = E['tree'].query(np.radians([[lat, lon]]), k=1)
    return int(j[0, 0]) if d[0, 0] * 6371.0 <= max_km else -1


_SCALE_MAP = {}


def scale_map(km, rows, row_indices):
    """for the search index of one scale: nearest 40 km property window (<= 30 km) of every row, or -1."""
    key = (int(km), len(row_indices))
    if key not in _SCALE_MAP:
        c = np.array([[rows[int(i)]['center']['latitude'], rows[int(i)]['center']['longitude_east']] for i in row_indices], float)
        d, j = earth()['tree'].query(np.radians(c), k=1)
        _SCALE_MAP[key] = np.where(d[:, 0] * 6371.0 <= 30.0, j[:, 0], -1)
    return _SCALE_MAP[key]


def candidate_block(body, P, summ, lat, lon):
    i = window_index(lat, lon)
    if i < 0:
        return {'available': False, 'reason': 'no 40 km property window within 30 km of this candidate'}
    out = comparison(body, P, i, summ['ceilings'])
    out['available'] = True
    out['earth_window'] = {'lat': round(float(earth()['lat'][i]), 4), 'lon': round(float(earth()['lon'][i]), 4)}
    return out


def earth_tokens(i, body='moon'):
    E = earth(); P = props(body, scoring=True); D = props(body, scoring=False)
    toks = []
    for k in CHEM + PHYS:
        d = D[k]; src = int(d['src'][i]); v = float(d['value'][i]) if np.isfinite(d['value'][i]) else None
        scored = int(P[k]['src'][i]) != 0
        flags = []
        if k in ('k', 'th') and SUPPORT[body] == 'window' and int(E[f'window_{k}_atten_flag'][i]):
            flags.append('attenuation_risk')
        if src == 2 and not scored:
            flags.append('not_scored')
        toks.append({'id': k, 'group': 'geochem' if k in CHEM else 'surface', 'class': 'physical',
                     'label': {'zh': S.LABEL[k][0], 'en': S.LABEL[k][1]}, 'value': None if v is None else round(v, 4), 'unit': S.UNIT[k],
                     'interval90': ([round(float(d['lo'][i]), 4), round(float(d['hi'][i]), 4)] if src == 2 else None),
                     'interval_method': 'CV conformal, Mondrian sigma terciles (p7b)' if src == 2 else None,
                     'medium': MEDIUM_EARTH[k] if src else None, 'support': (SUPPORT[body] if k in CHEM else 'window') if src else None,
                     'source': {1: 'measured', 2: 'estimated', 0: 'missing'}[src], 'flags': flags,
                     'provenance': PROV_EARTH[k] if src == 1 else ('gbt-v1 ' + E['est_sha'][:12] if src == 2 else None), 'body': 'earth'})
    return {'window': {'index': int(i), 'lat': round(float(E['lat'][i]), 4), 'lon': round(float(E['lon'][i]), 4)},
            'tokens': toks, 'version': VERSION}


# ------------------------------------------------------------------ query side
class _Binned:
    def __init__(self, path, scale=1.0):
        r = np.loadtxt(path, comments='#', delimiter=',')
        self.la0, self.la1, self.lo0, self.lo1, self.v = r[:, 0], r[:, 1], r[:, 2], r[:, 3], r[:, 4] * scale

        # Grid lookup: index each bin by its (lat0, lon0) cell; first row wins, as in a linear scan.
        self._lat_edges, li = np.unique(self.la0, return_inverse=True)
        self._lon_edges, lj = np.unique(self.lo0, return_inverse=True)
        keys = li.astype(np.int64) * len(self._lon_edges) + lj
        self._keys, self._first = np.unique(keys, return_index=True)

    def _scan(self, a, o):
        m = np.flatnonzero((self.la0 <= a) & (a < self.la1) & (self.lo0 <= o) & (o < self.lo1))
        return m[0] if len(m) else -1

    def at(self, lat, lon):
        lat = np.asarray(lat, float); lon = np.asarray(lon, float)
        out = np.full(len(lat), np.nan)
        i = np.searchsorted(self._lat_edges, lat, side='right') - 1
        j = np.searchsorted(self._lon_edges, lon, side='right') - 1
        key = i.astype(np.int64) * len(self._lon_edges) + j
        pos = np.clip(np.searchsorted(self._keys, key), 0, len(self._keys) - 1)
        row = np.where((i >= 0) & (j >= 0) & (self._keys[pos] == key), self._first[pos], -1)
        r = np.maximum(row, 0)
        hit = (row >= 0) & (self.la0[r] <= lat) & (lat < self.la1[r]) & (self.lo0[r] <= lon) & (lon < self.lo1[r])
        out[hit] = self.v[r[hit]]
        for k in np.flatnonzero(~hit):  # outside the regular grid: fall back to the exact scan
            m = self._scan(lat[k], lon[k])
            if m >= 0:
                out[k] = self.v[m]
        return out


class _GRS5:
    def __init__(self, path, scale=1.0):
        r = np.loadtxt(path)
        self.grid = np.full((36, 72), np.nan)
        for la, lo, v, s, _ in r:
            if v < 9000:
                self.grid[int((la + 90) // 5), int((lo % 360) // 5)] = v * scale

    def at(self, lat, lon):
        i = np.clip(((np.asarray(lat) + 90) // 5).astype(int), 0, 35); j = ((np.asarray(lon) % 360) // 5).astype(int) % 72
        return self.grid[i, j]


class _Raster:
    def __init__(self, paths, radius_m, lon360):
        import rasterio
        self.ds = [rasterio.open(p) for p in paths]; self.R = radius_m; self.lon360 = lon360

    def at(self, lat, lon):
        from rasterio.windows import Window
        out = np.full(len(lat), np.nan)
        for i, (a, o) in enumerate(zip(lat, lon)):
            o = o % 360 if self.lon360 else o
            x, y = self.R * np.radians(o), self.R * np.radians(a)
            for d in self.ds:
                b = d.bounds
                if b.left <= x < b.right and b.bottom <= y < b.top:
                    r, c = d.index(x, y)
                    v = float(d.read(1, window=Window(c, r, 1, 1))[0, 0])
                    if np.isfinite(v) and v > -1e30 and (d.nodata is None or v != d.nodata):
                        out[i] = v
                    break
        return out


@lru_cache(maxsize=1)
def maps():
    lp = P3SRC / 'lp'; grs = P3SRC / 'grs'
    return {'moon': {'feo': _Binned(ROOT / 'data/moon/lunar_prospector/ironhd.txt'),
                     'tio2': _Binned(ROOT / 'data/moon/lunar_prospector/titanium2d.txt', 1.668),
                     'k': _Binned(lp / 'potassium2d.txt', 1e-4), 'th': _Binned(lp / 'thoriumhd.txt'),
                     'albedo': _Raster(sorted(glob.glob(str(P3SRC / 'wac/WAC_HAPKE_643NM_E350*.IMG'))), 1737400.0, True)},
            'mars': {'feo': _GRS5(grs / 'fe_sr_5x5.tab', 1.2865), 'k': _GRS5(grs / 'k_sr_5x5.tab'), 'th': _GRS5(grs / 'th_sr_5x5.tab'),
                     'albedo': _Raster([P3SRC / 'tes/tes_albedo.tif'], 3396000.0, False)}}


def _window_points(lat, lon, body, km, n=9):
    import math
    half = km / 2 / R_KM[body]
    off = np.degrees(np.linspace(-half, half, n))
    dy, dx = np.meshgrid(off, off, indexing='ij')
    la = np.clip(lat + dy, -89.999, 89.999)
    lo = lon + dx / max(math.cos(math.radians(lat)), 0.05)
    return la.ravel(), ((lo.ravel() + 180) % 360) - 180


def _roughness(grid, km, target_km=1.85):
    import cv2
    g = np.asarray(grid, np.float32)
    if g.ndim != 2 or not np.isfinite(g).all():
        return None
    n = int(round(km / target_km)); spacing = km * 1000 / (g.shape[0] - 1) * g.shape[0] / n
    s = cv2.resize(g, (n, n), interpolation=cv2.INTER_AREA).astype(np.float64)
    gy, gx = np.gradient(s, spacing)
    return float(np.median(np.degrees(np.arctan(np.hypot(gx, gy)))))


@lru_cache(maxsize=256)
def _query_values(body, lat, lon, km):
    la, lo = _window_points(lat, lon, body, 40.0)
    P = {}
    for k, m in maps()[body].items():
        v = m.at(la, lo)
        ok = np.isfinite(v)
        P[k] = float(v[ok].mean()) if ok.sum() >= len(v) / 2 else None
    return P


def query_properties(body, lat, lon, km, grid=None):
    P = dict(_query_values(body, round(float(lat), 4), round(float(lon), 4), int(km)))
    if body == 'mars':
        P['tio2'] = None
    P['roughness'] = _roughness(grid, km) if grid is not None else None
    P['t_day'] = P['t_night'] = None
    return P


def query_tokens(body, P):
    toks = []
    for k in CHEM + PHYS:
        v = P.get(k)
        toks.append({'id': k, 'group': 'geochem' if k in CHEM else 'surface', 'class': 'physical',
                     'label': {'zh': S.LABEL[k][0], 'en': S.LABEL[k][1]}, 'value': None if v is None else round(v, 4), 'unit': S.UNIT[k],
                     'interval90': None, 'medium': ('orbital_gamma' if k in CHEM else 'orbital') if v is not None else None,
                     'support': ('foot220' if (body == 'mars' and k in CHEM) else 'window40') if v is not None else None,
                     'source': 'measured' if v is not None else 'not_applicable' if (body == 'mars' and k == 'tio2') else 'missing',
                     'flags': [], 'provenance': PROV_QUERY[body].get(k) if v is not None else None, 'body': body})
    return toks


# ------------------------------------------------------------------ scoring
def ceilings(body, P):
    """per use: C_meas (measured Earth values only), C_est (with allowed estimates); per property: share within tolerance."""
    Pm = props(body, scoring=True)
    out = {'uses': {}, 'properties': {}}
    for u in S.USES:
        Am, used = S.use_score(P, Pm, u, allow_estimates=False)
        if Am is None:
            continue
        Ae, _ = S.use_score(P, Pm, u, allow_estimates=True)
        out['uses'][u] = {'properties': used, 'C_meas': round(float(Am.max()), 4), 'C_est': round(float(Ae.max()), 4)}
    for k in CHEM + PHYS:
        q = P.get(k)
        if q is None:
            continue
        d = Pm[k]; m = d['src'] == 1
        within = int((np.abs(d['value'][m] - q) <= S.TOL[k]).sum())
        out['properties'][k] = {'measured_windows': int(m.sum()), 'within_tol': within,
                                'share_within': round(within / max(int(m.sum()), 1), 5),
                                'verdict': 'met' if within else 'earth_cannot_supply'}
    return out


def use_scores_all(body, P, use, weights=None):
    A, used = S.use_score(P, props(body, scoring=True), use, weights)
    return A, used


def comparison(body, P, i, ceil, weights=None):
    """ComparisonTokens and use scores of Earth window i against the query."""
    Pm = props(body, scoring=True)
    D = props(body, scoring=False)
    toks = []
    for k in CHEM + PHYS:
        q = P.get(k)
        if q is None:
            continue
        d = D[k]
        src_show = int(d['src'][i]); src_score = int(Pm[k]['src'][i])
        ev = float(d['value'][i]) if np.isfinite(d['value'][i]) else None
        lo, hi = float(d['lo'][i]), float(d['hi'][i])
        p = float(S.p_match(q, np.array([ev if ev is not None else np.nan]), np.array([lo]), np.array([hi]),
                            np.array([src_score]), S.TOL[k])[0]) if src_score else 0.0
        if src_show == 0 or ev is None:
            verdict = 'unknown'
        elif src_score == 0:
            verdict = 'not_scored'
        else:
            verdict = 'met' if p >= 0.5 else 'partial' if p > 0.05 else 'not_met'
        cm = ceil['properties'].get(k, {}).get('within_tol')
        if cm == 0 and verdict != 'met':
            verdict = 'earth_cannot_supply'
        toks.append({'id': k, 'label': {'zh': S.LABEL[k][0], 'en': S.LABEL[k][1]}, 'unit': S.UNIT[k],
                     'query_value': round(float(q), 4), 'earth_value': None if ev is None else round(ev, 4),
                     'earth_interval90': [round(lo, 4), round(hi, 4)] if src_show == 2 else None,
                     'earth_source': {1: 'measured', 2: 'estimated', 0: 'missing'}[src_show],
                     'delta': None if ev is None else round(ev - float(q), 4), 'tolerance': S.TOL[k], 'p_match': round(p, 4),
                     'scored': bool(src_score), 'verdict': verdict,
                     'ceiling_meas': None if cm is None else (1 if cm else 0),
                     'earth_share_within': ceil['properties'].get(k, {}).get('share_within'),
                     'earth_within': cm, 'earth_measured': ceil['properties'].get(k, {}).get('measured_windows')})
    uses = {}
    for u in S.USES:
        A, used = S.use_score(P, {k: {f: v[i:i + 1] for f, v in Pm[k].items()} for k in Pm}, u)
        if A is not None:
            uses[u] = {'score': round(float(A[0]), 4), 'ceiling_meas': ceil['uses'].get(u, {}).get('C_meas'),
                       'weights': {k: S.USES[u][k] for k in used}}
    return {'window_index': int(i), 'tokens': toks, 'uses': uses}


def summary(body, lat, lon, km, grid=None):
    P = query_properties(body, lat, lon, km, grid)
    ceil = ceilings(body, P)
    E = earth()
    return {'version': VERSION, 'query_tokens': query_tokens(body, P), 'query_values': P, 'ceilings': ceil,
            'uses_definition': {u: {'weights': w, 'tolerances': {k: S.TOL[k] for k in w}} for u, w in S.USES.items()},
            'condition_only_uses': S.CONDITION_USES,
            'estimates_in_scoring': {k: E['allow'][(body, k)] for k in CHEM},
            'evaluation': {'p7b_envelope': 'estimates only within 300 km of measurements (p7b Part A pass)',
                           'p8_protocol_sha256': E['p8_sha']}}


def analog(body, lat, lon, km, use, weights=None, grid=None, top=30):
    """ranked Earth windows by use score (ties broken by index); grouped at 60 km."""
    P = query_properties(body, lat, lon, km, grid)
    ceil = ceilings(body, P)
    A, used = use_scores_all(body, P, use, weights)
    if A is None:
        return {'version': VERSION, 'use': use, 'available': False, 'reason': 'query has none of this use\'s properties'}
    E = earth()
    order = np.argsort(-A, kind='stable')
    reps, la, lo = [], [], []
    for i in order[:5000]:
        if la:
            d = 2 * 6371.0 * np.arcsin(np.sqrt(np.clip(np.sin(np.radians(E['lat'][i] - np.array(la)) / 2) ** 2 + np.cos(np.radians(E['lat'][i])) *
                                                       np.cos(np.radians(la)) * np.sin(np.radians(E['lon'][i] - np.array(lo)) / 2) ** 2, 0, 1)))
            if (d < 60.0).any():
                continue
        reps.append(int(i)); la.append(float(E['lat'][i])); lo.append(float(E['lon'][i]))
        if len(reps) == top:
            break
    return {'version': VERSION, 'use': use, 'available': True, 'properties': used, 'query_tokens': query_tokens(body, P),
            'ceilings': ceil, 'candidates': [dict(comparison(body, P, i, ceil, weights), lat=round(float(E['lat'][i]), 4),
                                                  lon=round(float(E['lon'][i]), 4), absolute_score=round(float(A[i]), 4)) for i in reps]}
