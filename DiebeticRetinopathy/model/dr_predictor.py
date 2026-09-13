"""
dr_predictor.py
================
Standalone, reusable predictor for Module 3 (DR Severity Classification).

SIH 2026 — Problem Statement 26038
"Explainable AI for Diabetic Retinopathy Screening in Rural India"

This module reconstructs the trained EfficientNet-B0 model from a checkpoint and
exposes a single class, ``DRPredictor``, that maps a fundus image (JPG/PNG) to:

    - a predicted DR grade (0-4),
    - the five per-class probabilities,
    - a Referable-DR flag (grade >= 2),
    - the referable probability (P(G2)+P(G3)+P(G4)).

It reproduces EXACTLY the deterministic preprocessing used in the training
notebook (RGB -> conservative dark-border crop -> aspect-ratio-preserving resize
-> pad to square -> ToTensor -> ImageNet normalization).

NOTE: This predictor intentionally contains NO medical recommendation / triage /
clinical-advice logic. It only returns model outputs. Any recommendation logic is
handled elsewhere (frontend/backend), by design.

Example
-------
    from dr_predictor import DRPredictor

    predictor = DRPredictor(model_path="efficientnet_b0_dr_best.pth")
    result = predictor.predict("path/to/fundus_image.jpg")
    print(result)
"""

from __future__ import annotations

from pathlib import Path
from typing import Union

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image
from torchvision import models, transforms

__all__ = ["DRPredictor"]

# ImageNet fallbacks (only used if the checkpoint omits them).
_DEFAULT_MEAN = [0.485, 0.456, 0.406]
_DEFAULT_STD = [0.229, 0.224, 0.225]


# --------------------------------------------------------------------------- #
# Deterministic preprocessing — must match the training notebook exactly.
# --------------------------------------------------------------------------- #
def crop_dark_borders(img: Image.Image, tol: int = 7) -> Image.Image:
    """Conservatively crop near-black borders around the retina.

    Keeps the tight bounding box of every pixel whose grayscale value > tol, so
    retinal anatomy and peripheral lesions are never clipped. Falls back to the
    original image if detection is degenerate.
    """
    gray = np.asarray(img.convert("L"))
    mask = gray > tol
    if not mask.any():
        return img
    ys = np.where(mask.any(axis=1))[0]
    xs = np.where(mask.any(axis=0))[0]
    y0, y1 = int(ys[0]), int(ys[-1]) + 1
    x0, x1 = int(xs[0]), int(xs[-1]) + 1
    if (y1 - y0) < 2 or (x1 - x0) < 2:
        return img
    return img.crop((x0, y0, x1, y1))


