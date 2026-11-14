"""Run the PitChain-C2F teacher on every high-resolution DEM (downloaded set + DEMs already on the server).

Each DEM is read at a fixed teacher resolution (Earth/Mars 2 m, Moon native 2-5 m; geographic rasters are warped to
local UTM first) and gets: closed-depression depth (float16), a pit-like mask (d/D >= teacher.PIT_D_OVER_D, fixed a
priori), and a table of all depressions and pit chains in map coordinates. Outputs go to data/research/lavatube_c2f/
teacher/. Resumable: existing outputs are skipped."""
import json
import math
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))  # append: a stale lunar_pipeline.py sits in the repo root
from scripts.lavatube_c2f import teacher  # noqa: E402

SRC = ROOT / 'data/research/lavatube_c2f/sources'
OUT = ROOT / 'data/research/lavatube_c2f/teacher'
MIN_PX = 20


def discover():
    items = []
    for dtm in sorted((SRC / 'moon').glob('*/NAC_DTM_*.TIF')):
        site = dtm.parent.name
        items.append({'body': 'moon', 'name': site, 'dem': dtm, 'image': next(iter(sorted(dtm.parent.glob('*.IMG'))), None), 'origin': 'download'})
    for dtm in sorted((SRC / 'moon_blind').glob('*/NAC_DTM_*.TIF')):
        items.append({'body': 'moon', 'name': dtm.parent.name, 'dem': dtm, 'image': next(iter(sorted(dtm.parent.glob('*.IMG'))), None), 'origin': 'blind_v2'})
    local = ROOT / 'data/research/highres_lunar_dem/sources'
    for site in ['ANDERSON01', 'FECUNDITATIS', 'FRSHCRATER8', 'NASSAU02', 'SCHRODNGR02']:
        items.append({'body': 'moon', 'name': site, 'dem': local / f'NAC_DTM_{site}.TIF',
                      'image': next(iter(sorted(local.glob(f'NAC_DTM_{site}_M*.TIF'))), None), 'origin': 'local'})
    items.append({'body': 'moon', 'name': 'MARIUS3', 'dem': ROOT / 'data/research/published_analog_audit/sources/NAC_DTM_MARIUS3.TIF',
                  'image': local / 'NAC_DTM_MARIUS3_M137909506_2M.TIF', 'origin': 'local'})
    for d in sorted((SRC / 'mars').glob('ESP_*')):
        dem = next(iter(sorted(d.glob('DTEE*.IMG'))), None)
        if dem:
            items.append({'body': 'mars', 'name': d.name, 'dem': dem, 'image': next(iter(sorted(d.glob('*.JP2'))), None), 'origin': 'download'})
    for tif in sorted((SRC / 'earth').glob('*.tif')):
        items.append({'body': 'earth', 'name': tif.stem, 'dem': tif, 'image': None, 'origin': 'download'})
    for z in sorted((SRC / 'earth').glob('*.zip')):
        folder = SRC / 'earth' / z.stem
        if not folder.exists():
            folder.mkdir()
            with zipfile.ZipFile(z) as archive:
                for member in archive.namelist():
                    if member.lower().endswith(('.img', '.hdr', '.prj', '.xml', '.aux.xml')) and '..' not in member:
                        archive.extract(member, folder)
        for img in sorted(folder.rglob('*.img')):
            items.append({'body': 'earth', 'name': img.stem, 'dem': img, 'image': None, 'origin': 'download'})
    for crop in sorted((ROOT / 'data/research').glob('earth_3dep_*/*_3km_2m.tif')):
        items.append({'body': 'earth', 'name': crop.parent.name, 'dem': crop, 'image': None, 'origin': 'local_3km_crop'})
    return [i for i in items if i['dem'] and Path(i['dem']).exists()]


