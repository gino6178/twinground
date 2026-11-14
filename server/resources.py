"""Load the terrain model and every Earth window index once per process.

Each index file is checked against the model hash it was built with, so a
retrained encoder can never be searched against stale vectors.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import config
from lunar_pipeline import MODEL_PATH, SCALES_KM, earth_sites, load_model
from global_pixel_centers import VERSION as GLOBAL_SAMPLING_VERSION
from global_sampling_support import global_support_audit
from local_sampling_support import local_sampling_support

DATA = config.ROOT / "data"
LOCAL_INDEX = (DATA / "moon/earth_window_index.npz", DATA / "moon/earth_window_index.json")
GLOBAL_80KM = (DATA / "earth_global/etopo_80km_index.npz", DATA / "earth_global/etopo_80km_index.json")
SUPPLEMENT_80KM = (DATA / "earth_global/etopo_80km_supplement.npz", DATA / "earth_global/etopo_80km_supplement.json")
FINE_20_40KM = (DATA / "earth_global/etopo_15s_20_40km_index.npz", DATA / "earth_global/etopo_15s_20_40km_index.json")
FINE_TILES = DATA / "earth_global/etopo_15s_tiles/manifest.json"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


@lru_cache(maxsize=1)
def model_sha256() -> str:
    return file_sha256(MODEL_PATH)


@dataclass(frozen=True)
class SearchResources:
    model: object
    sites: dict
    rows: list
    scale_data: dict  # scale_km -> (row indices, float32 vectors)
    report: dict

    def __iter__(self):  # legacy tuple unpacking: model, sites, rows, scale_data, report
        return iter((self.model, self.sites, self.rows, self.scale_data, self.report))


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _load_global(npz: Path, meta_path: Path, model_hash: str, label: str, strict_count=False):
    meta = _read_json(meta_path)
    if meta.get("sampling_version") != GLOBAL_SAMPLING_VERSION:
        raise RuntimeError(f"{label} index needs pixel-center re-embedding")
    if meta.get("vectors_sha256") != file_sha256(npz):
        raise RuntimeError(f"{label} vectors do not match their metadata")
    if meta["model_sha256"] != model_hash:
        raise RuntimeError(f"{label} index was built with different model weights")
    vectors = np.load(npz)["vectors"]
    if strict_count and (meta["count"] != len(meta["rows"]) or vectors.shape != (meta["count"], meta["dimensions"])):
        raise RuntimeError(f"{label} index metadata and vectors differ")
    return meta["rows"], vectors


@lru_cache(maxsize=1)
def resources() -> SearchResources:
    model = load_model()
    sites = earth_sites()
    npz, meta_path = LOCAL_INDEX
    if not npz.exists() or not meta_path.exists():
        raise RuntimeError("Build the Earth window index: python src/build_earth_index.py")
    metadata = _read_json(meta_path)
    model_hash = metadata["model_sha256"]
    if model_hash != model_sha256():
        raise RuntimeError("Earth index was built with different model weights")
    rows = list(metadata["rows"])
    blocks = [np.load(npz)["vectors"]]

    if all(p.exists() for p in GLOBAL_80KM):
        extra_rows, extra = _load_global(*GLOBAL_80KM, model_hash, "Global Earth")
        rows += extra_rows
        blocks.append(extra)
    if SUPPLEMENT_80KM[0].exists() != SUPPLEMENT_80KM[1].exists():
        raise RuntimeError("Supplemental 80 km index is incomplete")
    if SUPPLEMENT_80KM[1].exists():
        extra_rows, extra = _load_global(*SUPPLEMENT_80KM, model_hash, "Supplemental 80 km", strict_count=True)
        rows += extra_rows
        blocks.append(extra)
    if all(p.exists() for p in FINE_20_40KM) and FINE_TILES.exists():
        fine = _read_json(FINE_20_40KM[1])
        if fine["model_sha256"] != model_hash:
            raise RuntimeError("NOAA 15s index was built with different model weights")
        rows += fine["rows"]
        blocks.append(np.load(FINE_20_40KM[0])["vectors"])
    vectors = np.concatenate(blocks, axis=0)

    global_quality = global_support_audit().apply(rows)
    local_quality = []
    for row in rows:
        if not row.get("dataset"):
            row["sampling_support"] = local_sampling_support(sites[row["site_id"]], row, row["patch_km"])
            local_quality.append(row["sampling_support"])

    patch_km = np.fromiter((row["patch_km"] for row in rows), dtype=np.int32, count=len(rows))
    eligible = np.fromiter((row.get("sampling_support", {}).get("eligible_for_search", True) for row in rows),
                           dtype=np.bool_, count=len(rows))
    scale_data = {}
    for scale in SCALES_KM:
        indices = np.flatnonzero((patch_km == scale) & eligible)
        # NumPy float16 matmul is slow on CPU, so search matrices stay float32.
        scale_data[scale] = (indices, np.ascontiguousarray(vectors[indices], dtype=np.float32))

    report = _read_json(MODEL_PATH.parent / "tiny_terrain_training.json")
    report["global_dem_quality_gate"] = global_quality
    report["stored_dem_quality_gate"] = {
        "version": "stored-local-dem-gate-v1",
        "checked_local_windows": len(local_quality),
        "excluded_local_windows": sum(not item["eligible_for_search"] for item in local_quality),
        "rule": "Require a fully valid stored local source pixel rectangle and no edge clamping; "
                "global ETOPO sampling validity remains a separate audit.",
    }
    return SearchResources(model, sites, rows, scale_data, report)


@lru_cache(maxsize=1)
def rows_by_id() -> dict:
    return {row["id"]: row for row in resources().rows}


def has_supplement() -> bool:
    return SUPPLEMENT_80KM[1].exists()
