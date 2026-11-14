"""Pixel-center sampling shared by ETOPO index construction and live queries."""

from __future__ import annotations

import math

import numpy as np
from scipy.ndimage import map_coordinates


PIXELS_PER_DEGREE = 240


def pixel_coordinates(top: float, left: float, lat: float, lon: float,
                      patch_km: int, size: int) -> tuple[np.ndarray, np.ndarray]:
    half_lat = patch_km / 111.32 / 2
    half_lon = half_lat / max(math.cos(math.radians(lat)), 0.08)
    ys = (top - (lat + np.linspace(half_lat, -half_lat, size))) * PIXELS_PER_DEGREE - 0.5
    xs = ((lon + np.linspace(-half_lon, half_lon, size)) - left) * PIXELS_PER_DEGREE - 0.5
    return ys, xs


def sample_pixels(grid: np.ndarray, ys: np.ndarray, xs: np.ndarray,
                  row_offset: int = 0, col_offset: int = 0) -> np.ndarray:
    xx, yy = np.meshgrid(xs - col_offset, ys - row_offset)
    return map_coordinates(grid, [yy, xx], order=1, mode="nearest").astype(np.float32)
