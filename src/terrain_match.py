#!/usr/bin/env python3
"""Rank candidate DEM grids against a reference using interpretable features."""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
from typing import Any

import numpy as np


SLOPE_BINS_DEG = np.array([0, 2, 5, 10, 20, 35, 50, 70, 90], dtype=float)


def read_grid(path: Path) -> np.ndarray:
    """Read a rectangular CSV or single-band GeoTIFF DEM."""
    if path.suffix.lower() in {".tif", ".tiff"}:
        try:
            import rasterio
        except ImportError as exc:
            raise RuntimeError("GeoTIFF support requires rasterio; install requirements.txt") from exc
        with rasterio.open(path) as dataset:
            grid = dataset.read(1, masked=True).astype(np.float64).filled(np.nan)
        if grid.ndim != 2 or min(grid.shape) < 3:
            raise ValueError(f"{path}: DEM must be at least 3 by 3 cells")
        if np.isfinite(grid).sum() < 9:
            raise ValueError(f"{path}: fewer than 9 valid elevation cells")
        return grid

    if path.suffix.lower() != ".csv":
        raise ValueError(f"{path}: supported formats are CSV and single-band GeoTIFF")
    rows: list[list[float]] = []
    with path.open("r", newline="", encoding="utf-8-sig") as f:
        for row in csv.reader(f):
            if not row or all(not cell.strip() for cell in row):
                continue
            values = []
            for cell in row:
                value = cell.strip()
                values.append(float(value) if value else float("nan"))
            rows.append(values)

    if len(rows) < 3 or min(map(len, rows)) < 3:
        raise ValueError(f"{path}: DEM must be at least 3 by 3 cells")
    widths = {len(row) for row in rows}
    if len(widths) != 1:
        raise ValueError(f"{path}: DEM rows have inconsistent lengths")
    grid = np.asarray(rows, dtype=np.float64)
    if np.isfinite(grid).sum() < 9:
        raise ValueError(f"{path}: fewer than 9 valid elevation cells")
    return grid


def _finite_stats(values: np.ndarray) -> dict[str, float]:
    values = values[np.isfinite(values)]
    if values.size == 0:
        return {k: 0.0 for k in ("mean", "std", "p10", "p50", "p90")}
    return {
        "mean": float(np.mean(values)),
        "std": float(np.std(values)),
        "p10": float(np.percentile(values, 10)),
        "p50": float(np.percentile(values, 50)),
        "p90": float(np.percentile(values, 90)),
    }


def _valid_neighborhood(mask: np.ndarray, radius: int) -> np.ndarray:
    """Cells whose full square neighborhood is valid, for edge-safe derivatives."""
    result = np.zeros_like(mask, dtype=bool)
    h, w = mask.shape
    if h <= 2 * radius or w <= 2 * radius:
        return result
    core = np.ones((h - 2 * radius, w - 2 * radius), dtype=bool)
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            core &= mask[radius + dy:h - radius + dy,
                         radius + dx:w - radius + dx]
    result[radius:h - radius, radius:w - radius] = core
    return result


def describe_terrain(grid: np.ndarray, pixel_size: float) -> dict[str, Any]:
    """Compute scale-aware terrain descriptors from a regular DEM grid."""
    valid = np.isfinite(grid)
    if valid.sum() < 9:
        raise ValueError("DEM has too few valid cells")

    # Fill holes with the valid median for derivative computation only.
    filled = np.where(valid, grid, np.nanmedian(grid))
    dz_dy, dz_dx = np.gradient(filled, pixel_size, pixel_size)
    slope_deg = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy)))

    # Laplacian curvature and local neighbor relief as simple, reproducible proxies.
    d2x = np.gradient(dz_dx, pixel_size, axis=1)
    d2y = np.gradient(dz_dy, pixel_size, axis=0)
    curvature = d2x + d2y

    neighbor_diffs = []
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        a = filled[max(0, dy): filled.shape[0] + min(0, dy),
                   max(0, dx): filled.shape[1] + min(0, dx)]
        b = filled[max(0, -dy): filled.shape[0] - max(0, dy),
                   max(0, -dx): filled.shape[1] - max(0, dx)]
        va = valid[max(0, dy): valid.shape[0] + min(0, dy),
                   max(0, dx): valid.shape[1] + min(0, dx)]
        vb = valid[max(0, -dy): valid.shape[0] - max(0, dy),
                   max(0, -dx): valid.shape[1] - max(0, dx)]
        if a.size and b.size:
            neighbor_diffs.append(np.abs(a - b)[va & vb])
    roughness = np.concatenate(neighbor_diffs) if neighbor_diffs else np.array([0.0])

    elevation_stats = _finite_stats(grid[valid])
    slope_valid = _valid_neighborhood(valid, 1)
    curvature_valid = _valid_neighborhood(valid, 2)
    slope_stats = _finite_stats(slope_deg[slope_valid])
    curvature_stats = _finite_stats(curvature[curvature_valid])
    roughness_stats = _finite_stats(roughness)
    hist, _ = np.histogram(slope_deg[slope_valid], bins=SLOPE_BINS_DEG)
    hist = hist.astype(float) / max(float(hist.sum()), 1.0)

    return {
        "grid_shape": [int(grid.shape[0]), int(grid.shape[1])],
        "valid_fraction": float(valid.mean()),
        "pixel_size_m": float(pixel_size),
        "relief_p90_p10": elevation_stats["p90"] - elevation_stats["p10"],
        "slope_deg": slope_stats,
        "roughness_m": roughness_stats,
        "curvature_per_m": curvature_stats,
        "slope_histogram": hist.tolist(),
    }


