// Standard MediaPipe Pose skeleton connections (landmark index pairs).
const POSE_CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
];

// Distinct colors per detected person so overlapping/multiple skeletons stay legible.
const PERSON_COLORS = ['#2f6fed', '#e05d5d', '#2fa84f', '#c77dea', '#e0a72f', '#2fb8c7'];

// Landmarks below this confidence are not drawn - MediaPipe still returns a
// coordinate for occluded joints, but rendering it as if it were seen is
// misleading (see the README's "known limitations" for why this matters).
const VISIBILITY_THRESHOLD = 0.5;

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp']);

const $ = (sel) => document.querySelector(sel);

// ---------------- API key ----------------
// When the server sets API_KEY, every data request must carry it. The key is kept for this browser tab
// only (sessionStorage), never in a cookie or in the URL.
function getApiKey() {
  try { return sessionStorage.getItem('apiKey') || ''; } catch { return ''; }
}

function apiFetch(url, options = {}) {
  const key = getApiKey();
  const headers = { ...(options.headers || {}), ...(key ? { Authorization: 'Bearer ' + key } : {}) };
  return fetch(url, { ...options, headers });
}

// <img src> cannot send an Authorization header, so images are fetched with it and shown from a blob URL.
const imageUrlCache = new Map();
async function imageObjectUrl(path) {
  if (imageUrlCache.has(path)) return imageUrlCache.get(path);
  const res = await apiFetch(path);
  if (!res.ok) throw new Error('image ' + res.status);
  const url = URL.createObjectURL(await res.blob());
  imageUrlCache.set(path, url);
  return url;
}

function setupApiKey() {
  const input = $('#api-key');
  input.value = getApiKey();
  $('#api-key-save').addEventListener('click', () => {
    try { sessionStorage.setItem('apiKey', input.value.trim()); } catch { /* storage blocked: key lasts until reload */ }
    imageUrlCache.clear();
    loadRecords();
  });
}

function drawPoses(canvas, imageEl, poses) {
  const ctx = canvas.getContext('2d');
  const w = imageEl.naturalWidth || imageEl.width;
  const h = imageEl.naturalHeight || imageEl.height;
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(imageEl, 0, 0, w, h);

  if (!poses || poses.length === 0) return;

  for (const pose of poses) {
    const color = PERSON_COLORS[pose.personIndex % PERSON_COLORS.length];
    const keypoints = pose.keypoints;

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, w / 250);
    for (const [a, b] of POSE_CONNECTIONS) {
      const pa = keypoints[a];
      const pb = keypoints[b];
      if (!pa || !pb) continue;
      if (pa.visibility < VISIBILITY_THRESHOLD || pb.visibility < VISIBILITY_THRESHOLD) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x * w, pa.y * h);
      ctx.lineTo(pb.x * w, pb.y * h);
      ctx.stroke();
    }

    ctx.fillStyle = color;
    for (const kp of keypoints) {
      if (kp.visibility < VISIBILITY_THRESHOLD) continue;
      ctx.beginPath();
      ctx.arc(kp.x * w, kp.y * h, Math.max(2, w / 180), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

async function checkHealth() {
  const pgDot = $('#health-pg');
  const mongoDot = $('#health-mongo');
  const text = $('#health-text');
  try {
    const res = await fetch('/health');
    const body = await res.json();
    pgDot.className = 'dot ' + (body.postgres === 'ok' ? 'dot-ok' : 'dot-error');
    mongoDot.className = 'dot ' + (body.mongo === 'ok' ? 'dot-ok' : 'dot-error');
    text.textContent = res.ok ? 'PostgreSQL / MongoDB connected' : 'Degraded — see status dots';
  } catch (err) {
    pgDot.className = 'dot dot-error';
    mongoDot.className = 'dot dot-error';
    text.textContent = 'Server unreachable';
  }
}

// ---------------- Upload flow ----------------

let selectedFile = null;

function resetUpload() {
  selectedFile = null;
  $('#upload-preview-wrap').classList.add('hidden');
  $('#dropzone').classList.remove('hidden');
  $('#file-input').value = '';
  $('#upload-status').textContent = '';
  $('#upload-status').className = 'status';
}

function validateFile(file) {
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return `Unsupported file type "${file.type || 'unknown'}". Allowed: JPEG, PNG, WebP, BMP.`;
  }
  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    return `File is ${(file.size / (1024 * 1024)).toFixed(1)}MB, which exceeds the ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB limit.`;
  }
  return null;
}

