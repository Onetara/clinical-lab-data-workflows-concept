/* Author: Stacy Toriola | Code Reviewer: Anthony O. */
// CLSDW – Clinical Lab & Sample Data Workflows (No external deps, deterministic simulation)

/* ===========================
   Global State (immutable-ish)
   =========================== */
const STCDP = (() => {
  const state = {
    runId: createRunId(),
    rawInput: '',
    inputFormat: 'json', // 'json' | 'xml'
    records: [],           // intake-normalized (clinical)
    validRecords: [],
    quarantined: [],       // {record, reason, code}
    errors: [],            // [{idx, id, code, message, field}]
    processed: [],         // post-transform
    acks: [],              // reconciliation results
    audit: [],             // audit entries
    metrics: {
      total: 0,
      valid: 0,
      errors: 0,
      quarantine: 0,
      acked: 0,
      slaBreaches: 0,
      errorByCode: {},     // for chart
      ackDelays: [],       // for histogram
    },
    ui: {
      dashAnimEnabled: true
    }
  };
  return state;
})();

/* ===========================
   Utilities
   =========================== */
function createRunId() {
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `run_${Date.now().toString(36)}_${rand}`;
}
function nowIso() { return new Date().toISOString(); }
function safeJsonStringify(obj) {
  try { return JSON.stringify(obj, Object.keys(obj).sort(), 2); }
  catch { return JSON.stringify(obj); }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

/* ===========================
   Clinical Normalization
   =========================== */
function normalizeRecord(r) {
  // Clinical schema: id, patientId, specimenType, status, value, unit, collectedAt, accession, source
  return {
    id: String(r.id ?? '').trim(),
    patientId: String(r.patientId ?? '').trim(),
    specimenType: String(r.specimenType ?? '').trim().toUpperCase(),
    status: String(r.status ?? '').trim().toUpperCase(),
    value: (typeof r.value === 'number') ? r.value : Number(r.value),
    unit: String(r.unit ?? '').trim().toUpperCase(),
    collectedAt: String(r.collectedAt ?? '').trim(),
    accession: r.accession != null ? String(r.accession).trim().toUpperCase() : '',
    source: String(r.source ?? 'json').toLowerCase(), // provenance (json|xml)
  };
}

/* CRC32 (IEEE 802.3) */
function crc32(str) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < str.length; i++) {
    const byte = str.charCodeAt(i);
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}
const CRC32_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/* Seeded PRNG (Mulberry32) for deterministic reconciliation */
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ===========================
   Parsing & Intake
   =========================== */
function parseJson(text) {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      return { error: 'JSON must be an array of clinical sample records.' };
    }
    const normalized = data.map(d => normalizeRecord({ ...d, source: 'json' }));
    return { records: normalized };
  } catch (e) {
    return { error: `E010 JSON parse error: ${e.message}` };
  }
}

function parseXml(text) {
  try {
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'application/xml');
    const err = xml.querySelector('parsererror');
    if (err) return { error: 'E009 XML parse error: Malformed XML.' };

    // Expect: <samples><sample>...</sample></samples>
    const nodes = Array.from(xml.querySelectorAll('samples > sample'));
    if (!nodes.length) return { error: 'XML must contain <samples><sample>..</sample></samples>.' };

    const records = nodes.map(x => {
      const g = tag => x.querySelector(tag)?.textContent ?? '';
      return normalizeRecord({
        id: g('id'),
        patientId: g('patientId'),
        specimenType: g('specimenType'),
        status: g('status'),
        value: Number(g('value')),
        unit: g('unit'),
        collectedAt: g('collectedAt'),
        accession: g('accession'),
        source: 'xml'
      });
    });
    return { records };
  } catch (e) {
    return { error: `E009 XML parse error: ${e.message}` };
  }
}

function intakeAndValidate(raw, format) {
  STCDP.runId = createRunId();
  STCDP.rawInput = raw;
  STCDP.inputFormat = format;
  STCDP.records = [];
  STCDP.validRecords = [];
  STCDP.quarantined = [];
  STCDP.errors = [];
  STCDP.processed = [];
  STCDP.acks = [];
  STCDP.audit = [];
  STCDP.metrics = { total: 0, valid: 0, errors: 0, quarantine: 0, acked: 0, slaBreaches: 0, errorByCode: {}, ackDelays: [] };

  const parsed = (format === 'xml') ? parseXml(raw) : parseJson(raw);
  if (parsed.error) {
    logAudit('intake', '-', 'error', '-', parsed.error);
    STCDP.metrics.errors = 1;
    return { ok: false, message: parsed.error };
  }

  STCDP.records = parsed.records;
  STCDP.metrics.total = STCDP.records.length;
  logAudit('intake', '-', 'ok', '-', `Ingested ${STCDP.records.length} records via ${format}`);

  const vres = validateRecords(STCDP.records);
  STCDP.validRecords = vres.valid;
  STCDP.errors = vres.errors;
  STCDP.quarantined = vres.quarantine;
  STCDP.metrics.valid = STCDP.validRecords.length;
  STCDP.metrics.errors = STCDP.errors.length;
  STCDP.metrics.quarantine = STCDP.quarantined.length;

  logAudit('validate', '-', 'ok', '-', `Valid=${STCDP.metrics.valid} Errors=${STCDP.metrics.errors} Quarantine=${STCDP.metrics.quarantine}`);

  return { ok: true, message: `Ingested ${STCDP.records.length} records. Valid: ${STCDP.validRecords.length}. Errors: ${STCDP.errors.length}. Quarantine: ${STCDP.quarantined.length}.` };
}

