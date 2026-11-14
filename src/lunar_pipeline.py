"""Local Moon/Earth terrain preparation and tiny neural embedding model."""

from __future__ import annotations

import json
import math
import zipfile
from io import BytesIO
from functools import lru_cache
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window
import torch
from scipy.ndimage import distance_transform_edt, map_coordinates
from torch import nn

from etopo_sampling import pixel_coordinates, sample_pixels
from global_pixel_centers import sample_full as sample_global_centers, sample_windowed as sample_global_window


ROOT = Path(__file__).resolve().parents[1]
MOON_DEM = ROOT / "data/moon/ldem_16_uint.tif"
MOON_DEM_HI = ROOT / "data/moon/ldem_64_uint.tif"
EARTH_METADATA = ROOT / "data/demo/metadata.json"
MODEL_PATH = ROOT / "data/moon/tiny_terrain_encoder.pt"
DIVINER_BASE = ROOT / "data/moon"
GLOBAL_EARTH_DEM = ROOT / "data/earth_global/etopo_2022_60s_surface.tif"
ETOPO_15S_TILE_DIR = ROOT / "data/earth_global/etopo_15s_tiles"
GLIM_ARCHIVE = ROOT / "data/earth_global/glim_05deg_2012.zip"
LP_FE_O = ROOT / "data/moon/lunar_prospector/ironhd.txt"
LP_TI = ROOT / "data/moon/lunar_prospector/titanium2d.txt"
KAGUYA_WEATHERING_DIR = ROOT / "data/moon/kaguya_space_weathering"
PATCH_KM = 81.92
SCALES_KM = (20, 40, 80)
SIZE = 32
GLIM_CLASSES = {
    1: ("su", "未固結沉積物"), 2: ("vb", "基性火山岩"),
    3: ("ss", "矽質碎屑沉積岩"), 4: ("pb", "基性深成岩"),
    5: ("sm", "混合沉積岩"), 6: ("sc", "碳酸鹽沉積岩"),
    7: ("va", "酸性火山岩"), 8: ("mt", "變質岩"),
    9: ("pa", "酸性深成岩"), 10: ("vi", "中性火山岩"),
    11: ("wb", "水體"), 12: ("py", "火山碎屑岩"),
    13: ("pi", "中性深成岩"), 14: ("ev", "蒸發岩"),
    15: ("nd", "未分類"), 16: ("ig", "冰與冰川"),
}


class TinyTerrainEncoder(nn.Module):
    """6,424 parameter CNN; outputs a 24-dimensional unit terrain embedding."""

    def __init__(self):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(2, 8, 3, padding=1), nn.GELU(), nn.AvgPool2d(2),
            nn.Conv2d(8, 16, 3, padding=1), nn.GELU(), nn.AvgPool2d(2),
            nn.Conv2d(16, 24, 3, padding=1), nn.GELU(), nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Sequential(nn.Linear(25, 32), nn.GELU(), nn.Linear(32, 24))

    def forward(self, terrain: torch.Tensor, relief: torch.Tensor) -> torch.Tensor:
        pooled = self.conv(terrain).flatten(1)
        return nn.functional.normalize(self.head(torch.cat((pooled, relief[:, None]), 1)), dim=1)


@lru_cache(maxsize=1)
def lunar_dem() -> np.ndarray:
    source = MOON_DEM_HI if MOON_DEM_HI.exists() and MOON_DEM_HI.stat().st_size > 500_000_000 else MOON_DEM
    with rasterio.open(source) as src:
        # NASA SVS: unsigned pixels have +20,000 half-meter offset.
        raw = src.read(1)
    return raw


