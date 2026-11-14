"""Global coordinate selection on a local, source-labelled MOLA elevation grid."""
from functools import lru_cache
from pathlib import Path
import math
import numpy as np
from mars_reference import catalog, mars_patch

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / 'data/mars_global/megt90n000fb.img'
RADIUS_M = 3396000.0
SOURCE_PAGE = 'https://pds-geosciences.wustl.edu/missions/mgs/megdr.html'
SOURCE_URL = 'https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg032/megt90n000fb.img'

def validate(lat, lon, patch_km):
    if not math.isfinite(lat) or not math.isfinite(lon) or abs(lat) > 89.5 or abs(lon) > 180:
        raise ValueError('請選擇緯度 -89.5～89.5、經度 -180～180 的火星區域。')
    if patch_km not in (20, 40, 80):
        raise ValueError('火星搜尋尺度必須為 20、40 或 80 km。')

def saved_key(lat, lon):
    return next((key for key, item in catalog().items()
                 if abs(lat-item['latitude']) < 0.00001 and abs(lon-item['longitude_east']) < 0.00001), None)

def reference_at(lat, lon):
    key = saved_key(lat, lon)
    if key:
        return catalog()[key].copy()
    return dict(id='global', name='自由選取的火星區域', latitude=lat, longitude_east=lon,
                source_name='MGS MOLA MEGDR topography v2.0 (32 pixels/degree)',
                source_url=SOURCE_URL, source_page=SOURCE_PAGE,
                source_resolution_m=1853, source_coverage=1.0,
                source_note='全球粗尺度高程：原始南北格距約 1.85 km；插值不增加實測細節。')

@lru_cache(maxsize=1)
def global_raster():
    if not PATH.exists() or PATH.stat().st_size != 5760 * 11520 * 2:
        raise ValueError('火星全球高程尚未準備完成，請稍後重試。')
    return np.memmap(PATH, dtype='>i2', mode='r', shape=(5760, 11520))

def surface_coordinates(lat, lon, patch_km, size):
    """Spherical azimuthal equidistant square, including longitude wrap and poles."""
    axis = np.linspace(-patch_km * 500, patch_km * 500, size)
    east, north = np.meshgrid(axis, -axis)
    rho = np.hypot(east, north)
    angle = rho / RADIUS_M
    phi, lam = np.radians([lat, lon])
    ratio = np.divide(np.sin(angle), rho, out=np.full_like(rho, 1/RADIUS_M), where=rho != 0)
    latitude = np.arcsin(np.clip(np.cos(angle)*np.sin(phi) + north*ratio*np.cos(phi), -1, 1))
    longitude = lam + np.arctan2(east*ratio, np.cos(phi)*np.cos(angle)-north*np.sin(phi)*ratio)
    return np.degrees(latitude), np.degrees(longitude) % 360

def sample_grid(source, latitude, longitude):
    """Bilinear interpolation with cyclic columns and edge-clamped polar rows."""
    rows, cols = source.shape
    y = np.clip((90-latitude)*(rows/180)-0.5, 0, rows-1)
    x = (longitude*(cols/360)-0.5) % cols
    y0 = np.floor(y).astype(int); y1 = np.minimum(y0+1, rows-1)
    x0 = np.floor(x).astype(int); x1 = (x0+1) % cols
    fy, fx = y-y0, x-x0
    values = [source[y0,x0].astype(np.float64), source[y0,x1].astype(np.float64),
              source[y1,x0].astype(np.float64), source[y1,x1].astype(np.float64)]
    if any(np.any(value == -32768) for value in values):
        raise ValueError('此火星方框有缺失高程，請移動選區後重試。')
    return ((1-fy)*((1-fx)*values[0]+fx*values[1]) + fy*((1-fx)*values[2]+fx*values[3])).astype(np.float32)

@lru_cache(maxsize=128)
def patch_at(lat, lon, patch_km, size=32):
    validate(lat, lon, patch_km)
    key = saved_key(lat, lon)
    if key:
        return mars_patch(key, patch_km, size)
    latitude, longitude = surface_coordinates(lat, lon, patch_km, size)
    return sample_grid(global_raster(), latitude, longitude)
