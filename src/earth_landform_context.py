"""Point-catalog provenance near an Earth terrain candidate.

These are external geologic origin records. A nearby catalog center does not
validate the terrain embedding, and an absent record does not exclude a form.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache

import numpy as np

from lunar_pipeline import ROOT


IMPACTS = ROOT / "data/earth_global/earth_impact_craters_2026.json"
CALDERAS = ROOT / "data/earth_global/gvp_caldera_centers_2026.json"
HOLOCENE_VOLCANOES = ROOT / "data/earth_global/gvp_holocene_volcanoes_2026.geojson"
EARTH_RADIUS_KM = 6371.0088


@lru_cache(maxsize=1)
def _catalogs() -> tuple[list[dict], list[dict], list[dict]]:
    impacts = json.loads(IMPACTS.read_text(encoding="utf-8"))["catalog"]
    calderas = json.loads(CALDERAS.read_text(encoding="utf-8"))["calderas"]
    features = json.loads(HOLOCENE_VOLCANOES.read_text(encoding="utf-8"))["features"]
    volcanoes = []
    for feature in features:
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point" or len(geometry.get("coordinates", [])) < 2:
            continue
        props = feature["properties"]
        number = props.get("Volcano_Number")
        volcanoes.append({
            "name": props["Volcano_Name"],
            "latitude": float(geometry["coordinates"][1]),
            "longitude_east": float(geometry["coordinates"][0]),
            "detail_url": f"https://volcano.si.edu/volcano.cfm?vn={number}",
            "category": "Holocene volcano",
            "volcano_number": number,
            "volcano_type": props.get("Primary_Volcano_Type"),
            "major_rock_type": props.get("Major_Rock_Type"),
        })
    return impacts, calderas, volcanoes


def _nearest(lat: float, lon: float, rows: list[dict]) -> dict:
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    lat2 = np.deg2rad([row["latitude"] for row in rows])
    lon2 = np.deg2rad([row["longitude_east"] for row in rows])
    angle = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    distances = 2 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(np.clip(angle, 0, 1)))
    index = int(np.argmin(distances))
    row = rows[index]
    return {"name": row["name"], "distance_km": round(float(distances[index]), 1),
            "latitude": row["latitude"], "longitude_east": row["longitude_east"],
            "detail_url": row["detail_url"],
            "diameter_km": row.get("diameter_km"),
            "category": row.get("category", "Caldera"),
            "volcano_number": row.get("volcano_number"),
            "volcano_type": row.get("volcano_type"),
            "major_rock_type": row.get("major_rock_type")}


def landform_catalog_context(lat: float, lon: float, patch_km: float) -> dict:
    impacts, calderas, volcanoes = _catalogs()
    impact = _nearest(lat, lon, impacts)
    caldera = _nearest(lat, lon, calderas)
    holocene_volcano = _nearest(lat, lon, volcanoes)
    impact["within_search_radius"] = impact["distance_km"] <= patch_km
    caldera["within_search_radius"] = caldera["distance_km"] <= patch_km
    holocene_volcano["within_search_radius"] = holocene_volcano["distance_km"] <= patch_km
    return {
        "search_radius_km": patch_km,
        "impact": impact,
        "caldera": caldera,
        "holocene_volcano": holocene_volcano,
        "source_impact": "https://impact.uwo.ca/impact-craters/map/",
        "source_caldera": "https://volcano.si.edu/database/webservices.cfm",
        "source_holocene_volcano": "https://volcano.si.edu/database/webservices.cfm",
        "interpretation": "Only proximity to published point centers; not a landform label for this exact window, not evidence of absence when no center is nearby.",
    }
