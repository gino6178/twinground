"""Read small windows from the published Kaguya MI mineral maps via HTTP Range.

The 512-pixel/degree global GeoTIFFs are uncompressed, one row per strip.
Only the TIFF directory and requested row segments are transferred. Values are
published map estimates, not labels measured on the lunar surface.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from pathlib import Path

import numpy as np
import requests
import tifffile


BASE = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Lunar_MI_mineral_maps"
MINERALS = ("Clinopyroxene", "Orthopyroxene", "Olivine", "Plagioclase")
WIDTH = 184_320
HEIGHT = 51_200
PIXELS_PER_DEGREE = 512
NODATA = -3.4028226e38
_LOCAL = threading.local()


def pooled_session():
    if not hasattr(_LOCAL, "session"):
        _LOCAL.session = requests.Session()
    return _LOCAL.session


class RemoteRangeFile(io.RawIOBase):
    def __init__(self, url: str):
        self.url = url
        self.name = url
        self.position = 0
        self.response = requests.head(url, timeout=30)
        self.response.raise_for_status()
        self.size = int(self.response.headers["Content-Length"])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        if whence == 1:
            offset += self.position
        elif whence == 2:
            offset += self.size
        self.position = int(offset)
        return self.position

    def read(self, size=-1):
        if size < 0:
            raise ValueError("Unbounded remote TIFF read is not allowed")
        if size == 0:
            return b""
        end = min(self.position + size, self.size) - 1
        result = requests.get(
            self.url, headers={"Range": f"bytes={self.position}-{end}"}, timeout=60
        )
        result.raise_for_status()
        if result.status_code != 206 or len(result.content) != end - self.position + 1:
            raise IOError("Server did not honor the requested byte range")
        self.position = end + 1
        return result.content


def source_url(mineral: str) -> str:
    return f"{BASE}/Lunar_Kaguya_MIMap_MineralDeconv_{mineral}Percent_50N50S.tif"


@lru_cache(maxsize=4)
def tiff_layout(url: str):
    with tifffile.TiffFile(RemoteRangeFile(url)) as tif:
        page = tif.pages[0]
        if (page.imagewidth, page.imagelength) != (WIDTH, HEIGHT):
            raise ValueError("Unexpected mineral-map dimensions")
        if page.compression != 1 or page.bitspersample != 32 or page.rowsperstrip != 1:
            raise ValueError("Expected uncompressed float32 row strips")
        if page.samplesperpixel != 1 or page.dtype != np.dtype("<f4"):
            raise ValueError("Unexpected mineral-map pixel format")
        offsets = tuple(int(v) for v in page.dataoffsets)
        lengths = tuple(int(v) for v in page.databytecounts)
        if len(offsets) != HEIGHT or min(lengths) < WIDTH * 4:
            raise ValueError("Unexpected strip table")
        return offsets, lengths


def _read_row(url: str, byte_start: int, count: int):
    byte_end = byte_start + count * 4 - 1
    response = pooled_session().get(
        url, headers={"Range": f"bytes={byte_start}-{byte_end}"}, timeout=60
    )
    response.raise_for_status()
    data = response.content
    if response.status_code != 206 or len(data) != count * 4:
        raise IOError("Incomplete row range")
    return np.frombuffer(data, dtype="<f4").copy(), hashlib.sha256(data).hexdigest()


def fetch_grid(url: str, lat: float, lon: float, size_km: float, samples: int, workers: int):
    if not -50 < lat < 50:
        raise ValueError("Kaguya mineral maps cover only 50°S to 50°N")
    lon = ((lon + 180) % 360) - 180
    lat_half = size_km / (2 * 111.195)
    lon_half = lat_half / math.cos(math.radians(lat))
    lats = np.linspace(lat + lat_half, lat - lat_half, samples)
    lons = np.linspace(lon - lon_half, lon + lon_half, samples)
    sampled, valid, metadata = fetch_at_coordinates(
        url, lats[:, None] * np.ones((1, samples)),
        np.ones((samples, 1)) * lons[None, :], workers,
    )
    return sampled, valid, lats, lons, metadata


def fetch_at_coordinates(url: str, lats: np.ndarray, lons_east: np.ndarray, workers: int = 12):
    if lats.shape != lons_east.shape or lats.ndim != 2:
        raise ValueError("Latitude and longitude must be matching 2D arrays")
    lons = (lons_east + 180) % 360 - 180
    rows = np.floor((50 - lats) * PIXELS_PER_DEGREE).astype(int)
    cols = np.floor((lons + 180) * PIXELS_PER_DEGREE).astype(int)
    if rows.min() < 0 or rows.max() >= HEIGHT or cols.min() < 0 or cols.max() >= WIDTH:
        raise ValueError("Window crosses the map boundary")
    offsets, lengths = tiff_layout(url)
    left, right = int(cols.min()), int(cols.max())
    # A window straddling 180° sits at opposite TIFF edges. Read the two
    # short edge segments, not a nearly global-width segment on every row.
    if right - left > WIDTH // 2:
        column_groups = [cols < WIDTH // 2, cols >= WIDTH // 2]
    else:
        column_groups = [np.ones(cols.shape, dtype=bool)]
    ranges = [(int(cols[mask].min()), int(cols[mask].max())) for mask in column_groups]
    unique_rows = sorted(set(rows.ravel().tolist()))
    segments = {}
    digests = {}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        jobs = {}
        for row in unique_rows:
            for group, mask in enumerate(column_groups):
                if not np.any((rows == row) & mask):
                    continue
                lo, hi = ranges[group]
                job = executor.submit(_read_row, url, offsets[row] + lo * 4, hi - lo + 1)
                jobs[job] = (row, group)
        for job in as_completed(jobs):
            key = jobs[job]
            segments[key], digests[key] = job.result()
    grid = np.empty(lats.shape, dtype=np.float32)
    for index in np.ndindex(lats.shape):
        col = int(cols[index])
        group = int(col >= WIDTH // 2) if len(ranges) == 2 else 0
        grid[index] = segments[(int(rows[index]), group)][col - ranges[group][0]]
    # Despite the source filenames saying Percent, stored values are fractions.
    # The four component rasters sum to 1 where all components are valid.
    valid = np.isfinite(grid) & (grid > -1e30) & (grid >= 0) & (grid <= 1.001)
    return grid, valid, {
        "url": url,
        "dimensions": [HEIGHT, WIDTH],
        "resolution_pixels_per_degree": PIXELS_PER_DEGREE,
        "rows": [int(rows.min()), int(rows.max())],
        "columns": [left, right],
        "requested_column_ranges": ranges,
        "row_segment_sha256": {
            str(row) if len(ranges) == 1 else f"{row}:{group}": digest
            for (row, group), digest in sorted(digests.items())
        },
        "valid_fraction": float(valid.mean()),
        "median_weight_percent": float(np.median(grid[valid]) * 100) if valid.any() else None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lat", type=float, required=True)
    parser.add_argument("--lon", type=float, required=True)
    parser.add_argument("--size-km", type=float, default=20)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--output", type=Path, default=Path("data/research/kaguya_mineral_pilot"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    name = f"kaguya_{args.lat:+08.4f}_{args.lon:+09.4f}_{args.size_km:g}km_{args.samples}px"
    arrays = {}
    report = {
        "center_lat": args.lat,
        "center_lon_east": args.lon,
        "size_km": args.size_km,
        "samples": args.samples,
        "product": "USGS Kaguya MI Hapke mineral deconvolution maps",
        "interpretation": "Published orbital mineral-map estimates; not ground truth or this system's prediction. GeoTIFF stores 0–1 fractions, so multiply by 100 for wt%.",
        "minerals": {},
    }
    for mineral in MINERALS:
        grid, valid, lats, lons, metadata = fetch_grid(
            source_url(mineral), args.lat, args.lon, args.size_km, args.samples, args.workers
        )
        arrays[f"{mineral.lower()}_fraction"] = grid
        arrays[f"{mineral.lower()}_valid"] = valid
        arrays["lat"] = lats
        arrays["lon"] = lons
        report["minerals"][mineral] = metadata
        print(f"{mineral}: valid={valid.mean():.3f}, median wt%={metadata['median_weight_percent']}", flush=True)
    all_valid = np.logical_and.reduce([arrays[f"{name.lower()}_valid"] for name in MINERALS])
    summed = np.sum([arrays[f"{name.lower()}_fraction"] for name in MINERALS], axis=0)
    report["all_four_valid_fraction"] = float(all_valid.mean())
    report["four_fraction_sum_median"] = float(np.median(summed[all_valid])) if all_valid.any() else None
    np.savez_compressed(args.output / f"{name}.npz", **arrays)
    (args.output / f"{name}.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(args.output / f"{name}.npz")


if __name__ == "__main__":
    main()
