"""Every API endpoint except the window/search pipeline (see search.py).

A route is ``fn(handler, query)``. Returning a value sends it as JSON;
returning None means the route already wrote its own response.
"""
from __future__ import annotations

import json
import math
import re

from . import config, resources as res
from .params import Query, earth_point, moon_window

from lunar_pipeline import MOON_DEM_HI, SCALES_KM, mesh_payload
from copernicus_dem import glo90_patch
from earth_environment import power_climatology
from global_mineral_inference import mineral_model_observation
from highres_lunar_preview import local_lunar_preview
from mars_imagery import mars_window
from mars_reference import catalog as mars_catalog
from microterrain_orthophoto import (ctx_reference_texture, hirise_reference_texture, jezero_reference_texture,
                                     lroc_reference_texture, marius_reference_texture, naip_earth_texture)
from microterrain_service import map_for_site, resolve_native_region_window, search as microterrain_search
from microterrain_service import sites as microterrain_sites
from moon_locator import shaded_locator_jpeg
from moon_mineral_maps import mineral_map_observation
from surface_textures import earth_texture, moon_texture
from scripts.known_analogs import service as known_analogs
from scripts.visual_geology_v1.global_index import status as global_visual_status

KAGUYA_URL = "https://astrogeology.usgs.gov/search/map/lunar-kaguya-multiband-imager-mosaics"
POWER_URL = "https://power.larc.nasa.gov/docs/services/api/temporal/climatology/"


def unavailable(label, reason, source_url, exc):
    print(f"{label} request error:", repr(exc), flush=True)
    return {"available": False, "reason": reason, "source_url": source_url}


# ---- status and catalogues -------------------------------------------------

def status(h, q):
    model, sites, rows, scale_data, report = res.resources()
    counts = {scale: len(scale_data[scale][0]) for scale in SCALES_KM}
    if counts[20] > 295:
        coverage = ("global ETOPO 15s 20/40 km + 60s 80 km half-stride screening; five SRTM regions"
                    if res.has_supplement() else "global ETOPO 15s 20/40 km + 60s 80 km screening; five SRTM regions")
    elif len(rows) > 295:
        coverage = "global 80 km ETOPO land grid + five SRTM regions"
    else:
        coverage = "five SRTM regions; global ingestion pending"
    return {
        "model": "TinyTerrainEncoder",
        "parameters": report["parameters"],
        "model_sha256": res.model_sha256(),
        "best_epoch": report["best_epoch"],
        "training_examples": report["train_examples"],
        "source_moon": config.MOON_SOURCE,
        "source_earth": config.SRTM_SOURCE,
        "candidate_count": len(rows),
        "region_count": len(sites),
        "scales_km": SCALES_KM,
        "candidate_count_by_scale": {str(k): v for k, v in counts.items()},
        "moon_pixels_per_degree": 64 if MOON_DEM_HI.exists() and MOON_DEM_HI.stat().st_size > 500_000_000 else 16,
        "coverage": coverage,
    }


def mars_sites(h, q):
    return {"sites": list(mars_catalog().values()), "scales_km": SCALES_KM,
            "status": "Global MOLA coordinate selection and two saved USGS MOLA/HRSC windows; "
                      "Moon-trained terrain encoder is exploratory on Mars"}


def known_analog_catalogue(h, q):
    return dict(known_analogs.catalogue()[0], summary=known_analogs.summary())


def global_visual(h, q):
    return global_visual_status(q.int("scale") if "scale" in q else None)


def refine(h, q):
    candidate_id = q.str("candidate_id", "")
    row = res.rows_by_id().get(candidate_id)
    if row is None:
        raise ValueError("Unknown indexed Earth candidate")
    center = row["center"]
    grid, source = glo90_patch(center["latitude"], center["longitude_east"], row["patch_km"], size=128)
    return {"candidate_id": candidate_id, "center": center, "patch_km": row["patch_km"],
            "terrain": mesh_payload(grid, size=128), "source": source,
            "scoring_note": "Geometry refinement only; coarse retrieval cosine is unchanged"}


# ---- lunar and Earth observations ------------------------------------------

def moon_local_dtm(h, q):
    lat, lon = q.float("lat", "0"), q.float("lon", "0")
    if not (math.isfinite(lat) and math.isfinite(lon)):
        raise ValueError("Invalid lunar coordinate")
    return local_lunar_preview(lat, lon)


def moon_minerals(h, q):
    lat, lon, size_km = moon_window(q)
    try:
        return mineral_map_observation(lat, lon, size_km)
    except Exception as exc:
        h.send_json(unavailable("Kaguya mineral map", "Kaguya MI 高解析圖層暫時無法讀取", KAGUYA_URL, exc), 503)


