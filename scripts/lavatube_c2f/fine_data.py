"""F-Net training set: every teacher site resampled to one 10 m student grid.

Inputs (what the fine stage sees at serving time): a grey image at 10 m and a coarse DEM with GLO-30-like quality
(Earth: the real Copernicus GLO-30; Moon/Mars: the high-resolution DTM block-averaged to 30 m plus 2 m noise).
Targets (from the analytic teacher on the 1-5 m DEM): pit-like area fraction and closed-depression depth per 10 m cell.
Illumination: the sun azimuth/elevation of every image is estimated photometrically (best correlation between the image
and DEM hillshades); Earth scenes also carry the Sentinel-2 metadata angles, which serve as a check.

Split (fixed before training; evaluation sites never train):
  Earth  - every 3DEP site is in the USA, so Earth trains here and Earth retrieval is evaluated on non-US fields.
           Dev: Jordan Craters (OR).
  Moon   - test: every NAC DTM made for a mare pit; dev: APOLLO15; train: the other NAC DTMs.
  Mars   - test: every HiRISE DTM whose footprint contains an MGC3 skylight/APC candidate; train: the rest
           (one of them dev)."""
import json
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
import torch
import torch.nn.functional as F
from affine import Affine
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))  # append: a stale lunar_pipeline.py sits in the repo root
from scripts.lavatube_c2f import sites, teacher_batch  # noqa: E402

TEACHER = ROOT / 'data/research/lavatube_c2f/teacher'
OUT = ROOT / 'data/research/lavatube_c2f/fine'
RES = 10.0
SEED = 20261018
MOON_TEST = {'MARIUSPIT01', 'TRANQPIT1', 'INGENIIPIT', 'FECUNPIT', 'SWFECUNPIT1', 'PRCLRMPIT01', 'IRIDIUMPIT1', 'LACUSMORT02'}
MOON_DEV = {'APOLLO15'}
EARTH_DEV_KEY = 'OR_SouthEast_D22'  # Jordan Craters


def hillshade(dem, res, az_deg, el_deg):
    """Lambert shading; az clockwise from north, rows increase southward, columns eastward."""
    gy, gx = np.gradient(dem, res)  # gy: d/d(row) = -d/d(north)
    nx, ny, nz = -gx, gy, np.ones_like(dem)
    norm = np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    az, el = math.radians(az_deg), math.radians(el_deg)
    s = (math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el))  # east, north, up
    return np.clip((nx * s[0] + ny * s[1] + nz * s[2]) / norm, 0, None)


