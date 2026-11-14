"""Train an explicitly limited lunar FeO surrogate from Diviner and LP maps.

The target is Lunar Prospector's published 0.5° FeO product, not a measured
mineral label. Longitude sectors are held out to expose geographic transfer.
"""

from __future__ import annotations

import copy
import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch
from torch import nn

from lunar_pipeline import DIVINER_BASE, LP_FE_O, ROOT


DATA_PATH = ROOT / "data/moon/material_features_05deg.npz"
MODEL_PATH = ROOT / "data/moon/tiny_feo_surrogate.pt"
REPORT_PATH = ROOT / "data/moon/tiny_feo_surrogate_training.json"
DIVINER_FILES = (
    DIVINER_BASE / "dgdr_std_cf_clc_cyl_032_img.img",
    DIVINER_BASE / "dgdr_ra_avg_cyl_032_img.img",
)


class TinyFeOSurrogate(nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = nn.Sequential(nn.Linear(6, 32), nn.GELU(),
                                    nn.Linear(32, 16), nn.GELU(), nn.Linear(16, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.layers(x).squeeze(-1)


def aggregate_blocks(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Compute native 16×16 Diviner statistics for every 0.5° cell at ±60°."""
    if not path.exists() or path.stat().st_size != 88_473_600:
        raise FileNotFoundError(f"Expected 32 ppd Diviner signed-int16 map: {path}")
    image = np.memmap(path, dtype="<i2", mode="r", shape=(3840, 11520))
    means = np.empty((240, 720), dtype=np.float32)
    stds = np.empty_like(means)
    coverages = np.empty_like(means)
    for lat_band in range(240):
        cell = np.asarray(image[lat_band * 16:(lat_band + 1) * 16], dtype=np.float32)
        cell = cell.reshape(16, 720, 16)
        valid = cell != -32768
        count = valid.sum(axis=(0, 2)).astype(np.float32)
        values = np.where(valid, cell, 0)
        mean = values.sum(axis=(0, 2)) / np.maximum(count, 1)
        variance = (values * values).sum(axis=(0, 2)) / np.maximum(count, 1) - mean * mean
        means[lat_band] = mean * 0.001
        stds[lat_band] = np.sqrt(np.maximum(variance, 0)) * 0.001
        coverages[lat_band] = count / 256
    return means, stds, coverages


def prepare() -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    if DATA_PATH.exists():
        data = np.load(DATA_PATH)
        return data["features"], data["targets"], data["latitudes"], data["longitudes"]
    cf_mean, cf_std, cf_cov = aggregate_blocks(DIVINER_FILES[0])
    rock_mean, rock_std, rock_cov = aggregate_blocks(DIVINER_FILES[1])
    iron = np.loadtxt(LP_FE_O, delimiter=",", comments="#", usecols=(4,), dtype=np.float32)
    if iron.size != 360 * 720:
        raise ValueError(f"Unexpected Lunar Prospector FeO bins: {iron.size}")
    iron = iron.reshape(360, 720)
    # Diviner bands start at 60°N / 0°E; LP FeO starts at 90°S / 180°W.
    target = iron[299 - np.arange(240)[:, None],
                  (np.arange(720)[None, :] + 360) % 720]
    features = np.stack((cf_mean, cf_std, rock_mean, rock_std, cf_cov, rock_cov), axis=-1)
    latitudes = np.broadcast_to(59.75 - np.arange(240)[:, None] * 0.5, (240, 720))
    longitudes = np.broadcast_to(0.25 + np.arange(720)[None, :] * 0.5, (240, 720))
    good = ((cf_cov >= 0.8) & (rock_cov >= 0.8) & np.isfinite(target) &
            np.isfinite(features).all(axis=-1) & (target >= 0) & (target <= 35))
    result = (features[good].astype(np.float32), target[good].astype(np.float32),
              latitudes[good].astype(np.float32), longitudes[good].astype(np.float32))
    np.savez_compressed(DATA_PATH, features=result[0], targets=result[1],
                        latitudes=result[2], longitudes=result[3])
    return result


def metrics(truth: np.ndarray, estimate: np.ndarray) -> dict:
    error = estimate - truth
    return {
        "mae_wt_percent": round(float(np.mean(np.abs(error))), 3),
        "rmse_wt_percent": round(float(np.sqrt(np.mean(error * error))), 3),
        "bias_wt_percent": round(float(np.mean(error)), 3),
        "r2": round(float(1 - np.sum(error * error) /
                          max(np.sum((truth - truth.mean()) ** 2), 1e-8)), 3),
    }


def train() -> None:
    torch.manual_seed(20261010)
    np.random.seed(20261010)
    torch.set_num_threads(4)
    features, targets, _, longitudes = prepare()
    test = longitudes < 60
    valid = (longitudes >= 180) & (longitudes < 240)
    train_mask = ~(test | valid)
    x_mean = features[train_mask].mean(axis=0)
    x_std = np.maximum(features[train_mask].std(axis=0), 0.001)
    y_mean = float(targets[train_mask].mean())
    y_std = float(targets[train_mask].std())
    x = torch.from_numpy(((features - x_mean) / x_std).astype(np.float32))
    y = torch.from_numpy(((targets - y_mean) / y_std).astype(np.float32))
    train_ids = np.flatnonzero(train_mask)
    model = TinyFeOSurrogate()
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.002, weight_decay=0.0001)
    best_mae = math.inf
    best_state = None
    best_epoch = 0
    stale = 0
    history = []
    for epoch in range(1, 61):
        model.train()
        np.random.shuffle(train_ids)
        for start in range(0, train_ids.size, 4096):
            ids = train_ids[start:start + 4096]
            optimizer.zero_grad(set_to_none=True)
            loss = nn.functional.huber_loss(model(x[ids]), y[ids], delta=0.5)
            loss.backward()
            optimizer.step()
        model.eval()
        with torch.inference_mode():
            estimate = model(x[valid]).numpy() * y_std + y_mean
        mae = float(np.mean(np.abs(estimate - targets[valid])))
        history.append({"epoch": epoch, "validation_mae_wt_percent": round(mae, 3)})
        if mae < best_mae - 0.001:
            best_mae, best_epoch = mae, epoch
            best_state = copy.deepcopy(model.state_dict())
            stale = 0
        else:
            stale += 1
            if stale >= 10:
                break
    if best_state is None:
        raise RuntimeError("No model checkpoint selected")
    model.load_state_dict(best_state)
    model.eval()
    with torch.inference_mode():
        valid_pred = model(x[valid]).numpy() * y_std + y_mean
        test_pred = model(x[test]).numpy() * y_std + y_mean
    half_width = float(np.quantile(np.abs(valid_pred - targets[valid]), 0.90))
    baseline = np.full(int(test.sum()), y_mean, dtype=np.float32)
    normalized = (features - x_mean) / x_std
    linear_weights = np.linalg.lstsq(
        np.column_stack((normalized[train_mask], np.ones(int(train_mask.sum())))),
        targets[train_mask], rcond=None)[0]
    linear_test = np.column_stack((normalized[test], np.ones(int(test.sum())))) @ linear_weights
    torch.save({"state_dict": best_state, "input_mean": x_mean.tolist(), "input_std": x_std.tolist(),
                "target_mean": y_mean, "target_std": y_std,
                "validation_error_p90": half_width}, MODEL_PATH)
    report = {
        "name": "TinyFeOSurrogate",
        "parameters": sum(p.numel() for p in model.parameters()),
        "target": "PDS Lunar Prospector GRS-derived FeO weight percent at 0.5° bins",
        "inputs": "Diviner CF and rock fraction 0.5° mean, std, and coverage",
        "spatial_split": {"test_longitude_east": "0–60°", "validation_longitude_east": "180–240°",
                          "training_longitude_east": "remaining 240°"},
        "counts": {"train": int(train_mask.sum()), "validation": int(valid.sum()),
                   "test": int(test.sum())},
        "best_epoch": best_epoch,
        "validation": metrics(targets[valid], valid_pred),
        "held_out_test": metrics(targets[test], test_pred),
        "held_out_mean_baseline": metrics(targets[test], baseline),
        "held_out_linear_baseline": metrics(targets[test], linear_test),
        "validation_absolute_error_p90_wt_percent": round(half_width, 3),
        "held_out_coverage_at_validation_p90": round(float(np.mean(
            np.abs(test_pred - targets[test]) <= half_width)), 3),
        "history": history,
        "limitations": "Surrogate of a published coarse FeO estimate, not an independent mineral observation or site-scale mineral classifier. Sensor spatial footprints may exceed map bin size.",
    }
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("parameters", "counts", "best_epoch",
                                                   "validation", "held_out_test",
                                                   "held_out_mean_baseline", "held_out_linear_baseline",
                                                   "held_out_coverage_at_validation_p90")}, indent=2))


@lru_cache(maxsize=1)
def load_surrogate() -> tuple[TinyFeOSurrogate, dict]:
    checkpoint = torch.load(MODEL_PATH, map_location="cpu", weights_only=True)
    model = TinyFeOSurrogate()
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
    return model, {**checkpoint, "report": report}


def predict_feo(lat: float, lon: float, patch_km: float) -> dict:
    """Predict LP-like regional FeO from covered Diviner 0.5° cells."""
    source = "https://pds-geosciences.wustl.edu/missions/lunarp/reduced_special.html"
    if not MODEL_PATH.exists() or not REPORT_PATH.exists():
        return {"available": False, "reason": "Trained FeO surrogate unavailable", "source_url": source}
    half_lat = patch_km / 30.32 / 2
    if lat - half_lat < -60 or lat + half_lat > 60:
        return {"available": False, "reason": "Outside complete Diviner ±60° coverage", "source_url": source}
    half_lon = half_lat / max(math.cos(math.radians(lat)), 0.5)
    ys = range(max(0, math.floor((60 - lat - half_lat) * 2)),
               min(239, math.floor((60 - lat + half_lat) * 2)) + 1)
    xs = range(math.floor((lon - half_lon) * 2), math.floor((lon + half_lon) * 2) + 1)
    maps = [np.memmap(path, dtype="<i2", mode="r", shape=(3840, 11520)) for path in DIVINER_FILES]
    features = []
    total = 0
    for y in ys:
        for x in xs:
            total += 1
            stats = []
            for image in maps:
                block = np.asarray(image[y * 16:(y + 1) * 16,
                                         (x % 720) * 16:((x % 720) + 1) * 16])
                valid = block[block != -32768].astype(np.float32)
                stats.append((float(valid.mean()) * 0.001 if valid.size else 0.0,
                              float(valid.std()) * 0.001 if valid.size else 0.0,
                              valid.size / 256))
            if stats[0][2] >= 0.8 and stats[1][2] >= 0.8:
                features.append([stats[0][0], stats[0][1], stats[1][0], stats[1][1],
                                 stats[0][2], stats[1][2]])
    if len(features) < 3 or len(features) / max(total, 1) < 0.5:
        return {"available": False, "reason": "Insufficient Diviner CF/rock coverage",
                "covered_cells": len(features), "sampled_cells": total, "source_url": source}
    model, info = load_surrogate()
    values = (np.asarray(features, dtype=np.float32) - np.asarray(info["input_mean"])) / np.asarray(info["input_std"])
    with torch.inference_mode():
        estimates = model(torch.from_numpy(values.astype(np.float32))).numpy() * info["target_std"] + info["target_mean"]
    return {
        "available": True,
        "feo_weight_percent_prediction": round(float(np.median(estimates)), 2),
        "model": "TinyFeOSurrogate",
        "parameters": info["report"]["parameters"],
        "covered_cells": len(features),
        "sampled_cells": total,
        "held_out_test_mae_wt_percent": info["report"]["held_out_test"]["mae_wt_percent"],
        "source_url": source,
        "interpretation": "Small Diviner-to-Lunar-Prospector FeO surrogate; trained on coarse derived FeO bins, not validated against local mineral samples",
    }


if __name__ == "__main__":
    train()
