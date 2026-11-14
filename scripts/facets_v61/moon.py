"""Facets v6.1, Moon query side: measured values for a lunar window from LRO (Diviner, LOLA illumination, Mini-RF) and Lunar
Prospector (hydrogen). Every function returns plain numbers or None; nothing here is a threshold."""
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'data/research/facets_v61'
SRC = DATA / 'sources'
R_MOON = 1737400.0


def window_points(lat, lon, km, n=9):
    half = km / 2 / (math.pi * R_MOON / 1000 / 180)
    off = np.linspace(-half, half, n)
    dy, dx = np.meshgrid(off, off, indexing='ij')
    la = np.clip(lat + dy, -89.999, 89.999)
    lo = lon + dx / max(math.cos(math.radians(lat)), 0.02)
    return la.ravel(), ((lo.ravel() + 180) % 360) - 180


@lru_cache(maxsize=1)
def diviner_global():
    z = np.load(DATA / 'moon_diviner_05deg.npz')
    return {k: z[k] for k in z.files}


@lru_cache(maxsize=1)
def diviner_polar():
    z = np.load(DATA / 'moon_diviner_polar_01deg.npz')
    return {k: z[k] for k in z.files}


@lru_cache(maxsize=2)
def visibility(pole):
    """LOLA average Sun visibility, polar stereographic 240 m (PGDA, Mazarico et al. 2011)."""
    a = np.memmap(SRC / f'AVGVISIB_{pole}_240M_201608.IMG', dtype='<i2', mode='r', shape=(6420, 6420))
    return a


@lru_cache(maxsize=1)
def minirf():
    return np.memmap(SRC / 'global_cpr_32ppd_simp_0c.img', dtype='<f4', mode='r', shape=(5760, 11520))


@lru_cache(maxsize=1)
def hydrogen():
    rows = []
    for line in open(SRC / 'lp_hydrogenhd.txt', encoding='ascii', errors='ignore'):
        if line.startswith('#') or not line.strip():
            continue
        parts = [x.strip() for x in line.split(',')]
        try:
            rows.append([float(x) for x in parts[:4]] + [float(parts[4]) if '*' not in parts[4] else np.nan])
        except ValueError:
            continue
    a = np.array(rows)
    g = np.full((360, 720), np.nan, np.float32)
    r = np.clip(((90 - a[:, 1]) / 0.5).astype(int), 0, 359); c = np.clip(((a[:, 2] + 180) / 0.5).astype(int), 0, 719)
    g[r, c] = a[:, 4]
    return g


def _nanstat(v, fn):
    v = np.asarray(v, np.float64)
    v = v[np.isfinite(v)]
    return float(fn(v)) if v.size >= 3 else None


def thermal(lat, lon, km):
    """Diviner bolometric temperature over the window: diurnal mean, maximum and minimum (K)."""
    d = diviner_global()
    la, lo = window_points(lat, lon, max(km, 40.0))
    r = np.clip(((90 - la) / 0.5).astype(int), 0, 359); c = np.clip(((lo + 180) / 0.5).astype(int), 0, 719)
    mean, mx, mn = d['tbol_mean'][r, c], d['tbol_max'][r, c], d['tbol_min'][r, c]
    if np.isfinite(mean).sum() < 3:
        return None
    return {'mean_k': round(float(np.nanmean(mean)), 1), 'max_k': round(float(np.nanmax(mx)), 1), 'min_k': round(float(np.nanmin(mn)), 1),
            'source': 'LRO Diviner global cumulative product'}


def polar(lat, lon, km):
    """poleward of 60 deg: Diviner ice stability and LOLA Sun visibility over the window."""
    if abs(lat) < 60:
        return None
    pole = 'north' if lat > 0 else 'south'
    la, lo = window_points(lat, lon, km, n=15)
    out = {'pole': pole}
    try:
        d = diviner_polar()
    except FileNotFoundError:
        d = None
    if d is not None:
        rr = np.clip(np.floor((90 - np.abs(la)) / 0.1).astype(int), 0, 299); cc = np.clip(np.floor((lo + 180) / 0.1).astype(int), 0, 3599)
        share = d[f'{pole}_ice_share_1m'][rr, cc]; tavg = d[f'{pole}_t_avg'][rr, cc]; depth = d[f'{pole}_ice_depth_min'][rr, cc]
    if d is not None and np.isfinite(share).any():
        out.update(ice_stable_1m_share=round(float(np.nanmean(share)), 4), annual_mean_k=round(float(np.nanmean(tavg)), 1),
                   ice_depth_min_m=None if not np.isfinite(depth).any() else round(float(np.nanmin(depth)), 3))
    if abs(lat) >= 65:
        vis = visibility('65N' if lat > 0 else '65S')
        rho = 2 * R_MOON * np.tan(np.radians(90 - np.abs(la)) / 2)
        lam = np.radians(lo)
        x = rho * np.sin(lam)
        y = rho * np.cos(lam) * (1 if lat < 0 else -1)
        line = np.round(3209.5 - y / 240.0).astype(int); samp = np.round(3209.5 + x / 240.0).astype(int)
        ok = (line >= 0) & (line < 6420) & (samp >= 0) & (samp < 6420)
        v = np.asarray(vis[line[ok], samp[ok]], np.float64) * 0.00004
        if v.size:
            out.update(sun_visibility_mean=round(float(v.mean()), 4), permanent_shadow_share=round(float((v <= 0.0).mean()), 4))
    out['source'] = 'LRO Diviner polar resource product; LOLA average Sun visibility'
    return out


def radar(lat, lon, km):
    """Mini-RF S-band circular polarisation ratio over the window: median and 90th percentile."""
    a = minirf()
    la, lo = window_points(lat, lon, km, n=21)
    r = np.clip(np.round(2880.5 - la * 32 - 1).astype(int), 0, 5759); c = np.clip(np.round(5760.5 + lo * 32 - 1).astype(int), 0, 11519)
    v = np.asarray(a[r, c], np.float64)
    v = v[np.isfinite(v) & (v > -1e30) & (v >= 0) & (v < 5)]
    if v.size < 20:
        return None
    return {'cpr_median': round(float(np.median(v)), 3), 'cpr_p90': round(float(np.percentile(v, 90)), 3), 'samples': int(v.size),
            'source': 'LRO Mini-RF global CPR mosaic (S band, 12.6 cm)'}


def hydrogen_ppm(lat, lon, km):
    g = hydrogen()
    la, lo = window_points(lat, lon, max(km, 60.0), n=5)
    r = np.clip(((90 - la) / 0.5).astype(int), 0, 359); c = np.clip(((lo + 180) / 0.5).astype(int), 0, 719)
    v = g[r, c]
    return None if not np.isfinite(v).any() else round(float(np.nanmean(v)), 1)


def summary(lat, lon, km):
    out = {}
    for k, fn in (('thermal', thermal), ('polar', polar), ('radar', radar)):
        try:
            out[k] = fn(lat, lon, km)
        except FileNotFoundError:
            out[k] = None
    try:
        out['hydrogen_ppm'] = hydrogen_ppm(lat, lon, km)
    except FileNotFoundError:
        out['hydrogen_ppm'] = None
    return out
