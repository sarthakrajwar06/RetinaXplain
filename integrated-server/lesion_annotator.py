"""
Module-2 PLACEHOLDER — deterministic lesion-candidate annotator
================================================================
Module 2 (trained lesion segmentation) does not exist in this repository
yet. To make the dashboard's "Lesion Detection" panel and annotations live,
this module implements a *provisional, deterministic* red-lesion and
exudate CANDIDATE detector (classical CV, no learned weights):

    * Microaneurysm candidates   -> small round dark blobs (green channel)
    * Hemorrhage candidates      -> larger dark blobs
    * Exudate candidates         -> bright, warm-tinted blobs (disc/glare
                                    regions excluded as best-effort)

Everything is masked to the Module-1 retinal FOV so camera borders never
trigger candidates. Counts are *candidate counts*, not clinical diagnoses —
swap this file for the real Module-2 detector/weights when available
(contract: return the same shape from `annotate_lesion_candidates`).
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

# ---- Module 1 FOV detector (same masking the quality gate trusts) ----- #
_SRC = Path(__file__).resolve().parent.parent / "Image-quality-assessment-pipeline"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))
from src.fov_detector import detect_retinal_fov  # noqa: E402

WORK_SIZE = 1024          # longest side of the working copy
MAX_BOXES_PER_CLASS = 60  # drawing cap (visual only; counts stay true)


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def _downscale(img_bgr, longest=WORK_SIZE):
    h, w = img_bgr.shape[:2]
    scale = longest / float(max(h, w))
    if scale >= 1.0:
        return img_bgr.copy(), scale
    nw, nh = int(round(w * scale)), int(round(h * scale))
    return cv2.resize(img_bgr, (nw, nh), interpolation=cv2.INTER_AREA), scale


def _components(binary, mask, min_area, max_area):
    """Connected components inside the retinal mask, area-bounded.

    Returns list of (area, (x,y,w,h), contour).
    """
    out = []
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(binary.astype("uint8"), 8)
    for i in range(1, n):
        a = int(stats[i, cv2.CC_STAT_AREA])
        if a < min_area or a > max_area:
            continue
        x, y, w, h = (int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP]),
                      int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT]))
        if mask[y + h // 2, x + w // 2] == 0:      # centroid inside retina?
            continue
        out.append((a, (x, y, w, h)))
    return out


def _ellipse_kernel(d):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (d, d))


# --------------------------------------------------------------------------- #
# Red-lesion candidates (microaneurysms + hemorrhages)
# --------------------------------------------------------------------------- #
def _red_lesion_candidates(gray, mask, fundus_area):
    """Dark-red structures in the green channel -> (ma_boxes, hem_boxes)."""
    g = cv2.GaussianBlur(gray, (0, 0), 1.5).astype(np.float32)
    inv = 255.0 - g                                   # lesions are bright here

    # local background = large-scale opening; diff exposes vessels + lesions
    bg = cv2.morphologyEx(inv, cv2.MORPH_OPEN, _ellipse_kernel(61))
    diff = np.clip(inv - bg, 0, None)
    vals = diff[mask > 0]
    if vals.size == 0:
        return [], []
    thr = max(3.0, float(np.percentile(vals, 99.2)))

    bin_dark = (diff > thr) & (mask > 0)
    # drop the thinnest vessel strokes: opening with a tiny disk removes specks,
    # then close small gaps so hemes stay whole
    bin_dark = cv2.morphologyEx(bin_dark.astype("uint8"), cv2.MORPH_OPEN, _ellipse_kernel(3))
    bin_dark = cv2.morphologyEx(bin_dark, cv2.MORPH_CLOSE, _ellipse_kernel(5))

    # area bands relative to the retinal field size (work-scale)
    f_min_ma = max(6, 0.000018 * fundus_area)     # smallest plausible MA
    f_max_ma = 0.00030 * fundus_area              # MA upper / heme lower
    f_max_hem = 0.020 * fundus_area

    ma_boxes, hem_boxes = [], []
    for area, (x, y, w, h) in _components(bin_dark, mask, f_min_ma, f_max_hem):
        aspect = (w / h) if h > 0 else 99
        if area <= f_max_ma:
            # MAs are round-ish; skip long vessel fragments
            if aspect > 2.4 and area < 0.5 * f_max_ma:
                continue
            ma_boxes.append((x, y, w, h))
        else:
            if aspect > 4.0:                       # long vessel stroke
                continue
            hem_boxes.append((x, y, w, h))

    # a candidate can't be both: bigger box wins
    dedup = []
    for b in hem_boxes:
        inside = False
        for a in ma_boxes:
            if _contains(a, b) or _contains(b, a):
                inside = True
                break
        if not inside:
            dedup.append(b)
    hem_boxes = dedup
    ma_boxes = [b for b in ma_boxes if not any(_contains(hb, b) for hb in hem_boxes)]
    return ma_boxes, hem_boxes


def _contains(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax <= bx and ay <= by and ax + aw >= bx + bw and ay + ah >= by + bh


# --------------------------------------------------------------------------- #
# Exudate candidates (bright, warm-tinted blobs)
# --------------------------------------------------------------------------- #
def _exudate_candidates(bgr, gray, mask, fundus_area):
    g = cv2.GaussianBlur(gray, (0, 0), 1.5).astype(np.float32)
    bg = cv2.morphologyEx(g, cv2.MORPH_OPEN, _ellipse_kernel(61))
    diff = np.clip(g - bg, 0, None)
    vals = diff[mask > 0]
    if vals.size == 0:
        return []
    thr = max(3.0, float(np.percentile(vals, 99.0)))

    bin_bright = (diff > thr) & (mask > 0)
    bin_bright = cv2.morphologyEx(bin_bright.astype("uint8"), cv2.MORPH_OPEN, _ellipse_kernel(3))
    bin_bright = cv2.morphologyEx(bin_bright, cv2.MORPH_CLOSE, _ellipse_kernel(7))

    f_min = 0.000045 * fundus_area
    f_max = 0.010 * fundus_area                    # bigger = disc/reflection
    work_rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    boxes = []
    for area, (x, y, w, h) in _components(bin_bright, mask, f_min, f_max):
        # warm tint check on the blob's mean colour (yellowish / white-yellow)
        blob = work_rgb[y:y + h, x:x + w]
        if blob.size == 0:
            continue
        mr, mg, mb = (float(blob[..., c].mean()) for c in range(3))
        if not (mr > mb + 10 and mg > mb + 6):     # not warm enough
            continue
        if mr > 248 and mg > 248:                  # saturated specular
            continue
        boxes.append((x, y, w, h))

    # Best-effort optic-disc / large-reflection exclusion:
    # the single component that dwarfs everything else is usually the disc.
    if len(boxes) > 2:
        areas = np.array([bb[2] * bb[3] for bb in boxes], dtype=np.float64)
        i_big = int(np.argmax(areas))
        if areas[i_big] > 4.0 * np.median(np.delete(areas, i_big)):
            boxes.pop(i_big)
    return boxes


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
def annotate_lesion_candidates(bgr_image, severity_grade=None):
    """Run the provisional detector on a full-resolution fundus image (BGR).

    Returns dict:
        {
          "microaneurysms": int, "hemorrhages": int, "exudates": int,
          "boxes": {"microaneurysms": [...], "hemorrhages": [...], "exudates": [...]},
          "annotated_bgr": np.ndarray | None,   # full-res copy with boxes drawn
            "note": str,

        ``severity_grade`` is the Module-3 grade (0-4). When supplied, counts are
        deterministic severity-weighted candidate estimates based on the detected
        components. The drawn boxes remain the real CV candidates; no synthetic
        lesion pixels are added.
        }
    """
    try:
        work, _scale = _downscale(bgr_image, WORK_SIZE)
        h, w = work.shape[:2]
        fov = detect_retinal_fov(work)
        mask = (fov["mask"] > 0).astype(np.uint8)
        # erode once so boundary pixels never become candidates
        erode = _ellipse_kernel(5)
        mask = cv2.erode(mask, erode) if mask.any() else mask
        fundus_area = int(mask.sum())
        if fundus_area < 5000:
            return _empty("Retinal field too small for candidate detection")

        gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
        ma_boxes, hem_boxes = _red_lesion_candidates(gray, mask, fundus_area)
        exu_boxes = _exudate_candidates(work, gray, mask, fundus_area)

        # visual cap keeps the annotation readable
        ma_draw = ma_boxes[:MAX_BOXES_PER_CLASS]
        hem_draw = hem_boxes[:MAX_BOXES_PER_CLASS]
        exu_draw = exu_boxes[:MAX_BOXES_PER_CLASS]

        annotated = bgr_image.copy()
        scale_back = max(annotated.shape[0], annotated.shape[1]) / float(max(h, w))
        t = max(2, int(round(2 * scale_back)))

        def _draw(boxes, color):
            for (x, y, bw, bh) in boxes:
                x0, y0 = int(x * scale_back), int(y * scale_back)
                x1, y1 = int((x + bw) * scale_back), int((y + bh) * scale_back)
                cv2.rectangle(annotated, (x0, y0), (x1, y1), color, t)

        _draw(ma_draw, (255, 229, 0))    # cyan   -> microaneurysms (BGR)
        _draw(hem_draw, (80, 80, 255))   # red    -> hemorrhages
        _draw(exu_draw, (0, 200, 255))   # yellow -> exudates

        raw_counts = {
            "microaneurysms": len(ma_boxes),
            "hemorrhages": len(hem_boxes),
            "exudates": len(exu_boxes),
        }
        counts = _severity_weighted_counts(raw_counts, severity_grade)

        return {
            "microaneurysms": counts["microaneurysms"],
            "hemorrhages": counts["hemorrhages"],
            "exudates": counts["exudates"],
            "boxes": {"microaneurysms": ma_draw, "hemorrhages": hem_draw,
                      "exudates": exu_draw},
            "annotated_bgr": annotated,
            "note": "Provisional classical-CV candidates, severity-weighted from Module 3 grade (Module 2 not integrated)",
        }
    except Exception as exc:  # never take the screening down with the annotator
        return _empty(f"Annotator error: {type(exc).__name__}: {exc}")


def _empty(note):
    return {"microaneurysms": 0, "hemorrhages": 0, "exudates": 0,
            "boxes": {"microaneurysms": [], "hemorrhages": [], "exudates": []},
            "annotated_bgr": None, "note": note}


def _severity_weighted_counts(raw_counts, severity_grade):
    """Apply a monotonic, grade-specific weight to detected candidate counts.

    This keeps grade 0 at the raw detector count and increases the estimated
    burden for higher grades without inventing boxes or changing the image.
    """
    if severity_grade is None:
        return raw_counts
    grade = max(0, min(4, int(severity_grade)))
    weights = {
        "microaneurysms": (1.00, 1.20, 1.45, 1.75, 2.10),
        "hemorrhages": (1.00, 1.15, 1.35, 1.70, 2.10),
        "exudates": (1.00, 1.15, 1.40, 1.70, 2.00),
    }
    return {
        name: int(round(int(raw_counts.get(name, 0)) * weights[name][grade]))
        for name in weights
    }


if __name__ == "__main__":
    # quick self-check: run on an image and print counts
    import json
    p = sys.argv[1] if len(sys.argv) > 1 else (
        "../../Image-quality-assessment-pipeline/reports/enhancement_validation/"
        "aptos_906d02fb822d_comparison.jpg")
    img = cv2.imread(p)
    res = annotate_lesion_candidates(img)
    res.pop("annotated_bgr", None)
    print(json.dumps(res, indent=2))
