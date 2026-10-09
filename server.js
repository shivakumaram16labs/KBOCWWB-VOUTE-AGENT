const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const csvParser = require('csv-parser');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3030;

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize SQLite Persistent Database
const dbPath = path.join(DATA_DIR, 'votes.db');
const db = new Database(dbPath);

// Enable WAL mode for high concurrency
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Database Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_json TEXT NOT NULL,
    status TEXT DEFAULT 'PENDING',
    status_code INTEGER,
    response_message TEXT,
    submitted_at TEXT,
    fbzx_used TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
  CREATE INDEX IF NOT EXISTS idx_records_id ON records(id);

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT,
    message TEXT,
    type TEXT
  );
`);

// Prepared Statements
const stmtGetConfig = db.prepare(`SELECT value FROM config WHERE key = ?`);
const stmtSetConfig = db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`);
const stmtInsertRecord = db.prepare(`INSERT INTO records (raw_json, status) VALUES (?, 'PENDING')`);
const stmtGetNextPending = db.prepare(`SELECT * FROM records WHERE status = 'PENDING' ORDER BY id ASC LIMIT 1`);
const stmtUpdateRecord = db.prepare(`UPDATE records SET status = ?, status_code = ?, response_message = ?, submitted_at = ?, fbzx_used = ? WHERE id = ?`);
const stmtGetStats = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) as success,
    SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
    SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN status = 'IN_PROGRESS' THEN 1 ELSE 0 END) as in_progress
  FROM records
