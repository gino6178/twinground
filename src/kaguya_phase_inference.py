"""Read precomputed tiny-model lunar npFe/mpFe proxy estimates by window."""

from __future__ import annotations

import hashlib
import json
import math
from functools import lru_cache

import numpy as np

from lunar_pipeline import ROOT


GRID_PATH = ROOT / "data/moon/tiny_kaguya_phase_prediction_grid_05deg.npz"
MANIFEST_PATH = ROOT / "data/moon/tiny_kaguya_phase_prediction_grid_05deg.json"
REPORT_PATH = ROOT / "data/moon/tiny_kaguya_phase_training.json"
SOURCE_URL = "https://data.lroc.im-ldi.com/lroc/view_rdr/WAC_HAPKE"


@lru_cache(maxsize=1)
def prediction_grid() -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    digest = hashlib.sha256(GRID_PATH.read_bytes()).hexdigest()
    if digest != manifest["output_sha256"]:
        raise ValueError("Kaguya phase prediction grid does not match its manifest")
    with np.load(GRID_PATH) as grid:
        npfe = grid["npfe_wt"]
        mpfe = grid["mpfe_wt"]
        valid = grid["valid"]
    if any(array.shape != (240, 720) for array in (npfe, mpfe, valid)):
        raise ValueError("Unexpected Kaguya phase prediction grid shape")
    if not (np.isfinite(npfe[valid]).all() and np.isfinite(mpfe[valid]).all()):
        raise ValueError("Nonfinite valid prediction cell")
    report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
    if hashlib.sha256(REPORT_PATH.read_bytes()).hexdigest() != manifest["training_report_sha256"]:
        raise ValueError("Kaguya phase report does not match the served grid")
    return npfe, mpfe, valid, report


def predict_kaguya_phase(lat: float, lon: float, patch_km: float) -> dict:
    """Median 0.5° cell estimates in a selected physical lunar square."""
    base = {"available": False, "source_url": SOURCE_URL,
            "model": "TinyKaguyaPhaseHead", "model_kind": "precomputed local neural grid"}
    if not GRID_PATH.is_file() or not MANIFEST_PATH.is_file() or not REPORT_PATH.is_file():
        return {**base, "reason": "Trained phase-prediction grid unavailable"}
    half_lat = patch_km / 30.32 / 2
    if lat - half_lat < -60 or lat + half_lat > 60:
        return {**base, "reason": "Outside Diviner/Kaguya training latitude ±60°"}
    half_lon = half_lat / max(math.cos(math.radians(lat)), 0.5)
    ys = np.arange(max(0, math.floor((60 - lat - half_lat) * 2)),
                   min(239, math.floor((60 - lat + half_lat) * 2)) + 1)
    xs = np.arange(math.floor((lon - half_lon) * 2),
                   math.floor((lon + half_lon) * 2) + 1) % 720
    npfe, mpfe, valid, report = prediction_grid()
    cells = valid[np.ix_(ys, xs)]
    total, covered = int(cells.size), int(cells.sum())
    if not covered or covered / total < 0.5:
        return {**base, "reason": "Insufficient Diviner/LP/WAC feature coverage",
                "covered_cells": covered, "sampled_cells": total}
    selected_npfe = npfe[np.ix_(ys, xs)][cells]
    selected_mpfe = mpfe[np.ix_(ys, xs)][cells]
    result = report["variants"][str(report["selected_input_features"])]
    return {
        **base,
        "available": True,
        "parameters": result["parameters"],
        "nanophase_wt_percent_prediction": round(float(np.median(selected_npfe)), 3),
        "microphase_wt_percent_prediction": round(float(np.median(selected_mpfe)), 3),
        "covered_cells": covered,
        "sampled_cells": total,
        "cell_degrees": 0.5,
        "held_out_cell_mae_wt_percent": {
            "nanophase": result["held_out_test"]["nanophase_iron"]["mae_wt_percent"],
            "microphase": result["held_out_test"]["microphase_iron"]["mae_wt_percent"],
        },
        "interpretation": "Proxy for published Kaguya MI-derived Hapke iron-phase maps; held-out errors are per-cell, not window-level uncertainty or mineral identification",
    }