def utm_crs(lon, lat):
    zone = int((lon + 180) // 6) + 1
    return f'EPSG:{32600 + zone if lat >= 0 else 32700 + zone}'


def read_dem(item):
    target = {'earth': 2.0, 'mars': 2.0, 'moon': None}[item['body']]
    with rasterio.open(item['dem']) as ds:
        src = ds
        vrt = None
        if ds.crs and ds.crs.is_geographic:
            b = ds.bounds
            lon, lat = (b.left + b.right) / 2, (b.top + b.bottom) / 2
            vrt = WarpedVRT(ds, crs=utm_crs(lon, lat), resampling=Resampling.bilinear)
            src = vrt
        res = abs(src.res[0])
        scale = max(1.0, (target or res) / res)
        shape = (max(1, int(round(src.height / scale))), max(1, int(round(src.width / scale))))
        a = src.read(1, out_shape=shape, masked=True, resampling=Resampling.average if scale > 1 else Resampling.nearest)
        transform = src.transform * src.transform.scale(src.width / shape[1], src.height / shape[0])
        crs = src.crs.to_string() if src.crs else None
        if vrt:
            vrt.close()
    a = a.astype(np.float32)
    valid = ~np.ma.getmaskarray(a) & np.isfinite(a.filled(np.nan)) & (np.abs(a.filled(0)) < 1e7)
    dem = a.filled(np.nan)
    dem[~valid] = np.nanmedian(dem[valid]) if valid.any() else 0
    return dem, valid, abs(transform.a), transform, crs


def run(item):
    out = OUT / f"{item['body']}_{item['name']}"
    if Path(str(out) + '.json').exists():
        return None
    t0 = time.time()
    dem, valid, res, transform, crs = read_dem(item)
    if valid.mean() < 0.05:
        return {'name': item['name'], 'skipped': 'mostly nodata'}
    min_depth = {'earth': 1.0, 'mars': 1.0, 'moon': max(2.0, 0.6 * res)}[item['body']]
    # DTM effective resolution is ~3 posts, so depressions narrower than 5 posts (area >= 20 px) are not measured
    depth, labels, pits = teacher.depressions(dem, valid, res, min_depth, min_px=MIN_PX)
    chains = teacher.chains(pits, res)
    pit_ids = np.array([p['label'] for p in pits if p['collapse_like']], np.int32)
    pitmask = np.isin(labels, pit_ids) if len(pit_ids) else np.zeros(labels.shape, bool)
    for p in pits:
        x, y = transform * (p['cx'] + 0.5, p['cy'] + 0.5)
        p['x'], p['y'] = round(float(x), 2), round(float(y), 2)
    OUT.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(str(out) + '.npz', depth=np.where(valid, depth, 0).astype(np.float16), pit=pitmask.astype(np.uint8),
                        valid=valid.astype(np.uint8))
    meta = {'body': item['body'], 'name': item['name'], 'origin': item['origin'], 'dem': str(Path(item['dem']).relative_to(ROOT)),
            'image': str(Path(item['image']).relative_to(ROOT)) if item['image'] else None, 'res_m': res,
            'transform': list(transform)[:6], 'crs': crs, 'shape': list(dem.shape), 'valid_fraction': round(float(valid.mean()), 4),
            'min_depth_m': min_depth, 'min_px': MIN_PX, 'pit_d_over_d': teacher.PIT_D_OVER_D, 'depressions': len(pits),
            'pits': int(len(pit_ids)), 'chains': chains, 'table': pits, 'seconds': round(time.time() - t0, 1)}
    Path(str(out) + '.json').write_text(json.dumps(meta))
    return {k: meta[k] for k in ['body', 'name', 'res_m', 'shape', 'depressions', 'pits', 'seconds']} | {'chains': len(chains)}


if __name__ == '__main__':
    items = discover()
    print(json.dumps({'sources': len(items)}), flush=True)
    for item in items:
        try:
            r = run(item)
            if r:
                print(json.dumps(r), flush=True)
        except Exception as e:  # noqa: BLE001 - report and continue with the next DEM
            print(json.dumps({'name': item['name'], 'error': str(e)[:300]}), flush=True)