def moon_patch(lat: float, lon: float, size: int = SIZE, patch_km: float = PATCH_KM,
               dem_data: np.ndarray | None = None) -> np.ndarray:
    """Sample a geodesic square from the supplied or highest available LOLA raster."""
    lat = float(np.clip(lat, -89.5, 89.5))
    lon = ((float(lon) + 180.0) % 360.0) - 180.0
    dem = lunar_dem() if dem_data is None else dem_data
    ppd = dem.shape[0] / 180.0
    lat0, lon0 = math.radians(lat), math.radians(lon)
    center = np.array([math.cos(lat0) * math.cos(lon0), math.sin(lat0),
                       math.cos(lat0) * math.sin(lon0)])
    east = np.array([-math.sin(lon0), 0.0, math.cos(lon0)])
    north = np.array([-math.sin(lat0) * math.cos(lon0), math.cos(lat0),
                      -math.sin(lat0) * math.sin(lon0)])
    ex, ny = np.meshgrid(np.linspace(-patch_km / 2, patch_km / 2, size),
                         np.linspace(patch_km / 2, -patch_km / 2, size))
    rho = np.hypot(ex, ny)
    theta = rho / 1737.4
    tangent = ex[..., None] * east + ny[..., None] * north
    unit = center * np.cos(theta)[..., None] + tangent * (np.sin(theta) / np.maximum(rho, 1e-9))[..., None]
    latitudes = np.degrees(np.arcsin(np.clip(unit[..., 1], -1, 1)))
    longitudes = np.degrees(np.arctan2(unit[..., 2], unit[..., 0]))
    yy = np.clip((90.0 - latitudes) * ppd, 0, dem.shape[0] - 1)
    xx = ((longitudes + 180.0) * ppd) % dem.shape[1]
    return (map_coordinates(dem, [yy, xx], order=1, mode="wrap").astype(np.float32) - 20000.0) * 0.5


@lru_cache(maxsize=1)
def earth_sites() -> dict[str, dict]:
    metadata = json.loads(EARTH_METADATA.read_text(encoding="utf-8"))
    sites = {}
    for item in metadata["earth_candidates"]:
        with rasterio.open(ROOT / "data/demo" / item["file"]) as src:
            data = src.read(1, masked=True).astype(np.float32).filled(np.nan)
            transform = src.transform
            crs = str(src.crs)
        missing = ~np.isfinite(data)
        if missing.any():
            nearest = distance_transform_edt(missing, return_distances=False, return_indices=True)
            data = data[tuple(nearest)]
        sites[Path(item["file"]).stem] = {"metadata": item, "grid": data,
                                         "stored_valid_mask": ~missing,
                                         "transform": transform, "crs": crs}
    return sites


def earth_patch(grid: np.ndarray, size: int = SIZE, scale: float = 1.0,
                center_y: float = 0.5, center_x: float = 0.5) -> np.ndarray:
    h, w = grid.shape
    half = scale * min(h, w) / 2
    ys = np.linspace(center_y * (h - 1) - half, center_y * (h - 1) + half, size)
    xs = np.linspace(center_x * (w - 1) - half, center_x * (w - 1) + half, size)
    xx, yy = np.meshgrid(np.clip(xs, 0, w - 1), np.clip(ys, 0, h - 1))
    return map_coordinates(grid, [yy, xx], order=1, mode="nearest").astype(np.float32)


@lru_cache(maxsize=1)
def global_earth_dem() -> np.ndarray:
    """NOAA ETOPO 2022 60 arc-second ice-surface global elevation."""
    with rasterio.open(GLOBAL_EARTH_DEM) as src:
        return src.read(1)


@lru_cache(maxsize=1)
def global_earth_transform():
    with rasterio.open(GLOBAL_EARTH_DEM) as src:
        return src.transform


def global_earth_patch(lat: float, lon: float, patch_km: float = 80,
                       size: int = SIZE) -> np.ndarray:
    """Approximate metric square, using source pixel centers and periodic longitude."""
    return sample_global_centers(global_earth_dem(), global_earth_transform(),
                                 lat, lon, patch_km, size)


def global_earth_patch_windowed(lat: float, lon: float, patch_km: float = 80,
                                size: int = SIZE) -> np.ndarray:
    """Pixel-center equivalent of the full sampler, reading only needed strips."""
    with rasterio.open(GLOBAL_EARTH_DEM) as src:
        return sample_global_window(src, lat, lon, patch_km, size)


