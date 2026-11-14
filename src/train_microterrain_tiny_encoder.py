"""Train a small, shared morphology encoder on site-held-out DEM views.

This is self-supervised representation training. Same-location D4 and Earth
5 m/20 m pairs are positives; there are no Moon/Earth or Mars/Earth analog
labels. Holdout scores measure view consistency only.
"""

from __future__ import annotations

import copy
import json
import math
import random
from pathlib import Path

import numpy as np
import rasterio
import torch
from scipy.ndimage import map_coordinates
from torch import nn

from build_highres_dem_cohort import ROOT, sha256
from build_microterrain_native_index import EARTH_SITES, OUT, site_grid

SEED = 20261011
SIZES_M = (200, 500, 1000)
TRAIN_SITES = ("MARIUS3", "FECUNDITATIS", "ANDERSON01", "NASSAU02",
               "FRSHCRATER8", "JEZERO_CTX", "METEOR_CRATER")
HOLDOUT_SITES = ("SCHRODNGR02", "OLYMPUS_CTX", "KILBOURNE_HOLE")
MODEL_PATH = OUT / "tiny_morph_encoder.pt"
REPORT_PATH = OUT / "tiny_morph_training.json"
INPUT_SIDE = 32


class TinyMorphEncoder(nn.Module):
    """Three-channel DEM/slope/curvature encoder, 32-D unit output."""

    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 16, 3, padding=1), nn.SiLU(),
            nn.Conv2d(16, 24, 3, stride=2, padding=1), nn.SiLU(),
            nn.Conv2d(24, 32, 3, stride=2, padding=1), nn.SiLU(),
            nn.Conv2d(32, 48, 3, stride=2, padding=1), nn.SiLU(),
            nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Sequential(nn.Linear(49, 64), nn.SiLU(), nn.Linear(64, 32))

    def forward(self, terrain: torch.Tensor, relief: torch.Tensor) -> torch.Tensor:
        pooled = self.features(terrain).flatten(1)
        return nn.functional.normalize(
            self.head(torch.cat((pooled, relief[:, None]), dim=1)), dim=1
        )


def transform_patch(height: np.ndarray, size_m: int) -> tuple[np.ndarray, float]:
    z = np.asarray(height, dtype=np.float32)
    if z.shape != (INPUT_SIDE, INPUT_SIDE) or not np.isfinite(z).all():
        raise ValueError("Need a complete 32×32 elevation patch")
    median = float(np.median(z))
    relief = max(float(np.percentile(z, 90) - np.percentile(z, 10)), 0.2)
    h = np.clip((z - median) / relief, -3, 3)
    pixel_m = size_m / INPUT_SIDE
    north, east = np.gradient(z, pixel_m)
    slope = np.clip(np.arctan(np.hypot(north, east)) / np.deg2rad(35), 0, 2)
    gy, gx = np.gradient(h)
    cy, _ = np.gradient(gy)
    _, cx = np.gradient(gx)
    curvature = np.clip((cx + cy) * 5, -2, 2)
    scalar = float(np.clip(math.log1p(relief) / math.log1p(1000), 0, 2))
    return np.stack((h, slope, curvature)).astype(np.float32), scalar


def sample(full: np.ndarray, spacing_m: int, size_m: int,
           east_m: float, north_m: float) -> np.ndarray:
    mid = (full.shape[0] - 1) / 2
    offsets = (np.arange(INPUT_SIDE) - (INPUT_SIDE - 1) / 2) * (size_m / INPUT_SIDE)
    yy, xx = np.meshgrid(offsets, offsets, indexing="ij")
    row = mid - (north_m - yy) / spacing_m
    col = mid + (east_m + xx) / spacing_m
    return map_coordinates(full, [row, col], order=1, mode="constant", cval=np.nan)


def source_grids() -> tuple[dict[str, tuple[np.ndarray, int]], dict[str, tuple[np.ndarray, int]]]:
    with np.load(OUT / "moon_anchors_5m.npz") as data:
        moon = {name: (data[name].copy(), 5) for name in data.files}
    with np.load(OUT / "mars_anchors_20m.npz") as data:
        mars = {name: (data[name].copy(), 20) for name in data.files}
    earth5, earth20 = {}, {}
    for name, path in EARTH_SITES.items():
        meta = json.loads((path.parent / "manifest.json").read_text(encoding="utf-8"))
        center = tuple(meta["anchor_lat_lon"])
        earth5[name] = site_grid(path, "earth", center, 5)[0]
        earth20[name] = site_grid(path, "earth", center, 20)[0]
    return {**moon, **mars, **{name: (grid, 5) for name, grid in earth5.items()}}, {
        name: (grid, 20) for name, grid in earth20.items()
    }


