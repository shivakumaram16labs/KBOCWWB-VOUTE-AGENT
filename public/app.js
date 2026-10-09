// State
let appState = {
  status: 'IDLE',
  stats: { total: 0, completed: 0, success: 0, failed: 0, pending: 0 },
  liveCycle: {
    cycleNumber: 0,
    minuteTarget: 0,
    processedInMinute: 0,
    secondsRemaining: 0,
    nextVoteInSeconds: 0,
    currentStatus: 'IDLE'
  },
  mapping: {},
  page: 1,
  limit: 50,
  totalPages: 1,
  statusFilter: 'ALL',
  searchTerm: ''
};

// DOM Elements
const daemonPulse = document.getElementById('daemonPulse');
const daemonStatusText = document.getElementById('daemonStatusText');
const daemonPaceSubtext = document.getElementById('daemonPaceSubtext');
const btnDaemonStart = document.getElementById('btnDaemonStart');
const btnDaemonPause = document.getElementById('btnDaemonPause');
const btnDaemonResume = document.getElementById('btnDaemonResume');

const cycleNumberDisplay = document.getElementById('cycleNumberDisplay');
const secondsRemainingDisplay = document.getElementById('secondsRemainingDisplay');
const timerBarFill = document.getElementById('timerBarFill');
const nextVoteInDisplay = document.getElementById('nextVoteInDisplay');
const minuteTargetDisplay = document.getElementById('minuteTargetDisplay');
const etcDisplay = document.getElementById('etcDisplay');

const btnHeaderClear = document.getElementById('btnHeaderClear');
const btnClearFile = document.getElementById('btnClearFile');
const btnClearSheetBtn = document.getElementById('btnClearSheetBtn');

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const btnBrowseFile = document.getElementById('btnBrowseFile');
const fileMeta = document.getElementById('fileMeta');
const fileNameDisplay = document.getElementById('fileNameDisplay');
const rowCountDisplay = document.getElementById('rowCountDisplay');

const formUrlInput = document.getElementById('formUrlInput');
const cookiesInput = document.getElementById('cookiesInput');
const minPerMinute = document.getElementById('minPerMinute');
const maxPerMinute = document.getElementById('maxPerMinute');
const nightPauseToggle = document.getElementById('nightPauseToggle');
const mappingList = document.getElementById('mappingList');

const btnTestSingle = document.getElementById('btnTestSingle');
const btnExportResults = document.getElementById('btnExportResults');

const statTotal = document.getElementById('statTotal');
const statPending = document.getElementById('statPending');
const statSuccess = document.getElementById('statSuccess');
const statFailed = document.getElementById('statFailed');
const progressPercentSmall = document.getElementById('progressPercentSmall');

const progressPercent = document.getElementById('progressPercent');
const progressBarFill = document.getElementById('progressBarFill');

const dataTable = document.getElementById('dataTable');
const tableBody = document.getElementById('tableBody');
const tableCountBadge = document.getElementById('tableCountBadge');
const tablePaginationInfo = document.getElementById('tablePaginationInfo');
const pageNumberDisplay = document.getElementById('pageNumberDisplay');
const btnPrevPage = document.getElementById('btnPrevPage');
const btnNextPage = document.getElementById('btnNextPage');
const tableSearch = document.getElementById('tableSearch');
const statusFilter = document.getElementById('statusFilter');

const terminalLogs = document.getElementById('terminalLogs');
const btnClearLogs = document.getElementById('btnClearLogs');

const btnOpenDocs = document.getElementById('btnOpenDocs');
const btnCloseDocs = document.getElementById('btnCloseDocs');
const docsModal = document.getElementById('docsModal');

// Tab Switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const tabId = btn.getAttribute('data-tab');
    document.getElementById(tabId).classList.add('active');
  });
});

// Modal Controls
btnOpenDocs.addEventListener('click', () => docsModal.classList.remove('hidden'));
btnCloseDocs.addEventListener('click', () => docsModal.classList.add('hidden'));
docsModal.addEventListener('click', (e) => {
  if (e.target === docsModal) docsModal.classList.add('hidden');
});

btnClearLogs.addEventListener('click', () => {
  terminalLogs.innerHTML = '';
});

// File Upload
btnBrowseFile.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', (e) => {
  if (e.target !== btnBrowseFile) fileInput.click();
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    handleFileUpload(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFileUpload(e.target.files[0]);
  }
});