def moon_material_model(h, q):
    lat, lon, size_km = moon_window(q)
    try:
        return mineral_model_observation(lat, lon, size_km)
    except Exception as exc:
        h.send_json(unavailable("Regional mineral research model", "研究材質格網暫時無法讀取", KAGUYA_URL, exc), 503)


def earth_environment(h, q):
    lat, lon = earth_point(q)
    try:
        return power_climatology(lat, lon)
    except Exception as exc:
        h.send_json(unavailable("NASA POWER Earth environment", "NASA POWER 氣候格網暫時無法讀取", POWER_URL, exc), 503)


def explore_dem(h, q):
    from explore_dem import explore_dem as build
    km = q.int("km", "40")
    if km not in SCALES_KM:
        raise ValueError(f"km must be one of {SCALES_KM}")
    try:
        return build(q.str("body", ""), q.float("lat", "nan"), q.float("lon", "nan"), km)
    except ValueError as exc:
        return {"available": False, "reason": str(exc)}
    except Exception as exc:
        print("Explorer DEM error:", repr(exc), flush=True)
        h.send_json({"available": False, "reason": "high-resolution DEM temporarily unavailable"}, 503)


# ---- images ----------------------------------------------------------------

def moon_locator(h, q):
    jpeg = shaded_locator_jpeg(round(q.float("x", "0.5"), 5), round(q.float("y", "0.5"), 5), q.int("zoom", "16"))
    h.send_bytes(jpeg, "image/jpeg", 300)


def surface_texture(h, q):
    lat, lon, size_km = moon_window(q)
    body = q.choice("body", ("moon", "earth"), "moon", "body must be moon or earth")
    render = moon_texture if body == "moon" else earth_texture
    h.send_bytes(render(round(lat, 5), round(lon, 5), size_km), "image/jpeg", 3600)


def mars_imagery(h, q):
    lat, lon, size_km = moon_window(q)
    mode = q.choice("format", ("json", "png"), "json", "format must be json or png")
    metadata, image = mars_window(round(lat, 5), round(lon, 5), size_km)
    if mode == "json":
        return metadata
    if image is None:
        h.send_json(metadata, 404)
    else:
        h.send_bytes(image, "image/png", 3600)


# ---- microterrain ----------------------------------------------------------

def microterrain_map(h, q):
    return map_for_site(q.str("site", "MARIUS3"))


def microterrain_resolve(h, q):
    return resolve_native_region_window(q.str("parent", ""), q.int("size_m", "500"),
                                        q.float("east_m", "0"), q.float("north_m", "0"))


def microterrain_query(h, q):
    return microterrain_search(
        q.str("site", "MARIUS3"), q.int("size_m", "500"), q.float("east_m", "0"), q.float("north_m", "0"),
        q.str("mode", "legacy"), q.str("ranker", "geomorphon"), q.flag("include_3d"),
        q.str("comparison", "shape"), q.str("evidence_filter", "off"))


def earth_orthophoto(h, q):
    image = naip_earth_texture(q.str("body", ""), q.int("size_m", "0"), q.int("index", "-1"),
                               q.int("orientation", "-1"), q.flag("fine"))
    h.send_bytes(image, "image/webp", 86400)


def _reference_orthophoto(render):
    def route(h, q):
        image = render(q.str("site", ""), q.int("size_m", "0"), q.float("east_m", "0"), q.float("north_m", "0"))
        h.send_bytes(image, "image/webp", 86400)
    return route


# ---- research panels (imported on first use; several load large tables) ----

def physical_tokens(h, q):
    from scripts.physmatch_v5 import service as physmatch
    from lunar_pipeline import moon_patch
    from mars_global import patch_at as mars_patch_at
    path = h.api_path
    if path.startswith("/api/tokens/earth/"):
        idx = int(path.rsplit("/", 1)[-1])
        if not 0 <= idx < len(physmatch.earth()["lat"]):
            raise ValueError("Unknown Earth window")
        return physmatch.earth_tokens(idx, q.choice("body", ("moon", "mars"), "moon", "Unknown body"))
    body = q.choice("body", ("moon", "mars"), "moon", "Unknown body")
    lat, lon = q.float("lat"), q.float("lon")
    size_km = q.int("size_km", "40")
    if size_km not in (20, 40, 80):
        raise ValueError("size_km must be 20, 40 or 80")
    grid = mars_patch_at(lat, lon, size_km) if body == "mars" else moon_patch(lat, lon, patch_km=size_km)
    if path == "/api/tokens/query":
        return physmatch.summary(body, lat, lon, size_km, grid)
    use = q.choice("use", physmatch.S.USES, "isru", "Unknown physical use")
    weights = None
    if "weights" in q:
        weights = {k: float(v) for k, v in json.loads(q.str("weights")).items() if k in physmatch.S.USES[use]}
        if not weights or min(weights.values()) < 0 or sum(weights.values()) <= 0:
            raise ValueError("weights must be non-negative and cover this use's properties")
    return physmatch.analog(body, lat, lon, size_km, use, weights, grid)


