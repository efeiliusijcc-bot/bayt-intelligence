// Checkpointed, local-only Bayt collection through the user's logged-in Ego page.
// No 154 node, credential extraction, direct Bayt API replay, or 108 safety-pause override.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseExcelExport } from '../src/excel.ts';
import { verifyBulkBatch, writeBulkManifest } from '../src/bulk-batch.ts';
import { sha256File } from '../src/files.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiScript = await fsp.readFile(path.join(here, 'local-ego-action.mjs'), 'utf8');
const base = path.resolve(here, '../../data/local-runs');
const HOUR = 3_600_000;
export const POLICY = Object.freeze({
  durationMs: 24 * HOUR,
  exportMinMs: 15 * 60_000,
  exportMaxMs: 20 * 60_000,
  pageMinMs: 60 * 60_000,
  pageMaxMs: 70 * 60_000,
  transientWaitsMs: [2 * 60_000, 5 * 60_000, 15 * 60_000],
  rateWaitsMs: [15 * 60_000, 30 * 60_000, 60 * 60_000],
});
export const jitter = (min, max) => crypto.randomInt(min, max + 1);
export const deadlineReached = (deadlineAt, now = Date.now()) => now >= Date.parse(deadlineAt);
export function classifyFailure(message) {
  if (/BAYT_RATE_LIMIT|\b429\b/i.test(message)) return 'rate_limit';
  if (/BAYT_CAPTCHA|BAYT_LOGIN_REQUIRED|BAYT_QUOTA_OR_PURCHASE|\b403\b|SEARCH_IDENTITY_CHANGED|FILTER_CHANGED|PAGE_MEMBERS_CHANGED|OVERLAP|CV_ID_INVALID|MAPPING|CRC|PURCHASE/i.test(message)) return 'safety';
  if (/timed out|timeout|ERR_|connection|disconnected|navigation|LISTING_NOT_VISIBLE|PAGE_NUMBER_CHANGED|SELECT_ALL_CONTROL_MISSING|BULK_ACTION_MISSING|FORMAT_MISSING/i.test(message)) return 'transient';
  return 'safety';
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const statePath = root => path.join(root, 'checkpoint.json');
const statusPath = root => path.join(root, 'status.json');
const logPath = root => path.join(root, 'events.jsonl');
const batchDir = (root, page) => path.join(root, 'batches', String(page).padStart(4, '0'));
const sameSet = (left, right) => left.length === right.length && left.every(id => right.includes(id));
let shutdownRequested = false;
process.on('SIGTERM', () => { shutdownRequested = true; });
process.on('SIGINT', () => { shutdownRequested = true; });

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.rename(temporary, file);
}
async function appendLog(root, event, fields = {}) {
  await fsp.appendFile(logPath(root), JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n', { mode: 0o600 });
}
async function save(root, state) {
  state.updatedAt = new Date().toISOString();
  await atomicJson(statePath(root), state);
  await heartbeat(root, state);
}
async function heartbeat(root, state) {
  let uploadedPages = 0;
  for (const item of state.pages) {
    try {
      const receipt = JSON.parse(await fsp.readFile(path.join(root, 'upload-receipts', `${String(item.page).padStart(4, '0')}.json`), 'utf8'));
      if (receipt.status === 'uploaded') uploadedPages++;
    } catch { /* uploader is independent and may not have started */ }
  }
  await atomicJson(statusPath(root), {
    runId: state.runId,
    status: state.status,
    phase: state.phase,
    keyword: state.keyword,
    searchId: state.searchId,
    startedAt: state.startedAt,
    deadlineAt: state.deadlineAt,
    currentPage: state.current?.page || state.pages.at(-1)?.page || 0,
    completedPages: state.pages.length,
    verifiedResumes: state.pages.reduce((sum, item) => sum + item.count, 0),
    nextActionAt: state.nextActionAt,
    stopReason: state.stopReason || null,
    heartbeatAt: new Date().toISOString(),
    route: 'local_ego_browser',
    upload: `${uploadedPages}/${state.pages.length} pages uploaded independently; 108 collector safety pause unchanged`,
    challenge: state.challenge || null,
  });
}

async function notifyVerification() {
  await new Promise(resolve => {
    const child = spawn('/usr/bin/osascript', ['-e', 'display notification "Bayt 页面需要人工验证。请完成后回复：已验证。" with title "Bayt 采集暂停"'],
      { stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}
async function evidence(file) {
  const stat = await fsp.stat(file);
  if (!stat.isFile() || stat.size <= 0) throw Error('EMPTY_EXPORT_FILE');
  return { name: path.basename(file), sizeBytes: stat.size, sha256: await sha256File(file) };
}
async function ego(action) {
  return await new Promise((resolve, reject) => {
    const child = spawn('ego-browser', ['nodejs'], {
      cwd: here,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 300_000);
    child.stdout.on('data', chunk => { out += String(chunk).slice(0, 200_000); });
    child.stderr.on('data', chunk => { err += String(chunk).slice(0, 200_000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(Error('EGO_ACTION_TIMEOUT'));
      if (code !== 0) return reject(Error((err || out).slice(-1500) || `EGO_EXIT_${code}`));
      // The CLI emits console output on stderr when its stdin is a pipe.
      const line = `${out}\n${err}`.split('\n').find(item => item.startsWith('BAYT_EGO_RESULT='));
      if (!line) return reject(Error('EGO_RESULT_MISSING'));
      try { resolve(JSON.parse(line.slice('BAYT_EGO_RESULT='.length))); }
      catch { reject(Error('EGO_RESULT_INVALID')); }
    });
    child.stdin.end(`globalThis.BAYT_EGO_ACTION_JSON=${JSON.stringify(JSON.stringify(action))};\n${uiScript}`);
  });
}

function assertListing(page, state, expectedPage, expectedIds) {
  if (page.host !== 'www.bayt.com' || page.path !== '/en/employers/cv-search/listing/' ||
    page.searchId !== state.searchId || page.keyword !== state.keyword || page.page !== expectedPage ||
    (state.schemaVersion !== 2 && !Object.values(page.filters || {}).every(Boolean)) || !page.ids.length || page.ids.length > 50 ||
    new Set(page.ids).size !== page.ids.length ||
    (expectedIds && !sameSet(page.ids, expectedIds))) throw Error('LISTING_IDENTITY_OR_FILTER_MISMATCH');
}

export function freshNextPage(page, state) {
  try { assertListing(page, state, state.current.page + 1); }
  catch { return false; }
  return !page.ids.some(id => state.seenIds.includes(id));
}

export function challengeDecision(result, state) {
  if (!result?.cleared) return 'handoff';
  if (state.phase === 'next' && freshNextPage(result.state, state)) return 'fresh_next';
  try { assertListing(result.state, state, state.current.page, state.current.ids); return 'current'; }
  catch { return 'handoff'; }
}

async function acceptNextPage(root, state, page) {
  if (!freshNextPage(page, state)) throw Error('NEXT_PAGE_NOT_FRESH');
  state.current = { page: page.page, ids: page.ids, firstSeenAt: new Date().toISOString(), excel: null, pdf: null };
  state.phase = 'excel_prepare'; state.status = 'running'; state.nextActionAt = new Date().toISOString();
  state.stopReason = null; state.failures = 0; state.challenge = null;
  await save(root, state);
  await appendLog(root, 'next_page_ready', { page: page.page, count: page.ids.length });
}

function challengeEvidence(raw, message = '') {
  const parts = message.match(/BAYT_RESULTS_HTTP_403\|([^|]*)\|([^|]*)\|([^\s|]*)/);
  const response = raw?.resultResponse;
  return {
    at: response?.at || parts?.[1] || new Date().toISOString(),
    status: response?.status || Number(parts?.[2]) || 403,
    rayId: response?.rayId || parts?.[3] || null,
    path: response?.path || null,
  };
}

async function awaitVerification(root, state, evidence, reason) {
  const firstNotice = !state.challenge?.notifiedAt;
  state.resumePhase = state.phase;
  state.resumeNextActionAt = state.nextActionAt;
  state.status = 'awaiting_verification'; state.nextActionAt = null;
  state.stopReason = reason;
  state.challenge = { ...evidence, attemptedNormalLoad: true,
    notifiedAt: state.challenge?.notifiedAt || new Date().toISOString() };
  await save(root, state);
  await appendLog(root, 'awaiting_verification', { page: state.current.page + 1,
    responseAt: evidence.at, status: evidence.status, rayId: evidence.rayId, path: evidence.path, reason });
  if (firstNotice) await notifyVerification();
  try { await ego({ action: 'handoff', spaceId: state.spaceId }); }
  catch (error) { await appendLog(root, 'ego_handoff_error', { code: String(error?.message || error).slice(0, 120) }); }
}

async function handleChallenge(root, state, raw, message = '') {
  const evidence = challengeEvidence(raw, message);
  if (state.challenge?.attemptedNormalLoad) {
    await awaitVerification(root, state, evidence, 'BAYT_CHALLENGE_REPEATED');
    return;
  }
  await appendLog(root, 'challenge_detected', { responseAt: evidence.at, status: evidence.status, rayId: evidence.rayId });
  state.challenge = { ...evidence, attemptedNormalLoad: true };
  await save(root, state);
  let result;
  try {
    result = await ego({ action: 'challenge', spaceId: state.spaceId, searchId: state.searchId, keyword: state.keyword, schemaVersion: state.schemaVersion });
  } catch (error) {
    await appendLog(root, 'challenge_normal_load_failed', { code: String(error?.message || error).slice(0, 120) });
    await awaitVerification(root, state, evidence, 'BAYT_CHALLENGE_NOT_VISIBLE');
    return;
  }
  if (result.cleared) {
    const decision = challengeDecision(result, state);
    if (decision === 'fresh_next') {
      await acceptNextPage(root, state, result.state); return;
    }
    if (decision === 'current') {
      state.status = 'running'; state.nextActionAt = new Date().toISOString(); state.stopReason = null;
      await save(root, state);
      await appendLog(root, 'challenge_cleared', { clicked: result.clicked });
      return;
    }
  }
  await awaitVerification(root, state, evidence, 'BAYT_CHALLENGE_NEEDS_USER');
}

async function init(spaceId) {
  if (!Number.isInteger(spaceId) || spaceId < 1) throw Error('EGO_SPACE_ID_REQUIRED');
  const page = await ego({ action: 'inspect', spaceId });
  const baseline = { searchId: page.searchId, keyword: 'Backend Engineer' };
  assertListing(page, baseline, 1);
  const runId = `local-ego-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  await fsp.mkdir(base, { recursive: true, mode: 0o700 });
  const root = path.join(base, runId);
  await fsp.mkdir(root, { mode: 0o700 });
  const startedAt = new Date();
  const state = {
    schemaVersion: 1, runId, spaceId, keyword: baseline.keyword, searchId: baseline.searchId,
    filters: { freshness6Months: true, experience2to5: true, fullTime: true },
    startedAt: startedAt.toISOString(), deadlineAt: new Date(startedAt.getTime() + POLICY.durationMs).toISOString(),
    status: 'running', phase: 'excel_prepare', nextActionAt: startedAt.toISOString(),
    current: { page: 1, ids: page.ids, firstSeenAt: startedAt.toISOString(), excel: null, pdf: null },
    pages: [], seenIds: [], intent: null, failures: 0, rateLimits: 0, stopReason: null,
  };
  await save(root, state);
  await appendLog(root, 'initialized', { searchId: state.searchId, page: 1, candidates: page.ids.length });
  console.log(root);
}

async function initJob(input) {
  const { spaceId, job, supervisorPid, actualKeyword } = input;
  if (!Number.isInteger(spaceId) || spaceId < 1 || job?.searchSpec?.schemaVersion !== 2 ||
    !Number.isInteger(supervisorPid) || supervisorPid < 1) throw Error('INVALID_QUEUE_JOB_INIT');
  const page = await ego({ action: 'inspect', spaceId });
  const baseline = { schemaVersion: 2, searchId: page.searchId, keyword: actualKeyword };
  assertListing(page, baseline, 1);
  const runId = `local-ego-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  await fsp.mkdir(base, { recursive: true, mode: 0o700 });
  const root = path.join(base, runId);
  await fsp.mkdir(root, { mode: 0o700 });
  const startedAt = new Date();
  const deadlineMs = job.limits.durationHours ? job.limits.durationHours * HOUR : 48 * HOUR;
  const state = { schemaVersion: 2, runId, spaceId, queueJobId: job.id, supervisorPid,
    keyword: baseline.keyword, searchId: baseline.searchId, searchSpec: job.searchSpec, limits: job.limits,
    startedAt: startedAt.toISOString(), deadlineAt: new Date(startedAt.getTime() + deadlineMs).toISOString(),
    status: 'prepared', phase: 'excel_prepare', nextActionAt: startedAt.toISOString(),
    current: { page: 1, ids: page.ids, firstSeenAt: startedAt.toISOString(), excel: null, pdf: null },
    pages: [], seenIds: [], intent: null, failures: 0, rateLimits: 0, stopReason: null };
  await save(root, state);
  await appendLog(root, 'queue_job_initialized', { jobId: job.id, searchId: state.searchId, page: 1, candidates: page.ids.length });
  console.log(root);
}

async function activateRun(root, jobId) {
  root = path.resolve(root || '');
  if (!root.startsWith(base + path.sep)) throw Error('RUN_ROOT_OUTSIDE_LOCAL_RUNS');
  const state = JSON.parse(await fsp.readFile(statePath(root), 'utf8'));
  if (state.schemaVersion !== 2 || state.queueJobId !== jobId || state.pages.length || state.intent ||
    !['prepared', 'running'].includes(state.status)) throw Error('QUEUE_RUN_ACTIVATION_INVALID');
  if (state.status === 'prepared') {
    state.status = 'running';
    await save(root, state);
    await appendLog(root, 'queue_run_activated', { jobId });
  }
}

async function commitExcel(root, state) {
  const file = path.join(batchDir(root, state.current.page), 'resumes.xls');
  const rows = await parseExcelExport(file);
  if (!sameSet(rows.map(row => row.cvId), state.current.ids)) throw Error('XLS_CV_ID_MAPPING_FAILED');
  state.current.excel = await evidence(file);
  state.current.excelAt = new Date().toISOString();
  state.intent = null;
  state.phase = 'pdf_prepare';
  state.nextActionAt = new Date(Date.now() + jitter(POLICY.exportMinMs, POLICY.exportMaxMs)).toISOString();
  state.failures = 0;
  await save(root, state);
  await appendLog(root, 'excel_verified', { page: state.current.page, count: state.current.ids.length, bytes: state.current.excel.sizeBytes });
}
async function commitPdf(root, state) {
  const dir = batchDir(root, state.current.page);
  const manifest = await verifyBulkBatch({
    runId: state.runId, queueJobId: state.queueJobId, keyword: state.keyword, page: state.current.page,
    expectedCvIds: state.current.ids,
    excelPath: path.join(dir, 'resumes.xls'), pdfArchivePath: path.join(dir, 'resumes.zip'),
  });
  await writeBulkManifest(dir, manifest);
  const pageNo = state.current.page;
  const count = state.current.ids.length;
  state.current.pdf = manifest.files.pdfArchive;
  state.pages.push({ page: pageNo, count, cvIdSetSha256: manifest.cvIdSetSha256,
    firstSeenAt: state.current.firstSeenAt, completedAt: new Date().toISOString(), manifest });
  state.seenIds.push(...state.current.ids);
  state.intent = null;
  state.phase = 'next';
  state.nextActionAt = new Date(Math.max(
    Date.parse(state.current.excelAt) + jitter(POLICY.pageMinMs, POLICY.pageMaxMs),
    Date.now() + jitter(POLICY.exportMinMs, POLICY.exportMaxMs),
  )).toISOString();
  state.browserCooldownUntil = state.nextActionAt;
  state.failures = 0;
  state.rateLimits = 0;
  await save(root, state);
  await appendLog(root, 'page_verified', { page: pageNo, count, total: state.seenIds.length,
    zipCrcFailures: manifest.verification.zipCrcFailures });
}

async function reconcileIntent(root, state) {
  if (!state.intent) return true;
  const format = state.intent.format;
  const file = path.join(batchDir(root, state.current.page), format === 'xls' ? 'resumes.xls' : 'resumes.zip');
  if (!fs.existsSync(file)) return false;
  try {
    if (format === 'xls') await commitExcel(root, state);
    else await commitPdf(root, state);
    await appendLog(root, 'reconciled_download', { page: state.current.page, format });
    return true;
  } catch { return false; }
}

export function finishIfReady(state, now = Date.now()) {
  if (state.intent) return false;
  const limit = state.phase === 'next' && state.limits &&
    ((state.limits.maxPages && state.pages.length >= state.limits.maxPages) ||
      (state.limits.targetCount && state.seenIds.length >= state.limits.targetCount));
  const expired = ['next', 'excel_prepare'].includes(state.phase) && deadlineReached(state.deadlineAt, now);
  if (limit || expired) {
    if (state.phase === 'next' && state.nextActionAt) state.browserCooldownUntil = state.nextActionAt;
    state.status = 'completed'; state.phase = 'finished'; state.nextActionAt = null;
    return true;
  }
  return false;
}

async function step(root, state) {
  const current = state.current;
  if (finishIfReady(state)) {
    await save(root, state); await appendLog(root, 'collection_completed', { pages: state.pages.length, count: state.seenIds.length }); return;
  }
  const common = { spaceId: state.spaceId, searchId: state.searchId, keyword: state.keyword, schemaVersion: state.schemaVersion,
    page: current.page, ids: current.ids };
  if (state.phase === 'excel_prepare' || state.phase === 'pdf_prepare') {
    const format = state.phase.startsWith('excel') ? 'xls' : 'pdf';
    const page = await ego({ action: 'inspect', spaceId: state.spaceId });
    assertListing(page, state, current.page, current.ids);
    await ego({ ...common, action: 'prepare', format });
    state.phase = format === 'xls' ? 'excel_confirm' : 'pdf_confirm';
    state.failures = 0;
    await save(root, state);
    await appendLog(root, 'export_prepared', { page: current.page, format });
    return;
  }
  if (state.phase === 'excel_confirm' || state.phase === 'pdf_confirm') {
    const format = state.phase.startsWith('excel') ? 'xls' : 'pdf';
    const dir = batchDir(root, current.page);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const destination = path.join(dir, format === 'xls' ? 'resumes.xls' : 'resumes.zip');
    if (fs.existsSync(destination)) throw Error('UNEXPECTED_EXISTING_EXPORT');
    state.intent = { format, page: current.page, startedAt: new Date().toISOString() };
    await save(root, state);
    await appendLog(root, 'download_intent', { page: current.page, format });
    await ego({ ...common, action: 'confirm', format, destination });
    if (format === 'xls') await commitExcel(root, state);
    else await commitPdf(root, state);
    return;
  }
  if (state.phase === 'next') {
    if (deadlineReached(state.deadlineAt)) {
      state.status = 'completed'; state.phase = 'finished'; state.nextActionAt = null;
      await save(root, state); await appendLog(root, 'duration_completed', { total: state.seenIds.length });
      return;
    }
    const page = await ego({ ...common, action: 'next' });
    if (page.endOfResults) {
      state.status = 'completed'; state.phase = 'finished'; state.nextActionAt = null;
      await save(root, state); await appendLog(root, 'end_of_results', { total: state.seenIds.length });
      return;
    }
    await acceptNextPage(root, state, page);
    return;
  }
  throw Error('UNKNOWN_RUN_PHASE');
}

async function stop(root, state, reason) {
  if (state.phase !== 'stopped') {
    state.resumePhase = state.phase;
    state.resumeNextActionAt = state.nextActionAt;
  }
  state.status = 'safety_stopped'; state.phase = 'stopped'; state.stopReason = reason;
  state.nextActionAt = null;
  await save(root, state);
  await appendLog(root, 'safety_stopped', { reason });
}

async function handleError(root, state, error) {
  const message = String(error?.message || error);
  await appendLog(root, 'action_error', { phase: state.phase, code: message.split('\n')[0].slice(0, 120) });
  if (state.intent) {
    if (await reconcileIntent(root, state)) return;
    await stop(root, state, 'UNCERTAIN_DOWNLOAD_RESULT');
    return;
  }
  if (/EGO_USER_CONTROL_REQUIRED|BAYT_LOGIN_REQUIRED/.test(message)) {
    await awaitVerification(root, state, { at: new Date().toISOString(), status: null, rayId: null }, 'EGO_USER_CONTROL_REQUIRED');
    return;
  }
  if (/BAYT_RESULTS_HTTP_403|BAYT_CAPTCHA|NEXT_PAGE_OVERLAP|NEXT_PAGE_VALIDATION_FAILED/.test(message)) {
    let raw = null;
    try { raw = await ego({ action: 'inspectRaw', spaceId: state.spaceId }); }
    catch { /* error text still contains the response evidence */ }
    if (raw?.warning === 'RESULTS_HTTP_403' || raw?.warning === 'CAPTCHA' || /BAYT_RESULTS_HTTP_403|BAYT_CAPTCHA/.test(message)) {
      await handleChallenge(root, state, raw, message); return;
    }
  }
  const kind = classifyFailure(message);
  const attempts = kind === 'rate_limit' ? ++state.rateLimits : ++state.failures;
  const schedule = kind === 'rate_limit' ? POLICY.rateWaitsMs : POLICY.transientWaitsMs;
  if (kind === 'safety' || attempts > schedule.length) {
    const safeCode = message.match(/\b[A-Z][A-Z0-9_]{3,}\b/)?.[0] || 'SAFETY_CHECK_FAILED';
    await stop(root, state, kind === 'safety' ? safeCode : `${kind.toUpperCase()}_RETRY_EXHAUSTED`);
    return;
  }
  state.nextActionAt = new Date(Date.now() + schedule[attempts - 1]).toISOString();
  await save(root, state);
  await appendLog(root, 'retry_scheduled', { kind, attempt: attempts, phase: state.phase, nextActionAt: state.nextActionAt });
}

async function verifyCompletedPages(root, state) {
  const seen = new Set();
  for (const item of state.pages) {
    const dir = batchDir(root, item.page);
    const rows = await parseExcelExport(path.join(dir, 'resumes.xls'));
    const ids = rows.map(row => row.cvId);
    if (ids.some(id => seen.has(id))) throw Error('CHECKPOINT_CV_ID_OVERLAP');
    ids.forEach(id => seen.add(id));
    const checked = await verifyBulkBatch({ runId: state.runId, keyword: state.keyword, page: item.page,
      queueJobId: state.queueJobId,
      expectedCvIds: ids, excelPath: path.join(dir, 'resumes.xls'), pdfArchivePath: path.join(dir, 'resumes.zip') });
    const stored = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    if (checked.cvIdSetSha256 !== item.cvIdSetSha256 || stored.cvIdSetSha256 !== checked.cvIdSetSha256 ||
      stored.schemaVersion !== checked.schemaVersion || stored.queueJobId !== checked.queueJobId ||
      stored.files?.excel?.sha256 !== checked.files.excel.sha256 ||
      stored.files?.pdfArchive?.sha256 !== checked.files.pdfArchive.sha256 || item.count !== ids.length)
      throw Error('CHECKPOINT_PAGE_EVIDENCE_MISMATCH');
  }
  if (seen.size !== state.seenIds.length || state.seenIds.some(id => !seen.has(id))) throw Error('CHECKPOINT_SEEN_IDS_MISMATCH');
}

async function retire(root) {
  root = path.resolve(root || '');
  if (!root.startsWith(base + path.sep)) throw Error('RUN_ROOT_OUTSIDE_LOCAL_RUNS');
  const state = JSON.parse(await fsp.readFile(statePath(root), 'utf8'));
  if (!['awaiting_verification', 'safety_stopped', 'completed'].includes(state.status))
    throw Error('RUN_NOT_RETIRABLE');
  if (state.intent) throw Error('UNCERTAIN_PREVIOUS_DOWNLOAD');
  await verifyCompletedPages(root, state);
  for (const page of state.pages) {
    const receipt = JSON.parse(await fsp.readFile(path.join(root, 'upload-receipts', `${String(page.page).padStart(4, '0')}.json`), 'utf8'));
    const manifestPath = path.join(batchDir(root, page.page), 'manifest.json');
    if (receipt.status !== 'uploaded' || receipt.page !== page.page ||
      receipt.manifestSha256 !== await sha256File(manifestPath) ||
      receipt.excelSha256 !== page.manifest.files.excel.sha256 ||
      receipt.pdfSha256 !== page.manifest.files.pdfArchive.sha256)
      throw Error('RUN_UPLOAD_EVIDENCE_MISMATCH');
  }
  state.status = 'operator_stopped';
  state.phase = 'stopped';
  state.stopReason = 'RETIRED_BY_ADMIN_NEW_COLLECTION';
  state.nextActionAt = null;
  await save(root, state);
  await appendLog(root, 'run_retired_by_admin', { pages: state.pages.length, verifiedResumes: state.seenIds.length });
}

export function resumePhase(state) {
  if (state.intent) throw Error('UNCERTAIN_PREVIOUS_DOWNLOAD');
  const saved = state.phase === 'stopped' ? state.resumePhase : state.phase;
  // A confirmation modal itself is not a download intent. Reopen it only after identity checks.
  if (['next', 'excel_prepare', 'pdf_prepare'].includes(saved)) return saved;
  if (saved === 'excel_confirm') return 'excel_prepare';
  if (saved === 'pdf_confirm') return 'pdf_prepare';
  if (state.current?.pdf && state.pages.at(-1)?.page === state.current.page) return 'next';
  if (state.current?.excel && !state.current.pdf) return 'pdf_prepare';
  if (!state.current?.excel && !state.current?.pdf && state.current?.page === state.pages.length + 1) return 'excel_prepare';
  throw Error('RECOVERY_PHASE_UNPROVEN');
}

function assertRecoverable(state, userVerified) {
  if (state.intent) throw Error('UNCERTAIN_PREVIOUS_DOWNLOAD');
  if (state.status === 'awaiting_verification' && !userVerified) throw Error('USER_VERIFICATION_REQUIRED');
  if (!['awaiting_verification', 'safety_stopped', 'operator_stopped'].includes(state.status) ||
    /RETIRED|UNCERTAIN|MISMATCH|CRC|MAPPING|INVALID/.test(state.stopReason || '')) throw Error('RECOVERY_STATE_NOT_SUPPORTED');
}

async function recover(root, userVerified = false) {
  root = path.resolve(root || '');
  if (!root.startsWith(base + path.sep)) throw Error('RUN_ROOT_OUTSIDE_LOCAL_RUNS');
  const state = JSON.parse(await fsp.readFile(statePath(root), 'utf8'));
  assertRecoverable(state, userVerified);
  await verifyCompletedPages(root, state);
  const phase = resumePhase(state);
  if (phase === 'pdf_prepare') {
    const file = path.join(batchDir(root, state.current.page), 'resumes.xls');
    const actual = await evidence(file);
    const ids = (await parseExcelExport(file)).map(row => row.cvId);
    if (actual.sha256 !== state.current.excel.sha256 || !sameSet(ids, state.current.ids)) throw Error('PARTIAL_XLS_MISMATCH');
  }
  state.phase = phase;
  state.nextActionAt = state.resumeNextActionAt || state.browserCooldownUntil ||
    (phase === 'pdf_prepare' ? new Date(Date.parse(state.current.excelAt) + POLICY.exportMaxMs).toISOString() : new Date().toISOString());
  if (finishIfReady(state)) { await save(root, state); await appendLog(root, 'expired_run_finalized'); return; }
  let page = await ego({ action: userVerified ? 'resumeInspect' : 'inspectRaw', spaceId: state.spaceId });
  if (!page.warning && page.host === 'www.bayt.com' &&
    (page.path === '/en/employers/cv-search/' || (page.path === '/en/employers/cv-search/listing/' && page.searchId !== state.searchId)))
    page = await ego({ action: 'restoreListing', spaceId: state.spaceId, searchId: state.searchId, page: state.current.page });
  if (page.warning === 'RATE_LIMIT') throw Error('BAYT_RATE_LIMIT');
  if (page.warning === 'LOGIN_REQUIRED') throw Error('BAYT_LOGIN_REQUIRED');
  if (phase === 'next' && !page.warning && freshNextPage(page, state)) {
    const nextAt = state.nextActionAt;
    await acceptNextPage(root, state, page);
    state.nextActionAt = nextAt;
    await fsp.unlink(path.join(root, 'stop-requested.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await save(root, state); return;
  }
  if (!page.warning && page.page === state.current.page && sameSet(page.ids, state.current.ids)) {
    assertListing(page, state, state.current.page, state.current.ids);
    state.status = 'running';
    state.stopReason = null; state.challenge = null;
    // The resume request explicitly acknowledges an earlier pause request.
    await fsp.unlink(path.join(root, 'stop-requested.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await save(root, state); await appendLog(root, 'checkpoint_resume_verified', { phase }); return;
  }
  if (page.warning === 'RESULTS_HTTP_403' || page.warning === 'CAPTCHA') {
    await awaitVerification(root, state, challengeEvidence(page), 'VERIFICATION_NOT_CONFIRMED'); return;
  }
  throw Error('RECOVERY_PAGE_NOT_VERIFIED');
}

async function verifyResume(root, jobId) {
  root = path.resolve(root || '');
  if (!root.startsWith(base + path.sep)) throw Error('RUN_ROOT_OUTSIDE_LOCAL_RUNS');
  const state = JSON.parse(await fsp.readFile(statePath(root), 'utf8'));
  if (state.schemaVersion !== 2 || state.queueJobId !== jobId ||
    state.runId !== path.basename(root) || state.intent) throw Error('CHECKPOINT_RESUME_NOT_SAFE');
  assertRecoverable(state, true);
  resumePhase(state);
  await verifyCompletedPages(root, state);
}

async function rebindSupervisor(root, supervisorPid) {
  root = path.resolve(root || '');
  if (!root.startsWith(base + path.sep) || !Number.isInteger(supervisorPid) || supervisorPid < 1) throw Error('QUEUE_REBIND_INVALID');
  const state = JSON.parse(await fsp.readFile(statePath(root), 'utf8'));
  if (state.schemaVersion !== 2 || state.status !== 'running') throw Error('QUEUE_REBIND_NOT_RUNNING');
  await verifyCompletedPages(root, state);
  if (state.intent && !(await reconcileIntent(root, state))) {
    await stop(root, state, 'UNCERTAIN_PREVIOUS_DOWNLOAD'); throw Error('UNCERTAIN_PREVIOUS_DOWNLOAD');
  }
  state.supervisorPid = supervisorPid;
  await save(root, state);
  await appendLog(root, 'queue_supervisor_rebound', { pid: supervisorPid });
}

async function waitUntil(root, state) {
  while (!shutdownRequested && state.status === 'running' && Date.now() < Date.parse(state.nextActionAt)) {
    if (finishIfReady(state)) { await save(root, state); return; }
    if (state.supervisorPid) {
      try { process.kill(state.supervisorPid, 0); }
      catch { await stop(root, state, 'QUEUE_SUPERVISOR_LOST'); return; }
    }
    if (!(await checkControlLease(root, state))) return;
    if (fs.existsSync(path.join(root, 'stop-requested.json'))) {
      state.resumePhase = state.phase; state.resumeNextActionAt = state.nextActionAt;
      state.status = 'operator_stopped'; state.phase = 'stopped'; state.stopReason = 'LOCAL_STOP_REQUESTED';
      await save(root, state); return;
    }
    await heartbeat(root, state);
    await sleep(Math.min(30_000, Date.parse(state.nextActionAt) - Date.now()));
  }
}

async function checkControlLease(root, state) {
  if (state.schemaVersion !== 2) return true;
  let confirmedAt;
  try { confirmedAt = JSON.parse(await fsp.readFile(path.join(root, 'control-lease.json'), 'utf8')).confirmedAt; }
  catch { /* A missing control-plane acknowledgement is not a valid lease. */ }
  if (confirmedAt && Date.now() - Date.parse(confirmedAt) < 90_000) return true;
  await stop(root, state, 'LOCAL_LEASE_HEARTBEAT_LOST'); return false;
}

async function run(root) {
  root = path.resolve(root || '');
  if (!root.startsWith(base + path.sep)) throw Error('RUN_ROOT_OUTSIDE_LOCAL_RUNS');
  const lock = path.join(root, 'worker.lock');
  let handle;
  try { handle = await fsp.open(lock, 'wx', 0o600); }
  catch {
    // Recover only a lock left by a process that no longer exists.
    const previous = JSON.parse(await fsp.readFile(lock, 'utf8'));
    if (!Number.isInteger(previous.pid) || previous.pid < 1) throw Error('RUN_LOCK_INVALID');
    try { process.kill(previous.pid, 0); throw Error('RUN_ALREADY_LOCKED'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await fsp.unlink(lock);
    handle = await fsp.open(lock, 'wx', 0o600);
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const state = JSON.parse(await fsp.readFile(statePath(root), 'utf8'));
    if (state.status !== 'running') return;
    if (state.schemaVersion === 2) {
      try { await verifyCompletedPages(root, state); }
      catch { await stop(root, state, 'CHECKPOINT_PAGE_EVIDENCE_MISMATCH'); return; }
    }
    if (state.intent && !(await reconcileIntent(root, state))) {
      await stop(root, state, 'UNCERTAIN_PREVIOUS_DOWNLOAD'); return;
    }
    while (!shutdownRequested && state.status === 'running') {
      if (finishIfReady(state)) { await save(root, state); await appendLog(root, 'collection_completed', { pages: state.pages.length }); break; }
      // A due action must also observe pause; waitUntil alone only checks while sleeping.
      if (fs.existsSync(path.join(root, 'stop-requested.json'))) {
        state.resumePhase = state.phase; state.resumeNextActionAt = state.nextActionAt;
        state.status = 'operator_stopped'; state.phase = 'stopped'; state.stopReason = 'LOCAL_STOP_REQUESTED';
        await save(root, state); break;
      }
      await waitUntil(root, state);
      if (shutdownRequested) break;
      if (state.status !== 'running') break;
      if (!(await checkControlLease(root, state))) break;
      if (state.supervisorPid) {
        try { process.kill(state.supervisorPid, 0); }
        catch { await stop(root, state, 'QUEUE_SUPERVISOR_LOST'); break; }
      }
      try { await step(root, state); }
      catch (error) { await handleError(root, state, error); }
    }
  } finally {
    await handle.close();
    await fsp.unlink(lock);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [command, argument, extra] = process.argv.slice(2);
  try {
    if (command === 'init') await init(Number(argument));
    else if (command === 'init-job') await initJob(JSON.parse(await fsp.readFile(path.resolve(argument || ''), 'utf8')));
    else if (command === 'run') await run(argument);
    else if (command === 'recover') await recover(argument);
    else if (command === 'resume-verified') await recover(argument, true);
    else if (command === 'verify-resume') await verifyResume(argument, String(extra || ''));
    else if (command === 'rebind-supervisor') await rebindSupervisor(argument, Number(extra));
    else if (command === 'activate-run') await activateRun(argument, String(extra || ''));
    else if (command === 'retire') await retire(argument);
    else if (command === 'status') console.log(await fsp.readFile(statusPath(path.resolve(argument || '')), 'utf8'));
    else throw Error('Usage: local-ego-soak.mjs init <space-id> | run <run-root> | status <run-root>');
  } catch (error) {
    console.error(String(error?.message || error).slice(0, 500));
    process.exitCode = 1;
  }
}