async function handleFileUpload(file) {
  const formData = new FormData();
  formData.append('file', file);

  addLogToUI(`Streaming and indexing "${file.name}" into persistent SQLite database...`, 'info');

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to upload file');

    appState.mapping = data.mapping;

    fileNameDisplay.textContent = data.fileName;
    rowCountDisplay.textContent = `${data.totalRows.toLocaleString()} records`;
    fileMeta.classList.remove('hidden');
    dropZone.classList.add('hidden');
    btnClearSheetBtn.classList.remove('hidden');

    renderMapping();
    await syncServerState();
    await fetchRecordsPage(1);

    addLogToUI(`Indexed ${data.totalRows.toLocaleString()} records into database. Ready to start background service.`, 'success');
  } catch (err) {
    alert(`Upload Error: ${err.message}`);
    addLogToUI(`Upload Error: ${err.message}`, 'error');
  }
}

// Clear Database & Reset
async function performClearAll() {
  try {
    await fetch('/api/clear-all', { method: 'POST' });
    fileInput.value = '';
    fileMeta.classList.add('hidden');
    dropZone.classList.remove('hidden');
    btnClearSheetBtn.classList.add('hidden');

    appState.stats = { total: 0, completed: 0, success: 0, failed: 0, pending: 0 };
    appState.status = 'IDLE';

    await syncServerState();
    await fetchRecordsPage(1);
    addLogToUI('Database wiped clean. Please upload your dataset.', 'info');
  } catch (err) {
    console.error(err);
  }
}

btnClearFile.addEventListener('click', performClearAll);
btnClearSheetBtn.addEventListener('click', performClearAll);
btnHeaderClear.addEventListener('click', () => {
  if (confirm('Are you sure you want to clear all data and logs from the database?')) {
    performClearAll();
  }
});

// Start / Pause / Resume Handlers
btnDaemonStart.addEventListener('click', async () => {
  if (appState.stats.total === 0) {
    alert('Please upload a dataset (CSV/Excel) first.');
    return;
  }

  const config = {
    formUrl: formUrlInput.value.trim(),
    minPerMinute: parseInt(minPerMinute.value) || 8,
    maxPerMinute: Math.min(19, parseInt(maxPerMinute.value) || 16),
    nightPauseEnabled: nightPauseToggle.checked,
    cookies: cookiesInput.value.trim()
  };

  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, mapping: appState.mapping })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    appState.status = 'RUNNING';
    updateDaemonControls();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});

btnDaemonPause.addEventListener('click', async () => {
  try {
    await fetch('/api/pause', { method: 'POST' });
    appState.status = 'PAUSED';
    updateDaemonControls();
    addLogToUI('⏸️ Service paused by user.', 'warning');
  } catch (err) {
    console.error(err);
  }
});

btnDaemonResume.addEventListener('click', async () => {
  try {
    await fetch('/api/resume', { method: 'POST' });
    appState.status = 'RUNNING';
    updateDaemonControls();
    addLogToUI('▶️ Service resumed. Continuing from exact next record.', 'success');
  } catch (err) {
    console.error(err);
  }
});

// Single Row Test
btnTestSingle.addEventListener('click', async () => {
  if (appState.stats.total === 0) {
    alert('Please upload a dataset first.');
    return;
  }
  btnTestSingle.disabled = true;
  btnTestSingle.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Testing Row #1...`;

  try {
    const res = await fetch('/api/test-single', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert(`✅ Success: ${data.message}`);
    } else {
      alert(`❌ Test Submission Failed: ${data.message}`);
    }
  } catch (err) {
    alert(`Test error: ${err.message}`);
  } finally {
    btnTestSingle.disabled = false;
    btnTestSingle.innerHTML = `<i class="fa-solid fa-vial"></i> Test 1st Row`;
  }
});

btnExportResults.addEventListener('click', () => {
  window.location.href = '/api/export?format=csv';
});

