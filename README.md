# SIH 2026 — Explainable AI for Diabetic Retinopathy Screening (PS 26038)

Monorepo for the Smart India Hackathon 2026 problem statement **26038**.
It contains the standalone module work **plus** the new integration server
that connects them into a single web app.

## Repository layout

| Folder | Contents | Status |
| ------ | -------- | ------ |
| `dr-dashboard/` | Frontend (plain HTML/CSS/JS) — upload form, DR results, quality pills, XAI thumbs, history chart | UI done; **now wired to the real backend** |
| `Image-quality-assessment-pipeline/` | **Module 1** — deterministic fundus image-quality assessment + enhancement (7 dimensions, CRITICAL / BORDERLINE / NON-CRITICAL) | standalone ✅ |
| `DiebeticRetinopathy/` | **Module 3** — EfficientNet-B0 DR severity classifier (grades 0–4) + trained checkpoint + `dr_predictor.py` | standalone ✅ |
| `integrated-server/` | **NEW — integration layer** (Flask): quality gate → DR classification → Grad-CAM XAI → history; serves the dashboard too | connects the three folders |

## Quick start

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python integrated-server\server.py        # http://localhost:8000
```

Open the dashboard, upload a fundus photo → you get:
Module-1 quality verdict (+ enhancement when the photo is borderline) →
real DR grade/confidence from the trained EfficientNet-B0 checkpoint →
Grad-CAM heatmap images.

## The end-to-end flow (what the integration does)

```
upload ─► Module 1 quality gate (full resolution)
            ├─ NON-CRITICAL ────────────────► classify ORIGINAL
            ├─ BORDERLINE ── enhance & re-assess ─► classify ENHANCED
            └─ CRITICAL ────────────────────► RECAPTURE (classification flagged unreliable)
                                                  │
                  Grad-CAM (EfficientNet-B0) ◄────┘
                  + patient history (runtime/history.json)
```

## Known gaps (not implemented anywhere yet)

1. **Module 2 — Lesion detection / segmentation** (microaneurysms,
   hemorrhages, exudates). No code or weights exist in this repo. The
   dashboard's "Lesion Detection" card therefore shows a placeholder note,
   and `/api/analyze` returns `lesions.* = null`. Wire it in
   `integrated-server/server.py` when ready.
2. **Training dataset** (APTOS/IDRiD images + `labels.csv`) is not in the repo
   (large, licensed). The Module-3 notebook and Module-1 scripts reference a
   local `dataset/` folder you must re-supply to retrain or re-run reports.
3. **Grad-CAM was not in the notebooks** — the "Explainable AI" heatmap is
   implemented from scratch in `integrated-server/server.py`
   (`DRModelService.explain()`). Review it before clinical use.
4. **Patient history & telemedicine panel** run on a local JSON store with
   simulated numbers — swap in your DB/telemetry module.
5. Runtime dependencies are consolidated in the root `requirements.txt`.

