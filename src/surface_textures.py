"""Source imagery draped onto measured DEM meshes in the results viewer.

This is an orthophoto/reflectance texture service, not Skyfall-GS training or
an inference of minerals. The Moon uses NASA SVS color and, where available,
the original LROC WAC 643 nm mosaic for local brightness detail. Earth uses
the georeferenced ArcGIS World Imagery map service with visible attribution.
"""

from __future__ import annotations

import io
import json
import math
import urllib.error
import urllib.parse
import urllib.request
from functools import lru_cache
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import Window
from scipy.ndimage import gaussian_filter, map_coordinates


ROOT = Path(__file__).resolve().parents[1]
MOON_RADIUS_KM = 1737.4
TEXTURE_SIZE = 512
MOON_COLOR = ROOT / "data/moon/lroc_color_poles_8k.tif"
MOON_COLOR_FALLBACK = ROOT / "data/moon/lroc_color_poles_2k.tif"
WAC_DIR = ROOT / "data/moon/lroc_wac_hapke"
ESRI_EXPORT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
USGS_WMS = "https://planetarymaps.usgs.gov/cgi-bin/mapserv"


@lru_cache(maxsize=1)
def moon_color_array() -> np.ndarray:
    source = MOON_COLOR if MOON_COLOR.exists() else MOON_COLOR_FALLBACK
    with Image.open(source) as image:
        return np.asarray(image.convert("RGB"))


@lru_cache(maxsize=1)
def wac_tiles() -> tuple[dict, ...]:
    manifest = WAC_DIR / "sources.json"
    if not manifest.exists():
        return ()
    rows = json.loads(manifest.read_text(encoding="utf-8"))["tiles"]
    available = []
    for row in rows:
        original = WAC_DIR / row["name"]
        preview = WAC_DIR / (Path(row["name"]).stem + ".webp")
        if preview.exists():
            available.append({"path": preview, "bounds_m": row["bounds_m"],
                              "width": row["width"], "height": row["height"],
                              "preview": True})
        elif original.exists():
            available.append({"path": original, "preview": False})
    return tuple(available)


@lru_cache(maxsize=3)
def wac_preview_array(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("L"))


def moon_coordinates(lat: float, lon: float, size_km: int, pixels: int) -> tuple[np.ndarray, np.ndarray]:
    """Use the same tangent-plane geodesic square as lunar_pipeline.moon_patch."""
    lat0, lon0 = math.radians(lat), math.radians(lon)
    center = np.array([math.cos(lat0) * math.cos(lon0), math.sin(lat0),
                       math.cos(lat0) * math.sin(lon0)])
    east = np.array([-math.sin(lon0), 0.0, math.cos(lon0)])
    north = np.array([-math.sin(lat0) * math.cos(lon0), math.cos(lat0),
                      -math.sin(lat0) * math.sin(lon0)])
    ex, ny = np.meshgrid(np.linspace(-size_km / 2, size_km / 2, pixels),
                         np.linspace(size_km / 2, -size_km / 2, pixels))
    rho = np.hypot(ex, ny)
    theta = rho / MOON_RADIUS_KM
    tangent = ex[..., None] * east + ny[..., None] * north
    unit = center * np.cos(theta)[..., None] + tangent * (np.sin(theta) / np.maximum(rho, 1e-9))[..., None]
    return (np.degrees(np.arcsin(np.clip(unit[..., 1], -1, 1))),
            np.degrees(np.arctan2(unit[..., 2], unit[..., 0])))


def _wac_brightness(latitudes: np.ndarray, longitudes: np.ndarray) -> np.ndarray:
    result = np.full(latitudes.shape, np.nan, dtype=np.float32)
    x = np.deg2rad(longitudes % 360.0) * MOON_RADIUS_KM * 1000
    y = np.deg2rad(latitudes) * MOON_RADIUS_KM * 1000
    for tile in wac_tiles():
        if tile["preview"]:
            left, bottom, right, top = tile["bounds_m"]
            inside = (x >= left) & (x < right) & (y >= bottom) & (y < top)
            if not inside.any():
                continue
            cols = (x[inside] - left) * tile["width"] / (right - left) - 0.5
            rows = (top - y[inside]) * tile["height"] / (top - bottom) - 0.5
            pixels = wac_preview_array(tile["path"])
            sampled = map_coordinates(pixels, [rows, cols], order=1, mode="nearest")
            result[inside] = np.where(sampled > 0, sampled / 2048.0, np.nan)
            continue
        with rasterio.open(tile["path"]) as src:
            inside = ((x >= src.bounds.left) & (x < src.bounds.right) &
                      (y >= src.bounds.bottom) & (y < src.bounds.top))
            if not inside.any():
                continue
            cols, rows = (~src.transform) * (x[inside], y[inside])
            cols = np.asarray(cols) - 0.5
            rows = np.asarray(rows) - 0.5
            col0 = max(0, int(math.floor(float(cols.min()))) - 1)
            row0 = max(0, int(math.floor(float(rows.min()))) - 1)
            col1 = min(src.width, int(math.ceil(float(cols.max()))) + 2)
            row1 = min(src.height, int(math.ceil(float(rows.max()))) + 2)
            patch = src.read(1, window=Window(col0, row0, col1 - col0, row1 - row0))
            sampled = map_coordinates(patch, [rows - row0, cols - col0],
                                      order=1, mode="nearest")
            result[inside] = np.where((sampled > 0) & np.isfinite(sampled), sampled, np.nan)
    return result


