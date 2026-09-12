/* ===================================================================
   DR Screening Dashboard — app.js
   Frontend. All result data (including the composited fundus image) comes
   from the integrated backend (`integrated-server/server.py`), which runs
   the Module-1 quality gate + Module-3 EfficientNet-B0 classifier +
   Grad-CAM, then returns exactly the shape documented below.

   ┌─────────────────────────────────────────────────────────────────┐
   │ BACKEND CONTRACT                                                  │
   │ POST {API_BASE}/api/analyze   (multipart/form-data)               │
   │   fields: patient_id (str), eye ("Left"|"Right"), image (file)    │
   │                                                                   │
   │ 200 OK → JSON:                                                    │
   │ {                                                                 │
   │   "result_image_url": "https://…/result.png",  // fundus WITH     │
   │        // Grad-CAM heatmap + grade badge drawn in                  │
   │   "submitted_photo_url": "…/submitted.png",   // as uploaded       │
   │   "enhanced_photo_url":  "…/enhanced.png",    // Module-1 fix or   │
   │        // null when no enhancement was applied                     │
   │   "classification": {                                             │
   │      "grade": 3,                 // 0..4 from DRPredictor          │
   │      "confidence": 0.94,         // max softmax prob              │
   │      "class_probs": [0.01,0.03,0.10,0.72,0.14],                   │
   │      "referable": true,          // grade >= 2                    │
   │      "referable_prob": 0.96      // P(G2)+P(G3)+P(G4)             │
   │   },                                                              │
   │   "lesions":  { "microaneurysms":12, "hemorrhages":4,             │
   │                 "exudates":7, "detection_bars":[12,4,7],          │
   │                 "annotated_url": "…/annotated.png" }, // Module-2 │
   │        // provisional candidates; annotated_url may be null       │
   │   "quality":  { "focus":"Optimal", "illumination":"Optimal",      │
   │                 "field_of_view":"Optimal", "overall":"Excellent", │
   │                 "enhancement":"Adaptive (CLAHE + Norm)" },        │
   │   "quality_gate": { …Module-1 verdict + reason… },                │
   │   "xai":      { "original_url":"…", "heatmap_url":"…" },           │
   │   "telemedicine": { "throughput_per_hr":120,                      │
   │                 "capacity_per_year":100000, "current_load_pct":68 },│
   │   "history":  [ {"t":"2026-01","grade":1}, {"t":"2026-04","grade":2},│
   │                 {"t":"2026-07","grade":2}, {"t":"now","grade":3} ] │
   │ }                                                                 │
   │                                                                   │
   │ NOTE: classification.* maps 1:1 to DRPredictor output. Lesion     │
   │ counts/annotations come from the provisional Module-2 candidate   │
   │ annotator; telemedicine/history are placeholders until their      │
   │ modules exist — return them from the backend in this shape.       │
   └─────────────────────────────────────────────────────────────────┘
   =================================================================== */

const API_BASE = ""; // same origin; set to "http://localhost:5000" etc. if separate

/* grade → clinical label (0..4). Referable = grade >= 2. */
const GRADE_LABELS = {
  0: "No DR",
  1: "Mild NPDR",
  2: "Moderate (Referable NPDR)",
  3: "Severe (Referable NPDR)",
  4: "Proliferative DR (Referable)",
};

/* =============================== refs =============================== */
const $ = (id) => document.getElementById(id);
const app = document.querySelector(".app");
const form = $("screeningForm");
const eyeInputs = {
  Left: { input: $("leftFileInput"), zone: $("leftDropZone"), inner: $("dzInner"), preview: $("leftPreview"), image: $("leftPreviewImg"), name: $("leftPreviewName") },
  Right: { input: $("rightFileInput"), zone: $("rightDropZone"), inner: $("rightDzInner"), preview: $("rightPreview"), image: $("rightPreviewImg"), name: $("rightPreviewName") },
};
const formError = $("formError");
const uploadState = $("uploadState");
const resultState = $("resultState");
const loading = $("loading");
const resultImage = $("resultImage");
const eyeLabel = $("eyeLabel");
const newScreeningBtn = $("newScreeningBtn");

const selectedFiles = { Left: null, Right: null };
let lastData = null;      // latest /api/analyze payload
let reportEyes = [];
let previewUrl = null;    // object URL of the uploaded file (loading view)
let resultView = "analyzed"; // which image the center panel shows

/* Lesion chart metadata (3 bars: MA / haemorrhages / exudates) */
const LESION_LABELS = ["MA", "HEM", "EXU"];
const LESION_COLORS = ["#7fd6ff", "#ff9d97", "#ffe08a"];
const LESION_FULL = ["Microaneurysms", "Hemorrhages", "Exudates"];