def etopo_15s_patch(lat: float, lon: float, patch_km: float, tile: str,
                    size: int = SIZE) -> np.ndarray:
    """Read an indexed 15s window using the same pixel centers as the index."""
    path = ETOPO_15S_TILE_DIR / tile
    if path.parent != ETOPO_15S_TILE_DIR or not path.is_file():
        raise FileNotFoundError(f"NOAA 15s source tile unavailable: {tile}")
    with rasterio.open(path) as src:
        ys, xs = pixel_coordinates(src.bounds.top, src.bounds.left,
                                   lat, lon, patch_km, size)
        # Indexed centers are rounded to 5 decimals; tolerate subpixel drift
        # and use the index builder's nearest-edge sampling convention.
        if min(ys) < -1 or max(ys) > src.height or min(xs) < -1 or max(xs) > src.width:
            raise ValueError(f"Indexed 15s patch crosses tile edge: {tile}")
        row0, col0 = max(0, math.floor(min(ys)) - 1), max(0, math.floor(min(xs)) - 1)
        row1 = min(src.height, math.ceil(max(ys)) + 2)
        col1 = min(src.width, math.ceil(max(xs)) + 2)
        pixels = src.read(1, window=Window(col0, row0, col1 - col0, row1 - row0))
        return sample_pixels(pixels, ys, xs, row_offset=row0, col_offset=col0)


def model_input(grid: np.ndarray) -> tuple[np.ndarray, np.float32]:
    grid = np.asarray(grid, dtype=np.float32)
    relief = max(float(np.percentile(grid, 90) - np.percentile(grid, 10)), 1.0)
    height = np.clip((grid - np.median(grid)) / relief, -3, 3)
    gy, gx = np.gradient(height)
    gradient = np.clip(np.hypot(gx, gy) * SIZE / 4, 0, 3)
    tensor = np.stack((height, gradient)).astype(np.float32)
    relief_feature = np.float32((math.log1p(relief) - math.log1p(500)) / 5)
    return tensor, relief_feature


def embed(model: TinyTerrainEncoder, grid: np.ndarray) -> np.ndarray:
    values, relief = model_input(grid)
    with torch.inference_mode():
        vector = model(torch.from_numpy(values[None]),
                       torch.tensor([relief], dtype=torch.float32))
    return vector.numpy()[0]


def mesh_payload(grid: np.ndarray, size: int = 64) -> dict:
    if grid.shape != (size, size):
        yy = np.linspace(0, grid.shape[0] - 1, size)
        xx = np.linspace(0, grid.shape[1] - 1, size)
        xx, yy = np.meshgrid(xx, yy)
        grid = map_coordinates(grid, [yy, xx], order=1)
    center = float(np.median(grid))
    relative = grid - center
    return {
        "size": size,
        "heights_m": np.round(relative, 1).flatten().tolist(),
        "relief_m": round(float(np.percentile(grid, 90) - np.percentile(grid, 10)), 1),
        "min_m": round(float(np.min(grid)), 1),
        "max_m": round(float(np.max(grid)), 1),
    }


def material_observation(lat: float, lon: float, patch_km: float) -> dict:
    """Summarize real Diviner CF and rock-fraction pixels, with explicit limits.

    CF is a compositional proxy, not a directly measured mineral abundance.
    The low/high thresholds are empirical quartiles of the global valid map.
    """
    files = {
        "cf": DIVINER_BASE / "dgdr_std_cf_clc_cyl_032_img.img",
        "rock": DIVINER_BASE / "dgdr_ra_avg_cyl_032_img.img",
    }
    if any(not path.exists() or path.stat().st_size != 88_473_600 for path in files.values()):
        return {"available": False, "reason": "Diviner spectral and rock-cover rasters unavailable"}
    half_lat = patch_km / 30.32 / 2
    half_lon = half_lat / max(math.cos(math.radians(lat)), 0.35)
    y0 = max(0, int(math.floor((60 - lat - half_lat) * 32)))
    y1 = min(3840, int(math.ceil((60 - lat + half_lat) * 32)))
    if y1 <= y0:
        return {"available": False, "reason": "Outside Diviner ±60° latitude coverage"}
    longitude = lon % 360
    xs = np.arange(int(math.floor((longitude - half_lon) * 32)),
                   int(math.ceil((longitude + half_lon) * 32))) % 11520
    result = {"available": True, "source": "LRO Diviner GDR L3 32 ppd",
              "source_url": "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_gdr_l3/cylindrical/img/"}
    for key, file in files.items():
        data = np.memmap(file, dtype="<i2", mode="r", shape=(3840, 11520))
        values = np.asarray(data[y0:y1][:, xs], dtype=np.int16)
        valid = values[values != -32768]
        result[f"{key}_coverage"] = round(valid.size / max(values.size, 1), 3)
        result[f"{key}_median"] = round(float(np.median(valid)) * 0.001, 4) if valid.size else None
    cf = result["cf_median"]
    if cf is None:
        result["tendency"] = "光譜覆蓋不足"
    elif cf <= 8.093:
        result["tendency"] = "偏長石質光譜傾向"
    elif cf >= 8.221:
        result["tendency"] = "偏鎂鐵質光譜傾向"
    else:
        result["tendency"] = "中間光譜傾向"
    result["interpretation"] = "CF quartile-based compositional tendency; not a mineral identification or calibrated probability"
    return result


