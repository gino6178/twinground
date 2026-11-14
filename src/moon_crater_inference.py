"""Fast, local inference for locked 20 and 40 km lunar crater-center heads.

The output is a balanced-sample classification score, not a calibrated
probability of a crater at an arbitrary lunar location.
"""

from __future__ import annotations

import math
import hashlib
import json
from functools import lru_cache

import numpy as np
import torch
from torch import nn

from lunar_pipeline import ROOT, model_input


WEIGHTS = ROOT / "data/moon/tiny_radial_crater_head_40km.pt"
SMALL_WEIGHTS = ROOT / "data/research/small_earth_morphology_holdout/tiny_small_crater_radial_20km.pt"
SMALL_REPORT = ROOT / "data/research/small_earth_morphology_holdout/tiny_small_crater_radial_20km.json"
SMALL_VALIDATION = ROOT / "data/research/sombench_crater_audit/first_validation_dtm_morphology_evaluation.json"
SOURCE_URL = "https://astrogeology.usgs.gov/search/map/Moon/Research/Craters/lunar_crater_database_robbins_2018"


class RadialResidualNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.linear = nn.Linear(19, 1)
        self.residual = nn.Sequential(nn.Linear(19, 32), nn.GELU(),
                                      nn.Linear(32, 8), nn.GELU(), nn.Linear(8, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return (self.linear(x) + self.residual(x)).squeeze(-1)


class SmallCraterRadialNet(nn.Module):
    """The frozen 793-parameter 20 km radial head architecture."""

    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(19, 24), nn.GELU(),
                                 nn.Linear(24, 12), nn.GELU(), nn.Linear(12, 1))

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        return self.net(features).squeeze(-1)


def radial_features(image: np.ndarray, relief: np.float32) -> np.ndarray:
    """Use the exact 19 radial features saved in the training pipeline."""
    image = np.asarray(image, dtype=np.float32)[None]
    height, gradient = image[:, 0], image[:, 1]
    yy, xx = np.mgrid[:32, :32]
    radius = np.hypot(xx - 15.5, yy - 15.5)
    bands = ((0, 2), (2, 4), (4, 6), (6, 9), (9, 12), (12, 16))
    h = [height[:, (radius >= low) & (radius < high)].mean(axis=1)
         for low, high in bands]
    g = [gradient[:, (radius >= low) & (radius < high)].mean(axis=1)
         for low, high in bands]
    center = h[0]
    return np.column_stack((
        np.asarray([relief], dtype=np.float32), *h, *g,
        h[2] - center, h[3] - center, h[4] - center,
        np.maximum.reduce((h[2], h[3], h[4])) - center,
        height.std(axis=(1, 2)),
        np.percentile(gradient, 90, axis=(1, 2)),
    )).astype(np.float32)


@lru_cache(maxsize=1)
def _resources():
    # This checkpoint is built by this repository and contains NumPy scalers.
    checkpoint = torch.load(WEIGHTS, map_location="cpu", weights_only=False)
    if checkpoint["patch_km"] != 40 or checkpoint["input_size"] != 32:
        raise ValueError("Unexpected crater model scale")
    model = RadialResidualNet()
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return (model, np.asarray(checkpoint["feature_mean"], dtype=np.float32),
            np.asarray(checkpoint["feature_scale"], dtype=np.float32))


@lru_cache(maxsize=1)
def _small_resources():
    weights_sha = hashlib.sha256(SMALL_WEIGHTS.read_bytes()).hexdigest()
    training = json.loads(SMALL_REPORT.read_text(encoding="utf-8"))
    validation = json.loads(SMALL_VALIDATION.read_text(encoding="utf-8"))
    if (training["weights_sha256"] != weights_sha or
            validation["weights_sha256"] != weights_sha or
            validation["sites"] != 28):
        raise ValueError("20 km crater-head provenance changed")
    # The self-produced checkpoint contains NumPy feature-scaler arrays. Its
    # exact hash is checked before deserializing it.
    checkpoint = torch.load(SMALL_WEIGHTS, map_location="cpu", weights_only=False)
    if checkpoint["patch_km"] != 20 or checkpoint["input_size"] != 32:
        raise ValueError("Unexpected 20 km crater model scale")
    model = SmallCraterRadialNet()
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return (model, np.asarray(checkpoint["feature_mean"], dtype=np.float32),
            np.asarray(checkpoint["feature_scale"], dtype=np.float32), weights_sha)


def predict_crater_center(grid: np.ndarray, size_km: int, lat: float) -> dict:
    small = size_km == 20
    result = {"available": False,
              "model_parameters": 793 if small else 933 if size_km == 40 else None,
              "source_url": SOURCE_URL,
              "supported_size_km": size_km if size_km in (20, 40) else None,
              "target_diameter_km": "4–<8" if small else "10–30" if size_km == 40 else None}
    if size_km not in (20, 40):
        result["reason"] = "中心坑形模型支援 20 或 40 km 方形窗格"
        return result
    if abs(lat) > (73 if small else 74):
        result["reason"] = ("超過 20 km 模型外部驗證地點的最大絕對緯度 72.75°"
                            if small else "超出 40 km 模型已評估的 ±74° 緯度範圍")
        return result
    if np.asarray(grid).shape != (32, 32) or not np.isfinite(grid).all():
        result["reason"] = "LOLA 高程窗格不可用"
        return result
    image, relief = model_input(grid)
    if small:
        model, mean, scale, weights_sha = _small_resources()
    else:
        model, mean, scale = _resources()
    features = (radial_features(image, relief) - mean) / scale
    with torch.inference_mode():
        logit = float(model(torch.from_numpy(features)).item())
    score = 1 / (1 + math.exp(-max(-50.0, min(50.0, logit))))
    result.update({"available": True, "score": round(score, 4),
                   "label": "偏向中心撞擊坑形態" if score >= 0.5 else "偏向對照地形",
                   "score_note": "平衡抽樣的分類指數，非任意地點有坑機率；不參與地球候選排序"})
    if small:
        result["model_sha256"] = weights_sha
        result["external_lunar_validation"] = {
            "sites": 28, "site_mean_auroc": 0.966,
            "label": "SomBench WAC/DTM 4–<8 km 中心坑；同源 Robbins 標註，非地月類比真值"}
    return result
