"""Build scale-aware geomorphon galleries from true high-resolution DEMs.

Moon/Earth share a 5 m grid; Mars/Earth share a 20 m grid. The 2014-style
descriptor remains an adapted baseline, not a learned cross-body analog model.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject

from build_highres_dem_cohort import (MOON_RADIUS_M, ROOT, SIDE_M, SOURCES,
                                      sha256)
from build_highres_mars_cohort import MARS_RADIUS_M
from microterrain_geomorphon import geomorphons, signature

OUT = ROOT / "data/research/microterrain_native"
SIZES_M = (200, 500, 1000)
EARTH_SITES = {
    "METEOR_CRATER": ROOT / "data/research/earth_3dep_meteor/meteor_crater_3km_2m.tif",
    "KILBOURNE_HOLE": ROOT / "data/research/earth_3dep_kilbourne/kilbourne_hole_3km_2m.tif",
    "CARRIZOZO_FLOW": ROOT / "data/research/earth_3dep_carrizozo/carrizozo_flow_3km_2m.tif",
    "AMBOY_CRATER": ROOT / "data/research/earth_3dep_amboy/amboy_crater_3km_2m.tif",
    "BIG_PINE_FLOW": ROOT / "data/research/earth_3dep_big_pine/big_pine_flow_3km_2m.tif",
    "CIMA_FIELD": ROOT / "data/research/earth_3dep_cima/cima_field_3km_2m.tif",
    "DEATH_VALLEY_MARS_HILL": ROOT / "data/research/earth_3dep_death_valley/death_valley_mars_hill_3km_2m.tif",
    "CRATERS_MOON_IDAHO": ROOT / "data/research/earth_3dep_craters_moon/craters_moon_field_3km_2m.tif",
}
MARS_SITES = {
    "JEZERO_CTX": (
        ROOT / "data/demo/mars_ctx_stereo/dtm.tif",
        (18.4532403, 77.7186703),
    ),
    "OLYMPUS_CTX": (
        ROOT / "data/demo/mars_ctx_olympus_verified/dtm.tif",
        (14.85, 227.6),
    ),
}


def aeqd(body: str, lat: float, lon: float) -> CRS:
    radius = (f"+R={MOON_RADIUS_M}" if body == "moon" else
              f"+R={MARS_RADIUS_M}" if body == "mars" else "+datum=WGS84")
    return CRS.from_proj4(
        f"+proj=aeqd +lat_0={lat:.9f} +lon_0={lon:.9f} {radius} +units=m +no_defs"
    )


def site_grid(path: Path, body: str, center: tuple[float, float],
              spacing_m: float, minimum_valid: float = 0.995) -> tuple[np.ndarray, float]:
    cells = round(SIDE_M / spacing_m)
    grid = np.full((cells, cells), np.nan, dtype=np.float32)
    with rasterio.open(path) as source:
        reproject(
            rasterio.band(source, 1), grid,
            src_crs=source.crs, src_nodata=source.nodata,
            dst_crs=aeqd(body, *center),
            dst_transform=from_origin(-SIDE_M / 2, SIDE_M / 2,
                                      spacing_m, spacing_m),
            dst_nodata=np.nan, resampling=Resampling.average,
            num_threads=1,
        )
    valid = float(np.isfinite(grid).mean())
    if valid < minimum_valid:
        raise ValueError(f"Insufficient source coverage ({valid:.3%}): {path}")
    return grid, valid


def radius_cells(spacing_m: int) -> int:
    # 30–40 m physical sight radius, quantized to the common grid.
    return max(1, round(30 / spacing_m))


def candidates(grids: dict[str, np.ndarray], spacing_m: int,
               size_m: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    cells = round(size_m / spacing_m)
    stride = max(1, round(size_m / (2 * spacing_m)))
    low, high = cells // 2, cells - cells // 2
    out_grids, out_sigs, ids, offsets = [], [], [], []
    for site_id, full in grids.items():
        mid = (full.shape[0] - 1) / 2
        for row in range(low, full.shape[0] - high + 1, stride):
            for col in range(low, full.shape[1] - high + 1, stride):
                crop = np.ascontiguousarray(
                    full[row-low:row+high, col-low:col+high], dtype=np.float32
                )
                if crop.shape != (cells, cells) or not np.isfinite(crop).all():
                    continue
                forms = geomorphons(crop, spacing_m,
                                    radius_cells=radius_cells(spacing_m))
                sig = signature(forms)
                if sig.sum() == 0:
                    continue
                out_grids.append(crop)
                out_sigs.append(sig)
                ids.append(site_id)
                offsets.append(((col - mid) * spacing_m,
                                (mid - row) * spacing_m))
    if not out_grids:
        raise ValueError(f"No valid {size_m} m Earth candidates at {spacing_m} m")
    return (np.stack(out_grids), np.stack(out_sigs),
            np.asarray(ids), np.asarray(offsets, dtype=np.float32))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    lunar_manifest = json.loads(
        (ROOT / "data/research/highres_lunar_dem/manifest.json").read_text(encoding="utf-8")
    )
    lunar_source_rows = {row["id"]: row for row in lunar_manifest["sources"]}
    source_rows = []
    outputs = {}
    for spacing_m, mode in ((5, "moon"), (20, "mars")):
        earth = {}
        references = {}
        for site_id, path in EARTH_SITES.items():
            meta = json.loads((path.parent / "manifest.json").read_text(encoding="utf-8"))
            if sha256(path) != meta["outputs"][f"{path.name}_sha256"]:
                raise ValueError(f"Earth crop checksum mismatch: {path}")
            earth[site_id], valid = site_grid(path, "earth", tuple(meta["anchor_lat_lon"]), spacing_m)
            source_rows.append({"mode": mode, "site_id": site_id,
                                "path": str(path.relative_to(ROOT)).replace("\\", "/"),
                                "sha256": sha256(path), "native_spacing_m": 1,
                                "saved_crop_spacing_m": 2, "valid_fraction": valid})
        if mode == "moon":
            for spec in SOURCES:
                path = spec["path"]
                if sha256(path) != lunar_source_rows[spec["id"]]["sha256"]:
                    raise ValueError(f"LROC checksum mismatch: {path}")
                references[spec["id"]], valid = site_grid(
                    path, "moon", tuple(spec["center"]), spacing_m,
                    minimum_valid=0.98,
                )
                source_rows.append({"mode": mode, "site_id": spec["id"],
                                    "path": str(path.relative_to(ROOT)).replace("\\", "/"),
                                    "sha256": sha256(path),
                                    "native_spacing_m": spec["native_spacing_m"],
                                    "valid_fraction": valid})
        else:
            for site_id, (path, center) in MARS_SITES.items():
                references[site_id], valid = site_grid(path, "mars", center, spacing_m)
                source_rows.append({"mode": mode, "site_id": site_id,
                                    "path": str(path.relative_to(ROOT)).replace("\\", "/"),
                                    "sha256": sha256(path),
                                    "native_spacing_m": round(float(rasterio.open(path).res[0]), 3),
                                    "valid_fraction": valid})
        anchor_path = OUT / f"{mode}_anchors_{spacing_m}m.npz"
        np.savez_compressed(anchor_path, **references)
        outputs[anchor_path.name] = sha256(anchor_path)
        for size_m in SIZES_M:
            gallery = candidates(earth, spacing_m, size_m)
            gallery_path = OUT / f"earth_{mode}_{size_m}m.npz"
            np.savez_compressed(
                gallery_path, grids=gallery[0], signatures=gallery[1],
                site_ids=gallery[2], center_east_north_m=gallery[3],
            )
            outputs[gallery_path.name] = sha256(gallery_path)
            print(f"{mode} {size_m} m: {len(gallery[0])} Earth windows", flush=True)
    manifest = {
        "purpose": "Scale-aware 2014-style geomorphon baseline gallery with bare-earth USGS 3DEP candidates",
        "earth_site_ids": list(EARTH_SITES),
        "moon_reference_ids": [spec["id"] for spec in SOURCES],
        "mars_reference_ids": list(MARS_SITES),
        "physical_site_side_m": SIDE_M,
        "query_sizes_m": list(SIZES_M),
        "comparison_grid_spacing_m": {"moon": 5, "mars": 20},
        "geomorphon_sight_radius_m": {"moon": 5 * radius_cells(5),
                                       "mars": 20 * radius_cells(20)},
        "source_rows": source_rows,
        "outputs_sha256": outputs,
        "limitations": [
            "Meteor Crater, Kilbourne Hole, Amboy Crater and Death Valley Mars Hill are known analog research sites. Carrizozo and Big Pine are search-corpus research candidates in documented basalt-flow regions, not verified new analogs; none provide per-window positive/negative labels.",
            "The 5 m and 20 m modes use different grids; compare retrieval methods within a mode, not raw scores across modes.",
            "Moon 5 m output may downsample 2–4 m LROC data; Mars 20 m CTX post spacing overstates its true resolved feature scale.",
            "USGS 3DEP is bare-earth elevation, not a bare-rock or mineral map.",
            "Nearby windows overlap strongly and cannot be randomly split for scientific evaluation.",
            "Geomorphon local radius is adapted to these small windows; this does not reproduce all 2014 paper settings.",
        ],
    }
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