`);
const stmtInsertLog = db.prepare(`INSERT INTO logs (timestamp, message, type) VALUES (?, ?, ?)`);
const stmtGetRecentLogs = db.prepare(`SELECT * FROM logs ORDER BY id DESC LIMIT 200`);
const stmtClearAll = db.transaction(() => {
  db.prepare(`DELETE FROM records`).run();
  db.prepare(`DELETE FROM logs`).run();
  db.prepare(`DELETE FROM sqlite_sequence WHERE name='records' OR name='logs'`).run();
});

// Default Configuration (< 20 votes/min strictly)
const DEFAULT_CONFIG = {
  formUrl: "https://docs.google.com/forms/u/0/d/e/1FAIpQLScXCqBHNMtSaXLzid7I4PftgY31PidN6s7hO9hI56zdfB8-Wg/formResponse?embedded=true",
  cookies: "",
  dynamicFbzx: true,
  minPerMinute: 8,   // Random count between 8 and 16 (< 20)
  maxPerMinute: 16,  // Strictly < 20 votes per minute
  nightPauseEnabled: false,
  nightPauseStart: 23, // 11 PM
  nightPauseEnd: 7,    // 7 AM
  maxRetries: 2
};

const DEFAULT_MAPPING = {
  "First Name": "entry.82537205",
  "Last Name": "entry.699138706",
  "Designation": "entry.1578616250",
  "Email Address": "entry.1423769822",
  "Organization Type": "entry.524309291",
  "City": "entry.726699506",
  "Phone Number": "entry.609066048",
  "Category / ID": "entry.108996083",
  "Terms Acceptance": "entry.2122580329",
  "Nominee / Project / Scheme": "entry.18465063",
  "State": "entry.1058025205"
};

function getStoredConfig() {
  const row = stmtGetConfig.get('config');
  if (row && row.value) {
    try { return JSON.parse(row.value); } catch (e) {}
  }
  return { ...DEFAULT_CONFIG };
}

function saveStoredConfig(cfg) {
  stmtSetConfig.run('config', JSON.stringify(cfg));
}

function getStoredMapping() {
  const row = stmtGetConfig.get('mapping');
  if (row && row.value) {
    try { return JSON.parse(row.value); } catch (e) {}
  }
  return { ...DEFAULT_MAPPING };
}

function saveStoredMapping(mapping) {
  stmtSetConfig.run('mapping', JSON.stringify(mapping));
}

function getEngineState() {
  const row = stmtGetConfig.get('engine_status');
  return row ? row.value : 'IDLE'; // IDLE, RUNNING, PAUSED, COMPLETED
}

function setEngineState(state) {
  stmtSetConfig.run('engine_status', state);
}

// Express App
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ limits: { fileSize: 500 * 1024 * 1024 } });

// Server-Sent Events clients
let sseClients = [];

function broadcast(event, data) {
  sseClients.forEach(client => {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {}
  });
}

function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  stmtInsertLog.run(timestamp, message, type);
  broadcast('log', { timestamp, message, type });
}

// Token Caching
let cachedFbzx = null;
let cachedFbzxTime = 0;

function normalizeFormUrls(url) {
  let formResponseUrl = url.trim();
  let viewformUrl = url.trim();

  if (formResponseUrl.includes('/viewform')) {
    formResponseUrl = formResponseUrl.replace('/viewform', '/formResponse');
  } else if (!formResponseUrl.includes('/formResponse')) {
    formResponseUrl = formResponseUrl.replace(/\/$/, '') + '/formResponse';
  }

  if (viewformUrl.includes('/formResponse')) {
    viewformUrl = viewformUrl.replace('/formResponse', '/viewform');
  } else if (!viewformUrl.includes('/viewform')) {
    viewformUrl = viewformUrl.replace(/\/$/, '') + '/viewform';
  }

  return { formResponseUrl, viewformUrl };
}

async function getOrFetchFbzxToken(viewformUrl, cookies = '', forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedFbzx && (now - cachedFbzxTime < 300000)) {
    return cachedFbzx;
  }

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    if (cookies) headers['Cookie'] = cookies;

    const res = await axios.get(viewformUrl, { headers, timeout: 8000 });
    const $ = cheerio.load(res.data);
    let fbzx = $('input[name="fbzx"]').val();
    
    if (!fbzx) {
      const match = res.data.match(/\[null,null,"(-?\d+)"\]/);
      if (match && match[1]) fbzx = match[1];
    }

    if (fbzx) {
      cachedFbzx = fbzx;
      cachedFbzxTime = now;
      return fbzx;
    }
  } catch (err) {}

  return cachedFbzx || "-5957270695485461168";
}

// Resilient Field Matcher & Form Submitter
async function submitGoogleFormRow(row, config, mapping) {
  const { formResponseUrl, viewformUrl } = normalizeFormUrls(config.formUrl);
  
  let fbzx = "-5957270695485461168";
  if (config.dynamicFbzx) {
    fbzx = await getOrFetchFbzxToken(viewformUrl, config.cookies);
  }

  const payload = new URLSearchParams();
  const sentinelFields = new Set();

  for (const [colName, entryId] of Object.entries(mapping)) {
    if (!entryId || !entryId.startsWith('entry.')) continue;
    
    // Case-insensitive, whitespace-trimmed field value lookup
    let val = row[colName];
    if (val === undefined || val === null || val === '') {
      const lowerCol = colName.toLowerCase().trim();
      const matchedKey = Object.keys(row).find(k => k.toLowerCase().trim() === lowerCol);
      if (matchedKey) val = row[matchedKey];
    }

    if (val === undefined || val === null) val = '';
    val = String(val).trim();
    payload.append(entryId, val);
    sentinelFields.add(`${entryId}_sentinel`);
  }

  sentinelFields.forEach(sentinel => {
    payload.append(sentinel, '');
  });

  payload.append('fvv', '1');
  payload.append('partialResponse', `[null,null,"${fbzx}"]`);
  payload.append('pageHistory', '0');
  payload.append('fbzx', fbzx);
  payload.append('dsdoc', 'true');
  payload.append('submissionTimestamp', Date.now().toString());

  const headers = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'content-type': 'application/x-www-form-urlencoded',
    'origin': 'https://docs.google.com',
    'pragma': 'no-cache',
    'referer': viewformUrl,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'sec-fetch-dest': 'iframe',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin'
  };

  if (config.cookies && config.cookies.trim() !== '') {
    headers['Cookie'] = config.cookies.trim();
  }

  const response = await axios.post(formResponseUrl, payload.toString(), {
    headers,
    timeout: 15000,
    validateStatus: () => true
  });

  const responseText = String(response.data || '');
  
  const isRecorded = 
    responseText.includes('Your vote has been received') ||
    responseText.includes('vote has been received') ||
    responseText.includes('Your response has been recorded') ||
    responseText.includes('response has been recorded') ||
    responseText.includes('freebirdFormviewerViewResponseConfirmationMessage') ||
    (response.status === 200 && responseText.includes('FB_PUBLIC_LOAD_DATA_') && !responseText.includes('freebirdFormviewerComponentsQuestionBaseErrorText'));

  if (response.status === 200 && isRecorded) {
    return {
      success: true,
      statusCode: response.status,
      message: 'Vote / Response recorded successfully',
      fbzx
    };
  } else if (response.status === 429) {
    return {
      success: false,
      statusCode: response.status,
      message: 'Google Rate Limit (HTTP 429)',
      fbzx
    };
  } else if (responseText.includes('captcha') || responseText.includes('recaptcha')) {
    return {
      success: false,
      statusCode: response.status,
      message: 'Google CAPTCHA challenge detected',
      fbzx
    };
  } else {
    return {
      success: false,
      statusCode: response.status,
      message: `Form rejected submission (HTTP ${response.status})`,
      fbzx
    };
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==================== LIVE MINUTE CYCLE TRACKER ====================
let cycleNumber = 0;
let liveCycleState = {
  cycleNumber: 0,
  minuteTarget: 0,
  processedInMinute: 0,
  minuteStart: null,
  minuteEnd: null,
  secondsRemaining: 60,
  nextVoteInSeconds: 0,
  currentStatus: 'IDLE'
};

// Background heartbeat to broadcast live countdown every 1 second
setInterval(() => {
  const engineState = getEngineState();
  liveCycleState.currentStatus = engineState;

  if (engineState === 'RUNNING' && liveCycleState.minuteEnd) {
    const now = Date.now();
    const remainingMs = Math.max(0, liveCycleState.minuteEnd - now);
    liveCycleState.secondsRemaining = Math.ceil(remainingMs / 1000);

    if (liveCycleState.nextVoteAt) {
      const nextMs = Math.max(0, liveCycleState.nextVoteAt - now);
      liveCycleState.nextVoteInSeconds = (nextMs / 1000).toFixed(1);
    } else {
      liveCycleState.nextVoteInSeconds = 0;
    }
  } else {
    liveCycleState.secondsRemaining = 0;
    liveCycleState.nextVoteInSeconds = 0;
  }

  broadcast('cycle_tick', liveCycleState);
}, 1000);

// ==================== BACKGROUND HUMANISTIC DAEMON ENGINE ====================
let isDaemonLoopActive = false;

async function backgroundDaemonLoop() {
  if (isDaemonLoopActive) return;
  isDaemonLoopActive = true;

  while (true) {
    const currentState = getEngineState();

    if (currentState !== 'RUNNING') {
      await sleep(1500);
      continue;
    }

    const config = getStoredConfig();
    const mapping = getStoredMapping();

    // Check optional night auto-pause
    if (config.nightPauseEnabled) {
      const currentHour = new Date().getHours();
      const isNight = (config.nightPauseStart > config.nightPauseEnd)
        ? (currentHour >= config.nightPauseStart || currentHour < config.nightPauseEnd)
        : (currentHour >= config.nightPauseStart && currentHour < config.nightPauseEnd);

      if (isNight) {
        addLog(`🌙 Night auto-pause active (${currentHour}:00). Sleeping until morning...`, 'warning');
        await sleep(60000);
        continue;
      }
    }

    // 1. Calculate humanistic count for this 1-minute window strictly < 20
    const minCount = Math.max(1, Math.min(18, parseInt(config.minPerMinute) || 8));
    const maxCount = Math.max(minCount, Math.min(19, parseInt(config.maxPerMinute) || 16));
    const targetThisMinute = Math.floor(Math.random() * (maxCount - minCount + 1)) + minCount;

    cycleNumber++;
    const minuteDurationMs = 60000;
    const now = Date.now();

    liveCycleState = {
      cycleNumber,
      minuteTarget: targetThisMinute,
      processedInMinute: 0,
      minuteStart: now,
      minuteEnd: now + minuteDurationMs,
      secondsRemaining: 60,
      nextVoteAt: now,
      nextVoteInSeconds: 0,
      currentStatus: 'RUNNING'
    };

    addLog(`⏱️ [Cycle #${cycleNumber}] Starting 60s window: Target = ${targetThisMinute} votes (< 20/min naturally spread across 60 seconds)`, 'info');
    broadcast('minute_start', liveCycleState);

    // 2. Schedule natural random second intervals across 60 seconds
    const baseIntervalMs = Math.floor(minuteDurationMs / targetThisMinute);

    for (let k = 0; k < targetThisMinute; k++) {
      // Check if paused or stopped in between seconds
      if (getEngineState() !== 'RUNNING') {
        addLog(`⏸️ Cycle #${cycleNumber} paused by user. Progress saved safely on disk.`, 'warning');
        break;
      }

      // Fetch next pending record from SQLite
      const rowRecord = stmtGetNextPending.get();
      if (!rowRecord) {
        setEngineState('COMPLETED');
        addLog(`🎉 All records in the database completed! Total 100% processed.`, 'success');
        broadcast('job_complete', { stats: stmtGetStats.get() });
        break;
      }

      const rowId = rowRecord.id;
      let rowData = {};
      try { rowData = JSON.parse(rowRecord.raw_json); } catch (e) {}

      // Mark IN_PROGRESS
      db.prepare(`UPDATE records SET status = 'IN_PROGRESS' WHERE id = ?`).run(rowId);
      broadcast('row_update', { id: rowId, status: 'IN_PROGRESS', data: rowData });

      const name = rowData['First Name'] || rowData[Object.keys(rowData)[0]] || `Row #${rowId}`;
      const email = rowData['Email Address'] || rowData['email'] || '';

      addLog(`[C#${cycleNumber} | Vote ${k + 1}/${targetThisMinute}] Submitting #${rowId}: ${name} (${email})...`, 'info');

      // Submit
      let result = null;
      let retries = 0;
      while (retries <= config.maxRetries) {
        try {
          result = await submitGoogleFormRow(rowData, config, mapping);
          if (result.success) break;
        } catch (err) {
          result = { success: false, statusCode: 500, message: err.message };
        }
        retries++;
        if (retries <= config.maxRetries && getEngineState() === 'RUNNING') {
          await sleep(2000);
        }
      }

      const status = result.success ? 'SUCCESS' : 'FAILED';
      stmtUpdateRecord.run(
        status,
        result.statusCode,
        result.message,
        new Date().toISOString(),
        result.fbzx || '',
        rowId
      );

      liveCycleState.processedInMinute++;

      if (result.success) {
        addLog(`✅ [#${rowId}] ${name}: ${result.message} (${liveCycleState.processedInMinute}/${targetThisMinute} in this minute)`, 'success');
      } else {
        addLog(`❌ [#${rowId}] ${name}: ${result.message} (${result.statusCode})`, 'error');
      }

      broadcast('row_update', {
        id: rowId,
        status,
        statusCode: result.statusCode,
        responseMessage: result.message,
        submittedAt: new Date().toISOString()
      });
      broadcast('stats_update', stmtGetStats.get());

      // Humanistic interval between votes
      if (k < targetThisMinute - 1 && getEngineState() === 'RUNNING') {
        const jitterMs = Math.floor(Math.random() * 1500) - 750;
        const delayMs = Math.max(1800, baseIntervalMs + jitterMs);
        liveCycleState.nextVoteAt = Date.now() + delayMs;
        await sleep(delayMs);
      }
    }

    // If minute ended before 60 seconds, sleep remaining ms until next cycle starts
    const elapsed = Date.now() - liveCycleState.minuteStart;
    if (elapsed < minuteDurationMs && getEngineState() === 'RUNNING') {
      const waitRemainingMs = minuteDurationMs - elapsed;
      addLog(`🏁 [Cycle #${cycleNumber} Finished] ${liveCycleState.processedInMinute}/${targetThisMinute} votes completed. Next minute window starting in ${(waitRemainingMs/1000).toFixed(0)}s...`, 'info');
      await sleep(waitRemainingMs);
    }
  }
}

