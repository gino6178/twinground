"""Read the prebuilt small-window geomorphon research gallery for the web UI."""

from __future__ import annotations

import json
import hashlib
import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch
from rasterio.warp import transform as transform_coordinates
from rasterio.crs import CRS

from build_microterrain_native_index import aeqd, site_grid, MOON_RADIUS_M, MARS_RADIUS_M
from microterrain_geomorphon import best_overlay, geomorphons, signature, wave_hedges
from train_microterrain_tiny_encoder import TinyMorphEncoder, transform_patch
from build_microterrain_tiny_index import resize_height

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "data/research/microterrain_geomorphon"
MARS = ROOT / "data/research/highres_mars_dem"
MOON = ROOT / "data/research/highres_lunar_dem"
NATIVE = ROOT / "data/research/microterrain_native"
LANDCOVER = ROOT / "data/research/microterrain_landcover"
GEOLOGY = ROOT / "data/research/microterrain_geology"
NPS_IDAHO = ROOT / "data/research/nps_cotm_geology"
CIMA_USGS = ROOT / "data/research/cima_usgs_24k"
AMBOY_USGS = ROOT / "data/research/amboy_usgs_surficial_100k"
NAIP_IDAHO = ROOT / "data/research/naip_idaho"
NAIP_EARTH_ORTHOS = ROOT / "data/research/naip_earth_orthos"
LROC_ORTHOS = ROOT / "data/research/lroc_paired_orthos"
HIRISE = ROOT / "data/research/hirise_jezero_1m"
HIRISE_ID = "JEZERO_HIRISE_023524"
SIZES = {200: 7, 500: 16, 1000: 32}
SPACING_M = 31.25


@lru_cache(maxsize=1)
def source_data():
    manifest = json.loads((INDEX / "manifest.json").read_text(encoding="utf-8"))
    with np.load(INDEX / "moon_anchors.npz") as data:
        moons = {name: data[name].copy() for name in data.files}
    return manifest, moons


@lru_cache(maxsize=3)
def earth_data(size_m: int):
    with np.load(INDEX / f"earth_{size_m}m.npz") as data:
        return {name: data[name].copy() for name in data.files}


