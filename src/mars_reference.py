"""Two georeferenced Mars DEM reference windows for the interactive atlas.

The 81.92 km source rasters were prepared from the USGS MOLA/HRSC blended
global DEM. Smaller windows are sampled from their centers in local metres.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import numpy as np
import rasterio
from scipy.ndimage import map_coordinates


ROOT = Path(__file__).resolve().parents[1]
BASE_KM = 81.92
SOURCES = {
    "jezero": ROOT / "data/demo/metadata.json",
    "gale": ROOT / "data/demo/mars_gale/metadata.json",
}


@lru_cache(maxsize=1)
def catalog() -> dict[str, dict]:
    result = {}
    for key, metadata_path in SOURCES.items():
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))["mars"]
        path = ROOT / "data/demo" / metadata["file"]
        result[key] = {
            "id": key,
            "name": "Jezero Crater" if key == "jezero" else "Gale Crater",
            "latitude": metadata["center"]["latitude"],
            "longitude_east": metadata["center"]["longitude_east"],
            "source_name": metadata["source_name"],
            "source_url": metadata["source_url"],
            "source_page": metadata["source_page"],
            "source_raster": path.relative_to(ROOT).as_posix(),
            "source_resolution_m": metadata["pixel_size_m"],
            "source_coverage": metadata["valid_fraction"],
        }
    return result


@lru_cache(maxsize=2)
def _raster(key: str) -> np.ndarray:
    if key not in SOURCES:
        raise ValueError("Mars reference must be jezero or gale")
    path = ROOT / "data/demo" / json.loads(SOURCES[key].read_text(encoding="utf-8"))["mars"]["file"]
    with rasterio.open(path) as source:
        grid = source.read(1, masked=True).astype(np.float32).filled(np.nan)
    if grid.shape != (256, 256) or not np.isfinite(grid).all():
        raise ValueError(f"Mars reference DEM is incomplete: {key}")
    return grid


def mars_patch(key: str, patch_km: int, size: int = 32) -> np.ndarray:
    if key not in SOURCES:
        raise ValueError("Mars reference must be jezero or gale")
    if patch_km not in (20, 40, 80):
        raise ValueError("Mars patch must be 20, 40, or 80 km")
    source = _raster(key)
    half_pixels = patch_km / BASE_KM * source.shape[0] / 2
    center_y = (source.shape[0] - 1) / 2
    center_x = (source.shape[1] - 1) / 2
    ys = np.linspace(center_y - half_pixels, center_y + half_pixels, size)
    xs = np.linspace(center_x - half_pixels, center_x + half_pixels, size)
    xx, yy = np.meshgrid(xs, ys)
    return map_coordinates(source, [yy, xx], order=1, mode="nearest").astype(np.float32)


def reference(key: str) -> dict:
    if key not in SOURCES:
        raise ValueError("Mars reference must be jezero or gale")
    return catalog()[key].copy()