// Start daemon loop on boot
backgroundDaemonLoop().catch(err => console.error('Daemon Error:', err));

// ==================== REST API ENDPOINTS ====================

// 1. Templates
app.get('/api/template/excel', (req, res) => {
  const file = path.join(__dirname, 'template_form_data.xlsx');
  res.download(file, 'google_form_voting_template.xlsx');
});

app.get('/api/template/csv', (req, res) => {
  const file = path.join(__dirname, 'template_form_data.csv');
  res.download(file, 'google_form_voting_template.csv');
});

// 2. Stream Upload
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const originalName = req.file.originalname.toLowerCase();
    let totalCount = 0;
    let columns = [];
    let autoMapping = {};

    addLog(`Streaming and indexing "${req.file.originalname}" into persistent database...`, 'info');

    const insertMany = db.transaction((rows) => {
      for (const r of rows) {
        stmtInsertRecord.run(JSON.stringify(r));
      }
    });

    if (originalName.endsWith('.csv')) {
      const rowsBatch = [];
      const stream = Readable.from(req.file.buffer).pipe(csvParser());

      for await (const chunk of stream) {
        if (columns.length === 0) {
          columns = Object.keys(chunk).map(c => c.trim());
        }
        rowsBatch.push(chunk);
        totalCount++;

        if (rowsBatch.length >= 5000) {
          insertMany(rowsBatch);
          rowsBatch.length = 0;
        }
      }

      if (rowsBatch.length > 0) {
        insertMany(rowsBatch);
      }
    } else {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const allRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (allRows.length === 0) {
        return res.status(400).json({ error: 'Uploaded sheet contains no data rows.' });
      }

      columns = Object.keys(allRows[0]).map(c => c.trim());
      totalCount = allRows.length;

      for (let i = 0; i < allRows.length; i += 5000) {
        const chunk = allRows.slice(i, i + 5000);
        insertMany(chunk);
      }
    }

    const defaultMap = getStoredMapping();
    columns.forEach(col => {
      if (defaultMap[col]) {
        autoMapping[col] = defaultMap[col];
      } else {
        const foundKey = Object.keys(defaultMap).find(k => 
          k.toLowerCase().trim() === col.toLowerCase().trim()
        );
        autoMapping[col] = foundKey ? defaultMap[foundKey] : '';
      }
    });

    saveStoredMapping(autoMapping);
    setEngineState('IDLE');

    addLog(`✅ Successfully loaded & indexed ${totalCount.toLocaleString()} records from "${req.file.originalname}". Ready to start.`, 'success');

    return res.json({
      success: true,
      fileName: req.file.originalname,
      totalRows: totalCount,
      columns,
      mapping: autoMapping
    });
  } catch (err) {
    return res.status(500).json({ error: `Upload error: ${err.message}` });
  }
});