/* ============================ utilities ============================ */
const selectedEye = () => document.querySelector('input[name="eye"]:checked')?.value || "Left";
const svgNS = "http://www.w3.org/2000/svg";
function el(name, attrs = {}) {
  const n = document.createElementNS(svgNS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}

/* ---------------- dynamic result-image frame ----------------
   The center preview box takes the aspect-ratio of whatever image is shown,
   so images of any shape are always displayed completely (no cropping, no
   fixed 1/0.82 frame). Height is clamped for sanity on extreme ratios; the
   image then letterboxes inside the dark frame but is never cut off. */
const resultWrap = document.querySelector(".result-image-wrap");

function fitResultFrame(img) {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) return;
  const cw = resultWrap.clientWidth || 640;
  const maxH = Math.min(window.innerHeight * 0.72, 760);
  const minH = 200;
  const h = (cw * nh) / nw;
  resultWrap.style.width = "100%";
  resultWrap.style.aspectRatio =
    h >= minH && h <= maxH ? `${nw} / ${nh}` : `${cw} / ${Math.min(Math.max(h, minH), maxH)}`;
}

function setResultImage(src) {
  const apply = () => fitResultFrame(resultImage);
  if (resultImage.src === src && resultImage.complete) { apply(); return; }
  resultImage.src = src;
  if (resultImage.complete) apply();
  else resultImage.addEventListener("load", apply, { once: true });
}

window.addEventListener("resize", () => {
  if (resultImage.getAttribute("src")) fitResultFrame(resultImage);
});

function viewSrcOf(d, view) {
  const map = {
    analyzed:  d.result_image_url,
    submitted: d.submitted_photo_url,
    enhanced:  d.enhanced_photo_url,
  };
  return map[view] || null;
}

/* ============================ file input =========================== */
function showPreview(eye, file) {
  const refs = eyeInputs[eye];
  selectedFiles[eye] = file;
  refs.image.src = URL.createObjectURL(file);
  refs.name.textContent = file.name;
  refs.inner.hidden = true;
  refs.preview.hidden = false;
  formError.hidden = true;
}
function clearPreview(eye) {
  const refs = eyeInputs[eye];
  selectedFiles[eye] = null;
  refs.input.value = "";
  refs.inner.hidden = false;
  refs.preview.hidden = true;
}

Object.entries(eyeInputs).forEach(([eye, refs]) => {
  refs.input.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) showPreview(eye, f); });
  refs.zone.addEventListener("click", (e) => { if (!e.target.closest("button") && refs.preview.hidden) refs.input.click(); });
  refs.zone.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && refs.preview.hidden) { e.preventDefault(); refs.input.click(); } });
  ["dragenter", "dragover"].forEach((ev) => refs.zone.addEventListener(ev, (e) => { e.preventDefault(); refs.zone.classList.add("is-drag"); }));
  ["dragleave", "drop"].forEach((ev) => refs.zone.addEventListener(ev, (e) => { e.preventDefault(); refs.zone.classList.remove("is-drag"); }));
  refs.zone.addEventListener("drop", (e) => { const f = e.dataTransfer.files?.[0]; if (f && f.type.startsWith("image/")) showPreview(eye, f); });
});
$("leftBrowseBtn").addEventListener("click", () => eyeInputs.Left.input.click());
$("rightBrowseBtn").addEventListener("click", () => eyeInputs.Right.input.click());
$("leftClearBtn").addEventListener("click", () => clearPreview("Left"));
$("rightClearBtn").addEventListener("click", () => clearPreview("Right"));

/* ===================== result-image view tabs ===================== */
$("resultTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".result-tab");
  if (!btn) return;
  resultView = btn.dataset.view;
  document.querySelectorAll(".result-tab").forEach((b) =>
    b.classList.toggle("is-active", b === btn));
  if (!lastData) return;
  const src = viewSrcOf(lastData, resultView);
  if (src) setResultImage(src);
  renderResultCaption();
});

/* ============================ view mode ============================ */
$("viewMode").addEventListener("change", (e) => {
  const classificationOnly = e.target.value === "Classification only";
  $("cardXai").hidden = classificationOnly;
  $("cardSim").hidden = classificationOnly;
  $("cardLesion").hidden = classificationOnly;
});

/* ======================= the backend seam ========================= */
async function analyzeImage({ patientId, eye, file }) {
  const fd = new FormData();
  fd.append("patient_id", patientId);
  fd.append("eye", eye);
  fd.append("image", file);
  const res = await fetch(`${API_BASE}/api/analyze`, { method: "POST", body: fd });
  if (!res.ok) {
    let msg = `Analysis failed (${res.status})`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) { /* keep default */ }
    throw new Error(msg);
  }
  return await res.json();
}