// Render Mapping Inputs
function renderMapping() {
  mappingList.innerHTML = '';
  const cols = Object.keys(appState.mapping);

  if (cols.length === 0) {
    mappingList.innerHTML = '<div class="empty-hint">Upload a dataset to review parameter mappings</div>';
    return;
  }

  cols.forEach(col => {
    const row = document.createElement('div');
    row.className = 'mapping-row';

    const label = document.createElement('div');
    label.className = 'mapping-col-name';
    label.textContent = col;
    label.title = col;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mapping-entry-input';
    input.value = appState.mapping[col] || '';
    input.placeholder = 'e.g. entry.82537205';
    input.addEventListener('change', (e) => {
      appState.mapping[col] = e.target.value.trim();
    });

    row.appendChild(label);
    row.appendChild(input);
    mappingList.appendChild(row);
  });
}

// Fetch Paginated Database Records
async function fetchRecordsPage(page = 1) {
  appState.page = page;
  try {
    const params = new URLSearchParams({
      page: appState.page,
      limit: appState.limit,
      status: appState.statusFilter,
      search: appState.searchTerm
    });

    const res = await fetch(`/api/records?${params.toString()}`);
    const data = await res.json();

    appState.totalPages = data.totalPages || 1;
    pageNumberDisplay.textContent = `${appState.page} / ${appState.totalPages}`;
    tablePaginationInfo.textContent = `Showing ${data.records.length} records (Page ${appState.page} of ${appState.totalPages})`;

    renderTableRecords(data.records);
  } catch (err) {
    console.error('Failed to fetch records:', err);
  }
}

btnPrevPage.addEventListener('click', () => {
  if (appState.page > 1) fetchRecordsPage(appState.page - 1);
});

btnNextPage.addEventListener('click', () => {
  if (appState.page < appState.totalPages) fetchRecordsPage(appState.page + 1);
});

tableSearch.addEventListener('input', (e) => {
  appState.searchTerm = e.target.value;
  fetchRecordsPage(1);
});

statusFilter.addEventListener('change', (e) => {
  appState.statusFilter = e.target.value;
  fetchRecordsPage(1);
});

