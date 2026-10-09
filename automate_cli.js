#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const axios = require('axios');
const cheerio = require('cheerio');

const DEFAULT_FORM_URL = "https://docs.google.com/forms/u/0/d/e/1FAIpQLScXCqBHNMtSaXLzid7I4PftgY31PidN6s7hO9hI56zdfB8-Wg/formResponse?embedded=true";

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

function normalizeUrls(url) {
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

let cachedFbzx = null;

async function fetchFbzx(viewformUrl, cookies) {
  if (cachedFbzx) return cachedFbzx;
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    if (cookies) headers['Cookie'] = cookies;
    const res = await axios.get(viewformUrl, { headers, timeout: 10000 });
    const $ = cheerio.load(res.data);
    const fbzx = $('input[name="fbzx"]').val();
    if (fbzx) {
      cachedFbzx = fbzx;
      return fbzx;
    }
  } catch (err) {}
  return "-5957270695485461168";
}

async function submitRow(row, formUrl, cookies) {
  const { formResponseUrl, viewformUrl } = normalizeUrls(formUrl);
  const fbzx = await fetchFbzx(viewformUrl, cookies);

  const payload = new URLSearchParams();
  const sentinelFields = new Set();

  for (const [colName, entryId] of Object.entries(DEFAULT_MAPPING)) {
    let val = row[colName];
    if (val === undefined || val === null) val = '';
    val = String(val).trim();
    payload.append(entryId, val);
    sentinelFields.add(`${entryId}_sentinel`);
  }

  sentinelFields.forEach(s => payload.append(s, ''));

  payload.append('fvv', '1');
  payload.append('partialResponse', `[null,null,"${fbzx}"]`);
  payload.append('pageHistory', '0');
  payload.append('fbzx', fbzx);
  payload.append('dsdoc', 'true');
  payload.append('submissionTimestamp', Date.now().toString());

  const headers = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'content-type': 'application/x-www-form-urlencoded',
    'origin': 'https://docs.google.com',
    'referer': viewformUrl,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  };

  if (cookies) headers['Cookie'] = cookies;

  try {
    const res = await axios.post(formResponseUrl, payload.toString(), {
      headers,
      timeout: 15000,
      validateStatus: () => true
    });
    const text = String(res.data || '');
    const isRecorded = text.includes('Your vote has been received') ||
                       text.includes('vote has been received') ||
                       text.includes('recorded') ||
                       text.includes('freebirdFormviewerViewResponseConfirmationMessage') ||
                       res.status === 200;
    return {
      success: isRecorded,
      statusCode: res.status,
      message: isRecorded ? 'Vote / Response received successfully' : `HTTP ${res.status}`
    };
  } catch (err) {
    return { success: false, statusCode: 500, message: err.message };
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  const filePath = process.argv[2] || path.join(__dirname, 'template_form_data.xlsx');
  const concurrency = parseInt(process.argv[3]) || 5;

  console.log(`\n🚀 High-Speed Node.js Google Form Automation CLI`);
  console.log(`📁 Target File: ${filePath}`);
  console.log(`⚡ Parallel Workers: ${concurrency}`);

  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  const workbook = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
  console.log(`📊 Loaded ${rows.length} rows to submit in parallel.\n`);

  const results = new Array(rows.length);
  let successCount = 0;
  let failCount = 0;
  let completedCount = 0;
  let queue = rows.map((r, i) => ({ row: r, index: i }));

  async function worker(workerId) {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { row, index } = item;
      const name = row['First Name'] || row['name'] || `Record #${index + 1}`;

      const res = await submitRow(row, DEFAULT_FORM_URL, '');
      results[index] = { ...row, _status: res.success ? 'SUCCESS' : 'FAILED', _code: res.statusCode, _msg: res.message };

      completedCount++;
      if (res.success) {
        successCount++;
        console.log(`[W${workerId}] [${completedCount}/${rows.length}] ✅ #${index + 1} ${name}: Success`);
      } else {
        failCount++;
        console.log(`[W${workerId}] [${completedCount}/${rows.length}] ❌ #${index + 1} ${name}: Failed (${res.message})`);
      }

      await sleep(100);
    }
  }

  const workers = [];
  for (let w = 1; w <= concurrency; w++) {
    workers.push(worker(w));
  }

  await Promise.all(workers);

  console.log(`\n🎉 Finished! Total: ${rows.length} | Success: ${successCount} | Failed: ${failCount}`);
  const outWs = XLSX.utils.json_to_sheet(results);
  const outWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outWb, outWs, "Results");
  XLSX.writeFile(outWb, path.join(__dirname, "node_cli_results.xlsx"));
  console.log(`💾 Saved results to: node_cli_results.xlsx\n`);
}

run();
