"""Render source-aligned local orthophotos on the searched DEM windows.

The aerial image is surface appearance evidence, not a material label.  The
texture follows the same D4 transform as the DEM overlay.
"""

from __future__ import annotations

import io
import json
import hashlib
from functools import lru_cache

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject

from build_microterrain_native_index import EARTH_SITES, aeqd
from microterrain_service import (ROOT, _centered_crop, dynamic_native_grid,
                                  dynamic_site_spec, native_earth_data, native_manifest,
                                  native_references, reference_site, hirise_earth_data,
                                  hirise_query_grid, HIRISE, HIRISE_ID)


@lru_cache(maxsize=1)
def _naip_catalog():
    return json.loads((ROOT / "data/research/naip_earth_orthos/manifest.json")
                      .read_text(encoding="utf-8"))["sites"]


@lru_cache(maxsize=8)
def _naip_source(site_id: str):
    row = _naip_catalog()[site_id]
    path = ROOT / row["source_tiff"]
    if (hashlib.sha256(path.read_bytes()).hexdigest() != row["source_tiff_sha256"] or
            hashlib.sha256(EARTH_SITES[site_id].read_bytes()).hexdigest() != row["dem_sha256"]):
        raise ValueError("NAIP source or paired Earth DEM checksum mismatch")
    return path, row


@lru_cache(maxsize=128)
def naip_earth_texture(body: str, size_m: int, index: int, orientation: int,
                       fine: bool = False) -> bytes:
    if body not in ("moon", "mars") or size_m not in (200, 500, 1000):
        raise ValueError("Invalid microterrain texture scale or body")
    if orientation not in range(8):
        raise ValueError("Invalid D4 orientation")
    if fine and body != "mars":
        raise ValueError("Fine Earth gallery exists only for Mars HiRISE")
    gallery = hirise_earth_data(size_m) if fine else native_earth_data(body, size_m)
    if index < 0 or index >= len(gallery["site_ids"]):
        raise ValueError("Unknown gallery window")
    site_id = str(gallery["site_ids"][index])
    if site_id not in _naip_catalog():
        raise ValueError("NAIP texture is unavailable for this Earth window")
    path, metadata = _naip_source(site_id)
    center_east, center_north = map(float, gallery["center_east_north_m"][index])
    spacing = 4 if fine else native_manifest()["comparison_grid_spacing_m"][body]
    # The gallery stores the central DEM post. An even-cell crop is centered
    # half a post west and north of that post.
    if round(size_m / spacing) % 2 == 0:
        center_east -= spacing / 2
        center_north += spacing / 2
    image_cells = size_m // 2
    channels = np.zeros((3, image_cells, image_cells), dtype=np.uint8)
    valid = np.zeros((image_cells, image_cells), dtype=np.uint8)
    with rasterio.open(path) as source:
        for band in range(3):
            reproject(rasterio.band(source, band + 1), channels[band],
                      src_crs=source.crs,
                      dst_crs=aeqd("earth", *metadata["anchor_lat_lon"]),
                      dst_transform=from_origin(center_east - size_m / 2,
                                                center_north + size_m / 2, 2, 2),
                      dst_nodata=0, resampling=Resampling.bilinear)
        reproject(source.read_masks(1), valid,
                  src_transform=source.transform, src_crs=source.crs,
                  dst_crs=aeqd("earth", *metadata["anchor_lat_lon"]),
                  dst_transform=from_origin(center_east - size_m / 2,
                                            center_north + size_m / 2, 2, 2),
                  dst_nodata=0, resampling=Resampling.nearest)
    if np.mean(valid > 0) < .95:
        raise ValueError("NAIP does not cover this candidate window")
    rgb = np.moveaxis(channels, 0, -1)
    if orientation >= 4:
        rgb = np.fliplr(rgb)
    rgb = np.rot90(rgb, orientation % 4)
    output = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(rgb), "RGB").save(output, format="WEBP", quality=83)
    return output.getvalue()


def idaho_earth_texture(body: str, size_m: int, index: int, orientation: int) -> bytes:
    """Keep the original URL callable for an Idaho candidate only."""
    gallery = native_earth_data(body, size_m)
    if index < 0 or index >= len(gallery["site_ids"]) or str(gallery["site_ids"][index]) != "CRATERS_MOON_IDAHO":
        raise ValueError("This URL is for Idaho NAIP only")
    return naip_earth_texture(body, size_m, index, orientation)


