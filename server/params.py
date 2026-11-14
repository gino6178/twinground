"""Query-string access with validation that turns bad input into HTTP 400."""
from __future__ import annotations

import math
from urllib.parse import parse_qs

from lunar_pipeline import SCALES_KM

_MISSING = object()


class Query:
    def __init__(self, raw: str, keep_blank: bool = False):
        self._data = parse_qs(raw, keep_blank_values=keep_blank)

    def __contains__(self, key):
        return key in self._data

    def str(self, key, default=_MISSING):
        values = self._data.get(key)
        if values:
            return values[0]
        if default is _MISSING:
            raise ValueError(f"Missing parameter: {key}")
        return default

    def float(self, key, default=_MISSING):
        return float(self.str(key, default))

    def int(self, key, default=_MISSING):
        return int(self.str(key, default))

    def flag(self, key):
        return self.str(key, "0") == "1"

    def choice(self, key, allowed, default=_MISSING, message=None):
        value = self.str(key, default)
        if value not in allowed:
            raise ValueError(message or f"{key} must be one of {sorted(allowed)}")
        return value

    def body(self, default="moon"):
        return self.choice("body", ("moon", "mars"), default, "body must be moon or mars")


def moon_window(q: Query):
    """Validated (lat, lon, size_km) for a lunar selection window."""
    if ("lat" in q) != ("lon" in q):
        raise ValueError("月球選區需同時提供經緯度。")
    lat = q.float("lat", "0")
    lon = q.float("lon", "0")
    if not (math.isfinite(lat) and math.isfinite(lon) and -89.5 <= lat <= 89.5):
        raise ValueError("月球緯度需為 -89.5～89.5 的有限數值；經度需為有限數值。")
    lon = ((lon + 180.0) % 360.0) - 180.0
    size_km = q.int("size_km", "40")
    if size_km not in SCALES_KM:
        raise ValueError(f"size_km must be one of {SCALES_KM}")
    return lat, lon, size_km


def earth_point(q: Query):
    lat = round(q.float("lat"), 5)
    lon = round(q.float("lon"), 5)
    if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Invalid Earth latitude or longitude")
    return lat, lon