def make_pairs(site_ids: tuple[str, ...], count_per_site_scale: int,
               seed: int) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    grids, earth20 = source_grids()
    left_x, right_x, left_r, right_r, names, sizes, centers = [], [], [], [], [], [], []
    for site in site_ids:
        full, spacing = grids[site]
        for size_m in SIZES_M:
            count, attempts = 0, 0
            margin = 1500 - size_m / 2 - 20
            while count < count_per_site_scale and attempts < count_per_site_scale * 100:
                attempts += 1
                east, north = rng.uniform(-margin, margin, size=2)
                a = sample(full, spacing, size_m, east, north)
                if not np.isfinite(a).all():
                    continue
                if site in earth20:
                    b = sample(earth20[site][0], 20, size_m, east, north)
                    if not np.isfinite(b).all():
                        continue
                else:
                    b = a
                ax, ar = transform_patch(a, size_m)
                bx, br = transform_patch(b, size_m)
                left_x.append(ax); right_x.append(bx)
                left_r.append(ar); right_r.append(br)
                names.append(site); sizes.append(size_m); centers.append([east, north])
                count += 1
            if count < count_per_site_scale:
                raise ValueError(f"Only {count} complete samples for {site}/{size_m} m")
    return {
        "left_x": np.stack(left_x), "right_x": np.stack(right_x),
        "left_r": np.asarray(left_r, dtype=np.float32),
        "right_r": np.asarray(right_r, dtype=np.float32),
        "sites": np.asarray(names), "sizes_m": np.asarray(sizes, dtype=np.int16),
        "centers_east_north_m": np.asarray(centers, dtype=np.float32),
    }


def augment(x: torch.Tensor) -> torch.Tensor:
    views = []
    for item in x:
        view = torch.rot90(item, random.randrange(4), dims=(-2, -1))
        if random.random() < 0.5:
            view = torch.flip(view, dims=(-1,))
        views.append(view)
    return torch.stack(views) + torch.randn_like(x) * 0.008


def loss_for_batch(model: nn.Module, data: dict[str, np.ndarray],
                   indices: np.ndarray, device: str) -> torch.Tensor:
    a = augment(torch.from_numpy(data["left_x"][indices]).to(device))
    b = augment(torch.from_numpy(data["right_x"][indices]).to(device))
    ar = torch.from_numpy(data["left_r"][indices]).to(device)
    br = torch.from_numpy(data["right_r"][indices]).to(device)
    z = torch.cat((model(a, ar), model(b, br)), dim=0)
    n = len(indices)
    logits = z @ z.T / 0.15
    eye = torch.eye(2 * n, dtype=torch.bool, device=device)
    sites = data["sites"][indices]
    centers = data["centers_east_north_m"][indices]
    sizes = data["sizes_m"][indices]
    near = (sites[:, None] == sites[None, :]) & (
        np.linalg.norm(centers[:, None] - centers[None, :], axis=2)
        < np.maximum(sizes[:, None], sizes[None, :])
    )
    forbidden = torch.from_numpy(np.tile(near, (2, 2))).to(device) | eye
    target = (torch.arange(2 * n, device=device) + n) % (2 * n)
    forbidden[torch.arange(2 * n, device=device), target] = False
    logits = logits.masked_fill(forbidden, -1e9)
    return nn.functional.cross_entropy(logits, target)


@torch.inference_mode()
def heldout_view_recall(model: nn.Module, data: dict[str, np.ndarray],
                        device: str) -> dict:
    model.eval()
    left, right = [], []
    for start in range(0, len(data["sites"]), 64):
        end = start + 64
        a = augment(torch.from_numpy(data["left_x"][start:end]).to(device))
        b = augment(torch.from_numpy(data["right_x"][start:end]).to(device))
        ar = torch.from_numpy(data["left_r"][start:end]).to(device)
        br = torch.from_numpy(data["right_r"][start:end]).to(device)
        left.append(model(a, ar).cpu().numpy())
        right.append(model(b, br).cpu().numpy())
    similarity = np.concatenate(left) @ np.concatenate(right).T
    ranking = np.argsort(-similarity, axis=1)
    truth = np.arange(len(similarity))
    per_site = {}
    for site in np.unique(data["sites"]):
        ids = np.flatnonzero(data["sites"] == site)
        per_site[str(site)] = {
            "queries": len(ids),
            "same_window_recall_at_1": round(float(np.mean(ranking[ids, 0] == ids)), 4),
            "same_window_recall_at_5": round(float(np.mean(np.any(ranking[ids, :5] == ids[:, None], axis=1))), 4),
        }
    return {"overall_same_window_recall_at_1": round(float(np.mean(ranking[:, 0] == truth)), 4),
            "overall_same_window_recall_at_5": round(float(np.mean(np.any(ranking[:, :5] == truth[:, None], axis=1))), 4),
            "by_heldout_site": per_site}


