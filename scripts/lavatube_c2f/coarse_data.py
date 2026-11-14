"""PitChain-C2F coarse-stage training set from DEMs already on the server (no downloads).

Moon: LOLA 64 ppd + co-located LROC WAC 643 nm Hapke I/F (real image <-> DEM pairs, +-70 deg).
Mars: MOLA MEGDR 32 ppd.  Earth: the windows of the production index (ETOPO 15 s for 20/40 km, 60 s for 80 km).
Every sample is a 64x64 geodesic square of 20/40/80 km. Samples within sites.EXCLUDE_KM of evaluation sites are
dropped. Single seed."""
import json
import math
import sys
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))  # append: a stale lunar_pipeline.py sits in the repo root
sys.path.insert(0, str(ROOT / 'src'))  # src/ first: a stale lunar_pipeline.py sits in the repo root
from scripts.lavatube_c2f import sites  # noqa: E402

OUT = ROOT / 'data/research/lavatube_c2f'
SEED = 20261017
SIZE = 64
SCALES = (20, 40, 80)
N = {'moon': 60000, 'mars': 40000, 'earth': 80000}
WAC_PPD = 76


def wac_mosaic():
    """Assemble the eight 643 nm previews (I/F x 2048, 0 = nodata) into one 70N-70S equirectangular array."""
    Image.MAX_IMAGE_PIXELS = None
    base = ROOT / 'data/moon/lroc_wac_hapke'
    out = np.zeros((140 * WAC_PPD, 360 * WAC_PPD), np.uint8)
    for f in sorted(base.glob('WAC_HAPKE_643NM_E350*.webp')):
        tag = f.stem.split('E350')[1]
        hemi, lon_c = tag[0], int(tag[1:5]) / 10
        a = np.asarray(Image.open(f).convert('L'))[:70 * WAC_PPD, :90 * WAC_PPD]
        r0 = 0 if hemi == 'N' else 70 * WAC_PPD
        c0 = int(lon_c - 45) * WAC_PPD
        out[r0:r0 + a.shape[0], c0:c0 + a.shape[1]] = a
    return out


def geodesic_grid(lat, lon, km, radius_km):
    lat0, lon0 = math.radians(lat), math.radians(lon)
    center = np.array([math.cos(lat0) * math.cos(lon0), math.sin(lat0), math.cos(lat0) * math.sin(lon0)])
    east = np.array([-math.sin(lon0), 0.0, math.cos(lon0)])
    north = np.array([-math.sin(lat0) * math.cos(lon0), math.cos(lat0), -math.sin(lat0) * math.sin(lon0)])
    ex, ny = np.meshgrid(np.linspace(-km / 2, km / 2, SIZE), np.linspace(km / 2, -km / 2, SIZE))
    rho = np.hypot(ex, ny)
    theta = rho / radius_km
    tangent = ex[..., None] * east + ny[..., None] * north
    unit = center * np.cos(theta)[..., None] + tangent * (np.sin(theta) / np.maximum(rho, 1e-9))[..., None]
    return np.degrees(np.arcsin(np.clip(unit[..., 1], -1, 1))), np.degrees(np.arctan2(unit[..., 2], unit[..., 0]))


WAC = None


def moon_job(args):
    from lunar_pipeline import moon_patch
    lat, lon, km = args
    dem = moon_patch(lat, lon, size=SIZE, patch_km=km)
    img = np.zeros((SIZE, SIZE), np.uint8)
    ok = False
    if abs(lat) + km / 30.3 < 69:
        la, lo = geodesic_grid(lat, lon, km, 1737.4)
        yy = (70 - la) * WAC_PPD - 0.5
        xx = ((lo % 360) * WAC_PPD - 0.5) % WAC.shape[1]
        v = map_coordinates(WAC, [yy, xx], order=1, mode='nearest')
        valid = map_coordinates(WAC, [yy, xx], order=0, mode='nearest') > 0  # sample the mask, never build it
        if valid.mean() > 0.98:
            img, ok = np.clip(v, 0, 255).astype(np.uint8), True
    return dem.astype(np.float32), img, ok


def mars_job(args):
    from mars_global import patch_at
    lat, lon, km = args
    return patch_at(lat, lon, km, size=SIZE).astype(np.float32)  # expects -180..180


