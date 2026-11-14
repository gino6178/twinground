"""High-resolution DEM square for the astronaut explorer (central EXTENT of the selected window).

The explorer used to rebuild the ground only from the 64 x 64 search grid (635 m cells for a 40 km window), so the real
landform was smoothed away at walking scale. This module returns a denser DEM for the central square:
  Earth  Copernicus GLO-30 (30 m, AWS COG)
  Moon   SLDEM2015 512 ppd (~59 m, LOLA + Kaguya TC, PDS Geosciences; per-row HTTP byte ranges, |lat| <= 60)
  Mars   HRSC-MOLA blended DEM v2 (200 m, USGS Astrogeology, GDAL /vsicurl window read)
Samples follow the explorer grid: row 0 = north, column 0 = west, on the same tangent-plane square as the search
patch. Results are cached on disk; at most two fetches run at once."""
import base64
import hashlib
import json
import math
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from scipy.ndimage import map_coordinates

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'data/research/explore_dem_cache'
EXTENT_KM = 16.0
RADIUS_KM = {'earth': 6371.0, 'moon': 1737.4, 'mars': 3396.19}
CELL_M = {'earth': 40.0, 'moon': 59.0, 'mars': 200.0}
MAX_N = 401
_SLOTS = threading.BoundedSemaphore(2)
UA = {'User-Agent': 'AnalogAtlas/1.0 (NASA Space Apps 2026)'}
GLO30 = 'https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{ns}{lat:02d}_00_{ew}{lon:03d}_00_DEM/Copernicus_DSM_COG_10_{ns}{lat:02d}_00_{ew}{lon:03d}_00_DEM.tif'
SLDEM = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/sldem2015/tiles/float_img/sldem2015_512_{band}_{l0:03d}_{l1:03d}_float.img'
MARS_BLEND = 'https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif'
GDAL_ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='60', GDAL_HTTP_MAX_RETRY='3', GDAL_HTTP_RETRY_DELAY='2',
                CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif', GDAL_CACHEMAX=256)


def grid_latlon(body, lat, lon, extent_km, n):
    """Tangent-plane square (same construction as the search patches): row 0 north, column 0 west."""
    R = RADIUS_KM[body]
    lat0, lon0 = math.radians(lat), math.radians(lon)
    center = np.array([math.cos(lat0) * math.cos(lon0), math.sin(lat0), math.cos(lat0) * math.sin(lon0)])
    east = np.array([-math.sin(lon0), 0.0, math.cos(lon0)])
    north = np.array([-math.sin(lat0) * math.cos(lon0), math.cos(lat0), -math.sin(lat0) * math.sin(lon0)])
    ex, ny = np.meshgrid(np.linspace(-extent_km / 2, extent_km / 2, n), np.linspace(extent_km / 2, -extent_km / 2, n))
    rho = np.hypot(ex, ny)
    theta = rho / R
    tangent = ex[..., None] * east + ny[..., None] * north
    unit = center * np.cos(theta)[..., None] + tangent * (np.sin(theta) / np.maximum(rho, 1e-9))[..., None]
    return np.degrees(np.arcsin(np.clip(unit[..., 1], -1, 1))), np.degrees(np.arctan2(unit[..., 2], unit[..., 0]))


def _earth(lats, lons):
    import rasterio
    from rasterio.windows import from_bounds
    out = np.full(lats.shape, np.nan, np.float32)
    with rasterio.Env(**GDAL_ENV):
        for tlat in range(math.floor(lats.min()), math.floor(lats.max()) + 1):
            for tlon in range(math.floor(lons.min()), math.floor(lons.max()) + 1):
                url = GLO30.format(ns='N' if tlat >= 0 else 'S', lat=abs(tlat), ew='E' if tlon >= 0 else 'W', lon=abs(tlon))
                sel = (lats >= tlat) & (lats < tlat + 1) & (lons >= tlon) & (lons < tlon + 1)
                if not sel.any():
                    continue
                try:
                    with rasterio.open(url) as src:
                        pad = 3 * abs(src.res[0])
                        win = from_bounds(max(tlon, lons[sel].min() - pad), max(tlat, lats[sel].min() - pad),
                                          min(tlon + 1, lons[sel].max() + pad), min(tlat + 1, lats[sel].max() + pad), src.transform)
                        win = win.round_offsets().round_lengths()
                        a = src.read(1, window=win, boundless=False).astype(np.float32)
                        t = src.window_transform(win)
                except Exception:  # noqa: BLE001 - ocean tiles do not exist
                    continue
                rows = (lats[sel] - t.f) / t.e - 0.5
                cols = (lons[sel] - t.c) / t.a - 0.5
                out[sel] = map_coordinates(a, [rows, cols], order=1, mode='nearest')
    return out, 'Copernicus DEM GLO-30 (30 m)', ('produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space '
                                                 'GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved')