def prefield_check(h, q):
    """Pre-field check of one candidate: nearby known analog, papers naming the place, challenge resources."""
    from scripts.atlas_match import prefield
    return prefield.check(q.body(), q.float("qlat"), q.float("qlon"), q.float("lat"), q.float("lon"))


def resource_card(h, q):
    """Challenge resources applied to one Earth candidate (radar, Earthdata, Worldview); display only."""
    from scripts.facets_v61 import resources as fres
    return fres.card(q.str("body", "moon"), q.float("qlat"), q.float("qlon"), q.float("lat"), q.float("lon"),
                     int(q.float("km", "40")))


def resource_image(h, q):
    from scripts.facets_v61 import resources as fres
    name = h.api_path.rsplit("/", 1)[-1]
    if not re.fullmatch(r"[0-9a-f]{16}\.png", name) or not (fres.CACHE / name).exists():
        h.send_json({"error": "not found"}, 404)
        return
    h.send_bytes((fres.CACHE / name).read_bytes(), "image/png", 86400)


def biology(h, q):
    """Biosignature-preservation settings and sampled microbiomes near one Earth candidate; display only."""
    from scripts.facets_v7 import biology as bio
    qlat = q.float("qlat") if "qlat" in q else None
    qlon = q.float("qlon") if "qlon" in q else None
    return bio.biology(q.float("lat"), q.float("lon"), q.str("body", "moon"), qlat, qlon)


def material_fine(h, q):
    from scripts.material_v5 import material_service as msvc
    return msvc.job_status(q.str("job", ""))


def lavatube_fine(h, q):
    from scripts.lavatube_c2f import service as lavatube
    return lavatube.fine_status(q.str("job", ""))


def lavatube_overlay(h, q):
    from scripts.lavatube_c2f import service as lavatube
    png = lavatube.overlay(q.str("id", ""))
    if png is None:
        h.send_json({"error": "No overlay for this key yet"}, 404)
    else:
        h.send_bytes(png, "image/png", 3600)


EXACT = {
    "/api/status": status,
    "/api/mars-sites": mars_sites,
    "/api/known-analogs": known_analog_catalogue,
    "/api/global-visual/status": global_visual,
    "/api/refine": refine,
    "/api/moon-local-dtm": moon_local_dtm,
    "/api/moon-minerals": moon_minerals,
    "/api/moon-material-model": moon_material_model,
    "/api/earth-environment": earth_environment,
    "/api/explore-dem": explore_dem,
    "/api/moon-locator": moon_locator,
    "/api/surface-texture": surface_texture,
    "/api/microterrain/sites": lambda h, q: microterrain_sites(),
    "/api/microterrain/map": microterrain_map,
    "/api/microterrain/resolve-window": microterrain_resolve,
    "/api/microterrain/search": microterrain_query,
    "/api/microterrain/earth-orthophoto": earth_orthophoto,
    "/api/microterrain/jezero-orthophoto": _reference_orthophoto(jezero_reference_texture),
    "/api/microterrain/ctx-orthophoto": _reference_orthophoto(ctx_reference_texture),
    "/api/microterrain/hirise-orthophoto": _reference_orthophoto(hirise_reference_texture),
    "/api/microterrain/marius-orthophoto": _reference_orthophoto(marius_reference_texture),
    "/api/microterrain/lroc-orthophoto": _reference_orthophoto(lroc_reference_texture),
    "/api/tokens/query": physical_tokens,
    "/api/analog": physical_tokens,
    "/api/maxmatch/check": prefield_check,
    "/api/resources/card": resource_card,
    "/api/biology": biology,
    "/api/material/fine": material_fine,
    "/api/lavatube/fine": lavatube_fine,
    "/api/lavatube/overlay": lavatube_overlay,
}

PREFIX = (
    ("/api/tokens/earth/", physical_tokens),
    ("/api/resources/img/", resource_image),
)

# mars-imagery keeps blank values so an empty lat/lon is reported, not ignored.
EXACT["/api/mars-imagery"] = mars_imagery
KEEP_BLANK = {"/api/mars-imagery"}