def estimate_sun(img, dem, valid):
    """Sun direction that best explains the image shading (Pearson r over valid pixels, high-pass filtered)."""
    from scipy.ndimage import gaussian_filter
    # the sun direction is one global parameter: fit it on a block-averaged copy (<= ~600 px per side)
    f = int(math.ceil(max(img.shape) / 600))
    res = RES
    if f > 1:
        h, w = (img.shape[0] // f) * f, (img.shape[1] // f) * f
        blk = lambda a: a[:h, :w].reshape(h // f, f, w // f, f).mean((1, 3))
        ok = (valid & np.isfinite(img)).astype(np.float32)
        img = np.where(blk(ok) > 0.9, blk(np.where(ok > 0, img, 0)) / np.maximum(blk(ok), 1e-6), np.nan)
        dem, valid, res = blk(dem), blk(ok) > 0.9, RES * f
    m = valid & np.isfinite(img)
    if m.sum() < 1000:
        return None, None, None
    hp = lambda a: a - gaussian_filter(a, 8)
    im = hp(np.where(m, img, np.nanmean(img[m])))[m]
    best = (-2, None, None)
    for el in (10, 20, 30, 45, 60, 75):
        for az in range(0, 360, 10):
            hs = hp(hillshade(dem, res, az, el))[m]
            r = float(np.corrcoef(im, hs)[0, 1])
            if r > best[0]:
                best = (r, az, el)
    return best[1], best[2], round(best[0], 4)


def pool(a, shape, kind):
    t = torch.from_numpy(np.asarray(a, np.float32))[None, None]
    return (F.adaptive_max_pool2d(t, shape) if kind == 'max' else F.adaptive_avg_pool2d(t, shape))[0, 0].numpy()


def coarse_dem(dem_true10, rng):
    """GLO-30-like DEM: 30 m block mean + 2 m Gaussian noise, back to the 10 m grid (bilinear)."""
    h, w = dem_true10.shape
    c = pool(dem_true10, (max(2, h // 3), max(2, w // 3)), 'avg') + rng.normal(0, 2.0, (max(2, h // 3), max(2, w // 3))).astype(np.float32)
    return F.interpolate(torch.from_numpy(c)[None, None], size=(h, w), mode='bilinear', align_corners=False)[0, 0].numpy()


def image_on_grid(path, crs, transform, w, h):
    with rasterio.open(path) as src, WarpedVRT(src, crs=crs, transform=transform, width=w, height=h, resampling=Resampling.average) as vrt:
        a = vrt.read(1, masked=True).astype(np.float32)
    nodata = np.ma.getmaskarray(a) | ~np.isfinite(a.filled(np.nan)) | (a.filled(0) <= -1e30)
    return np.where(nodata, np.nan, a.filled(np.nan))


def split_of(meta, mars_candidates):
    body, name = meta['body'], meta['name']
    if body == 'earth':
        return 'dev' if EARTH_DEV_KEY in name else 'train'
    if body == 'moon':
        return 'test' if name in MOON_TEST else 'dev' if name in MOON_DEV else 'train'
    t = Affine(*meta['transform']); h, w = meta['shape']
    crs = rasterio.crs.CRS.from_string(meta['crs'])
    geo = crs.to_proj4().replace('+proj=eqc', '+proj=longlat').split('+lat_ts')[0] + ' +R=3396190 +no_defs'
    try:
        w_, s_, e_, n_ = transform_bounds(crs, '+proj=longlat +R=3396190 +no_defs', t.c, t.f + t.e * h, t.c + t.a * w, t.f)
    except Exception:  # noqa: BLE001
        return 'train'
    inside = [q for q in mars_candidates if s_ <= q['lat'] <= n_ and w_ <= q['lon'] <= e_]
    return 'test' if inside else 'train'


def build(meta_path, mars_candidates, rng):
    meta = json.loads(meta_path.read_text())
    name = f"{meta['body']}_{meta['name']}"
    target = OUT / f'{name}.npz'
    if target.exists():
        return None
    tz = np.load(meta_path.with_suffix('.npz'))
    t = Affine(*meta['transform']); h, w = meta['shape']; res = meta['res_m']
    H, W = max(8, int(round(h * res / RES))), max(8, int(round(w * res / RES)))
    t10 = Affine(RES, 0, t.c, 0, -RES, t.f)
    pit = pool(tz['pit'], (H, W), 'avg')
    depth = pool(tz['depth'].astype(np.float32), (H, W), 'max')
    valid = pool(tz['valid'], (H, W), 'avg')
    item = {'body': meta['body'], 'name': meta['name'], 'dem': ROOT / meta['dem'], 'image': None, 'origin': meta['origin']}
    dem_hr, valid_hr, _, _, _ = teacher_batch.read_dem(item)
    dem_true10 = pool(np.where(valid_hr, dem_hr, np.nan if False else dem_hr), (H, W), 'avg')
    info = {'name': name, 'body': meta['body'], 'shape': [H, W], 'res_m': RES, 'crs': meta['crs'], 'transform': list(t10)[:6],
            'teacher_res_m': res, 'teacher_pits': meta['pits']}
    if meta['body'] == 'earth':
        inputs = meta_path.with_suffix('.inputs.npz')
        if not inputs.exists():
            return {'name': name, 'skipped': 'no Sentinel-2/GLO-30 inputs yet'}
        e = np.load(inputs)
        s2 = e['s2'][:, :H, :W].astype(np.float32)
        img = s2[:3].mean(0)
        img[(e['scl'][:H, :W] == 0) | np.isin(e['scl'][:H, :W], [1, 3, 8, 9, 10])] = np.nan
        dem_in = e['glo30'][:H, :W].astype(np.float32)
        if np.isnan(dem_in).mean() > 0.2:
            dem_in = coarse_dem(dem_true10, rng)
            info['dem_input'] = 'simulated (GLO-30 missing)'
        else:
            dem_in = np.where(np.isfinite(dem_in), dem_in, np.nanmedian(dem_in))
            info['dem_input'] = 'Copernicus GLO-30'
        ij = json.loads(inputs.with_suffix('.json').read_text())
        info['sun_metadata'] = [ij.get('sun_azimuth'), ij.get('sun_elevation')]
        info['image_source'] = 'Sentinel-2 L2A ' + ij.get('s2_item', '')
    else:
        if not meta.get('image'):
            return {'name': name, 'skipped': 'no orthoimage'}
        img = image_on_grid(ROOT / meta['image'], meta['crs'], t10, W, H)
        dem_in = coarse_dem(dem_true10, rng)
        info['dem_input'] = 'simulated GLO-30-like (30 m mean + 2 m noise)'
        info['image_source'] = meta['image']
    m = (valid > 0.95) & np.isfinite(img)
    az, el, r = estimate_sun(img, dem_true10, m)
    info.update(sun_fit=[az, el, r], valid_fraction=round(float(m.mean()), 4), split=split_of(meta, mars_candidates))
    lo, hi = np.nanpercentile(img[m], [1, 99]) if m.any() else (0, 1)
    img_n = np.clip((img - lo) / max(hi - lo, 1e-6), 0, 1)
    OUT.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(target, img=np.where(m, img_n, 0).astype(np.float16), dem=dem_in.astype(np.float32),
                        dem_true=dem_true10.astype(np.float32), pit=pit.astype(np.float16), depth=depth.astype(np.float16),
                        valid=m.astype(np.uint8))
    target.with_suffix('.json').write_text(json.dumps(info))
    return info


def main():
    rng = np.random.default_rng(SEED)
    mars_candidates = [q for q in sites.query_sites(ROOT) if q['body'] == 'mars']
    for meta_path in sorted(TEACHER.glob('*.json')):
        if meta_path.name.endswith('.inputs.json'):
            continue
        try:
            r = build(meta_path, mars_candidates, rng)
            if r:
                print(json.dumps({k: r.get(k) for k in ('name', 'split', 'shape', 'sun_fit', 'sun_metadata', 'teacher_pits', 'valid_fraction', 'skipped')}), flush=True)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({'name': meta_path.stem, 'error': str(e)[:300]}), flush=True)


if __name__ == '__main__':
    main()
