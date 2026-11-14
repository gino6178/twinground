"""Approximate selected-window coverage from official LROC NAC DTM footprints.

The index reports where published stereo DTMs exist. It does not download a
DTM, infer local landforms, or increase the resolution of the LOLA preview.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np
from rasterio.features import rasterize
from rasterio.transform import from_bounds


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "data/research/lroc_nac_dtm_coverage/catalog.json"
SOURCE_URL = "https://data.lroc.im-ldi.com/lroc/view_rdr/SHAPEFILE_NAC_DTMS"
SAMPLE_CELLS = 21


@lru_cache(maxsize=1)
def catalog() -> dict:
    source = json.loads(CATALOG.read_text(encoding="utf-8"))
    if source["site_count"] != len(source["sites"]):
        raise ValueError("LROC catalog site count is inconsistent")
    return source


def bounds(lat: float, lon: float, side_km: float) -> tuple[float, float, float, float]:
    half_lat = side_km / (2 * 30.32)
    half_lon = half_lat / max(math.cos(math.radians(lat)), 0.01)
    return lon - half_lon, lat - half_lat, lon + half_lon, lat + half_lat


def intersects(site_bbox: list[float], window_bbox: tuple[float, float, float, float]) -> bool:
    west, south, east, north = window_bbox
    return site_bbox[0] <= east and site_bbox[2] >= west and site_bbox[1] <= north and site_bbox[3] >= south


def coverage_mask(site: dict, window_bbox: tuple[float, float, float, float]) -> np.ndarray:
    return rasterize([(site["geometry_lon_lat"], 1)], out_shape=(SAMPLE_CELLS, SAMPLE_CELLS),
                     transform=from_bounds(*window_bbox, SAMPLE_CELLS, SAMPLE_CELLS),
                     fill=0, dtype="uint8", all_touched=False).astype(bool)


def lroc_dtm_coverage(lat: float, lon: float, side_km: int) -> dict:
    """Return sampled official DTM footprint coverage around a Moon window.

    Coverage is a 21×21 lon/lat rasterization estimate, not exact polygon area
    or proof that a particular product's downloaded DEM has valid elevations.
    """
    if not (-89.5 <= lat <= 89.5 and -180 <= lon <= 180 and side_km in (20, 40, 80)):
        raise ValueError("Unsupported lunar window")
    if not CATALOG.is_file():
        return {"available": False, "reason": "LROC NAC DTM 覆蓋索引尚未安裝", "source_url": SOURCE_URL}
    source = catalog()
    selected = bounds(lat, lon, side_km)
    center_3km = bounds(lat, lon, 3)
    union_selected = np.zeros((SAMPLE_CELLS, SAMPLE_CELLS), dtype=bool)
    union_center = np.zeros_like(union_selected)
    matches = []
    for site in source["sites"]:
        if not (intersects(site["bbox_lon_lat"], selected) or
                intersects(site["bbox_lon_lat"], center_3km)):
            continue
        selected_mask = coverage_mask(site, selected)
        center_mask = coverage_mask(site, center_3km)
        if not (selected_mask.any() or center_mask.any()):
            continue
        union_selected |= selected_mask
        union_center |= center_mask
        matches.append({
            "id": site["id"], "name": site["name"], "url": site["url"],
            "resolution_m": site["resolution_m"],
            "relative_linear_error_m": site["relative_linear_error_m"],
            "lola_rms_m": site["lola_rms_m"],
            "selected_window_sampled_fraction": round(float(selected_mask.mean()), 4),
            "center_3km_sampled_fraction": round(float(center_mask.mean()), 4),
            "features_site_level_not_window_truth": site["features_site_level"],
        })
    matches.sort(key=lambda row: (-row["center_3km_sampled_fraction"],
                                  row["resolution_m"] or float("inf"),
                                  -row["selected_window_sampled_fraction"], row["id"]))
    return {
        "available": True,
        "source_url": SOURCE_URL,
        "source_release_through": source["source_release_through"],
        "catalog_site_count": source["site_count"],
        "sample_grid": [SAMPLE_CELLS, SAMPLE_CELLS],
        "selected_window_sampled_fraction": round(float(union_selected.mean()), 4),
        "center_3km_sampled_fraction": round(float(union_center.mean()), 4),
        "center_covered_by_dtm_footprint": bool(union_center[SAMPLE_CELLS // 2, SAMPLE_CELLS // 2]),
        "intersecting_product_count": len(matches),
        "products": matches[:5],
        "interpretation": "Published NAC stereo DTM footprint coverage sampled on a 21×21 lon/lat grid; not downloaded DEM validity or local material/landform truth",
    }