/* ===========================
   Clinical Data Quality Gates
   =========================== */
const ENUM = Object.freeze({
  SPECIMEN: new Set(['BLOOD', 'URINE', 'SWAB', 'SALIVA', 'PLASMA']),
  STATUS: new Set(['RECEIVED', 'IN_PROGRESS', 'REPORTED']),
  UNIT: new Set(['MG/DL', 'MMOL/L', 'IU/L', 'CELLS/µL']),
});

const ERROR_BOOK = Object.freeze({
  E001: { title: 'Missing Required Field',
    fix: ['Identify the missing field.',
          'Ensure source systems populate it (LIS/LIMS).',
          'If unavailable, quarantine or enrich upstream.',
          'Re-run intake after correction.'] },
  E002: { title: 'Invalid Enumeration',
    fix: ['Compare value to allowed list (specimenType/status/unit).',
          'Correct mapping in source or extend enum after review.',
          'Re-run validation.'] },
  E003: { title: 'Out-of-Range Value',
    fix: ['Verify biological thresholds and units.',
          'Check unit conversions.',
          'Correct anomalous values or quarantine.'] },
  E004: { title: 'Chronology Violation',
    fix: ['Sort samples by collectedAt.',
          'Ensure timestamps are not in the future.',
          'Re-intake after ordering fixes.'] },
  E005: { title: 'Plausibility Failure',
    fix: ['Check clinical rules (e.g., REPORTED must have valid value).',
          'Review specimen/unit pairing.',
          'Fix data or quarantine.'] },
  E006: { title: 'Duplicate Detected',
    fix: ['Use id+accession as a natural key.',
          'Deduplicate upstream.',
          'Keep first occurrence, quarantine duplicates.'] },
  E007: { title: 'Format Check Failed',
    fix: ['Use ISO-8601 timestamp in collectedAt.',
          'Ensure id/accession match regex.',
          'Correct formatting upstream.'] },
  E009: { title: 'XML Parse Error',
    fix: ['Validate XML structure.',
          'Fix closing tags & nesting.',
          'Re-submit.'] },
  E010: { title: 'JSON Parse Error',
    fix: ['Validate JSON syntax.',
          'Remove trailing commas.',
          'Re-submit.'] },
});

function addError(idx, id, code, message, field) {
  STCDP.errors.push({ idx, id, code, message, field });
  STCDP.metrics.errorByCode[code] = (STCDP.metrics.errorByCode[code] || 0) + 1;
}
function quarantine(record, reason, code='E005') {
  STCDP.quarantined.push({ record, reason, code });
}
function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(?:\.\d+)?)?Z$/.test(s);
}
function idPattern(s) { return /^[A-Za-z0-9\-_]{4,40}$/.test(s); }
function accessionPattern(s) { return s === '' || /^[A-Z0-9\-]{8,30}$/.test(s); }

