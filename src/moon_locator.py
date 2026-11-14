"""Render a local LOLA shaded-relief locator for precise lunar picking."""

from __future__ import annotations

from functools import lru_cache
from io import BytesIO

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

from lunar_pipeline import lunar_dem


@lru_cache(maxsize=24)
def shaded_locator_jpeg(center_x: float, center_y: float, zoom: int) -> bytes:
    """Return a 2:1 map viewport aligned with the site's equirectangular image."""
    if zoom not in (16, 32, 64) or not 0 <= center_x <= 1 or not 0 <= center_y <= 1:
        raise ValueError("Invalid lunar locator viewport")
    width, height = 900, 450
    dem = lunar_dem()
    world_x = center_x + ((np.arange(width) + 0.5) / width - 0.5) / zoom
    world_y = center_y + ((np.arange(height) + 0.5) / height - 0.5) / zoom
    xx = np.broadcast_to((world_x % 1) * dem.shape[1], (height, width))
    yy = np.broadcast_to(np.clip(world_y * dem.shape[0], 0, dem.shape[0] - 1)[:, None],
                         (height, width))
    elevations = map_coordinates(dem, [yy, xx], order=1, mode="nearest").astype(np.float32) * 0.5 - 10000

    latitudes = np.deg2rad(90 - world_y * 180)
    dx_m = (360 / zoom / width) * 30320 * np.maximum(np.cos(latitudes), 0.08)
    dy_m = (180 / zoom / height) * 30320
    east_slope = np.gradient(elevations, axis=1) / dx_m[:, None]
    north_slope = -np.gradient(elevations, axis=0) / dy_m
    norm = np.sqrt(1 + east_slope ** 2 + north_slope ** 2)
    # Fixed northwest illumination. This is visualization, never a model input.
    illumination = (-east_slope * -0.55 - north_slope * 0.59 + 0.59) / norm
    lo, hi = np.percentile(elevations, (3, 97))
    height_tone = np.clip((elevations - lo) / max(hi - lo, 1), 0, 1)
    gray = np.clip(48 + 157 * np.clip(illumination, 0, 1) + 24 * (height_tone - 0.5), 0, 255)
    rgb = np.stack((gray * 0.91, gray * 0.98, gray), axis=-1).astype(np.uint8)
    output = BytesIO()
    Image.fromarray(rgb, "RGB").save(output, format="JPEG", quality=86, optimize=True)
    return output.getvalue()
