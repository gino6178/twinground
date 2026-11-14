"""Query-side surface material for Mars and Moon windows, as within-body percentiles on shared physical axes.

Axes (all 0..1 within-body percentiles of the window mean):
  albedo   Mars OMEGA R1080 / Moon LROC WAC 643 nm
  ferric   Mars OMEGA BD530 (nanophase/crystalline ferric oxides)            [Moon: not applicable]
  mafic    Mars max(OMEGA pyroxene BD2000, olivine OSP1) / Moon Lunar Prospector FeO
  hydrated Mars: OMEGA/CRISM hydrous detection inside the window (flag)     [Moon: not applicable]
Dust: Mars windows that are bright AND ferric (OMEGA albedo percentile >= 0.75 and ferric percentile >= 0.6; rule fixed
before any evaluation) are treated as dust-mantled, so their spectra show dust rather than bedrock; the bedrock mafic
level is then INFERRED from dark, dust-poor windows (albedo percentile <= 0.4) within 600 km (inverse-distance mean),
the same occlusion idea used for vegetated Earth windows. (The JMARS TES dust layer we hold is not the published DCI
scale, so it is not used.)

  python -m scripts.material_v5.material_query --reference   # build reference distributions (once)"""
import json
import math
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))
DATA = ROOT / 'data/research/material_v5'
REF = DATA / 'query_reference.npz'
MARS_KM_PER_DEG = 3389.5 * math.pi / 180
MOON_KM_PER_DEG = 1737.4 * math.pi / 180
DUST_ALBEDO, DUST_FERRIC, CLEAN_ALBEDO = 0.75, 0.6, 0.4
SEED = 20261018


@lru_cache(maxsize=1)
def mars_layers():
    d = np.load(DATA / 'mars_material_4ppd.npz')
    return {k: d[k] for k in d.files}


def _box(lat, lon, km, ppd, rows, cols, km_per_deg):
    half_lat = km / 2 / km_per_deg
    half_lon = half_lat / max(math.cos(math.radians(lat)), 0.1)
    r0, r1 = int(math.floor((90 - lat - half_lat) * ppd)), int(math.ceil((90 - lat + half_lat) * ppd))
    c0, c1 = int(math.floor((lon + 180 - half_lon) * ppd)), int(math.ceil((lon + 180 + half_lon) * ppd))
    rr = np.arange(max(0, r0), min(rows, max(r1, r0 + 1)))
    cc = np.arange(c0, max(c1, c0 + 1)) % cols
    return rr, cc


def mars_raw(lat, lon, km):
    L = mars_layers()
    rr, cc = _box(lat, lon, km, 4, 720, 1440, MARS_KM_PER_DEG)
    out = {}
    for k in ('albedo_r1080', 'ferric_bd530', 'pyroxene_bd2000', 'olivine_osp1'):
        v = L[k][np.ix_(rr, cc)]
        out[k] = float(np.nanmean(v)) if np.isfinite(v).any() else None
    out['hydrous_count'] = float(L['hydrous_count'][np.ix_(rr, cc)].sum())
    return out


@lru_cache(maxsize=1)
def moon_layers():
    from scripts.lavatube_c2f.coarse_data import wac_mosaic
    sys.path.insert(0, str(ROOT / 'src'))
    from lunar_pipeline import lunar_prospector_maps
    iron, _ = lunar_prospector_maps()
    return wac_mosaic(), iron  # WAC: 70N-70S at 76 ppd; FeO: 0.5 deg, south-to-north


def moon_raw(lat, lon, km):
    wac, iron = moon_layers()
    out = {'albedo_wac643': None, 'feo_wt': None}
    if abs(lat) + km / 2 / MOON_KM_PER_DEG < 70:
        half_lat = km / 2 / MOON_KM_PER_DEG
        half_lon = half_lat / max(math.cos(math.radians(lat)), 0.1)
        r0, r1 = int((70 - lat - half_lat) * 76), int((70 - lat + half_lat) * 76) + 1
        cc = np.arange(int(((lon % 360) - half_lon) * 76), int(((lon % 360) + half_lon) * 76) + 1) % wac.shape[1]
        v = wac[max(0, r0):r1][:, cc].astype(np.float32)
        v = v[v > 0]
        out['albedo_wac643'] = float(v.mean() / 2048) if v.size else None
    half = km / 2 / MOON_KM_PER_DEG
    ys = np.clip(np.floor((lat + np.linspace(-half, half, 5) + 90) * 2).astype(int), 0, 359)
    xs = np.floor(((lon + np.linspace(-half, half, 5) / max(math.cos(math.radians(lat)), 0.1) + 180) % 360) * 2).astype(int) % 720
    out['feo_wt'] = float(np.median(iron[np.ix_(ys, xs)]))
    return out