FEATURE_WEIGHTS = {
    "relief_p90_p10": 1.0,
    "slope_mean": 1.0,
    "slope_std": 0.75,
    "roughness_median": 1.0,
    "roughness_p90": 0.75,
    "curvature_std": 0.5,
    "slope_histogram": 1.0,
}


def _log_ratio(a: float, b: float) -> float:
    """Symmetric relative difference, robust near zero."""
    eps = 1e-6
    return abs(math.log((abs(a) + eps) / (abs(b) + eps)))


def compare_features(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """Return an interpretable distance and 0-100 similarity score."""
    components: dict[str, float] = {
        "relief_p90_p10": _log_ratio(a["relief_p90_p10"], b["relief_p90_p10"]),
        "slope_mean": abs(a["slope_deg"]["mean"] - b["slope_deg"]["mean"]) / 45.0,
        "slope_std": abs(a["slope_deg"]["std"] - b["slope_deg"]["std"]) / 45.0,
        "roughness_median": _log_ratio(a["roughness_m"]["p50"], b["roughness_m"]["p50"]),
        "roughness_p90": _log_ratio(a["roughness_m"]["p90"], b["roughness_m"]["p90"]),
        "curvature_std": _log_ratio(a["curvature_per_m"]["std"], b["curvature_per_m"]["std"]),
        "slope_histogram": float(np.abs(np.asarray(a["slope_histogram"]) - np.asarray(b["slope_histogram"])).sum() / 2),
    }
    total_weight = sum(FEATURE_WEIGHTS.values())
    distance = sum(FEATURE_WEIGHTS[k] * components[k] for k in components) / total_weight
    score = 100.0 * math.exp(-distance)
    return {"similarity_score": round(score, 2), "feature_distance": round(distance, 5),
            "feature_distances": {k: round(v, 5) for k, v in components.items()}}


def rank_candidates(reference_path: Path, candidate_dir: Path, pixel_size: float) -> list[dict[str, Any]]:
    ref_features = describe_terrain(read_grid(reference_path), pixel_size)
    results = []
    paths = sorted([*candidate_dir.glob("*.csv"), *candidate_dir.glob("*.tif"),
                    *candidate_dir.glob("*.tiff")])
    # Candidate directories may also contain co-registered RGB imagery.
    # Terrain descriptors require a single elevation band, so skip multiband rasters.
    paths = [path for path in paths if path.suffix.lower() == ".csv" or _is_singleband_raster(path)]
    for path in paths:
        candidate_features = describe_terrain(read_grid(path), pixel_size)
        results.append({
            "candidate": path.stem,
            **compare_features(ref_features, candidate_features),
            "candidate_features": candidate_features,
        })
    results.sort(key=lambda item: item["similarity_score"], reverse=True)
    for i, result in enumerate(results, start=1):
        result["rank"] = i
    return [{"reference": reference_path.stem, "reference_features": ref_features,
             "candidates": results}]


def _is_singleband_raster(path: Path) -> bool:
    import rasterio
    with rasterio.open(path) as dataset:
        return dataset.count == 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", required=True, type=Path, help="Reference DEM CSV or GeoTIFF")
    parser.add_argument("--candidates", required=True, type=Path, help="Directory of candidate DEM CSV/GeoTIFF files")
    parser.add_argument("--pixel-size", required=True, type=float, help="Cell spacing in metres; same for every input")
    parser.add_argument("--output", type=Path, help="Write results JSON to this path (default: stdout)")
    args = parser.parse_args()
    if args.pixel_size <= 0:
        parser.error("--pixel-size must be greater than zero")
    if not args.candidates.is_dir():
        parser.error("--candidates must be an existing directory")

    result = rank_candidates(args.reference, args.candidates, args.pixel_size)[0]
    serialized = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized + "\n", encoding="utf-8")
    else:
        print(serialized)


if __name__ == "__main__":
    main()
