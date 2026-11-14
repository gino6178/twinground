"""Atlas-Match features (v1): the same physical quantity, in the same unit, on both sides of the match.

Earth side: the 75,860 searchable 40 km windows of the live service (its own index and terrain encoder).
Query side: a Moon or Mars 40 km window read from orbital data, with the same operation as on Earth where one exists
(terrain encoder and 1.85 km roughness on the DEM window).

Facets and features (units):
  terrain    24-D terrain-encoder vector (same frozen encoder both sides) + median slope at 1.85 km (deg)
  chemistry  FeO, TiO2, K (wt%), Th (ppm)   Moon: Lunar Prospector; Mars: Odyssey GRS (no TiO2); Earth: measured or
             in-envelope estimates at the query's support (40 km window for the Moon, 220 km footprint for Mars)
  thermal    surface temperature mean, maximum, minimum (K)   Moon: Diviner; Mars: MCD; Earth: MODIS LST normals
  ice        share of the window with ground ice near the surface (0-1)   Moon: Diviner ice stable within 1 m
             (0 equatorward of 60 deg); Mars: SWIM 0-1 m consistency >= 0.25 (1 poleward of 60 deg); Earth: CCI permafrost
  dust       aerosol optical depth (1) and wind (m/s)   Mars: MCD; Earth: NASA POWER          (Mars only)
  albedo     broadband albedo (1)   Mars: TES; Earth: GLASS snow-free                          (Mars only)
Earth-only variables (access, mines, karst) are not features; the Moon has no atmosphere, so no dust facet."""
import math
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
for _p in (ROOT / 'src', ROOT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))
OUT = ROOT / 'data/research/atlas_match'
KM = 40
EMB = [f'emb{i:02d}' for i in range(24)]
FACETS = {'terrain': EMB + ['roughness'], 'chemistry': ['feo', 'tio2', 'k', 'th'], 'thermal': ['t_mean', 't_max', 't_min'],
          'ice': ['ice_frac'], 'dust': ['dust_tau', 'wind'], 'albedo': ['albedo']}
BODY_FACETS = {'moon': ['terrain', 'chemistry', 'thermal', 'ice'],
               'mars': ['terrain', 'chemistry', 'thermal', 'ice', 'dust', 'albedo']}
FEATURES = [f for v in FACETS.values() for f in v]
COL = {f: i for i, f in enumerate(FEATURES)}
CHEM = ['feo', 'tio2', 'k', 'th']
SUPPORT = {'moon': 'window', 'mars': 'foot220'}


@lru_cache(maxsize=1)
def ws():
    """Search resources shared with the running web server (loaded once per process)."""
    from types import SimpleNamespace
    from lunar_pipeline import embed, moon_patch
    from mars_global import patch_at as mars_patch_at
    from server.resources import resources
    model, _sites, rows, scale_data, _report = resources()
    W = SimpleNamespace(embed=embed, moon_patch=moon_patch, mars_patch_at=mars_patch_at)
    return W, model, rows, scale_data


def build_earth():
    W, model, rows, scale_data = ws()
    from scripts.physmatch_v5 import service as pm
    ri, vec = scale_data[KM]
    ri = np.asarray(ri)
    n = len(ri)
    ids = np.array([rows[int(i)]['id'] for i in ri])
    lat = np.array([rows[int(i)]['center']['latitude'] for i in ri], np.float64)
    lon = np.array([rows[int(i)]['center']['longitude_east'] for i in ri], np.float64)
    X = np.full((n, len(FEATURES)), np.nan, np.float32)
    X[:, :24] = np.asarray(vec, np.float32)
    E = pm.earth()
    j = pm.scale_map(KM, rows, ri)
    ok = j >= 0

    def take(key, dtype=np.float32, fill=np.nan):
        out = np.full(n, fill, dtype)
        out[ok] = E[key][j[ok]]
        return out

    X[:, COL['roughness']] = take('window_roughness_value')
    X[:, COL['albedo']] = take('window_albedo_value')
    chem = {}
    for sup in ('window', 'foot220'):
        for k in CHEM:
            v, s = take(f'{sup}_{k}_value'), take(f'{sup}_{k}_src', np.int8, 0)
            chem[f'{sup}_{k}'] = np.where(s > 0, v, np.nan).astype(np.float32)
            chem[f'{sup}_{k}_src'] = s
    z61 = np.load(ROOT / 'data/research/facets_v61/earth_facets_v61.npz')
    pos61 = {s: i for i, s in enumerate(z61['ids'].tolist())}
    p = np.array([pos61.get(s, -1) for s in ids.tolist()])
    m = p >= 0
    for f, k in (('t_mean', 'lst_mean_k'), ('t_max', 'lst_day_max_k'), ('t_min', 'lst_night_min_k'), ('ice_frac', 'permafrost_frac')):
        X[m, COL[f]] = z61[k][p[m]]
    # CCI permafrost maps permafrost only: a gap is "no permafrost", except south of 60 S, which the product does not cover
    ice = X[:, COL['ice_frac']]
    X[:, COL['ice_frac']] = np.where(np.isfinite(ice), ice, np.where(lat < -60, np.nan, 0.0))
    z6 =np.load(ROOT / 'data/research/facets_v6/earth_facets.npz')
    pos6 = {s: i for i, s in enumerate(z6['ids'].tolist())}
    p6 = np.array([pos6.get(s, -1) for s in ids.tolist()])
    m6 = p6 >= 0
    for f, k in (('dust_tau', 'aod'), ('wind', 'wind_ms')):
        X[m6, COL[f]] = z6[k][p6[m6]]
    OUT.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(OUT / 'earth_40km.npz', ids=ids, lat=lat, lon=lon, X=X, features=np.array(FEATURES),
                        row_indices=ri, **chem)
    rep = {f: {'finite': int(np.isfinite(X[:, COL[f]]).sum()), 'p01': float(np.nanpercentile(X[:, COL[f]], 1)),
               'p50': float(np.nanpercentile(X[:, COL[f]], 50)), 'p99': float(np.nanpercentile(X[:, COL[f]], 99))}
           for f in FEATURES if not f.startswith('emb')}
    for sup in ('window', 'foot220'):
        for k in CHEM:
            rep[f'{sup}_{k}'] = {'finite': int(np.isfinite(chem[f'{sup}_{k}']).sum()),
                                 'measured': int((chem[f'{sup}_{k}_src'] == 1).sum())}
    return rep