def build_reference(n=20000):
    rng = np.random.default_rng(SEED)
    ref = {}
    for km in (20, 40, 80):
        lat = np.degrees(np.arcsin(rng.uniform(-math.sin(math.radians(65)), math.sin(math.radians(65)), n)))
        lon = rng.uniform(-180, 180, n)
        mars = [mars_raw(a, b, km) for a, b in zip(lat, lon)]
        for k in ('albedo_r1080', 'ferric_bd530', 'pyroxene_bd2000', 'olivine_osp1'):
            v = np.array([m[k] for m in mars if m[k] is not None], np.float64)
            ref[f'mars_{k}_{km}'] = np.sort(v[np.isfinite(v)])
        ref[f'mars_points_{km}'] = np.stack([lat, lon], 1)
        ref[f'mars_axes_{km}'] = np.array([[_pct(ref[f'mars_albedo_r1080_{km}'], m['albedo_r1080']), _pct(ref[f'mars_ferric_bd530_{km}'], m['ferric_bd530']),
                                           max(_pct(ref[f'mars_pyroxene_bd2000_{km}'], m['pyroxene_bd2000']), _pct(ref[f'mars_olivine_osp1_{km}'], m['olivine_osp1']))]
                                          for m in mars], np.float32)
        moon = [moon_raw(a, b, km) for a, b in zip(lat[:8000], lon[:8000])]
        for k in ('albedo_wac643', 'feo_wt'):
            v = np.array([m[k] for m in moon if m[k] is not None], np.float64)
            ref[f'moon_{k}_{km}'] = np.sort(v[np.isfinite(v)])
        print(json.dumps({'km': km, 'mars_valid': {k: len(ref[f'mars_{k}_{km}']) for k in ('albedo_r1080', 'ferric_bd530', 'pyroxene_bd2000', 'olivine_osp1')},
                          'moon_valid': {k: len(ref[f'moon_{k}_{km}']) for k in ('albedo_wac643', 'feo_wt')}}), flush=True)
    np.savez_compressed(REF, **ref)


def _pct(sorted_values, x):
    if x is None or not np.isfinite(x) or len(sorted_values) == 0:
        return float('nan')
    return float(np.searchsorted(sorted_values, x) / len(sorted_values))


@lru_cache(maxsize=1)
def reference():
    d = np.load(REF)
    return {k: d[k] for k in d.files}


def _scale(km):
    return min((20, 40, 80), key=lambda s: abs(s - km))


def mars_descriptor(lat, lon, km):
    ref, s = reference(), _scale(km)
    raw = mars_raw(lat, lon, km)
    pct = lambda k: _pct(ref[f'mars_{k}_{s}'], raw[k])
    axes = {'albedo': pct('albedo_r1080'), 'ferric': pct('ferric_bd530'),
            'mafic': np.nanmax([pct('pyroxene_bd2000'), pct('olivine_osp1')]) if np.isfinite([pct('pyroxene_bd2000'), pct('olivine_osp1')]).any() else float('nan')}
    dusty = bool(np.isfinite(axes['albedo']) and np.isfinite(axes['ferric']) and axes['albedo'] >= DUST_ALBEDO and axes['ferric'] >= DUST_FERRIC)
    out = {'body': 'mars', 'raw': raw, 'axes': {k: (None if not np.isfinite(v) else round(float(v), 3)) for k, v in axes.items()},
           'hydrated': raw['hydrous_count'] > 0, 'dusty': dusty, 'inferred': {}}
    if dusty or not np.isfinite(axes['mafic']):
        pts, ax = ref[f'mars_points_{s}'], ref[f'mars_axes_{s}']
        clean = (ax[:, 0] <= CLEAN_ALBEDO) & np.isfinite(ax[:, 2])
        p1, p2 = math.radians(lat), np.radians(pts[clean, 0])
        dl = np.radians(pts[clean, 1] - lon)
        d = 2 * 3389.5 * np.arcsin(np.sqrt(np.clip(np.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2, 0, 1)))
        near = d < 600
        if near.sum() >= 3:
            w = 1 / np.maximum(d[near], 30) ** 2
            out['inferred']['bedrock_mafic'] = round(float((ax[clean][near, 2] * w).sum() / w.sum()), 3)
            out['inferred']['neighbours'] = int(near.sum())
            out['inferred']['rule'] = 'dark dust-poor windows (OMEGA albedo percentile <= 0.4) within 600 km, inverse-distance-squared mean'
    return out


def moon_descriptor(lat, lon, km):
    ref, s = reference(), _scale(km)
    raw = moon_raw(lat, lon, km)
    axes = {'albedo': _pct(ref[f'moon_albedo_wac643_{s}'], raw['albedo_wac643']), 'mafic': _pct(ref[f'moon_feo_wt_{s}'], raw['feo_wt'])}
    return {'body': 'moon', 'raw': raw, 'axes': {k: (None if not np.isfinite(v) else round(float(v), 3)) for k, v in axes.items()},
            'hydrated': False, 'dusty': False, 'inferred': {}}


def target_axes(desc):
    """Axes the Earth match is scored on, with weights. Dust-mantled Mars uses the inferred bedrock mafic level."""
    a = dict(desc['axes'])
    if desc.get('dusty') and 'bedrock_mafic' in desc.get('inferred', {}):
        a['mafic'] = desc['inferred']['bedrock_mafic']
    t = {k: v for k, v in a.items() if v is not None}
    w = {k: 1.0 for k in t}
    if desc.get('hydrated'):
        t['hydroxyl'] = 0.85; w['hydroxyl'] = 1.0
    t['dryness'] = 1.0; w['dryness'] = 0.5  # both bodies are hyper-arid: prefer the driest Earth windows
    return t, w


if __name__ == '__main__':
    if '--reference' in sys.argv:
        build_reference()
    else:
        print(json.dumps(mars_descriptor(18.0, 77.0, 40), default=str))