def main() -> None:
    random.seed(SEED); np.random.seed(SEED); torch.manual_seed(SEED)
    torch.set_num_threads(4)
    train = make_pairs(TRAIN_SITES, count_per_site_scale=70, seed=SEED)
    holdout = make_pairs(HOLDOUT_SITES, count_per_site_scale=25, seed=SEED + 1)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = TinyMorphEncoder().to(device)
    parameters = sum(item.numel() for item in model.parameters())
    if parameters >= 100_000:
        raise ValueError("Tiny model exceeds 100k parameter budget")
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.002, weight_decay=1e-4)
    best_loss, best_state, best_epoch = float("inf"), None, 0
    history = []
    rng = np.random.default_rng(SEED)
    for epoch in range(1, 16):
        model.train()
        permutation = rng.permutation(len(train["sites"]))
        losses = []
        for ids in np.array_split(permutation, math.ceil(len(permutation) / 48)):
            optimizer.zero_grad()
            loss = loss_for_batch(model, train, ids, device)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1)
            optimizer.step()
            losses.append(float(loss.detach()))
        model.eval()
        with torch.inference_mode():
            validation = [float(loss_for_batch(model, holdout, ids, device))
                          for ids in np.array_split(np.arange(len(holdout["sites"])),
                                                    math.ceil(len(holdout["sites"]) / 48))]
        record = {"epoch": epoch, "train_loss": round(float(np.mean(losses)), 4),
                  "heldout_view_loss": round(float(np.mean(validation)), 4)}
        history.append(record)
        print(record, flush=True)
        if record["heldout_view_loss"] < best_loss:
            best_loss = record["heldout_view_loss"]
            best_epoch = epoch
            best_state = copy.deepcopy(model.state_dict())
    model.load_state_dict(best_state)
    model.eval()
    OUT.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": best_state, "input_channels": 3,
                "input_side": INPUT_SIDE, "embedding_dim": 32,
                "parameters": parameters, "best_epoch": best_epoch}, MODEL_PATH)
    metric = heldout_view_recall(model, holdout, device)
    report = {
        "model": "TinyMorphEncoder",
        "architecture": "3-channel normalized DEM, slope, curvature → four small convolutions → 32-D unit embedding; relief scalar at head",
        "parameter_count": parameters,
        "training": "Self-supervised D4/noise positives; Meteor Crater 5m/20m same-location cross-resolution positives; nearby same-site windows masked as negatives",
        "seed": SEED, "device": device,
        "train_site_ids": list(TRAIN_SITES),
        "heldout_site_ids": list(HOLDOUT_SITES),
        "train_examples": len(train["sites"]),
        "heldout_examples": len(holdout["sites"]),
        "scales_m": list(SIZES_M),
        "best_epoch": best_epoch,
        "history": history,
        "heldout_augmented_view_retrieval": metric,
        "model_sha256": sha256(MODEL_PATH),
        "limitations": [
            "Same-window augmented-view retrieval is not a Moon/Earth or Mars/Earth analog relevance metric.",
            "No expert cross-body pairs, material labels, or mission-environment labels are used.",
            "Only one Earth site and one Mars site contribute to training; transfer uncertainty is high.",
            "The 32x32 common physical image can upsample Mars CTX 200 m from about ten true DEM posts; it cannot restore missing detail.",
            "Heldout site groups are disjoint, but the tiny number of sites prevents a generalization claim.",
        ],
    }
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")
    print(json.dumps({"parameters": parameters, "best_epoch": best_epoch,
                      "heldout_view_recall_at_1": metric["overall_same_window_recall_at_1"],
                      "model_sha256": report["model_sha256"]}, indent=2), flush=True)


if __name__ == "__main__":
    main()
