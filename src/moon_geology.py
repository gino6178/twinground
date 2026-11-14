"""Fast lookup of the USGS 2020 Unified Geologic Map of the Moon.

The rasterized 1:5M polygon map is independent published geologic context.
It is neither a mineral assay nor a target for the current FeO proxy model.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
GRID_PATH = ROOT / "data/moon/usgs_moon_geologic_units_025deg.npz"
META_PATH = GRID_PATH.with_suffix(".json")
MOON_RADIUS_KM = 1737.4


@lru_cache(maxsize=1)
def _data() -> tuple[np.ndarray, dict]:
    with np.load(GRID_PATH) as data:
        grid = data["unit_id"].copy()
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    if grid.shape != tuple(meta["shape"]):
        raise ValueError("USGS geologic unit grid shape disagrees with its metadata")
    return grid, meta


def _square_coordinates(lat: float, lon: float, patch_km: float,
                        size: int = 13) -> tuple[np.ndarray, np.ndarray]:
    """Sample the same geodesic tangent-plane square geometry as moon_patch."""
    lat0, lon0 = math.radians(lat), math.radians(lon)
    center = np.array([math.cos(lat0) * math.cos(lon0), math.sin(lat0),
                       math.cos(lat0) * math.sin(lon0)])
    east = np.array([-math.sin(lon0), 0.0, math.cos(lon0)])
    north = np.array([-math.sin(lat0) * math.cos(lon0), math.cos(lat0),
                      -math.sin(lat0) * math.sin(lon0)])
    ex, ny = np.meshgrid(np.linspace(-patch_km / 2, patch_km / 2, size),
                         np.linspace(patch_km / 2, -patch_km / 2, size))
    rho = np.hypot(ex, ny)
    theta = rho / MOON_RADIUS_KM
    tangent = ex[..., None] * east + ny[..., None] * north
    unit = center * np.cos(theta)[..., None] + tangent * (
        np.sin(theta) / np.maximum(rho, 1e-9))[..., None]
    latitudes = np.degrees(np.arcsin(np.clip(unit[..., 1], -1, 1)))
    longitudes = np.degrees(np.arctan2(unit[..., 2], unit[..., 0]))
    return latitudes, longitudes


def geology_observation(lat: float, lon: float, patch_km: float) -> dict:
    grid, meta = _data()
    latitudes, longitudes = _square_coordinates(lat, lon, patch_km)
    step = float(meta["resolution_degrees"])
    yy = np.clip(np.floor((90 - latitudes) / step).astype(np.int32), 0, grid.shape[0] - 1)
    xx = np.floor(((longitudes + 180) % 360) / step).astype(np.int32)
    values = grid[yy, xx]
    valid = values[values > 0]
    center_id = int(values[values.shape[0] // 2, values.shape[1] // 2])
    base = {
        "available": len(valid) > 0,
        "source": "USGS Unified Geologic Map of the Moon, 2020",
        "source_url": meta["source_page"],
        "map_scale": meta["map_scale"],
        "sampling_note": "13×13 等距實地窗格抽樣；比例是格點占比，非量測信心或精確面積比例",
        "sampled_cells": int(values.size),
        "covered_cells": int(len(valid)),
    }
    if not len(valid):
        return base
    ids, counts = np.unique(valid, return_counts=True)
    order = np.argsort(counts)[::-1]
    units = []
    for index in order[:4]:
        unit_id = int(ids[index])
        units.append({**meta["unit_ids"][str(unit_id)],
                      "sample_fraction": round(float(counts[index] / len(valid)), 3)})
    base.update({
        "dominant_unit": units[0],
        "center_unit": meta["unit_ids"].get(str(center_id)),
        "top_units": units,
        "mixed": units[0]["sample_fraction"] < 0.6,
    })
    return base