@lru_cache(maxsize=1)
def lunar_prospector_maps() -> tuple[np.ndarray, np.ndarray]:
    """Load PDS Lunar Prospector GRS elemental products with their native bins."""
    iron = np.loadtxt(LP_FE_O, delimiter=",", comments="#", usecols=(4,), dtype=np.float32)
    if iron.size != 360 * 720:
        raise ValueError(f"Unexpected LP FeO grid length: {iron.size}")
    titanium = np.loadtxt(LP_TI, delimiter=",", comments="#", dtype=np.float32)
    if titanium.shape != (11306, 5):
        raise ValueError(f"Unexpected LP Ti bin table: {titanium.shape}")
    # The iron table runs south-to-north and west-to-east at 0.5° spacing.
    return iron.reshape(360, 720), titanium


def kaguya_space_weathering_observation(lat: float, lon: float, patch_km: float) -> dict:
    """Summarize PDS Kaguya MI derived iron phases in the selected Moon square.

    These are published radiative-transfer estimates, not our model predictions
    and not mineral species or total elemental iron abundance.
    """
    codes = {"nanophase": "npfe", "microphase": "mpfe", "submicroscopic": "smfe"}
    paths = {key: KAGUYA_WEATHERING_DIR / f"kaguya_mi_derived_30ppd_{code}.img"
             for key, code in codes.items()}
    expected_bytes = 3600 * 10800 * 4
    source = "https://pds-geosciences.wustl.edu/missions/kaguya/trang_moon.htm"
    if any(not path.is_file() or path.stat().st_size != expected_bytes
           for path in paths.values()):
        return {"available": False, "reason": "Kaguya MI iron-phase maps unavailable",
                "source_url": source}
    half_lat = patch_km / 30.32 / 2
    half_lon = half_lat / max(math.cos(math.radians(lat)), 0.35)
    y0 = max(0, int(math.floor((60 - lat - half_lat) * 30)))
    y1 = min(3600, int(math.ceil((60 - lat + half_lat) * 30)))
    if y1 <= y0:
        return {"available": False, "reason": "Outside Kaguya MI ±60° latitude coverage",
                "source_url": source}
    xs = np.arange(int(math.floor((lon + 180 - half_lon) * 30)),
                   int(math.ceil((lon + 180 + half_lon) * 30))) % 10800
    if xs.size == 0:
        return {"available": False, "reason": "Empty Kaguya MI window",
                "source_url": source}
    result = {"available": True, "source": "PDS Kaguya MI / Trang & Lucey 2019",
              "source_url": source, "resolution": "30 pixels per degree (~1 km)",
              "unit": "weight percent", "coverage_latitude": "±60°",
              "interpretation": "Hapke-modelled space-weathering iron phases; not mineral classification"}
    for name, path in paths.items():
        data = np.memmap(path, dtype="<f4", mode="r", shape=(3600, 10800))
        values = np.asarray(data[y0:y1][:, xs], dtype=np.float32)
        valid = values[np.isfinite(values) & (values >= 0)]
        result[f"{name}_coverage"] = round(float(valid.size / values.size), 3)
        result[f"{name}_wt_percent"] = round(float(np.median(valid)), 3) if valid.size else None
    if all(result[f"{name}_wt_percent"] is None for name in codes):
        result["available"] = False
        result["reason"] = "No valid Kaguya MI pixels in selected window"
    return result