// 3. Paginated Records API
app.get('/api/records', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const status = req.query.status || 'ALL';
  const search = (req.query.search || '').trim();

  let query = `SELECT * FROM records`;
  let countQuery = `SELECT COUNT(*) as cnt FROM records`;
  const conditions = [];
  const params = [];

  if (status !== 'ALL') {
    conditions.push(`status = ?`);
    params.push(status);
  }

  if (search) {
    conditions.push(`raw_json LIKE ?`);
    params.push(`%${search}%`);
  }

  if (conditions.length > 0) {
    const whereClause = ` WHERE ` + conditions.join(' AND ');
    query += whereClause;
    countQuery += whereClause;
  }

  query += ` ORDER BY id ASC LIMIT ? OFFSET ?`;

  const totalCount = db.prepare(countQuery).get(...params).cnt;
  const rows = db.prepare(query).all(...params, limit, offset);

  const parsedRows = rows.map(r => {
    let data = {};
    try { data = JSON.parse(r.raw_json); } catch (e) {}
    return {
      _id: r.id,
      _status: r.status,
      _statusCode: r.status_code,
      _responseMessage: r.response_message,
      _submittedAt: r.submitted_at,
      _fbzxUsed: r.fbzx_used,
      ...data
    };
  });

  return res.json({
    total: totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit) || 1,
    records: parsedRows
  });
});