def _usgs_wac_brightness(latitudes: np.ndarray, longitudes: np.ndarray) -> np.ndarray:
    """Fetch the 100 m LROC WAC orthomosaic for a small lunar window."""
    lon_min, lon_max = float(longitudes.min()), float(longitudes.max())
    if lon_max - lon_min > 10:
        raise ValueError("WMS window crosses the date line or polar singularity")
    lat_min, lat_max = float(latitudes.min()), float(latitudes.max())
    params = {
        "map": "/maps/earth/moon_simp_cyl.map", "SERVICE": "WMS",
        "VERSION": "1.1.1", "REQUEST": "GetMap", "LAYERS": "LROC_WAC",
        "STYLES": "", "SRS": "EPSG:4326",
        "BBOX": f"{lon_min:.7f},{lat_min:.7f},{lon_max:.7f},{lat_max:.7f}",
        "WIDTH": TEXTURE_SIZE, "HEIGHT": TEXTURE_SIZE,
        "FORMAT": "image/png", "TRANSPARENT": "FALSE",
    }
    request = urllib.request.Request(
        USGS_WMS + "?" + urllib.parse.urlencode(params),
        headers={"User-Agent": "SELENE-Lunar-Terrain-Atlas/1.0"})
    with urllib.request.urlopen(request, timeout=8) as response:
        if not response.headers.get("Content-Type", "").startswith("image/png"):
            raise RuntimeError("USGS WMS did not return lunar imagery")
        payload = response.read(1_500_001)
    if len(payload) > 1_500_000:
        raise RuntimeError("USGS WMS image is too large")
    with Image.open(io.BytesIO(payload)) as image:
        pixels = np.asarray(image.convert("L"))
    xx = (longitudes - lon_min) * (TEXTURE_SIZE - 1) / max(lon_max - lon_min, 1e-9)
    yy = (lat_max - latitudes) * (TEXTURE_SIZE - 1) / max(lat_max - lat_min, 1e-9)
    sampled = map_coordinates(pixels, [yy, xx], order=1, mode="nearest").astype(np.float32)
    # The service no longer applies a display stretch (mean ~26/255), so only reject empty or flat images; the
    # caller normalises brightness.
    if np.mean(sampled > 3) < 0.8 or float(sampled.std()) < 0.6:
        raise RuntimeError("USGS WMS imagery has insufficient valid detail")
    return sampled


@lru_cache(maxsize=24)
def moon_texture(lat: float, lon: float, size_km: int) -> bytes:
    latitudes, longitudes = moon_coordinates(lat, lon, size_km, TEXTURE_SIZE)
    color = moon_color_array()
    h, w = color.shape[:2]
    yy = np.clip((90 - latitudes) * h / 180 - 0.5, 0, h - 1)
    xx = ((longitudes + 180) * w / 360 - 0.5) % w
    rgb = np.stack([map_coordinates(color[:, :, band], [yy, xx], order=1, mode="wrap")
                    for band in range(3)], axis=-1).astype(np.float32)
    # The USGS 100 m WAC mosaic supplies image detail. NASA's color map supplies
    # muted chroma. If WMS is unavailable, local 643 nm WAC I/F adds detail.
    try:
        wac_image = _usgs_wac_brightness(latitudes, longitudes)
        chroma = rgb / np.maximum(rgb.mean(axis=-1, keepdims=True), 1)
        # Relative WAC brightness (100 m) anchored to the colour map's mean luminance. Flat mare scenes get a
        # modest contrast lift; rugged highland scenes keep their own contrast, and highlights are compressed so
        # sunlit slopes do not clip.
        relative = wac_image / max(float(wac_image.mean()), 1.0)
        variation = float(relative.std())
        relative = np.maximum(1.0 + (relative - 1.0) * float(np.clip(1.6 - (variation - 0.15) * 4.0, 1.0, 1.6)), 0.0)
        luminance = relative * min(float(rgb.mean()) * 1.3, 140.0)
        knee = 170.0
        luminance = np.where(luminance > knee, knee + (245.0 - knee) * np.tanh((luminance - knee) / (245.0 - knee)), luminance)
        rgb = np.clip(luminance[..., None] * chroma, 0, 255)
    except (ValueError, RuntimeError, OSError, urllib.error.URLError):
        reflectance = _wac_brightness(latitudes, longitudes)
        valid = np.isfinite(reflectance)
        if valid.mean() > 0.05:
            filled = np.where(valid, reflectance, float(np.nanmedian(reflectance)))
            broad = gaussian_filter(filled, 16)
            local_detail = np.clip(filled / np.maximum(broad, 0.005), 0.65, 1.45)
            rgb *= np.where(valid, local_detail, 1.0)[..., None]
    image = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=87, optimize=True)
    return output.getvalue()


