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

const app = express();
const PORT = process.env.PORT || 3030;

// Ensure persistent directories exist
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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

// Express App Configuration
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Subpath & Reverse Proxy Prefix Normalizer (Supports /kbocvoteagent or direct root /)
app.use((req, res, next) => {
  if (req.url.startsWith('/kbocvoteagent/')) {
    req.url = req.url.substring('/kbocvoteagent'.length);
  } else if (req.url === '/kbocvoteagent') {
    return res.redirect(301, '/kbocvoteagent/');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Disk Storage Multer for Large 10L Files (avoids RAM Exhaustion on Linux servers)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'upload-' + uniqueSuffix + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 1024 * 1024 * 1024 } // Up to 1GB file size
});

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

    // Night pause
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

    // Rate strictly < 20
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

    const baseIntervalMs = Math.floor(minuteDurationMs / targetThisMinute);

    for (let k = 0; k < targetThisMinute; k++) {
      if (getEngineState() !== 'RUNNING') {
        addLog(`⏸️ Cycle #${cycleNumber} paused by user. Progress saved safely on disk.`, 'warning');
        break;
      }

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

      db.prepare(`UPDATE records SET status = 'IN_PROGRESS' WHERE id = ?`).run(rowId);
      broadcast('row_update', { id: rowId, status: 'IN_PROGRESS', data: rowData });

      const name = rowData['First Name'] || rowData[Object.keys(rowData)[0]] || `Row #${rowId}`;
      const email = rowData['Email Address'] || rowData['email'] || '';

      addLog(`[C#${cycleNumber} | Vote ${k + 1}/${targetThisMinute}] Submitting #${rowId}: ${name} (${email})...`, 'info');

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

      if (k < targetThisMinute - 1 && getEngineState() === 'RUNNING') {
        const jitterMs = Math.floor(Math.random() * 1500) - 750;
        const delayMs = Math.max(1800, baseIntervalMs + jitterMs);
        liveCycleState.nextVoteAt = Date.now() + delayMs;
        await sleep(delayMs);
      }
    }

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

// 2. High-Performance Disk Streaming Upload (Linux PM2 Optimized)
app.post('/api/upload', upload.single('file'), async (req, res) => {
  let uploadedFilePath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file received by server. Check server upload permissions or Nginx client_max_body_size.' });
    }

    uploadedFilePath = req.file.path;
    const originalName = req.file.originalname.toLowerCase();
    const fileSizeMB = (req.file.size / (1024 * 1024)).toFixed(2);
    let totalCount = 0;
    let columns = [];
    let autoMapping = {};

    addLog(`Streaming "${req.file.originalname}" (${fileSizeMB} MB) into persistent database...`, 'info');

    const insertMany = db.transaction((rows) => {
      for (const r of rows) {
        stmtInsertRecord.run(JSON.stringify(r));
      }
    });

    if (originalName.endsWith('.csv') || originalName.endsWith('.txt')) {
      const rowsBatch = [];
      const stream = fs.createReadStream(uploadedFilePath).pipe(csvParser({
        mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim() // Strip UTF-8 BOM
      }));

      for await (const chunk of stream) {
        if (columns.length === 0) {
          columns = Object.keys(chunk).map(c => c.trim());
        }
        rowsBatch.push(chunk);
        totalCount++;

        if (rowsBatch.length >= 5000) {
          insertMany(rowsBatch);
          rowsBatch.length = 0;
          if (totalCount % 50000 === 0) {
            addLog(`Indexed ${totalCount.toLocaleString()} rows into database...`, 'info');
          }
        }
      }

      if (rowsBatch.length > 0) {
        insertMany(rowsBatch);
      }
    } else {
      // Excel (.xlsx, .xls)
      const workbook = XLSX.readFile(uploadedFilePath, { cellDates: true, dense: true });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const allRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (allRows.length === 0) {
        return res.status(400).json({ error: 'Uploaded sheet contains no data rows.' });
      }

      columns = Object.keys(allRows[0]).map(c => c.replace(/^\uFEFF/, '').trim());
      totalCount = allRows.length;

      for (let i = 0; i < allRows.length; i += 5000) {
        const chunk = allRows.slice(i, i + 5000);
        insertMany(chunk);
      }
    }

    if (totalCount === 0) {
      return res.status(400).json({ error: 'File was parsed but 0 valid data rows were found. Please check column format.' });
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
    console.error('Upload Error:', err);
    addLog(`❌ Upload Processing Error: ${err.message}`, 'error');
    return res.status(500).json({ error: `Server failed to process file: ${err.message}` });
  } finally {
    // Delete temporary upload file from disk to avoid disk space bloat
    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      try { fs.unlinkSync(uploadedFilePath); } catch (e) {}
    }
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

// 6.5. Live Configuration Update (Applies instantly to running job)
app.post('/api/config', (req, res) => {
  const { config, mapping } = req.body || {};
  let currentConfig = getStoredConfig();

  if (config) {
    currentConfig = { ...currentConfig, ...config };
    saveStoredConfig(currentConfig);
  }
  if (mapping) {
    saveStoredMapping(mapping);
  }

  const nightStateStr = currentConfig.nightPauseEnabled ? 'ENABLED (11 PM – 7 AM)' : 'DISABLED (24/7 Continuous)';
  addLog(`⚙️ Configuration updated live: Auto Night Pause is now ${nightStateStr}. Pacing: ${currentConfig.minPerMinute}–${currentConfig.maxPerMinute} votes/min.`, 'info');

  broadcast('config_updated', {
    config: currentConfig,
    mapping: mapping || getStoredMapping()
  });

  return res.json({ success: true, message: 'Configuration saved and applied live.', config: currentConfig });
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

// Global Error Handler (Handles Multer errors, file size limit errors, etc.)
app.use((err, req, res, next) => {
  console.error('Express Error:', err);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large for server upload limit.' });
    }
    return res.status(400).json({ error: `Upload error (${err.code}): ${err.message}` });
  } else if (err) {
    return res.status(500).json({ error: err.message || 'Internal server error during upload.' });
  }
  next();
});

// Server binding on 0.0.0.0 for Linux servers & PM2
app.listen(PORT, '0.0.0.0', () => {
  console.log('=======================================================');
  console.log('🚀 Google Form Automation Server Started (PM2 / Linux Ready)');
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`🌐 Network binding: 0.0.0.0:${PORT}`);
  console.log(`💾 Database: ${dbPath}`);
  console.log(`📁 Uploads Temp Dir: ${UPLOADS_DIR}`);
  console.log('=======================================================');
});
