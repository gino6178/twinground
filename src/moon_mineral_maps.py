"""Published Kaguya MI mineral abundances for an interactive Moon window."""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import numpy as np

from fetch_kaguya_mineral_window import MINERALS, fetch_grid, source_url


SOURCE_PAGE = "https://astrogeology.usgs.gov/search/map/lunar-kaguya-multiband-imager-mosaics"


@lru_cache(maxsize=48)
def mineral_map_observation(lat: float, lon: float, size_km: int):
    lat = round(float(lat), 3)
    lon = round(float(lon), 3)
    size_km = int(size_km)
    if size_km not in (20, 40, 80):
        raise ValueError("Mineral window must be 20, 40, or 80 km")
    lat_half = size_km / (2 * 111.195)
    if abs(lat) + lat_half >= 50:
        return {"available": False, "reason": "Kaguya MI 四礦物圖只覆蓋南北緯 50°內", "source_url": SOURCE_PAGE}
    if abs(math.cos(math.radians(lat))) < 0.01:
        return {"available": False, "reason": "極區經度窗格超出圖層範圍", "source_url": SOURCE_PAGE}
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(fetch_grid, source_url(name), lat, lon, size_km, 16, 8)
                   for name in MINERALS]
        results = [future.result() for future in futures]
    fractions = np.stack([item[0] for item in results], axis=-1)
    valid = np.logical_and.reduce([item[1] for item in results])
    valid &= np.abs(fractions.sum(-1) - 1) < 0.02
    coverage = float(valid.mean())
    if coverage < 0.75:
        return {"available": False, "reason": f"四圖共同有效格點僅 {coverage:.0%}",
                "coverage_fraction": round(coverage, 4), "source_url": SOURCE_PAGE}
    median = np.median(fractions[valid], axis=0)
    # Four componentwise medians need not sum exactly to 100 wt%.
    dominant = np.argmax(fractions, axis=-1).astype(int)
    dominant[~valid] = -1
    return {
        "available": True,
        "source_url": SOURCE_PAGE,
        "source_label": "USGS Kaguya MI 512 ppd Hapke mineral deconvolution",
        "model_status": "Published independent-instrument orbital inversion, not SELENE model prediction or in-situ truth",
        "mineral_order": list(MINERALS),
        "median_weight_percent": [round(float(v * 100), 2) for v in median],
        "valid_fraction": round(coverage, 4),
        "sample_grid": [16, 16],
        "dominant_mineral_index_grid": dominant.tolist(),
        "raw_source_urls": [source_url(name) for name in MINERALS],
        "note": "Each bar is a separate sample median, so bar values may not sum to 100 wt%.",
    }