@lru_cache(maxsize=1)
def _jezero_source():
    base = ROOT / "data/demo/mars_ctx_stereo"
    meta = json.loads((base / "metadata.json").read_text(encoding="utf-8"))
    path = base / meta["assets"]["orthoimage"]
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != meta["orthoimage_sha256"]:
        raise ValueError("CTX orthoimage checksum mismatch")
    return path, meta


@lru_cache(maxsize=1)
def _olympus_source():
    base = ROOT / "data/demo/mars_ctx_olympus_verified"
    meta = json.loads((base / "orthoimage_manifest.json").read_text(encoding="utf-8"))
    path = ROOT / meta["source_image"]
    if (hashlib.sha256(path.read_bytes()).hexdigest() != meta["source_image_sha256"] or
            not meta["same_crs_transform_shape_as_dtm"]):
        raise ValueError("Olympus CTX orthoimage checksum or grid mismatch")
    return path, meta


@lru_cache(maxsize=128)
def ctx_reference_texture(site_id: str, size_m: int,
                          east_m: float, north_m: float) -> bytes:
    if size_m not in (200, 500, 1000) or not np.isfinite([east_m, north_m]).all():
        raise ValueError("Invalid CTX texture window")
    body, _, site_info = reference_site(site_id)
    parent = site_info.get("tile_parent_id") or site_id
    if body != "mars" or parent not in ("JEZERO_CTX", "OLYMPUS_CTX"):
        raise ValueError("No paired CTX orthoimage for this Mars window")
    if abs(east_m) > 1500 or abs(north_m) > 1500:
        raise ValueError("CTX texture window exceeds the local grid")
    spacing = native_manifest()["comparison_grid_spacing_m"]["mars"]
    full = (dynamic_native_grid(site_id) if dynamic_site_spec(site_id) is not None
            else native_references("mars")[site_id])
    _, (actual_east, actual_north) = _centered_crop(
        full, east_m, north_m, round(size_m / spacing), spacing)
    if round(size_m / spacing) % 2 == 0:
        actual_east -= spacing / 2
        actual_north += spacing / 2
    path, _ = (_jezero_source() if parent == "JEZERO_CTX" else _olympus_source())
    cells = size_m // 20
    reflectance = np.full((cells, cells), np.nan, dtype=np.float32)
    with rasterio.open(path) as source:
        reproject(rasterio.band(source, 1), reflectance,
                  src_crs=source.crs, src_nodata=source.nodata,
                  dst_crs=aeqd("mars", *site_info["center_lat_lon"]),
                  dst_transform=from_origin(actual_east - size_m / 2,
                                            actual_north + size_m / 2, 20, 20),
                  dst_nodata=np.nan, resampling=Resampling.bilinear)
    if np.isfinite(reflectance).mean() < .95:
        raise ValueError("CTX orthoimage does not cover this DEM window")
    # One fixed display stretch across all Jezero windows; grayscale CTX I/F
    # is not natural color or a compositional map.
    grayscale = np.clip((np.nan_to_num(reflectance, nan=.04) - .04) / .66 * 255,
                        0, 255).astype(np.uint8)
    output = io.BytesIO()
    Image.fromarray(grayscale, "L").save(output, format="WEBP", quality=84)
    return output.getvalue()


@lru_cache(maxsize=128)
def hirise_reference_texture(site_id: str, size_m: int,
                             east_m: float, north_m: float) -> bytes:
    if (site_id != HIRISE_ID or size_m not in (200, 500, 1000) or
            not np.isfinite([east_m, north_m]).all()):
        raise ValueError("Invalid HiRISE texture window")
    _, (actual_east, actual_north) = _centered_crop(
        hirise_query_grid(), east_m, north_m, round(size_m / 4), 4)
    if round(size_m / 4) % 2 == 0:
        actual_east -= 2
        actual_north += 2
    metadata = json.loads((HIRISE / "ortho_manifest.json").read_text(encoding="utf-8"))
    path = ROOT / metadata["local_crop"]["path"]
    if hashlib.sha256(path.read_bytes()).hexdigest() != metadata["local_crop"]["sha256"]:
        raise ValueError("HiRISE paired orthophoto crop checksum mismatch")
    cells = size_m // 2
    grayscale = np.zeros((cells, cells), dtype=np.uint8)
    valid = np.zeros((cells, cells), dtype=np.uint8)
    with rasterio.open(path) as source:
        target_crs = aeqd("mars", 18.3, 77.53)
        target_transform = from_origin(actual_east - size_m / 2,
                                       actual_north + size_m / 2, 2, 2)
        reproject(rasterio.band(source, 1), grayscale,
                  src_crs=source.crs, dst_crs=target_crs,
                  dst_transform=target_transform,
                  dst_nodata=0, resampling=Resampling.bilinear)
        reproject(source.read_masks(1), valid,
                  src_transform=source.transform, src_crs=source.crs,
                  dst_crs=target_crs, dst_transform=target_transform,
                  dst_nodata=0, resampling=Resampling.nearest)
    if np.mean(valid > 0) < .95:
        raise ValueError("HiRISE orthophoto does not cover this DEM window")
    output = io.BytesIO()
    Image.fromarray(grayscale, "L").save(output, format="WEBP", quality=85)
    return output.getvalue()


