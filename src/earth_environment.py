"""NASA POWER climate context for an Earth candidate, separate from model ranking."""

from __future__ import annotations

import math
from functools import lru_cache
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import json


POWER_BASE = "https://power.larc.nasa.gov/api/temporal/climatology/point"
POWER_DOCS = "https://power.larc.nasa.gov/docs/services/api/temporal/climatology/"
PARAMETERS = {
    "T2M": "C",
    "PRECTOTCORR": "mm/day",
    "ALLSKY_SFC_SW_DWN": "MJ/m^2/day",
}
# Optional extras: a missing or differently-united value becomes None instead of failing the whole request.
EXTRA_PARAMETERS = {
    "T2M_MAX": "C",
    "T2M_MIN": "C",
    "T2M_RANGE": "C",
    "WS10M": "m/s",
    "WS10M_MAX": "m/s",
    "AOD_55": "dimensionless",
    "ALLSKY_SFC_UV_INDEX": "W m-2 x 40",
    "PS": "kPa",
    "RH2M": "%",
}
MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")


def _valid_number(value: object, fill: float) -> float | None:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)) or float(value) == fill:
        return None
    return float(value)


@lru_cache(maxsize=4096)
def power_climatology(latitude: float, longitude: float) -> dict:
    """Fetch a fixed 2001–2025 climate normal at the published native source grid.

    POWER distributes NASA satellite/reanalysis data. Its API is a data source,
    not a material, landform, or similarity model inference endpoint.
    """
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise ValueError("Invalid Earth latitude or longitude")
    query = urlencode({
        "parameters": ",".join([*PARAMETERS, *EXTRA_PARAMETERS]), "community": "AG",
        "longitude": f"{longitude:.5f}", "latitude": f"{latitude:.5f}",
        "format": "JSON", "start": 2001, "end": 2025,
    })
    url = f"{POWER_BASE}?{query}"
    request = Request(url, headers={"User-Agent": "SELENE-terrain-atlas/1.0 (research climate context)"})
    with urlopen(request, timeout=8) as response:
        if response.status != 200:
            raise RuntimeError(f"POWER HTTP {response.status}")
        payload = json.load(response)
    header = payload["header"]
    period = header["range"]
    if "2001" not in period or "2025" not in period:
        raise ValueError("Unexpected POWER climatology period")
    fill = float(header["fill_value"])
    series = payload["properties"]["parameter"]
    for parameter, units in PARAMETERS.items():
        if payload["parameters"][parameter]["units"] != units:
            raise ValueError(f"Unexpected NASA POWER units for {parameter}")
    annual = {name: _valid_number(series[name].get("ANN"), fill) for name in PARAMETERS}
    monthly_temperature = [_valid_number(series["T2M"].get(month), fill) for month in MONTHS]
    monthly_precipitation = [_valid_number(series["PRECTOTCORR"].get(month), fill) for month in MONTHS]
    observed_months = [value for value in monthly_temperature if value is not None]
    if any(value is None for value in annual.values()) or len(observed_months) != 12:
        raise ValueError("Missing NASA POWER climatology values")
    def extra(name, key="ANN"):
        if name not in series or payload["parameters"].get(name, {}).get("units") != EXTRA_PARAMETERS[name]:
            return None
        return _valid_number(series[name].get(key), fill)

    def extra_months(name):
        values = [extra(name, month) for month in MONTHS]
        return values if all(value is not None for value in values) else None

    aod_months = extra_months("AOD_55")
    range_months = extra_months("T2M_RANGE")
    return {
        "available": True,
        "center": {"latitude": latitude, "longitude_east": longitude},
        "period": period,
        "source_grids": header["sources"],
        "source_url": POWER_DOCS,
        "source_data_url": url,
        "temperature_annual_c": annual["T2M"],
        "temperature_monthly_mean_min_c": min(observed_months),
        "temperature_monthly_mean_max_c": max(observed_months),
        "temperature_monthly_c": monthly_temperature,
        "precipitation_monthly_mm_day": monthly_precipitation,
        "precipitation_annual_mean_mm_day": annual["PRECTOTCORR"],
        "solar_annual_mean_mj_m2_day": annual["ALLSKY_SFC_SW_DWN"],
        "temperature_max_c": extra("T2M_MAX"),
        "temperature_min_c": extra("T2M_MIN"),
        "temperature_daily_range_c": extra("T2M_RANGE"),
        "temperature_daily_range_max_month_c": max(range_months) if range_months else None,
        "wind_mean_m_s": extra("WS10M"),
        "wind_max_m_s": extra("WS10M_MAX"),
        "aerosol_optical_depth": extra("AOD_55"),
        "aerosol_optical_depth_peak_month": max(aod_months) if aod_months else None,
        "uv_index": extra("ALLSKY_SFC_UV_INDEX"),
        "surface_pressure_kpa": extra("PS"),
        "relative_humidity_pct": extra("RH2M"),
        "role": "Earth environment context only; never used in Moon/Earth geometry retrieval or material scoring",
        "spatial_support": "NASA POWER source-native gridded climatology at a point; not a 20/40/80 km window measurement",
    }