/* ========================= submit / analyze ======================= */
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;

  const uploads = Object.entries(selectedFiles).filter(([, file]) => file);
  if (!uploads.length) {
    formError.textContent = "Upload a left-eye image, right-eye image, or both to start analysis.";
    formError.hidden = false;
    return;
  }

  const patientId = $("patientId").value.trim() || "Unlabeled";
  const eye = uploads[0][0];

  // enter loading state — the panel shows the submitted image right away
  app.dataset.state = "loading";
  uploadState.hidden = true;
  resultState.hidden = false;
  loading.hidden = false;
  eyeLabel.textContent = `${eye} eye`;
  resultView = "submitted";
  lastData = null;
  $("resultTabs").hidden = true;
  $("resultCaption").hidden = true;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(uploads[0][1]);
  setResultImage(previewUrl);
  $("startBtn").disabled = true;

  try {
    reportEyes = [];
    for (const [uploadEye, file] of uploads) {
      const data = await analyzeImage({ patientId, eye: uploadEye, file });
      reportEyes.push({ eye: uploadEye, data });
    }
    lastData = reportEyes[reportEyes.length - 1].data;
    renderResults(lastData, reportEyes[reportEyes.length - 1].eye);
    renderReport(buildReport(reportEyes, patientId));
    app.dataset.state = "results";
    loading.hidden = true;
    newScreeningBtn.hidden = false;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  } catch (err) {
    // failure is a moment for direction, not mood
    app.dataset.state = "empty";
    resultState.hidden = true;
    uploadState.hidden = false;
    loading.hidden = true;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    formError.textContent = `${err.message}. Check the backend is running, then try again.`;
    formError.hidden = false;
  } finally {
    $("startBtn").disabled = false;
  }
});

/* =========================== report preview ======================== */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function buildReport(entries, patientId) {
  const now = new Date();
  return {
    report_id: `RX-${now.getTime()}`,
    analysis_datetime: now.toLocaleString(),
    eye_analyzed: entries.length === 2 ? "Both Eyes" : `${entries[0].eye} Eye`,
    report_type: "AI-assisted diabetic retinopathy screening",
    performance_metrics: { sensitivity: "95.29%", specificity: "99.14%", auc: "0.997" },
    patient_id: patientId || "Unlabeled",
    doctor_llm_recommendation: null,
    disclaimer: "This report is generated by RetinaXplain as an AI-assisted screening aid. It is not a definitive diagnosis and must be reviewed by a qualified medical professional.",
    eyes: entries.map(({ eye, data }) => {
      const grade = data.classification?.grade;
      const referable = grade !== undefined && grade >= 2;
      const qualityReview = Boolean(data.quality_gate?.recapture_required || data.quality_gate?.final_status === "BORDERLINE");
      const recommendation = referable ? "Further ophthalmological evaluation is recommended." : "Routine monitoring and follow-up according to clinical protocol.";
      return {
        eye_name: `${eye} Eye`,
        image_path: data.enhanced_photo_url || data.submitted_photo_url || null,
        image_source: data.enhanced_photo_url ? "Module 1B-Enhanced Image" : "Original Image",
        quality_status: data.quality?.overall || null,
        quality_scores: data.quality_gate?.dimension_scores || null,
        predicted_grade: grade ?? null,
        grade_probabilities: data.classification?.class_probs || [],
        calibrated_confidence: null,
        model_confidence: data.classification?.confidence ?? null,
        screening_category: grade === undefined ? null : (referable ? "Referable" : "Non-Referable"),
        ai_recommendation: qualityReview ? `${recommendation} Clinical review is recommended before making a final decision.` : recommendation,
        gradcam_path: data.xai?.heatmap_url || null,
        annotated_image_path: data.lesions?.annotated_url || null,
        lesion_counts: data.lesions ? { Microaneurysms: data.lesions.microaneurysms, Hemorrhages: data.lesions.hemorrhages, Exudates: data.lesions.exudates } : null,
        lesion_graph_path: null,
        review_required: qualityReview,
      };
    }),
  };
}

