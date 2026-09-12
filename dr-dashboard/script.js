// animate sensitivity / specificity numbers + ring on load
  function animateNumber(el, to, decimals, suffix, duration){
    const start = performance.now();
    function frame(now){
      const p = Math.min(1, (now-start)/duration);
      const eased = 1 - Math.pow(1-p, 3);
      const val = (to*eased).toFixed(decimals);
      el.textContent = val + suffix;
      if(p<1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener('load', () => {
    document.querySelectorAll('.cal-bar-fill').forEach((el,i)=>{
      setTimeout(()=>{ el.style.width = el.dataset.w + '%'; }, 300 + i*90);
    });
  });

  // throughput bars — grow in when scrolled into view
  (function(){
    const svg = document.getElementById('throughputBars');
    const data = [
      [60,50,10],[70,58,12],[85,68,17],[95,74,21],[80,64,16],[65,52,13],[55,44,11]
    ];
    const barW = 26, gap = 18, base = 120;
    const bars = [];
    data.forEach((d,i)=>{
      const x = 10 + i*(barW+gap);
      const total = d[0];
      const clearedH = (d[1]/total)*70;
      const reviewH = (d[2]/total)*70;
      const capH = 70;

      const capRect = document.createElementNS('http://www.w3.org/2000/svg','rect');
      capRect.setAttribute('x', x); capRect.setAttribute('y', base-capH);
      capRect.setAttribute('width', barW); capRect.setAttribute('height', capH);
      capRect.setAttribute('rx', 4); capRect.setAttribute('fill', '#EFD9A8'); capRect.setAttribute('opacity','.35');
      svg.appendChild(capRect);

      const clearRect = document.createElementNS('http://www.w3.org/2000/svg','rect');
      clearRect.setAttribute('x', x); clearRect.setAttribute('width', barW);
      clearRect.setAttribute('y', base); clearRect.setAttribute('height', 0);
      clearRect.setAttribute('rx', 4); clearRect.setAttribute('fill', '#8FBF8A');
      svg.appendChild(clearRect);

      const reviewRect = document.createElementNS('http://www.w3.org/2000/svg','rect');
      reviewRect.setAttribute('x', x); reviewRect.setAttribute('width', barW);
      reviewRect.setAttribute('y', base); reviewRect.setAttribute('height', 0);
      reviewRect.setAttribute('rx', 4); reviewRect.setAttribute('fill', '#D9694D');
      svg.appendChild(reviewRect);

      bars.push({clearRect, reviewRect, clearedH, reviewH, delay:i*70});
    });

    let grown = false;
    const io = new IntersectionObserver((entries)=>{
      entries.forEach(entry=>{
        if (entry.isIntersecting && !grown){
          grown = true;
          bars.forEach(b=>{
            setTimeout(()=>{
              b.clearRect.setAttribute('y', base-b.clearedH);
              b.clearRect.setAttribute('height', b.clearedH);
              b.clearRect.style.transition = 'y .7s cubic-bezier(.2,.8,.3,1), height .7s cubic-bezier(.2,.8,.3,1)';
              b.reviewRect.setAttribute('y', base-b.clearedH-b.reviewH);
              b.reviewRect.setAttribute('height', b.reviewH);
              b.reviewRect.style.transition = 'y .7s cubic-bezier(.2,.8,.3,1), height .7s cubic-bezier(.2,.8,.3,1)';
            }, b.delay);
          });
        }
      });
    }, {threshold:.3});
    io.observe(svg);
  })();

  // ---------- Try it: two-eye upload + integrated backend screening ----------
  (function(){
    const resultBox = document.getElementById('tryResult');
    const resetBtn = document.getElementById('resetBtn');
    const trySection = document.getElementById('try-it');
    const tryPanel = document.querySelector('.try-panel');
    if (!resultBox) return;

    const state = {};
    const rawImages = {};
    const API_BASE = '';
    let selectedTryEye = null;
    let selectedHeroEye = null;

    function bestGradEye(){
      const entries = Object.entries(state).filter(([, report]) => hasDrResult(report));
      if (entries.length === 0) return null;
      return entries.reduce((a,b) => Number(b[1].classification?.grade ?? -1) > Number(a[1].classification?.grade ?? -1) ? b : a)[0];
    }

    let selectedReportEye = null;

    function eyeName(eye){
      return eye === 'L' ? 'Left eye' : 'Right eye';
    }

    function escapeHtml(value){
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[ch]));
    }

    function isUngradable(report){
      return Boolean(report?.quality_gate?.recapture_required || report?.quality_gate?.ok_to_go === false);
    }

    function hasDrResult(report){
      return Boolean(report && !isUngradable(report) && report.classification);
    }

    function qualitySummaryParts(eye, report){
      if (!report) return { verdict: null, detail: 'Focus, illumination and field of view scored automatically' };
      const quality = report.quality || {};
      const gate = report.quality_gate || {};
      if (isUngradable(report)){
        return { verdict: 'Ungradeable', detail: `${eyeName(eye)}: recapture this eye before DR severity screening.` };
      }
      if (gate.enhancement_applied){
        const ops = gate.operations?.length ? ` (${gate.operations.join(', ')})` : '';
        return { verdict: quality.overall || 'Quality passed', detail: `${eyeName(eye)}: Borderline image enhanced${ops}; quality gate passed.` };
      }
      if (gate.original_status === 'BORDERLINE' || gate.final_status === 'BORDERLINE'){
        return { verdict: quality.overall || 'Borderline', detail: `${eyeName(eye)}: Borderline quality after assessment; review before relying on grading.` };
      }
      return { verdict: quality.overall || 'Adequate', detail: `${eyeName(eye)}: focus, illumination and field of view passed.` };
    }

    function setQualitySummary(eye, report){
      const target = document.getElementById('qualitySub');
      if (!target) return;
      const parts = qualitySummaryParts(eye, report);
      target.innerHTML = parts.verdict
        ? `<strong>${escapeHtml(parts.verdict)}</strong><span>${escapeHtml(parts.detail)}</span>`
        : escapeHtml(parts.detail);
    }

    function setHeroEye(eye){
      if (!rawImages[eye] && !state[eye]) return;
      selectedHeroEye = eye;
      renderHeroEye();
      renderLesionViews(Object.entries(state).filter(([, report]) => hasDrResult(report)));
    }

    function loadImage(src){
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    }

    function refreshReportEyeButtons(){
      ['L','R'].forEach(eye => {
        const btn = document.getElementById('reportSlot'+eye);
        if (!btn) return;
        const hasData = hasDrResult(state[eye]) && !!state[eye]?.xai?.heatmap_url;
        btn.classList.toggle('has-data', hasData);
        btn.classList.toggle('blocked', !hasData);
        btn.classList.toggle('active', hasData && selectedReportEye === eye);
        btn.disabled = !hasData;
        btn.title = hasData ? `View ${eye === 'L' ? 'left' : 'right'} eye` : `${eyeName(eye)} did not complete DR/Grad-CAM screening`;
      });
    }

    function clearReportSlider(){
      selectedReportEye = null;
      const reportImg = document.getElementById('reportImg');
      const sampleHeatmap = document.getElementById('reportHeatmapSample');
      const heatmapCanvas = document.getElementById('reportHeatmapCanvas');
      if (reportImg) reportImg.src = 'images/fundus-sample.jpg';
      if (sampleHeatmap) sampleHeatmap.style.display = 'block';
      if (heatmapCanvas) heatmapCanvas.style.display = 'none';
      refreshReportEyeButtons();
    }

    function setReportEye(eye){
      if (!rawImages[eye] || !hasDrResult(state[eye]) || !state[eye].xai?.heatmap_url) {
        refreshReportEyeButtons();
        return;
      }
      selectedReportEye = eye;

      const reportImg = document.getElementById('reportImg');
      const sampleHeatmap = document.getElementById('reportHeatmapSample');
      const heatmapCanvas = document.getElementById('reportHeatmapCanvas');
      const submittedSrc = state[eye].submitted_photo_url || rawImages[eye].dataURL;
      renderDetailedReport(eye, state[eye]);
      if (reportImg) reportImg.src = submittedSrc;
      if (heatmapCanvas && state[eye].xai?.heatmap_url){
        loadImage(submittedSrc).then((img) => {
          const reportSlider = document.getElementById('reportCompareSlider');
          if (reportSlider) reportSlider.style.aspectRatio = `${img.width} / ${img.height}`;
          drawImageUrl(heatmapCanvas, state[eye].xai.heatmap_url, img.width / img.height);
          if (sampleHeatmap) sampleHeatmap.style.display = 'none';
          heatmapCanvas.style.display = 'block';
        });
      }
      const reportBefore = document.getElementById('reportCompareBefore');
      const reportHandle = document.getElementById('reportCompareHandle');
      if (reportBefore && reportHandle){
        reportBefore.style.clipPath = 'inset(0 50% 0 0)';
        reportHandle.style.left = '50%';
      }
      refreshReportEyeButtons();
    }

    function renderDetailedReport(eye, report){
      const classification = report.classification || {};
      const quality = report.quality || {};
      const gate = report.quality_gate || {};
      const lesions = report.lesions || {};
      const confidence = Number(classification.confidence || 0);
      const referable = Boolean(classification.referable);
      const ungradable = isUngradable(report);
      const patient = document.getElementById('patientId')?.value.trim() || 'Unlabeled';
      const reportPatientMeta = document.getElementById('reportPatientMeta');
      const reportVisitMeta = document.getElementById('reportVisitMeta');
      const reportFieldMeta = document.getElementById('reportFieldMeta');
      if (reportPatientMeta) reportPatientMeta.textContent = patient;
      if (reportVisitMeta) reportVisitMeta.textContent = new Date().toLocaleDateString([], {day:'2-digit', month:'short', year:'numeric'});
      if (reportFieldMeta) reportFieldMeta.textContent = `45° macula-centred, ${eye === 'L' ? 'left' : 'right'} eye`;

      const gradeTag = document.getElementById('reportGradeTag');
      if (gradeTag){
        gradeTag.textContent = ungradable ? 'Recapture required' : (referable ? 'Referable — refer to ophthalmologist' : 'Not referable at this grade');
        gradeTag.className = `tag ${ungradable || referable ? 'referable' : 'optimal'}`;
      }
      const confidenceValue = document.getElementById('reportConfidenceValue');
      if (confidenceValue) confidenceValue.textContent = ungradable ? '—' : `${(confidence * 100).toFixed(1)}%`;
      const confidenceBar = document.getElementById('reportConfidenceBar');
      if (confidenceBar) confidenceBar.style.width = ungradable ? '0%' : `${Math.max(0, Math.min(100, confidence * 100))}%`;

      const evidence = document.getElementById('reportEvidenceList');
      if (evidence){
        const lesionRows = [
          ['Microaneurysms', Number(lesions.microaneurysms) || 0, '#F6E27A'],
          ['Hemorrhages', Number(lesions.hemorrhages) || 0, '#F2733A'],
          ['Exudates', Number(lesions.exudates) || 0, '#7FBF9E'],
        ];
        const maxLesion = Math.max(1, ...lesionRows.map(([, count]) => count));
        evidence.innerHTML = lesionRows.map(([label, count, color]) => `<div class="report-lesion-row"><div class="report-lesion-name"><span class="e-dot" style="background:${color}"></span>${label} detected</div><div class="report-lesion-track"><b style="width:${(count / maxLesion) * 100}%;background:${color}"></b></div><div class="report-lesion-count">${count}</div></div>`).join('');
      }
    }

    function hashString(str){
      let h = 5381;
      for (let i=0; i<str.length; i++){ h = ((h<<5)+h) + str.charCodeAt(i); h = h & 0xffffffff; }
      return Math.abs(h);
    }
    function mulberry32(a){
      return function(){
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    function drawCover(ctx, img, size){
      const scale = Math.max(size/img.width, size/img.height);
      const w = img.width*scale, h = img.height*scale;
      const x = (size-w)/2, y = (size-h)/2;
      ctx.clearRect(0,0,size,size);
      ctx.drawImage(img, x, y, w, h);
    }

    function drawContain(ctx, img, width, height){
      const scale = Math.min(width / img.width, height / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
    }

    function sizeCompareCanvas(canvas, img, ratio){
      const width = 640;
      const height = Math.max(1, Math.round(width / ratio));
      canvas.width = width;
      canvas.height = height;
      drawContain(canvas.getContext('2d'), img, width, height);
    }

    function drawImageUrl(canvas, src, ratio){
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          sizeCompareCanvas(canvas, img, ratio || img.width / img.height);
          resolve();
        };
        img.onerror = reject;
        img.src = src;
      });
    }

    function drawHeatmapOverlay(canvasEl, img, size, seed){
      const ctxB = canvasEl.getContext('2d');
      drawCover(ctxB, img, size);
      ctxB.fillStyle = 'rgba(10,8,6,0.45)';
      ctxB.fillRect(0,0,size,size);
      const rand = mulberry32(seed);
      const blobCount = 2 + Math.floor(rand()*3);
      ctxB.globalCompositeOperation = 'lighter';
      for (let i=0; i<blobCount; i++){
        const bx = size*(0.25 + rand()*0.5);
        const by = size*(0.25 + rand()*0.5);
        const br = size*(0.10 + rand()*0.16);
        const grad = ctxB.createRadialGradient(bx,by,0,bx,by,br);
        grad.addColorStop(0, 'rgba(255,225,120,0.95)');
        grad.addColorStop(0.55, 'rgba(240,110,55,0.55)');
        grad.addColorStop(1, 'rgba(240,110,55,0)');
        ctxB.fillStyle = grad;
        ctxB.beginPath(); ctxB.arc(bx,by,br,0,Math.PI*2); ctxB.fill();
      }
      ctxB.globalCompositeOperation = 'source-over';
    }

    function evidenceFor(report){
      const lesions = report.lesions || {};
      return [
        [`Microaneurysms detected: ${lesions.microaneurysms ?? 0}`, '#F6E27A', 'review'],
        [`Hemorrhages detected: ${lesions.hemorrhages ?? 0}`, '#F2733A', 'review'],
        [`Exudates detected: ${lesions.exudates ?? 0}`, '#7FBF9E', 'review'],
      ];
    }

    function renderEvidence(listEl, report){
      listEl.innerHTML = '';
      evidenceFor(report).forEach(([name,color,val]) => {
        const row = document.createElement('div');
        row.className = 'evidence-item';
        row.innerHTML = `<div class="e-name"><span class="e-dot" style="background:${color}"></span>${name}</div><div class="e-val">${val}</div>`;
        listEl.appendChild(row);
      });
    }

    function setTryEye(eye){
      if (!rawImages[eye]) return;
      selectedTryEye = eye;
      ['L', 'R'].forEach((candidate) => {
        document.getElementById('detail' + candidate)?.classList.toggle('show', candidate === eye);
      });
      const switchButton = document.getElementById('tryEyeSwitch');
      const otherEye = eye === 'L' ? 'R' : 'L';
      switchButton.hidden = !rawImages[otherEye];
      switchButton.textContent = `Show ${otherEye === 'L' ? 'left' : 'right'} eye`;
      if (state[eye]) renderEyeSummary(eye, state[eye]);
    }

    function renderEyeSummary(eye, report){
      const target = document.getElementById('summary' + eye);
      if (!target) return;
      const classification = report.classification || {};
      const quality = report.quality || {};
      const gate = report.quality_gate || {};
      const lesions = report.lesions || {};
      if (isUngradable(report)){
        target.innerHTML = `<div class="eye-screening-stat"><span class="summary-label">Quality</span><strong>Ungradeable</strong><small>Recapture image</small></div><div class="eye-screening-stat"><span class="summary-label">DR grading</span><strong>Skipped</strong><small>Quality gate failed</small></div><div class="eye-screening-stat"><span class="summary-label">Reason</span><strong>Review</strong><small>${gate.reason || gate.action || 'Recapture required'}</small></div><div class="eye-screening-stat"><span class="summary-label">Lesions</span><strong>—</strong><small>Not analyzed</small></div>`;
        return;
      }
      const category = classification.referable ? 'Referable' : 'Not referable';
      const qualityDetail = gate.action || quality.overall || 'Unavailable';
      target.innerHTML = `<div class="eye-screening-stat"><span class="summary-label">Predicted grade</span><strong>${classification.grade ?? '—'}</strong><small>${category}</small></div><div class="eye-screening-stat"><span class="summary-label">Confidence</span><strong>${classification.confidence == null ? '—' : `${(classification.confidence * 100).toFixed(1)}%`}</strong><small>Model output</small></div><div class="eye-screening-stat"><span class="summary-label">Quality</span><strong>${quality.overall || '—'}</strong><small>${qualityDetail}</small></div><div class="eye-screening-stat"><span class="summary-label">Lesions</span><strong>${(lesions.microaneurysms || 0) + (lesions.hemorrhages || 0) + (lesions.exudates || 0)}</strong><small>MA · HEM · EXU</small></div>`;
    }

    function renderLesionViews(entries){
      const chart = document.getElementById('lesionCardChart');
      const modalContent = document.getElementById('lesionModalContent');
      if (!entries.length){
        if (chart) chart.innerHTML = '<div class="lesion-chart-empty">Run screening to populate lesion counts</div>';
        if (modalContent) modalContent.innerHTML = '<div class="preview-empty"><strong>Run a screening to view lesion counts.</strong><span>Each analyzed eye will appear here with its detected lesion burden.</span></div>';
        return;
      }
      const lesionTypes = [
        ['MA', 'Microaneurysms', 'microaneurysms'],
        ['HEM', 'Hemorrhages', 'hemorrhages'],
        ['EXU', 'Exudates', 'exudates'],
      ];
      const chartEntry = entries.find(([eye]) => eye === selectedHeroEye) || entries[0];
      const chartValues = lesionTypes.map(([, , key]) => Number(chartEntry?.[1]?.lesions?.[key]) || 0);
      const chartMax = Math.max(1, ...chartValues);
      if (chart){
        chart.setAttribute('aria-label', `${eyeName(chartEntry?.[0])} lesion counts`);
        chart.innerHTML = lesionTypes.map(([short], index) => `<div class="lesion-chart-row"><span>${short}</span><div class="lesion-chart-track"><b style="width:${(chartValues[index] / chartMax) * 100}%"></b></div><strong>${chartValues[index]}</strong></div>`).join('');
      }
      const modalMax = Math.max(1, ...entries.flatMap(([, data]) => lesionTypes.map(([, , key]) => Number(data.lesions?.[key]) || 0)));
      if (modalContent){
        modalContent.innerHTML = entries.map(([eye, data]) => {
          const eyeName = eye === 'L' ? 'Left eye' : 'Right eye';
          const annotatedUrl = data.lesions?.annotated_url;
          const rows = lesionTypes.map(([short, label, key], index) => {
            const count = Number(data.lesions?.[key]) || 0;
            const colors = ['#E3C95D', '#F2733A', '#7FBF9E'];
            return `<div class="lesion-modal-row"><span><i class="evidence-swatch ${['amber', 'coral', 'teal'][index]}"></i>${label}</span><div class="lesion-modal-track"><b style="width:${(count / modalMax) * 100}%;background:${colors[index]}"></b></div><strong>${count}</strong></div>`;
          }).join('');
          const annotation = annotatedUrl
            ? `<figure class="lesion-annotation"><img src="${annotatedUrl}" alt="${eyeName} annotated lesion detection image"><figcaption>Annotated lesion detection</figcaption></figure>`
            : '<div class="lesion-annotation lesion-annotation-missing">Annotated lesion image unavailable</div>';
          return `<section class="lesion-eye-block"><div class="lesion-eye-heading"><h3>${eyeName}</h3><span>${data.quality?.overall || 'Screened'} · Grade ${data.classification?.grade ?? '—'}</span></div><div class="lesion-eye-layout">${annotation}<div class="lesion-eye-bars">${rows}</div></div></section>`;
        }).join('');
      }
    }

    function renderHeroEye(){
      const availableEyes = ['L', 'R'].filter((eye) => rawImages[eye] || state[eye]);
      const completedEyes = ['L', 'R'].filter((eye) => state[eye]);
      const toggle = document.getElementById('heroEyeToggle');
      if (!selectedHeroEye || !availableEyes.includes(selectedHeroEye)){
        selectedHeroEye = completedEyes[0] || availableEyes[0] || null;
      }

      if (toggle){
        toggle.hidden = availableEyes.length < 2;
        toggle.dataset.eye = selectedHeroEye || 'L';
        ['L', 'R'].forEach((eye) => {
          const btn = document.getElementById('heroEyeToggle' + eye);
          if (!btn) return;
          btn.classList.toggle('active', selectedHeroEye === eye);
          btn.disabled = !availableEyes.includes(eye);
          btn.title = availableEyes.includes(eye) ? `Show ${eyeName(eye).toLowerCase()} results` : `Upload ${eyeName(eye).toLowerCase()} first`;
        });
      }

      const selectedReport = selectedHeroEye ? state[selectedHeroEye] : null;
      const selectedRaw = selectedHeroEye ? rawImages[selectedHeroEye] : null;
      const heroAwaiting = document.getElementById('heroAwaiting');
      const heroGradeNum = document.getElementById('heroGradeNum');
      const heroConfNum = document.getElementById('heroConfNum');
      const heroGradeTag = document.getElementById('heroGradeTag');
      const heroConfTag = document.getElementById('heroConfTag');
      const qualitySub = document.getElementById('qualitySub');
      const lesionSub = document.getElementById('lesionSub');
      const gradcamNum = document.getElementById('gradcamNum');
      const scanQuality = document.querySelector('.scan-quality');

      if (!selectedReport){
        heroAwaiting?.classList.remove('hide');
        if (heroAwaiting && selectedHeroEye) heroAwaiting.textContent = `${eyeName(selectedHeroEye)} uploaded. Run screening to see results for this eye.`;
        if (heroGradeNum) heroGradeNum.textContent = '—';
        if (heroConfNum) heroConfNum.textContent = '—';
        if (heroGradeTag) heroGradeTag.style.visibility = 'hidden';
        if (heroConfTag) heroConfTag.style.visibility = 'hidden';
        if (qualitySub) qualitySub.innerHTML = escapeHtml(selectedHeroEye ? `${eyeName(selectedHeroEye)} image awaiting quality assessment` : 'Focus, illumination and field of view scored automatically');
        if (lesionSub){
          lesionSub.textContent = 'Awaiting scan — run screening to localise lesions';
          lesionSub.style.color = '#ffffff';
        }
        if (gradcamNum) gradcamNum.textContent = '—';
        if (scanQuality) scanQuality.textContent = selectedHeroEye ? `${eyeName(selectedHeroEye)} awaiting screening` : 'Adequate quality';
        return;
      }

      const classification = selectedReport.classification || {};
      const lesions = selectedReport.lesions || {};
      const totalLesions = (Number(lesions.microaneurysms) || 0) + (Number(lesions.hemorrhages) || 0) + (Number(lesions.exudates) || 0);
      const ungradable = isUngradable(selectedReport);
      heroAwaiting?.classList.add('hide');
      if (heroGradeTag) heroGradeTag.style.visibility = 'visible';
      if (heroConfTag) heroConfTag.style.visibility = 'visible';
      setQualitySummary(selectedHeroEye, selectedReport);
      if (scanQuality) scanQuality.textContent = ungradable ? 'Ungradeable quality' : (selectedReport.quality?.overall || 'Adequate quality');

      if (ungradable){
        if (heroGradeNum) heroGradeNum.textContent = '—';
        if (heroConfNum) heroConfNum.textContent = '—';
        if (heroGradeTag){
          heroGradeTag.textContent = 'Recapture required';
          heroGradeTag.className = 'tag referable';
        }
        if (heroConfTag){
          heroConfTag.textContent = `${eyeName(selectedHeroEye)} not sent to DR model`;
          heroConfTag.className = 'tag referable';
        }
        if (lesionSub){
          lesionSub.textContent = `${eyeName(selectedHeroEye)} ungradeable — lesion detection skipped`;
          lesionSub.style.color = '#ffffff';
        }
        if (gradcamNum) gradcamNum.textContent = '—';
        return;
      }

      if (heroGradeNum) heroGradeNum.textContent = classification.grade ?? '—';
      if (heroConfNum) heroConfNum.textContent = classification.confidence == null ? '—' : `${(classification.confidence * 100).toFixed(1)}%`;
      if (heroGradeTag){
        heroGradeTag.textContent = classification.referable ? 'Referable — refer to ophthalmologist' : 'Not referable at this grade';
        heroGradeTag.className = `tag ${classification.referable ? 'referable' : 'optimal'}`;
      }
      if (heroConfTag){
        heroConfTag.textContent = `Scan complete · ${eyeName(selectedHeroEye).toLowerCase()}`;
        heroConfTag.className = 'tag optimal';
      }
      if (lesionSub){
        lesionSub.textContent = `${eyeName(selectedHeroEye)}: ${totalLesions} lesions localised`;
        lesionSub.style.color = '#5C4620';
      }
      if (gradcamNum) gradcamNum.textContent = classification.confidence == null ? '—' : `${(classification.confidence * 100).toFixed(1)}%`;
    }

    function updateCombined(){
      const entries = Object.entries(state);
      const gradableEntries = entries.filter(([, report]) => hasDrResult(report));
      if (entries.length === 0){
        renderLesionViews([]);
        resultBox.classList.remove('show');
        document.getElementById('heroGradeTag').style.visibility = 'hidden';
        document.getElementById('heroConfTag').style.visibility = 'hidden';
        document.getElementById('heroGradeNum').textContent = '—';
        document.getElementById('heroConfNum').textContent = '—';
        document.getElementById('heroAwaiting').classList.remove('hide');
        renderHeroEye();
        return;
      }
      resultBox.classList.add('show');
      renderLesionViews(gradableEntries);

      const worst = gradableEntries.length
        ? gradableEntries.reduce((a,b) => Number(b[1].classification?.grade ?? -1) > Number(a[1].classification?.grade ?? -1) ? b : a)
        : entries[0];
      const [worstEye, report] = worst;
      const classification = report.classification || {};
      const eyeLabel = worstEye === 'L' ? 'left eye' : 'right eye';

      document.getElementById('tryGrade').textContent = classification.grade ?? '—';
      document.getElementById('tryConfidence').textContent = classification.confidence == null ? '—' : `${(classification.confidence * 100).toFixed(1)}%`;
      const tag = document.getElementById('tryTag');
      if (isUngradable(report)){
        tag.textContent = `${eyeName(worstEye)} ungradeable — recapture required`;
        tag.style.background = 'rgba(217,105,77,.14)'; tag.style.color = 'var(--coral-deep)';
      } else if (classification.referable){
        tag.textContent = entries.length === 2
          ? `Referable — flagged for review (${eyeLabel})`
          : 'Referable — flagged for review';
        tag.style.background = 'rgba(217,105,77,.14)'; tag.style.color = 'var(--coral-deep)';
      } else {
        tag.textContent = 'Not referable at this grade';
        tag.style.background = 'rgba(46,107,92,.14)'; tag.style.color = 'var(--teal-deep)';
      }

      renderHeroEye();

      // ---- Report Generation card ----
      document.getElementById('reportSub').textContent =
        'Annotated report ready for ophthalmologist sign‑off, <30s';

      document.querySelector('.report-grade-num').textContent = classification.grade ?? '—';
      document.querySelector('.report-doc-summary .report-conf-row b').textContent = classification.confidence == null ? '—' : `${(classification.confidence * 100).toFixed(1)}%`;
      document.querySelector('.report-doc-summary .tag').textContent = isUngradable(report) ? 'Recapture required' : (classification.referable ? 'Referable — refer to ophthalmologist' : 'Not referable at this grade');
      document.querySelector('.report-doc-summary .tag').className = `tag ${isUngradable(report) || classification.referable ? 'referable' : 'optimal'}`;
      document.getElementById('downloadReportBtn').disabled = gradableEntries.length === 0;
      renderLiveReportPreview(entries, worstEye, report);
    }

    function renderLiveReportPreview(entries, worstEye, report){
      const content = document.getElementById('reportPreviewContent');
      if (!content) return;
      const imageCard = (src, label, alt) => src
        ? `<figure class="preview-image-card"><div class="preview-image-frame"><img src="${src}" alt="${alt}"></div><figcaption>${label}</figcaption></figure>`
        : `<figure class="preview-image-card preview-image-missing"><div class="preview-image-frame"><span>Unavailable</span></div><figcaption>${label}</figcaption></figure>`;
      const eyeReports = entries.map(([eye, data]) => {
        const classification = data.classification || {};
        const quality = data.quality || {};
        const gate = data.quality_gate || {};
        const lesions = data.lesions || {};
        const referable = Boolean(classification.referable);
        const ungradable = isUngradable(data);
        const eyeName = eye === 'L' ? 'Left eye' : 'Right eye';
        const values = [
          ['Microaneurysms', Number(lesions.microaneurysms) || 0, 'amber'],
          ['Hemorrhages', Number(lesions.hemorrhages) || 0, 'coral'],
          ['Exudates', Number(lesions.exudates) || 0, 'teal'],
        ];
        const maxLesion = Math.max(1, ...values.map(([, value]) => value));
        const bars = values.map(([label, value, color]) => `<div class="preview-lesion-row"><span><i class="evidence-swatch ${color}"></i>${label}</span><div class="preview-lesion-track"><b class="${color}" style="width:${(value / maxLesion) * 100}%"></b></div><strong>${value}</strong></div>`).join('');
        const statusText = ungradable ? 'Recapture required' : (referable ? 'Referable' : 'Not referable');
        const recommendation = ungradable ? 'Recapture this eye image before DR severity screening.' : (referable ? 'Further ophthalmological evaluation is recommended.' : 'Routine monitoring and follow-up according to clinical protocol.');
        return `<article class="preview-eye-report"><div class="preview-eye-heading"><h3>${eyeName}</h3><span class="tag ${ungradable || referable ? 'referable' : 'optimal'}">${statusText}</span></div><div class="preview-result-grid"><div><span class="preview-label">ICDR grade</span><strong>${ungradable ? 'Skipped' : (classification.grade ?? '—')}</strong></div><div><span class="preview-label">Confidence</span><strong>${ungradable || classification.confidence == null ? '—' : `${(classification.confidence * 100).toFixed(1)}%`}</strong><span class="preview-muted">${ungradable ? 'Quality gate failed' : 'Uncalibrated model output'}</span></div><div><span class="preview-label">Quality</span><strong>${quality.overall || '—'}</strong><span class="preview-muted">${gate.action || 'Quality gate complete'}</span></div></div><div class="preview-image-grid">${imageCard(data.submitted_photo_url, 'Input fundus image', `${eyeName} input fundus image`)}${imageCard(data.xai?.heatmap_url || data.result_image_url, 'Grad-CAM attention', `${eyeName} Grad-CAM attention`)}${imageCard(data.lesions?.annotated_url, 'Lesion detection', `${eyeName} lesion detection image`)}</div><div class="preview-lesions"><h3>Lesions detected</h3>${ungradable ? '<div class="preview-empty"><strong>Skipped by quality gate.</strong><span>Recapture this eye image to continue.</span></div>' : bars}</div><div class="preview-recommendation"><strong>Clinician recommendation</strong><span>${recommendation}</span></div></article>`;
      }).join('');
      content.innerHTML = `<div class="preview-meta"><span>Patient <strong>${document.getElementById('patientId')?.value.trim() || 'Unlabeled'}</strong></span><span>${entries.length === 2 ? 'Both eyes' : `${worstEye === 'L' ? 'Left' : 'Right'} eye`} · live analysis</span></div>${eyeReports}`;
    }

    function buildReportPayload(){
      const entries = Object.entries(state);
      return {
        report_id: `RX-${Date.now()}`,
        analysis_datetime: new Date().toLocaleString(),
        eye_analyzed: entries.length === 2 ? 'Both Eyes' : `${entries[0][0] === 'L' ? 'Left' : 'Right'} Eye`,
        report_type: 'AI-assisted diabetic retinopathy screening',
        patient_id: document.getElementById('patientId')?.value.trim() || 'Unlabeled',
        eyes: entries.map(([eye, data]) => {
          const classification = data.classification || {};
          const lesions = data.lesions || {};
          const referable = Boolean(classification.referable);
          const ungradable = isUngradable(data);
          return {
            eye_name: `${eye === 'L' ? 'Left' : 'Right'} Eye`,
            image_path: data.enhanced_photo_url || data.submitted_photo_url || null,
            image_source: data.enhanced_photo_url ? 'Module 1B-Enhanced Image' : 'Original Image',
            quality_status: data.quality?.overall || null,
            quality_scores: data.quality_gate?.dimension_scores || null,
            predicted_grade: classification.grade ?? null,
            grade_probabilities: classification.class_probs || [],
            model_confidence: classification.confidence ?? null,
            screening_category: ungradable ? 'Ungradeable - Recapture Required' : (classification.grade === undefined ? null : (referable ? 'Referable' : 'Non-Referable')),
            ai_recommendation: ungradable ? 'Recapture this eye image before DR severity screening.' : (referable ? 'Further ophthalmological evaluation is recommended.' : 'Routine monitoring and follow-up according to clinical protocol.'),
            gradcam_path: data.xai?.heatmap_url || null,
            annotated_image_path: data.lesions?.annotated_url || null,
            lesion_counts: {
              Microaneurysms: lesions.microaneurysms || 0,
              Hemorrhages: lesions.hemorrhages || 0,
              Exudates: lesions.exudates || 0,
            },
          };
        }),
      };
    }

    function attachTrySlider(eye){
      const wrap = document.getElementById('trySlider'+eye);
      const before = document.getElementById('trySliderBefore'+eye);
      const handle = document.getElementById('trySliderHandle'+eye);
      if (!wrap) return;
      let dragging = false;
      function setPos(px){
        const r = wrap.getBoundingClientRect();
        let pct = ((px - r.left) / r.width) * 100;
        pct = Math.max(4, Math.min(96, pct));
        before.style.clipPath = `inset(0 ${100-pct}% 0 0)`;
        handle.style.left = pct + '%';
      }
      wrap.addEventListener('pointerdown', (e) => { dragging = true; setPos(e.clientX); wrap.setPointerCapture(e.pointerId); });
      wrap.addEventListener('pointermove', (e) => { if (dragging) setPos(e.clientX); });
      wrap.addEventListener('pointerup', () => { dragging = false; });
      wrap.addEventListener('pointerleave', () => { dragging = false; });
    }

    function sweepTrySlider(eye){
      const before = document.getElementById('trySliderBefore'+eye);
      const handle = document.getElementById('trySliderHandle'+eye);
      if (!before) return;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduceMotion){ before.style.clipPath = 'inset(0 50% 0 0)'; handle.style.left = '50%'; return; }
      let p = 4;
      before.style.clipPath = 'inset(0 96% 0 0)';
      handle.style.left = '4%';
      const sweep = setInterval(() => {
        p += 3;
        before.style.clipPath = `inset(0 ${100-p}% 0 0)`;
        handle.style.left = p + '%';
        if (p >= 50){ clearInterval(sweep); }
      }, 10);
    }

    function setupEye(eye){
      const dropzone = document.getElementById('dropzone'+eye);
      const fileInput = document.getElementById('fileInput'+eye);
      const thumbRow = document.getElementById('thumbRow'+eye);
      const thumbImg = document.getElementById('thumbImg'+eye);
      const thumbGrade = document.getElementById('thumbGrade'+eye);
      const thumbChange = document.getElementById('thumbChange'+eye);
      const canvasOriginal = document.getElementById('canvasOriginal'+eye);
      const canvasHeatmap = document.getElementById('canvasHeatmap'+eye);
      const evidenceList = document.getElementById('evidence'+eye);
      const detail = document.getElementById('detail'+eye);
      attachTrySlider(eye);

      function handleFile(file){
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            const size = 320;
            const ctxA = canvasOriginal.getContext('2d');
            const ctxB = canvasHeatmap.getContext('2d');
            const ratio = img.width / img.height;
            const compareSlider = document.getElementById('trySlider' + eye);
            if (compareSlider) compareSlider.style.aspectRatio = `${img.width} / ${img.height}`;
            sizeCompareCanvas(canvasOriginal, img, ratio);
            sizeCompareCanvas(canvasHeatmap, img, ratio);

            // this eye's previous computed result (if any) is now stale until Run is pressed again
            delete state[eye];
            rawImages[eye] = { file, img, dataURL: e.target.result };

            thumbImg.src = e.target.result;
            thumbGrade.textContent = 'Uploaded — press Run to screen';
            thumbRow.classList.add('show');
            dropzone.classList.add('hide');
            trySection?.classList.remove('upload-section-pending');
            tryPanel?.classList.remove('upload-panel-pending');

            evidenceList.innerHTML = '';
            detail.classList.add('show');
            setTryEye(selectedTryEye || eye);
            sweepTrySlider(eye);

            const heroSlot = document.getElementById('heroSlot'+eye);
            if (heroSlot){
              heroSlot.style.backgroundImage = `url(${e.target.result})`;
              heroSlot.classList.add('filled');
            }
            const heroCaption = document.getElementById('heroCaption'+eye);
            if (heroCaption) heroCaption.textContent = 'Uploaded';

            document.getElementById('runScreeningBtn').disabled = false;
            updateCombined(); // will show the "awaiting" state if nothing has been run yet
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      }

      dropzone.addEventListener('click', () => fileInput.click());
      ['dragover','dragenter'].forEach(evt => dropzone.addEventListener(evt, e => {
        e.preventDefault(); dropzone.classList.add('drag');
      }));
      ['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, e => {
        e.preventDefault(); dropzone.classList.remove('drag');
      }));
      dropzone.addEventListener('drop', e => {
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleFile(f);
      });
      fileInput.addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        if (f) handleFile(f);
      });
      thumbChange.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
    }

    setupEye('L');
    setupEye('R');

    const runBtn = document.getElementById('runScreeningBtn');
    async function analyzeImage(eye, file){
      const form = new FormData();
      form.append('patient_id', document.getElementById('patientId')?.value.trim() || 'Unlabeled');
      form.append('eye', eye === 'L' ? 'Left' : 'Right');
      form.append('image', file);
      const response = await fetch(`${API_BASE}/api/analyze`, { method: 'POST', body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Analysis failed (${response.status})`);
      return data;
    }

    async function runScreening(){
      const eyes = Object.keys(rawImages);
      if (eyes.length === 0) return;

      runBtn.disabled = true;
      runBtn.classList.add('running');
      runBtn.querySelector('.run-btn-label').textContent = 'Running screening…';

      try {
        for (const eye of eyes) {
          const data = await analyzeImage(eye, rawImages[eye].file);
          state[eye] = data;
          if (isUngradable(data)){
            document.getElementById('thumbGrade' + eye).textContent = 'Ungradeable — recapture image';
            const evidenceList = document.getElementById('evidence' + eye);
            if (evidenceList){
              evidenceList.innerHTML = '<div class="evidence-item"><div class="e-name"><span class="e-dot" style="background:#D9694D"></span>Quality gate failed — recapture required</div><div class="e-val">skip</div></div>';
            }
          } else {
            await drawImageUrl(
              document.getElementById('canvasHeatmap' + eye),
              data.xai?.heatmap_url,
              rawImages[eye].img.width / rawImages[eye].img.height,
            );
            document.getElementById('thumbGrade' + eye).textContent = `Grade ${data.classification.grade} · ${(data.classification.confidence * 100).toFixed(1)}%`;
            renderEvidence(document.getElementById('evidence' + eye), data);
          }
          if (!selectedHeroEye || selectedHeroEye === eye) setHeroEye(eye);
          renderEyeSummary(eye, data);
          sweepTrySlider(eye);
        }
        const gradEye = bestGradEye();
        setTryEye(gradEye || selectedHeroEye || eyes[0]);
        if (gradEye){
          animateNumber(document.getElementById('gradcamNum'), state[gradEye].classification.confidence * 100, 1, '%', 900);
          setReportEye(gradEye);
          setHeroEye(selectedHeroEye || gradEye);
        } else {
          setHeroEye(selectedHeroEye || eyes[0]);
        }
        updateCombined();
        resultBox.scrollIntoView({behavior:'smooth', block:'nearest'});
      } catch (error) {
        window.alert(`${error.message}. Make sure the integrated server is running.`);
      } finally {
        runBtn.disabled = false;
        runBtn.classList.remove('running');
        runBtn.querySelector('.run-btn-label').textContent = 'Re-run screening';
      }
    }
    runBtn.addEventListener('click', runScreening);
    document.getElementById('tryEyeSwitch')?.addEventListener('click', () => {
      if (selectedTryEye) setTryEye(selectedTryEye === 'L' ? 'R' : 'L');
    });

    async function downloadReportPdf(){
      if (!Object.keys(state).length) return;
      const button = document.getElementById('downloadReportBtn');
      button.disabled = true;
      try {
        const payload = buildReportPayload();
        payload.doctor_pathologist_comment = document.getElementById('commentInput')?.value.trim() || '';
        const response = await fetch(`${API_BASE}/api/report`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Report generation failed');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `RetinaXplain_${payload.report_id}.pdf`;
        link.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        window.alert(`${error.message}. Make sure the integrated server is running.`);
      } finally {
        button.disabled = false;
      }
    }
    document.getElementById('downloadReportBtn')?.addEventListener('click', downloadReportPdf);

    ['L','R'].forEach(eye => {
      const slot = document.getElementById('heroSlot'+eye);
      if (slot) slot.addEventListener('click', () => {
        const fi = document.getElementById('fileInput'+eye);
        if (fi) fi.click();
      });
      const reportSlot = document.getElementById('reportSlot'+eye);
      if (reportSlot) reportSlot.addEventListener('click', () => setReportEye(eye));
      const heroToggle = document.getElementById('heroEyeToggle' + eye);
      if (heroToggle) heroToggle.addEventListener('click', () => setHeroEye(eye));
    });
    refreshReportEyeButtons();

    const gradcamCard = document.getElementById('gradcamCard');
    if (gradcamCard){
      const goToReport = () => {
        document.querySelectorAll('.report-modal:not([hidden])').forEach(closeModal);
        const target = document.getElementById('report-generation');
        const slider = document.getElementById('reportCompareSlider');
        target?.scrollIntoView({behavior:'smooth', block:'start'});
        window.setTimeout(() => slider?.focus({preventScroll:true}), 450);
      };
      gradcamCard.addEventListener('click', goToReport);
      gradcamCard.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); goToReport(); }
      });
    }

    const reportGenerationCard = document.getElementById('reportGenerationCard');
    if (reportGenerationCard){
      const openGeneratedReport = () => openModal('reportPreviewModal');
      reportGenerationCard.addEventListener('click', openGeneratedReport);
      reportGenerationCard.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); openGeneratedReport(); }
      });
    }

    const lesionCard = document.getElementById('lesionCard');
    if (lesionCard){
      const openLesionDetails = () => openModal('lesionModal');
      lesionCard.addEventListener('click', openLesionDetails);
      lesionCard.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); openLesionDetails(); }
      });
    }

    function openModal(id){
      const modal = document.getElementById(id);
      if (!modal) return;
      modal.hidden = false;
      document.body.classList.add('modal-open');
      modal.querySelector('[data-modal-close]')?.focus();
    }

    function closeModal(modal){
      if (!modal) return;
      modal.hidden = true;
      if (!document.querySelector('.report-modal:not([hidden])')) document.body.classList.remove('modal-open');
    }

    document.getElementById('sampleReportBtn')?.addEventListener('click', (event) => {
      event.preventDefault();
      openModal('sampleReportModal');
    });
    document.querySelectorAll('[data-modal-close]').forEach((control) => {
      control.addEventListener('click', () => closeModal(control.closest('.report-modal')));
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') document.querySelectorAll('.report-modal:not([hidden])').forEach(closeModal);
    });
    document.getElementById('downloadPreviewBtn')?.addEventListener('click', () => {
      closeModal(document.getElementById('reportPreviewModal'));
      downloadReportPdf();
    });

    const defaultFundusSrc = document.getElementById('mainFundusPhoto').src;
    const defaultReportImgSrc = document.getElementById('reportImg').src;

    resetBtn.addEventListener('click', () => {
      ['L','R'].forEach(eye => {
        delete state[eye];
        delete rawImages[eye];
        document.getElementById('thumbRow'+eye).classList.remove('show');
        document.getElementById('dropzone'+eye).classList.remove('hide');
        document.getElementById('detail'+eye).classList.remove('show');
        document.getElementById('fileInput'+eye).value = '';
        const before = document.getElementById('trySliderBefore'+eye);
        const handle = document.getElementById('trySliderHandle'+eye);
        if (before){ before.style.clipPath = 'inset(0 50% 0 0)'; handle.style.left = '50%'; }
        const heroSlot = document.getElementById('heroSlot'+eye);
        if (heroSlot){
          heroSlot.style.backgroundImage = '';
          heroSlot.classList.remove('filled');
        }
        const heroCaption = document.getElementById('heroCaption'+eye);
        if (heroCaption) heroCaption.textContent = eye === 'L' ? 'Left eye' : 'Right eye';
      });
      trySection?.classList.add('upload-section-pending');
      tryPanel?.classList.add('upload-panel-pending');
      selectedReportEye = null;
      selectedTryEye = null;
      document.getElementById('tryEyeSwitch').hidden = true;
      refreshReportEyeButtons();
      document.getElementById('reportImg').src = defaultReportImgSrc;
      document.getElementById('reportHeatmapSample').style.display = '';
      document.getElementById('reportHeatmapCanvas').style.display = 'none';
      document.getElementById('gradcamNum').textContent = '—';
      document.getElementById('downloadReportBtn').disabled = true;
      document.getElementById('mainFundusPhoto').src = defaultFundusSrc;
      document.getElementById('qualitySub').textContent = 'Focus, illumination and field of view scored automatically';
      document.getElementById('lesionSub').textContent = 'Awaiting scan — run screening to localise lesions';
      document.getElementById('reportSub').textContent = 'Upload and run a scan to generate a report';
      runBtn.disabled = true;
      runBtn.classList.remove('running');
      runBtn.querySelector('.run-btn-label').textContent = 'Run screening';
      updateCombined();
      document.getElementById('try-it').scrollIntoView({behavior:'smooth', block:'start'});
    });
  })();

  // ---------- Reduced motion check ----------
  const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const IS_COARSE = window.matchMedia('(pointer: coarse)').matches;

  // ---------- Scroll reveal (IntersectionObserver, staggered) ----------
  (function(){
    const targets = document.querySelectorAll('[data-reveal], [data-reveal-group]');
    if (REDUCE_MOTION){ targets.forEach(t=>t.classList.add('in-view')); return; }
    const io = new IntersectionObserver((entries)=>{
      entries.forEach(entry=>{
        if (entry.isIntersecting){
          entry.target.classList.add('in-view');
          if (entry.target.hasAttribute('data-reveal-group')){
            Array.from(entry.target.children).forEach((child,i)=>{
              child.style.transitionDelay = (i*70)+'ms';
            });
          }
          io.unobserve(entry.target);
        }
      });
    }, {threshold:.18, rootMargin:'0px 0px -60px 0px'});
    targets.forEach(t=>io.observe(t));
  })();

  // ---------- Animated impact counters ----------
  (function(){
    const nums = document.querySelectorAll('[data-count]');
    const io = new IntersectionObserver((entries)=>{
      entries.forEach(entry=>{
        if (entry.isIntersecting){
          const el = entry.target;
          const to = parseFloat(el.dataset.count);
          const suffix = el.dataset.suffix || '';
          animateNumber(el, to, 0, suffix, 1100);
          io.unobserve(el);
        }
      });
    }, {threshold:.5});
    nums.forEach(n=>io.observe(n));
  })();

  // ---------- 3D tilt on cards ----------
  (function(){
    if (IS_COARSE) return;
    document.querySelectorAll('.tilt-card').forEach(card=>{
      const max = 7;
      card.addEventListener('mousemove', (e)=>{
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        const rx = (0.5 - py) * max*2;
        const ry = (px - 0.5) * max*2;
        card.style.transform = REDUCE_MOTION ? '' : `perspective(700px) rotateX(${rx}deg) rotateY(${ry}deg) translateZ(6px)`;
        card.style.setProperty('--gx', (px*100)+'%');
        card.style.setProperty('--gy', (py*100)+'%');
      });
      card.addEventListener('mouseleave', ()=>{
        card.style.transform = 'perspective(700px) rotateX(0) rotateY(0) translateZ(0)';
      });
    });
  })();

  // ---------- Cursor-follow ambient glow ----------
  (function(){
    const glow = document.getElementById('cursorGlow');
    if (!glow || IS_COARSE || REDUCE_MOTION) return;
    let mx = window.innerWidth/2, my = window.innerHeight*0.3, gx = mx, gy = my;
    window.addEventListener('mousemove', (e)=>{ mx = e.clientX; my = e.clientY; });
    function loop(){
      gx += (mx-gx)*0.08; gy += (my-gy)*0.08;
      glow.style.transform = `translate(${gx}px, ${gy}px) translate(-50%,-50%)`;
      requestAnimationFrame(loop);
    }
    loop();
  })();

  // ---------- Parallax background blobs ----------
  (function(){
    if (REDUCE_MOTION) return;
    const blobs = document.querySelectorAll('.blob');
    let sy = 0;
    window.addEventListener('scroll', ()=>{ sy = window.scrollY; }, {passive:true});
    function loop(){
      blobs.forEach((b,i)=>{
        const factor = 0.04 + i*0.02;
        b.style.transform = `translateY(${sy*factor}px)`;
      });
      requestAnimationFrame(loop);
    }
    loop();
  })();

  // ---------- Clinician comments (report card) ----------
  (function(){
    const list = document.getElementById('commentList');
    const empty = document.getElementById('commentEmpty');
    const input = document.getElementById('commentInput');
    const addBtn = document.getElementById('addCommentBtn');
    if (!list || !input || !addBtn) return;

    function addComment(){
      const text = input.value.trim();
      if (!text) return;
      if (empty) empty.remove();

      const item = document.createElement('div');
      item.className = 'comment-item';
      const now = new Date();
      const time = now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      const nameEl = document.createElement('div');
      nameEl.className = 'comment-meta';
      nameEl.innerHTML = `<span>Reviewing ophthalmologist</span><span>${time}</span>`;
      const textEl = document.createElement('div');
      textEl.className = 'comment-text';
      textEl.textContent = text;
      item.appendChild(nameEl);
      item.appendChild(textEl);
      list.appendChild(item);

      input.value = '';
      input.focus();
    }

    addBtn.addEventListener('click', addComment);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey){
        e.preventDefault();
        addComment();
      }
    });
  })();

  // ---------- Before/after compare slider (Grad-CAM, report card) ----------
  (function(){
    const wrap = document.getElementById('reportCompareSlider');
    const before = document.getElementById('reportCompareBefore');
    const handle = document.getElementById('reportCompareHandle');
    if (!wrap) return;
    let dragging = false;

    function setPos(px){
      const r = wrap.getBoundingClientRect();
      let pct = ((px - r.left) / r.width) * 100;
      pct = Math.max(4, Math.min(96, pct));
      before.style.clipPath = `inset(0 ${100-pct}% 0 0)`;
      handle.style.left = pct + '%';
    }
    wrap.addEventListener('pointerdown', (e)=>{ dragging = true; setPos(e.clientX); wrap.setPointerCapture(e.pointerId); });
    wrap.addEventListener('pointermove', (e)=>{ if(dragging) setPos(e.clientX); });
    wrap.addEventListener('pointerup', ()=>{ dragging = false; });
    wrap.addEventListener('pointerleave', ()=>{ dragging = false; });

    // gentle auto-sweep once on load to hint interactivity, then settle at 50%
    if (!REDUCE_MOTION){
      const io = new IntersectionObserver((entries)=>{
        entries.forEach(entry=>{
          if (entry.isIntersecting){
            let p = 4;
            const sweep = setInterval(()=>{
              p += 2;
              before.style.clipPath = `inset(0 ${100-p}% 0 0)`;
              handle.style.left = p + '%';
              if (p >= 50){ clearInterval(sweep); }
            }, 12);
            io.unobserve(wrap);
          }
        });
      }, {threshold:.6});
      io.observe(wrap);
    }
  })();

  // ---------- Retina scan frame: CSS 3D tilt (no WebGL, fully controlled) ----------
  (function(){
    const frame = document.getElementById('scanFrame');
    if (!frame || IS_COARSE) return;
    const max = 16;
    frame.addEventListener('mousemove', (e)=>{
      if (REDUCE_MOTION) return;
      const r = frame.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      const rx = (0.5 - py) * max;
      const ry = (px - 0.5) * max;
      frame.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateZ(10px)`;
    });
    frame.addEventListener('mouseleave', ()=>{
      frame.style.transform = 'perspective(900px) rotateX(6deg) rotateY(-9deg) translateZ(0)';
    });
    frame.style.transform = 'perspective(900px) rotateX(6deg) rotateY(-9deg) translateZ(0)';
  })();