@lru_cache(maxsize=32)
def earth_texture(lat: float, lon: float, size_km: int) -> bytes:
    half_lat = size_km / 111.32 / 2
    half_lon = half_lat / max(math.cos(math.radians(lat)), 0.08)
    if abs(lat) + half_lat >= 85:
        raise ValueError("Earth imagery is unavailable for this polar window")
    left, right = lon - half_lon, lon + half_lon
    if left < -180:
        split = (-180 - left) / (right - left)
        pieces = ((left + 360, 180), (-180, right))
    elif right > 180:
        split = (180 - left) / (right - left)
        pieces = ((left, 180), (-180, right - 360))
    else:
        split = None
        pieces = ((left, right),)

    def fetch(part_left: float, part_right: float, width: int) -> Image.Image:
        params = {
            "bbox": f"{part_left:.7f},{lat - half_lat:.7f},{part_right:.7f},{lat + half_lat:.7f}",
            "bboxSR": 4326, "imageSR": 4326,
            "size": f"{width},{TEXTURE_SIZE}", "format": "jpg", "f": "json",
        }
        request = urllib.request.Request(
            ESRI_EXPORT + "?" + urllib.parse.urlencode(params),
            headers={"User-Agent": "SELENE-Lunar-Terrain-Atlas/1.0"})
        with urllib.request.urlopen(request, timeout=12) as response:
            metadata_bytes = response.read(100_001)
        if len(metadata_bytes) > 100_000:
            raise RuntimeError("World Imagery metadata is too large")
        metadata = json.loads(metadata_bytes)
        if "error" in metadata:
            raise RuntimeError("World Imagery export failed")
        url = urllib.parse.urlparse(metadata.get("href", ""))
        if (url.scheme != "https" or url.hostname != "server.arcgisonline.com"
                or url.port not in (None, 443) or url.username or url.password
                or not url.path.startswith("/arcgis/rest/directories/arcgisoutput/")):
            raise RuntimeError("Unexpected World Imagery export location")
        request = urllib.request.Request(url.geturl(), headers={"User-Agent": "SELENE-Lunar-Terrain-Atlas/1.0"})
        with urllib.request.urlopen(request, timeout=12) as response:
            if not response.headers.get("Content-Type", "").startswith("image/jpeg"):
                raise RuntimeError("World Imagery did not return a JPEG image")
            payload = response.read(2_000_001)
        if len(payload) > 2_000_000 or not payload.startswith(b"\xff\xd8"):
            raise RuntimeError("Invalid World Imagery image")
        with Image.open(io.BytesIO(payload)) as image:
            return resample_export_extent(image, metadata,
                (part_left, lat - half_lat, part_right, lat + half_lat),
                (width, TEXTURE_SIZE))

    if split is None:
        image = fetch(*pieces[0], TEXTURE_SIZE)
    else:
        first_width = min(TEXTURE_SIZE - 1, max(1, round(TEXTURE_SIZE * split)))
        image = Image.new("RGB", (TEXTURE_SIZE, TEXTURE_SIZE))
        image.paste(fetch(*pieces[0], first_width), (0, 0))
        image.paste(fetch(*pieces[1], TEXTURE_SIZE - first_width), (first_width, 0))
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=88, optimize=True)
    return output.getvalue()


def resample_export_extent(image: Image.Image, metadata: dict,
                           requested: tuple[float, float, float, float],
                           output_size: tuple[int, int]) -> Image.Image:
    """Map actual ArcGIS extent to the requested north-up geographic rectangle.

    MapServer adjusts bbox to its output aspect ratio. Never assume the returned
    image already covers the requested rectangle. Pixel bounds are outer edges.
    This corrects export geometry, not physical image/DEM registration residuals.
    """
    extent = metadata.get("extent", {})
    sr = extent.get("spatialReference", {})
    if sr.get("latestWkid", sr.get("wkid")) != 4326:
        raise ValueError("Expected EPSG:4326 imagery extent")
    bounds = tuple(float(extent[k]) for k in ("xmin", "ymin", "xmax", "ymax"))
    if not all(math.isfinite(v) for v in (*bounds, *requested)):
        raise ValueError("Non-finite imagery extent")
    left, bottom, right, top = bounds
    west, south, east, north = requested
    if right <= left or top <= bottom or east <= west or north <= south:
        raise ValueError("Empty imagery extent")
    tolerance = 1e-6
    if west < left-tolerance or east > right+tolerance or south < bottom-tolerance or north > top+tolerance:
        raise ValueError("Imagery does not cover requested rectangle")
    if image.size != (metadata.get("width"), metadata.get("height")):
        raise ValueError("Export dimensions do not match image")
    w, h = image.size
    box = ((west-left)/(right-left)*w, (top-north)/(top-bottom)*h,
           (east-left)/(right-left)*w, (top-south)/(top-bottom)*h)
    box = (max(0.,box[0]), max(0.,box[1]), min(float(w),box[2]), min(float(h),box[3]))
    return image.convert("RGB").resize(output_size, Image.Resampling.BILINEAR, box=box)