function renderReport(report) {
  const content = $("reportContent");
  const summaries = report.eyes.map((eye) => {
    const probs = (eye.grade_probabilities || []).slice(0, 5).map((value, index) => `<div class="prob-row"><span>Grade ${index}</span><i><b style="width:${Math.max(0, Math.min(100, Number(value) * 100))}%"></b></i><strong>${(Number(value) * 100).toFixed(2)}%</strong></div>`).join("") || `<p class="report-muted">Probability values unavailable.</p>`;
    const lesionEntries = eye.lesion_counts ? Object.entries(eye.lesion_counts) : [];
    const lesionMax = Math.max(1, ...lesionEntries.map(([, count]) => Number(count) || 0));
    const lesionBars = lesionEntries.length ? `<div class="lesion-bars" aria-label="Detected lesion graph for ${escapeHtml(eye.eye_name)}">${lesionEntries.map(([label, count]) => `<div><span>${escapeHtml(label)}</span><i><b style="width:${Math.max(0, Math.min(100, ((Number(count) || 0) / lesionMax) * 100))}%"></b></i></div>`).join("")}</div>` : `<p class="report-muted">Lesion graph unavailable.</p>`;
    const image = (src, alt) => src ? `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"><figcaption>${escapeHtml(alt)}</figcaption></figure>` : `<div class="report-missing">${escapeHtml(alt)} unavailable</div>`;
    return `<article class="eye-report"><div class="eye-report-head"><div><p class="report-kicker">Eye-specific result</p><h3>${escapeHtml(eye.eye_name)} Analysis</h3></div><span class="status-badge ${eye.screening_category === "Referable" ? "is-referable" : "is-clear"}">${escapeHtml(eye.screening_category || "Unavailable")}</span></div><p class="report-meta">Image Source: <b>${escapeHtml(eye.image_source || "Unavailable")}</b></p><div class="report-image-grid">${image(eye.image_path, "Fundus image")}${image(eye.gradcam_path, "Grad-CAM generated from Module 3")}${image(eye.annotated_image_path, "Lesion annotations generated from Module 2")}</div><div class="report-data-grid"><div><h4>Prediction</h4><p class="report-grade">Grade ${eye.predicted_grade ?? "Unavailable"}</p><p>Model confidence (uncalibrated): <b>${eye.model_confidence === null ? "Unavailable" : `${(Number(eye.model_confidence) * 100).toFixed(2)}%`}</b></p><p>${escapeHtml(eye.ai_recommendation || "Recommendation unavailable.")}</p></div><div><h4>Grade Probabilities</h4><div class="probabilities">${probs}</div></div><div><h4>Detected Lesions</h4>${lesionBars}<p class="report-muted">Bars represent relative AI-detected lesion regions and require clinical review.</p></div></div></article>`;
  }).join("");
  content.innerHTML = `<div class="report-header"><div><p class="report-kicker">RetinaXplain</p><h3>Explainable AI-Assisted Diabetic Retinopathy Screening</h3></div><div class="performance"><b>Evaluation Performance on Project Dataset</b><span>Sensitivity: 95.29% &nbsp; Specificity: 99.14% &nbsp; AUC: 0.997</span></div></div><section class="report-section"><h3>Report Information</h3><dl><div><dt>Date and Time of Analysis</dt><dd>${escapeHtml(report.analysis_datetime)}</dd></div><div><dt>Eye Analyzed</dt><dd>${escapeHtml(report.eye_analyzed)}</dd></div><div><dt>Report Type</dt><dd>${escapeHtml(report.report_type)}</dd></div></dl></section><section class="report-section"><h3>Screening Summary</h3><div class="summary-grid">${report.eyes.map((eye) => `<div><b>${escapeHtml(eye.eye_name)}</b><span>Predicted DR Grade: Grade ${eye.predicted_grade ?? "Unavailable"}</span><span>Screening Category: ${escapeHtml(eye.screening_category || "Unavailable")}</span></div>`).join("")}</div></section>${summaries}`;
  $("reportPreview").hidden = false;
}