def jezero_reference_texture(site_id: str, size_m: int,
                             east_m: float, north_m: float) -> bytes:
    """Keep the previously published Jezero URL working."""
    if not site_id.startswith("JEZERO_CTX"):
        raise ValueError("This URL is for Jezero CTX only")
    return ctx_reference_texture(site_id, size_m, east_m, north_m)


@lru_cache(maxsize=1)
def _lroc_catalog():
    return json.loads((ROOT / "data/research/lroc_paired_orthos/manifest.json")
                      .read_text(encoding="utf-8"))["sites"]


@lru_cache(maxsize=6)
def _lroc_source(parent_id: str):
    row = _lroc_catalog()[parent_id]
    path = ROOT / row["source_image"]
    if (hashlib.sha256(path.read_bytes()).hexdigest() != row["source_image_sha256"] or
            not row["aligned_to_paired_dtm_grid"]):
        raise ValueError("LROC DTM-paired orthophoto checksum or grid mismatch")
    return path, row


@lru_cache(maxsize=128)
def lroc_reference_texture(site_id: str, size_m: int,
                           east_m: float, north_m: float) -> bytes:
    if size_m not in (200, 500, 1000) or not np.isfinite([east_m, north_m]).all():
        raise ValueError("Invalid LROC texture window")
    body, _, site_info = reference_site(site_id)
    parent = site_info.get("tile_parent_id") or site_id
    if body != "moon" or parent not in _lroc_catalog():
        raise ValueError("No paired LROC orthophoto for this Moon window")
    if abs(east_m) > 1500 or abs(north_m) > 1500:
        raise ValueError("LROC texture window exceeds the local grid")
    spacing = native_manifest()["comparison_grid_spacing_m"]["moon"]
    full = (dynamic_native_grid(site_id) if dynamic_site_spec(site_id) is not None
            else native_references("moon")[site_id])
    _, (actual_east, actual_north) = _centered_crop(
        full, east_m, north_m, round(size_m / spacing), spacing)
    if round(size_m / spacing) % 2 == 0:
        actual_east -= spacing / 2
        actual_north += spacing / 2
    path, row = _lroc_source(parent)
    cells = round(size_m / row["image_spacing_m"][0])
    pixel_m = size_m / cells
    gray = np.zeros((cells, cells), dtype=np.uint8)
    with rasterio.open(path) as source:
        reproject(rasterio.band(source, 1), gray,
                  src_crs=source.crs, src_nodata=source.nodata,
                  dst_crs=aeqd("moon", *site_info["center_lat_lon"]),
                  dst_transform=from_origin(actual_east - size_m / 2,
                                            actual_north + size_m / 2, pixel_m, pixel_m),
                  dst_nodata=0, resampling=Resampling.bilinear)
    if np.mean(gray > 0) < .95:
        raise ValueError("LROC orthophoto does not cover this DEM window")
    # Fixed visualization gamma brightens a dark NAC scene. It does not create
    # multispectral color or change the original image stored with its hash.
    display = np.sqrt(gray.astype(np.float32) / 255) * 255
    output = io.BytesIO()
    Image.fromarray(display.astype(np.uint8), "L").save(output, format="WEBP", quality=85)
    return output.getvalue()


def marius_reference_texture(site_id: str, size_m: int,
                             east_m: float, north_m: float) -> bytes:
    """Keep the previously published Marius URL working."""
    return lroc_reference_texture(site_id, size_m, east_m, north_m)
