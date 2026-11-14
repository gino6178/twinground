"""Per-candidate resource card (2026-11-13): the challenge's recommended resources applied to one Earth candidate.

  radar     Sentinel-1 RTC (Copernicus, via the Microsoft Planetary Computer mirror; no login): median VV and VH backscatter
            and the cross-polarised ratio over the window, plus a VV quicklook.
            RADARSAT Constellation Mission compact-polarimetry land mosaic of Canada (CSA/CCRS ARD, 30 m), where covered.
            RADARSAT-1 archive (CSA): number of processed archive images whose footprint covers the candidate.
            Lunar queries: Mini-RF circular polarisation ratio of the query window, with a class comparison.
            Rasters are read and plotted following the CSA SAR tutorial workflow (rasterio read of a GeoTIFF window,
            bounds transformed to the raster CRS, display in dB).
  earthdata NASA Earthdata Search (CMR): granule counts over the window for a few collections useful for a field
            campaign, and a link that opens the same search.
  worldview NASA Worldview / GIBS: true colour, land surface temperature and snow layers for the window (WMS), and a
            Worldview link at the same extent.
Display only; nothing here enters ranking. Results are cached on disk."""
import hashlib
import json
import math
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / 'data/research/facets_v61/resource_cache'
PC = 'https://planetarycomputer.microsoft.com/api'
RCM = 'https://datacube-prod-data-public.s3.amazonaws.com/store/imagery/sar/rcm-ard-mosaic/rcm-ard-mosaic.tif'
R1 = 'https://maps-cartes.services.geo.ca/server_serveur/rest/services/CSA/radarsat1_heatmap_processed_archived_images_en/MapServer'
CMR = 'https://cmr.earthdata.nasa.gov/search'
GIBS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
UA = {'User-Agent': 'analog-atlas-research'}
EARTHDATA = [  # (short_name, version, zh, en)
    ('MOD11A2', '061', 'MODIS 地表溫度（8 日）', 'MODIS land surface temperature (8-day)'),
    ('SPL3SMP_E', '006', 'SMAP 土壤水分', 'SMAP soil moisture'),
    ('HLSL30', '2.0', 'Landsat 協調地表反射率', 'Harmonized Landsat surface reflectance'),
    ('ASTGTM', '003', 'ASTER 全球數值地形', 'ASTER global DEM'),
    ('GEDI02_A', '002', 'GEDI 雷射高程', 'GEDI lidar elevation'),
]