function onFileSelected(file) {
  if (!file) return;

  const statusEl = $('#upload-status');
  const validationError = validateFile(file);
  if (validationError) {
    statusEl.className = 'status error';
    statusEl.textContent = validationError;
    return;
  }
  statusEl.className = 'status';
  statusEl.textContent = '';

  selectedFile = file;
  const url = URL.createObjectURL(file);
  $('#upload-preview').src = url;
  $('#upload-preview-wrap').classList.remove('hidden');
  $('#dropzone').classList.add('hidden');
  $('#result').classList.add('hidden');
}

function setupDropzone() {
  const dz = $('#dropzone');
  const input = $('#file-input');
  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => onFileSelected(e.target.files[0]));

  ['dragenter', 'dragover'].forEach((evt) =>
    dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.remove('dragover'); })
  );
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    onFileSelected(file);
  });

  $('#cancel-btn').addEventListener('click', resetUpload);

  $('#submit-btn').addEventListener('click', async () => {
    if (!selectedFile) return;
    const btn = $('#submit-btn');
    const cancelBtn = $('#cancel-btn');
    const spinner = $('#upload-spinner');
    btn.disabled = true;
    cancelBtn.disabled = true;
    spinner.classList.remove('hidden');
    const statusEl = $('#upload-status');
    statusEl.className = 'status';
    statusEl.textContent = '';

    const form = new FormData();
    form.append('image', selectedFile);

    try {
      const res = await apiFetch('/extract-pose', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) {
        statusEl.className = 'status error';
        statusEl.textContent = `${res.status}: ${body.message || 'Extraction failed'}`;
        return;
      }
      statusEl.className = 'status success';
      statusEl.textContent = body.message;
      showResult(body.record);
      loadRecords();
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Request failed: ${err.message}`;
    } finally {
      btn.disabled = false;
      cancelBtn.disabled = false;
      spinner.classList.add('hidden');
    }
  });
}

function showResult(record) {
  $('#result').classList.remove('hidden');
  $('#result-detected').textContent = record.poseDetected ? 'Yes' : 'No';
  $('#result-person-count').textContent = record.personCount;
  $('#result-count').textContent = record.landmarkCount;
  $('#result-id').textContent = record.id;
  $('#result-json').textContent = JSON.stringify(record, null, 2);

  const img = new Image();
  img.onload = () => drawPoses($('#result-canvas'), img, record.poses);
  img.src = $('#upload-preview').src;
}

// ---------------- Records list ----------------

let currentOffset = 0;
const PAGE_SIZE = 10;
let searchDebounceTimer = null;

function buildRecordsQuery() {
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: currentOffset });
  const search = $('#search-input').value.trim();
  const poseFilter = $('#pose-filter').value;
  if (search) params.set('search', search);
  if (poseFilter) params.set('poseDetected', poseFilter);
  return params.toString();
}

async function loadRecords() {
  const res = await apiFetch(`/records?${buildRecordsQuery()}`);
  const body = await res.json();
  const tbody = $('#records-body');
  if (!res.ok) {
    tbody.innerHTML = '';
    $('#records-empty').classList.remove('hidden');
    $('#records-empty').textContent = res.status === 401 ? 'This server needs an API key. Enter it at the top and press Save.' : (body.message || 'Could not load records.');
    return;
  }
  $('#records-empty').textContent = 'No records match.';
  tbody.innerHTML = '';

  $('#records-empty').classList.toggle('hidden', body.records.length > 0);

  for (const record of body.records) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><img alt="thumbnail" data-image-path="/records/${record.id}/image?thumbnail=true" /></td>
      <td>${escapeHtml(record.originalFilename || '—')}</td>
      <td><span class="badge ${record.poseDetected ? 'badge-yes' : 'badge-no'}">${record.poseDetected ? 'Detected' : 'None'}</span></td>
      <td>${record.personCount}</td>
      <td>${record.landmarkCount}</td>
      <td>${new Date(record.createdAt).toLocaleString()}</td>
      <td>
        <button class="btn btn-small view-btn" data-id="${record.id}">View</button>
        <button class="btn btn-small btn-danger delete-btn" data-id="${record.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('img[data-image-path]').forEach((img) => {
    imageObjectUrl(img.dataset.imagePath).then((url) => { img.src = url; }).catch(() => {});
  });
  tbody.querySelectorAll('.view-btn').forEach((btn) =>
    btn.addEventListener('click', () => openDetail(btn.dataset.id))
  );
  tbody.querySelectorAll('.delete-btn').forEach((btn) =>
    btn.addEventListener('click', () => deleteRecord(btn.dataset.id))
  );

  $('#page-info').textContent = `Showing ${body.records.length ? currentOffset + 1 : 0}-${currentOffset + body.records.length} of ${body.total}`;
  $('#prev-page').disabled = currentOffset === 0;
  $('#next-page').disabled = currentOffset + PAGE_SIZE >= body.total;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function deleteRecord(id) {
  if (!confirm('Delete this record and its stored image? This cannot be undone.')) return;
  await apiFetch(`/records/${id}`, { method: 'DELETE' });
  loadRecords();
}

function setupFilters() {
  $('#search-input').addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      currentOffset = 0;
      loadRecords();
    }, 300);
  });
  $('#pose-filter').addEventListener('change', () => {
    currentOffset = 0;
    loadRecords();
  });
}

// ---------------- Detail modal ----------------

let modalRecordId = null;

async function openDetail(id) {
  const res = await apiFetch(`/records/${id}`);
  if (!res.ok) return;
  const { record } = await res.json();
  modalRecordId = id;

  $('#modal-id').textContent = record.id;
  $('#modal-detected').textContent = record.poseDetected ? 'Yes' : 'No';
  $('#modal-person-count').textContent = record.personCount;
  $('#modal-count').textContent = record.landmarkCount;
  $('#modal-filename').value = record.originalFilename || '';
  $('#modal-json').textContent = JSON.stringify(record, null, 2);

  const img = new Image();
  img.onload = () => drawPoses($('#modal-canvas'), img, record.poses);
  imageObjectUrl(`/records/${id}/image`).then((url) => { img.src = url; }).catch(() => {});

  $('#detail-modal').classList.remove('hidden');
}

function closeDetail() {
  $('#detail-modal').classList.add('hidden');
  modalRecordId = null;
}

function setupModal() {
  $('#modal-close').addEventListener('click', closeDetail);
  $('#detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'detail-modal') closeDetail();
  });

  $('#modal-rename-btn').addEventListener('click', async () => {
    if (!modalRecordId) return;
    const newName = $('#modal-filename').value;
    await apiFetch(`/records/${modalRecordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalFilename: newName }),
    });
    loadRecords();
  });

  $('#modal-delete-btn').addEventListener('click', async () => {
    if (!modalRecordId) return;
    if (!confirm('Delete this record and its stored image? This cannot be undone.')) return;
    await apiFetch(`/records/${modalRecordId}`, { method: 'DELETE' });
    closeDetail();
    loadRecords();
  });
}