def resize_keep_aspect_pad(img: Image.Image, size: int = 224, fill: int = 0) -> Image.Image:
    """Resize so the longest side == size (aspect ratio preserved), then pad the
    shorter side symmetrically with `fill` to obtain a square size x size image."""
    w, h = img.size
    scale = size / float(max(w, h))
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    img = img.resize((new_w, new_h), Image.BILINEAR)
    canvas = Image.new("RGB", (size, size), (fill, fill, fill))
    canvas.paste(img, ((size - new_w) // 2, (size - new_h) // 2))
    return canvas


class RetinaGeometry:
    """Deterministic geometric normalization (crop -> resize -> pad)."""

    def __init__(self, size: int = 224, tol: int = 7, fill: int = 0):
        self.size, self.tol, self.fill = size, tol, fill

    def __call__(self, img: Image.Image) -> Image.Image:
        if img.mode != "RGB":
            img = img.convert("RGB")
        img = crop_dark_borders(img, self.tol)
        img = resize_keep_aspect_pad(img, self.size, self.fill)
        return img


# --------------------------------------------------------------------------- #
# Predictor
# --------------------------------------------------------------------------- #
class DRPredictor:
    """Load a trained EfficientNet-B0 DR checkpoint and run inference.

    Parameters
    ----------
    model_path : str | Path
        Path to the ``.pth`` checkpoint saved by the Module 3 notebook.
    device : str | torch.device | None
        Force a device. Defaults to CUDA when available, else CPU.
    """

    def __init__(self, model_path: Union[str, Path], device=None):
        self.model_path = str(model_path)
        self.device = torch.device(
            device if device is not None
            else ("cuda" if torch.cuda.is_available() else "cpu")
        )

        # weights_only=False: our OWN trusted checkpoint carries config objects.
        ckpt = torch.load(self.model_path, map_location="cpu", weights_only=False)

        # ---- configuration from checkpoint (with safe fallbacks) ----
        self.num_classes = int(ckpt.get("num_classes", 5))
        self.class_names = list(ckpt.get(
            "class_names", [f"Grade {i}" for i in range(self.num_classes)]))
        self.image_size = int(ckpt.get("image_size", 224))
        self.mean = list(ckpt.get("normalize_mean", _DEFAULT_MEAN))
        self.std = list(ckpt.get("normalize_std", _DEFAULT_STD))
        self.referable_threshold = int(ckpt.get("referable_threshold", 2))

        pre = ckpt.get("preprocessing", {}) or {}
        self.dark_tol = int(pre.get("dark_tol", 7))
        self.pad_fill = int(pre.get("pad_fill", 0))

        # ---- reconstruct EfficientNet-B0 + 5-class head, then load weights ----
        self.model = self._build_model()
        self.model.load_state_dict(ckpt["model_state_dict"])
        self.model.to(self.device).eval()

        # ---- deterministic transform (identical to notebook validation_transform) ----
        self.transform = transforms.Compose([
            RetinaGeometry(size=self.image_size, tol=self.dark_tol, fill=self.pad_fill),
            transforms.ToTensor(),
            transforms.Normalize(self.mean, self.std),
        ])

    # --------------------------------------------------------------------- #
    def _build_model(self) -> nn.Module:
        model = models.efficientnet_b0(weights=None)          # no download; weights come from ckpt
        in_features = model.classifier[1].in_features         # 1280
        model.classifier[1] = nn.Linear(in_features, self.num_classes)
        return model

    # --------------------------------------------------------------------- #
    @torch.no_grad()
    def predict(self, image: Union[str, Path, Image.Image]) -> dict:
        """Predict DR grade and referable status for a single fundus image.

        `image` may be a path (str/Path) to a JPG/PNG or a PIL.Image.
        Returns a plain dictionary (no clinical recommendation logic).
        """
        if isinstance(image, (str, Path)):
            img = Image.open(image).convert("RGB")
        elif isinstance(image, Image.Image):
            img = image.convert("RGB")
        else:
            raise TypeError("image must be a file path or a PIL.Image.Image")

        x = self.transform(img).unsqueeze(0).to(self.device)   # (1, 3, H, W)
        logits = self.model(x)
        probs = F.softmax(logits, dim=1).squeeze(0).cpu().numpy()

        grade = int(np.argmax(probs))
        referable_probability = float(probs[self.referable_threshold:].sum())
        referable_dr = bool(grade >= self.referable_threshold)

        return {
            "predicted_grade": grade,
            "predicted_label": self.class_names[grade],
            "probabilities": {
                self.class_names[i]: float(probs[i]) for i in range(self.num_classes)
            },
            "referable_dr": referable_dr,
            "referable_probability": referable_probability,
        }

    # --------------------------------------------------------------------- #
    @torch.no_grad()
    def predict_batch(self, image_paths) -> list:
        """Convenience: run predict() over an iterable of image paths."""
        return [self.predict(p) for p in image_paths]


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="DR severity prediction (Module 3).")
    parser.add_argument("--model", required=True, help="Path to efficientnet_b0_dr_best.pth")
    parser.add_argument("--image", required=True, help="Path to a fundus image (JPG/PNG)")
    args = parser.parse_args()

    _predictor = DRPredictor(model_path=args.model)
    import json
    print(json.dumps(_predictor.predict(args.image), indent=2))