function validateRecords(records) {
  const valid = [];
  const seenKey = new Set();
  const quarantineBin = [];

  const now = Date.now();
  const threeYearsAgo = now - 1000 * 60 * 60 * 24 * 365 * 3;

  let lastTs = -Infinity;

  records.forEach((r, idx) => {
    const id = r.id || `row_${idx+1}`;

    // Required fields
    const requiredFields = ['id','patientId','specimenType','status','value','unit','collectedAt'];
    for (const f of requiredFields) {
      if (r[f] === '' || r[f] === undefined || r[f] === null || (f === 'value' && Number.isNaN(r[f]))) {
        addError(idx, id, 'E001', `Required field '${f}' is missing`, f);
      }
    }

    // Enumerations
    if (r.specimenType && !ENUM.SPECIMEN.has(r.specimenType)) addError(idx, id, 'E002', `Invalid specimenType '${r.specimenType}'`, 'specimenType');
    if (r.status && !ENUM.STATUS.has(r.status)) addError(idx, id, 'E002', `Invalid status '${r.status}'`, 'status');
    if (r.unit && !ENUM.UNIT.has(r.unit)) addError(idx, id, 'E002', `Invalid unit '${r.unit}'`, 'unit');

    // Value ranges (basic biological plausibility bounds; domain-neutral)
    if (typeof r.value === 'number' && !Number.isNaN(r.value)) {
      if (r.value < 0) addError(idx, id, 'E003', `Value cannot be negative: ${r.value}`, 'value');
      if (r.value > 1_000_000) addError(idx, id, 'E003', `Value out of range: ${r.value}`, 'value');
    }

    // Plausibility: REPORTED implies a measured value >= small epsilon
    if (r.status === 'REPORTED' && !(typeof r.value === 'number') || Number.isNaN(r.value)) {
      addError(idx, id, 'E005', 'REPORTED requires a numeric value', 'value');
    }

    // Format checks
    if (r.id && !idPattern(r.id)) addError(idx, id, 'E007', 'Invalid id format', 'id');
    if (r.accession && !accessionPattern(r.accession)) addError(idx, id, 'E007', 'Invalid accession format', 'accession');
    if (r.collectedAt && !isIsoDate(r.collectedAt)) addError(idx, id, 'E007', 'Invalid ISO timestamp (collectedAt)', 'collectedAt');

    // Timestamp plausibility
    if (isIsoDate(r.collectedAt)) {
      const t = Date.parse(r.collectedAt);
      if (Number.isNaN(t)) addError(idx, id, 'E007', 'Unparseable collectedAt', 'collectedAt');
      else {
        if (t > now) addError(idx, id, 'E004', 'collectedAt cannot be in the future', 'collectedAt');
        if (t < threeYearsAgo) addError(idx, id, 'E003', 'collectedAt older than 3 years', 'collectedAt');
        if (t < lastTs) addError(idx, id, 'E004', 'Dataset chronology must be non-decreasing', 'collectedAt');
        lastTs = Math.max(lastTs, t);
      }
    }

    // Duplicate (id + accession)
    const dedupKey = `${r.id}::${r.accession || ''}`;
    if (seenKey.has(dedupKey)) addError(idx, id, 'E006', 'Duplicate id+accession', 'id/accession');
    else seenKey.add(dedupKey);

    // Audit: per-record checksum (pre-transform)
    const checksum = crc32(safeJsonStringify(r)).toString(16).padStart(8, '0');
    logAudit('validate:item', 'ok', 'ok', r.id, `preCRC=${checksum}`);

    // Valid vs quarantine
    const hadErrors = STCDP.errors.some(e => e.id === id && e.idx === idx);
    if (hadErrors) {
      quarantineBin.push({ record: r, reason: 'Validation failure', code: 'E005' });
    } else {
      valid.push(r);
    }
  });

  return { valid, errors: STCDP.errors, quarantine: quarantineBin };
}

/* ===========================
   Processing
   =========================== */
function processRecords() {
  const out = [];
  for (const r of STCDP.validRecords) {
    const category =
      (r.unit.includes('/µL') ? 'HEMATOLOGY' :
       r.specimenType === 'SWAB' ? 'MICROBIOLOGY' :
       'CHEMISTRY');

    const processed = {
      ...r,
      processedAt: nowIso(),
      normalizedValue: Number(r.value),
      category,
    };
    const checksum = crc32(safeJsonStringify(processed)).toString(16).padStart(8, '0');
    logAudit('process:item', 'ok', 'ok', r.id, `postCRC=${checksum}`);
    out.push(processed);
  }
  STCDP.processed = out;
  logAudit('process', '-', 'ok', '-', `Processed ${out.length} records`);
  return out.length;
}

/* ===========================
   Reconciliation (Simulated ACKs with SLA)
   =========================== */
function reconcileRecords(slaMs) {
  const acks = [];
  STCDP.metrics.acked = 0;
  STCDP.metrics.slaBreaches = 0;
  STCDP.metrics.ackDelays = [];

  for (const r of STCDP.processed) {
    const seed = crc32(r.id) >>> 0;
    const rand = mulberry32(seed);
    const delay = 100 + Math.floor(rand() * 2400); // 100..2500ms
    const ok = rand() > 0.12;                       // ~88% success
    const ackCode = ok ? 200 : 500;
    const sla = delay <= slaMs;

    STCDP.metrics.ackDelays.push(delay);
    if (ok) STCDP.metrics.acked++;
    if (!sla) STCDP.metrics.slaBreaches++;

    acks.push({ id: r.id, ok, ackCode, delay, sla });

    logAudit('reconcile:item', ok ? 'ok' : 'error', ok ? 'ok' : 'failed', r.id,
      `ack=${ackCode} delay=${delay}ms sla=${sla ? 'met' : 'breach'}`);
  }

  STCDP.acks = acks;
  logAudit('reconcile', '-', 'ok', '-', `ACKed=${STCDP.metrics.acked} SLA breaches=${STCDP.metrics.slaBreaches}`);
  return acks.length;
}

/* ===========================
   Audit & Export
   =========================== */
