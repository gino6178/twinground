"""Small-window geomorphon/co-occurrence retrieval based on Jasiewicz et al. 2014.

Ten-form lookup follows GRASS GIS r.geomorphon ``determine_form``.  The
eight-direction angle calculation is a vectorized local-radius adaptation;
the 55-bin unordered neighbor co-occurrence signature and modified
Wave-Hedges similarity follow the 2014 landscape-retrieval paper.  At 200 m
with 31.25 m Earth DEM cells the descriptor is exploratory, not a rock label.
"""

from __future__ import annotations

import numpy as np

FORMS = ("無", "平地", "峰", "稜", "上坡肩", "側脊", "坡", "凹坡", "下坡腳", "谷", "坑")
# GRASS r.geomorphon geom.c: rows = number of lower views, columns = higher.
LOOKUP = np.array([
    [1, 1, 1, 8, 8, 9, 9, 9, 10],
    [1, 1, 8, 8, 8, 9, 9, 9, 0],
    [1, 4, 6, 6, 7, 7, 9, 0, 0],
    [4, 4, 6, 6, 6, 7, 0, 0, 0],
    [4, 4, 5, 6, 6, 0, 0, 0, 0],
    [3, 3, 5, 5, 0, 0, 0, 0, 0],
    [3, 3, 3, 0, 0, 0, 0, 0, 0],
    [3, 3, 0, 0, 0, 0, 0, 0, 0],
    [2, 0, 0, 0, 0, 0, 0, 0, 0],
], dtype=np.uint8)
DIRECTIONS = ((-1, -1), (-1, 0), (-1, 1), (0, 1),
              (1, 1), (1, 0), (1, -1), (0, -1))
PAIRS = tuple((a, b) for a in range(1, 11) for b in range(a, 11))
PAIR_INDEX = np.full((11, 11), -1, dtype=np.int16)
for _i, (_a, _b) in enumerate(PAIRS):
    PAIR_INDEX[_a, _b] = PAIR_INDEX[_b, _a] = _i


def _shift(grid: np.ndarray, dy: int, dx: int) -> np.ndarray:
    out = np.full(grid.shape, np.nan, dtype=np.float32)
    h, w = grid.shape
    ys = slice(max(0, -dy), min(h, h - dy))
    xs = slice(max(0, -dx), min(w, w - dx))
    out[ys, xs] = grid[ys.start + dy:ys.stop + dy, xs.start + dx:xs.stop + dx]
    return out


def geomorphons(grid: np.ndarray, spacing_m: float, radius_cells: int = 2,
                flat_angle_deg: float = 1.0) -> np.ndarray:
    """Classify local terrain into the GRASS ten-form categories, 0 = invalid."""
    z = np.asarray(grid, dtype=np.float32)
    if z.ndim != 2 or min(z.shape) < 5 or spacing_m <= 0:
        raise ValueError("Need a 2-D DEM of at least 5x5 and positive spacing")
    radius_cells = max(1, min(int(radius_cells), min(z.shape) // 3))
    upper_count = np.zeros(z.shape, dtype=np.uint8)
    lower_count = np.zeros(z.shape, dtype=np.uint8)
    valid_count = np.zeros(z.shape, dtype=np.uint8)
    threshold = np.deg2rad(flat_angle_deg)
    for dy, dx in DIRECTIONS:
        upper = np.full(z.shape, -np.inf, dtype=np.float32)
        lower = np.full(z.shape, np.inf, dtype=np.float32)
        seen = np.zeros(z.shape, dtype=bool)
        for step in range(1, radius_cells + 1):
            neighbor = _shift(z, dy * step, dx * step)
            ok = np.isfinite(neighbor) & np.isfinite(z)
            angle = np.arctan2(neighbor - z, spacing_m * step * np.hypot(dx, dy))
            upper = np.maximum(upper, np.where(ok, angle, -np.inf))
            lower = np.minimum(lower, np.where(ok, angle, np.inf))
            seen |= ok
        positive = seen & (upper > threshold) & (upper >= -lower)
        negative = seen & (lower < -threshold) & (-lower > upper)
        upper_count += positive.astype(np.uint8)
        lower_count += negative.astype(np.uint8)
        valid_count += seen.astype(np.uint8)
    forms = LOOKUP[lower_count, upper_count].copy()
    forms[(~np.isfinite(z)) | (valid_count < 6)] = 0
    return forms


def signature(forms: np.ndarray) -> np.ndarray:
    """55 unordered 8-connected form-pair frequencies, normalized to sum 1."""
    f = np.asarray(forms, dtype=np.uint8)
    counts = np.zeros(len(PAIRS), dtype=np.float64)
    # Four directions count every unordered 8-neighbor pair exactly once.
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        a = f[max(0, -dy):min(f.shape[0], f.shape[0] - dy),
              max(0, -dx):min(f.shape[1], f.shape[1] - dx)]
        b = f[max(0, dy):min(f.shape[0], f.shape[0] + dy),
              max(0, dx):min(f.shape[1], f.shape[1] + dx)]
        good = (a > 0) & (b > 0)
        counts += np.bincount(PAIR_INDEX[a[good], b[good]], minlength=len(PAIRS))
    total = counts.sum()
    return (counts / total).astype(np.float32) if total else counts.astype(np.float32)


def wave_hedges(query: np.ndarray, gallery: np.ndarray) -> np.ndarray:
    """Paper's mean min/max across bins present in either signature."""
    q = np.asarray(query, dtype=np.float32)
    g = np.atleast_2d(np.asarray(gallery, dtype=np.float32))
    larger = np.maximum(g, q)
    ratio = np.divide(np.minimum(g, q), larger,
                      out=np.zeros_like(larger), where=larger > 0)
    occupied = np.count_nonzero(larger > 0, axis=1)
    return np.divide(ratio.sum(axis=1), occupied,
                     out=np.zeros(len(g), dtype=np.float32), where=occupied > 0)


def best_overlay(moon: np.ndarray, earth: np.ndarray) -> tuple[int, float, np.ndarray]:
    """D4-aligned relief-normalized RMS for visual verification, separate from retrieval."""
    a = np.asarray(moon, dtype=np.float32)
    b = np.asarray(earth, dtype=np.float32)
    def normalized(x):
        relief = max(float(np.nanpercentile(x, 90) - np.nanpercentile(x, 10)), 0.1)
        return (x - np.nanmedian(x)) / relief
    a = normalized(a)
    b = normalized(b)
    best = (0, float("inf"), b)
    for flip in (False, True):
        base = np.fliplr(b) if flip else b
        for turns in range(4):
            rotated = np.rot90(base, turns)
            valid = np.isfinite(a) & np.isfinite(rotated)
            if valid.mean() < 0.9:
                continue
            gap = float(np.sqrt(np.mean((a[valid] - rotated[valid]) ** 2)))
            if gap < best[1]:
                best = (turns + 4 * int(flip), gap, rotated)
    return best