@lru_cache(maxsize=2)
def earth(body):
    """Earth feature matrix for a query of `body` (chemistry at that body's support), plus measured-only chemistry."""
    z = np.load(OUT / 'earth_40km.npz')
    X = z['X'].copy()
    sup = SUPPORT[body]
    meas = {}
    for k in CHEM:
        X[:, COL[k]] = z[f'{sup}_{k}']
        meas[k] = np.where(z[f'{sup}_{k}_src'] == 1, z[f'{sup}_{k}'], np.nan)
    return {'X': X, 'lat': z['lat'], 'lon': z['lon'], 'ids': z['ids'], 'row_indices': z['row_indices'], 'measured_chem': meas}


@lru_cache(maxsize=1)
def _swim01():
    from scripts.conditions_v1 import service as cs
    return cs.swim()['0_1']


def query(body, lat, lon):
    """feature vector of a Moon or Mars 40 km window (NaN where a quantity is not observed)."""
    W, model, _rows, _sd = ws()
    from scripts.physmatch_v5 import service as pm
    lat, lon = float(lat), float(lon)
    grid = W.mars_patch_at(lat, lon, KM) if body == 'mars' else W.moon_patch(lat, lon, patch_km=KM)
    x = np.full(len(FEATURES), np.nan, np.float32)
    x[:24] = np.asarray(W.embed(model, grid), np.float32)
    r = pm._roughness(grid, KM)
    x[COL['roughness']] = np.nan if r is None else r
    P = pm._query_values(body, round(lat, 4), round(lon, 4), KM)
    for k in CHEM:
        v = P.get(k)
        x[COL[k]] = np.nan if v is None or body == 'mars' and k == 'tio2' else v
    if body == 'moon':
        from scripts.facets_v61 import moon as M
        t = M.thermal(lat, lon, KM)
        if t:
            x[COL['t_mean']], x[COL['t_max']], x[COL['t_min']] = t['mean_k'], t['max_k'], t['min_k']
        if abs(lat) >= 60:
            pol = M.polar(lat, lon, KM) or {}
            s = pol.get('ice_stable_1m_share')
            x[COL['ice_frac']] = np.nan if s is None else s
        else:
            x[COL['ice_frac']] = 0.0
    else:
        from scripts.facets_v7 import service as V7
        m = V7.mars_climate()
        i = int(np.argmin(np.abs(m['lat'] - lat)))
        j = int(np.argmin(np.abs(((m['lon'] - lon + 180) % 360) - 180)))
        x[COL['t_mean']], x[COL['t_max']], x[COL['t_min']] = m['t_mean_k'][i, j], m['t_max_k'][i, j], m['t_min_k'][i, j]
        x[COL['dust_tau']], x[COL['wind']] = m['dust_tau'][i, j], m['wind_ms'][i, j]
        if P.get('albedo') is not None:
            x[COL['albedo']] = P['albedo']
        if abs(lat) > 60:
            x[COL['ice_frac']] = 1.0
        else:
            la, lo = pm._window_points(lat, lon, 'mars', KM)
            s = _swim01()
            rr = np.clip(((60 - la) / 0.05).astype(int), 0, s.shape[0] - 1)
            cc = np.clip(((lo + 180) / 0.05).astype(int), 0, s.shape[1] - 1)
            v = s[rr, cc]
            x[COL['ice_frac']] = float((v[np.isfinite(v)] >= 0.25).mean()) if np.isfinite(v).any() else np.nan
    return x


def random_queries(body, n, seed):
    """n window centres drawn uniformly on the sphere within |lat| <= 85 deg."""
    rng = np.random.default_rng(seed)
    zmax = math.sin(math.radians(85))
    lat = np.degrees(np.arcsin(rng.uniform(-zmax, zmax, n)))
    lon = rng.uniform(-180, 180, n)
    return [(round(float(a), 4), round(float(o), 4)) for a, o in zip(lat, lon)]
