"""On-demand 3 km reconstruction from locally downloaded LROC NAC stereo DTMs.

The public 20/40/80 km query remains a LOLA query. This optional inset is
shown only where an entire 3 km window has real, finite NAC DTM elevations.
"""

from __future__ import annotations

import json
import hashlib
from functools import lru_cache
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject

from lroc_dtm_coverage import bounds, catalog, intersects
from lunar_pipeline import mesh_payload


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "data/research/highres_lunar_dem/manifest.json"
SIDE_M = 3000
CELLS = 96
SPACING_M = SIDE_M / CELLS


@lru_cache(maxsize=8)
def verified_source(path: Path, expected_sha256: str) -> bool:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest() == expected_sha256


@lru_cache(maxsize=1)
def local_sources() -> tuple[dict, ...]:
    if not MANIFEST.is_file():
        return ()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    footprints = {row["id"]: row for row in catalog()["sites"]}
    sources = []
    for row in manifest["sources"]:
        footprint = footprints.get(row["id"])
        if footprint is None:
            continue
        path = (ROOT / row["local_path"]).resolve()
        try:
            path.relative_to(ROOT.resolve())
        except ValueError as exc:
            raise ValueError("LROC source path escapes the project") from exc
        if path.is_file():
            sources.append({"id": row["id"], "path": path,
                            "resolution_m": row["native_spacing_m"],
                            "source_sha256": row["sha256"],
                            "product_page": row["product_page"],
                            "bbox_lon_lat": footprint["bbox_lon_lat"]})
    return tuple(sorted(sources, key=lambda row: row["resolution_m"]))


def local_lunar_preview(lat: float, lon: float) -> dict:
    """Return a real 96-cell NAC inset, or explicitly say it is unavailable."""
    if not (-89.5 <= lat <= 89.5 and -180 <= lon <= 180):
        raise ValueError("Unsupported lunar coordinate")
    selected = bounds(lat, lon, SIDE_M / 1000)
    for spec in local_sources():
        if not intersects(spec["bbox_lon_lat"], selected):
            continue
        if not verified_source(spec["path"], spec["source_sha256"]):
            raise ValueError(f"LROC source checksum mismatch: {spec['id']}")
        grid = np.full((CELLS, CELLS), np.nan, dtype=np.float32)
        with rasterio.open(spec["path"]) as source:
            reproject(
                rasterio.band(source, 1), grid,
                src_crs=source.crs, src_nodata=source.nodata,
                dst_transform=from_origin(-SIDE_M / 2, SIDE_M / 2,
                                          SPACING_M, SPACING_M),
                dst_crs=CRS.from_proj4(
                    f"+proj=aeqd +lat_0={lat:.9f} +lon_0={lon:.9f} "
                    "+R=1737400 +units=m +no_defs"),
                dst_nodata=np.nan, resampling=Resampling.average,
                num_threads=1,
            )
        valid_fraction = float(np.isfinite(grid).mean())
        if valid_fraction == 1.0:
            return {"available": True, "center": {"lat": lat, "lon": lon},
                    "side_km": 3, "spacing_m": SPACING_M,
                    "valid_fraction": valid_fraction,
                    "product_id": spec["id"],
                    "native_spacing_m": spec["resolution_m"],
                    "product_page": spec["product_page"],
                    "source_sha256": spec["source_sha256"],
                    "terrain": mesh_payload(grid, size=CELLS),
                    "note": "This is a 3 km stereo DTM inset, not the full 20/40/80 km search window or a material map."}
    return {"available": False,
            "reason": "已下載的 NAC 立體高程未完整覆蓋這個 3 公里局部窗格",
            "source_url": "https://data.lroc.im-ldi.com/lroc/view_rdr/SHAPEFILE_NAC_DTMS"}
