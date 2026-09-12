"""
Integrated DR Screening Server — SIH 2026 (Problem Statement 26038)
====================================================================
"Explainable AI for Diabetic Retinopathy Screening in Rural India"

This single Flask app WIRES TOGETHER the three standalone folders in this repo:

    dr-dashboard/                      -> the frontend (served at /)
    Image-quality-assessment-pipeline/ -> Module 1 (fundus image-quality gate,
                                          deterministic enhancement) — "src/*"
    DiebeticRetinopathy/               -> Module 3 (DR grade 0-4 classifier,
                                          EfficientNet-B0) — "model/*"

End-to-end flow for `POST /api/analyze`:

    1. Uploaded fundus image is decoded (full resolution — the quality module's
       thresholds are resolution-aware and must never see a downscaled image).
    2. Module 1 `assess_and_enhance_pipeline` runs the 7-dimension quality
       triage (CRITICAL -> RECAPTURE, BORDERLINE -> ENHANCE & REASSESS,
       NON-CRITICAL -> OK TO GO).
    3. Module 3 DRPredictor classifies the image that passed the quality gate:
       - NON-CRITICAL / OK TO GO  -> the original image,
       - BORDERLINE, successfully enhanced -> the ENHANCED image,
       - CRITICAL (recapture)     -> the original image, flagged as unreliable.
    4. Grad-CAM (implemented here on the EfficientNet-B0 feature maps — the
       training notebook did not ship an XAI module) produces the heatmap, the
       composited result image and the XAI "original" thumbnail.
    5. Every screening is appended to a local JSON patient-history store, which
       feeds the dashboard's "Patient History & Trend" chart.

The JSON response matches the exact contract documented in
`dr-dashboard/app.js` (see the BACKEND CONTRACT block at the top of that file).

Run:
    pip install -r integrated-server/requirements-server.txt
    python integrated-server/server.py            # http://0.0.0.0:8000
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import time
import uuid
import threading
import datetime
from collections import deque
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from flask import Flask, request, jsonify, send_from_directory, send_file
from report_service import normalize_report, render_pdf

# --------------------------------------------------------------------------- #
# Repo layout
# --------------------------------------------------------------------------- #
SERVER_DIR = Path(__file__).resolve().parent
ROOT_DIR = SERVER_DIR.parent

DASHBOARD_DIR = ROOT_DIR / "dr-dashboard"
QUALITY_ROOT = ROOT_DIR / "Image-quality-assessment-pipeline"
DR_MODEL_DIR = ROOT_DIR / "DiebeticRetinopathy" / "model"

RUNTIME_DIR = SERVER_DIR / "runtime"
OUTPUT_DIR = RUNTIME_DIR / "outputs"          # per-run generated images
REPORT_DIR = ROOT_DIR / "reports"
HISTORY_FILE = RUNTIME_DIR / "history.json"   # patient history store
RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
REPORT_DIR.mkdir(parents=True, exist_ok=True)

# Module-1 quality code does `from src.config import ...`, so the pipeline root
# must sit on sys.path and be imported as top-level `src.*`.
for p in (str(QUALITY_ROOT), str(DR_MODEL_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

MAX_UPLOAD_MB = 60
ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"}

# --------------------------------------------------------------------------- #
# Module 1 — quality gate (imported at startup; needs opencv-python)
# --------------------------------------------------------------------------- #
try:
    from src.quality_enhancer import assess_and_enhance_pipeline  # noqa: E402
    QUALITY_READY = True
    QUALITY_ERROR = None
except Exception as exc:  # pragma: no cover - surfaced via /api/health
    QUALITY_READY = False
    QUALITY_ERROR = f"{type(exc).__name__}: {exc}"

# Module-2 placeholder — provisional lesion-candidate annotator (see its
# own docstring). Fully optional: the API degrades to zero-counts if absent.
try:
    from lesion_annotator import annotate_lesion_candidates  # noqa: E402
    ANNOTATOR_READY = True
    ANNOTATOR_ERROR = None
except Exception as exc:  # pragma: no cover
    ANNOTATOR_READY = False
    ANNOTATOR_ERROR = f"{type(exc).__name__}: {exc}"

PHOTO_LONGEST = 1600   # full-res photo copies kept for the dashboard

# =========================================================================== #
# Module 3 + Grad-CAM service  (torch imports are deferred/lazy on purpose so
# the dashboard still serves even if the ML stack is not installed yet)
# =========================================================================== #
class DRModelService:
    """DRPredictor (Module 3) + a from-scratch Grad-CAM explainer."""

    _instance = None
    _lock = threading.Lock()

    def __init__(self, model_path: Path):
        # torch imports are deferred on purpose: importing torch takes seconds,
        # so the dashboard still starts fast if the ML stack is not installed.
        import torch
        import torch.nn as nn
        import torch.nn.functional as F
        from torchvision import transforms
        import dr_predictor as dpr  # Module 3 predictor (repo model/ folder)

        self.torch = torch
        self.F = F
        self.nn = nn

        self.device = torch.device("cpu")  # CPU serving; change to cuda if needed
        torch.set_num_threads(max(1, min(8, os.cpu_count() or 4)))

        self.predictor = dpr.DRPredictor(model_path=model_path, device=self.device)
        ckpt = torch.load(model_path, map_location="cpu", weights_only=False)

        self.image_size = self.predictor.image_size
        self.mean = list(self.predictor.mean)
        self.std = list(self.predictor.std)
        self.class_names = list(self.predictor.class_names)
        self.num_classes = self.predictor.num_classes
        self.referable_threshold = self.predictor.referable_threshold
        self.geometry = dpr.RetinaGeometry(
            size=self.predictor.image_size,
            tol=self.predictor.dark_tol,
            fill=self.predictor.pad_fill,
        )
        self.transform = transforms.Compose([
            transforms.ToTensor(),
            transforms.Normalize(self.mean, self.std),
        ])
        self.model = self.predictor.model
        self.model.eval()

        # Grad-CAM target: the last Conv2d inside model.features
        self.target_layer = None
        for mod in self.model.features.modules():
            if isinstance(mod, nn.Conv2d):
                self.target_layer = mod
        if self.target_layer is None:
            raise RuntimeError("Could not locate a Conv2d target layer for Grad-CAM")
        self._acts: dict = {}
        self._grads: dict = {}
        self._fw = self.target_layer.register_forward_hook(self._on_forward)
        self._bw = self.target_layer.register_full_backward_hook(self._on_backward)

        self.arch = str(ckpt.get("arch", "efficientnet_b0"))
        print(f"[server] DR model ready: {self.arch} @ {model_path} "
              f"(classes={self.num_classes}, size={self.image_size})")

    # ------------------------------------------------------------------ #
    def _on_forward(self, _m, _inp, out):
        self._acts["out"] = out.detach()

    def _on_backward(self, _m, _gin, gout):
        self._grads["out"] = gout[0].detach()

    # ------------------------------------------------------------------ #
    def explain(self, pil_rgb):
        """Classify + Grad-CAM on one RGB PIL fundus image.

        Returns (classification dict, display_canvas, heatmap_image, result_image)
        """
        torch = self.torch
        F = self.F
        canvas = self.geometry(pil_rgb.convert("RGB"))          # what the model sees
        x = self.transform(canvas).unsqueeze(0).to(self.device)  # (1,3,S,S)

        self._acts.clear()
        self._grads.clear()
        self.model.zero_grad(set_to_none=True)
        logits = self.model(x)
        probs = F.softmax(logits, dim=1).squeeze(0).detach()
        grade = int(torch.argmax(probs).item())
        confidence = float(probs[grade].item())
        probs_list = [float(p) for p in probs]
        referable_prob = float(probs[self.referable_threshold:].sum().item())

        # ---- Grad-CAM for the predicted class ---------------------------- #
        logits[0, grade].backward()
        act = self._acts["out"]          # (1, C, h, w)
        grad = self._grads["out"]        # (1, C, h, w)
        weights = grad.mean(dim=(2, 3), keepdim=True)
        cam = F.relu((weights * act).sum(dim=1, keepdim=True))[0, 0]  # (h, w)
        cam = cam - cam.min()
        if cam.max() > 0:
            cam = cam / cam.max()
        cam_np = cam.cpu().numpy()       # 0..1 at feature resolution

        # Resize CAM to canvas size and build the visualisations.
        # Keep the jet map inside the retinal disc: black padding stays black.
        canvas_np = np.asarray(canvas, dtype=np.uint8)
        lum = np.asarray(canvas.convert("L"), dtype=np.uint8)
        k = max(3, min(canvas.size) // 16) | 1
        mask = cv2.dilate((lum > 12).astype("uint8"),
                          cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))) > 0

        cam_img = np.asarray(
            Image.fromarray((cam_np * 255).astype("uint8")).resize(
                canvas.size, Image.BILINEAR), dtype=np.float32) / 255.0

        heat_col = self._colormap_jet(cam_img)               # (H, W, 3) RGB 0..255
        heat_col = np.where(mask[:, :, None], heat_col, canvas_np)
        heat_img = Image.fromarray(heat_col.astype("uint8"), "RGB")

        overlay_np = np.where(
            mask[:, :, None],
            (0.55 * canvas_np + 0.45 * heat_col).astype("uint8"),
            canvas_np,
        )
        result_img = Image.fromarray(overlay_np, "RGB")

        classification = {
            "grade": grade,
            "confidence": round(confidence, 6),
            "class_probs": [round(p, 6) for p in probs_list],
            "referable": bool(grade >= self.referable_threshold),
            "referable_prob": round(referable_prob, 6),
        }
        return classification, canvas, heat_img, result_img

    # ------------------------------------------------------------------ #
    @staticmethod
    def _colormap_jet(gray01):
        """gray01: (H, W) float 0..1 -> jet colormap RGB (H, W, 3) 0..255."""
        g = (np.clip(gray01, 0.0, 1.0) * 255).astype("uint8")
        bgr = cv2.applyColorMap(g, cv2.COLORMAP_JET)
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    # ------------------------------------------------------------------ #
    @staticmethod
    def _draw_badge(img, grade, confidence, referable_prob):
        """Put a small clinical-readout strip on the composited image."""
        size = max(img.size)
        font_paths = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        ]
        font = ImageFont.load_default(size=max(16, size // 12))
        for fp in font_paths:
            if os.path.exists(fp):
                try:
                    font = ImageFont.truetype(fp, max(16, size // 12))
                    break
                except Exception:
                    pass

        label = ["No DR", "Mild NPDR", "Moderate NPDR", "Severe NPDR", "PDR"][
            min(4, max(0, grade))
        ]
        text = f"DR Grade {grade} - {label}   |   conf {confidence*100:.0f}%   |   referable p={referable_prob*100:.0f}%"
        draw = ImageDraw.Draw(img)
        w, h = draw.textlength(text, font=font), font.size
        pad = max(8, size // 32)
        x0, y0 = pad, img.size[1] - h - 3 * pad
        x1, y1 = min(img.size[0] - pad, x0 + w + 2 * pad), y0 + h + 2 * pad
        draw.rounded_rectangle([x0, y0, x1, y1], radius=pad // 2, fill=(12, 23, 48))
        draw.text((x0 + pad, y0 + pad), text, fill=(255, 255, 255), font=font)
        return img

    # ------------------------------------------------------------------ #
    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls(DR_MODEL_DIR / "efficientnet_b0_dr_best.pth")
        return cls._instance


# --------------------------------------------------------------------------- #
# Patient history store (tiny local JSON db — swap for a real DB later)
# --------------------------------------------------------------------------- #
HISTORY_LOCK = threading.Lock()
RECENT_LATENCIES = deque(maxlen=10)


def _read_history():
    if not HISTORY_FILE.exists():
        return {}
    try:
        return json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_history(data):
    HISTORY_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def record_screening(patient_id, eye, grade, referable, quality_action):
    """Append one screening and return the history series for the chart."""
    with HISTORY_LOCK:
        store = _read_history()
        key = (patient_id or "Unlabeled").strip().lower() or "unlabeled"
        series = store.setdefault(key, [])
        now = datetime.date.today()
        series.append({
            "date": now.isoformat(),
            "t": now.strftime("%b %Y"),
            "grade": int(grade),
            "referable": bool(referable),
            "quality_action": quality_action,
            "eye": eye,
        })
        if len(series) > 200:                    # cap per patient
            series = series[-200:]
            store[key] = series
        _write_history(store)

        # chart series: history + current point labelled "Now"
        chart = [
            {"t": p["t"], "grade": p["grade"]} for p in series[:-1]
        ] + [{"t": "Now", "grade": int(grade)}]
        return chart


def telemedicine_stats():
    """Telemedicine-panel numbers.

    Simulated channel figures (no telemetry module exists yet), but grounded in
    live data where possible: `throughput_per_hr` reflects the measured
    per-screening latency, clamped to the 12-150/hr design envelope of a
    rural telemedicine channel, and the load is derived from stored visits.
    """
    with HISTORY_LOCK:
        store = _read_history()
        total = sum(len(v) for v in store.values())
    avg_s = (sum(RECENT_LATENCIES) / len(RECENT_LATENCIES)) if RECENT_LATENCIES else 3.0
    throughput = max(12, min(150, round(3600.0 / max(0.5, avg_s))))
    capacity = 100000                                          # yearly design target
    daily_target = capacity / 365.0
    load = max(3, min(100, round(100.0 * total / max(1.0, daily_target))))  # simulated
    return {
        "throughput_per_hr": throughput,
        "capacity_per_year": capacity,
        "current_load_pct": load,
    }


# --------------------------------------------------------------------------- #
# Flag/score -> friendly UI strings
# --------------------------------------------------------------------------- #
_DIM_LABELS = {
    "focus": {"GOOD": "Good", "BORDERLINE_BLUR": "Fair", "SEVERE_BLUR": "Poor"},
    "brightness": {"ACCEPTABLE_EXPOSURE": "Good", "MILD_UNDEREXPOSURE": "Fair",
                   "MILD_OVEREXPOSURE": "Fair", "SEVERE_UNDEREXPOSURE": "Poor",
                   "SEVERE_OVEREXPOSURE": "Poor"},
    "contrast": {"GOOD_CONTRAST": "Good", "MILD_LOW_CONTRAST": "Fair",
                 "SLIGHTLY_HIGH_CONTRAST": "Fair", "SEVERE_LOW_CONTRAST": "Poor",
                 "EXCESSIVE_CONTRAST": "Poor"},
    "noise": {"LOW_NOISE": "Good", "ACCEPTABLE_NOISE": "Good", "MODERATE_NOISE": "Fair",
              "SEVERE_NOISE": "Poor"},
    "fov": {"COMPLETE_FOV": "Good", "BORDERLINE_FOV": "Fair", "INSUFFICIENT_FOV": "Poor"},
    "illumination": {"UNIFORM_ILLUMINATION": "Good", "MODERATE_UNEVEN_ILLUMINATION": "Fair",
                     "SEVERE_UNEVEN_ILLUMINATION": "Poor"},
    "artifact": {"CLEAN_NO_ARTIFACTS": "Good", "MINOR_GLARE": "Good",
                 "MODERATE_GLARE": "Fair", "SEVERE_GLARE": "Poor"},
}

_OPS_NAMES = {
    "CLAHE": "CLAHE contrast",
    "gamma_correction": "Gamma/exposure correction",
    "illumination_normalization": "Illumination normalization",
    "bilateral_denoising": "Denoising",
    "unsharp_masking": "Mild sharpening",
    "glare_attenuation": "Glare attenuation",
}


def _dim_label(dim, flag):
    return _DIM_LABELS.get(dim, {}).get(flag, "Good")


def quality_block(qres):
    """Translate the Module-1 result dict into the dashboard's quality shape."""
    original_status = qres["original_status"]
    final_status = qres["final_status"]
    ops = qres.get("enhancement_operations") or []
    flags = qres["original_flags"]

    if final_status == "NON-CRITICAL":
        overall = "Excellent" if qres["original_overall_score"] >= 0.85 else "Good"
    elif final_status == "BORDERLINE":
        overall = "Fair"
    else:
        overall = "Poor"

    if ops:
        if qres.get("enhancement_applied"):
            enhancement = "Applied: " + "; ".join(_OPS_NAMES.get(o, o) for o in ops)
        else:
            enhancement = "Not applicable"
    else:
        if original_status == "BORDERLINE":
            enhancement = "None (failed to improve)"
        elif original_status == "CRITICAL":
            enhancement = "Bypassed (recapture required)"
        else:
            enhancement = "None needed"

    return {
        "focus": _dim_label("focus", flags["focus"]),
        "illumination": _dim_label("illumination", flags["illumination"]),
        "field_of_view": _dim_label("fov", flags["fov"]),
        "overall": overall,
        "enhancement": enhancement,
        # extra structured info used by the frontend's quality gate banner
        "original_status": original_status,
        "final_status": final_status,
        "action": qres["final_directive"],
        "overall_score": round(float(qres["original_overall_score"]), 4),
        "post_enhancement_score": round(float(qres.get("post_enhancement_overall_score", qres["original_overall_score"])), 4),
        "score_delta": round(float(qres.get("score_delta", 0.0)), 4),
        "reason": qres.get("reason", ""),
        "dimension_scores": qres["original_scores"],
    }