function logAudit(stage, status, outcome, recordId, notes) {
  const entry = {
    time: nowIso(),
    runId: STCDP.runId,
    stage, status, recordId,
    checksum: crc32(`${STCDP.runId}|${stage}|${recordId}|${notes ?? ''}`).toString(16).padStart(8, '0'),
    notes: notes ?? ''
  };
  STCDP.audit.push(entry);
}
function auditToCsv() {
  const rows = [['time','runId','stage','status','recordId','checksum','notes']];
  for (const a of STCDP.audit) {
    rows.push([a.time, a.runId, a.stage, a.status, a.recordId, a.checksum, a.notes.replace(/\n/g, ' ')]);
  }
  return rows.map(r => r.map(cell => `"${String(cell).replace(/"/g,'""')}"`).join(',')).join('\n');
}
function download(filename, text, type='text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ===========================
   Rendering
   =========================== */
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
function renderValidation() {
  setText('kpiTotal', STCDP.metrics.total);
  setText('kpiValid', STCDP.metrics.valid);
  setText('kpiErrors', STCDP.metrics.errors);
  setText('kpiQuarantine', STCDP.metrics.quarantine);

  // Errors table
  const tbody = document.getElementById('tblErrors');
  tbody.innerHTML = '';
  let row = 1;
  for (const e of STCDP.errors) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row++}</td>
      <td><code class="stcdp-chip">${escapeHtml(e.id)}</code></td>
      <td><button type="button" class="stcdp-btn stcdp-btn--ghost stcdp-btn--tiny" data-playbook="${e.code}">${e.code}</button></td>
      <td>${escapeHtml(e.message)}</td>
      <td>${escapeHtml(e.field || '')}</td>
      <td><span class="stcdp-chip">${escapeHtml(ERROR_BOOK[e.code]?.title || 'See playbook')}</span></td>`;
    tbody.appendChild(tr);
  }

  // Quarantine table
  const tq = document.getElementById('tblQuarantine');
  tq.innerHTML = '';
  let qn = 1;
  for (const q of STCDP.quarantined) {
    const sample = safeJsonStringify(q.record).slice(0, 180).replace(/\n/g, ' ');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${qn++}</td>
      <td><code class="stcdp-chip">${escapeHtml(q.record.id)}</code></td>
      <td>${escapeHtml(q.reason)} (${q.code})</td>
      <td><code>${escapeHtml(sample)}${sample.length >= 180 ? '…' : ''}</code></td>`;
    tq.appendChild(tr);
  }
}
function renderProcessSummary(count) {
  const el = document.getElementById('processSummary');
  el.textContent = `Processed ${count} records.`;
}
function renderReconcile() {
  setText('kpiAck', STCDP.metrics.acked);
  setText('kpiSla', STCDP.metrics.slaBreaches);

  const tbody = document.getElementById('tblAcks');
  tbody.innerHTML = '';
  let i = 1;
  for (const a of STCDP.acks) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i++}</td>
      <td><code class="stcdp-chip">${escapeHtml(a.id)}</code></td>
      <td>${a.ok ? '<span class="stcdp-ok">OK</span>' : '<span class="stcdp-bad">FAILED</span>'}</td>
      <td>${a.ackCode}</td>
      <td>${a.delay}</td>
      <td>${a.sla ? '<span class="stcdp-ok">MET</span>' : '<span class="stcdp-bad">BREACH</span>'}</td>`;
    tbody.appendChild(tr);
  }
}
function renderAudit() {
  const tbody = document.getElementById('tblAudit');
  tbody.innerHTML = '';
  let i = 1;
  for (const a of STCDP.audit) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i++}</td>
      <td>${escapeHtml(a.time)}</td>
      <td><code class="stcdp-chip">${escapeHtml(a.runId)}</code></td>
      <td>${escapeHtml(a.stage)}</td>
      <td><code>${escapeHtml(a.recordId || '-')}</code></td>
      <td>${escapeHtml(a.status)}</td>
      <td><code>${escapeHtml(a.checksum)}</code></td>
      <td>${escapeHtml(a.notes)}</td>`;
    tbody.appendChild(tr);
  }
}
function renderDashboard() {
  const total = STCDP.metrics.total;
  const err = STCDP.metrics.errors;
  const qsize = STCDP.metrics.quarantine;
  const acked = STCDP.metrics.acked;
  const breaches = STCDP.metrics.slaBreaches;

  const errorRate = total ? Math.round((err / total) * 100) : 0;
  const slaRate = STCDP.acks.length ? Math.round((breaches / STCDP.acks.length) * 100) : 0;

  setText('metricErrorRate', `${errorRate}%`);
  setText('metricSlaRate', `${slaRate}%`);
  setText('metricQuarantine', String(qsize));
  setText('metricThroughput', String(total));

  drawErrorBars('chartErrors', STCDP.metrics.errorByCode);
  drawDelayHistogram('chartAckDelays', STCDP.metrics.ackDelays);
}

