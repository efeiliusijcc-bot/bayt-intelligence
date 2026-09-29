// Isolated, fail-closed native Chrome CDP soak. No Playwright, request replay or credentials.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as XLSX from '@e965/xlsx';
import { parseExcelExport } from '../src/excel.ts';
import { verifyBulkBatch } from '../src/bulk-batch.ts';

XLSX.set_fs(fs); // SheetJS ESM does not initialize its Node filesystem adapter itself.
export const POLICY = Object.freeze({ target: 500, daily: 500, maxPages: 20,
  pageMin: 60 * 60_000, pageMax: 70 * 60_000, exportMin: 15 * 60_000,
  exportMax: 20 * 60_000, maxDuration: 48 * 60 * 60_000 });
export const hashIds = ids => crypto.createHash('sha256').update([...new Set(ids)].sort().join('\n')).digest('hex');
export const dayKey = time => new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
export const nextDay = time => Date.parse(dayKey(time) + 'T00:00:00+08:00') + 24 * 3600_000;
export const jitter = (min, max) => crypto.randomInt(min, max + 1);
export const isTerminal = state => ['completed', 'safety_stopped', 'operator_stopped', 'insufficient_results'].includes(state.status);
export function responseSummary(raw, status, mime, resourceType = '') {
  let u; try { u = new URL(raw); } catch { return null; }
  if (u.hostname !== 'bayt.com' && !u.hostname.endsWith('.bayt.com')) return null;
  const download = /\/v6\/searchCv\/[^/]+\/downloadCV\//.test(u.pathname);
  const token = /\/v6\/searchCv\/[^/]+\/getActionToken/.test(u.pathname);
  const results = /\/v6\/cvSearch\/[^/]+\/results\/?$/.test(u.pathname);
  const count = /\/v6\/cvSearch\/[^/]+\/count\/?$/.test(u.pathname);
  const listingDocument = resourceType === 'Document' && /\/en\/employers\/cv-search\/listing\/?$/.test(u.pathname);
  return {
    route: download ? 'downloadCV' : token ? 'getActionToken' : results ? 'searchResults' : count ? 'searchCount' : listingDocument ? 'listingDocument' : 'other_bayt',
    status,
    mime: String(mime || '').slice(0, 70),
    authCritical: download || token || results || count || listingDocument,
  };
}
export function assertIdentity(page, state, expectedPage, expectedIds) {
  if (page.host !== 'www.bayt.com' || page.pathname !== '/en/employers/cv-search/listing/') throw Error('BAYT_PAGE_CHANGED');
  if (page.warning) throw Error(page.warning);
  if (page.keyword !== state.keyword || page.searchId !== state.searchId) throw Error('SEARCH_CHANGED');
  if (page.page !== expectedPage) throw Error('PAGE_NUMBER_CHANGED');
  if (page.ids.length !== 50 || new Set(page.ids).size !== 50) throw Error('PAGE_NOT_50_UNIQUE');
  if (expectedIds && hashIds(page.ids) !== hashIds(expectedIds)) throw Error('PAGE_MEMBERS_CHANGED');
}
export function decision(state, now) {
  if (isTerminal(state)) return { kind: 'terminal' };
  if (now - state.createdAt > POLICY.maxDuration) return { kind: 'stop', reason: 'TIME_BUDGET_REACHED' };
  if (state.intent) return { kind: 'stop', reason: 'UNCERTAIN_PREVIOUS_ACTION' };
  if (state.current?.excel) return { kind: 'pdf', due: state.dueAt };
  if ((state.uniqueIds || []).length >= POLICY.target) return { kind: 'verify' };
  if (state.pages.length >= POLICY.maxPages) return { kind: 'stop', reason: 'PAGE_BUDGET_REACHED' };
  const today = state.reservations.filter(r => r.day === dayKey(now)).reduce((n, r) => n + r.count, 0);
  if (today + 50 > POLICY.daily) return { kind: 'wait_day', due: nextDay(now) + 60_000 };
  return { kind: state.current ? 'xls' : 'next', due: state.dueAt };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
async function atomicJson(file, value) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, file);
}
async function evidence(file) {
  const data = await fsp.readFile(file);
  if (!data.length) throw Error('EMPTY_FILE');
  return { name: path.basename(file), sizeBytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}
async function assertFile(file, expected) {
  const actual = await evidence(file);
  if (actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) throw Error('FILE_HASH_MISMATCH');
}
async function assertExcel(file, ids) {
  const rows = await parseExcelExport(file);
  if (rows.length !== ids.length || hashIds(rows.map(r => r.cvId)) !== hashIds(ids)) throw Error('XLS_MAPPING_MISMATCH');
  return evidence(file);
}

// These functions execute inside the page. They read only list controls and numeric CV_IDs.
export function listingSnapshot() {
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const normalize = s => String(s || '').replace(/\s+/g, ' ').trim();
  const text = document.body?.innerText || '';
  const dialogs = [...document.querySelectorAll('[role=dialog],[role=alert],.modal,.alert')].filter(visible).map(e => e.innerText || '').join('\n');
  let warning = null;
  if (/verify you are human|attention required|confirm you are human|security verification|complete the captcha/i.test(text)) warning = 'BAYT_CAPTCHA';
  if (/too many requests|rate limit|try again later/i.test(text)) warning = 'BAYT_RATE_MESSAGE';
  if (/session (?:has )?expired|sign in to continue|log in to continue/i.test(text) || [...document.querySelectorAll('input[type=password]')].some(visible)) warning = 'BAYT_LOGIN_REQUIRED';
  if (/insufficient|buy credits|purchase|upgrade|quota|credits remaining|remaining credits/i.test(dialogs)) warning = 'BAYT_QUOTA_OR_UPGRADE';
  const boxes = [...document.querySelectorAll('input[type=checkbox]')].filter(e => /^[0-9]+$/.test(e.name || ''));
  return { host: location.hostname, pathname: location.pathname, searchId: new URL(location.href).searchParams.get('searchId'),
    keyword: document.querySelector('#searchBar')?.value?.trim(), page: Number(document.querySelector('.pagination input[type=number]')?.value),
    ids: boxes.map(e => e.name), selected: boxes.filter(e => e.checked).length, warning,
    formatLabels: [...document.querySelectorAll('label')].filter(visible).map(e => normalize(e.innerText)).filter(t => /^(Adobe Acrobat|Microsoft Excel)/.test(t)),
    hasNext: !!document.querySelector('.pagination-next:not(.is-disabled):not(.disabled) a') };
}
function controlRect(kind, text) {
  const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  let matches = [];
  if (kind === 'next') matches = [...document.querySelectorAll('.pagination-next a')].filter(e => !/disabled/.test(e.parentElement.className) && e.getAttribute('aria-disabled') !== 'true');
  if (kind === 'bulk') matches = [...document.querySelectorAll('.bulkActions a')].filter(e => norm(e.innerText) === 'Download CV');
  if (kind === 'select') {
    const spans = [...document.querySelectorAll('span')].filter(e => vis(e) && norm(e.textContent) === 'Select all');
    matches = spans.map(e => [...e.parentElement.querySelectorAll('label')].find(vis) || e);
  }
  if (kind === 'format') matches = [...document.querySelectorAll('label')].filter(e => norm(e.innerText) === text);
  if (kind === 'confirm') matches = [...document.querySelectorAll('button')].filter(e => norm(e.innerText) === 'Download without revealing' && !e.disabled);
  matches = matches.filter(vis);
  if (matches.length !== 1) return null;
  const e = matches[0]; e.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, top = document.elementFromPoint(x, y);
  if (!(top === e || e.contains(top))) return null;
  return { x, y, selected: kind === 'format' ? !!document.getElementById(e.htmlFor)?.checked : null };
}

export class NativeChrome {
  constructor(ws, log) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.safety = null; this.downloads = []; this.responses = []; this.log = log;
    ws.addEventListener('message', event => {
      const m = JSON.parse(event.data);
      if (m.id && this.pending.has(m.id)) { const callback = this.pending.get(m.id); this.pending.delete(m.id); callback(m); return; }
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response, safe = responseSummary(r.url, r.status, r.mimeType, m.params.type);
        if (safe) {
          this.responses.push(safe);
          if (safe.route !== 'other_bayt' || safe.status >= 400) this.log('response', safe);
          // Optional Bayt widgets can return 401 while the employer search session remains valid.
          // Fail closed for all 403/429 responses and for 401 responses from the listing,
          // result, action-token, or download path. Other 401 responses remain evidence and
          // listingSnapshot() rechecks the visible login state before every action.
          if ([403, 429].includes(safe.status) || (safe.status === 401 && safe.authCritical)) this.safety = 'BAYT_' + safe.status;
          else if (safe.status === 401) this.log('noncritical_401', { route: safe.route, mime: safe.mime });
        }
      }
      if (m.method === 'Page.downloadWillBegin') this.downloads.push({ kind: 'begin', guid: m.params.guid, extension: path.extname(m.params.suggestedFilename).toLowerCase() });
      if (m.method === 'Page.downloadProgress') this.downloads.push({ kind: 'progress', guid: m.params.guid, state: m.params.state, bytes: m.params.receivedBytes });
    });
    ws.addEventListener('close', () => { this.closed = true; });
    ws.addEventListener('error', () => { this.closed = true; });
  }
  static async connect(endpoint, targetId, log = () => {}) {
    const targets = await (await fetch(endpoint + '/json/list', { signal: AbortSignal.timeout(8000) })).json();
    const matches = targets.filter(t => t.type === 'page' && new URL(t.url).hostname === 'www.bayt.com');
    if (matches.length !== 1 || (targetId && matches[0].id !== targetId)) throw Error('BAYT_TAB_CHANGED');
    const target = matches[0], address = new URL(target.webSocketDebuggerUrl); address.host = new URL(endpoint).host;
    const ws = new WebSocket(address);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(Error('CDP_CONNECT_TIMEOUT')); }, 8000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('CDP_CONNECTION_ERROR')); }, { once: true });
    });
    const client = new NativeChrome(ws, log); client.targetId = target.id;
    await client.call('Page.enable'); await client.call('Network.enable'); return client;
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('CDP_COMMAND_TIMEOUT')); }, 8000);
      this.pending.set(id, m => { clearTimeout(timer); m.error ? reject(Error('CDP_COMMAND_ERROR')) : resolve(m.result); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(fn, ...args) {
    const r = await this.call('Runtime.evaluate', { expression: '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')', returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error('DOM_READ_ERROR');
    return r.result?.value;
  }
  async guard() { if (this.safety) throw Error(this.safety); if (this.closed) throw Error('CDP_DISCONNECTED'); if (this.stopRequested?.()) throw Error('OPERATOR_STOP'); }
  async snapshot() { await this.guard(); const s = await this.eval(listingSnapshot); if (s.warning) throw Error(s.warning); return s; }
  async click(kind, text) {
    await this.guard(); const rect = await this.eval(controlRect, kind, text);
    if (!rect) throw Error('CONTROL_MISSING_OR_OBSCURED');
    for (const [type, buttons] of [['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0]]) {
      await this.guard(); await this.call('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
  }
  async settle(predicate, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { await this.guard(); if (await predicate()) return; await sleep(500); }
    throw Error('PAGE_SETTLE_TIMEOUT');
  }
  async select(state, batch) {
    let s = await this.snapshot(); assertIdentity(s, state, batch.page, batch.ids);
    if (s.selected === 0) { await this.click('select'); await sleep(700); s = await this.snapshot(); }
    assertIdentity(s, state, batch.page, batch.ids); if (s.selected !== 50) throw Error('PARTIAL_SELECTION');
  }
  async export(state, batch, format, dir, beforeClick) {
    const initial = await this.snapshot(); assertIdentity(initial, state, batch.page, batch.ids);
    if (initial.selected !== 50 || initial.formatLabels.length) throw Error('UNEXPECTED_DOWNLOAD_STATE');
    await this.click('bulk');
    const label = format === 'xls' ? 'Microsoft Excel (XLS file format)' : 'Adobe Acrobat (PDF file format) (maximum 50 CVs)';
    await this.settle(async () => (await this.snapshot()).formatLabels.includes(label));
    await this.click('format', label); await sleep(700);
    const chosen = await this.eval(controlRect, 'format', label);
    if (!chosen?.selected) throw Error('FORMAT_NOT_SELECTED');
    assertIdentity(await this.snapshot(), state, batch.page, batch.ids);
    this.downloads = []; this.responses = [];
    await this.call('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    try {
      await beforeClick(); await this.click('confirm');
      await this.settle(async () => this.downloads.some(d => d.state === 'completed' || d.state === 'canceled'), 180000);
      if (this.downloads.some(d => d.state === 'canceled')) throw Error('DOWNLOAD_CANCELED');
      const begin = this.downloads.filter(d => d.kind === 'begin');
      if (begin.length !== 1 || begin[0].extension !== (format === 'xls' ? '.xls' : '.zip')) throw Error('DOWNLOAD_TYPE_MISMATCH');
      const response = this.responses.filter(r => r.route === 'downloadCV');
      if (response.length !== 1 || response[0].status !== 200) throw Error('DOWNLOAD_RESPONSE_NOT_VERIFIED');
      const files = await fsp.readdir(dir), temporary = files.filter(f => /\.(crdownload|tmp|part)$/i.test(f));
      if (temporary.length || files.length !== 1) throw Error('UNEXPECTED_DOWNLOAD_FILES');
      const file = path.join(dir, files[0]), info = await evidence(file);
      const completion = this.downloads.find(d => d.state === 'completed' && d.guid === begin[0].guid);
      if (!completion || completion.bytes !== info.sizeBytes) throw Error('DOWNLOAD_SIZE_MISMATCH');
      return { ...info, downloadedAt: Date.now() };
    } finally { await this.call('Page.setDownloadBehavior', { behavior: 'default' }).catch(() => {}); }
  }
  async close() { this.ws.close(); }
}

export class Soak {
  constructor(root) { this.root = path.resolve(root); this.stateFile = path.join(this.root, 'checkpoint.json'); this.statusFile = path.join(this.root, 'status.json'); }
  log(event, fields = {}) { fs.appendFileSync(path.join(this.root, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n', { mode: 0o600 }); }
  async save() {
    await atomicJson(this.stateFile, this.state);
    const s = this.state;
    await atomicJson(this.statusFile, { runId: s.runId, keyword: s.keyword, target: POLICY.target, status: s.status,
      phase: s.phase, currentPage: s.current?.page || s.pages.at(-1)?.page || 0, completedPages: s.pages.length,
      uniqueCvIds: s.uniqueIds.length, exportedRecords: s.reservations.reduce((n, r) => n + r.count, 0),
      xlsFiles: s.pages.length + (s.current?.excel ? 1 : 0), pdfZipFiles: s.pages.length,
      verifiedPdfEntries: s.pages.reduce((n, p) => n + p.manifest.verification.pdfEntries, 0),
      dueAt: s.dueAt ? new Date(s.dueAt).toISOString() : null, stopReason: s.stopReason || null,
      heartbeatAt: new Date().toISOString(), dailyCap: POLICY.daily, collectionRoute: 'official_chrome_native_cdp', upload: 'not_requested' });
  }
  batchDir(n) { return path.join(this.root, 'pages', String(n).padStart(3, '0')); }
  async init(adopt, endpoint) {
    if (fs.existsSync(this.stateFile)) throw Error('RUN_ALREADY_INITIALIZED');
    if (!fs.existsSync(this.root)) await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await fsp.readdir(this.root)).some(n => !['events.jsonl'].includes(n))) throw Error('RUN_ROOT_NOT_EMPTY');
    const browser = await NativeChrome.connect(endpoint);
    try {
      const p = await browser.snapshot();
      const base = { keyword: 'Frontend Developer', searchId: p.searchId };
      assertIdentity(p, base, 1);
      if (hashIds(p.ids) !== '2334e1585f5a39ab384d181d914925d77b69651830d27ce8a81b2f240786dc58') throw Error('ADOPT_IDENTITY_CHANGED');
      const files = await fsp.readdir(adopt), excelName = files.find(n => n.endsWith('.xls')), pdfName = files.find(n => n.endsWith('.zip'));
      if (files.length !== 2 || !excelName || !pdfName) throw Error('ADOPT_FILES_MISMATCH');
      const sourceXls = path.join(adopt, excelName), sourcePdf = path.join(adopt, pdfName);
      const manifest = await verifyBulkBatch({ runId: path.basename(this.root), keyword: base.keyword, page: 1, expectedCvIds: p.ids, excelPath: sourceXls, pdfArchivePath: sourcePdf });
      const xlsTime = (await fsp.stat(sourceXls)).mtimeMs, pdfTime = (await fsp.stat(sourcePdf)).mtimeMs;
      const dir = this.batchDir(1); await fsp.mkdir(path.join(dir, 'xls'), { recursive: true }); await fsp.mkdir(path.join(dir, 'pdf'));
      await fsp.copyFile(sourceXls, path.join(dir, 'xls', excelName), fs.constants.COPYFILE_EXCL);
      await fsp.copyFile(sourcePdf, path.join(dir, 'pdf', pdfName), fs.constants.COPYFILE_EXCL);
      await atomicJson(path.join(dir, 'manifest.json'), manifest);
      this.state = { schemaVersion: 1, runId: path.basename(this.root), ...base, endpoint, targetId: browser.targetId,
        createdAt: Date.now(), status: 'running', phase: 'waiting_next_page', uniqueIds: [...p.ids],
        pages: [{ page: 1, ids: p.ids, startedAt: xlsTime, excel: manifest.files.excel, pdf: manifest.files.pdfArchive, manifest }],
        current: null, intent: null, reservations: [{ page: 1, day: dayKey(xlsTime), count: 50 }],
        dueAt: Math.max(xlsTime + jitter(POLICY.pageMin, POLICY.pageMax), pdfTime + jitter(POLICY.exportMin, POLICY.exportMax)),
        lastActionAt: pdfTime, stopReason: null };
      await this.save(); this.log('adopted_verified_page', { page: 1, unique: 50 });
    } finally { await browser.close(); }
  }
  assertNoOtherWorker() {
    if (process.platform !== 'win32') throw Error('WINDOWS_ONLY_EXECUTION');
    const ps = `$ProgressPreference='SilentlyContinue'; $p=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -like '*src\\windows-agent.ts*'}); Write-Output $p.Count`;
    const count = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim());
    if (count !== 0) throw Error('COMPETING_WINDOWS_AGENT');
    if (fs.existsSync('D:/bayt/agent-state/safety-stop.json')) throw Error('EXISTING_GLOBAL_SAFETY_MARKER');
  }
  async stop(reason, status = 'safety_stopped') {
    this.state.status = status; this.state.phase = 'stopped'; this.state.stopReason = reason; this.state.dueAt = null;
    await this.save(); this.log('stopped', { reason });
  }
  async validateBatch(batch) {
    const dir = this.batchDir(batch.page), excelPath = path.join(dir, 'xls', batch.excel.name), pdfArchivePath = path.join(dir, 'pdf', batch.pdf.name);
    for (const [format, expected] of [['xls', batch.excel.name], ['pdf', batch.pdf.name]]) {
      const files = await fsp.readdir(path.join(dir, format));
      if (files.length !== 1 || files[0] !== expected) throw Error('UNMATCHED_OR_TEMPORARY_FILES');
    }
    await assertFile(excelPath, batch.excel); await assertFile(pdfArchivePath, batch.pdf);
    return verifyBulkBatch({ runId: this.state.runId, keyword: this.state.keyword, page: batch.page, expectedCvIds: batch.ids, excelPath, pdfArchivePath });
  }
  async verify() {
    const s = this.state || readJson(this.stateFile); this.state = s; const ids = [];
    for (const batch of s.pages) { await this.validateBatch(batch); ids.push(...batch.ids); }
    const report = { verifiedAt: new Date().toISOString(), keyword: s.keyword, fullPages: s.pages.length,
      records: ids.length, uniqueCvIds: new Set(ids).size, duplicatesAcrossPages: ids.length - new Set(ids).size,
      target: POLICY.target, targetReached: new Set(ids).size >= POLICY.target, zipCrcFailures: 0, unmatchedFiles: 0,
      collectedAtLeastTarget: new Set(ids).size >= POLICY.target, extrasOverTarget: Math.max(0, new Set(ids).size - POLICY.target) };
    await atomicJson(path.join(this.root, 'verification.json'), report);
    const rows = s.pages.flatMap(p => p.ids.map(id => ({ cv_id: id, page: p.page,
      excel: path.relative(this.root, path.join(this.batchDir(p.page), 'xls', p.excel.name)),
      pdf_zip: path.relative(this.root, path.join(this.batchDir(p.page), 'pdf', p.pdf.name)),
      excel_sha256: p.excel.sha256, pdf_zip_sha256: p.pdf.sha256 })));
    const columns = ['cv_id', 'page', 'excel', 'pdf_zip', 'excel_sha256', 'pdf_zip_sha256'];
    const quote = v => '"' + String(v).replaceAll('"', '""') + '"';
    await fsp.writeFile(path.join(this.root, 'manifest.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    await fsp.writeFile(path.join(this.root, 'manifest.csv'), columns.join(',') + '\n' + rows.map(r => columns.map(c => quote(r[c])).join(',')).join('\n') + '\n', { mode: 0o600 });
    return report;
  }
  async run() {
    this.state = readJson(this.stateFile); if (isTerminal(this.state)) return;
    const lockFile = path.join(this.root, 'worker.lock');
    const lock = await fsp.open(lockFile, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    let browser = null;
    try {
      if (this.state.intent) { await this.stop('UNCERTAIN_PREVIOUS_ACTION'); return; }
      while (!isTerminal(this.state)) {
        const s = this.state;
        if (fs.existsSync(path.join(this.root, 'STOP'))) { await this.stop('OPERATOR_STOP', 'operator_stopped'); break; }
        const action = decision(s, Date.now());
        if (action.kind === 'stop') { await this.stop(action.reason, 'insufficient_results'); break; }
        if (action.kind === 'verify') {
          await this.verify(); s.status = 'completed'; s.phase = 'verified'; s.dueAt = null;
          await this.save(); this.log('target_verified', { unique: s.uniqueIds.length }); break;
        }
        if (action.kind === 'wait_day' || Date.now() < action.due) {
          s.phase = action.kind === 'wait_day' ? 'daily_limit_wait' : s.current?.excel ? 'between_formats' : 'between_pages';
          if (action.kind === 'wait_day') s.dueAt = action.due;
          await this.save(); await sleep(Math.max(100, Math.min(30000, action.due - Date.now()))); continue;
        }
        this.assertNoOtherWorker();
        browser = await NativeChrome.connect(s.endpoint, s.targetId, (e, f) => this.log(e, f));
        browser.stopRequested = () => fs.existsSync(path.join(this.root, 'STOP'));
        if (!s.current) {
          const previous = s.pages.at(-1), current = await browser.snapshot();
          assertIdentity(current, s, previous.page, previous.ids);
          if (!current.hasNext) { await this.stop('NO_MORE_PAGES', 'insufficient_results'); break; }
          s.intent = { type: 'next_page', page: previous.page + 1, at: Date.now() }; s.phase = 'navigating'; await this.save();
          await browser.click('next');
          await browser.settle(async () => (await browser.snapshot()).page === previous.page + 1, 30000);
          const p = await browser.snapshot(); assertIdentity(p, s, previous.page + 1);
          if (hashIds(p.ids) === hashIds(previous.ids)) throw Error('PAGINATION_DID_NOT_CHANGE_MEMBERS');
          s.current = { page: p.page, ids: p.ids, startedAt: Date.now() }; s.intent = null;
          await this.save();
        }
        const b = s.current, dir = this.batchDir(b.page);
        await browser.select(s, b);
        const format = b.excel ? 'pdf' : 'xls';
        if (format === 'pdf') await assertFile(path.join(dir, 'xls', b.excel.name), b.excel);
        const downloadDir = path.join(dir, format); await fsp.mkdir(downloadDir, { recursive: true });
        if ((await fsp.readdir(downloadDir)).length) throw Error('UNCLAIMED_FILES_REQUIRE_REVIEW');
        const info = await browser.export(s, b, format, downloadDir, async () => {
          if (format === 'xls') {
            const day = dayKey(Date.now()), today = s.reservations.filter(r => r.day === day).reduce((n, r) => n + r.count, 0);
            if (today + 50 > POLICY.daily) throw Error('DAILY_LIMIT_RACE');
            s.reservations.push({ page: b.page, day, count: 50 });
          }
          s.intent = { type: 'download', format, page: b.page, at: Date.now() };
          s.phase = 'downloading_' + format; await this.save();
        });
        s.lastActionAt = info.downloadedAt;
        if (format === 'xls') {
          await assertExcel(path.join(downloadDir, info.name), b.ids); b.excel = info; s.intent = null;
          s.dueAt = info.downloadedAt + jitter(POLICY.exportMin, POLICY.exportMax); s.phase = 'between_formats';
        } else {
          b.pdf = info; b.manifest = await this.validateBatch(b);
          await atomicJson(path.join(dir, 'manifest.json'), b.manifest);
          s.pages.push(b); s.uniqueIds = [...new Set([...s.uniqueIds, ...b.ids])]; s.current = null; s.intent = null;
          s.dueAt = Math.max(b.startedAt + jitter(POLICY.pageMin, POLICY.pageMax), info.downloadedAt + POLICY.exportMin); s.phase = 'between_pages';
          this.log('page_verified', { page: b.page, unique: s.uniqueIds.length, pdfEntries: b.manifest.verification.pdfEntries });
        }
        await this.save(); await browser.close(); browser = null;
      }
    } catch (error) {
      const reason = browser?.safety || (/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_OR_TRANSPORT_ERROR');
      await this.stop(reason, reason === 'OPERATOR_STOP' ? 'operator_stopped' : 'safety_stopped'); // Never repeat an ambiguous click or auto-clear a safety stop.
    } finally {
      if (browser) await browser.close().catch(() => {});
      await lock.close(); await fsp.unlink(lockFile);
    }
  }
}

async function main() {
  const [command, root, adopt] = process.argv.slice(2);
  if (process.platform !== 'win32' || !root || !path.resolve(root).toLowerCase().startsWith('d:\\bayt\\runs\\native-500-')) throw Error('ISOLATED_WINDOWS_RUN_REQUIRED');
  const soak = new Soak(root);
  if (command === 'init') await soak.init(adopt, 'http://127.0.0.1:19229');
  else if (command === 'run') await soak.run();
  else if (command === 'verify') console.log(JSON.stringify(await soak.verify()));
  else throw Error('EXPECTED_INIT_RUN_VERIFY');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'SOAK_STARTUP_FAILED'); process.exitCode = 1; });
}