def earth_job(row):
    from lunar_pipeline import etopo_15s_patch, global_earth_patch_windowed
    c = row['center']
    if row.get('dataset') == 'ETOPO_2022_15s':
        g = etopo_15s_patch(c['latitude'], c['longitude_east'], row['patch_km'], row['tile'], size=SIZE)
    else:
        g = global_earth_patch_windowed(c['latitude'], c['longitude_east'], row['patch_km'], size=SIZE)
    return np.asarray(g, np.float32)


def sphere_points(rng, n, max_lat):
    lat = np.degrees(np.arcsin(rng.uniform(-math.sin(math.radians(max_lat)), math.sin(math.radians(max_lat)), n)))
    lon = rng.uniform(-180, 180, n)
    return lat, lon


def earth_rows():
    rows = []
    for meta in ['data/earth_global/etopo_15s_20_40km_index.json', 'data/earth_global/etopo_80km_index.json',
                 'data/earth_global/etopo_80km_supplement.json']:
        path = ROOT / meta
        if path.exists():
            rows += [r for r in json.loads(path.read_text())['rows']]
    return rows


def pack(dems):
    """float16 relative elevation (metres minus the patch median)."""
    d = np.stack(dems)
    return (d - np.median(d.reshape(len(d), -1), 1)[:, None, None]).astype(np.float16)


def main():
    global WAC
    OUT.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED)
    t0 = time.time()
    WAC = wac_mosaic()
    # load the global rasters once in the parent so forked workers share them
    from lunar_pipeline import lunar_dem
    from mars_global import global_raster
    lunar_dem(); global_raster()
    report = {'seed': SEED, 'size': SIZE, 'exclude_km': sites.EXCLUDE_KM}
    # Moon (each body is skipped when its file exists; the RNG draws stay identical)
    lat, lon = sphere_points(rng, int(N['moon'] * 1.1), 80)
    keep = ~sites.excluded('moon', lat, lon)
    lat, lon = lat[keep][:N['moon']], lon[keep][:N['moon']]
    km = rng.choice(SCALES, len(lat))
    if (OUT / 'coarse_moon.npz').exists():
        res = None
    else:
        with Pool(12) as pool:
            res = pool.map(moon_job, list(zip(lat, lon, km)), chunksize=256)
    if res is not None:
        np.savez(OUT / 'coarse_moon.npz', dem=pack([r[0] for r in res]), wac=np.stack([r[1] for r in res]),
             wac_ok=np.array([r[2] for r in res]), lat=lat.astype(np.float32), lon=lon.astype(np.float32), km=km.astype(np.int16))
    report['moon'] = {'n': len(lat), 'wac_pairs': int(np.load(OUT / 'coarse_moon.npz')['wac_ok'].sum())}
    print(json.dumps(report), round(time.time() - t0), flush=True)
    # Mars
    lat, lon = sphere_points(rng, int(N['mars'] * 1.1), 80)
    keep = ~sites.excluded('mars', lat, lon)
    lat, lon = lat[keep][:N['mars']], lon[keep][:N['mars']]
    km = rng.choice(SCALES, len(lat))
    with Pool(12) as pool:
        res = pool.map(mars_job, list(zip(lat, lon, km)), chunksize=256)
    np.savez(OUT / 'coarse_mars.npz', dem=pack(res), lat=lat.astype(np.float32), lon=lon.astype(np.float32), km=km.astype(np.int16))
    report['mars'] = {'n': len(lat)}
    print(json.dumps(report), round(time.time() - t0), flush=True)
    # Earth
    rows = earth_rows()
    la = np.array([r['center']['latitude'] for r in rows]); lo = np.array([r['center']['longitude_east'] for r in rows])
    ok = np.flatnonzero(~sites.excluded('earth', la, lo))
    pick = rng.choice(ok, min(N['earth'], len(ok)), replace=False)
    chosen = [rows[i] for i in pick]
    with Pool(12) as pool:
        res = pool.map(earth_job, chosen, chunksize=128)
    np.savez(OUT / 'coarse_earth.npz', dem=pack(res), lat=la[pick].astype(np.float32), lon=lo[pick].astype(np.float32),
             km=np.array([r['patch_km'] for r in chosen], np.int16), ids=np.array([r['id'] for r in chosen]))
    report['earth'] = {'n': len(chosen), 'excluded_rows': int(len(rows) - len(ok)), 'pool_rows': len(rows)}
    report['seconds'] = round(time.time() - t0)
    (OUT / 'coarse_data_report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