/* Charts */
function drawErrorBars(canvasId, codeCounts) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,c.width,c.height);
  const entries = Object.entries(codeCounts);
  if (!entries.length) return;

  const max = Math.max(...entries.map(([,v]) => v));
  const barW = Math.max(24, Math.floor((c.width - 40) / entries.length) - 10);
  let x = 20;
  entries.forEach(([code, val]) => {
    const h = Math.round(((val / max) * (c.height - 40)));
    ctx.fillStyle = '#4cc9f0';
    ctx.fillRect(x, c.height - 20 - h, barW, h);
    ctx.strokeStyle = '#314257';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, c.height - 20 - h, barW, h);

    ctx.fillStyle = '#a8b0bf';
    ctx.font = '12px system-ui';
    ctx.fillText(code, x, c.height - 4);
    x += barW + 10;
  });
}
function drawDelayHistogram(canvasId, delays) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,c.width,c.height);
  if (!delays.length) return;

  const maxDelay = Math.max(...delays);
  const buckets = Math.ceil(maxDelay / 200);
  const counts = new Array(buckets).fill(0);
  delays.forEach(d => { counts[Math.min(buckets-1, Math.floor(d/200))]++; });

  const max = Math.max(...counts);
  const barW = Math.max(18, Math.floor((c.width - 40) / buckets) - 6);
  let x = 20;

  for (let i=0;i<buckets;i++) {
    const v = counts[i];
    const h = Math.round(((v / max) * (c.height - 40)));
    ctx.fillStyle = '#80ffdb';
    ctx.fillRect(x, c.height - 20 - h, barW, h);
    ctx.strokeStyle = '#2a6f5a';
    ctx.strokeRect(x, c.height - 20 - h, barW, h);

    ctx.fillStyle = '#a8b0bf';
    ctx.font = '11px system-ui';
    ctx.fillText(`${i*200}`, x, c.height - 4);
    x += barW + 6;
  }
}

/* ===========================
   Playbooks rendering
   =========================== */
function renderPlaybooks() {
  const host = document.getElementById('playbookList');
  host.innerHTML = '';
  Object.entries(ERROR_BOOK).forEach(([code, meta]) => {
    const det = document.createElement('details');
    det.id = `playbook-${code}`;
    const summary = document.createElement('summary');
    summary.innerHTML = `<strong>${code}</strong> — ${escapeHtml(meta.title)}`;
    det.appendChild(summary);

    const ul = document.createElement('ol');
    (meta.fix || []).forEach(step => {
      const li = document.createElement('li');
      li.textContent = step;
      ul.appendChild(li);
    });
    det.appendChild(ul);
    host.appendChild(det);
  });
}

/* ===========================
   Editor Helpers (new)
   =========================== */
function recordsToJsonText() {
  return safeJsonStringify(STCDP.records);
}
function recordsToXmlText() {
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const rows = STCDP.records.map(r => `
  <sample>
    <id>${esc(r.id)}</id>
    <patientId>${esc(r.patientId)}</patientId>
    <specimenType>${esc(r.specimenType)}</specimenType>
    <status>${esc(r.status)}</status>
    <value>${Number(r.value)}</value>
    <unit>${esc(r.unit)}</unit>
    <collectedAt>${esc(r.collectedAt)}</collectedAt>
    <accession>${esc(r.accession)}</accession>
  </sample>`.trim()).join('\n  ');
  return `<samples>\n  ${rows}\n</samples>\n`;
}

/* ===========================
   DOM Helpers & Events
   =========================== */
function switchTab(target) {
  document.querySelectorAll('.stcdp-tab').forEach(b => b.classList.remove('is-active'));
  document.querySelectorAll('.stcdp-panel').forEach(p => p.classList.add('stcdp-hidden'));
  document.querySelector(`.stcdp-tab[data-tab="${target}"]`)?.classList.add('is-active');
  document.getElementById(`stcdp-panel-${target}`)?.classList.remove('stcdp-hidden');
}
function onClickPlaybook(e) {
  const code = e.target?.dataset?.playbook;
  if (!code) return;
  switchTab('playbooks');
  const d = document.getElementById(`playbook-${code}`);
  if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}

/* ===========================
   Clinical Examples (12 records each)
   =========================== */