// ---------------- Backup ----------------

function setupBackup() {
  $('#backup-btn').addEventListener('click', async () => {
    const btn = $('#backup-btn');
    const statusEl = $('#backup-status');
    const resultEl = $('#backup-result');
    btn.disabled = true;
    statusEl.className = 'status';
    statusEl.textContent = 'Running backup (pg_dump + mongodump + zip)… this can take a few seconds.';
    resultEl.classList.add('hidden');

    try {
      const res = await apiFetch('/backup/run', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) {
        statusEl.className = 'status error';
        statusEl.textContent = `${res.status}: ${body.message || 'Backup failed'}`;
        return;
      }
      statusEl.className = 'status success';
      statusEl.textContent = `Backup complete: ${body.result.zipPath}`;
      resultEl.textContent = JSON.stringify(body.result, null, 2);
      resultEl.classList.remove('hidden');
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Request failed: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------- Pagination ----------------

function setupPagination() {
  $('#prev-page').addEventListener('click', () => {
    currentOffset = Math.max(0, currentOffset - PAGE_SIZE);
    loadRecords();
  });
  $('#next-page').addEventListener('click', () => {
    currentOffset += PAGE_SIZE;
    loadRecords();
  });
  $('#refresh-records').addEventListener('click', () => loadRecords());
}

// ---------------- Init ----------------

setupApiKey();
checkHealth();
setupDropzone();
setupModal();
setupBackup();
setupPagination();
setupFilters();
loadRecords();
setInterval(checkHealth, 15000);