def _get(url, data=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers={**UA, **({'Content-Type': 'application/json'} if data else {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), dict(r.headers)


def bbox(lat, lon, km):
    d = km / 111.0 / 2
    dx = d / max(math.cos(math.radians(lat)), 0.05)
    return [round(lon - dx, 4), round(lat - d, 4), round(lon + dx, 4), round(lat + d, 4)]


def _png(arr, path):
    """grey or RGB uint8 array -> PNG, without extra dependencies beyond OpenCV (used elsewhere in the project)."""
    import cv2
    a = arr if arr.ndim == 2 else arr[..., ::-1]
    cv2.imwrite(str(path), a)


def sentinel1(lat, lon, km):
    import rasterio
    from rasterio.warp import transform_bounds
    from rasterio.windows import from_bounds
    b = bbox(lat, lon, km)
    body = json.dumps({'collections': ['sentinel-1-rtc'], 'bbox': b, 'limit': 1,
                       'sortby': [{'field': 'datetime', 'direction': 'desc'}]}).encode()
    items = json.loads(_get(f'{PC}/stac/v1/search', body)[0])['features']
    if not items:
        return None
    it = items[0]
    tok = json.loads(_get(f'{PC}/sas/v1/token/sentinel-1-rtc')[0])['token']

    def read(pol):
        if pol not in it['assets']:
            return None
        with rasterio.open(it['assets'][pol]['href'] + '?' + tok) as s:
            w = from_bounds(*transform_bounds('EPSG:4326', s.crs, *b), s.transform)
            return s.read(1, window=w, out_shape=(160, 160), boundless=True, fill_value=0).astype(np.float64)

    with ThreadPoolExecutor(2) as ex:
        vv, vh = ex.map(read, ('vv', 'vh'))
    if vv is None:
        return None
    ok = vv > 0
    if ok.mean() < 0.2:
        return None
    vv_db = 10 * np.log10(np.where(ok, vv, np.nan))
    out = {'scene': it['id'], 'date': it['properties'].get('datetime', '')[:10], 'vv_db': round(float(np.nanmedian(vv_db)), 2), 'coverage': round(float(ok.mean()), 2)}
    if vh is not None and (vh > 0).any():
        vh_db = 10 * np.log10(np.where(vh > 0, vh, np.nan))
        out['vh_db'] = round(float(np.nanmedian(vh_db)), 2)
        out['cross_ratio_db'] = round(out['vh_db'] - out['vv_db'], 2)
    img = np.clip((np.nan_to_num(vv_db, nan=-30) + 25) / 25 * 255, 0, 255).astype(np.uint8)
    name = hashlib.sha1(f's1{lat:.4f}{lon:.4f}{km}'.encode()).hexdigest()[:16] + '.png'
    _png(img, CACHE / name)
    out['quicklook'] = name
    return out


def rcm(lat, lon, km):
    """CCRS RCM ARD land mosaic of Canada (compact polarimetry, m-chi style RGB composite)."""
    if not (40 <= lat <= 84.5 and -142 <= lon <= -50):
        return None
    import rasterio
    from rasterio.warp import transform_bounds
    from rasterio.windows import from_bounds
    with rasterio.open(RCM) as s:
        w = from_bounds(*transform_bounds('EPSG:4326', s.crs, *bbox(lat, lon, km)), s.transform)
        a = s.read(window=w, out_shape=(s.count, 160, 160), boundless=True, fill_value=0)
    valid = a.sum(0) > 0
    if valid.mean() < 0.2:
        return None
    m = a[:, valid].astype(np.float64).mean(1)
    name = hashlib.sha1(f'rcm{lat:.4f}{lon:.4f}{km}'.encode()).hexdigest()[:16] + '.png'
    _png(np.moveaxis(a, 0, -1).astype(np.uint8), CACHE / name)
    tot = max(m.sum(), 1e-9)
    return {'red': round(float(m[0] / tot), 3), 'green': round(float(m[1] / tot), 3), 'blue': round(float(m[2] / tot), 3),
            'coverage': round(float(valid.mean()), 2), 'quicklook': name}


def radarsat1(lat, lon):
    q = {'geometry': f'{lon},{lat}', 'geometryType': 'esriGeometryPoint', 'inSR': '4326', 'spatialRel': 'esriSpatialRelIntersects', 'f': 'json'}
    n = json.loads(_get(f'{R1}/2/query?' + urllib.parse.urlencode({**q, 'returnCountOnly': 'true'}))[0]).get('count', 0)
    out = {'images': int(n)}
    if n:
        st = json.dumps([{'statisticType': 'min', 'onStatisticField': 'start', 'outStatisticFieldName': 'first'},
                         {'statisticType': 'max', 'onStatisticField': 'start', 'outStatisticFieldName': 'last'}])
        r = json.loads(_get(f'{R1}/2/query?' + urllib.parse.urlencode({**q, 'outStatistics': st}))[0])
        a = (r.get('features') or [{}])[0].get('attributes', {})
        out.update(first=str(a.get('first') or '')[:4] or None, last=str(a.get('last') or '')[:4] or None)
    return out


def earthdata(lat, lon, km):
    b = bbox(lat, lon, km)
    bb = ','.join(map(str, b))

    def hits(c):
        _, h = _get(f'{CMR}/granules.json?' + urllib.parse.urlencode({'short_name': c[0], 'version': c[1], 'bounding_box': bb, 'page_size': 0}))
        return {'short_name': c[0], 'label': {'zh': c[2], 'en': c[3]}, 'granules': int(h.get('CMR-Hits') or h.get('cmr-hits') or 0)}

    with ThreadPoolExecutor(5) as ex:
        rows = list(ex.map(hits, EARTHDATA))
    link = 'https://search.earthdata.nasa.gov/search?' + urllib.parse.urlencode({'sb': f'{b[0]},{b[1]},{b[2]},{b[3]}'})
    return {'collections': rows, 'search_link': link}


def _wms(layer, date, b, size):
    return GIBS + '?' + urllib.parse.urlencode({'SERVICE': 'WMS', 'REQUEST': 'GetMap', 'VERSION': '1.1.1', 'SRS': 'EPSG:4326',
                                                'BBOX': ','.join(map(str, b)), 'WIDTH': size, 'HEIGHT': size, 'FORMAT': 'image/jpeg',
                                                'LAYERS': layer, 'TIME': date})


def _clear_date(layer, month, b):
    """first day of the month (15th, then nearby days) whose image has no swath gap: a daily MODIS image can be black
    where the orbit left a gap, so a few dates are tried at small size and the first one with < 5% black pixels is used."""
    import cv2
    for day in (15, 12, 18, 9, 21, 6, 24, 3, 27):
        d = f'2024-{month:02d}-{day:02d}'
        try:
            raw, _ = _get(_wms(layer, d, b, 64), timeout=30)
            img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE)
            if img is not None and (img < 8).mean() < 0.05:
                return d
        except Exception:  # noqa: BLE001
            continue
    return f'2024-{month:02d}-15'


def worldview(lat, lon, km, earth=None):
    b = bbox(lat, lon, max(km, 40))
    sm, wm = (7, 1) if lat >= 0 else (1, 7)
    tc = 'MODIS_Terra_CorrectedReflectance_TrueColor'
    ds, dw = _clear_date(tc, sm, b), _clear_date(tc, wm, b)
    layers = [(tc, ds, '真彩色（夏季）', 'True colour (summer)'), (tc, dw, '真彩色（冬季）', 'True colour (winter)'),
              ('MODIS_Terra_Land_Surface_Temp_Day', ds, '白天地表溫度（夏季）', 'Daytime land surface temperature (summer)')]
    cold = earth is not None and earth.get('lst_night_min_c') is not None and earth['lst_night_min_c'] < 0
    if cold:  # snow is only shown where winter nights freeze; elsewhere the layer would be an empty black square
        layers.append(('MODIS_Terra_NDSI_Snow_Cover', dw, '積雪（冬季）', 'Snow cover (winter)'))
    imgs = [{'layer': l, 'date': d, 'label': {'zh': z, 'en': e}, 'url': _wms(l, d, b, 320)} for l, d, z, e in layers]
    link = 'https://worldview.earthdata.nasa.gov/?' + urllib.parse.urlencode(
        {'v': ','.join(map(str, b)), 'l': 'MODIS_Terra_CorrectedReflectance_TrueColor,MODIS_Terra_Land_Surface_Temp_Day,Coastlines_15m', 't': ds})
    return {'images': imgs, 'link': link}


def radar_compare(moon_cpr, s1):
    """class comparison only: Mini-RF is S band circular polarisation, Sentinel-1 is C band linear dual polarisation."""
    if not moon_cpr or not s1 or s1.get('cross_ratio_db') is None:
        return None
    c = moon_cpr['cpr_median']
    moon_cls = 'rough' if c >= 0.6 else 'smooth' if c <= 0.45 else 'mixed'
    x = s1['cross_ratio_db']
    earth_cls = 'rough' if x >= -6.0 else 'smooth' if x <= -8.5 else 'mixed'
    same = moon_cls == earth_cls
    return {'moon_class': moon_cls, 'earth_class': earth_cls, 'status': 'strong' if same else 'partial' if 'mixed' in (moon_cls, earth_cls) else 'breaks'}


def _cached(key, fn, *args, ttl_days=30):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / (hashlib.sha1(key.encode()).hexdigest()[:20] + '.json')
    if f.exists() and time.time() - f.stat().st_mtime < ttl_days * 86400:
        return json.loads(f.read_text())
    try:
        v = fn(*args)
    except Exception as exc:  # noqa: BLE001
        return {'error': str(exc)[:160]}
    f.write_text(json.dumps(v))
    return v


_TREE = {}


def earth_measured(lat, lon):
    """values of the nearest Earth window (<= 30 km) from the v6.1 table: surface temperature (Terra MODIS via JAXA),
    soil moisture (AMSR2), precipitation (GSMaP) and permafrost fraction (ESA CCI). Display only."""
    if 'tree' not in _TREE:
        from sklearn.neighbors import BallTree
        f6 = np.load(ROOT / 'data/research/facets_v6/earth_facets.npz')
        z = np.load(ROOT / 'data/research/facets_v61/earth_facets_v61.npz')
        _TREE['z'] = {k: z[k] for k in z.files if k != 'ids'}
        _TREE['tree'] = BallTree(np.radians(np.c_[f6['lat'], f6['lon']]), metric='haversine')
    d, j = _TREE['tree'].query(np.radians([[lat, lon]]), k=1)
    if d[0, 0] * 6371 > 30:
        return None
    z, i = _TREE['z'], int(j[0, 0])
    v = lambda k: None if not np.isfinite(z[k][i]) else float(z[k][i])
    c = lambda k: None if v(k) is None else round(v(k) - 273.15, 1)
    return {'lst_mean_c': c('lst_mean_k'), 'lst_day_max_c': c('lst_day_max_k'), 'lst_night_min_c': c('lst_night_min_k'),
            'lst_swing_k': None if v('lst_swing_k') is None else round(v('lst_swing_k'), 1),
            'soil_moisture_pct': None if v('soil_moisture') is None else round(v('soil_moisture'), 1),
            'precip_mm_yr': None if v('precip_rate') is None else round(v('precip_rate') * 8766),
            'permafrost_frac': None if v('permafrost_frac') is None else round(v('permafrost_frac'), 2)}


def card(body, qlat, qlon, lat, lon, km):
    lat, lon, km = round(float(lat), 4), round(float(lon), 4), int(km)
    k = f'{lat},{lon},{km}'
    with ThreadPoolExecutor(5) as ex:
        f_s1 = ex.submit(_cached, 's1:' + k, sentinel1, lat, lon, km)
        f_rcm = ex.submit(_cached, 'rcm:' + k, rcm, lat, lon, km)
        f_r1 = ex.submit(_cached, 'r1:' + k, radarsat1, lat, lon)
        f_ed = ex.submit(_cached, 'ed:' + k, earthdata, lat, lon, km)
        s1, rc, r1, ed = f_s1.result(), f_rcm.result(), f_r1.result(), f_ed.result()
    moon_cpr = None
    if body == 'moon':
        from scripts.facets_v61 import moon as M
        try:
            moon_cpr = M.radar(float(qlat), float(qlon), km)
        except Exception:  # noqa: BLE001
            moon_cpr = None
    s1v = s1 if isinstance(s1, dict) and 'error' not in s1 else None
    em = earth_measured(lat, lon)
    wv = _cached('wv2:' + k, worldview, lat, lon, km, em)
    return {'radar': {'sentinel1': s1, 'rcm': rc, 'radarsat1': r1, 'moon_minirf': moon_cpr, 'compare': radar_compare(moon_cpr, s1v)},
            'earthdata': ed, 'worldview': wv, 'earth': em, 'bbox': bbox(lat, lon, km)}