function renderTableRecords(records) {
  if (!records || records.length === 0) {
    tableBody.innerHTML = `
      <tr class="placeholder-row">
        <td colspan="10" style="text-align: center; padding: 40px; color: var(--text-muted);">
          <i class="fa-solid fa-database" style="font-size: 2rem; margin-bottom: 10px; display: block;"></i>
          No records matching query in database.
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = '';
  records.forEach((row) => {
    const tr = document.createElement('tr');
    tr.id = `row-tr-${row._id}`;

    const statusBadge = getStatusBadge(row._status);
    const firstName = row['First Name'] || row['name'] || '-';
    const lastName = row['Last Name'] || '-';
    const email = row['Email Address'] || row['email'] || '-';
    const phone = row['Phone Number'] || row['phone'] || '-';
    const designation = row['Designation'] || '-';
    const city = row['City'] || '-';
    const state = row['State'] || '-';
    const msg = row._responseMessage ? `${row._statusCode || ''} ${row._responseMessage}` : '-';

    tr.innerHTML = `
      <td><strong>#${row._id}</strong></td>
      <td>${statusBadge}</td>
      <td>${escapeHtml(firstName)}</td>
      <td>${escapeHtml(lastName)}</td>
      <td>${escapeHtml(email)}</td>
      <td>${escapeHtml(phone)}</td>
      <td>${escapeHtml(designation)}</td>
      <td>${escapeHtml(city)}</td>
      <td>${escapeHtml(state)}</td>
      <td title="${escapeHtml(msg)}"><small style="color: ${row._status === 'SUCCESS' ? 'var(--success-color)' : (row._status === 'FAILED' ? 'var(--danger-color)' : 'var(--text-muted)')}">${escapeHtml(msg)}</small></td>
    `;
    tableBody.appendChild(tr);
  });
}

function getStatusBadge(status) {
  switch (status) {
    case 'SUCCESS':
      return `<span class="table-badge badge-success"><i class="fa-solid fa-check"></i> Confirmed</span>`;
    case 'FAILED':
      return `<span class="table-badge badge-failed"><i class="fa-solid fa-xmark"></i> Failed</span>`;
    case 'IN_PROGRESS':
      return `<span class="table-badge badge-in_progress"><i class="fa-solid fa-spinner fa-spin"></i> Submitting</span>`;
    default:
      return `<span class="table-badge badge-pending"><i class="fa-solid fa-hourglass-start"></i> Pending</span>`;
  }
}

// Update Controls, Timers & Metrics
function updateDaemonControls() {
  daemonPulse.className = 'live-pulse-dot';

  if (appState.status === 'RUNNING') {
    daemonPulse.classList.add('running');
    daemonStatusText.textContent = `Service Status: RUNNING (Processing 24/7 in Background)`;
    daemonPaceSubtext.textContent = `Pacing naturally across minute intervals (< 20/min). Tab can be closed safely.`;
    btnDaemonStart.classList.add('hidden');
    btnDaemonPause.classList.remove('hidden');
    btnDaemonResume.classList.add('hidden');
  } else if (appState.status === 'PAUSED') {
    daemonPulse.classList.add('paused');
    daemonStatusText.textContent = `Service Status: PAUSED`;
    daemonPaceSubtext.textContent = `Service is paused at row ${appState.stats.completed}. Click Resume whenever ready.`;
    btnDaemonStart.classList.add('hidden');
    btnDaemonPause.classList.add('hidden');
    btnDaemonResume.classList.remove('hidden');
  } else if (appState.status === 'COMPLETED') {
    daemonStatusText.textContent = `Service Status: COMPLETED (100% Processed)`;
    daemonPaceSubtext.textContent = `All records have been submitted successfully.`;
    btnDaemonStart.classList.add('hidden');
    btnDaemonPause.classList.add('hidden');
    btnDaemonResume.classList.add('hidden');
  } else {
    daemonStatusText.textContent = `Service Status: IDLE`;
    daemonPaceSubtext.textContent = `Upload a sheet and click Start Service.`;
    btnDaemonStart.classList.remove('hidden');
    btnDaemonPause.classList.add('hidden');
    btnDaemonResume.classList.add('hidden');
  }

  // Update Timers & Cycle Gauge
  if (appState.liveCycle && appState.status === 'RUNNING') {
    cycleNumberDisplay.textContent = `Cycle #${appState.liveCycle.cycleNumber || 1}`;
    secondsRemainingDisplay.textContent = `${appState.liveCycle.secondsRemaining || 0}s`;

    const pct = Math.max(0, Math.min(100, (1 - (appState.liveCycle.secondsRemaining / 60)) * 100));
    timerBarFill.style.width = `${pct}%`;

    if (parseFloat(appState.liveCycle.nextVoteInSeconds) > 0) {
      nextVoteInDisplay.textContent = `${appState.liveCycle.nextVoteInSeconds}s`;
    } else {
      nextVoteInDisplay.textContent = `Active`;
    }

    minuteTargetDisplay.textContent = `${appState.liveCycle.processedInMinute || 0} / ${appState.liveCycle.minuteTarget || 0} votes`;
  } else if (appState.status === 'PAUSED') {
    secondsRemainingDisplay.textContent = `Paused`;
    nextVoteInDisplay.textContent = `Paused`;
    timerBarFill.style.width = `0%`;
  } else {
    cycleNumberDisplay.textContent = `Cycle #0`;
    secondsRemainingDisplay.textContent = `--s`;
    nextVoteInDisplay.textContent = `--`;
    minuteTargetDisplay.textContent = `0 / 0 votes`;
    timerBarFill.style.width = `0%`;
  }

  // Update Counters
  statTotal.textContent = (appState.stats.total || 0).toLocaleString();
  statSuccess.textContent = (appState.stats.success || 0).toLocaleString();
  statFailed.textContent = (appState.stats.failed || 0).toLocaleString();
  statPending.textContent = (appState.stats.pending || 0).toLocaleString();
  tableCountBadge.textContent = (appState.stats.total || 0).toLocaleString();

  const total = appState.stats.total || 0;
  const completed = appState.stats.completed || 0;
  const percent = total > 0 ? ((completed / total) * 100).toFixed(1) : '0.0';
  progressPercent.textContent = `${percent}%`;
  progressPercentSmall.textContent = `${percent}%`;
  progressBarFill.style.width = `${percent}%`;

  // Calculate Estimated Time Remaining (ETC)
  if (appState.stats.pending > 0 && appState.status === 'RUNNING') {
    const avgPerMin = Math.max(6, appState.liveCycle.minuteTarget || 12);
    const minutesLeft = Math.ceil(appState.stats.pending / avgPerMin);
    if (minutesLeft > 1440) {
      etcDisplay.textContent = `~${(minutesLeft / 1440).toFixed(1)} days`;
    } else if (minutesLeft > 60) {
      etcDisplay.textContent = `~${(minutesLeft / 60).toFixed(1)} hrs`;
    } else {
      etcDisplay.textContent = `~${minutesLeft} mins`;
    }
  } else if (appState.stats.pending === 0 && total > 0) {
    etcDisplay.textContent = `Done`;
  } else {
    etcDisplay.textContent = `--`;
  }
}