def lunar_geochemistry_observation(lat: float, lon: float, patch_km: float) -> dict:
    """Summarize published regional FeO/Ti estimates; never label them site minerals."""
    source = "https://pds-geosciences.wustl.edu/missions/lunarp/reduced_special.html"
    if not LP_FE_O.exists() or not LP_TI.exists():
        return {"available": False, "reason": "Lunar Prospector maps unavailable", "source_url": source}
    iron, titanium = lunar_prospector_maps()
    half_lat = patch_km / 30.32 / 2
    half_lon = half_lat / max(math.cos(math.radians(lat)), 0.08)
    latitudes = np.clip(lat + np.linspace(-half_lat, half_lat, 9), -89.999, 89.999)
    longitudes = lon + np.linspace(-half_lon, half_lon, 9)
    ys = np.clip(np.floor((latitudes + 90) * 2).astype(int), 0, 359)
    xs = np.floor(((longitudes + 180) % 360) * 2).astype(int) % 720
    fe_values = iron[np.ix_(ys, xs)]
    longitude = ((lon + 180) % 360) - 180
    ti_bin = titanium[(titanium[:, 0] <= lat) & (lat < titanium[:, 1]) &
                      (titanium[:, 2] <= longitude) & (longitude < titanium[:, 3])]
    if ti_bin.shape[0] != 1:
        raise ValueError(f"Expected one LP Ti bin at {lat}, {lon}; found {ti_bin.shape[0]}")
    return {
        "available": True,
        "feo_weight_percent": round(float(np.median(fe_values)), 2),
        "feo_p10_p90": [round(float(x), 2) for x in np.percentile(fe_values, [10, 90])],
        "titanium_weight_percent": round(float(ti_bin[0, 4]), 3),
        "titanium_bin_degrees": [round(float(ti_bin[0, 1] - ti_bin[0, 0]), 2),
                                 round(float(ti_bin[0, 3] - ti_bin[0, 2]), 2)],
        "source": "Lunar Prospector GRS elemental abundance products",
        "source_url": source,
        "interpretation": "Derived regional oxide/element abundances, not a site-scale mineral identification",
    }


@lru_cache(maxsize=1)
def glim_grid() -> np.ndarray:
    """Read Hartmann & Moosdorf's 0.5° categorical GLiM grid."""
    with zipfile.ZipFile(GLIM_ARCHIVE) as archive:
        raw = archive.read("glim_wgs84_0point5deg.txt.asc")
    grid = np.loadtxt(BytesIO(raw), skiprows=6, dtype=np.int16)
    if grid.shape != (360, 720):
        raise ValueError(f"Unexpected GLiM grid shape: {grid.shape}")
    return grid


def earth_lithology_observation(lat: float, lon: float, patch_km: float) -> dict:
    """Regional mapped rock class; not a window-scale mineral prediction."""
    source = "https://doi.org/10.1594/PANGAEA.788537"
    if not GLIM_ARCHIVE.exists():
        return {"available": False, "reason": "GLiM grid unavailable", "source_url": source}
    grid = glim_grid()
    half_lat = patch_km / 111.32 / 2
    half_lon = half_lat / max(math.cos(math.radians(lat)), 0.08)
    latitudes = np.clip(lat + np.linspace(-half_lat, half_lat, 9), -89.999, 89.999)
    longitudes = lon + np.linspace(-half_lon, half_lon, 9)
    ys = np.clip(np.floor((90 - latitudes) * 2).astype(int), 0, 359)
    xs = np.floor(((longitudes + 180) % 360) * 2).astype(int) % 720
    values = grid[np.ix_(ys, xs)].ravel()
    valid = values[(values >= 1) & (values <= 16) & (values != 15)]
    if not valid.size:
        return {"available": False, "reason": "No mapped lithology here", "source_url": source}
    codes, counts = np.unique(valid, return_counts=True)
    top = int(codes[np.argmax(counts)])
    code, label = GLIM_CLASSES[top]
    return {
        "available": True, "code": code, "label": label,
        "mapped_fraction": round(float(valid.size / values.size), 3),
        "sample_share": round(float(counts.max() / valid.size), 3),
        "source": "GLiM v1.0 (Hartmann & Moosdorf 2012)",
        "source_url": source,
        "license": "CC BY 3.0",
        "resolution": "0.5° grid (~55 km north-south)",
        "interpretation": "Regional mapped lithology, not mineral abundance or a site-scale prediction",
    }


def load_model() -> TinyTerrainEncoder:
    checkpoint = torch.load(MODEL_PATH, map_location="cpu", weights_only=True)
    model = TinyTerrainEncoder()
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return model