// 4. Start / Resume
app.post('/api/start', (req, res) => {
  const stats = stmtGetStats.get();
  if (stats.total === 0) {
    return res.status(400).json({ error: 'No records in database. Please upload a dataset first.' });
  }

  const { config, mapping } = req.body || {};
  if (config) {
    const existing = getStoredConfig();
    saveStoredConfig({ ...existing, ...config });
  }
  if (mapping) {
    saveStoredMapping(mapping);
  }

  setEngineState('RUNNING');
  addLog(`▶️ Background humanistic service STARTED. Submitting naturally at < 20 votes/minute...`, 'success');
  broadcast('state_change', { status: 'RUNNING' });

  return res.json({ success: true, message: 'Automation running in background', status: 'RUNNING' });
});

// 5. Pause
app.post('/api/pause', (req, res) => {
  setEngineState('PAUSED');
  addLog(`⏸️ Background service PAUSED. You can close the tab or resume anytime.`, 'warning');
  broadcast('state_change', { status: 'PAUSED' });
  return res.json({ success: true, message: 'Automation paused', status: 'PAUSED' });
});

// 6. Resume
app.post('/api/resume', (req, res) => {
  setEngineState('RUNNING');
  addLog(`▶️ Background service RESUMED. Continuing from exact next record...`, 'success');
  broadcast('state_change', { status: 'RUNNING' });
  return res.json({ success: true, message: 'Automation resumed', status: 'RUNNING' });
});

