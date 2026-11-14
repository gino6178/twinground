"""On-demand, source-resolution Copernicus GLO-90 candidate terrain windows.

The global ETOPO index is still used for fast retrieval.  This module only
reconstructs selected candidates from the public Copernicus DSM COG tiles.
"""

from __future__ import annotations

import json
import math
import os
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.merge import merge
from scipy.ndimage import distance_transform_edt


BASE_URL = "https://copernicus-dem-90m.s3.amazonaws.com"
SOURCE_URL = "https://registry.opendata.aws/copernicus-dem/"
LICENSE_URL = "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM"
DERIVED_NOTICE = ("produced using Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and "
                  "© Airbus Defence and Space GmbH 2014-2018 provided under "
                  "COPERNICUS by the European Union and ESA; all rights reserved")
CACHE_DIR = Path(__file__).resolve().parents[1] / "data/earth_global/copernicus_glo90_tiles"
MAX_CACHE_BYTES = 3_000_000_000
PIN_FILE = CACHE_DIR / "pinned_tiles.json"
_download_lock = threading.Lock()


def _tile_name(latitude: int, longitude: int) -> str:
    north = f"{'N' if latitude >= 0 else 'S'}{abs(latitude):02d}_00"
    east = f"{'E' if longitude >= 0 else 'W'}{abs(longitude):03d}_00"
    return f"Copernicus_DSM_COG_30_{north}_{east}_DEM"


def _tile_path(latitude: int, longitude: int) -> Path:
    name = _tile_name(latitude, longitude)
    return CACHE_DIR / f"{name}.tif"


def _touch(path: Path) -> None:
    # mtime doubles as last-use time for LRU eviction.
    try:
        os.utime(path)
    except OSError:
        pass


def _evict_for(incoming: int) -> None:
    """Delete least recently used unpinned tiles so a new tile fits under the cap."""
    try:
        pinned = set(json.loads(PIN_FILE.read_text(encoding="utf-8"))["tiles"])
    except (OSError, ValueError, KeyError):
        pinned = set()
    tiles = [(item.stat().st_mtime, item.stat().st_size, item) for item in CACHE_DIR.glob("*.tif")]
    total = sum(size for _, size, _ in tiles)
    for _, size, item in sorted(tiles):
        if total + incoming <= MAX_CACHE_BYTES:
            break
        if item.name in pinned:
            continue
        item.unlink(missing_ok=True)
        total -= size
    if total + incoming > MAX_CACHE_BYTES:
        raise RuntimeError("Copernicus cache is full of pinned research tiles")


def _ensure_tile(latitude: int, longitude: int) -> Path:
    path = _tile_path(latitude, longitude)
    if path.is_file() and path.stat().st_size > 100_000:
        _touch(path)
        return path
    name = _tile_name(latitude, longitude)
    url = f"{BASE_URL}/{name}/{name}.tif"
    with _download_lock:
        if path.is_file() and path.stat().st_size > 100_000:
            return path
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _evict_for(40_000_000)
        temporary = path.with_suffix(".download")
        try:
            with urlopen(url, timeout=25) as source, temporary.open("wb") as output:
                size = 0
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    if size > 40_000_000:
                        raise ValueError(f"Copernicus tile exceeds 40 MB: {name}")
                    output.write(chunk)
            if size < 100_000:
                raise ValueError(f"Copernicus tile is unexpectedly small: {name}")
            os.replace(temporary, path)
        except HTTPError as exc:
            temporary.unlink(missing_ok=True)
            if exc.code == 404:
                raise FileNotFoundError(f"Copernicus GLO-90 tile is unavailable: {name}") from exc
            raise
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    return path


def glo90_patch(lat: float, lon: float, patch_km: float, size: int = 64) -> tuple[np.ndarray, dict]:
    """Resample a physical square from all intersecting 1-degree GLO-90 tiles."""
    if not (-89.0 <= lat <= 89.0 and -180.0 <= lon <= 180.0):
        raise ValueError("Candidate center is outside the supported Earth coordinate range")
    if patch_km not in (3, 5, 10, 20, 40, 80) or size not in (32, 64, 128):
        raise ValueError("Unsupported physical patch size or raster size")
    half_lat = patch_km / 111.32 / 2
    half_lon = half_lat / max(math.cos(math.radians(lat)), 0.08)
    west, south, east, north = lon - half_lon, lat - half_lat, lon + half_lon, lat + half_lat
    if south < -90 or north > 90 or west < -180 or east > 180:
        raise ValueError("Copernicus patch crossing a polar or date-line edge is unavailable")
    tile_coords = [(y, x) for y in range(math.floor(south), math.ceil(north))
                   for x in range(math.floor(west), math.ceil(east))]
    if len(tile_coords) > 16:
        raise ValueError("Too many GLO-90 tiles required for this candidate")
    paths = [_ensure_tile(y, x) for y, x in tile_coords]
    sources = [rasterio.open(path) for path in paths]
    try:
        pixels, _ = merge(sources, bounds=(west, south, east, north),
                          res=((east - west) / size, (north - south) / size),
                          resampling=Resampling.bilinear, nodata=np.nan)
    finally:
        for source in sources:
            source.close()
    grid = pixels[0].astype(np.float32)
    if grid.shape != (size, size):
        raise ValueError(f"Unexpected Copernicus patch dimensions: {grid.shape}")
    valid = np.isfinite(grid)
    valid_fraction = float(valid.mean())
    if valid_fraction < 0.99:
        raise ValueError(f"Copernicus patch coverage insufficient: {valid_fraction:.1%}")
    if not valid.all():
        # The public COGs drop a shared edge pixel. Rare one-column seam gaps
        # survive mosaic resampling; fill only these tiny gaps and disclose them.
        nearest = distance_transform_edt(~valid, return_distances=False,
                                         return_indices=True)
        grid = grid[tuple(nearest)]
    return grid, {
        "dataset": "Copernicus DEM GLO-90",
        "source_url": SOURCE_URL,
        "attribution": DERIVED_NOTICE,
        "license_url": LICENSE_URL,
        "modifications": "Window extraction, bilinear resampling, and disclosed nearest-elevation seam filling; display mesh may use relative heights and vertical exaggeration.",
        "resolution_note": (f"原始南北格距約 93 m；畫面網格間距約 "
                            f"{patch_km * 1000 / (size - 1):.0f} m（地表模型含植被與建物）"
                            + (f"；接縫缺測 {100 * (1 - valid_fraction):.2f}% 以鄰近高程填補"
                               if valid_fraction < 1 else "")),
        "tile_count": len(paths),
        "valid_fraction": round(valid_fraction, 4),
        "seam_filled_fraction": round(1 - valid_fraction, 4),
        "native_latitude_spacing_m": 92.8,
        "display_mesh_spacing_m": round(patch_km * 1000 / (size - 1), 1),
    }
