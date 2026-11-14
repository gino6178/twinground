"""Build source-paired Jezero CTX windows on the existing 3 km / 96-cell grid.

The USGS product and our ASP reconstruction use the *same* CTX stereo pair.
Their agreement is a processing consistency check, never independent accuracy
or evidence that an Earth window is a Mars analog.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform

from build_highres_dem_cohort import (CELLS, MIN_VALID, ROOT, SIDE_M,
                                      SPACING_M, patch_summary, sha256)

OUT = ROOT / "data/research/highres_mars_dem"
USGS = ROOT / "data/demo/mars_ctx_stereo/dtm.tif"
REBUILT = ROOT / "data/demo/mars_ctx_stereo_self_rebuilt/ctx_edr_self_rebuilt_20m.tif"
USGS_HASH = "5f21d37d2c7d50c87f8d16b62e31f279a46e36e92b2710865ddd433f3cad8f3f"
REBUILT_HASH = "a42f3765905bc723a7f16a087c1c9d8cdd2e37a8d771c63e9c33afa21b5c9ba8"
MARS_RADIUS_M = 3396190
MARS_GEODETIC = CRS.from_proj4(f"+proj=longlat +R={MARS_RADIUS_M} +no_defs")


def local_crs(lat: float, lon: float) -> CRS:
    return CRS.from_proj4(
        f"+proj=aeqd +lat_0={lat:.9f} +lon_0={lon:.9f} "
        f"+R={MARS_RADIUS_M} +units=m +no_defs"
    )


def window(source: rasterio.io.DatasetReader, lat: float, lon: float) -> np.ndarray:
    grid = np.full((CELLS, CELLS), np.nan, dtype=np.float32)
    reproject(
        rasterio.band(source, 1), grid,
        src_crs=source.crs, src_nodata=source.nodata,
        dst_transform=from_origin(-SIDE_M / 2, SIDE_M / 2, SPACING_M, SPACING_M),
        dst_crs=local_crs(lat, lon), dst_nodata=np.nan,
        resampling=Resampling.average, num_threads=1,
    )
    return grid


def consistency(a: np.ndarray, b: np.ndarray) -> dict:
    valid = np.isfinite(a) & np.isfinite(b)
    av, bv = a[valid].astype(np.float64), b[valid].astype(np.float64)
    residual = (av - np.median(av)) - (bv - np.median(bv))
    return {
        "overlap_fraction": round(float(valid.mean()), 6),
        "median_centered_rmse_m": round(float(np.sqrt(np.mean(residual ** 2))), 3),
        "median_centered_mae_m": round(float(np.mean(np.abs(residual))), 3),
        "elevation_correlation": round(float(np.corrcoef(av, bv)[0, 1]), 5),
    }


def main() -> None:
    for source, expected in ((USGS, USGS_HASH), (REBUILT, REBUILT_HASH)):
        if not source.is_file():
            raise FileNotFoundError(source)
        if sha256(source) != expected:
            raise ValueError(f"Source checksum mismatch: {source}")

    rows, usgs_grids, rebuilt_grids = [], [], []
    with rasterio.open(USGS) as official, rasterio.open(REBUILT) as rebuilt:
        for source in (official, rebuilt):
            if source.count != 1 or source.nodata is None:
                raise ValueError(f"Unexpected CTX DTM metadata: {source.name}")
            if str(MARS_RADIUS_M) not in source.crs.to_wkt():
                raise ValueError(f"Unexpected Mars radius: {source.name}")
            if not 19 <= source.res[0] <= 21:
                raise ValueError(f"Unexpected CTX source spacing: {source.name}")
        x0 = (official.bounds.left + official.bounds.right) / 2
        y0 = (official.bounds.bottom + official.bounds.top) / 2
        for north_m in range(-20000, 20001, 4000):
            for east_m in range(-12000, 12001, 4000):
                lon, lat = transform(
                    official.crs, MARS_GEODETIC, [x0 + east_m], [y0 + north_m]
                )
                lat, lon = lat[0], lon[0]
                a = window(official, lat, lon)
                b = window(rebuilt, lat, lon)
                valid_a = float(np.isfinite(a).mean())
                valid_b = float(np.isfinite(b).mean())
                if min(valid_a, valid_b) < MIN_VALID:
                    continue
                row = {
                    "id": f"JEZERO_CTX_{east_m:+06d}_{north_m:+06d}",
                    "center_lat_lon": [round(lat, 7), round(lon, 7)],
                    "offset_east_north_m": [east_m, north_m],
                    "usgs_valid_fraction": round(valid_a, 6),
                    "rebuilt_valid_fraction": round(valid_b, 6),
                    "usgs": patch_summary(a),
                    "rebuilt": patch_summary(b),
                    "same_pair_consistency_only": consistency(a, b),
                }
                rows.append(row)
                usgs_grids.append(a)
                rebuilt_grids.append(b)
    if not rows:
        raise ValueError("No jointly valid Mars 3 km windows")

    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / "mars_ctx_3km_96.npz"
    np.savez_compressed(
        out_path,
        usgs_elevation_m=np.stack(usgs_grids),
        rebuilt_elevation_m=np.stack(rebuilt_grids),
        usgs_valid_mask=np.isfinite(usgs_grids).astype(np.uint8),
        rebuilt_valid_mask=np.isfinite(rebuilt_grids).astype(np.uint8),
        center_lat_lon=np.asarray([row["center_lat_lon"] for row in rows]),
    )
    manifest = {
        "purpose": "Jezero CTX source-paired high-resolution geometry cohort",
        "physical_side_km": SIDE_M / 1000,
        "grid_cells": [CELLS, CELLS],
        "grid_spacing_m": SPACING_M,
        "minimum_valid_fraction_per_product": MIN_VALID,
        "reference_sphere_radius_m": MARS_RADIUS_M,
        "resampling": "average to a Mars local azimuthal equidistant grid",
        "shared_stereo_pair": "G13_023102_1986_XN_18N282W__G13_023168_1986_XN_18N282W",
        "sources": [
            {
                "id": "USGS_CTX_CONTROLLED",
                "local_path": str(USGS.relative_to(ROOT)).replace("\\", "/"),
                "sha256": USGS_HASH,
                "native_spacing_m": 20.298507840584602,
                "catalog": "https://doi.org/10.5066/P9JKVWR3",
                "stac_item": "https://g6goyz4w56.execute-api.us-west-2.amazonaws.com/prod/collections/mro_ctx_controlled_usgs_dtms/items/G13_023102_1986_XN_18N282W__G13_023168_1986_XN_18N282W",
            },
            {
                "id": "PROJECT_ASP_REBUILT",
                "local_path": str(REBUILT.relative_to(ROOT)).replace("\\", "/"),
                "sha256": REBUILT_HASH,
                "native_spacing_m": 20,
                "processing_metadata": "data/demo/mars_ctx_stereo_self_rebuilt/metadata.json",
            },
        ],
        "windows": rows,
        "outputs": {"mars_ctx_3km_96.npz_sha256": sha256(out_path)},
        "limitations": [
            "Both DTMs come from the same CTX observation pair and share source errors; agreement is not independent validation.",
            "All windows are from one Jezero stereo footprint; shifted windows overlap and have no independent landform, material, or Earth-analog labels.",
            "The 31.25 m output grid is for cross-body comparison. 200 m windows have only about six output cells per side; the original Mars DTM has about ten posts per side.",
            "This cohort does not expand Mars coverage globally and cannot support selection outside the CTX footprint.",
            "The rebuilt DTM is aligned to a coarse MOLA/HRSC control surface; neither product proves meter-scale detail.",
        ],
    }
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "retained_joint_windows": len(rows),
        "minimum_usgs_coverage": min(row["usgs_valid_fraction"] for row in rows),
        "minimum_rebuilt_coverage": min(row["rebuilt_valid_fraction"] for row in rows),
        "median_same_pair_centered_rmse_m": float(np.median([
            row["same_pair_consistency_only"]["median_centered_rmse_m"] for row in rows
        ])),
        "output_sha256": manifest["outputs"]["mars_ctx_3km_96.npz_sha256"],
    }, indent=2))


if __name__ == "__main__":
    main()