// Add Log Entry
function addLogToUI(message, type = 'info', timestamp = null) {
  const time = timestamp || new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = `log-entry log-${type}`;
  div.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-text">${escapeHtml(message)}</span>`;
  terminalLogs.appendChild(div);
  terminalLogs.scrollTop = terminalLogs.scrollHeight;
}

// Sync full state from server (even on tab reopen!)
async function syncServerState() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    appState.status = data.status;
    appState.stats = data.stats;
    appState.mapping = data.mapping || {};
    appState.liveCycle = data.liveCycle || {};

    if (data.config) {
      if (data.config.formUrl) formUrlInput.value = data.config.formUrl;
      if (data.config.minPerMinute) minPerMinute.value = data.config.minPerMinute;
      if (data.config.maxPerMinute) maxPerMinute.value = data.config.maxPerMinute;
      if (data.config.nightPauseEnabled) nightPauseToggle.checked = data.config.nightPauseEnabled;
      if (data.config.cookies) cookiesInput.value = data.config.cookies;
    }

    if (data.logs && data.logs.length > 0 && terminalLogs.children.length <= 1) {
      terminalLogs.innerHTML = '';
      data.logs.forEach(l => addLogToUI(l.message, l.type, l.timestamp));
    }

    renderMapping();
    updateDaemonControls();
  } catch (err) {
    console.error('Failed to sync state:', err);
  }
}

// Server-Sent Events (SSE) Listener for Real-Time UI Updates
function initSSE() {
  const eventSource = new EventSource('/api/events');

  eventSource.addEventListener('log', (e) => {
    const logItem = JSON.parse(e.data);
    addLogToUI(logItem.message, logItem.type, logItem.timestamp);
  });

  eventSource.addEventListener('cycle_tick', (e) => {
    const cycleInfo = JSON.parse(e.data);
    appState.liveCycle = cycleInfo;
    updateDaemonControls();
  });

  eventSource.addEventListener('minute_start', (e) => {
    const cycleInfo = JSON.parse(e.data);
    appState.liveCycle = cycleInfo;
    updateDaemonControls();
  });

  eventSource.addEventListener('row_update', (e) => {
    const updated = JSON.parse(e.data);
    const tr = document.getElementById(`row-tr-${updated.id}`);
    if (tr) {
      const statusTd = tr.querySelector('td:nth-child(2)');
      const msgTd = tr.querySelector('td:nth-child(10)');
      if (statusTd) statusTd.innerHTML = getStatusBadge(updated.status);
      if (msgTd) {
        const msg = updated.responseMessage ? `${updated.statusCode || ''} ${updated.responseMessage}` : '-';
        msgTd.innerHTML = `<small style="color: ${updated.status === 'SUCCESS' ? 'var(--success-color)' : (updated.status === 'FAILED' ? 'var(--danger-color)' : 'var(--text-muted)')}">${escapeHtml(msg)}</small>`;
      }
    }
  });

  eventSource.addEventListener('stats_update', (e) => {
    const stats = JSON.parse(e.data);
    appState.stats = {
      total: stats.total || 0,
      completed: (stats.success || 0) + (stats.failed || 0),
      success: stats.success || 0,
      failed: stats.failed || 0,
      pending: stats.pending || 0
    };
    updateDaemonControls();
  });

  eventSource.addEventListener('state_change', (e) => {
    const { status } = JSON.parse(e.data);
    appState.status = status;
    updateDaemonControls();
  });

  eventSource.addEventListener('job_complete', () => {
    appState.status = 'COMPLETED';
    updateDaemonControls();
  });

  eventSource.addEventListener('state_cleared', () => {
    appState.status = 'IDLE';
    appState.stats = { total: 0, completed: 0, success: 0, failed: 0, pending: 0 };
    updateDaemonControls();
    fetchRecordsPage(1);
  });

  eventSource.onerror = () => {
    console.warn('SSE reconnecting...');
  };
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

window.addEventListener('DOMContentLoaded', async () => {
  initSSE();
  await syncServerState();
  await fetchRecordsPage(1);
});