# --------------------------------------------------------------------------- #
# Flask app
# --------------------------------------------------------------------------- #
def create_app():
    app = Flask(__name__, static_folder=str(DASHBOARD_DIR), static_url_path="")
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

    @app.get("/")
    def index():
        return send_from_directory(DASHBOARD_DIR, "index.html")

    @app.get("/api/health")
    def health():
        model_ok = False
        model_err = None
        try:
            DRModelService.get_instance()
            model_ok = True
        except Exception as exc:
            model_err = f"{type(exc).__name__}: {exc}"
        return jsonify({
            "status": "ok" if (model_ok and QUALITY_READY) else "degraded",
            "quality_module": QUALITY_READY,
            "quality_error": QUALITY_ERROR,
            "dr_model": model_ok,
            "dr_model_error": model_err,
            "time": datetime.datetime.now().isoformat(timespec="seconds"),
        })

    @app.post("/api/analyze")
    def analyze():
        t0 = time.time()
        if not QUALITY_READY:
            return jsonify({"error": f"Quality module unavailable: {QUALITY_ERROR}"}), 500

        patient_id = (request.form.get("patient_id") or "").strip()
        eye = request.form.get("eye") or "Right"
        img_file = request.files.get("image")
        if img_file is None or not img_file.filename:
            return jsonify({"error": "No image file uploaded (field name: image)"}), 400
        ext = Path(img_file.filename).suffix.lower()
        if ext not in ALLOWED_EXT:
            return jsonify({"error": f"Unsupported file type '{ext}'. "
                                     f"Allowed: {sorted(ALLOWED_EXT)}"}), 400

        raw = img_file.read()
        if not raw:
            return jsonify({"error": "Uploaded file is empty"}), 400

        bgr = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if bgr is None:
            return jsonify({"error": "Could not decode image - is it a valid fundus photo?"}), 400
        h, w = bgr.shape[:2]
        if min(h, w) < 96:
            return jsonify({"error": f"Image too small ({w}x{h}) for fundus analysis"}), 400

        try:
            pil_rgb = Image.open(io.BytesIO(raw)).convert("RGB")
        except Exception:
            pil_rgb = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))

        run_id = uuid.uuid4().hex[:12]
        name = Path(img_file.filename).name[:80]
        run_dir = OUTPUT_DIR / run_id
        run_dir.mkdir(parents=True, exist_ok=True)

        def _save_photo(arr_bgr, name):
            """Downscale (max side ~1600) and store a full-res photo copy."""
            hh, ww = arr_bgr.shape[:2]
            sc = min(1.0, PHOTO_LONGEST / float(max(hh, ww)))
            if sc < 1.0:
                arr_bgr = cv2.resize(
                    arr_bgr, (int(round(ww * sc)), int(round(hh * sc))),
                    interpolation=cv2.INTER_AREA)
            Image.fromarray(cv2.cvtColor(arr_bgr, cv2.COLOR_BGR2RGB)).save(run_dir / name)

        # ------------------- 1) MODULE 1 quality gate ------------------- #
        qres, _orig_bgr, passed_bgr = assess_and_enhance_pipeline(bgr, filename=name)
        q = quality_block(qres)
        recapture = bool(qres["recapture_required"] or not qres["ok_to_go"])
        if recapture:
            _save_photo(bgr, "submitted.png")
            elapsed = time.time() - t0
            RECENT_LATENCIES.append(elapsed)
            payload = {
                "result_image_url": None,
                "submitted_photo_url": f"/outputs/{run_id}/submitted.png",
                "enhanced_photo_url": None,
                "classification": None,
                "lesions": {
                    "microaneurysms": 0,
                    "hemorrhages": 0,
                    "exudates": 0,
                    "detection_bars": [0, 0, 0],
                    "annotated_url": None,
                    "note": "Skipped because the quality gate marked this eye ungradeable.",
                },
                "quality": {
                    "focus": q["focus"],
                    "illumination": q["illumination"],
                    "field_of_view": q["field_of_view"],
                    "overall": q["overall"],
                    "enhancement": q["enhancement"],
                },
                "quality_gate": {
                    "original_status": q["original_status"],
                    "final_status": q["final_status"],
                    "action": q["action"],
                    "overall_score": q["overall_score"],
                    "post_enhancement_score": q["post_enhancement_score"],
                    "score_delta": q["score_delta"],
                    "enhancement_applied": bool(qres.get("enhancement_applied")),
                    "operations": qres.get("enhancement_operations") or [],
                    "recapture_required": True,
                    "ok_to_go": False,
                    "reason": q["reason"] or "Image is ungradeable; recapture required.",
                    "dimension_scores": q["dimension_scores"],
                },
                "xai": {
                    "original_url": None,
                    "heatmap_url": None,
                },
                "telemedicine": telemedicine_stats(),
                "history": [],
                "request": {
                    "patient_id": patient_id or "Unlabeled",
                    "eye": eye,
                    "image_name": name,
                    "processed_ms": round(elapsed * 1000, 1),
                },
            }
            print(f"[server] {name} | {w}x{h} | quality={q['final_status']} "
                  f"({q['action']}) | DR skipped: recapture required | {elapsed:.1f}s")
            return jsonify(payload)

        # ---------------- 2) MODULE 3 classification + XAI ---------------- #
        try:
            model = DRModelService.get_instance()
        except Exception as exc:
            return jsonify({"error": f"DR model unavailable: {type(exc).__name__}: {exc}"}), 500
        pil_for_model = Image.fromarray(cv2.cvtColor(passed_bgr, cv2.COLOR_BGR2RGB))
        classification, canvas, heat_img, result_img = model.explain(pil_for_model)

        # ---- 2b) Module-2 placeholder: lesion-candidate annotations ------- #
        if ANNOTATOR_READY:
            ann = annotate_lesion_candidates(passed_bgr, classification["grade"])
        else:
            ann = {"microaneurysms": 0, "hemorrhages": 0, "exudates": 0,
                   "annotated_bgr": None,
                   "note": f"Annotator unavailable: {ANNOTATOR_ERROR}"}

        # ----------------------- 3) persist outputs ---------------------- #
        run_dir = OUTPUT_DIR / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        canvas.save(run_dir / "original.png")
        heat_img.save(run_dir / "heatmap.png")
        result_img.save(run_dir / "result.png")

        def _save_photo(arr_bgr, name):
            """Downscale (max side ~1600) and store a full-res photo copy."""
            hh, ww = arr_bgr.shape[:2]
            sc = min(1.0, PHOTO_LONGEST / float(max(hh, ww)))
            if sc < 1.0:
                arr_bgr = cv2.resize(
                    arr_bgr, (int(round(ww * sc)), int(round(hh * sc))),
                    interpolation=cv2.INTER_AREA)
            Image.fromarray(cv2.cvtColor(arr_bgr, cv2.COLOR_BGR2RGB)).save(run_dir / name)

        _save_photo(bgr, "submitted.png")                       # raw upload
        if qres.get("enhancement_applied"):
            _save_photo(passed_bgr, "enhanced.png")             # Module-1 enhanced
        if ann.get("annotated_bgr") is not None:
            _save_photo(ann["annotated_bgr"], "annotated.png")  # lesion boxes

        # ----------------------- 4) history store ------------------------ #
        history = record_screening(
            patient_id, eye, classification["grade"],
            classification["referable"], qres["final_directive"],
        )

        # ------------------- 5) assemble the response -------------------- #
        q = quality_block(qres)
        overall = q["overall"]
        elapsed = time.time() - t0
        RECENT_LATENCIES.append(elapsed)
        recapture = bool(qres["recapture_required"])

        payload = {
            "result_image_url": f"/outputs/{run_id}/result.png",
            "submitted_photo_url": f"/outputs/{run_id}/submitted.png",
            "enhanced_photo_url": (f"/outputs/{run_id}/enhanced.png"
                                   if qres.get("enhancement_applied") else None),
            "classification": classification,
            "lesions": {
                "microaneurysms": int(ann["microaneurysms"]),
                "hemorrhages": int(ann["hemorrhages"]),
                "exudates": int(ann["exudates"]),
                "detection_bars": [int(ann["microaneurysms"]),
                                   int(ann["hemorrhages"]),
                                   int(ann["exudates"])],
                "annotated_url": (f"/outputs/{run_id}/annotated.png"
                                  if ann.get("annotated_bgr") is not None else None),
                "note": ann.get("note", "Module 2 (lesion segmentation) is not integrated yet"),
            },
            "quality": {
                "focus": q["focus"],
                "illumination": q["illumination"],
                "field_of_view": q["field_of_view"],
                "overall": overall,
                "enhancement": q["enhancement"],
            },
            "quality_gate": {
                "original_status": q["original_status"],
                "final_status": q["final_status"],
                "action": q["action"],
                "overall_score": q["overall_score"],
                "post_enhancement_score": q["post_enhancement_score"],
                "score_delta": q["score_delta"],
                "enhancement_applied": bool(qres.get("enhancement_applied")),
                "operations": qres.get("enhancement_operations") or [],
                "recapture_required": recapture,
                "ok_to_go": bool(qres["ok_to_go"]),
                "reason": q["reason"],
                "dimension_scores": q["dimension_scores"],
            },
            "xai": {
                "original_url": f"/outputs/{run_id}/original.png",
                "heatmap_url": f"/outputs/{run_id}/heatmap.png",
            },
            "telemedicine": telemedicine_stats(),
            "history": history,
            "request": {
                "patient_id": patient_id or "Unlabeled",
                "eye": eye,
                "image_name": name,
                "processed_ms": round(elapsed * 1000, 1),
            },
        }
        print(f"[server] {name} | {w}x{h} | quality={q['final_status']} "
              f"({q['action']}) | DR grade={classification['grade']} "
              f"conf={classification['confidence']:.2f} | {elapsed:.1f}s")
        return jsonify(payload)

    @app.get("/outputs/<path:filename>")
    def outputs(filename):
        return send_from_directory(OUTPUT_DIR, filename)

    @app.post("/api/report")
    def report():
        payload = request.get_json(silent=True) or {}
        try:
            report_data = normalize_report(payload)
            report_id = re.sub(r"[^A-Za-z0-9._-]+", "_", report_data["report_id"]).strip("._") or "report"
            pdf_path = REPORT_DIR / f"report_{report_id}.pdf"
            render_pdf(report_data, pdf_path, SERVER_DIR)
            return send_file(pdf_path, as_attachment=True, download_name=f"RetinaXplain_{report_id}.pdf", mimetype="application/pdf")
        except Exception as exc:
            return jsonify({"error": f"Report generation failed: {type(exc).__name__}: {exc}"}), 500

    @app.errorhandler(413)
    def too_large(_e):
        return jsonify({"error": f"Upload exceeds the {MAX_UPLOAD_MB} MB limit"}), 413

    return app


app = create_app()

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Integrated DR screening server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    print("=" * 70)
    print("DR Screening Server (SIH 2026 / PS 26038)")
    print(f"  Dashboard : http://{args.host}:{args.port}/")
    print(f"  API       : http://{args.host}:{args.port}/api/analyze  (POST)")
    print(f"  Health    : http://{args.host}:{args.port}/api/health")
    print("=" * 70)

    # warm the model in the background so the first screening is fast
    threading.Thread(target=DRModelService.get_instance, daemon=True).start()
    app.run(host=args.host, port=args.port, threaded=True)
