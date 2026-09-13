# Integrated DR Screening Server

This folder is the **integration layer** that connects the three standalone
parts of this repository into one end-to-end screening flow:

```
                        ┌────────────────────────────┐
   fundus upload  ──►   │  integrated-server (Flask) │
   (dr-dashboard)       │                            │
                        │  1. Module 1               │   dr-dashboard/
                        │     Image-quality-         │   (frontend, served at /)
                        │     assessment-pipeline    │
                        │     ─ 7-dimension quality  │
                        │       triage               │
                        │     ─ BORDERLINE →         │
                        │       deterministic        │
                        │       enhancement +        │
                        │       reassessment         │
                        │                            │
                        │  2. Module 3               │   DiebeticRetinopathy/
                        │     DRPredictor            │   (model/)
                        │     EfficientNet-B0        │
                        │     grade 0-4 + probs      │
                        │                            │
                        │  3. Grad-CAM explainer     │   (implemented here —
                        │     (new: not in the       │    not in the notebook)
                        │      notebook)             │
                        │                            │
                        │  4. Patient history store  │   runtime/history.json
                        └────────────────────────────┘
```

## Run it

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

python integrated-server/server.py            # → http://0.0.0.0:8000
```

On Windows from the repository root, use the project interpreter explicitly:

```powershell
.venv\Scripts\python.exe integrated-server\server.py
```

This matters for report downloads because the PDF renderer requires the
`reportlab` package installed in that same environment. Generated PDFs are
saved to the repository-level `reports\` directory.

Open http://localhost:8000 — the dashboard is served from `dr-dashboard/`, and
its "Start analysis" button now calls the real backend (`POST /api/analyze`).

### Endpoints

| Method | Path            | Purpose                                                        |
| ------ | --------------- | -------------------------------------------------------------- |
| GET    | `/`             | DR screening dashboard (frontend)                              |
| GET    | `/api/health`   | Module status (quality module / DR model loaded?)              |
| POST   | `/api/analyze`  | Upload `image` + `patient_id` + `eye` → full screening result  |
| GET    | `/outputs/...`  | Generated result / heatmap / original images (per run)         |

### `/api/analyze` response

Exactly the contract documented at the top of `dr-dashboard/app.js`, plus one
extra block, `quality_gate`, with the Module-1 verdict
(`final_status`, `action`, `reason`, `recapture_required`, …) that the
dashboard uses for its quality banner.

Key wiring decisions:

- The **quality module must see the full-resolution upload** — its thresholds
  are resolution-aware (`fov_retinal_area_min`, scale-normalized Laplacian…).
  Never downscale before triage.
- The **DR model classifies the image that passed the gate**:
  - OK TO GO            → original image,
  - BORDERLINE + fixed  → the enhanced image,
  - RECAPTURE           → original (prediction flagged "unreliable" in the UI).
- **Grad-CAM** is computed on the last Conv2d of `model.features`
  (EfficientNet-B0), on the exact geometry the model sees
  (`RetinaGeometry`: crop dark borders → resize → pad), so the heatmap aligns
  pixel-perfect with the returned XAI images.

## Files

```
integrated-server/
├── server.py                 Flask app + wiring + Grad-CAM service
├── smoke_test.py             end-to-end offline test (Flask test client)
├── requirements-server.txt
├── README.md
└── runtime/                  created at runtime (gitignored)
    ├── history.json          per-patient screening records
    └── outputs/<run_id>/     original.png · heatmap.png · result.png
```

## Smoke test

```bash
python integrated-server/smoke_test.py
```

No arguments → it uses real fundus samples already checked into
`Image-quality-assessment-pipeline/reports/module1_full_visual_samples/`
(one "normal/accepted", one "escalated_critical"), exercising both the
OK-TO-GO and RECAPTURE paths. Pass your own images as arguments to test more.

## Honest limits (what is still placeholder)

- **Lesion Detection** runs the **provisional Module-2 placeholder**
  (`lesion_annotator.py`): a deterministic classical-CV *candidate* detector
  (MA / haemorrhages / exudates, FOV-masked). Returned candidate counts are
  severity-weighted from the Module-3 grade, so higher grades carry a
  correspondingly higher estimated lesion burden; drawn boxes remain only the
  real CV candidates. Counts are **not clinical diagnoses** — swap the file
  for your trained Module-2 segmenter when ready (keep the same return
  contract).
- Each `/outputs/<run_id>/` may contain: `original.png` · `heatmap.png` ·
  `result.png` (Grad-CAM composite) · `submitted.png` (as uploaded) ·
  `enhanced.png` (only when the gate enhanced) · `annotated.png` (lesion
  boxes, when candidates exist).
- **Patient history** is a local JSON file (single-node demo); replace
  `record_screening()`/`telemedicine_stats()` with your DB/telemetry service.
- Downloaded PDF reports are written only to the repository-level
  `reports/` directory, not `integrated-server/runtime/`.
- **Class balance / clinical thresholds** — Module 1 thresholds are
  provisional (see its README); DR grades come from the trained Module 3
  checkpoint as-is. Nothing here is a clinical decision system.
