"""Window reading and Earth-analog search for the Moon and Mars.

Flow for /api/search and /api/mars-search:

1. Read the query window (DEM grid, display mesh, sampling evidence).
2. Score every Earth window of the same scale with the terrain encoder cosine.
3. Let the selected *purpose* re-score those windows (facets, conditions, ...).
4. Context fusion + optional visual rerank -> shortlist -> spatial groups.
5. Build one evidence record per returned group.

Each purpose contributes a ``Ranking``: the scores used for ordering, the
cosine shown to the user, and how the 0-100 display score is computed.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np

from . import resources as res
from .params import Query, moon_window

from lunar_pipeline import (MOON_DEM, MOON_DEM_HI, PATCH_KM, ROOT, earth_lithology_observation, earth_patch,
                            embed, etopo_15s_patch, global_earth_patch_windowed, kaguya_space_weathering_observation,
                            lunar_dem, lunar_geochemistry_observation, material_observation, mesh_payload,
                            moon_patch)
from candidate_groups import group_ranked, index_provenance, sampling_footprint
from context_ranker import rank_context, resolve_target
from dune_context import dune_window_evidence
from earth_landform_context import landform_catalog_context
from global_sampling_support import global_support_audit
from kaguya_phase_inference import predict_kaguya_phase
from lroc_dtm_coverage import lroc_dtm_coverage
from mars_global import patch_at as mars_patch_at, reference_at as mars_reference_at
from mars_reference import mars_patch, reference as mars_reference
from moon_crater_inference import predict_crater_center
from moon_geology import geology_observation
from terrain_match import compare_features, describe_terrain
from terrain_sampling import sampling_evidence
from train_tiny_material_head import predict_feo
from scripts.known_analogs import service as known_analogs
from scripts.visual_geology_v1.global_index import compare as global_visual_compare

PURPOSES = ("morphology", "surface", "terrain_test", "lavatube", "material", "conditions", "physical", "facets",
            "maxmatch")
OWN_SECOND_STAGE = ("lavatube", "material", "physical", "facets", "maxmatch")
BASE_MODEL = "tiny-terrain-encoder-global-v3+context-fusion-v1"
RESOLUTION_NOTE = {
    "ETOPO_2022_60s": "約 1.85 km 原始格網（全球粗篩）",
    "ETOPO_2022_15s": "約 0.46 km 原始格網（全球粗篩）",
}


def clamp_score(cosine: float) -> float:
    return round(max(0.0, min(100.0, (cosine + 1.0) * 50)), 1)


# ---- step 1: the query window ----------------------------------------------

@dataclass
class Window:
    body: str
    lat: float
    lon: float
    size_km: int
    grid: np.ndarray
    display_grid: np.ndarray
    site: Optional[dict] = None

    @property
    def is_mars(self):
        return self.body == "mars"


def read_window(q: Query, is_mars: bool) -> Window:
    if not is_mars:
        lat, lon, size_km = moon_window(q)
        return Window("moon", lat, lon, size_km, moon_patch(lat, lon, patch_km=size_km),
                      moon_patch(lat, lon, size=64, patch_km=size_km))
    size_km = q.int("size_km", "40")
    if "lat" in q or "lon" in q:
        if "lat" not in q or "lon" not in q:
            raise ValueError("火星選區需同時提供經緯度。")
        lat, lon = q.float("lat"), q.float("lon")
        return Window("mars", lat, lon, size_km, mars_patch_at(lat, lon, size_km),
                      mars_patch_at(lat, lon, size_km, size=64), mars_reference_at(lat, lon))
    site = mars_reference(q.str("site", "jezero"))
    return Window("mars", site["latitude"], site["longitude_east"], size_km, mars_patch(site["id"], size_km),
                  mars_patch(site["id"], size_km, size=64), site)


def window_answer(w: Window) -> dict:
    answer = {"window": {"lat": round(w.lat, 5), "lon": round(w.lon, 5), "body": w.body,
                         "site_id": w.site["id"] if w.is_mars else None, "patch_km": w.size_km,
                         "terrain": mesh_payload(w.display_grid)}}
    if w.is_mars:
        spacing = w.site["source_resolution_m"]
        source_id = w.site.get("source_raster", "data/mars_global/megt90n000fb.img")
        source_kind = "prepared_local_grid" if w.site.get("source_raster") else "global_angular_grid"
        answer["mars_reference"] = w.site
    else:
        answer["moon_crater_center"] = predict_crater_center(w.grid, w.size_km, w.lat)
        try:
            answer["lroc_dtm_coverage"] = lroc_dtm_coverage(w.lat, w.lon, w.size_km)
        except Exception as exc:
            print("LROC DTM coverage request error:", repr(exc), flush=True)
            answer["lroc_dtm_coverage"] = {"available": False, "reason": "LROC DTM 覆蓋索引暫時無法讀取",
                                           "source_url": "https://data.lroc.im-ldi.com/lroc/view_rdr/SHAPEFILE_NAC_DTMS"}
        spacing = math.pi * 1737400 / lunar_dem().shape[0]
        hi = MOON_DEM_HI.exists() and MOON_DEM_HI.stat().st_size > 500_000_000
        source_id = str((MOON_DEM_HI if hi else MOON_DEM).relative_to(ROOT))
        source_kind = "global_angular_grid"
    answer["window"]["sampling"] = sampling_evidence(w.body, w.size_km, w.grid, w.display_grid,
                                                     spacing, source_id, source_kind)
    # SysOne-Nano reading: evidence only, never used for ranking.
    from scripts.sysone_nano import service as sysone
    try:
        answer["terrain_read"] = sysone.query_read(w.body, w.lat, w.lon, w.size_km)
    except Exception as exc:
        print("SysOne-Nano read error:", repr(exc), flush=True)
        answer["terrain_read"] = None
    return answer


# ---- step 3: purpose-specific ranking -------------------------------------

@dataclass
class Ranking:
    scores: np.ndarray                      # ordering scores, one per searched window
    cosine: np.ndarray                      # terrain cosine reported per candidate
    model: str = BASE_MODEL
    display: Optional[Callable[[int], Optional[float]]] = None  # 0-100 score, or None -> fallback
    clamp_cosine: bool = False              # fallback shows clamped cosine instead of fused context
    rank_note: dict = field(default_factory=dict)  # extra top-level answer fields
    candidate_extra: Optional[Callable[[int, dict], dict]] = None


@dataclass
class Context:
    w: Window
    q: Query
    rows: list
    row_indices: np.ndarray
    cosine: np.ndarray
    conditions: Optional[dict] = None
    physical: Optional[tuple] = None   # (properties, summary, physmatch module)
    facets: Optional[dict] = None
    facet_use: str = "overall"


def rank_terrain(c: Context) -> Ranking:
    return Ranking(c.cosine, c.cosine)


def rank_material(c: Context) -> Ranking:
    """Half terrain cosine, half occlusion-robust inferred material similarity (rank-normalised)."""
    from scripts.material_v5 import material_query as mq, material_service as msvc
    w = c.w
    query = mq.mars_descriptor(w.lat, w.lon, w.size_km) if w.is_mars else mq.moon_descriptor(w.lat, w.lon, w.size_km)
    target, weights = mq.target_axes(query)
    positions = msvc.inferred()["pos"]
    sim = msvc.inferred_similarity_array(target, weights,
                                         np.array([positions.get(c.rows[int(i)]["id"], -1) for i in c.row_indices]))

    def z(a):
        return (a - np.nanmean(a)) / (np.nanstd(a) + 1e-9)

    fused = 0.5 * z(c.cosine) + 0.5 * np.nan_to_num(z(sim), nan=-5.0)
    rank = np.argsort(np.argsort(fused, kind="stable"), kind="stable")
    scores = (2.0 * rank / max(len(rank) - 1, 1) - 1.0).astype(np.float32)

    def finish(answer, groups):
        top = [c.rows[int(c.row_indices[g["representative_index"]])]["id"] for g in groups[:15]]
        answer["material"] = dict(
            {"query": query, "target": target, "weights": weights},
            fine_job=msvc.start_observation(target, weights, top), fine_candidates=top,
            method="Terrain cosine (production encoder) + occlusion-robust material inference (geology, dryness, "
                   "climate, soil, nearby Sentinel-2 observations); Sentinel-2 check of the top groups",
            evaluation_summary=msvc.evaluation_summary())

    return Ranking(scores, c.cosine, BASE_MODEL, clamp_cosine=True, rank_note={"finish": finish},
                   candidate_extra=lambda i, row: {"material_context": msvc.inferred_detail(row["id"], target, weights)})


def rank_lavatube(c: Context) -> Ranking:
    """PitChain-C2F v2 coarse stage: basaltic-volcano gate, then C-Enc v2 terrain cosine."""
    from scripts.lavatube_c2f import service as lavatube
    w = c.w
    scores, cosine, meta = lavatube.coarse_scores(w.body, w.lat, w.lon, w.size_km, c.rows, c.row_indices)

    def finish(answer, groups):
        reps = [c.rows[int(c.row_indices[g["representative_index"]])] for g in groups[:15]]
        candidates = [{"id": r["id"], "lat": r["center"]["latitude"], "lon": r["center"]["longitude_east"]}
                      for r in reps]
        answer["lavatube"] = {
            "coarse": meta,
            "fine_job": lavatube.start_fine(w.body, w.lat, w.lon, w.size_km, candidates),
            "fine_candidates": [x["id"] for x in candidates],
            "method": "PitChain-C2F v2: basaltic-volcano gate + C-Enc v2 terrain ranking; F-Net v2 pit detection "
                      "on the query's NAC/HiRISE image; lidar pit detection on Earth candidates where 3DEP is held",
            "evaluation": "data/research/lavatube_c2f/results_E3v2_coarse.json, results_v2_fine.json",
            "evaluation_summary": lavatube.evaluation_summary()}

    return Ranking(scores, cosine, "pitchain-c2f-v2 (gvp-gate + cenc-v2; fnet-v2)", clamp_cosine=True,
                   rank_note={"finish": finish},
                   candidate_extra=lambda i, row: {"lavatube_context": lavatube.nearest_volcano(
                       row["center"]["latitude"], row["center"]["longitude_east"])})


def rank_conditions(c: Context) -> Ranking:
    """Windows failing the condition gate rank below every passing window, each keeping terrain order."""
    from scripts.conditions_v1 import service as conditions
    if c.conditions is None:
        raise ValueError("Condition profile unavailable for this window")
    gate, _fit, meta = conditions.gate(c.conditions, c.rows, c.row_indices)
    scores = np.where(gate, 0.5 * c.cosine + 0.5, 0.5 * c.cosine - 0.5).astype(np.float32)
    return Ranking(scores, c.cosine, BASE_MODEL, clamp_cosine=True, rank_note={"conditions_gate": meta})


def rank_physical(c: Context) -> Ranking:
    from scripts.physmatch_v5 import service as physmatch
    if c.physical is None:
        raise ValueError("Physical match unavailable for this window")
    use = c.q.choice("use", physmatch.S.USES, "isru", "Unknown physical use")
    a_all, _ = physmatch.use_scores_all(c.w.body, c.physical[0], use)
    if a_all is None:
        raise ValueError("This window has none of the properties of this use")
    pmap = physmatch.scale_map(c.w.size_km, c.rows, c.row_indices)
    a = np.where(pmap >= 0, a_all[np.maximum(pmap, 0)], 0.0)
    scores = np.where(pmap >= 0, a + 0.01 * (c.cosine + 1) / 2 - 0.5, -1.0).astype(np.float32)
    return Ranking(scores, c.cosine, "physmatch-v5 (measured same-unit properties; terrain cosine only breaks ties)",
                   display=lambda i: round(float(a[i]) * 100, 1), rank_note={"answer": {"physical_use": use}})


def rank_facets(c: Context) -> Ranking:
    from scripts.facets_v6 import service as facets
    if c.facets is None:
        raise ValueError("Facet profile unavailable for this window")
    s, fs = facets.use_score(c.facets, facets.positions(c.rows, c.row_indices, c.w.size_km), c.cosine, c.facet_use)
    scores = np.where(np.isfinite(s), s - 0.5, -1.0).astype(np.float32)
    return Ranking(scores, c.cosine, "facets-v6 (ten scored facets; fixed rules)",
                   display=lambda i: round(float(s[i]) * 100, 1),
                   rank_note={"answer": {"facet_use": c.facet_use}, "facet_scores": (s, fs)})


def rank_maxmatch(c: Context) -> Ranking:
    """Most measured properties within tolerance; nothing learned, no geologic rule."""
    from scripts.atlas_match import maxmatch as mm
    scaled, x, ev, pos = mm.rank_rows(c.w.body, c.w.lat, c.w.lon, c.rows, c.row_indices, c.w.size_km)

    def display(i):
        if pos[i] < 0:
            return None
        return round(100.0 * float(ev["matched"][pos[i]]) / max(len(ev["props"]), 1), 1)

    return Ranking(scaled, c.cosine, "maxmatch-1.0 (measured properties within tolerance; nothing learned)",
                   display=display, rank_note={"answer": {"maxmatch": mm.summary(c.w.body, ev)}},
                   candidate_extra=lambda i, row: {"maxmatch": mm.candidate(c.w.body, x, ev, int(pos[i]))})


RANKERS = {"material": rank_material, "lavatube": rank_lavatube, "conditions": rank_conditions,
           "physical": rank_physical, "facets": rank_facets, "maxmatch": rank_maxmatch}


# ---- shared evidence profiles (shown for every purpose) -------------------

def conditions_profile(w: Window):
    from scripts.conditions_v1 import service as conditions
    try:
        return conditions.query_profile(w.body, w.lat, w.lon, w.size_km)
    except Exception as exc:
        print("Conditions profile error:", repr(exc), flush=True)
        return None


def physical_profile(w: Window):
    try:
        from scripts.physmatch_v5 import service as physmatch
        props = physmatch.query_properties(w.body, w.lat, w.lon, w.size_km, w.grid)
        return props, physmatch.summary(w.body, w.lat, w.lon, w.size_km, w.grid), physmatch
    except Exception as exc:
        print("Physical match error:", repr(exc), flush=True)
        return None


def facets_profile(w: Window, cond):
    if cond is None:
        return None
    try:
        from scripts.facets_v6 import service as facets
        return facets.profile(w.body, w.lat, w.lon, w.size_km, cond)
    except Exception as exc:
        print("Facets profile error:", repr(exc), flush=True)
        return None


def facets_measured(w: Window):
    if w.is_mars:
        return {}
    try:
        from scripts.facets_v61 import moon
        return moon.summary(float(w.lat), float(w.lon), float(w.size_km))
    except Exception as exc:
        print("measured v6.1 error:", repr(exc), flush=True)
        return {}


# ---- step 5: candidate records --------------------------------------------

def candidate_terrain(row, size_km, sites):
    center = row["center"]
    if row.get("dataset") == "ETOPO_2022_60s":
        return global_earth_patch_windowed(center["latitude"], center["longitude_east"], size_km, size=64)
    if row.get("dataset") == "ETOPO_2022_15s":
        return etopo_15s_patch(center["latitude"], center["longitude_east"], size_km, row["tile"], size=64)
    return earth_patch(sites[row["site_id"]]["grid"], size=64, scale=size_km / PATCH_KM,
                       center_y=row["center_y"], center_x=row["center_x"])


def search(q: Query, is_mars: bool) -> dict:
    from scripts.conditions_v1 import display as cond_display, service as conditions
    from scripts.facets_v6 import service as facets
    from scripts.facets_v7.biology import nearest_any
    from scripts.sysone_nano import service as sysone

    model, sites, rows, scale_data, report = res.resources()
    w = read_window(q, is_mars)
    answer = window_answer(w)
    purpose = q.str("purpose", "morphology")
    if purpose not in PURPOSES:
        raise ValueError("Unknown research purpose")
    answer.update(purpose=purpose, stored_dem_quality_gate=report["stored_dem_quality_gate"],
                  global_dem_quality_gate=report["global_dem_quality_gate"],
                  purpose_note="Presentation and evidence focus only; no learned purpose-specific ranker is deployed.")
    limit = q.int("limit", "5")
    if not 1 <= limit <= 30:
        raise ValueError("Candidate limit must be between 1 and 30")
    offset = q.int("offset", "0")
    if not 0 <= offset <= 512:
        raise ValueError("Candidate offset must be between 0 and 512")

    # Step 2: terrain cosine against every eligible window of this scale.
    vector = embed(model, w.grid)
    reference_shape = describe_terrain(w.display_grid, w.size_km * 1000 / (w.display_grid.shape[0] - 1))
    row_indices, scale_vectors = scale_data[w.size_km]
    cosine = scale_vectors @ vector

    ctx = Context(w, q, rows, row_indices, cosine)
    ctx.conditions = conditions_profile(w)
    ctx.physical = physical_profile(w)
    ctx.facets = facets_profile(w, ctx.conditions)
    ctx.facet_use = q.str("facet_use", "overall")
    if ctx.facets is not None and ctx.facet_use not in facets.USES:
        raise ValueError("Unknown facet use")

    # Step 3.
    ranking = RANKERS.get(purpose, rank_terrain)(ctx)
    scores = ranking.scores
    answer.update(ranking.rank_note.get("answer", {}))

    # Step 4.
    ref_geology = None if is_mars else geology_observation(w.lat, w.lon, w.size_km)
    target = (resolve_target("any", "any", ref_geology) if purpose in ("physical", "maxmatch")
              else resolve_target(q.str("surface", "any"), q.str("rock", "auto"), ref_geology))
    shortlist, context_meta, context_scores = rank_context(rows, row_indices, scores, w.size_km, target)
    eligible = np.ones(len(row_indices), dtype=bool)  # full-index eligibility, before any visual rerank
    if target["surface"] == "desert":
        eligible &= context_scores["desert"] >= .6
    if target["surface"] == "mapped_dunes":
        eligible &= context_scores["dunes"] >= .6
    if target["rock_index"] is not None:
        eligible &= context_scores["rock"] >= .6
    context_scores["eligible"] = eligible
    if purpose in OWN_SECOND_STAGE:
        visual_meta, visual_scores = {"applied": False, "reason": "this mode has its own second stage"}, {}
    else:
        shortlist, visual_meta, visual_scores = global_visual_compare(
            rows, row_indices, shortlist, context_scores, w.body, w.lat, w.lon, w.size_km,
            q.str("visual", "complete"))
    answer["global_visual"] = visual_meta
    answer["context_ranking"] = context_meta
    groups = group_ranked(rows, row_indices, shortlist, context_scores["fused"], w.size_km)
    page = groups[offset:offset + limit]
    answer["index_provenance"] = index_provenance()
    answer["candidate_groups"] = {
        "method": "rank-ordered leader-radius-v1", "radius_km": w.size_km * 1.5,
        "shortlisted_windows": len(shortlist), "group_count": len(groups), "returned_groups": len(page),
        "offset": offset, "next_offset": offset + limit if offset + limit < len(groups) else None,
        "limit": limit, "scope": "Only the top-512 eligible shortlist; not all eligible windows or verified sites."}
    catalogue = known_analogs.summary()
    answer["known_analog_catalogue"] = catalogue

    # Step 5.
    support = global_support_audit()
    facet_use = ctx.facet_use
    matches = []
    for group in page:
        index = int(group["representative_index"])
        row = rows[int(row_indices[index])]
        lat, lon = row["center"]["latitude"], row["center"]["longitude_east"]
        cos = float(ranking.cosine[index])
        score = ranking.display(index) if ranking.display else None
        if score is None:
            score = clamp_score(cos) if ranking.clamp_cosine else round(float(context_scores["fused"][index]) * 100, 1)
        terrain = candidate_terrain(row, w.size_km, sites)
        earth_shape = describe_terrain(terrain, w.size_km * 1000 / (terrain.shape[0] - 1))
        gap = compare_features(reference_shape, earth_shape)
        record = {
            "id": row["id"], "name": row["name"],
            "spatial_group": {k: v for k, v in group.items() if k != "representative_index"},
            "sampling_footprint": sampling_footprint(row, w.size_km, None if row.get("dataset") else sites.get(row["site_id"])),
            "sampling_support": (support.support(row) if row.get("dataset") in ("ETOPO_2022_15s", "ETOPO_2022_60s")
                                 else row.get("sampling_support")),
            "valid_fraction_interpretation": "Stored index statistic, not a live native-pixel coverage measurement. "
                                             "For legacy SRTM this describes the entire prepared source raster, not this candidate window.",
            "mapped_dunes": dune_window_evidence(lat, lon, w.size_km),
            "center": row["center"],
            "score": score,
            "terrain_read": sysone.candidate_read(w.body, row["id"]) if answer["terrain_read"] else None,
            "physical_match": (ctx.physical[2].candidate_block(w.body, ctx.physical[0], ctx.physical[1], lat, lon)
                               if ctx.physical is not None else None),
            "conditions": (cond_display.decorate(ctx.conditions, row["id"], conditions.candidate(
                ctx.conditions, row["id"], abs(reference_shape["slope_deg"]["mean"] - earth_shape["slope_deg"]["mean"])))
                if ctx.conditions is not None else None),
            "facets": facets.candidate(ctx.facets, row["id"], cos, facet_use) if ctx.facets is not None else None,
            "maxmatch": None, "material_context": None, "lavatube_context": None,
        }
        if ranking.candidate_extra:
            record.update(ranking.candidate_extra(index, row))
        if catalogue["available"]:  # key omitted when unavailable, so null always means a new candidate
            record["known_analog"] = known_analogs.nearest(lat, lon, w.body)
        record.update({
            "catalogue_nearest": nearest_any(lat, lon),
            "visual_similarity": {"available": row["id"] in visual_scores, "cosine": visual_scores.get(row["id"]),
                                  "sample_m": 1536, "used_in_ranking": bool(visual_meta.get("applied"))},
            "geometry_score": clamp_score(cos),
            "cosine": round(cos, 4),
            "context_match": {
                "fusion_score": round(float(context_scores["fused"][index]), 5),
                "desert_sample_share": round(float(context_scores["desert"][index]), 3),
                "dune_positive_sample_share": (round(float(context_scores["dunes"][index]), 3)
                                               if context_scores["dunes"] is not None else None),
                "rock_sample_share": round(float(context_scores["rock"][index]), 3),
                "context_applied": context_meta["context_applied"]},
            "valid_fraction": row["valid_fraction"],
            "source": row.get("source", "NOAA ETOPO 2022 ice-surface elevation 15 arc-second"),
            "source_url": row.get("source_url", "https://www.ncei.noaa.gov/products/etopo-global-relief-model"),
            "dataset_label": row.get("dataset_label", "NOAA / ETOPO 2022 15s" if row.get("dataset") == "ETOPO_2022_15s"
                                     else "USGS / SRTM"),
            "resolution_note": RESOLUTION_NOTE.get(row.get("dataset"), "約 320 m 的 SRTM 重採樣窗格"),
            "terrain": mesh_payload(terrain),
            "geometry_audit": {
                "method": "untrained seven-component DEM descriptor; diagnostic only",
                "feature_distance": gap["feature_distance"],
                "feature_distances": gap["feature_distances"],
                "reference_mean_slope_deg": round(reference_shape["slope_deg"]["mean"], 2),
                "earth_mean_slope_deg": round(earth_shape["slope_deg"]["mean"], 2),
                "reference_roughness_p90_m": round(reference_shape["roughness_m"]["p90"], 1),
                "earth_roughness_p90_m": round(earth_shape["roughness_m"]["p90"], 1),
                "note": "Same-size 64x64 coarse DEM comparison; neither an analog probability nor part of neural ranking"},
            "earth_lithology": earth_lithology_observation(lat, lon, w.size_km),
            "earth_landform_context": landform_catalog_context(lat, lon, w.size_km),
            "site_id": row["site_id"],
            "patch_km": w.size_km,
        })
        matches.append(record)

    if visual_meta.get("applied") and visual_meta.get("partial"):
        answer["candidate_groups"]["next_offset"] = None
        answer["candidate_groups"]["scope"] = ("Partial visual index snapshot;refresh query for updated candidates,"
                                               "not paginated across changing index.")
    answer["matches"] = matches
    if ctx.conditions is not None:
        answer["conditions"] = {**conditions.summary(ctx.conditions), "gate": ranking.rank_note.get("conditions_gate"),
                                "ranking": ("condition gate, then the production terrain encoder" if purpose == "conditions"
                                            else "not used for ranking in this purpose")}
    if ctx.facets is not None:
        s, fs = ranking.rank_note.get("facet_scores", (None, None))
        answer["facets"] = {**facets.summary(ctx.facets, s, fs, facet_use), "measured": facets_measured(w),
                            "ranking": ("weighted facet score of this use" if purpose == "facets"
                                        else "not used for ranking in this purpose")}
    if "finish" in ranking.rank_note:
        ranking.rank_note["finish"](answer, groups)

    model_name = ranking.model
    if model_name == BASE_MODEL:
        if visual_meta.get("applied"):
            model_name += "+tiny-visual-geology-v1"
        if purpose == "material":
            model_name += "+material-inference-v1"
        elif purpose == "conditions":
            model_name += "+conditions-v1-gate"
    answer["model"] = model_name
    if ctx.physical is not None:
        answer["physical_match"] = ctx.physical[1]
    answer["model_sha256"] = res.model_sha256()
    answer["model_transfer_status"] = (
        "exploratory Mars-to-Earth geometry screening; Moon-trained encoder has no expert analog validation" if is_mars
        else "exploratory Moon-to-Earth geometry screening; no expert analog validation")
    answer["searched_windows"] = len(row_indices)
    answer["search_scope"] = ("global coarse land screening at 20/40 km from 15s ETOPO"
                              if w.size_km in (20, 40) and len(row_indices) > 295
                              else "global coarse land screening at 80 km" if w.size_km == 80 and len(rows) > 295
                              else "five SRTM regions")
    if not is_mars:
        answer.update(moon_side_observations(w))
    return answer


def moon_side_observations(w: Window) -> dict:
    return {
        "moon_material": material_observation(w.lat, w.lon, w.size_km),
        "moon_geology": geology_observation(w.lat, w.lon, w.size_km),
        "moon_geochemistry": lunar_geochemistry_observation(w.lat, w.lon, w.size_km),
        "moon_space_weathering": kaguya_space_weathering_observation(w.lat, w.lon, w.size_km),
        "moon_feo_prediction": predict_feo(w.lat, w.lon, w.size_km),
        "moon_phase_prediction": predict_kaguya_phase(w.lat, w.lon, w.size_km),
    }


def window(q: Query, is_mars: bool) -> dict:
    return window_answer(read_window(q, is_mars))
