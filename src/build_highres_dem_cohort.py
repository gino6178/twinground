"""Build a georegistered 3 km lunar DEM cohort and one Earth comparison.

These windows are source/geometry research data. Site descriptions are never
converted to per-window landform labels or cross-body positive pairs.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform as warp_transform

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data/research/highres_lunar_dem"
EARTH_SOURCE = ROOT / "data/research/highres_earth_dem/sources/Copernicus_DSM_COG_10_N44_00_E128_00_DEM.tif"
EARTH_SHA256 = "fe9a3c653300f78893a6b9411d54d05fc3360d9b5480b7ded17dfc981925559e"
SIDE_M = 3000
CELLS = 96
SPACING_M = SIDE_M / CELLS
MOON_RADIUS_M = 1737400
MOON_GEODETIC_CRS = CRS.from_proj4("+proj=longlat +R=1737400 +no_defs")
MIN_VALID = 0.995
EARTH_CENTER = (44.08, 128.83)

SOURCES = (
    {
        "id": "MARIUS3",
        "path": ROOT / "data/research/published_analog_audit/sources/NAC_DTM_MARIUS3.TIF",
        "page": "https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_MARIUS3",
        "center": (13.7, -56.05),
        "native_spacing_m": 2,
        "sha256": "1e663bdb8bbef9cb27472d9fab9159d624178a0bb29ade88a68fc6a04ecb80f5",
        "site_context": ("Marius Hills", "Volcanism", "Rille"),
        "north_offsets_m": range(-12000, 12001, 1500),
    },
    {
        "id": "FECUNDITATIS",
        "path": OUT / "sources/NAC_DTM_FECUNDITATIS.TIF",
        "page": "https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_FECUNDITATIS",
        "center": (-7.23, 53.24),
        "native_spacing_m": 3,
        "sha256": "e2b27bfff270ebbb593219c7856296dccb2c8831229b787d46f4935cb3b19b35",
        "site_context": ("Mare Fecunditatis", "Tectonism", "Wrinkle Ridge"),
        "north_offsets_m": range(-12000, 12001, 1500),
    },
    {
        "id": "SCHRODNGR02",
        "path": OUT / "sources/NAC_DTM_SCHRODNGR02.TIF",
        "page": "https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_SCHRODNGR02",
        "center": (-71.36, 138.21),
        "native_spacing_m": 4,
        "sha256": "f68cba06b1249e1ee2266eaa09b127fd2ab6df1a32e05d1131f6f066d19f5b6e",
        "site_context": ("Schrodinger crater floor", "Impact Feature", "Polar Region"),
        "north_offsets_m": range(-3000, 3001, 750),
    },
    {
        "id": "ANDERSON01",
        "path": OUT / "sources/NAC_DTM_ANDERSON01.TIF",
        "page": "https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_ANDERSON01",
        "center": (14.94, 170.02),
        "native_spacing_m": 4,
        "sha256": "1e552b0ba412e8a3f761c95d77036de0aab3e3b3bac92931df2f68ae5fa6fc26",
        "site_context": ("Anderson crater floor", "Impact Feature"),
        "north_offsets_m": range(-3000, 3001, 750),
    },
    {
        "id": "NASSAU02",
        "path": OUT / "sources/NAC_DTM_NASSAU02.TIF",
        "page": "https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_NASSAU02",
        "center": (-21.52, 178.51),
        "native_spacing_m": 4,
        "sha256": "69688c434ac593d54a9ae2897d96044dbcebfb5ad5b540ec5becf74e1059dfe4",
        "site_context": ("North of Nassau crater", "Highland", "Impact Feature"),
        "north_offsets_m": range(-3000, 3001, 750),
    },
    {
        "id": "FRSHCRATER8",
        "path": OUT / "sources/NAC_DTM_FRSHCRATER8.TIF",
        "page": "https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_FRSHCRATER8",
        "center": (39.9999821, -134.9354257),
        "catalog_center": (40.0, -135.0),
        "native_spacing_m": 5,
        "sha256": "92f9448e2c93c6558b53b61cf8603c1c2f22063e90586e6116dba6d6871a50d3",
        "site_context": ("Thiel crater product", "Impact Feature", "Ejecta"),
        "north_offsets_m": range(-15000, 15001, 1500),
    },
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def local_crs(lat: float, lon: float, moon: bool) -> CRS:
    earth_or_moon = "+R=1737400" if moon else "+datum=WGS84"
    return CRS.from_proj4(
        f"+proj=aeqd +lat_0={lat:.9f} +lon_0={lon:.9f} "
        f"{earth_or_moon} +units=m +no_defs"
    )


def patch(source: rasterio.io.DatasetReader, lat: float, lon: float,
          moon: bool) -> tuple[np.ndarray, float]:
    grid = np.full((CELLS, CELLS), np.nan, dtype=np.float32)
    reproject(
        rasterio.band(source, 1), grid,
        src_crs=source.crs, src_nodata=source.nodata,
        dst_transform=from_origin(-SIDE_M / 2, SIDE_M / 2,
                                  SPACING_M, SPACING_M),
        dst_crs=local_crs(lat, lon, moon), dst_nodata=np.nan,
        resampling=Resampling.average if moon else Resampling.bilinear,
        num_threads=1,
    )
    valid = np.isfinite(grid)
    return grid, float(valid.mean())


def patch_summary(grid: np.ndarray) -> dict:
    heights = grid.astype(np.float64)
    _, gradient_east = np.gradient(heights, SPACING_M)
    gradient_north, _ = np.gradient(heights, SPACING_M)
    slope = np.hypot(gradient_east, gradient_north)
    return {
        "relief_p90_p10_m": round(float(np.nanpercentile(heights, 90) - np.nanpercentile(heights, 10)), 3),
        "slope_p90_degrees": round(float(np.degrees(np.arctan(np.nanpercentile(slope, 90)))), 3),
    }


def make_lunar_cohort() -> tuple[list[dict], np.ndarray, dict[str, np.ndarray], list[dict]]:
    rows: list[dict] = []
    grids: list[np.ndarray] = []
    anchors: dict[str, np.ndarray] = {}
    source_rows: list[dict] = []
    for spec in SOURCES:
        source_path = spec["path"]
        if not source_path.is_file():
            raise FileNotFoundError(f"Download official LROC 32-bit GeoTIFF: {source_path}")
        source_hash = sha256(source_path)
        if source_hash != spec["sha256"]:
            raise ValueError(f"LROC source checksum mismatch: {source_path}")
        with rasterio.open(source_path) as source:
            if source.count != 1 or not np.allclose(source.res, spec["native_spacing_m"], atol=1e-6):
                raise ValueError(f"Unexpected resolution/bands: {source_path}")
            if "moon" not in source.crs.to_wkt().lower() or "1737400" not in source.crs.to_wkt():
                raise ValueError(f"Unexpected lunar projection or reference radius: {source_path}")
            anchor_lat, anchor_lon = spec["center"]
            anchor_crs = local_crs(anchor_lat, anchor_lon, moon=True)
            source_rows.append({
                "id": spec["id"], "product_page": spec["page"],
                "source_download_url": (
                    "https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/"
                    f"LROLRC_2001/DATA/SDP/NAC_DTM/{spec['id']}/NAC_DTM_{spec['id']}.TIF"
                ),
                "local_path": str(source_path.relative_to(ROOT)).replace("\\", "/"),
                "bytes": source_path.stat().st_size,
                "sha256": source_hash,
                "native_spacing_m": spec["native_spacing_m"],
                "projected_crs_wkt": source.crs.to_wkt(),
                "site_context_only": list(spec["site_context"]),
                "anchor_lat_lon": [anchor_lat, anchor_lon],
                "catalog_center_lat_lon": list(spec.get("catalog_center", spec["center"])),
            })
            for north_m in spec["north_offsets_m"]:
                for east_m in range(-1500, 1501, 750):
                    longitudes, latitudes = warp_transform(
                        anchor_crs, MOON_GEODETIC_CRS,
                        [east_m], [north_m],
                    )
                    lon, lat = longitudes[0], latitudes[0]
                    grid, valid = patch(source, lat, lon, moon=True)
                    if valid < MIN_VALID:
                        continue
                    row = {
                        "id": f"{spec['id']}_{east_m:+05d}_{north_m:+06d}",
                        "source_id": spec["id"],
                        "center_lat_lon": [round(lat, 7), round(lon, 7)],
                        "offset_east_north_m": [east_m, north_m],
                        "valid_fraction": valid,
                        **patch_summary(grid),
                    }
                    rows.append(row)
                    grids.append(grid)
                    if east_m == 0 and north_m == 0:
                        anchors[spec["id"]] = grid
            if spec["id"] not in anchors:
                raise ValueError(f"Official site anchor lacks a complete 3 km DTM: {spec['id']}")
    if not grids:
        raise ValueError("No 3 km lunar windows passed the mask threshold")
    return rows, np.stack(grids), anchors, source_rows


def make_earth_comparison() -> tuple[np.ndarray, dict]:
    if not EARTH_SOURCE.is_file():
        raise FileNotFoundError(f"Download Copernicus GLO-30 COG: {EARTH_SOURCE}")
    if sha256(EARTH_SOURCE) != EARTH_SHA256:
        raise ValueError(f"Copernicus GLO-30 source checksum mismatch: {EARTH_SOURCE}")
    with rasterio.open(EARTH_SOURCE) as source:
        if source.count != 1 or source.crs.to_epsg() != 4326 or source.height != 3600:
            raise ValueError("Unexpected Copernicus GLO-30 tile")
        grid, valid = patch(source, *EARTH_CENTER, moon=False)
    if valid < MIN_VALID:
        raise ValueError(f"Jingpohu GLO-30 3 km window has only {valid:.1%} coverage")
    return grid, {
        "center_lat_lon": list(EARTH_CENTER),
        "source_dataset": "Copernicus DEM GLO-30 Public digital surface model",
        "source_page": "https://registry.opendata.aws/copernicus-dem/",
        "source_download_url": (
            "https://copernicus-dem-30m.s3.amazonaws.com/"
            "Copernicus_DSM_COG_10_N44_00_E128_00_DEM/"
            "Copernicus_DSM_COG_10_N44_00_E128_00_DEM.tif"
        ),
        "local_path": str(EARTH_SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "bytes": EARTH_SOURCE.stat().st_size,
        "sha256": sha256(EARTH_SOURCE),
        "valid_fraction": valid,
        "resampling": "bilinear to a local WGS84 azimuthal equidistant 31.25 m grid",
        "catalog_anchor_only": "Smithsonian GVP Jingpohu volcanic field center, not a window-level landform or material label",
        **patch_summary(grid),
    }


def save_figure(anchors: dict[str, np.ndarray], earth: np.ndarray, path: Path) -> None:
    names = ["Marius Hills / Moon", "Fecunditatis / Moon", "Schrodinger / Moon",
             "Anderson / Moon", "Nassau / Moon", "Thiel vicinity / Moon",
             "Jingpohu / Earth"]
    grids = [anchors[spec["id"]] for spec in SOURCES] + [earth]
    relative = [grid - np.nanmedian(grid) for grid in grids]
    vlim = max(float(np.nanpercentile(np.abs(grid), 98)) for grid in relative)
    fig, axes = plt.subplots(1, len(grids), figsize=(3.0 * len(grids), 3.5), layout="constrained")
    for ax, grid, name in zip(axes, relative, names):
        im = ax.imshow(grid, cmap="terrain", vmin=-vlim, vmax=vlim,
                       extent=(-1.5, 1.5, -1.5, 1.5))
        ax.set_title(name, fontsize=10)
        ax.set_xlabel("East-west (km)")
        ax.set_ylabel("North-south (km)")
    fig.colorbar(im, ax=axes, label="Elevation relative to each median (m)", shrink=0.75)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    rows, moon, anchors, sources = make_lunar_cohort()
    earth, earth_meta = make_earth_comparison()
    OUT.mkdir(parents=True, exist_ok=True)
    moon_path = OUT / "moon_3km_96.npz"
    pair_path = OUT / "marius_jingpo_3km_96.npz"
    figure_path = OUT / "anchor_dem_comparison.png"
    np.savez_compressed(moon_path, elevation_m=moon, valid_mask=np.isfinite(moon).astype(np.uint8),
                        center_lat_lon=np.asarray([r["center_lat_lon"] for r in rows], dtype=np.float64),
                        source_index=np.asarray([next(i for i, s in enumerate(sources) if s["id"] == r["source_id"])
                                                 for r in rows], dtype=np.int16))
    np.savez_compressed(pair_path, moon_elevation_m=anchors["MARIUS3"], earth_elevation_m=earth)
    save_figure(anchors, earth, figure_path)
    manifest = {
        "purpose": "source-aligned 3 km, approximately 30 m lunar DEM cohort and one Earth comparison",
        "not_landform_or_material_labels": True,
        "not_cross_body_positive_pairs": True,
        "physical_side_km": SIDE_M / 1000,
        "grid_cells": [CELLS, CELLS],
        "grid_spacing_m": SPACING_M,
        "moon_reference_radius_m": MOON_RADIUS_M,
        "moon_resampling": "average from native 2-5 m pixels into local lunar azimuthal equidistant grid",
        "minimum_output_valid_fraction": MIN_VALID,
        "missing_value_rule": "Preserve source gaps as NaN and a separate valid_mask; never interpolate or claim full coverage",
        "sources": sources,
        "earth_comparison": earth_meta,
        "windows": rows,
        "outputs": {
            "moon_3km_96.npz_sha256": sha256(moon_path),
            "marius_jingpo_3km_96.npz_sha256": sha256(pair_path),
            "anchor_dem_comparison.png_sha256": sha256(figure_path),
        },
        "limitations": [
            "Overlapping windows from the same DTM site are highly dependent; a random row split would leak terrain.",
            "Up to 0.5% of a retained window can be missing and remains masked, so downstream encoders must use the mask or reject the window.",
            f"{len(SOURCES)} sites cannot establish cross-body analog retrieval accuracy without window-level relevance labels.",
            "Product site context is not a patch-level label; the Schrodinger product covers floor terrain, not a whole crater rim.",
            "GLO-30 is a surface model containing vegetation and buildings, with approximately 30 m native spacing.",
            "Jingpohu and Marius anchors are fixed valid locations, not literature-verified matching lava-tube windows.",
            "The FRSHCRATER8 sample anchor is 1.5 km east of the product catalog center to avoid a source-data gap; it is not a verified Thiel crater patch.",
            "A 31.25 m output cell cannot establish meter-scale skylight or lava tube similarity.",
        ],
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = {spec["id"]: sum(row["source_id"] == spec["id"] for row in rows) for spec in SOURCES}
    print(json.dumps({"retained_lunar_windows": len(rows), "by_site": counts,
                      "earth_valid_fraction": earth_meta["valid_fraction"],
                      "moon_array_sha256": manifest["outputs"]["moon_3km_96.npz_sha256"],
                      "pair_sha256": manifest["outputs"]["marius_jingpo_3km_96.npz_sha256"]}, indent=2))


if __name__ == "__main__":
    main()