const JSON_EXAMPLE_TEXT = `[
  {"id":"SMP-1001","patientId":"PAT-001","specimenType":"BLOOD","status":"RECEIVED","value":85.2,"unit":"MG/DL","collectedAt":"2026-01-15T09:00:00Z","accession":"ACC-2026-0001"},
  {"id":"SMP-1002","patientId":"PAT-002","specimenType":"URINE","status":"IN_PROGRESS","value":6.5,"unit":"MMOL/L","collectedAt":"2026-01-15T09:05:00Z","accession":"ACC-2026-0002"},
  {"id":"SMP-1003","patientId":"PAT-003","specimenType":"SWAB","status":"REPORTED","value":1,"unit":"IU/L","collectedAt":"2026-01-15T09:10:00Z","accession":"ACC-2026-0003"},
  {"id":"SMP-1004","patientId":"PAT-004","specimenType":"SALIVA","status":"RECEIVED","value":0.8,"unit":"IU/L","collectedAt":"2026-01-15T09:12:00Z","accession":"ACC-2026-0004"},
  {"id":"SMP-1005","patientId":"PAT-005","specimenType":"PLASMA","status":"REPORTED","value":245,"unit":"MG/DL","collectedAt":"2026-01-15T09:15:00Z","accession":"ACC-2026-0005"},
  {"id":"SMP-1006","patientId":"PAT-006","specimenType":"BLOOD","status":"IN_PROGRESS","value":4.6,"unit":"MMOL/L","collectedAt":"2026-01-15T09:20:00Z","accession":"ACC-2026-0006"},
  {"id":"SMP-1007","patientId":"PAT-007","specimenType":"PLASMA","status":"RECEIVED","value":120,"unit":"MG/DL","collectedAt":"2026-01-15T09:25:00Z","accession":"ACC-2026-0007"},
  {"id":"SMP-1008","patientId":"PAT-008","specimenType":"URINE","status":"REPORTED","value":2.1,"unit":"MMOL/L","collectedAt":"2026-01-15T09:30:00Z","accession":"ACC-2026-0008"},
  {"id":"SMP-1009","patientId":"PAT-009","specimenType":"SWAB","status":"REPORTED","value":0,"unit":"IU/L","collectedAt":"2026-01-15T09:35:00Z","accession":"ACC-2026-0009"},
  {"id":"SMP-1010","patientId":"PAT-010","specimenType":"BLOOD","status":"IN_PROGRESS","value":4500,"unit":"CELLS/µL","collectedAt":"2026-01-15T09:40:00Z","accession":"ACC-2026-0010"},
  {"id":"bad id!","patientId":"PAT-011","specimenType":"PLASMA","status":"REPORTED","value":-3,"unit":"MG/DL","collectedAt":"2026-01-15T09:42:00Z","accession":"TOO-LONG-REF-123456-OVER"},
  {"id":"SMP-1002","patientId":"PAT-002","specimenType":"URINE","status":"RECEIVED","value":1.1,"unit":"XYZ","collectedAt":"2026-01-15T09:45:00Z","accession":"ACC-2026-0002"}
]`;

const XML_EXAMPLE_TEXT = `
<samples>
  <sample>
    <id>SMP-2001</id>
    <patientId>PAT-021</patientId>
    <specimenType>BLOOD</specimenType>
    <status>RECEIVED</status>
    <value>92.4</value>
    <unit>MG/DL</unit>
    <collectedAt>2026-01-16T10:00:00Z</collectedAt>
    <accession>ACC-2026-0101</accession>
  </sample>
  <sample>
    <id>SMP-2002</id>
    <patientId>PAT-022</patientId>
    <specimenType>URINE</specimenType>
    <status>IN_PROGRESS</status>
    <value>4.2</value>
    <unit>MMOL/L</unit>
    <collectedAt>2026-01-16T10:05:00Z</collectedAt>
    <accession>ACC-2026-0102</accession>
  </sample>
  <sample>
    <id>SMP-2003</id>
    <patientId>PAT-023</patientId>
    <specimenType>SWAB</specimenType>
    <status>REPORTED</status>
    <value>1</value>
    <unit>IU/L</unit>
    <collectedAt>2026-01-16T10:06:00Z</collectedAt>
    <accession>ACC-2026-0103</accession>
  </sample>
  <sample>
    <id>SMP-2004</id>
    <patientId>PAT-024</patientId>
    <specimenType>SALIVA</specimenType>
    <status>RECEIVED</status>
    <value>0.7</value>
    <unit>IU/L</unit>
    <collectedAt>2026-01-16T10:08:00Z</collectedAt>
    <accession>ACC-2026-0104</accession>
  </sample>
  <sample>
    <id>SMP-2005</id>
    <patientId>PAT-025</patientId>
    <specimenType>PLASMA</specimenType>
    <status>REPORTED</status>
    <value>210</value>
    <unit>MG/DL</unit>
    <collectedAt>2026-01-16T10:10:00Z</collectedAt>
    <accession>ACC-2026-0105</accession>
  </sample>
  <sample>
    <id>SMP-2006</id>
    <patientId>PAT-026</patientId>
    <specimenType>BLOOD</specimenType>
    <status>IN_PROGRESS</status>
    <value>5.2</value>
    <unit>MMOL/L</unit>
    <collectedAt>2026-01-16T10:15:00Z</collectedAt>
    <accession>ACC-2026-0106</accession>
  </sample>
  <sample>
    <id>SMP-2007</id>
    <patientId>PAT-027</patientId>
    <specimenType>PLASMA</specimenType>
    <status>RECEIVED</status>
    <value>130</value>
    <unit>MG/DL</unit>
    <collectedAt>2026-01-16T10:20:00Z</collectedAt>
    <accession>ACC-2026-0107</accession>
  </sample>
  <sample>
    <id>SMP-2008</id>
    <patientId>PAT-028</patientId>
    <specimenType>URINE</specimenType>
    <status>REPORTED</status>
    <value>1.9</value>
    <unit>MMOL/L</unit>
    <collectedAt>2026-01-16T10:25:00Z</collectedAt>
    <accession>ACC-2026-0108</accession>
  </sample>
  <sample>
    <id>SMP-2009</id>
    <patientId>PAT-029</patientId>
    <specimenType>SWAB</specimenType>
    <status>REPORTED</status>
    <value>0</value>
    <unit>IU/L</unit>
    <collectedAt>2026-01-16T10:30:00Z</collectedAt>
    <accession>ACC-2026-0109</accession>
  </sample>
  <sample>
    <id>SMP-2010</id>
    <patientId>PAT-030</patientId>
    <specimenType>BLOOD</specimenType>
    <status>IN_PROGRESS</status>
    <value>5200</value>
    <unit>CELLS/µL</unit>
    <collectedAt>2026-01-16T10:35:00Z</collectedAt>
    <accession>ACC-2026-0110</accession>
  </sample>
  <!-- Intentionally invalid to show quarantine -->
  <sample>
    <id>bad id!</id>
    <patientId>PAT-031</patientId>
    <specimenType>PLASMA</specimenType>
    <status>REPORTED</status>
    <value>-2</value>
    <unit>MG/DL</unit>
    <collectedAt>2027-05-01T00:00:00Z</collectedAt>
    <accession>TOO-LONG-REF-123456-OVER</accession>
  </sample>
  <sample>
    <id>SMP-2002</id>
    <patientId>PAT-022</patientId>
    <specimenType>URINE</specimenType>
    <status>RECEIVED</status>
    <value>1.1</value>
    <unit>XYZ</unit>
    <collectedAt>2026-01-16T10:40:00Z</collectedAt>
    <accession>ACC-2026-0102</accession>
  </sample>
</samples>
`;

