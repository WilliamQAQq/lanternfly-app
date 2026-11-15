(() => {
  'use strict';

  const GEMINI_MODEL = 'gemini-3.8-flash';
  const GEMINI_TIMEOUT_MS = 30000;
  const SUPABASE_TIMEOUT_MS = 15000;
  const ASSET_TIMEOUT_MS = 20000;
  const YOLO_MODEL_URL = 'models/best.onnx';
  const YOLO_INPUT = 640;
  const YOLO_CONF = 0.7;
  const YOLO_CLASSES = [
    'Adult Spotted Lanternfly',
    'Early Nymph Spotted Lanternfly',
    'Late Nymph Spotted Lanternfly'
  ];
  const YOLO_STAGE_TO_Q1 = {
    'Adult Spotted Lanternfly': 'Adult',
    'Early Nymph Spotted Lanternfly': 'Nymph',
    'Late Nymph Spotted Lanternfly': 'Nymph'
  };
  const AI_STAGE_TO_Q1 = { Adult: 'Adult', Nymph: 'Nymph', 'Egg mass': 'Egg mass' };
  const ALLOWED_STAGES = new Set(['Adult', 'Nymph', 'Egg mass', 'Not sure']);
  const ALLOWED_COUNTS = new Set(['1', '2-10', '10+']);
  const ALLOWED_ACTIONS = new Set(['Killed it', 'Photo only', 'Just watched']);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const DB_COLUMNS = [
    'client_id',
    'stage',
    'count',
    'action',
    'lat',
    'lng',
    'place',
    'ai_is_lanternfly',
    'ai_stage',
    'ai_confidence',
    'ai_note'
  ];

  const SUPABASE_URL = 'https://jhftlemkgeocnhnvbafz.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_KMKic67K9tx7TGTPmhHXyg_D7dn6CIq';
  const GEMINI_KEY_STORAGE = 'gemini_key';
  const LOCAL_REPORTS_KEY = 'lantern_reports';
  const FAILED_REPORTS_KEY = 'lantern_reports_failed';
  const MAX_PENDING_QUEUE = 500;
  const MAX_FAILED_QUEUE = 20;

  const CDN_ASSETS = {
    supabaseJs: {
      url: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js',
      integrity: 'sha384-uteMfOloLDGt042uDz+xHGF3ym63/WQ6rFq7murQRG8Ih7QrXGEGNtWd8688sb4O'
    },
    leafletCss: {
      url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
      integrity: 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H'
    },
    leafletJs: {
      url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
      integrity: 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH'
    },
    ortJs: {
      url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js',
      integrity: 'sha384-RPL/K8tc0JVaNWsunkEmCzLeieefvFX2UCRLKLmLVChCI6P+CTKhzqF7VIeCc3Zp'
    },
    ortWasmMjs: {
      url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.mjs',
      integrity: 'sha384-SyfqCcawqO3udRV2twBwYuuR4Wh7Nj/yfAxyfN6UltDOh5VTrJH4aT9HfEvthS02'
    },
    ortWasmBin: {
      url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.wasm',
      integrity: 'sha384-t24pimTffN4djMKJaYLDupLzilNBHTgwqbjacQNJObCC4RrMH4UjfZgDkwHEU04k'
    }
  };

  function clampPercent(v) {
    return Math.max(0, Math.min(100, Math.round(parseFloat(v) || 0)));
  }

  function decodeYoloBoxes(preds, channels, numPreds, confThr, scale, dx, dy, imgW, imgH) {
    const numClasses = channels - 4;
    const boxes = [];
    for (let i = 0; i < numPreds; i++) {
      let cls = 0, conf = -1;
      for (let c = 0; c < numClasses; c++) {
        const score = preds[(4 + c) * numPreds + i];
        if (score > conf) { conf = score; cls = c; }
      }
      if (conf < confThr) continue;
      const cx = (preds[0 * numPreds + i] - dx) / scale;
      const cy = (preds[1 * numPreds + i] - dy) / scale;
      const bw = preds[2 * numPreds + i] / scale;
      const bh = preds[3 * numPreds + i] / scale;
      const x1 = Math.max(0, cx - bw / 2);
      const y1 = Math.max(0, cy - bh / 2);
      const x2 = Math.min(imgW, cx + bw / 2);
      const y2 = Math.min(imgH, cy + bh / 2);
      const w = x2 - x1;
      const h = y2 - y1;
      if (w > 0 && h > 0) boxes.push({ x: x1, y: y1, w, h, conf, cls });
    }
    return boxes;
  }

  /**
   * Class-agnostic Non-Maximum Suppression (NMS).
   * Intentional design: a single nymph frequently activates both "Early Nymph" and
   * "Late Nymph" classes on overlapping anchors. Suppressing across classes keeps
   * only the highest-confidence box per physical insect instead of double-counting.
   */
  function nms(boxes, iouThr = 0.45) {
    const sorted = [...boxes].sort((a, b) => b.conf - a.conf);
    const keep = [];
    while (sorted.length) {
      const a = sorted.shift();
      keep.push(a);
      for (let i = sorted.length - 1; i >= 0; i--) {
        const b = sorted[i];
        const ix = Math.max(a.x, b.x), iy = Math.max(a.y, b.y);
        const iw = Math.min(a.x + a.w, b.x + b.w) - ix;
        const ih = Math.min(a.y + a.h, b.y + b.h) - iy;
        if (iw <= 0 || ih <= 0) continue;
        const inter = iw * ih;
        const uni = a.w * a.h + b.w * b.h - inter;
        if (uni > 0 && inter / uni > iouThr) sorted.splice(i, 1);
      }
    }
    return keep;
  }

  function buildAiPayload(ai, yolo, confThr = YOLO_CONF) {
    if (!ai && !yolo) return {};
    const confPct = Math.round(confThr * 100);
    if (ai && !yolo) {
      return {
        ai_is_lanternfly: Boolean(ai.is_lanternfly),
        ai_stage: ai.stage ? String(ai.stage).slice(0, 64) : null,
        ai_confidence: clampPercent(ai.confidence),
        ai_note: ai.note ? String(ai.note).slice(0, 500) : null
      };
    }
    if (!ai && yolo) {
      const conf = clampPercent(yolo.confidence * 100);
      return {
        ai_is_lanternfly: Boolean(yolo.is_lanternfly),
        ai_stage: yolo.stage || (yolo.is_lanternfly ? 'lanternfly x' + yolo.count : 'No adult/nymph detected'),
        ai_confidence: conf,
        ai_note: `YOLO nano browser (Roboflow-trained): ${yolo.count ? yolo.count + ' box(es)' : '0 boxes >= ' + confPct + '%'}`
      };
    }
    const yoloConf = clampPercent(yolo.confidence * 100);
    const gemConf = clampPercent(ai.confidence);
    const isLanternfly = Boolean(yolo.is_lanternfly || ai.is_lanternfly);
    const stage = yolo.is_lanternfly ? (yolo.stage || ai.stage || null) : (ai.stage || null);
    const confidence = yolo.is_lanternfly
      ? (ai.is_lanternfly ? Math.max(yoloConf, gemConf) : yoloConf)
      : gemConf;
    const yoloSummary = yolo.is_lanternfly
      ? `${yolo.stage} (${yoloConf}%, ${yolo.count} box)`
      : `none >= ${confPct}%`;
    const gemSummary = `${ai.is_lanternfly ? 'yes' : 'no'} (${ai.stage || '?'}, ${gemConf}%)`;
    const combinedNote = `YOLO: ${yoloSummary} | Gemini: ${gemSummary}${ai.note ? ' — ' + ai.note : ''}`;
    return {
      ai_is_lanternfly: isLanternfly,
      ai_stage: stage ? String(stage).slice(0, 64) : null,
      ai_confidence: confidence,
      ai_note: combinedNote.slice(0, 500)
    };
  }

  function normalizeCoordinate(val, min, max) {
    if (val === null || val === undefined || val === '') return null;
    const num = Number(val);
    if (!Number.isFinite(num) || num < min || num > max) {
      throw new Error('Invalid GPS coordinate.');
    }
    return num.toFixed(6);
  }

  function generateClientId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    throw new Error('Secure random UUID generator is unavailable.');
  }

  function validateReportPayload(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('Invalid report payload.');
    }
    const stage = String(raw.stage || '');
    const count = String(raw.count || '');
    const action = String(raw.action || '');
    if (!ALLOWED_STAGES.has(stage)) throw new Error('Invalid life stage selection.');
    if (!ALLOWED_COUNTS.has(count)) throw new Error('Invalid count selection.');
    if (!ALLOWED_ACTIONS.has(action)) throw new Error('Invalid action selection.');

    const lat = normalizeCoordinate(raw.lat, -90, 90);
    const lng = normalizeCoordinate(raw.lng, -180, 180);
    const placeClean = typeof raw.place === 'string' ? raw.place.trim().slice(0, 200) : '';
    const out = {
      stage,
      count,
      action,
      lat: lat && lng ? lat : null,
      lng: lat && lng ? lng : null,
      place: placeClean || null
    };
    if (raw.client_id !== undefined && raw.client_id !== null && raw.client_id !== '') {
      const cid = String(raw.client_id).trim().toLowerCase();
      if (!UUID_RE.test(cid)) throw new Error('Invalid client report ID.');
      out.client_id = cid;
    }
    if (typeof raw.ai_is_lanternfly === 'boolean') {
      out.ai_is_lanternfly = raw.ai_is_lanternfly;
      out.ai_stage = raw.ai_stage ? String(raw.ai_stage).slice(0, 64) : null;
      out.ai_confidence = clampPercent(raw.ai_confidence);
      out.ai_note = raw.ai_note ? String(raw.ai_note).slice(0, 500) : null;
    }
    return out;
  }

  function extractDbColumns(entry) {
    const row = {};
    for (const col of DB_COLUMNS) {
      if (entry[col] !== undefined) row[col] = entry[col];
    }
    return validateReportPayload(row);
  }

  function getReportQueueKey(entry, fallbackIdx = 0) {
    if (!entry || typeof entry !== 'object') return `invalid-${fallbackIdx}`;
    if (typeof entry.client_id === 'string' && entry.client_id) return entry.client_id.toLowerCase();
    if (entry._qid !== undefined && entry._qid !== null && entry._qid !== '') return String(entry._qid);
    if (entry.id !== undefined && entry.id !== null) return `legacy-${entry.id}`;
    return `idx-${fallbackIdx}-${entry.created_at || ''}`;
  }

  function reconcileQueue(latestQueue, syncedKeys, failedErrorsByKey) {
    const syncedSet = syncedKeys instanceof Set ? syncedKeys : new Set(syncedKeys || []);
    const failedMap = failedErrorsByKey instanceof Map
      ? failedErrorsByKey
      : new Map(Object.entries(failedErrorsByKey || {}));
    const pending = [];
    const newlyFailed = [];
    latestQueue.forEach((item, idx) => {
      if (!item || typeof item !== 'object' || item.synced === true) return;
      const key = getReportQueueKey(item, idx);
      if (syncedSet.has(key)) return;
      if (failedMap.has(key)) {
        newlyFailed.push({
          ...item,
          failed: true,
          failed_at: new Date().toISOString(),
          last_error: failedMap.get(key)
        });
        return;
      }
      if (item.failed === true) {
        newlyFailed.push(item);
        return;
      }
      pending.push(item);
    });
    return { pending, newlyFailed };
  }

  function classifyCloudError(error, hasClientId = false) {
    if (!error) return 'inserted';
    const code = String(error.code || '');
    const msg = String(error.message || '').toLowerCase();
    if (hasClientId && ((code === 'PGRST204' && msg.includes('client_id')) || (code === '42703' && msg.includes('client_id')))) {
      return 'retry_without_client_id';
    }
    if (hasClientId && code === '23505') {
      return 'already_synced';
    }
    // Permanent row-level validation/constraint errors (CHECK, NOT NULL, truncation, bad scalar syntax)
    if (code === '23514' || code === '23502' || code.startsWith('22') || code === 'PGRST102') {
      return 'permanent';
    }
    return 'transient';
  }

  function createTimeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return { signal: AbortSignal.timeout(ms), cleanup: () => {} };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), ms);
    return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
  }

  function createTimedFetch(ms = SUPABASE_TIMEOUT_MS, baseFetch = globalThis.fetch) {
    return async (input, init) => {
      const opts = init || {};
      const { signal: timeoutSignal, cleanup } = createTimeoutSignal(ms);
      let combinedSignal = timeoutSignal;
      const callerSignal = opts.signal || (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
      let onCallerAbort = null;
      let onTimeoutAbort = null;
      if (callerSignal) {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
          combinedSignal = AbortSignal.any([callerSignal, timeoutSignal]);
        } else {
          const controller = new AbortController();
          if (callerSignal.aborted) {
            controller.abort(callerSignal.reason);
          } else if (timeoutSignal.aborted) {
            controller.abort(timeoutSignal.reason);
          } else {
            onCallerAbort = () => controller.abort(callerSignal.reason);
            onTimeoutAbort = () => controller.abort(timeoutSignal.reason);
            callerSignal.addEventListener('abort', onCallerAbort, { once: true });
            timeoutSignal.addEventListener('abort', onTimeoutAbort, { once: true });
          }
          combinedSignal = controller.signal;
        }
      }
      try {
        return await baseFetch(input, { ...opts, signal: combinedSignal });
      } finally {
        if (onCallerAbort && callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
        if (onTimeoutAbort) timeoutSignal.removeEventListener('abort', onTimeoutAbort);
        cleanup();
      }
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      YOLO_CONF,
      YOLO_CLASSES,
      clampPercent,
      decodeYoloBoxes,
      nms,
      buildAiPayload,
      generateClientId,
      validateReportPayload,
      extractDbColumns,
      getReportQueueKey,
      reconcileQueue,
      classifyCloudError,
      createTimedFetch
    };
  }

  if (typeof document === 'undefined') return;

  let gps = null;
  let gpsSeq = 0;
  let map = null, marker = null;
  let photoURL = null;
  let photoSeq = 0;
  let aiVerdict = null;   // {is_lanternfly, stage, confidence, note}
  let yoloVerdict = null; // {is_lanternfly, confidence, stage, count}
  let yoloSession = null;
  let yoloSessionPromise = null;
  let useCloud = false, sb = null, supportsClientId = true;
  let initDbPromise = null, flushPromise = null;

  const assetPromises = new Map();
  const form = document.getElementById('form');
  const locStatus = document.getElementById('locStatus');
  const gpsBtn = document.getElementById('gpsBtn');
  const clearGpsBtn = document.getElementById('clearGps');
  const mapEl = document.getElementById('map');
  const placeInput = document.getElementById('place');
  const photoInput = document.getElementById('photo');
  const previewImg = document.getElementById('preview');
  const yoloCanvas = document.getElementById('yoloCanvas');
  const clearPhotoBtn = document.getElementById('clearPhotoBtn');
  const yoloBtn = document.getElementById('yoloBtn');
  const yoloStatus = document.getElementById('yoloStatus');
  const geminiKeyInput = document.getElementById('geminiKey');
  const toggleKeyBtn = document.getElementById('toggleKeyBtn');
  const aiBtn = document.getElementById('aiBtn');
  const aiStatus = document.getElementById('aiStatus');
  const submitBtn = form.querySelector('button[type="submit"]');
  const msgBox = document.getElementById('msg');
  const dbStatusEl = document.getElementById('dbStatus');

  const safeStorage = {
    get(key, fallback = '') {
      try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    }
  };

  function setMsg(text, type) {
    msgBox.textContent = text;
    msgBox.className = 'msg-box msg-' + type;
  }

  function setDbStatus(txt) {
    if (dbStatusEl) dbStatusEl.textContent = txt;
  }

  function setButtonBusy(btn, busy, busyLabel) {
    if (busy) {
      if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      if (busyLabel) btn.textContent = busyLabel;
    } else {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      if (btn.dataset.idleLabel) btn.textContent = btn.dataset.idleLabel;
    }
  }

  function renderStatus(el, lines) {
    el.textContent = '';
    lines.forEach((line, idx) => {
      if (idx > 0) el.appendChild(document.createElement('br'));
      if (line.muted) {
        const span = document.createElement('span');
        span.className = 'muted';
        span.textContent = line.text;
        el.appendChild(span);
        return;
      }
      if (line.prefix) el.append(line.prefix);
      if (line.bold) {
        const b = document.createElement('b');
        b.textContent = line.bold;
        el.appendChild(b);
      }
      if (line.suffix) el.append(line.suffix);
    });
  }

  function appendHeadAsset(key, buildElement, resolveValue, label, timeoutMs = ASSET_TIMEOUT_MS) {
    if (assetPromises.has(key)) return assetPromises.get(key);
    const p = new Promise((resolve, reject) => {
      const el = buildElement();
      el.crossOrigin = 'anonymous';
      el.referrerPolicy = 'no-referrer';
      let settled = false;
      const fail = reason => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        assetPromises.delete(key);
        el.remove();
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail(`Timed out loading ${label}: ${key}`), timeoutMs);
      el.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(resolveValue());
      };
      el.onerror = () => fail(`Failed to load ${label}: ${key}`);
      document.head.appendChild(el);
    });
    assetPromises.set(key, p);
    return p;
  }

  function loadStylesheet(href, integrity) {
    return appendHeadAsset(
      href,
      () => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.integrity = integrity;
        return link;
      },
      () => undefined,
      'stylesheet'
    );
  }

  function loadScript(src, integrity, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    return appendHeadAsset(
      src,
      () => {
        const s = document.createElement('script');
        s.src = src;
        s.integrity = integrity;
        return s;
      },
      () => (globalName ? window[globalName] : undefined),
      'script'
    );
  }

  async function fetchVerifiedSubresource(url, integrity) {
    const { signal, cleanup } = createTimeoutSignal(ASSET_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        integrity,
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch subresource (${res.status}): ${url}`);
      }
      return await res.arrayBuffer();
    } finally {
      cleanup();
    }
  }

  // ===== Validation helpers (required radio groups) =====
  const REQUIRED_GROUPS = ['stage', 'count', 'action'];

  function setGroupValidity(name, valid) {
    const fs = document.getElementById('fs-' + name);
    const errId = 'err-' + name;
    const radios = fs.querySelectorAll('input[type="radio"]');
    fs.classList.toggle('is-invalid', !valid);
    radios.forEach(r => {
      r.setAttribute('aria-invalid', valid ? 'false' : 'true');
      if (valid) r.removeAttribute('aria-describedby');
      else r.setAttribute('aria-describedby', errId);
    });
  }

  function autoSelectStage(stageValue) {
    if (!stageValue) return false;
    const radios = document.querySelectorAll('input[name="stage"]');
    for (const radio of radios) {
      if (radio.value === stageValue) {
        radio.checked = true;
        setGroupValidity('stage', true);
        return true;
      }
    }
    return false;
  }

  REQUIRED_GROUPS.forEach(name => {
    setGroupValidity(name, true);
    document.getElementById('fs-' + name).addEventListener('change', () => setGroupValidity(name, true));
  });

  // ===== GPS & Leaflet map (lazy-loaded with SRI on capture) =====
  function ensureLeaflet() {
    return Promise.all([
      loadStylesheet(CDN_ASSETS.leafletCss.url, CDN_ASSETS.leafletCss.integrity),
      loadScript(CDN_ASSETS.leafletJs.url, CDN_ASSETS.leafletJs.integrity, 'L')
    ]);
  }

  gpsBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      locStatus.textContent = 'GPS not supported on this device.';
      return;
    }
    const seq = ++gpsSeq;
    setButtonBusy(gpsBtn, true, '📍 Getting GPS…');
    locStatus.textContent = 'Getting GPS… allow location access…';
    navigator.geolocation.getCurrentPosition(async pos => {
      setButtonBusy(gpsBtn, false);
      if (seq !== gpsSeq) return;
      gps = {
        lat: pos.coords.latitude.toFixed(6),
        lng: pos.coords.longitude.toFixed(6),
        acc: Math.round(pos.coords.accuracy)
      };
      clearGpsBtn.hidden = false;
      locStatus.textContent = `✅ GPS captured (±${gps.acc}m) — coordinates kept private, only shared with researchers.`;
      await showMap();
    }, err => {
      setButtonBusy(gpsBtn, false);
      if (seq !== gpsSeq) return;
      locStatus.textContent = 'GPS blocked/failed: ' + err.message + ' — you can still type a place name.';
    }, { enableHighAccuracy: true, timeout: 10000 });
  });

  function clearGpsState(restoreFocus = false) {
    gpsSeq++;
    gps = null;
    if (marker) { marker.remove(); marker = null; }
    mapEl.style.display = 'none';
    clearGpsBtn.hidden = true;
    locStatus.textContent = 'No GPS yet — you can still submit with a place name below.';
    if (restoreFocus) gpsBtn.focus();
  }
  clearGpsBtn.addEventListener('click', () => clearGpsState(true));

  async function showMap() {
    try {
      await ensureLeaflet();
      if (!gps || !window.L) return;
      mapEl.style.display = 'block';
      if (!map) {
        map = L.map('map').setView([gps.lat, gps.lng], 14);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      } else {
        map.setView([gps.lat, gps.lng], 14);
      }
      if (marker) marker.remove();
      marker = L.marker([gps.lat, gps.lng]).addTo(map).bindPopup('Lanternfly here').openPopup();
      requestAnimationFrame(() => map?.invalidateSize());
    } catch {
      mapEl.style.display = 'none';
      if (gps) locStatus.textContent = `✅ GPS captured (±${gps.acc}m) — map preview unavailable offline.`;
    }
  }

  // ===== Image decoding & photo state =====
  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) resolve(img);
        else reject(new Error('Image has empty dimensions.'));
      };
      img.onerror = () => reject(new Error('Could not decode selected image.'));
      img.src = src;
    });
  }

  async function getActivePhotoImage(file) {
    if (photoURL && previewImg.complete && previewImg.naturalWidth > 0) return previewImg;
    const tmpUrl = URL.createObjectURL(file);
    try {
      return await loadImageElement(tmpUrl);
    } finally {
      URL.revokeObjectURL(tmpUrl);
    }
  }

  function clearPhotoState(resetInput = false, restoreFocus = false) {
    photoSeq++;
    if (photoURL) { URL.revokeObjectURL(photoURL); photoURL = null; }
    if (resetInput) photoInput.value = '';
    previewImg.onload = null;
    previewImg.onerror = null;
    previewImg.removeAttribute('src');
    previewImg.style.display = 'none';
    yoloCanvas.style.display = 'none';
    clearPhotoBtn.hidden = true;
    aiVerdict = null;
    yoloVerdict = null;
    yoloStatus.textContent = 'No detection yet.';
    aiStatus.textContent = 'No AI check yet.';
    if (restoreFocus) photoInput.focus();
  }

  photoInput.addEventListener('change', e => {
    const f = e.target.files[0];
    clearPhotoState(false);
    if (!f) return;
    if (f.type && !f.type.startsWith('image/')) {
      clearPhotoState(true);
      yoloStatus.textContent = '⚠️ Please choose an image file (JPG, PNG, WebP).';
      return;
    }
    photoURL = URL.createObjectURL(f);
    previewImg.onload = () => {
      yoloCanvas.width = previewImg.naturalWidth;
      yoloCanvas.height = previewImg.naturalHeight;
    };
    previewImg.onerror = () => {
      clearPhotoState(true);
      yoloStatus.textContent = '⚠️ Could not preview this image format in your browser (try JPG, PNG, or WebP).';
    };
    previewImg.src = photoURL;
    previewImg.style.display = 'block';
    clearPhotoBtn.hidden = false;
    yoloStatus.textContent = 'Photo ready — press 🔎 Detect lanternflies (adults & nymphs).';
    aiStatus.textContent = 'Photo ready — press 🤖 Identify photo for AI check (optional).';
  });

  clearPhotoBtn.addEventListener('click', () => clearPhotoState(true, true));

  // ===== Gemini key storage & unmask toggle =====
  geminiKeyInput.value = safeStorage.get(GEMINI_KEY_STORAGE);
  const saveGeminiKey = () => safeStorage.set(GEMINI_KEY_STORAGE, geminiKeyInput.value.trim());
  geminiKeyInput.addEventListener('input', saveGeminiKey);
  geminiKeyInput.addEventListener('change', saveGeminiKey);

  toggleKeyBtn.addEventListener('click', () => {
    const shown = geminiKeyInput.type === 'text';
    geminiKeyInput.type = shown ? 'password' : 'text';
    toggleKeyBtn.textContent = shown ? 'Show' : 'Hide';
    toggleKeyBtn.setAttribute('aria-pressed', String(!shown));
    toggleKeyBtn.setAttribute('aria-label', shown ? 'Show Gemini API key' : 'Hide Gemini API key');
  });

  // ===== AI identify (Gemini Vision REST API) =====
  async function downscaleToJpeg(file, maxSide = 768, quality = 0.8) {
    const img = await getActivePhotoImage(file);
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const s = Math.min(1, maxSide / Math.max(iw, ih));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(iw * s));
    c.height = Math.max(1, Math.round(ih * s));
    try {
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', quality).split(',')[1];
    } finally {
      c.width = 0;
      c.height = 0;
    }
  }

  aiBtn.addEventListener('click', async () => {
    const key = geminiKeyInput.value.trim() || safeStorage.get(GEMINI_KEY_STORAGE).trim();
    const file = photoInput.files[0];
    if (!file) { aiStatus.textContent = '⚠️ Choose a photo first.'; return; }
    if (!key) { aiStatus.textContent = '⚠️ Paste your free Gemini API key first (aistudio.google.com/apikey).'; geminiKeyInput.focus(); return; }
    const seq = photoSeq;
    setButtonBusy(aiBtn, true, '🤖 Identifying…');
    aiStatus.textContent = '🤖 AI is looking… (sending to Gemini, ~5s)';
    const { signal, cleanup } = createTimeoutSignal(GEMINI_TIMEOUT_MS);
    try {
      const b64 = await downscaleToJpeg(file);
      if (seq !== photoSeq) return;
      const prompt = 'You are an entomology assistant. Is the insect or egg mass in this photo a spotted lanternfly (Lycorma delicatula)? Respond with JSON matching the schema: is_lanternfly (boolean), stage ("Adult" | "Nymph" | "Egg mass" | "Not a lanternfly"), confidence (integer 0-100), and note (one short sentence).';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key
        },
        signal,
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType: 'image/jpeg', data: b64 } }
            ]
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: {
              type: 'object',
              properties: {
                is_lanternfly: { type: 'boolean' },
                stage: { type: 'string', enum: ['Adult', 'Nymph', 'Egg mass', 'Not a lanternfly'] },
                confidence: { type: 'integer', minimum: 0, maximum: 100 },
                note: { type: 'string' }
              },
              required: ['is_lanternfly', 'stage', 'confidence', 'note'],
              additionalProperties: false
            },
            thinkingConfig: { thinkingLevel: 'LOW' }
          }
        })
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error('Gemini HTTP ' + res.status + ': ' + t.slice(0, 160));
      }
      const j = await res.json();
      if (seq !== photoSeq) return;
      const candidate = j.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const txt = parts.filter(p => !p.thought && p.text).map(p => p.text).join('')
        .replace(/^```json\s*|```$/g, '').trim();
      if (!txt) {
        throw new Error('Empty response from Gemini (' + (candidate?.finishReason || 'unknown') + ')');
      }
      const parsed = JSON.parse(txt);
      aiVerdict = {
        is_lanternfly: Boolean(parsed.is_lanternfly),
        stage: typeof parsed.stage === 'string' ? parsed.stage : '',
        confidence: clampPercent(parsed.confidence),
        note: typeof parsed.note === 'string' ? parsed.note : ''
      };
      const statusLines = [{
        prefix: aiVerdict.is_lanternfly ? '✅ ' : '❌ ',
        bold: aiVerdict.is_lanternfly ? 'Likely a lanternfly' : 'Does not look like a lanternfly',
        suffix: ` — ${aiVerdict.stage || '?'} (${aiVerdict.confidence}%)`
      }];
      if (aiVerdict.note) statusLines.push({ muted: true, text: aiVerdict.note });
      const mapped = aiVerdict.is_lanternfly ? AI_STAGE_TO_Q1[aiVerdict.stage] : null;
      if (mapped && autoSelectStage(mapped)) {
        statusLines.push({
          prefix: '👉 Q1 auto-filled as ',
          bold: mapped,
          suffix: ' — change it if you disagree.'
        });
      }
      renderStatus(aiStatus, statusLines);
    } catch (err) {
      if (seq !== photoSeq) return;
      aiVerdict = null;
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const reason = isTimeout ? 'Gemini request timed out after 30s' : (err?.message || 'Unknown error');
      aiStatus.textContent = '⚠️ AI check failed: ' + reason + ' — you can still submit manually.';
    } finally {
      cleanup();
      setButtonBusy(aiBtn, false);
    }
  });

  // ===== YOLO detector — runs locally in browser (lazy-loaded onnxruntime-web with SRI) =====
  // Model: models/best.onnx — YOLOv8n fine-tuned on 3.4k real annotated lanternfly photos (Roboflow)
  // Classes: 0=Adult, 1=Early Nymph, 2=Late Nymph. Output: [1, 7, 8400] = (cx,cy,w,h, cls0,cls1,cls2)
  async function loadYoloSession() {
    if (yoloSession) return yoloSession;
    if (yoloSessionPromise) return yoloSessionPromise;
    yoloSessionPromise = (async () => {
      const [, mjsBuffer, wasmBuffer] = await Promise.all([
        loadScript(CDN_ASSETS.ortJs.url, CDN_ASSETS.ortJs.integrity, 'ort'),
        fetchVerifiedSubresource(CDN_ASSETS.ortWasmMjs.url, CDN_ASSETS.ortWasmMjs.integrity),
        fetchVerifiedSubresource(CDN_ASSETS.ortWasmBin.url, CDN_ASSETS.ortWasmBin.integrity)
      ]);
      if (!window.ort) throw new Error('onnxruntime-web failed to load (check network / CDN)');
      const mjsBlobUrl = URL.createObjectURL(new Blob([mjsBuffer], { type: 'text/javascript' }));
      const wasmBlobUrl = URL.createObjectURL(new Blob([wasmBuffer], { type: 'application/wasm' }));
      try {
        ort.env.wasm.numThreads = 1;
        // Pass both SRI-verified Blob URLs and omit wasmBinary: ort.min.js only wires
        // Module.locateFile when wasmBinary is unset, otherwise Emscripten crashes calling
        // new URL("ort-wasm-simd-threaded.wasm", import.meta.url) against a blob: base URL.
        delete ort.env.wasm.wasmBinary;
        ort.env.wasm.wasmPaths = { mjs: mjsBlobUrl, wasm: wasmBlobUrl };
        yoloSession = await ort.InferenceSession.create(YOLO_MODEL_URL, { executionProviders: ['wasm'] });
        return yoloSession;
      } finally {
        URL.revokeObjectURL(mjsBlobUrl);
        URL.revokeObjectURL(wasmBlobUrl);
      }
    })();
    try {
      return await yoloSessionPromise;
    } catch (err) {
      yoloSessionPromise = null;
      throw err;
    }
  }

  function letterbox(img, size) {
    const imgW = img.naturalWidth || img.width;
    const imgH = img.naturalHeight || img.height;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const s = Math.min(size / imgW, size / imgH);
    const nw = imgW * s, nh = imgH * s;
    const dx = (size - nw) / 2, dy = (size - nh) / 2;
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, dx, dy, nw, nh);
    return { canvas, scale: s, dx, dy, imgW, imgH };
  }

  async function yoloInfer(img) {
    const session = await loadYoloSession();
    const { canvas, scale, dx, dy, imgW, imgH } = letterbox(img, YOLO_INPUT);
    let data;
    try {
      data = canvas.getContext('2d').getImageData(0, 0, YOLO_INPUT, YOLO_INPUT).data;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
    const plane = YOLO_INPUT * YOLO_INPUT;
    const input = new Float32Array(3 * plane);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      input[p] = data[i] / 255.0;
      input[plane + p] = data[i + 1] / 255.0;
      input[2 * plane + p] = data[i + 2] / 255.0;
    }
    const tensor = new ort.Tensor('float32', input, [1, 3, YOLO_INPUT, YOLO_INPUT]);
    let out;
    try {
      out = await session.run({ images: tensor });
      const output = out.output0;
      const channels = output.dims?.[1] || 7;
      const numPreds = output.dims?.[2] || (output.data.length / channels);
      const boxes = decodeYoloBoxes(output.data, channels, numPreds, YOLO_CONF, scale, dx, dy, imgW, imgH);
      return nms(boxes);
    } finally {
      tensor.dispose?.();
      if (out) Object.values(out).forEach(t => t?.dispose?.());
    }
  }

  function drawBoxes(boxes, img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    yoloCanvas.width = w;
    yoloCanvas.height = h;
    yoloCanvas.style.display = 'block';
    const ctx = yoloCanvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const scale = Math.max(1, Math.round(Math.max(w, h) / 600));
    const lineW = Math.max(3, scale * 3);
    const fontSize = Math.max(14, scale * 16);
    const pad = Math.max(4, scale * 4);
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textBaseline = 'top';

    boxes.forEach(b => {
      ctx.strokeStyle = '#ff3b30';
      ctx.lineWidth = lineW;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      const label = (b.conf * 100).toFixed(0) + '% ' + YOLO_CLASSES[b.cls].replace(' Spotted Lanternfly', '');
      const tw = ctx.measureText(label).width;
      const th = fontSize + pad * 2;
      const tx = Math.max(0, Math.min(b.x, w - tw - pad * 2));
      const ty = b.y > th + 2 ? b.y - th : Math.min(h - th, b.y + 2);
      ctx.fillStyle = 'rgba(255, 59, 48, 0.9)';
      ctx.fillRect(tx, ty, tw + pad * 2, th);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, tx + pad, ty + pad);
    });
    previewImg.style.display = 'none';
  }

  yoloBtn.addEventListener('click', async () => {
    const file = photoInput.files[0];
    if (!file) { yoloStatus.textContent = '⚠️ Choose a photo first.'; return; }
    const seq = photoSeq;
    setButtonBusy(yoloBtn, true, '⏳ Detecting…');
    yoloStatus.textContent = '⏳ Loading YOLO model (first run ~10s) + detecting…';
    try {
      const img = await getActivePhotoImage(file);
      const boxes = await yoloInfer(img);
      if (seq !== photoSeq) return;
      if (!boxes.length) {
        yoloVerdict = { is_lanternfly: false, confidence: 0, stage: null, count: 0 };
        yoloCanvas.style.display = 'none';
        previewImg.style.display = 'block';
        renderStatus(yoloStatus, [{
          prefix: '❌ ',
          bold: 'No adult/nymph lanternfly detected',
          suffix: ` (conf ≥ ${Math.round(YOLO_CONF * 100)}%) — if this is an egg mass or unclear angle, select Q1 manually or try AI check.`
        }]);
        return;
      }
      const best = boxes[0];
      const stage = YOLO_CLASSES[best.cls];
      yoloVerdict = { is_lanternfly: true, confidence: best.conf, stage, count: boxes.length };
      drawBoxes(boxes, img);
      const lines = [
        { prefix: '✅ ', bold: 'Lanternfly detected', suffix: ` — ${stage} (${(best.conf * 100).toFixed(1)}%)` },
        { prefix: `🔢 ${boxes.length} box(es) found. Submit to store the result.` }
      ];
      const q1val = YOLO_STAGE_TO_Q1[stage];
      if (q1val && autoSelectStage(q1val)) {
        lines.push({
          prefix: '👉 Q1 auto-filled as ',
          bold: q1val,
          suffix: ' — change it if you disagree.'
        });
      }
      renderStatus(yoloStatus, lines);
    } catch (err) {
      if (seq !== photoSeq) return;
      yoloVerdict = null;
      yoloStatus.textContent = '⚠️ YOLO check failed: ' + err.message + ' — you can still submit manually.';
    } finally {
      setButtonBusy(yoloBtn, false);
    }
  });

  // ===== Shared cloud DB (Supabase) + offline queue with auto-sync =====
  function readQueue() {
    try {
      const parsed = JSON.parse(safeStorage.get(LOCAL_REPORTS_KEY, '[]'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(item => item && typeof item === 'object' && item.synced !== true && item.failed !== true);
    } catch {
      return [];
    }
  }

  function writeQueue(items) {
    return safeStorage.set(LOCAL_REPORTS_KEY, JSON.stringify(items.slice(0, MAX_PENDING_QUEUE)));
  }

  function appendFailedReports(newlyFailed) {
    if (!newlyFailed.length) return;
    try {
      const existing = JSON.parse(safeStorage.get(FAILED_REPORTS_KEY, '[]'));
      const list = Array.isArray(existing) ? existing : [];
      const combined = [...list, ...newlyFailed].slice(-MAX_FAILED_QUEUE);
      safeStorage.set(FAILED_REPORTS_KEY, JSON.stringify(combined));
    } catch {}
  }

  function enqueueLocalReport(payload) {
    const queue = readQueue();
    if (queue.length >= MAX_PENDING_QUEUE) {
      return { ok: false, reason: 'queue_full' };
    }
    const qid = payload.client_id || generateClientId();
    if (queue.some((item, idx) => getReportQueueKey(item, idx) === qid)) {
      return { ok: true, count: queue.length };
    }
    const next = [...queue, {
      _qid: qid,
      created_at: new Date().toISOString(),
      ...payload
    }];
    if (!writeQueue(next)) {
      return { ok: false, reason: 'storage_error' };
    }
    return { ok: true, count: next.length };
  }

  async function insertReportToCloud(row) {
    if (!sb) throw new Error('Supabase client not initialized.');
    const sendRow = supportsClientId ? row : (() => {
      const { client_id: _ignored, ...rest } = row;
      return rest;
    })();
    // Plain INSERT (not upsert/ON CONFLICT) preserves strict INSERT-only RLS without requiring public SELECT.
    // Idempotent deduplication relies on client_id UUID + UNIQUE index catching retries with SQLSTATE 23505.
    const { error } = await sb.from('lantern_reports').insert([sendRow]);
    if (!error) return { status: 'inserted' };

    const kind = classifyCloudError(error, Boolean(sendRow.client_id));
    if (kind === 'retry_without_client_id') {
      supportsClientId = false;
      const { client_id: _ignored, ...fallbackRow } = row;
      const retry = await sb.from('lantern_reports').insert([fallbackRow]);
      if (!retry.error) return { status: 'inserted' };
      return { status: classifyCloudError(retry.error, false), error: retry.error };
    }
    return { status: kind, error };
  }

  async function flushPendingReports() {
    if (!sb) return { synced: 0, failed: 0, remaining: readQueue().length };
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      let totalSynced = 0;
      let totalFailed = 0;
      let syncedInPass = 0;
      let hitTransient = false;
      do {
        syncedInPass = 0;
        hitTransient = false;
        const batch = readQueue();
        if (!batch.length) break;
        const syncedKeys = new Set();
        const failedErrors = new Map();
        for (let i = 0; i < batch.length; i++) {
          const item = batch[i];
          const key = getReportQueueKey(item, i);
          let row;
          try {
            row = extractDbColumns(item);
          } catch (err) {
            failedErrors.set(key, err?.message || 'Invalid queued report');
            continue;
          }
          try {
            const res = await insertReportToCloud(row);
            if (res.status === 'inserted' || res.status === 'already_synced') {
              syncedKeys.add(key);
              syncedInPass++;
              totalSynced++;
            } else if (res.status === 'permanent') {
              failedErrors.set(key, res.error?.message || res.error?.code || 'Rejected by database');
            } else {
              hitTransient = true;
              break;
            }
          } catch {
            hitTransient = true;
            break;
          }
        }
        if (syncedKeys.size > 0 || failedErrors.size > 0) {
          const { pending, newlyFailed } = reconcileQueue(readQueue(), syncedKeys, failedErrors);
          writeQueue(pending);
          if (newlyFailed.length > 0) {
            totalFailed += newlyFailed.length;
            appendFailedReports(newlyFailed);
          }
        }
      } while (syncedInPass > 0 && !hitTransient && readQueue().length > 0);

      const remaining = readQueue().length;
      if (totalSynced > 0 && remaining === 0) {
        setDbStatus(`☁️ Shared cloud DB connected — synced ${totalSynced} offline report(s).`);
      } else if (remaining > 0) {
        setDbStatus(`💾 Offline queue active — ${remaining} pending report(s) waiting to sync.`);
      } else if (totalFailed > 0) {
        setDbStatus(`☁️ Shared cloud DB connected (${totalFailed} invalid queued entry skipped).`);
      }
      return { synced: totalSynced, failed: totalFailed, remaining };
    })();
    try {
      return await flushPromise;
    } finally {
      flushPromise = null;
    }
  }

  async function initDB() {
    if (initDbPromise) return initDbPromise;
    initDbPromise = (async () => {
      const pendingAtStart = readQueue().length;
      setDbStatus('⏳ Connecting to shared cloud DB…');
      if (SUPABASE_URL.startsWith('YOUR_')) {
        setDbStatus('💾 Local demo mode — shared DB not configured.');
        return false;
      }
      try {
        if (!window.supabase && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
          await loadScript(CDN_ASSETS.supabaseJs.url, CDN_ASSETS.supabaseJs.integrity, 'supabase');
        }
        if (!window.supabase) {
          throw new Error('Supabase SDK unavailable');
        }
        if (!sb) {
          sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { fetch: createTimedFetch(SUPABASE_TIMEOUT_MS) }
          });
        }
        // Prefer insert-safe health RPC; fall back to head select if older schema is deployed
        const { error: rpcErr } = await sb.rpc('lantern_db_health');
        if (rpcErr) {
          const msg = (rpcErr.message || '').toLowerCase();
          if (rpcErr.code === 'PGRST202' || msg.includes('lantern_db_health')) {
            const { error } = await sb.from('lantern_reports').select('id', { count: 'exact', head: true });
            if (error) throw error;
          } else {
            throw rpcErr;
          }
        }
        useCloud = true;
        setDbStatus('☁️ Shared cloud DB connected — every submission syncs for everyone.');
        await flushPendingReports();
        return true;
      } catch {
        useCloud = false;
        setDbStatus(
          pendingAtStart > 0
            ? `💾 Offline mode — ${pendingAtStart} pending report(s) queued to sync when online.`
            : '💾 Local demo mode — cloud DB not reachable right now.'
        );
        return false;
      }
    })();
    try {
      return await initDbPromise;
    } finally {
      initDbPromise = null;
    }
  }

  let resolveDbReady;
  const dbReady = new Promise(resolve => { resolveDbReady = resolve; });
  const startDbInit = () => initDB().finally(resolveDbReady);
  if (document.readyState === 'complete') startDbInit();
  else window.addEventListener('DOMContentLoaded', startDbInit, { once: true });

  window.addEventListener('online', async () => {
    if (initDbPromise) await initDbPromise;
    if (!sb || !useCloud) {
      await initDB();
    }
    if (sb) {
      const { synced } = await flushPendingReports();
      if (synced > 0) useCloud = true;
    }
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const d = new FormData(form);
    const stage = d.get('stage'), count = d.get('count'), action = d.get('action');
    const place = placeInput.value.trim();

    let firstInvalid = null;
    REQUIRED_GROUPS.forEach(name => {
      const valid = Boolean(d.get(name));
      setGroupValidity(name, valid);
      if (!valid && !firstInvalid) firstInvalid = document.querySelector('#fs-' + name + ' input[type="radio"]');
    });
    if (firstInvalid) {
      setMsg('⚠️ Please answer Q1–Q3 before submitting.', 'error');
      firstInvalid.focus();
      return;
    }

    setButtonBusy(submitBtn, true, 'Saving…');
    setMsg('Saving…', 'info');
    try {
      await dbReady;
      if (!sb && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
        await initDB();
      }
      const payload = validateReportPayload({
        client_id: generateClientId(),
        stage,
        count,
        action,
        lat: gps?.lat || null,
        lng: gps?.lng || null,
        place: place || null,
        ...buildAiPayload(aiVerdict, yoloVerdict)
      });

      let savedToCloud = false;
      if (sb) {
        try {
          const res = await insertReportToCloud(payload);
          if (res.status === 'inserted' || res.status === 'already_synced') {
            savedToCloud = true;
            useCloud = true;
            flushPendingReports();
          } else if (res.status === 'permanent') {
            setMsg('❌ Report rejected by database: ' + (res.error?.message || 'invalid data'), 'error');
            return;
          } else {
            useCloud = false;
          }
        } catch {
          useCloud = false;
        }
      }

      if (savedToCloud) {
        setMsg('✅ Report submitted successfully! Thanks for helping science.', 'success');
      } else {
        const queued = enqueueLocalReport(payload);
        if (!queued.ok) {
          const reason = queued.reason === 'queue_full'
            ? 'offline queue is full (500 pending reports)'
            : 'browser storage is full or blocked';
          setMsg(`❌ Cloud DB is unreachable and ${reason} — report could NOT be saved. Your inputs were kept.`, 'error');
          setDbStatus('⚠️ Offline save failed — free browser storage or reconnect to submit.');
          return;
        }
        setMsg('💾 Saved on this device (cloud DB unreachable — will auto-sync when online).', 'success');
        setDbStatus(`💾 Offline queue active — ${queued.count} pending report(s) will sync when online.`);
      }

      const preservedKey = geminiKeyInput.value;
      form.reset();
      REQUIRED_GROUPS.forEach(name => setGroupValidity(name, true));
      clearPhotoState(true, false);
      clearGpsState(false);
      geminiKeyInput.value = preservedKey || safeStorage.get(GEMINI_KEY_STORAGE);
    } catch (err) {
      setMsg('❌ Submit failed: ' + err.message, 'error');
    } finally {
      setButtonBusy(submitBtn, false);
    }
  });
})();