def _moon(lats, lons):
    if np.abs(lats).max() > 59.9:
        raise ValueError('SLDEM2015 covers 60S-60N only')
    res, width = 512, 23040
    lon360 = lons % 360
    out = np.full(lats.shape, np.nan, np.float32)
    bands = [(-60, -30, '60s_30s'), (-30, 0, '30s_00s'), (0, 30, '00n_30n'), (30, 60, '30n_60n')]
    jobs = []
    for lat_lo, lat_hi, band in bands:
        for l0 in range(0, 360, 45):
            sel = (lats >= lat_lo) & (lats < lat_hi) & (lon360 >= l0) & (lon360 < l0 + 45)
            if not sel.any():
                continue
            r0 = max(0, int(math.floor((lat_hi - lats[sel].max()) * res)) - 2)
            r1 = min(15359, int(math.ceil((lat_hi - lats[sel].min()) * res)) + 2)
            c0 = max(0, int(math.floor((lon360[sel].min() - l0) * res)) - 2)
            c1 = min(width - 1, int(math.ceil((lon360[sel].max() - l0) * res)) + 2)
            jobs.append((SLDEM.format(band=band, l0=l0, l1=l0 + 45), lat_hi, l0, r0, r1, c0, c1, sel))
    for url, lat_hi, l0, r0, r1, c0, c1, sel in jobs:
        block = np.zeros((r1 - r0 + 1, c1 - c0 + 1), np.float32)

        def row(r):
            start = (r * width + c0) * 4
            req = urllib.request.Request(url, headers={**UA, 'Range': f'bytes={start}-{start + (c1 - c0 + 1) * 4 - 1}'})
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(req, timeout=60) as resp:
                        return r, np.frombuffer(resp.read(), '<f4')
                except Exception:  # noqa: BLE001
                    time.sleep(1 + attempt)
            raise IOError('SLDEM row read failed')
        with ThreadPoolExecutor(24) as pool:
            for r, data in pool.map(row, range(r0, r1 + 1)):
                block[r - r0] = data
        rows = (lat_hi - lats[sel]) * res - 0.5 - r0
        cols = (lon360[sel] - l0) * res - 0.5 - c0
        out[sel] = map_coordinates(block, [rows, cols], order=1, mode='nearest') * 1000.0  # km -> m above 1737.4 km
    return out, 'SLDEM2015 (LOLA + SELENE TC, 512 ppd, ~59 m)', 'Barker et al. (2016) Icarus 273, 346; NASA/GSFC LOLA team and JAXA/SELENE, PDS Geosciences'


def _mars(lats, lons):
    import rasterio
    from rasterio.windows import Window
    with rasterio.Env(**GDAL_ENV), rasterio.open('/vsicurl/' + MARS_BLEND) as src:
        inv = ~src.transform
        cols, rows = inv * (lons.ravel(), lats.ravel())
        cols, rows = np.asarray(cols).reshape(lats.shape), np.asarray(rows).reshape(lats.shape)
        r0, r1 = max(0, int(rows.min()) - 2), min(src.height - 1, int(rows.max()) + 3)
        c0, c1 = max(0, int(cols.min()) - 2), min(src.width - 1, int(cols.max()) + 3)
        a = src.read(1, window=Window(c0, r0, c1 - c0 + 1, r1 - r0 + 1)).astype(np.float32)
        a[a == src.nodata] = np.nan
    out = map_coordinates(a, [rows - r0 - 0.5, cols - c0 - 0.5], order=1, mode='nearest')
    return out, 'HRSC-MOLA blended DEM v2 (200 m)', 'Fergason, Hare & Laura (2018), USGS Astrogeology; ESA/DLR/FU Berlin HRSC and NASA/MGS MOLA'


def explore_dem(body, lat, lon, patch_km):
    if body not in RADIUS_KM:
        raise ValueError('body must be earth, moon or mars')
    if not (math.isfinite(lat) and math.isfinite(lon) and -89.5 <= lat <= 89.5):
        raise ValueError('invalid coordinate')
    extent = float(min(EXTENT_KM, patch_km))
    lon = ((lon + 180.0) % 360.0) - 180.0
    key = f'{body}_{lat:.4f}_{lon:.4f}_{extent:g}'
    path = CACHE / (hashlib.sha1(key.encode()).hexdigest()[:20] + '.json')
    if path.exists():
        return json.loads(path.read_text())
    n = int(min(MAX_N, round(extent * 1000 / CELL_M[body]) + 1))
    lats, lons = grid_latlon(body, lat, lon, extent, n)
    if not _SLOTS.acquire(timeout=30):
        raise RuntimeError('explorer DEM service busy')
    try:
        t0 = time.time()
        h, source, credit = {'earth': _earth, 'moon': _moon, 'mars': _mars}[body](lats, lons)
    finally:
        _SLOTS.release()
    ok = np.isfinite(h)
    if ok.mean() < 0.5:
        raise ValueError('high-resolution DEM does not cover this square')
    lo = float(np.nanmin(h))
    q = np.where(ok, np.clip(np.round((h - lo) * 10), 0, 65534), 65535).astype('<u2')
    result = {'available': True, 'body': body, 'n': n, 'extent_m': extent * 1000, 'cell_m': round(extent * 1000 / (n - 1), 2),
              'min_m': round(lo, 2), 'heights_dm_b64': base64.b64encode(q.tobytes()).decode('ascii'), 'nodata': 65535,
              'valid_fraction': round(float(ok.mean()), 4), 'source': source, 'credit': credit, 'seconds': round(time.time() - t0, 1),
              'layout': 'row 0 north, column 0 west; decimetres above min_m; 65535 = no data'}
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result))
    return result


if __name__ == '__main__':
    for args in [('earth', 43.42, -113.52, 40), ('moon', 8.3355, 33.222, 40), ('mars', 18.4, 77.5, 40)]:
        r = explore_dem(*args)
        print(args, {k: r[k] for k in ('n', 'cell_m', 'valid_fraction', 'source', 'seconds')})