/* ===========================
   Initialization
   =========================== */
function init() {
  document.getElementById('year').textContent = new Date().getFullYear();

  // Tabs
  document.querySelectorAll('.stcdp-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Intake format selection
  document.querySelectorAll('input[name="format"]').forEach(r => {
    r.addEventListener('change', e => { STCDP.inputFormat = e.target.value; });
  });

  // Intake actions
  document.getElementById('btnLoadJson').addEventListener('click', () => {
    STCDP.inputFormat = 'json';
    document.querySelector('input[name="format"][value="json"]').checked = true;
    document.getElementById('inputData').value = JSON_EXAMPLE_TEXT;
  });
  document.getElementById('btnLoadXml').addEventListener('click', () => {
    STCDP.inputFormat = 'xml';
    document.querySelector('input[name="format"][value="xml"]').checked = true;
    document.getElementById('inputData').value = XML_EXAMPLE_TEXT.trim();
  });
  document.getElementById('btnClear').addEventListener('click', () => {
    document.getElementById('inputData').value = '';
    document.getElementById('intakeSummary').textContent = '';
  });

  document.getElementById('btnIntake').addEventListener('click', () => {
    const raw = document.getElementById('inputData').value.trim();
    const fmt = STCDP.inputFormat;
    const res = intakeAndValidate(raw, fmt);
    const summary = document.getElementById('intakeSummary');
    summary.textContent = res.ok ? res.message : `Intake failed: ${res.message}`;
    renderValidation();
    renderAudit();
    renderDashboard();
    switchTab('validate');
  });

  // Process
  document.getElementById('btnProcess').addEventListener('click', () => {
    const count = processRecords();
    renderProcessSummary(count);
    renderAudit();
    renderDashboard();
  });

  // Reconcile
  document.getElementById('btnReconcile').addEventListener('click', () => {
    const sla = Number(document.getElementById('slaMs').value) || 1500;
    const n = reconcileRecords(sla);
    renderReconcile();
    renderAudit();
    renderDashboard();
    if (!n) alert('No processed records to reconcile. Run "Process" first.');
  });

  // Export Audit
  document.getElementById('btnExportAudit').addEventListener('click', () => {
    const csv = auditToCsv();
    download(`audit_${STCDP.runId}.csv`, csv, 'text/csv');
  });
  document.getElementById('btnCopyAudit').addEventListener('click', async () => {
    const text = safeJsonStringify(STCDP.audit);
    try {
      await navigator.clipboard.writeText(text);
      alert('Audit JSON copied to clipboard.');
    } catch {
      download(`audit_${STCDP.runId}.json`, text, 'application/json');
    }
  });

  // Playbooks
  renderPlaybooks();
  document.getElementById('tblErrors').addEventListener('click', onClickPlaybook);

  /* ===== Editor wiring ===== */
  document.getElementById('btnShowCurrent').addEventListener('click', () => {
    const fmt = document.querySelector('input[name="editorFormat"]:checked').value;
    const text = (fmt === 'xml') ? recordsToXmlText() : recordsToJsonText();
    document.getElementById('editorText').value = text;
    document.getElementById('editorSummary').textContent = `Rendered current dataset as ${fmt.toUpperCase()}.`;
  });

  document.getElementById('btnBeautify').addEventListener('click', () => {
    const fmt = document.querySelector('input[name="editorFormat"]:checked').value;
    const el = document.getElementById('editorText');
    const raw = el.value.trim();
    try {
      if (fmt === 'json') {
        const obj = JSON.parse(raw);
        el.value = JSON.stringify(obj, null, 2);
      } else {
        // Naive pretty for XML: reparse and serialize via DOM
        const parser = new DOMParser();
        const xml = parser.parseFromString(raw, 'application/xml');
        const err = xml.querySelector('parsererror');
        if (err) throw new Error('XML parse error');
        const serializer = new XMLSerializer();
        const pretty = serializer.serializeToString(xml);
        el.value = pretty;
      }
      document.getElementById('editorSummary').textContent = 'Beautified successfully.';
    } catch (e) {
      document.getElementById('editorSummary').textContent = `Beautify failed: ${e.message}`;
    }
  });

  document.getElementById('filePicker').addEventListener('change', ev => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      document.getElementById('editorText').value = text;
      // Guess format by extension
      const isXml = /\.xml$/i.test(file.name);
      document.querySelector(`input[name="editorFormat"][value="${isXml ? 'xml' : 'json'}"]`).checked = true;
      document.getElementById('editorSummary').textContent = `Loaded ${file.name} (${text.length} bytes)`;
    };
    reader.readAsText(file);
  });

  document.getElementById('btnApplyEditor').addEventListener('click', () => {
    const fmt = document.querySelector('input[name="editorFormat"]:checked').value;
    const raw = document.getElementById('editorText').value.trim();
    if (!raw) {
      document.getElementById('editorSummary').textContent = 'Nothing to apply.';
      return;
    }
    const res = intakeAndValidate(raw, fmt);
    document.getElementById('editorSummary').textContent = res.ok ? `Applied: ${res.message}` : `Apply failed: ${res.message}`;
    renderValidation();
    renderAudit();
    renderDashboard();
    switchTab('validate');
  });

  document.getElementById('btnDownloadCurrent').addEventListener('click', () => {
    const fmt = document.querySelector('input[name="editorFormat"]:checked').value;
    const text = (fmt === 'xml') ? recordsToXmlText() : recordsToJsonText();
    const ext = (fmt === 'xml') ? 'xml' : 'json';
    download(`clsdw_dataset_${STCDP.runId}.${ext}`, text, (fmt === 'xml') ? 'application/xml' : 'application/json');
  });

  /* ===== New Entry wiring ===== */
  document.getElementById('btnAddNew').addEventListener('click', () => {
    const id = document.getElementById('newId').value.trim();
    const patientId = document.getElementById('newPatientId').value.trim();
    const specimenType = document.getElementById('newSpecimen').value.trim().toUpperCase();
    const status = document.getElementById('newStatus').value.trim().toUpperCase();
    const valueNum = Number(document.getElementById('newValue').value);
    const unit = document.getElementById('newUnit').value.trim().toUpperCase();
    const dtLocal = document.getElementById('newCollected').value; // yyyy-MM-ddTHH:mm
    const collectedAt = dtLocal ? new Date(dtLocal).toISOString().replace(/\.\d{3}Z$/, 'Z') : '';
    const accession = document.getElementById('newAccession').value.trim().toUpperCase();

    const newRec = normalizeRecord({ id, patientId, specimenType, status, value: valueNum, unit, collectedAt, accession, source: 'json' });
    const current = STCDP.records.slice();
    current.push(newRec);
    const res = intakeAndValidate(safeJsonStringify(current), 'json'); // re-run through intake pipeline
    document.getElementById('newSummary').textContent = res.ok ? `Added & validated. ${res.message}` : `Add failed: ${res.message}`;
    renderValidation();
    renderAudit();
    renderDashboard();
    switchTab('validate');
  });

  /* ===== Dashboard animation toggle ===== */
  const animToggle = document.getElementById('toggleDashAnim');
  const animHost = document.getElementById('dashboardAnimHost');
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  STCDP.ui.dashAnimEnabled = !prefersReduced;
  animToggle.checked = STCDP.ui.dashAnimEnabled;
  if (!STCDP.ui.dashAnimEnabled) animHost.classList.remove('is-animated');

  animToggle.addEventListener('change', () => {
    STCDP.ui.dashAnimEnabled = !!animToggle.checked;
    animHost.classList.toggle('is-animated', STCDP.ui.dashAnimEnabled);
  });

  // Initial tab
  switchTab('intake');
}

document.addEventListener('DOMContentLoaded', init);

/* ===========================
   Notes
   - CSS/JS prefixed classes to avoid collisions
   - No external assets; CSP self-only
   - Editor supports load/apply/download for JSON/XML
   - Dashboard anim honors toggle and prefers-reduced-motion
   =========================== */
``