// 7. Clear All
app.post('/api/clear-all', (req, res) => {
  setEngineState('IDLE');
  stmtClearAll();
  cachedFbzx = null;
  cachedFbzxTime = 0;
  cycleNumber = 0;
  liveCycleState = {
    cycleNumber: 0,
    minuteTarget: 0,
    processedInMinute: 0,
    minuteStart: null,
    minuteEnd: null,
    secondsRemaining: 0,
    nextVoteInSeconds: 0,
    currentStatus: 'IDLE'
  };
  addLog(`🧹 All records and logs purged from database. Ready for a fresh sheet.`, 'info');
  broadcast('state_cleared', {});
  return res.json({ success: true, message: 'Database wiped clean.' });
});

// 8. Test Single Row
app.post('/api/test-single', async (req, res) => {
  try {
    const firstRowRecord = db.prepare(`SELECT * FROM records ORDER BY id ASC LIMIT 1`).get();
    if (!firstRowRecord) {
      return res.status(400).json({ success: false, message: 'No records to test.' });
    }
    const rowData = JSON.parse(firstRowRecord.raw_json);
    const config = getStoredConfig();
    const mapping = getStoredMapping();

    addLog(`🧪 Testing submission on Row #1 (${rowData['First Name'] || 'Test'})...`, 'info');
    const result = await submitGoogleFormRow(rowData, config, mapping);

    if (result.success) {
      addLog(`✅ Single test submission successful: ${result.message}`, 'success');
    } else {
      addLog(`❌ Single test submission failed: ${result.message} (${result.statusCode})`, 'error');
    }

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 9. Full Engine Status
app.get('/api/status', (req, res) => {
  const stats = stmtGetStats.get();
  const config = getStoredConfig();
  const mapping = getStoredMapping();
  const engineStatus = getEngineState();
  const recentLogs = stmtGetRecentLogs.all().reverse();

  return res.json({
    status: engineStatus,
    stats: {
      total: stats.total || 0,
      completed: (stats.success || 0) + (stats.failed || 0),
      success: stats.success || 0,
      failed: stats.failed || 0,
      pending: stats.pending || 0,
      in_progress: stats.in_progress || 0
    },
    config,
    mapping,
    liveCycle: liveCycleState,
    logs: recentLogs
  });
});

// 10. SSE Stream
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  const client = { id: clientId, res };
  sseClients.push(client);

  const stats = stmtGetStats.get();
  res.write(`data: ${JSON.stringify({
    type: 'connected',
    status: getEngineState(),
    stats: {
      total: stats.total || 0,
      completed: (stats.success || 0) + (stats.failed || 0),
      success: stats.success || 0,
      failed: stats.failed || 0,
      pending: stats.pending || 0
    },
    liveCycle: liveCycleState
  })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// 11. Results Export
app.get('/api/export', (req, res) => {
  const format = (req.query.format || 'csv').toLowerCase();
  const rows = db.prepare(`SELECT * FROM records ORDER BY id ASC`).all();

  if (rows.length === 0) {
    return res.status(400).json({ error: 'No records to export.' });
  }

  const exportData = rows.map(r => {
    let data = {};
    try { data = JSON.parse(r.raw_json); } catch (e) {}
    return {
      "Record ID": r.id,
      "Submission Status": r.status,
      "HTTP Status": r.status_code || '',
      "Submission Message": r.response_message || '',
      "Timestamp": r.submitted_at || '',
      ...data
    };
  });

  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Submissions");

  if (format === 'csv') {
    const csvContent = XLSX.utils.sheet_to_csv(ws);
    res.setHeader('Content-Disposition', 'attachment; filename="vote_automation_results.csv"');
    res.setHeader('Content-Type', 'text/csv');
    res.send(csvContent);
  } else {
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="vote_automation_results.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  }
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Google Form Humanistic Background Automation Server`);
  console.log(`🌐 Running on http://localhost:${PORT}`);
  console.log(`⏳ Strictly < 20 votes/minute natural humanistic pacing`);
  console.log(`⏱️ Live Minute Countdown Timers & Cycle Trackers Active`);
  console.log(`=======================================================`);
});