@lru_cache(maxsize=1)
def native_manifest():
    return json.loads((NATIVE / "manifest.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=2)
def native_references(body: str):
    spacing = native_manifest()["comparison_grid_spacing_m"][body]
    with np.load(NATIVE / f"{body}_anchors_{spacing}m.npz") as data:
        references = {name: data[name].copy() for name in data.files}
    if body == "mars":
        tile_manifest = mars_tile_manifest()
        path = ROOT / tile_manifest["output_npz"]
        if _sha(path) != tile_manifest["output_sha256"]:
            raise ValueError("Mars CTX tile grid checksum mismatch")
        with np.load(path) as data:
            references.update({name: data[name].copy() for name in data.files})
    elif body == "moon":
        tile_manifest = moon_tile_manifest()
        path = ROOT / tile_manifest["output_npz"]
        if _sha(path) != tile_manifest["output_sha256"]:
            raise ValueError("Moon LROC tile grid checksum mismatch")
        with np.load(path) as data:
            references.update({name: data[name].copy() for name in data.files})
    return references


@lru_cache(maxsize=6)
def native_earth_data(body: str, size_m: int):
    with np.load(NATIVE / f"earth_{body}_{size_m}m.npz") as data:
        return {name: data[name].copy() for name in data.files}


@lru_cache(maxsize=1)
def hirise_index_manifest():
    return json.loads((HIRISE / "search_index/manifest.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def hirise_query_grid():
    path = HIRISE / "search_index/mars_hirise_3km_4m.npz"
    if _sha(path) != hirise_index_manifest()["query_sha256"]:
        raise ValueError("HiRISE query grid checksum mismatch")
    with np.load(path) as data:
        return data["elevation_m"].copy()


@lru_cache(maxsize=3)
def hirise_earth_data(size_m: int):
    path = HIRISE / f"search_index/earth_hirise_{size_m}m.npz"
    if _sha(path) != hirise_index_manifest()["outputs"][path.name]["sha256"]:
        raise ValueError("HiRISE Earth index checksum mismatch")
    with np.load(path) as data:
        return {name: data[name].copy() for name in data.files}


@lru_cache(maxsize=1)
def hirise_evidence_manifest():
    path = HIRISE / "evidence_index/manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if _sha(HIRISE / "search_index/manifest.json") != manifest["fine_gallery_manifest_sha256"]:
        raise ValueError("HiRISE fine evidence gallery manifest mismatch")
    return manifest


@lru_cache(maxsize=3)
def hirise_evidence_data(size_m: int):
    path = HIRISE / f"evidence_index/earth_hirise_{size_m}m_evidence.npz"
    entry = hirise_evidence_manifest()["outputs"][path.name]
    if (_sha(path) != entry["sha256"] or
            _sha(HIRISE / f"search_index/earth_hirise_{size_m}m.npz") != entry["fine_gallery_sha256"]):
        raise ValueError("HiRISE fine evidence or DEM gallery checksum mismatch")
    with np.load(path) as data:
        return {name: data[name].copy() for name in data.files}


@lru_cache(maxsize=3)
def hirise_candidate_stats(size_m: int):
    grids = hirise_earth_data(size_m)["grids"]
    deciles = np.percentile(grids, [10, 50, 90], axis=(1, 2))
    return (deciles[1].astype(np.float32),
            np.maximum(deciles[2] - deciles[0], 0.1).astype(np.float32))


def hirise_refine(query: np.ndarray, gallery: dict, shortlist: list[int],
                  comparison: str):
    """Batch the same eight D4 shape comparisons for 4 m candidates."""
    medians, reliefs = hirise_candidate_stats(round(query.shape[0] * 4))
    query_median = float(np.median(query))
    query_centered = query - query_median
    query_relief = max(float(np.percentile(query, 90) - np.percentile(query, 10)), 0.1)
    query_shape = query_centered / query_relief
    refined = []
    for start in range(0, len(shortlist), 32):
        ids = np.asarray(shortlist[start:start + 32], dtype=np.int32)
        centered = gallery["grids"][ids] - medians[ids, None, None]
        normalized = centered / reliefs[ids, None, None]
        best_gap = np.full(len(ids), np.inf, dtype=np.float32)
        best_meter = np.full(len(ids), np.inf, dtype=np.float32)
        best_code = np.zeros(len(ids), dtype=np.int8)
        for flip in (False, True):
            base_shape = np.flip(normalized, axis=2) if flip else normalized
            base_meter = np.flip(centered, axis=2) if flip else centered
            for turns in range(4):
                rotated_shape = np.rot90(base_shape, turns, axes=(1, 2))
                gap = np.sqrt(np.mean((rotated_shape - query_shape) ** 2, axis=(1, 2)))
                better = gap < best_gap
                if np.any(better):
                    rotated_meter = np.rot90(base_meter, turns, axes=(1, 2))
                    meter = np.sqrt(np.mean((rotated_meter - query_centered) ** 2,
                                            axis=(1, 2)))
                    best_gap[better] = gap[better]
                    best_meter[better] = meter[better]
                    best_code[better] = turns + 4 * int(flip)
        for j, idx in enumerate(ids):
            code = int(best_code[j])
            aligned = np.fliplr(normalized[j]) if code >= 4 else normalized[j]
            aligned = np.rot90(aligned, code % 4)
            gap = float(best_gap[j])
            meter = float(best_meter[j])
            refined.append((meter if comparison == "meter" else gap,
                            gap, meter, float(reliefs[idx]), int(idx), code, aligned))
    refined.sort(key=lambda item: item[0])
    return refined


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


@lru_cache(maxsize=1)
def tiny_index_manifest():
    return json.loads((NATIVE / "tiny_index_manifest.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def earth_context():
    return json.loads((NATIVE / "earth_context.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def earth_orthophoto_catalog():
    return json.loads((NAIP_EARTH_ORTHOS / "manifest.json").read_text(encoding="utf-8"))["sites"]


def earth_orthophoto_context(site_id: str):
    row = earth_orthophoto_catalog().get(site_id)
    if row is None:
        return None
    return {
        "year": row["year"],
        "source_page": "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer",
        "source_scene_resolution_m": row["source_scene_resolution_m"],
        "texture_spacing_m": row["export_spacing_m"],
        "source_scene_count": len(row["source_scenes"]),
        "source_tiff_sha256": row["source_tiff_sha256"],
        "used_in_search_ranking": False,
        "interpretation": "Georeferenced aerial RGB appearance only; not mineral, lithology, or rock exposure truth",
    }


@lru_cache(maxsize=1)
def landcover_manifest():
    return json.loads((LANDCOVER / "manifest.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=6)
def landcover_index(body: str, size_m: int):
    path = LANDCOVER / f"earth_{body}_{size_m}m_nlcd2024.npz"
    row = landcover_manifest()["galleries"][path.name]
    if _sha(path) != row["sha256"] or _sha(ROOT / row["gallery"]) != row["gallery_sha256"]:
        raise ValueError("Land cover or DEM gallery checksum mismatch")
    with np.load(path) as data:
        return data["class_counts"].copy(), data["sample_pixels"].copy()


def window_landcover(body: str, size_m: int, idx: int,
                     fine: bool = False) -> dict:
    if fine:
        evidence = hirise_evidence_data(size_m)
        counts, samples = evidence["nlcd_counts"], evidence["nlcd_pixels"]
    else:
        counts, samples = landcover_index(body, size_m)
    classes = landcover_manifest()["class_values"]
    total = int(samples[idx])
    distribution = {str(cls): round(float(n / total), 4)
                    for cls, n in zip(classes, counts[idx]) if n}
    leading = sorted(distribution.items(), key=lambda item: item[1], reverse=True)[:3]
    return {
        "year": landcover_manifest()["year"], "pixel_size_m": 30,
        "sample_pixels": total, "barren_rock_sand_clay_fraction": distribution.get("31", 0),
        "shrub_scrub_fraction": distribution.get("52", 0),
        "leading_classes": [{"code": int(cls), "fraction": share} for cls, share in leading],
        "source_url": landcover_manifest()["source_item"],
        "class_reference_url": landcover_manifest()["class_reference"],
        "interpretation": "30 m thematic land cover only; class 31 mixes rock, sand and clay; no lithology or mineral inference",
        "used_in_ranking": False,
        "used_in_optional_screen": True,
    }


@lru_cache(maxsize=1)
def geology_manifest():
    return json.loads((GEOLOGY / "manifest.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=6)
def geology_index(body: str, size_m: int):
    path = GEOLOGY / f"earth_{body}_{size_m}m_geology.npz"
    row = geology_manifest()["outputs"][path.name]
    if _sha(path) != row["sha256"] or _sha(ROOT / row["gallery"]) != row["gallery_sha256"]:
        raise ValueError("Mapped geology or DEM gallery checksum mismatch")
    with np.load(path) as data:
        return data["counts"].copy(), row["site_key_order"]


def window_geology(body: str, size_m: int, idx: int, site: str,
                   fine: bool = False) -> dict:
    if fine:
        counts = hirise_evidence_data(size_m)["geology_counts"]
        keys_by_site = hirise_evidence_manifest()["geology_site_key_order"]
    else:
        counts, keys_by_site = geology_index(body, size_m)
    keys = keys_by_site[site]
    row = counts[idx, :len(keys)]
    total = int(row.sum())
    site_units = geology_manifest()["sites"][site]["units"]
    mapped = []
    for key, count in zip(keys[1:], row[1:]):
        if count:
            unit = site_units[str(key)]
            mapped.append({"map_id": key, "name": unit["name"], "lith": unit["lith"],
                           "source_scale_group": unit["scale"],
                           "fraction": round(int(count) / total, 4),
                           "source_url": unit["source_request_url"]})
    mapped.sort(key=lambda unit: unit["fraction"], reverse=True)
    return {
        "mapped_units": mapped, "mapped_fraction": round(1 - int(row[0]) / total, 4),
        "cartographic_sampling_m": geology_manifest()["cartographic_sampling_m"],
        "underlying_source_url": geology_manifest()["underlying_source"],
        "macrostrat_documentation_url": geology_manifest()["macrostrat_documentation"],
        "interpretation": "State geologic map polygon overlap only; original map scale varies and does not resolve 200 m material exposure or mineral abundance",
        "used_in_ranking": False,
        "used_in_optional_screen": True,
    }


@lru_cache(maxsize=1)
def nps_idaho_manifest():
    row = json.loads((NPS_IDAHO / "manifest.json").read_text(encoding="utf-8"))
    if (_sha(NPS_IDAHO / "cotm_geology.gpkg") != row["source_gpkg_sha256"] or
            _sha(NPS_IDAHO / "cotm_geology_gpkg.zip") != row["source_zip_sha256"] or
            _sha(ROOT / row["grid"]) != row["grid_sha256"]):
        raise ValueError("NPS Idaho source or map grid checksum mismatch")
    return row


@lru_cache(maxsize=6)
def nps_idaho_index(body: str, size_m: int):
    path = NPS_IDAHO / f"earth_{body}_{size_m}m_nps24k.npz"
    row = nps_idaho_manifest()["outputs"][path.name]
    if (_sha(path) != row["sha256"] or
            _sha(NATIVE / f"earth_{body}_{size_m}m.npz") != row["gallery_sha256"]):
        raise ValueError("NPS Idaho window index or DEM gallery checksum mismatch")
    with np.load(path) as data:
        return data["counts"].copy()


def window_nps_idaho_geology(body: str, size_m: int, idx: int, site: str,
                             fine: bool = False) -> dict | None:
    if site != "CRATERS_MOON_IDAHO":
        return None
    manifest = nps_idaho_manifest()
    row = (hirise_evidence_data(size_m)["nps_counts"][idx] if fine else
           nps_idaho_index(body, size_m)[idx])
    total = int(row.sum())
    mapped = []
    for key, count in enumerate(row[1:], 1):
        if count:
            unit = manifest["units"][str(key)]
            mapped.append({"symbol": unit["Unit_Symbol"], "name": unit["Unit_Name"],
                           "major_lithology": unit["Major_Lithology"],
                           "source_maps": unit["source_maps"],
                           "fraction": round(int(count) / total, 4)})
    mapped.sort(key=lambda unit: unit["fraction"], reverse=True)
    return {
        "map_name": "NPS Craters of the Moon",
        "mapped_units": mapped, "mapped_fraction": round(1 - int(row[0]) / total, 4),
        "map_scale_denominator": manifest["map_scale_denominator"],
        "published_horizontal_accuracy_m": manifest["published_horizontal_accuracy_m"],
        "cartographic_sampling_m": manifest["cartographic_sampling_m"],
        "source_page": manifest["source_page"],
        "interpretation": "NPS 1:24,000 mapped unit overlap only; not exposed surface, mineral abundance, or every DEM cell's material",
        "used_in_ranking": False,
    }


@lru_cache(maxsize=1)
def cima_usgs_manifest():
    row = json.loads((CIMA_USGS / "manifest.json").read_text(encoding="utf-8"))
    if (_sha(CIMA_USGS / "of02-272_2a.e00") != row["source_e00_sha256"] or
            _sha(CIMA_USGS / "of02-272_1a.txt") != row["source_report_sha256"] or
            _sha(CIMA_USGS / "of02-272_1b.txt") != row["source_metadata_sha256"] or
            _sha(ROOT / row["grid"]) != row["grid_sha256"]):
        raise ValueError("USGS Cima source or map grid checksum mismatch")
    return row


@lru_cache(maxsize=6)
def cima_usgs_index(body: str, size_m: int):
    path = CIMA_USGS / f"earth_{body}_{size_m}m_usgs24k.npz"
    row = cima_usgs_manifest()["outputs"][path.name]
    if (_sha(path) != row["sha256"] or
            _sha(NATIVE / f"earth_{body}_{size_m}m.npz") != row["gallery_sha256"]):
        raise ValueError("USGS Cima window index or DEM gallery checksum mismatch")
    with np.load(path) as data:
        return data["counts"].copy()


def window_cima_usgs_geology(body: str, size_m: int, idx: int, site: str,
                             fine: bool = False) -> dict | None:
    if site != "CIMA_FIELD":
        return None
    manifest = cima_usgs_manifest()
    row = (hirise_evidence_data(size_m)["cima_counts"][idx] if fine else
           cima_usgs_index(body, size_m)[idx])
    total = int(row.sum())
    mapped = []
    for key, count in enumerate(row[1:], 1):
        if count:
            unit = manifest["units"][str(key)]
            mapped.append({"symbol": unit["symbol"], "name": unit["map_explanation"],
                           "major_lithology": unit["family"],
                           "uncertain_symbol": unit["uncertain_symbol"],
                           "fraction": round(int(count) / total, 4)})
    mapped.sort(key=lambda unit: unit["fraction"], reverse=True)
    return {
        "map_name": "USGS Indian Spring quadrangle (Cima)",
        "mapped_units": mapped, "mapped_fraction": round(1 - int(row[0]) / total, 4),
        "map_scale_denominator": manifest["map_scale_denominator"],
        "published_horizontal_accuracy_m": manifest["published_horizontal_accuracy_m"],
        "cartographic_sampling_m": manifest["cartographic_sampling_m"],
        "source_page": manifest["source_page"],
        "interpretation": manifest["interpretation"],
        "used_in_ranking": False,
    }


@lru_cache(maxsize=1)
def amboy_usgs_manifest():
    row = json.loads((AMBOY_USGS / "manifest.json").read_text(encoding="utf-8"))
    for name, expected in row["source_files"].items():
        if _sha(AMBOY_USGS / name) != expected:
            raise ValueError(f"USGS Amboy source checksum mismatch: {name}")
    if _sha(ROOT / row["grid"]) != row["grid_sha256"]:
        raise ValueError("USGS Amboy map grid checksum mismatch")
    return row


@lru_cache(maxsize=6)
def amboy_usgs_index(body: str, size_m: int):
    path = AMBOY_USGS / f"earth_{body}_{size_m}m_usgs100k.npz"
    row = amboy_usgs_manifest()["outputs"][path.name]
    if (_sha(path) != row["sha256"] or
            _sha(NATIVE / f"earth_{body}_{size_m}m.npz") != row["gallery_sha256"]):
        raise ValueError("USGS Amboy window index or DEM gallery checksum mismatch")
    with np.load(path) as data:
        return data["counts"].copy()


def window_amboy_usgs_geology(body: str, size_m: int, idx: int, site: str,
                              fine: bool = False) -> dict | None:
    if site != "AMBOY_CRATER":
        return None
    manifest = amboy_usgs_manifest()
    row = (hirise_evidence_data(size_m)["amboy_counts"][idx] if fine else
           amboy_usgs_index(body, size_m)[idx])
    total = int(row.sum())
    mapped = []
    for key, count in enumerate(row[1:], 1):
        if count:
            unit = manifest["units"][str(key)]
            mapped.append({"symbol": unit["symbol"], "name": unit["map_explanation"],
                           "major_lithology": unit["family"],
                           "fraction": round(int(count) / total, 4)})
    mapped.sort(key=lambda unit: unit["fraction"], reverse=True)
    return {
        "map_name": "USGS Amboy surficial map",
        "mapped_units": mapped,
        "mapped_fraction": round(1 - int(row[0]) / total, 4),
        "map_scale_denominator": manifest["map_scale_denominator"],
        "published_horizontal_accuracy_m": manifest["published_horizontal_accuracy_m"],
        "contact_accuracy_note": manifest["contact_accuracy"],
        "cartographic_sampling_m": manifest["cartographic_sampling_m"],
        "source_page": manifest["source_page"],
        "interpretation": manifest["interpretation"],
        "used_in_ranking": False,
    }


def window_detailed_geology(body: str, size_m: int, idx: int, site: str,
                            fine: bool = False) -> dict | None:
    return (window_nps_idaho_geology(body, size_m, idx, site, fine) or
            window_cima_usgs_geology(body, size_m, idx, site, fine) or
            window_amboy_usgs_geology(body, size_m, idx, site, fine))


@lru_cache(maxsize=1)
def naip_idaho_manifest():
    row = json.loads((NAIP_IDAHO / "manifest.json").read_text(encoding="utf-8"))
    if (_sha(ROOT / row["source_tiff"]) != row["source_tiff_sha256"] or
            _sha(ROOT / row["ndvi_grid"]) != row["ndvi_grid_sha256"]):
        raise ValueError("USGS NAIP Idaho source or NDVI grid checksum mismatch")
    return row


@lru_cache(maxsize=1)
def lroc_ortho_manifest():
    return json.loads((LROC_ORTHOS / "manifest.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=6)
def naip_idaho_index(body: str, size_m: int):
    path = NAIP_IDAHO / f"earth_{body}_{size_m}m_naip_ndvi.npz"
    row = naip_idaho_manifest()["outputs"][path.name]
    if (_sha(path) != row["sha256"] or
            _sha(NATIVE / f"earth_{body}_{size_m}m.npz") != row["gallery_sha256"]):
        raise ValueError("USGS NAIP window index or DEM gallery checksum mismatch")
    with np.load(path) as data:
        return data["metrics"].copy(), data["pixels"].copy()


def window_naip_idaho(body: str, size_m: int, idx: int, site: str) -> dict | None:
    if site != "CRATERS_MOON_IDAHO":
        return None
    manifest = naip_idaho_manifest()
    metrics, pixels = naip_idaho_index(body, size_m)
    row = metrics[idx]
    if not np.isfinite(row).all():
        return None
    dates = sorted({datetime.fromtimestamp(scene["acquisition_date"] / 1000, timezone.utc)
                    .date().isoformat() for scene in manifest["source_scenes"]
                    if scene["acquisition_date"] is not None})
    return {
        "acquisition_dates": dates, "sample_pixels": int(pixels[idx]),
        "valid_fraction": round(float(row[0]), 4),
        "median_ndvi": round(float(row[1]), 4),
        "ndvi_p10": round(float(row[2]), 4),
        "ndvi_p90": round(float(row[3]), 4),
        "fraction_ndvi_ge_0_1": round(float(row[4]), 4),
        "fraction_ndvi_ge_0_2": round(float(row[5]), 4),
        "fraction_ndvi_ge_0_3": round(float(row[6]), 4),
        "source_scene_resolution_m": manifest["source_scene_resolution_m"],
        "analysis_spacing_m": manifest["export_and_analysis_spacing_m"],
        "source_url": manifest["service_url"],
        "interpretation": "Exploratory near-infrared vegetation response; threshold is uncalibrated and does not measure exposed rock or minerals",
        "used_in_ranking": False,
    }


def window_naip_fine(size_m: int, idx: int, site: str) -> dict | None:
    evidence = hirise_evidence_data(size_m)
    row = evidence["ndvi_metrics"][idx]
    if not np.isfinite(row).all() or not evidence["ndvi_pixels"][idx]:
        return None
    source = earth_orthophoto_catalog()[site]
    dates = sorted({datetime.fromtimestamp(scene["acquisition_date"] / 1000, timezone.utc)
                    .date().isoformat() for scene in source["source_scenes"]
                    if scene.get("acquisition_date") is not None})
    return {
        "acquisition_dates": dates,
        "sample_pixels": int(evidence["ndvi_pixels"][idx]),
        "valid_fraction": round(float(row[0]), 4),
        "median_ndvi": round(float(row[1]), 4),
        "ndvi_p10": round(float(row[2]), 4),
        "ndvi_p90": round(float(row[3]), 4),
        "fraction_ndvi_ge_0_1": round(float(row[4]), 4),
        "fraction_ndvi_ge_0_2": round(float(row[5]), 4),
        "fraction_ndvi_ge_0_3": round(float(row[6]), 4),
        "source_scene_resolution_m": source["source_scene_resolution_m"],
        "analysis_spacing_m": source["export_spacing_m"],
        "source_url": "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer",
        "interpretation": "Uncalibrated near-infrared vegetation response at exact DEM candidate center; not exposed rock or minerals",
        "used_in_ranking": False,
    }


def mapped_alluvium_dominant(geology: dict) -> bool:
    """Describe coarse map overlap, not observed surface material."""
    alluvium = sum(unit["fraction"] for unit in geology["mapped_units"]
                   if "alluvium" in f'{unit["name"]} {unit["lith"]}'.lower())
    return geology["mapped_fraction"] >= 0.8 and alluvium >= 0.8


def surface_evidence_conflict(geology: dict, cover: dict) -> bool:
    """Flag a strong alluvium-and-scrub conflict, not classify exposed rock."""
    return (mapped_alluvium_dominant(geology) and
            cover["shrub_scrub_fraction"] >= 0.8 and
            cover["barren_rock_sand_clay_fraction"] <= 0.05)


@lru_cache(maxsize=1)
def tiny_model():
    path = NATIVE / "tiny_morph_encoder.pt"
    if _sha(path) != tiny_index_manifest()["model_sha256"]:
        raise ValueError("Tiny morphology model checksum mismatch")
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    torch.set_num_threads(min(torch.get_num_threads(), 4))
    model = TinyMorphEncoder()
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return model


@lru_cache(maxsize=6)
def tiny_earth_vectors(body: str, size_m: int):
    path = NATIVE / f"earth_{body}_{size_m}m_tiny32.npz"
    row = tiny_index_manifest()["outputs"][path.name]
    if _sha(path) != row["sha256"]:
        raise ValueError("Tiny morphology index checksum mismatch")
    gallery_path = NATIVE / row["source_gallery"]
    if _sha(gallery_path) != row["source_gallery_sha256"]:
        raise ValueError("Tiny morphology gallery checksum mismatch")
    with np.load(path) as data:
        vectors = data["embeddings"].copy()
    if vectors.shape != (row["vectors"], row["dimensions"]):
        raise ValueError("Tiny morphology index dimensions mismatch")
    return vectors


@lru_cache(maxsize=6)
def native_earth_reliefs(body: str, size_m: int) -> np.ndarray:
    grids = native_earth_data(body, size_m)["grids"]
    deciles = np.percentile(grids, [10, 90], axis=(1, 2))
    return np.maximum(deciles[1] - deciles[0], 0.1).astype(np.float32)


@torch.inference_mode()
def tiny_scores(query: np.ndarray, size_m: int, body: str,
                vectors: np.ndarray | None = None) -> np.ndarray:
    inputs, reliefs = [], []
    for flip in (False, True):
        base = np.fliplr(query) if flip else query
        for turns in range(4):
            grid = np.rot90(base, turns)
            features, relief = transform_patch(resize_height(grid), size_m)
            inputs.append(features)
            reliefs.append(relief)
    model = tiny_model()
    if vectors is None:
        vectors = tiny_earth_vectors(body, size_m)
    query_vectors = model(torch.from_numpy(np.stack(inputs)),
                          torch.tensor(reliefs, dtype=torch.float32)).numpy()
    return np.max(query_vectors @ vectors.T, axis=0)


@lru_cache(maxsize=1)
def mars_tile_manifest():
    return json.loads((NATIVE / "mars_tiles_manifest.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def moon_tile_manifest():
    return json.loads((NATIVE / "moon_tiles_manifest.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def moon_tile_data():
    manifest, _ = source_data()
    with np.load(MOON / "moon_3km_96.npz") as cohort:
        previews = cohort["elevation_m"].copy()
    sources = lunar_sources()
    result = {}
    for row in moon_tile_manifest()["tiles"]:
        parent_id = row["parent_id"]
        parent = manifest["site_info"][parent_id]
        east, north = row["offset_east_north_m"]
        direction = f"東 {east / 1000:+g} km／北 {north / 1000:+g} km"
        result[row["id"]] = (previews[row["source_window_index"]], {
            **parent,
            "label": f"{parent['label'].split(' · ')[0]} · {direction}",
            "family": None,  # Site-level context does not label this exact tile.
            "source_resolution_m": sources[parent_id]["native_spacing_m"],
            "center_lat_lon": row["center_lat_lon"],
            "tile_parent_id": parent_id,
            "tile_offset_east_north_m": row["offset_east_north_m"],
            "native_grid_valid_fraction": row["native_grid_valid_fraction"],
            "context": f"3 km LROC DTM tile within {parent_id}; no per-window landform or material label",
        })
    return result


@lru_cache(maxsize=1)
def mars_data():
    jezero = json.loads((MARS / "manifest.json").read_text(encoding="utf-8"))
    olympus = json.loads((MARS / "olympus_manifest.json").read_text(encoding="utf-8"))
    jezero_index = next(i for i, row in enumerate(jezero["windows"])
                        if row["offset_east_north_m"] == [0, 0])
    olympus_index = next(i for i, row in enumerate(olympus["windows"])
                         if row["offset_east_north_m"] == [0, 0])
    with np.load(MARS / "mars_ctx_3km_96.npz") as data:
        jezero_grid = data["usgs_elevation_m"][jezero_index].copy()
    with np.load(MARS / "mars_olympus_3km_96.npz") as data:
        olympus_grid = data["elevation_m"][olympus_index].copy()
    result = {
        HIRISE_ID: (
            np.nan_to_num(hirise_query_grid()[::8, ::8], nan=float(np.nanmedian(hirise_query_grid()))), {
                "label": "Jezero HiRISE 1 m · 火星", "family": None,
                "evidence": "https://hirise.lpl.arizona.edu/dtm/ESP_023524_1985",
                "source_resolution_m": 1.0096633268711,
                "center_lat_lon": [18.3, 77.53],
                "native_grid_valid_fraction": hirise_index_manifest()["query_grid_valid_fraction"],
                "context": "HiRISE stereo DTM; 4 m morphology comparison grid; no per-window lithology label",
            }),
        "JEZERO_CTX": (jezero_grid, {
            "label": "Jezero CTX · 火星", "family": None,
            "evidence": jezero["sources"][0]["stac_item"],
            "source_resolution_m": jezero["sources"][0]["native_spacing_m"],
            "center_lat_lon": jezero["windows"][jezero_index]["center_lat_lon"],
            "context": "Jezero stereo footprint; no per-window landform label",
        }),
        "OLYMPUS_CTX": (olympus_grid, {
            "label": "Olympus Mons 熔岩流觀測區 · 火星", "family": None,
            "evidence": olympus["source"]["stac_item"],
            "source_resolution_m": olympus["source"]["native_spacing_m"],
            "center_lat_lon": olympus["windows"][olympus_index]["center_lat_lon"],
            "context": "NASA HiRISE lava-flow image center; no per-window lava-flow label",
            "context_url": olympus["anchor_evidence"],
        }),
    }
    tile_rows = mars_tile_manifest()["tiles"]
    with np.load(MARS / "mars_ctx_3km_96.npz") as data:
        jezero_previews = data["usgs_elevation_m"].copy()
    with np.load(MARS / "mars_olympus_3km_96.npz") as data:
        olympus_previews = data["elevation_m"].copy()
    for row in tile_rows:
        parent_id = row["parent_id"]
        _, parent = result[parent_id]
        east, north = row["offset_east_north_m"]
        direction = f"東 {east / 1000:+g} km／北 {north / 1000:+g} km"
        preview = (jezero_previews if parent_id == "JEZERO_CTX" else olympus_previews)[row["source_window_index"]]
        result[row["id"]] = (preview, {
            **parent,
            "label": f"{parent['label'].split(' · ')[0]} · {direction}",
            "center_lat_lon": row["center_lat_lon"],
            "tile_parent_id": parent_id,
            "tile_offset_east_north_m": row["offset_east_north_m"],
            "native_grid_valid_fraction": row["native_grid_valid_fraction"],
            "context": f"3 km CTX DTM tile within {parent_id}; no per-window landform or material label",
        })
    return result


@lru_cache(maxsize=1)
def lunar_sources():
    manifest = json.loads((MOON / "manifest.json").read_text(encoding="utf-8"))
    return {row["id"]: row for row in manifest["sources"]}


def dynamic_site_spec(site_id: str):
    match = re.fullmatch(r"(.+)_FREE_E(-?\d+)_N(-?\d+)", site_id)
    if not match:
        return None
    parent, east_m, north_m = match.group(1), int(match.group(2)), int(match.group(3))
    if parent in lunar_sources():
        body, overview = "moon", moon_tile_manifest()["overviews"].get(parent)
    elif parent in ("JEZERO_CTX", "OLYMPUS_CTX"):
        body, overview = "mars", mars_tile_manifest()["overviews"].get(parent)
    else:
        raise ValueError("Unknown dynamic DTM source")
    if not overview or not (overview["west_m"] <= east_m <= overview["east_m"] and
                            overview["south_m"] <= north_m <= overview["north_m"]):
        raise ValueError("Dynamic DTM center is outside the published regional map")
    return body, parent, east_m, north_m


@lru_cache(maxsize=8)
def dynamic_source(parent: str):
    if parent in lunar_sources():
        row = lunar_sources()[parent]
        path = ROOT / row["local_path"]
        expected = row["sha256"]
        body, anchor = "moon", row["anchor_lat_lon"]
    elif parent == "JEZERO_CTX":
        row = json.loads((MARS / "manifest.json").read_text(encoding="utf-8"))["sources"][0]
        path = ROOT / row["local_path"]
        expected = row["sha256"]
        body, anchor = "mars", mars_data()[parent][1]["center_lat_lon"]
    elif parent == "OLYMPUS_CTX":
        row = json.loads((MARS / "olympus_manifest.json").read_text(encoding="utf-8"))["source"]
        path = ROOT / row["local_path"]
        expected = row["sha256"]
        body, anchor = "mars", mars_data()[parent][1]["center_lat_lon"]
    else:
        raise ValueError("Unknown DTM source")
    if not path.is_file() or _sha(path) != expected:
        raise ValueError("Original DTM source missing or checksum mismatch")
    return body, path, anchor


@lru_cache(maxsize=12)
def dynamic_native_grid(site_id: str):
    spec = dynamic_site_spec(site_id)
    if spec is None:
        raise ValueError("Not an on-demand DTM site")
    body, parent, east_m, north_m = spec
    _, path, anchor = dynamic_source(parent)
    center = window_center_lat_lon(body, anchor, (east_m, north_m))
    spacing = native_manifest()["comparison_grid_spacing_m"][body]
    grid, _ = site_grid(path, body, tuple(center), spacing, minimum_valid=0.0)
    return grid


@lru_cache(maxsize=12)
def dynamic_preview_grid(site_id: str):
    body, parent, east_m, north_m = dynamic_site_spec(site_id)
    _, path, anchor = dynamic_source(parent)
    center = window_center_lat_lon(body, anchor, (east_m, north_m))
    preview, _ = site_grid(path, body, tuple(center), SPACING_M, minimum_valid=0.0)
    return preview


def reference_site(site_id: str):
    dynamic = dynamic_site_spec(site_id)
    if dynamic is not None:
        body, parent, east_m, north_m = dynamic
        _, _, parent_info = reference_site(parent)
        center = window_center_lat_lon(body, parent_info["center_lat_lon"],
                                       (east_m, north_m))
        return body, dynamic_preview_grid(site_id), {
            **parent_info,
            "label": f"{parent_info['label'].split(' · ')[0]} · 原始 DTM 自由選框",
            "family": None,
            "center_lat_lon": center,
            "tile_parent_id": parent,
            "tile_offset_east_north_m": [east_m, north_m],
            "context": f"On-demand 3 km preview from original {parent} DTM; no per-window landform or material label",
        }
    manifest, moons = source_data()
    if site_id in moons:
        source = lunar_sources()[site_id]
        return "moon", moons[site_id], {
            **manifest["site_info"][site_id],
            "source_resolution_m": source["native_spacing_m"],
            "center_lat_lon": source["anchor_lat_lon"],
        }
    lunar_tiles = moon_tile_data()
    if site_id in lunar_tiles:
        return "moon", *lunar_tiles[site_id]
    mars = mars_data()
    if site_id in mars:
        return "mars", *mars[site_id]
    raise ValueError("Unknown high-resolution DTM site")


def sites():
    manifest, moons = source_data()
    mars = mars_data()
    return {
        "sizes_m": list(SIZES),
        "moon_sites": [{"id": id, **reference_site(id)[2]} for id in moons],
        "moon_tiles": [{"id": row["id"], **moon_tile_data()[row["id"]][1]}
                       for row in moon_tile_manifest()["tiles"]],
        "moon_overviews": moon_tile_manifest()["overviews"],
        "mars_sites": [{"id": id, **mars[id][1]} for id in (HIRISE_ID, "JEZERO_CTX", "OLYMPUS_CTX")],
        "mars_tiles": [{"id": row["id"], **mars[row["id"]][1]}
                       for row in mars_tile_manifest()["tiles"]],
        "mars_overviews": {
            **mars_tile_manifest()["overviews"],
            HIRISE_ID: {"url": "/research/hirise-jezero-overview.webp",
                        "sha256": hirise_index_manifest()["query_sha256"],
                        "west_m": -1500, "east_m": 1500,
                        "south_m": -1500, "north_m": 1500},
        },
        "earth_sites": [{"id": id, **manifest["site_info"][id]}
                        for id in ("METEOR_CRATER", "POTRILLO")],
        "method": manifest["method"], "paper": manifest["paper"],
        "scope": manifest["search_scope"], "limitations": manifest["limitations"],
        "earth_windows_by_size": {key: row["windows"] for key, row in manifest["outputs"].items()},
        "native_mode": {
            "moon_earth_spacing_m": 5, "mars_earth_spacing_m": 20,
            "earth_site_ids": native_manifest()["earth_site_ids"],
            "earth_sites": ["Meteor Crater", "Kilbourne Hole", "Carrizozo Lava Flow", "Amboy Crater", "Big Pine Volcanic Field", "Cima Volcanic Field", "Death Valley Mars Hill"],
            "source": "USGS 3DEP 1 m bare-earth DEM, saved as 2 m crops",
        },
        "experimental_tiny": {
            "parameters": 30024, "embedding_dimensions": 32,
            "training": "self-supervised same-window D4 and Earth 5m/20m consistency; no expert cross-body pairs",
            "model_sha256": tiny_index_manifest()["model_sha256"],
        },
    }


def map_for_site(site_id: str):
    body, full, site_info = reference_site(site_id)
    display = np.nan_to_num(_normal(full), nan=-1.4)
    recommended = native_recommended_offset(site_id)
    return {"site_id": site_id, "body": body, "grid": np.round(display, 3).tolist(),
            "side_m": 3000, "spacing_m": SPACING_M,
            "source_crop_mode": ("on_demand_original_dtm" if dynamic_site_spec(site_id) is not None
                                 else "saved_3km_dem"),
            "source_url": site_info["evidence"],
            "center_lat_lon": site_info["center_lat_lon"],
            "native_spacing_m": site_info["source_resolution_m"],
            "recommended_native_offset_east_north_m": recommended}


@lru_cache(maxsize=8)
def native_recommended_offset(site_id: str) -> list[float]:
    if site_id == HIRISE_ID:
        return [0.0, 0.0]
    if dynamic_site_spec(site_id) is not None:
        return [0.0, 0.0]
    body, _, _ = reference_site(site_id)
    spacing = native_manifest()["comparison_grid_spacing_m"][body]
    full = native_references(body)[site_id]
    cells = round(1000 / spacing)
    valid = np.pad(np.isfinite(full).astype(np.int32), ((1, 0), (1, 0)))
    summed = valid.cumsum(0).cumsum(1)
    counts = (summed[cells:, cells:] - summed[:-cells, cells:]
              - summed[cells:, :-cells] + summed[:-cells, :-cells])
    rows, cols = np.nonzero(counts == cells * cells)
    if not len(rows):
        raise ValueError(f"No complete 1 km native DEM window at {site_id}")
    mid = (full.shape[0] - 1) / 2
    center_rows = rows + (cells - 1) / 2
    center_cols = cols + (cells - 1) / 2
    nearest = np.argmin((center_rows - mid) ** 2 + (center_cols - mid) ** 2)
    return [round(float((center_cols[nearest] - mid) * spacing), 1),
            round(float((mid - center_rows[nearest]) * spacing), 1)]


def _centered_crop(grid, east_m: float, north_m: float, cells: int,
                   spacing_m: float = SPACING_M):
    mid = (grid.shape[0] - 1) / 2
    col = int(round(mid + east_m / spacing_m))
    row = int(round(mid - north_m / spacing_m))
    low, high = cells // 2, cells - cells // 2
    if row - low < 0 or col - low < 0 or row + high > grid.shape[0] or col + high > grid.shape[1]:
        raise ValueError("Window exceeds the source DTM; move toward the centre")
    crop = np.ascontiguousarray(grid[row - low:row + high, col - low:col + high])
    if not np.isfinite(crop).all():
        raise ValueError("Selected window contains missing DTM pixels")
    return crop, ((col - mid) * spacing_m, (mid - row) * spacing_m)


def resolve_native_region_window(parent_id: str, size_m: int,
                                 east_m: float, north_m: float) -> dict:
    """Resolve a regional-map point to a fully valid native DTM window.

    Reuse a saved tile when possible; otherwise sample the verified original
    source DTM at the selected center. Offsets are from the source anchor.
    """
    if size_m not in SIZES or not np.isfinite([east_m, north_m]).all():
        raise ValueError("Choose a finite 200, 500 or 1000 m regional window")
    if parent_id == HIRISE_ID:
        _, actual = _centered_crop(hirise_query_grid(), east_m, north_m,
                                   round(size_m / 4), 4)
        return {
            "available": True, "body": "mars", "parent_id": HIRISE_ID,
            "site_id": HIRISE_ID, "size_m": size_m,
            "tile_offset_east_north_m": [0, 0],
            "offset_east_north_m": [round(float(v), 1) for v in actual],
            "source_offset_east_north_m": [round(float(v), 1) for v in actual],
            "center_lat_lon": window_center_lat_lon("mars", [18.3, 77.53], actual),
            "comparison_spacing_m": 4,
            "source_mode": "saved_3km_dem",
            "interpretation": "Fully valid 4 m HiRISE DTM comparison window",
        }
    if parent_id in lunar_sources():
        body, rows = "moon", moon_tile_manifest()["tiles"]
    elif parent_id in ("JEZERO_CTX", "OLYMPUS_CTX"):
        body, rows = "mars", mars_tile_manifest()["tiles"]
    else:
        raise ValueError("Unknown LROC or CTX source")
    spacing = native_manifest()["comparison_grid_spacing_m"][body]
    centers = [(parent_id, [0, 0])]
    centers.extend((row["id"], row["offset_east_north_m"])
                   for row in rows if row["parent_id"] == parent_id)
    centers.sort(key=lambda item: ((east_m - item[1][0]) ** 2 +
                                    (north_m - item[1][1]) ** 2))
    references = native_references(body)
    for site_id, center in centers:
        relative_east = east_m - center[0]
        relative_north = north_m - center[1]
        try:
            _, actual = _centered_crop(references[site_id], relative_east,
                                       relative_north, round(size_m / spacing), spacing)
        except ValueError:
            continue
        _, _, site_info = reference_site(site_id)
        return {
            "available": True, "body": body, "parent_id": parent_id,
            "site_id": site_id, "size_m": size_m,
            "tile_offset_east_north_m": center,
            "offset_east_north_m": [round(float(v), 1) for v in actual],
            "source_offset_east_north_m": [round(float(center[i] + actual[i]), 1)
                                           for i in (0, 1)],
            "center_lat_lon": window_center_lat_lon(body, site_info["center_lat_lon"], actual),
            "comparison_spacing_m": spacing,
            "interpretation": "Fully valid native DEM window within a saved 3 km tile; other source areas are not implied searchable",
        }
    quantized_east = round(east_m / spacing) * spacing
    quantized_north = round(north_m / spacing) * spacing
    site_id = f"{parent_id}_FREE_E{int(quantized_east)}_N{int(quantized_north)}"
    try:
        full = dynamic_native_grid(site_id)
        _, actual = _centered_crop(full, 0, 0, round(size_m / spacing), spacing)
    except ValueError as exc:
        raise ValueError("此位置的原始 DTM 沒有完整高解析方框；請移至有資料的區域或縮小方框") from exc
    _, _, site_info = reference_site(site_id)
    return {
        "available": True, "body": body, "parent_id": parent_id,
        "site_id": site_id, "size_m": size_m,
        "source_mode": "on_demand_original_dtm",
        "tile_offset_east_north_m": [int(quantized_east), int(quantized_north)],
        "offset_east_north_m": [round(float(v), 1) for v in actual],
        "source_offset_east_north_m": [round(float(quantized_east + actual[0]), 1),
                                      round(float(quantized_north + actual[1]), 1)],
        "center_lat_lon": window_center_lat_lon(body, site_info["center_lat_lon"], actual),
        "comparison_spacing_m": spacing,
        "interpretation": "On-demand reprojection from checksum-verified original DTM; all query pixels valid; no mineral or analog label",
    }


def _normal(grid):
    x = grid.astype(np.float32)
    return (x - np.nanmedian(x)) / max(float(np.nanpercentile(x, 90) - np.nanpercentile(x, 10)), 0.1)


def _preview(grid: np.ndarray) -> list[list[float]]:
    step = max(1, int(np.ceil(max(grid.shape) / 64)))
    return np.round(grid[::step, ::step], 3).tolist()


def window_center_lat_lon(body: str, center_lat_lon: list[float] | tuple[float, float],
                          offset_east_north_m: np.ndarray | tuple[float, float]) -> list[float]:
    lat, lon = map(float, center_lat_lon)
    east, north = map(float, offset_east_north_m)
    target = ("EPSG:4326" if body == "earth" else
              CRS.from_proj4(f"+proj=longlat +R={MOON_RADIUS_M if body == 'moon' else MARS_RADIUS_M} +no_defs"))
    longitudes, latitudes = transform_coordinates(aeqd(body, lat, lon), target,
                                                  [east], [north])
    longitude = float(longitudes[0]) % 360 if body == "mars" else float(longitudes[0])
    return [round(float(latitudes[0]), 7), round(longitude, 7)]


def search_native(site_id: str, size_m: int, east_m: float, north_m: float,
                  ranker: str = "geomorphon", include_3d: bool = False,
                  comparison: str = "shape", evidence_filter: str = "off"):
    if size_m not in SIZES:
        raise ValueError("Choose 200, 500 or 1000 m")
    if not np.isfinite([east_m, north_m]).all():
        raise ValueError("Invalid offset")
    if ranker not in ("geomorphon", "tiny"):
        raise ValueError("Choose geomorphon or tiny ranker")
    if comparison not in ("shape", "meter"):
        raise ValueError("Choose shape or meter comparison")
    if evidence_filter not in ("off", "screen"):
        raise ValueError("Choose off or screen evidence filter")
    body, _, site_info = reference_site(site_id)
    fine_mars = site_id == HIRISE_ID
    spacing = 4 if fine_mars else native_manifest()["comparison_grid_spacing_m"][body]
    full = (hirise_query_grid() if fine_mars else
            dynamic_native_grid(site_id) if dynamic_site_spec(site_id) is not None
            else native_references(body)[site_id])
    cells = round(size_m / spacing)
    query, actual_offset = _centered_crop(full, east_m, north_m, cells, spacing)
    forms = geomorphons(query, spacing, radius_cells=max(1, round(30 / spacing)))
    sig = signature(forms)
    gallery = hirise_earth_data(size_m) if fine_mars else native_earth_data(body, size_m)
    scores = wave_hedges(sig, gallery["signatures"])
    paper_order = np.argsort(scores)[::-1]
    paper_rank = {int(idx): rank for rank, idx in enumerate(paper_order, 1)}
    neural_scores = tiny_scores(query, size_m, body,
                                gallery["embeddings"] if fine_mars else None)
    tiny_order = np.argsort(neural_scores)[::-1]
    tiny_rank = {int(idx): rank for rank, idx in enumerate(tiny_order, 1)}
    order = tiny_order if ranker == "tiny" else paper_order
    query_relief = max(float(np.percentile(query, 90) - np.percentile(query, 10)), 0.1)
    # Keep the strongest global rows while allowing each geographic crop to
    # contribute alternatives. Otherwise dozens of overlapping windows from
    # one crop can occupy the entire shortlist.
    shortlist_ids = set(int(i) for i in order[:min(40, len(order))])
    for earth_site in np.unique(gallery["site_ids"]):
        local = [int(i) for i in order if gallery["site_ids"][i] == earth_site]
        shortlist_ids.update(local[:10])
    if comparison == "meter":
        if fine_mars:
            reliefs = hirise_candidate_stats(size_m)[1]
        else:
            reliefs = native_earth_reliefs(body, size_m)
        relief_distance = np.abs(np.log(reliefs / query_relief))
        nearest_relief = np.argsort(relief_distance)
        shortlist_ids.update(int(i) for i in nearest_relief[:30])
        for earth_site in np.unique(gallery["site_ids"]):
            local = [int(i) for i in nearest_relief if gallery["site_ids"][i] == earth_site]
            shortlist_ids.update(local[:5])
    shortlist = [int(i) for i in order if int(i) in shortlist_ids]
    if fine_mars:
        refined = hirise_refine(query, gallery, shortlist, comparison)
    else:
        refined = []
        for idx in shortlist:
            code, gap, aligned = best_overlay(query, gallery["grids"][idx])
            if np.isfinite(gap):
                raw_earth = gallery["grids"][idx]
                oriented = np.fliplr(raw_earth) if code >= 4 else raw_earth
                oriented = np.rot90(oriented, code % 4)
                earth_relief = max(float(np.percentile(raw_earth, 90) - np.percentile(raw_earth, 10)), 0.1)
                meter_rmse = float(np.sqrt(np.mean(((query - np.median(query)) -
                                                    (oriented - np.median(oriented))) ** 2)))
                refined.append((meter_rmse if comparison == "meter" else float(gap),
                                float(gap), meter_rmse, earth_relief,
                                int(idx), int(code), aligned))
        refined.sort(key=lambda item: item[0])
    labels = {"METEOR_CRATER": "Meteor Crater · 3DEP 裸地",
              "KILBOURNE_HOLE": "Kilbourne Hole · 3DEP 裸地",
              "CARRIZOZO_FLOW": "Carrizozo 熔岩流候選 · 3DEP 裸地",
              "AMBOY_CRATER": "Amboy Crater 已知火星類比場址 · 3DEP 裸地",
              "BIG_PINE_FLOW": "Big Pine 火山流候選 · 3DEP 裸地",
              "CIMA_FIELD": "Cima 火山區待驗證候選 · 3DEP 裸地",
              "DEATH_VALLEY_MARS_HILL": "Death Valley Mars Hill 已知火星類比 · 3DEP 裸地",
              "CRATERS_MOON_IDAHO": "Idaho Craters of the Moon 已知月／火火山類比 · 3DEP 裸地"}
    contexts = earth_context()["site_rows"]
    chosen = []
    excluded_conflicts = 0
    for _, gap, meter_rmse, earth_relief, idx, code, aligned in refined:
        center = gallery["center_east_north_m"][idx]
        site = str(gallery["site_ids"][idx])
        context = contexts[site]
        geology = window_geology(body, size_m, idx, site, fine=fine_mars)
        cover = window_landcover(body, size_m, idx, fine=fine_mars)
        conflict = surface_evidence_conflict(geology, cover)
        if evidence_filter == "screen" and conflict:
            excluded_conflicts += 1
            continue
        if (sum(item["site_id"] == site for item in chosen) >= 2 or
                any(item["site_id"] == site and
                    np.linalg.norm(center - np.asarray(item["offset_east_north_m"])) < size_m
                    for item in chosen)):
            continue
        raw_earth = gallery["grids"][idx]
        oriented = np.fliplr(raw_earth) if code >= 4 else raw_earth
        oriented = np.rot90(oriented, code % 4)
        item = {
            "paper_rank": paper_rank[idx],
            "tiny_rank": tiny_rank[idx],
            "tiny_similarity": round(float(neural_scores[idx]), 4),
            "geomorphon_similarity": round(float(scores[idx]), 4),
            "shape_gap": round(gap, 4),
            "height_rmse_m": round(meter_rmse, 3),
            "query_relief_p90_p10_m": round(query_relief, 3),
            "earth_relief_p90_p10_m": round(earth_relief, 3),
            "earth_to_query_relief_ratio": round(earth_relief / query_relief, 4),
            "orientation_code": code,
            "gallery_index": idx,
            "fine_gallery": fine_mars,
            "evidence_sampling": "exact_candidate_center" if fine_mars else "prebuilt_candidate_center",
            "site_id": site, "site_label": labels[site],
            "regional_context": context["regional_geology_context"],
            "regional_context_url": context["regional_geology_url"],
            "earth_environment_context": {
                "temperature_annual_c": context["climate"]["temperature_annual_c"],
                "precipitation_annual_mean_mm_day": context["climate"]["precipitation_annual_mean_mm_day"],
                "source_data_url": context["climate"]["source_data_url"],
                "period": context["climate"]["period"],
                "spatial_support": context["climate"]["spatial_support"],
            },
            "earth_landcover_context": cover,
            "earth_geologic_map_context": geology,
            "earth_detailed_geologic_map_context": window_detailed_geology(body, size_m, idx, site, fine=fine_mars),
            "earth_naip_vegetation_signal": (window_naip_fine(size_m, idx, site) if fine_mars else
                                              window_naip_idaho(body, size_m, idx, site)),
            "earth_orthophoto": earth_orthophoto_context(site),
            "mapped_alluvium_dominant": mapped_alluvium_dominant(geology),
            "surface_evidence_conflict": conflict,
            "window_material": context["window_material"],
            "mission_suitability": context["mission_suitability"],
            "offset_east_north_m": [round(float(v), 1) for v in center],
            "center_lat_lon": window_center_lat_lon("earth", context["center_lat_lon"], center),
            "earth_height": _preview(_normal(gallery["grids"][idx])),
            "earth_aligned_height": _preview(aligned),
        }
        shared_scale_m = max(query_relief, earth_relief)
        item["overlay_shared_scale_m"] = round(shared_scale_m, 3)
        item["reference_height_shared"] = _preview((query - np.median(query)) / shared_scale_m)
        item["earth_aligned_height_shared"] = _preview((oriented - np.median(oriented)) / shared_scale_m)
        if include_3d:
            item["earth_aligned_height_m"] = _preview(oriented - np.median(oriented))
        chosen.append(item)
        if len(chosen) >= 5:
            break
    result = {
        "site_id": site_id, "site_label": site_info["label"], "body": body,
        "reference_crop_mode": ("on_demand_original_dtm" if dynamic_site_spec(site_id) is not None
                                else "saved_3km_dem"),
        "mode": "native", "family_gate": None, "earth_site_gate": None,
        "size_m": size_m, "actual_grid_cells": cells,
        "display_grid_cells": min(cells, len(_preview(query))),
        "comparison_spacing_m": spacing,
        "actual_sampled_side_m": cells * spacing,
        "moon_offset_east_north_m": [round(v, 1) for v in actual_offset],
        "reference_window_center_lat_lon": window_center_lat_lon(body, site_info["center_lat_lon"], actual_offset),
        "reference_height": _preview(_normal(query)),
        "reference_forms": _preview(forms),
        "searched_windows": len(order), "matches": chosen,
        "ranker": ranker, "comparison": comparison,
        "evidence_filter": evidence_filter,
        "excluded_evidence_conflicts": excluded_conflicts,
        "shortlisted_windows": len(shortlist),
        "method": (("TinyMorphEncoder 32-D cosine" if ranker == "tiny" else
                    "2014-style 55-bin geomorphon Wave-Hedges") +
                   " global top-40 plus top-10 per Earth site; " +
                   ("add 30 globally and 5 per site nearest in P90-P10 relief; D4 median-centered meter RMSE ranking"
                    if comparison == "meter" else "D4 relief-normalized shape RMS ranking") +
                   "; regional diversity" +
                   ("; exclude jointly mapped alluvium/scrub windows" if evidence_filter == "screen" else "") +
                   ("; HiRISE 1 m DTM and Earth 3DEP on 4 m comparison grid" if fine_mars else "")),
        "model_sha256": tiny_index_manifest()["model_sha256"],
        "interpretation": "High-resolution DEM morphology candidate only; no per-window rock, mineral, environment, or analog relevance label.",
        "resolution_warning": ("HiRISE approximately 1 m DTM posts do not guarantee resolving 1 m rocks; the Earth gallery remains eight 3 km regions"
                               if fine_mars else
                               "Mars CTX 20 m post spacing can miss features around 150 m; 200 m matches remain uncertain"
                               if body == "mars" and size_m == 200 else None),
        "reference_source_url": site_info["evidence"],
        "source_resolution_m": site_info["source_resolution_m"],
        "center_lat_lon": site_info["center_lat_lon"],
        "reference_context": site_info.get("context"),
        "reference_context_url": site_info.get("context_url"),
        "earth_dem_source": "USGS 3DEP 1 m bare-earth; locally saved 2 m crops",
        "evidence_alignment": ("Geology, NLCD, and NAIP source evidence sampled at the exact 4 m Earth candidate center; original map scales and registration uncertainty remain"
                               if fine_mars else None),
    }
    if include_3d:
        result["reference_height_m"] = _preview(query - np.median(query))
        result["height_values_are_relative_m"] = True
    parent_id = site_info.get("tile_parent_id") or site_id
    if body == "moon" and parent_id in lroc_ortho_manifest()["sites"]:
        ortho = lroc_ortho_manifest()["sites"][parent_id]
        result["reference_orthophoto"] = {
            "product_id": ortho["product_id"],
            "source_page": ortho["product_page"],
            "source_spacing_m": ortho["image_spacing_m"][0],
            "kind": "grayscale LROC NAC DTM-paired orthophoto",
            "used_in_search_ranking": False,
        }
    if body == "mars" and parent_id in ("JEZERO_CTX", "OLYMPUS_CTX"):
        if parent_id == "JEZERO_CTX":
            ortho = json.loads((ROOT / "data/demo/mars_ctx_stereo/metadata.json")
                               .read_text(encoding="utf-8"))
            source_page = ortho["stac_item_url"]
            source_spacing = ortho["gsd_m"]
            product_id = ortho["item_id"]
        else:
            ortho = json.loads((ROOT / "data/demo/mars_ctx_olympus_verified/orthoimage_manifest.json")
                               .read_text(encoding="utf-8"))
            source_page = ortho["stac_item_url"]
            source_spacing = ortho["image_spacing_m"][0]
            product_id = ortho["stac_item_id"]
        result["reference_orthophoto"] = {
            "product_id": product_id,
            "source_page": source_page,
            "source_spacing_m": source_spacing,
            "kind": "grayscale USGS MRO CTX DTM-paired orthoimage",
            "used_in_search_ranking": False,
        }
    if fine_mars:
        ortho = json.loads((HIRISE / "ortho_manifest.json").read_text(encoding="utf-8"))
        result["reference_orthophoto"] = {
            "product_id": ortho["product_id"],
            "source_page": ortho["product_page"],
            "source_spacing_m": ortho["source_resolution_m"][0],
            "kind": "grayscale DTM-paired HiRISE orthophoto",
            "used_in_search_ranking": False,
        }
    return result


LEGACY_EARTH_ATTRIBUTION = ("produced using Copernicus WorldDEM-30 \u00a9 DLR e.V. 2010-2014 and "
                            "\u00a9 Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS "
                            "by the European Union and ESA; all rights reserved")


def search(site_id: str, size_m: int, east_m: float = 0, north_m: float = 0,
           mode: str = "legacy", ranker: str = "geomorphon",
           include_3d: bool = False, comparison: str = "shape",
           evidence_filter: str = "off"):
    if mode == "native":
        return search_native(site_id, size_m, east_m, north_m, ranker, include_3d,
                             comparison, evidence_filter)
    if mode != "legacy":
        raise ValueError("Unknown microterrain search mode")
    manifest, _ = source_data()
    body, full, site_info = reference_site(site_id)
    if size_m not in SIZES:
        raise ValueError("Choose 200, 500 or 1000 m")
    if not np.isfinite([east_m, north_m]).all():
        raise ValueError("Invalid offset")
    cells = SIZES[size_m]
    reference_grid, actual_offset = _centered_crop(full, east_m, north_m, cells)
    reference_forms = geomorphons(reference_grid, SPACING_M,
                             radius_cells=max(1, min(3, cells // 5)))
    reference_sig = signature(reference_forms)
    gallery = earth_data(size_m)
    family = site_info["family"]
    allowed = {"impact": "METEOR_CRATER", "volcanic": "POTRILLO"}.get(family)
    mask = gallery["site_ids"] == allowed if allowed else np.ones(len(gallery["site_ids"]), dtype=bool)
    indices = np.flatnonzero(mask)
    scores = wave_hedges(reference_sig, gallery["signatures"][indices])
    order = indices[np.argsort(scores)[::-1]]
    paper_rank = {int(idx): rank for rank, idx in enumerate(order, 1)}
    # Shape verification is a separate second stage.  It never changes the
    # reported 2014 baseline score or rank.
    shortlist = order[:min(80, len(order))]
    refined = []
    for idx in shortlist:
        code, gap, aligned = best_overlay(reference_grid, gallery["grids"][idx])
        if not np.isfinite(gap):
            continue
        refined.append((float(gap), int(idx), int(code), aligned))
    refined.sort(key=lambda item: item[0])
    chosen = []
    for gap, idx, code, aligned in refined:
        center = gallery["center_east_north_m"][idx]
        if any(np.hypot(*(center - np.asarray(item["offset_east_north_m"]))) < size_m / 3
               for item in chosen):
            continue
        chosen.append({
            "paper_rank": paper_rank[idx],
            "geomorphon_similarity": round(float(wave_hedges(reference_sig, gallery["signatures"][idx])[0]), 4),
            "shape_gap": round(gap, 4),
            "orientation_code": code,
            "site_id": str(gallery["site_ids"][idx]),
            "site_label": manifest["site_info"][str(gallery["site_ids"][idx])]["label"],
            "offset_east_north_m": [round(float(v), 1) for v in center],
            "earth_height": np.round(_normal(gallery["grids"][idx]), 3).tolist(),
            "earth_aligned_height": np.round(aligned, 3).tolist(),
        })
        if len(chosen) >= 5:
            break
    return {
        "site_id": site_id, "site_label": site_info["label"], "body": body,
        "family_gate": family, "earth_site_gate": allowed,
        "size_m": size_m, "actual_grid_cells": cells,
        "actual_sampled_side_m": cells * SPACING_M,
        "moon_offset_east_north_m": [round(v, 1) for v in actual_offset],
        "reference_height": np.round(_normal(reference_grid), 3).tolist(),
        "reference_forms": reference_forms.tolist(),
        "searched_windows": len(indices), "matches": chosen,
        "method": "2014 55-bin geomorphon Wave-Hedges baseline; top-80 D4 shape verification",
        "interpretation": "Candidate morphology only. No window-level rock mask, material prediction, or verified geological identity.",
        "resolution_warning": ("200 m contains only 7 Earth DEM cells across; CTX true resolved detail may also be coarser than its 20 m posts; no credible exact-match claim"
                               if size_m == 200 else None),
        "reference_source_url": site_info["evidence"],
        "source_resolution_m": site_info.get("source_resolution_m"),
        "center_lat_lon": site_info["center_lat_lon"],
        "reference_context": site_info.get("context"),
        "reference_context_url": site_info.get("context_url"),
        # Earth heights in this mode derive from Copernicus GLO-30; the licence requires this notice.
        "earth_source": {
            "dataset": "Copernicus DEM GLO-30",
            "description": manifest["earth_dem"],
            "attribution": LEGACY_EARTH_ATTRIBUTION,
            "modification": "Modified data: heights cropped, resampled to the comparison grid and normalised for shape comparison.",
            "licence_source": "https://registry.opendata.aws/copernicus-dem/",
        },
    }
