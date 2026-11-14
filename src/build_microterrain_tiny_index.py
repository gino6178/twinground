"""Embed the *same* Earth candidate rows used by the native 2014 baseline."""

from __future__ import annotations

import json
import math

import numpy as np
import torch
from scipy.ndimage import map_coordinates

from build_highres_dem_cohort import sha256
from build_microterrain_native_index import OUT, SIZES_M
from train_microterrain_tiny_encoder import (INPUT_SIDE, MODEL_PATH,
                                             TinyMorphEncoder, transform_patch)


def resize_height(crop: np.ndarray) -> np.ndarray:
    n = crop.shape[0]
    points = (np.arange(INPUT_SIDE) - (INPUT_SIDE - 1) / 2) * n / INPUT_SIDE + (n - 1) / 2
    yy, xx = np.meshgrid(points, points, indexing="ij")
    return map_coordinates(crop, [yy, xx], order=1, mode="nearest")


def load_model() -> TinyMorphEncoder:
    checkpoint = torch.load(MODEL_PATH, map_location="cpu", weights_only=True)
    model = TinyMorphEncoder()
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return model


@torch.inference_mode()
def embed_gallery(model: TinyMorphEncoder, grids: np.ndarray,
                  size_m: int) -> np.ndarray:
    result = []
    for start in range(0, len(grids), 128):
        subset = grids[start:start + 128]
        transformed = [transform_patch(resize_height(grid), size_m) for grid in subset]
        x = torch.from_numpy(np.stack([item[0] for item in transformed]))
        relief = torch.tensor([item[1] for item in transformed], dtype=torch.float32)
        result.append(model(x, relief).numpy().astype(np.float32))
    return np.concatenate(result)


def main() -> None:
    torch.set_num_threads(4)
    model = load_model()
    model_hash = sha256(MODEL_PATH)
    native = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
    outputs = {}
    for body in ("moon", "mars"):
        for size_m in SIZES_M:
            gallery_path = OUT / f"earth_{body}_{size_m}m.npz"
            if sha256(gallery_path) != native["outputs_sha256"][gallery_path.name]:
                raise ValueError(f"Native gallery checksum mismatch: {gallery_path}")
            with np.load(gallery_path) as data:
                vectors = embed_gallery(model, data["grids"], size_m)
                count = len(data["grids"])
            if vectors.shape != (count, 32) or not np.isfinite(vectors).all():
                raise ValueError("Invalid tiny embedding index")
            path = OUT / f"earth_{body}_{size_m}m_tiny32.npz"
            np.savez_compressed(path, embeddings=vectors)
            outputs[path.name] = {
                "sha256": sha256(path),
                "source_gallery": gallery_path.name,
                "source_gallery_sha256": native["outputs_sha256"][gallery_path.name],
                "vectors": count,
                "dimensions": 32,
            }
            print(body, size_m, count, flush=True)
    manifest = {
        "purpose": "Exact dot-product candidate vectors for experimental tiny morphology ranker",
        "model_sha256": model_hash,
        "model_training_report": "data/research/microterrain_native/tiny_morph_training.json",
        "shared_candidate_rows_with_2014_baseline": True,
        "search_type": f"exact cosine via unit embeddings; ANN unnecessary for at most {max(row['vectors'] for row in outputs.values()):,} current rows",
        "outputs": outputs,
        "limitations": [
            "The model was trained on view consistency and one Earth cross-resolution site, not expert cross-body analog pairs.",
            "Tiny and geomorphon scores can be ranked on the same candidate rows but neither score is an analog probability.",
            "No independent expert relevance set exists yet to compare retrieval accuracy or claim an improvement.",
        ],
    }
    (OUT / "tiny_index_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