$("downloadReportBtn").addEventListener("click", async () => {
  if (!reportEyes.length) return;
  const report = buildReport(reportEyes, $("patientId").value.trim() || "Unlabeled");
  report.doctor_pathologist_comment = $("doctorComment").value.trim();
  const error = $("reportError");
  error.hidden = true;
  try {
    const response = await fetch(`${API_BASE}/api/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) });
    if (!response.ok) throw new Error((await response.json()).error || `Download failed (${response.status})`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `RetinaXplain_${report.report_id}.pdf`; link.click();
    URL.revokeObjectURL(url);
  } catch (err) { error.textContent = err.message; error.hidden = false; }
});

/* ============================== render ============================= */
function renderResults(d, eye) {
  const c = d.classification;

  // center result image + tabs: Grad-CAM analysis / Submitted / Enhanced
  eyeLabel.textContent = `${eye} eye`;
  renderResultTabs(d);
  const initialSrc = viewSrcOf(d, resultView);
  if (initialSrc) setResultImage(initialSrc);

  // Module 1 quality-gate banner (recapture / borderline warning)
  renderQualityGate(d);

  // DR classification
  $("drGrade").textContent = `LEVEL ${c.grade}`;
  $("drLabel").textContent = GRADE_LABELS[c.grade] ?? "—";
  $("drConfidence").textContent = `${Math.round(c.confidence * 100)}%`;
  drawGauge(c.grade);

  // lesion counts
  const ls = d.lesions || {};
  setCount($("cntMicro"), ls.microaneurysms);
  setCount($("cntHem"), ls.hemorrhages);
  setCount($("cntExu"), ls.exudates);

  // quality pills
  setPill($("qFocus"), d.quality.focus);
  setPill($("qIllum"), d.quality.illumination);
  setPill($("qFov"), d.quality.field_of_view);

  // lesion chart (histogram) + annotated image access
  drawBars([ls.microaneurysms, ls.hemorrhages, ls.exudates]);
  const note = ls.note
    ? `Counts shown are ${ls.note}.`
    : "Counts are provisional lesion-candidate detections (Module 2 not integrated).";
  $("lesionNote").textContent = note + " Click to view annotated image.";
  $("lesionExpandBtn").hidden = !ls.annotated_url;

  // XAI thumbs + expand affordance
  setThumb($("xaiOriginal"), $("xaiOriginalWrap"), d.xai.original_url);
  setThumb($("xaiHeatmap"), $("xaiHeatmapWrap"), d.xai.heatmap_url);
  $("xaiCaption").textContent = `Key regions for Level ${c.grade} prediction highlighted — click to maximize`;
  $("xaiExpandBtn").hidden = false;

  // telemedicine
  const t = d.telemedicine;
  $("tmThroughput").textContent = `${t.throughput_per_hr}/hr`;
  $("tmCapacity").textContent = `${t.capacity_per_year.toLocaleString()}/yr`;
  $("tmLoad").textContent = `${t.current_load_pct}%`;
  $("tmLoadBar").style.width = `${t.current_load_pct}%`;

  // history
  drawHistory(d.history);

  // status bar
  $("sbQuality").textContent = d.quality.overall;
  $("sbMid").innerHTML = `<em>Enhanced:</em> ${d.quality.enhancement}`;
  $("sbGrade").textContent = `LEVEL ${c.grade}${c.referable ? " (Referable)" : ""}`;
}

function renderResultTabs(d) {
  const tabs = $("resultTabs");
  const map = {
    analyzed:  { label: "Grad-CAM analysis", src: d.result_image_url },
    submitted: { label: "Submitted", src: d.submitted_photo_url },
    enhanced:  { label: "Enhanced", src: d.enhanced_photo_url },
  };
  // default to the real photo (enhanced when the quality gate fixed it,
  // otherwise the submitted one); Grad-CAM stays one click away
  const preferred = d.enhanced_photo_url ? "enhanced" : "submitted";
  const initial = map[preferred] && map[preferred].src ? preferred : "analyzed";
  const active = resultView && map[resultView] && map[resultView].src ? resultView : initial;
  resultView = active;

  const tabBar = tabs.parentElement;
  let seen = 0;
  ["analyzed", "submitted", "enhanced"].forEach((key) => {
    const tab = tabBar.querySelector(`.result-tab[data-view="${key}"]`);
    if (!tab) return;
    const info = map[key];
    if (key === "enhanced" && !info.src) { tab.hidden = true; return; }
    tab.hidden = false;
    tab.textContent = info.label;
    tab.classList.toggle("is-active", key === active);
    seen++;
  });
  tabs.hidden = seen <= 1;
  $("resultCaption").hidden = false;
  renderResultCaption();
}

function renderResultCaption() {
  const cap = $("resultCaption");
  if (!lastData) { cap.textContent = "Submitted image — analysis in progress…"; return; }
  const c = lastData.classification;
  const maps = {
    analyzed:  `Grad-CAM overlay — fundus fed to the model, heatmap highlights the key regions for Level ${c.grade}.`,
    submitted: `Image as submitted (quality assessment & DR grading use this or the enhanced version).`,
    enhanced:  `Image enhanced by the Module-1 quality pipeline, then graded.`,
  };
  cap.textContent = maps[resultView] || "";
}

/* ======================== lightbox / maximizer ====================== */
function openLightbox(title, items, note) {
  $("lightboxTitle").textContent = title;
  const body = $("lightboxBody");
  body.innerHTML = "";
  items.forEach((it) => {
    const fig = document.createElement("figure");
    fig.className = "lb-fig";
    const a = document.createElement("a");
    a.href = it.src; a.target = "_blank"; a.rel = "noopener";
    a.title = "Open in new tab";
    const img = document.createElement("img");
    img.src = it.src; img.alt = it.caption || "";
    a.appendChild(img);
    const figcap = document.createElement("figcaption");
    figcap.textContent = it.caption || "";
    fig.appendChild(a); fig.appendChild(figcap);
    body.appendChild(fig);
  });
  if (note) {
    const p = document.createElement("p");
    p.className = "lb-note";
    p.textContent = note;
    body.appendChild(p);
  }
  const lb = $("lightbox");
  lb.hidden = false;
  lb.style.display = "flex";   // inline style beats any stylesheet rule
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  const lb = $("lightbox");
  lb.style.display = "none";
  lb.hidden = true;
  $("lightboxBody").innerHTML = "";
  document.body.style.overflow = "";
}

$("lightboxClose").addEventListener("click", closeLightbox);
$("lightbox").addEventListener("click", (e) => {
  if (e.target === $("lightbox")) closeLightbox();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("lightbox").hidden) closeLightbox();
});

function openXaiLightbox() {
  if (!lastData || !lastData.xai) return;
  openLightbox(
    "XAI Attention — Grad-CAM",
    [
      { src: lastData.xai.original_url, caption: "Original (model input)" },
      { src: lastData.xai.heatmap_url, caption: `Grad-CAM heatmap — Level ${lastData.classification.grade} evidence` },
      { src: lastData.result_image_url, caption: "Overlay on model input" },
    ],
    "Jet overlay: red = strongest influence on the predicted grade. Click any image to open it in a new tab."
  );
}

function openLesionLightbox() {
  const ls = lastData ? lastData.lesions : null;
  if (!ls || !ls.annotated_url) return;
  const items = [{ src: ls.annotated_url, caption: "Annotated fundus — lesion candidates" }];
  if (lastData.enhanced_photo_url) {
    items.push({ src: lastData.enhanced_photo_url, caption: "Enhanced image (graded)" });
  }
  const legend = document.createElement("div");
  legend.className = "lb-legend";
  // colors match the boxes drawn in annotated.png (RGB)
  [["Microaneurysms", "#00e5ff"], ["Hemorrhages", "#ff5050"], ["Exudates", "#ffc800"]]
    .forEach(([name, color]) => {
      const chip = document.createElement("span");
      chip.className = "lb-chip";
      const sw = document.createElement("i");
      sw.style.background = color;
      chip.appendChild(sw);
      chip.appendChild(document.createTextNode(`${name}: ${ls[name.toLowerCase()]}`));
      legend.appendChild(chip);
    });
  openLightbox("Lesion Detection — annotated image", items,
    "Boxes mark provisional candidate locations from the classical-CV annotator (Module 2 is not trained yet).");
  $("lightboxBody").insertBefore(legend, $("lightboxBody").firstChild);
}

$("xaiExpandBtn").addEventListener("click", openXaiLightbox);
$("xaiBody").addEventListener("click", (e) => {
  if (e.target.closest(".expand-btn")) return;
  if (app.dataset.state === "results" && lastData && lastData.xai) openXaiLightbox();
});
document.querySelectorAll(".xai-thumb").forEach((el) => el.addEventListener("click", (e) => {
  e.stopPropagation();
  if (app.dataset.state === "results" && lastData && lastData.xai) openXaiLightbox();
}));

$("lesionExpandBtn").addEventListener("click", openLesionLightbox);
$("cardLesion").addEventListener("click", (e) => {
  if (e.target.closest(".expand-btn")) return;
  if (app.dataset.state === "results" && lastData && lastData.lesions && lastData.lesions.annotated_url) {
    openLesionLightbox();
  }
});

function setPill(node, value) {
  node.textContent = value;
  node.className = "pill " + (/optimal|good|pass|excellent|ok/i.test(value) ? "pill-ok"
    : /poor|fail|reject|recapture|fair/i.test(value) ? "pill-warn" : "pill-idle");
}
function setCount(node, value) {
  node.textContent = (value === null || value === undefined) ? "—" : value;
}
function setThumb(img, wrap, url) {
  img.src = url; img.hidden = false;
  wrap.querySelector("span").style.display = "none";
}

/* ---- Module-1 quality-gate banner (real verdict from the backend) ---- */
function renderQualityGate(d) {
  const banner = $("gateBanner");
  const text = $("gateBannerText");
  const g = d.quality_gate;
  if (!g || !g.final_status) { banner.hidden = true; return; }

  if (g.recapture_required) {
    banner.className = "gate-banner gate-critical";
    text.innerHTML = `<b>Image failed the quality gate — RECAPTURE REQUIRED.</b> ` +
      `Module-1 verdict: ${g.final_status} (score ${(g.overall_score * 100).toFixed(0)}/100). ` +
      `The DR grade below is for reference only and may be unreliable.`;
  } else if (g.final_status === "BORDERLINE") {
    banner.className = "gate-banner gate-warn";
    text.innerHTML = `<b>Borderline image quality after enhancement.</b> ` +
      `Enhancement applied: ${(g.operations && g.operations.join(", ")) || "none"}. ` +
      `A repeat capture is recommended before relying on this grade.`;
  } else if (g.enhancement_applied) {
    banner.className = "gate-banner gate-ok";
    text.innerHTML = `<b>Quality gate passed after enhancement</b> ` +
      `(${g.original_status} → ${g.final_status}, score ${(g.overall_score * 100).toFixed(0)}→${(g.post_enhancement_score * 100).toFixed(0)}/100).`;
  } else {
    banner.hidden = true;   // NON-CRITICAL straight through
    return;
  }
  banner.hidden = false;
}

/* ============================== charts ============================= */
function drawGauge(grade) {
  const svg = $("gauge");
  svg.innerHTML = "";
  const cx = 100, cy = 104, r = 84, w = 15;
  const colors = ["#3fa45a", "#8bc34a", "#f4c430", "#ef8c34", "#e0413a"];

  // 5 colored segments across 180° → 0°
  for (let i = 0; i < 5; i++) {
    const a0 = 180 - i * 36, a1 = 180 - (i + 1) * 36;
    let dstr = "";
    for (let a = a0; a >= a1; a -= 4) {
      const [x, y] = polar(cx, cy, r, a);
      dstr += (dstr ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1) + " ";
    }
    const [xe, ye] = polar(cx, cy, r, a1);
    dstr += `L${xe.toFixed(1)} ${ye.toFixed(1)}`;
    svg.appendChild(el("path", { d: dstr, fill: "none", stroke: colors[i],
      "stroke-width": w, "stroke-linecap": i === 0 || i === 4 ? "round" : "butt" }));
  }

  // needle
  const t = Math.max(0, Math.min(4, grade ?? 0));
  const ang = 180 - (t / 4) * 180;
  const [nx, ny] = polar(cx, cy, r - 22, ang);
  svg.appendChild(el("line", { x1: cx, y1: cy, x2: nx.toFixed(1), y2: ny.toFixed(1),
    stroke: "#243040", "stroke-width": 3.5, "stroke-linecap": "round" }));
  svg.appendChild(el("circle", { cx, cy, r: 6, fill: "#243040" }));
}

function drawBars(values) {
  const svg = $("lesionChart");
  svg.innerHTML = "";
  const W = 260, H = 150, padL = 34, padB = 24, padT = 10;
  const base = H - padB, plotW = W - padL - 14, plotH = base - padT;
  const counts = values.map((v) => Math.max(0, Math.round(Number(v) || 0)));
  const yMax = Math.max(10, ...counts);
  const yStep = yMax > 20 ? (yMax > 80 ? 40 : 20) : 5;

  // y grid + labels
  for (let g = 0; g <= yMax; g += yStep) {
    const y = base - (g / yMax) * plotH;
    svg.appendChild(el("line", { x1: padL, y1: y, x2: W - 10, y2: y,
      stroke: "rgba(255,255,255,.22)", "stroke-width": 1 }));
    const tx = document.createElementNS(svgNS, "text");
    tx.setAttribute("x", padL - 7); tx.setAttribute("y", y + 3);
    tx.setAttribute("text-anchor", "end"); tx.setAttribute("font-size", "9");
    tx.setAttribute("fill", "rgba(255,255,255,.85)"); tx.textContent = g;
    svg.appendChild(tx);
  }

  // bars — microaneurysms / hemorrhages / exudates (with count labels)
  const n = 3, slot = plotW / n, bw = Math.min(slot * 0.56, 52);
  counts.forEach((v, i) => {
    const h = Math.max(v > 0 ? 2 : 0, (v / yMax) * plotH);
    const x = padL + i * slot + (slot - bw) / 2;
    svg.appendChild(el("rect", { x, y: base - h, width: bw, height: h, rx: 3,
      fill: LESION_COLORS[i] }));
    if (v > 0) {
      const tv = document.createElementNS(svgNS, "text");
      tv.setAttribute("x", x + bw / 2); tv.setAttribute("y", base - h - 4);
      tv.setAttribute("text-anchor", "middle"); tv.setAttribute("font-size", "10");
      tv.setAttribute("font-weight", "bold");
      tv.setAttribute("fill", "#fff"); tv.textContent = v;
      svg.appendChild(tv);
    }
    const tx = document.createElementNS(svgNS, "text");
    tx.setAttribute("x", x + bw / 2); tx.setAttribute("y", base + 15);
    tx.setAttribute("text-anchor", "middle"); tx.setAttribute("font-size", "8.5");
    tx.setAttribute("fill", "rgba(255,255,255,.92)"); tx.textContent = LESION_LABELS[i];
    svg.appendChild(tx);
  });
}

function drawHistory(points) {
  $("historyEmpty").hidden = true;
  const svg = $("historyChart");
  svg.hidden = false;
  svg.innerHTML = "";
  const W = 520, H = 130, padL = 26, padR = 12, padB = 20, padT = 12;
  const base = H - padB, plotW = W - padL - padR, plotH = base - padT, gMax = 4;

  for (let g = 0; g <= gMax; g++) {
    const y = base - (g / gMax) * plotH;
    svg.appendChild(el("line", { x1: padL, y1: y, x2: W - padR, y2: y,
      stroke: "rgba(38,50,65,.12)", "stroke-width": 1 }));
    const tx = document.createElementNS(svgNS, "text");
    tx.setAttribute("x", padL - 6); tx.setAttribute("y", y + 3);
    tx.setAttribute("text-anchor", "end"); tx.setAttribute("font-size", "9");
    tx.setAttribute("fill", "#5b6875"); tx.textContent = g;
    svg.appendChild(tx);
  }
  const n = points.length;
  const xOf = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yOf = (g) => base - (g / gMax) * plotH;

  let dstr = "";
  points.forEach((p, i) => { dstr += (i ? "L" : "M") + xOf(i).toFixed(1) + " " + yOf(p.grade).toFixed(1) + " "; });
  svg.appendChild(el("path", { d: dstr, fill: "none", stroke: "#3d7cc0", "stroke-width": 2.5,
    "stroke-linejoin": "round", "stroke-linecap": "round" }));

  points.forEach((p, i) => {
    svg.appendChild(el("circle", { cx: xOf(i), cy: yOf(p.grade), r: 3.5, fill: "#3d7cc0" }));
    const tx = document.createElementNS(svgNS, "text");
    tx.setAttribute("x", xOf(i)); tx.setAttribute("y", base + 14);
    tx.setAttribute("text-anchor", "middle"); tx.setAttribute("font-size", "9");
    tx.setAttribute("fill", "#5b6875"); tx.textContent = p.t;
    svg.appendChild(tx);
  });
}

/* ============================== reset ============================= */
function resetToStart() {
  if (!$("lightbox").hidden) closeLightbox();
  resultWrap.style.width = "";
  resultWrap.style.aspectRatio = "";
  app.dataset.state = "empty";
  resultState.hidden = true;
  uploadState.hidden = false;
  loading.hidden = true;
  newScreeningBtn.hidden = true;
  formError.hidden = true;
  clearPreview("Left");
  clearPreview("Right");
  $("patientId").value = "";
  // reset panels to pending
  $("drGrade").textContent = "—";
  $("drLabel").textContent = "DR Scale (grade pending…)";
  $("drConfidence").textContent = "—%";
  ["cntMicro", "cntHem", "cntExu"].forEach((id) => { $(id).textContent = "—"; });
  const gateBanner = $("gateBanner"); if (gateBanner) gateBanner.hidden = true;
  ["qFocus", "qIllum"].forEach((id) => { const p = $(id); p.textContent = "pending"; p.className = "pill pill-idle"; });
  const fov = $("qFov"); fov.textContent = "Not assessed"; fov.className = "pill pill-idle";
  $("tmThroughput").textContent = "—"; $("tmCapacity").textContent = "—"; $("tmLoad").textContent = "—";
  $("tmLoadBar").style.width = "0%";
  $("xaiCaption").textContent = "Heatmaps will appear after processing — click to maximize";
  ["xaiOriginal", "xaiHeatmap"].forEach((id) => { const im = $(id); im.hidden = true; im.removeAttribute("src"); });
  $("xaiOriginalWrap").querySelector("span").style.display = "";
  $("xaiHeatmapWrap").querySelector("span").style.display = "";
  $("xaiExpandBtn").hidden = true;
  $("lesionExpandBtn").hidden = true;
  $("lesionNote").textContent = "Run a screening to detect lesion candidates.";
  $("sbQuality").textContent = "Not assessed";
  $("sbMid").innerHTML = "<em>Ready for input</em>";
  $("sbGrade").textContent = "Pending";
  $("historyEmpty").hidden = false;
  $("historyChart").hidden = true;
  $("resultTabs").hidden = true;
  $("resultCaption").hidden = true;
  $("reportPreview").hidden = true;
  $("reportContent").innerHTML = "";
  $("doctorComment").value = "";
  $("reportError").hidden = true;
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  lastData = null;
  reportEyes = [];
  resultView = "analyzed";
  drawGauge(0);
  drawBars([0, 0, 0]);
}

newScreeningBtn.addEventListener("click", resetToStart);

/* navigation (only Dashboard is functional in this frontend) */
document.querySelectorAll(".nav-item").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    if (btn.dataset.nav === "dashboard") resetToStart();
  }));

/* ============================== init ============================= */
drawGauge(0);
drawBars([0, 0, 0]);
