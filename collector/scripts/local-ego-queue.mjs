// Local Ego queue worker. It never uses the 154 node or replays Bayt APIs.
// Activation requires the user to have completed the official-site challenge.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentId, localPageInput, verificationId, controlRequest as request } from './local-queue-control.mjs';
import { scheduleRecovery, recoveryKind, effectiveDeadline, retryAfterTime, automaticRecovery } from '../src/recovery.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '../../data/local-runs');
const queueDir = path.resolve(here, '../../data/local-queue');
const activePath = path.join(queueDir, 'active.json');
const controlUrl = (process.env.BAYT_CONTROL_URL || '').replace(/\/$/, '');
const token = process.env.BAYT_CONTROL_AGENT_TOKEN || '';
const spaceId = Number(process.env.BAYT_EGO_SPACE_ID || 0);
const enabled = process.env.BAYT_EGO_VERIFIED === '1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = async file => JSON.parse(await fsp.readFile(file, 'utf8'));

export function checkpointInput(page, receipt) {
  const manifest = page.manifest;
  if (receipt.status !== 'uploaded' || receipt.page !== page.page ||
    receipt.manifestSha256?.length !== 64 || !manifest?.verification?.exactMatch ||
    manifest.verification.zipCrcFailures !== 0 || manifest.verification.pdfEntries !== manifest.selectedCount ||
    receipt.excelSha256 !== manifest.files.excel.sha256 || receipt.pdfSha256 !== manifest.files.pdfArchive.sha256) {
    throw Error('QUEUE_UPLOAD_RECEIPT_INVALID');
  }
  return { page: page.page, selectedCount: manifest.selectedCount, cvIdSetSha256: manifest.cvIdSetSha256,
    excelSha256: manifest.files.excel.sha256, excelSizeBytes: manifest.files.excel.sizeBytes,
    pdfSha256: manifest.files.pdfArchive.sha256, pdfSizeBytes: manifest.files.pdfArchive.sizeBytes,
    pdfEntries: manifest.verification.pdfEntries, zipCrcOk: true, remoteBatch: receipt.remoteBatch };
}

async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.rename(temp, file);
}

export function startSearchFailure(error) {
  const detail = String(error?.message || error);
  const rayId = detail.match(/rayId=([a-f0-9]{8,64})/i)?.[1] || null;
  if (/BAYT_RATE_LIMIT|BAYT_429|HTTP_429/.test(detail)) return { code: 'BAYT_429', message: '官网限流，停止领取新任务并保留原检查点', rayId: null };
  if (/BAYT_VERIFICATION_REQUIRED|EGO_USER_CONTROL_REQUIRED|USER_VERIFICATION_REQUIRED|BAYT_LOGIN_REQUIRED/.test(detail)) return {
    code: 'BAYT_VERIFICATION_REQUIRED',
    message: `官网验证需要人工接手${rayId ? `；Ray ID ${rayId}` : ''}`,
    rayId,
  };
  return { code: 'SEARCH_FORM_UNVERIFIED', message: detail.slice(0, 200), rayId: null };
}

async function handOffStartChallenge(jobId, failure) {
  const markerPath = path.join(queueDir, 'awaiting-verification.json');
  let previous = null;
  try { previous = await readJson(markerPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await atomicJson(markerPath, { jobId, at: new Date().toISOString(), status: 'awaiting_verification',
    code: failure.code, rayId: failure.rayId });
  try { await ego({ action: 'handoff' }); }
  catch (error) { console.error(JSON.stringify({ event: 'ego_handoff_error', code: String(error.message).slice(0, 100) })); }
  if (previous?.jobId === jobId && previous?.rayId === failure.rayId) return;
  await new Promise(resolve => {
    const child = spawn('/usr/bin/osascript', ['-e',
      'display notification "Bayt 页面需要人工验证。完成后请回复：已验证。" with title "Bayt 采集暂停"'],
    { stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

export async function verificationPending(markerPath = path.join(queueDir, 'awaiting-verification.json')) {
  try { return (await readJson(markerPath)).status === 'awaiting_verification'; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function runProcess(command, args, stdin = null, timeoutMs = 300_000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: here, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', chunk => { out += String(chunk).slice(0, 200_000); });
    child.stderr.on('data', chunk => { err += String(chunk).slice(0, 200_000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(Error('ACTION_TIMEOUT'));
      else if (code !== 0) reject(Error((err || out).slice(-500) || `ACTION_EXIT_${code}`));
      else resolve({ out, err });
    });
    child.stdin.end(stdin || '');
  });
}

async function ego(action) {
  const script = await fsp.readFile(path.join(here, action.action === 'automaticRecovery' ? 'local-ego-recovery-action.mjs' : 'local-ego-advanced-action.mjs'), 'utf8');
  const result = await runProcess('ego-browser', ['nodejs'],
    `globalThis.BAYT_EGO_ACTION_JSON=${JSON.stringify(JSON.stringify({ ...action, spaceId }))};\n${script}`);
  const line = `${result.out}\n${result.err}`.split('\n').find(item => item.startsWith('BAYT_EGO_RESULT='));
  if (!line) throw Error('EGO_RESULT_MISSING');
  return JSON.parse(line.slice('BAYT_EGO_RESULT='.length));
}

export async function blockedByExistingRun(runBase = base) {
  try {
    const entries = await fsp.readdir(runBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('local-ego-')) continue;
      try {
        // The checkpoint is authoritative: init-job writes it before status.json.
        // A crash in that window must not allow another search to be claimed.
        const state = await readJson(path.join(runBase, entry.name, 'checkpoint.json'));
        if (!['completed', 'operator_stopped', 'safety_stopped', 'awaiting_verification'].includes(state.status)) return true;
      } catch {
        // An incomplete or corrupt local-ego run needs operator review too.
        return true;
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return false;
}

export function assertNewSearchAllowed(job) {
  // A registered searchId may already have a verified page. A fresh search
  // would generate a different ID and could repeat that page's downloads.
  if (job.searchId) throw Error('EXISTING_SEARCH_ID_REQUIRES_CHECKPOINT_RESUME');
}

export function assertResumeClaim(job, runId, state, receipts) {
  if (!job?.searchId || !/^local-ego-[A-Za-z0-9_-]{1,70}$/.test(runId || '') ||
    state?.schemaVersion !== 2 || state.runId !== runId || state.queueJobId !== job.id ||
    state.searchId !== job.searchId || !['safety_stopped', 'operator_stopped', 'awaiting_verification'].includes(state.status) ||
    /UNCERTAIN|RETIRED|MISMATCH|CRC|MAPPING|INVALID/.test(state.stopReason || '') ||
    state.intent || (job.limits?.durationHours && !Number.isFinite(Date.parse(state.deadlineAt))) ||
    JSON.stringify(state.searchSpec) !== JSON.stringify(job.searchSpec) ||
    JSON.stringify(state.limits) !== JSON.stringify(job.limits)) throw Error('CHECKPOINT_RESUME_IDENTITY_INVALID');
  const pages = state.pages || [];
  if (pages.length < (job.pages || []).length ||
    ![pages.length, pages.length + 1].includes(state.current?.page) ||
    state.seenIds?.length !== pages.reduce((sum, item) => sum + item.count, 0) ||
    new Set(state.seenIds).size !== state.seenIds.length ||
    receipts.length !== pages.length) throw Error('CHECKPOINT_RESUME_PAGES_INVALID');
  for (let index = 0; index < pages.length; index++) {
    const local = pages[index], remote = (job.pages || []).find(item => item.page === local.page), receipt = receipts[index];
    const uploaded = localPageInput(local);
    if (local.page !== index + 1) throw Error('CHECKPOINT_RESUME_PAGES_INVALID');
    if (!remote) continue; // A verified local page may still be waiting for its independent uploader.
    if (!receipt) throw Error('CHECKPOINT_RESUME_RECEIPT_MISSING');
    checkpointInput(local, receipt);
    if (remote.selectedCount !== uploaded.selectedCount ||
      remote.cvIdSetSha256 !== uploaded.cvIdSetSha256 || remote.excelSha256 !== uploaded.excelSha256 ||
      remote.pdfSha256 !== uploaded.pdfSha256 || remote.remoteBatch !== receipt.remoteBatch)
      throw Error('CHECKPOINT_RESUME_REMOTE_MISMATCH');
  }
}

export function terminalAcknowledged(active, local, remote) {
  if (remote?.id !== active.jobId || remote.searchId !== active.searchId) return false;
  if (remote.status === 'completed')
    return local.status === 'completed' && local.pages?.length > 0 &&
      ((remote.collectionFinishedAt && remote.collectedPages === local.pages.length) ||
        (remote.completedPages === local.pages.length && active.checkpointedPages.length === local.pages.length));
  if (remote.status === 'paused') return local.status === 'operator_stopped';
  if (remote.status === 'safety_stopped')
    return ['safety_stopped', 'awaiting_verification'].includes(local.status);
  return false;
}

export async function completeRunRegistration(active, state, send, persist) {
  if (!active.registrationPending) return;
  if (state.schemaVersion !== 2 || state.status !== 'prepared' ||
    state.queueJobId !== active.jobId || state.runId !== path.basename(active.root) ||
    state.searchId !== active.searchId || state.pages?.length || state.intent) {
    throw Error('PENDING_RUN_IDENTITY_UNVERIFIED');
  }
  // registerRun is idempotent for the same run/search pair. Persist the
  // acknowledgement only after 108 confirms it, so a crash retries this
  // registration rather than searching Bayt or downloading again.
  await send(active);
  const registered = { ...active, registrationPending: false };
  await persist(registered);
  Object.assign(active, registered);
}

export function claimedActive(candidate, claim, runBase = base) {
  if (!candidate || candidate.jobId !== claim.job?.id || candidate.leaseToken !== claim.leaseToken ||
    candidate.root?.startsWith(runBase + path.sep) !== true || !candidate.searchId) return null;
  return candidate;
}

export async function bootstrapRun(active, state, { register, activate, rebind }) {
  const prepared = state.status === 'prepared';
  if (prepared) {
    await register(active, state);
    await activate(active);
    active.needsRebind = true;
  } else if (active.registrationPending) throw Error('PENDING_RUN_IDENTITY_UNVERIFIED');
  if ((prepared || state.status === 'running') && active.needsRebind) {
    await rebind(active);
    active.needsRebind = false;
  }
  return prepared;
}

async function ensureRunRegistered(active, state) {
  const access = await uploadAccess(active);
  await completeRunRegistration(active, state,
    item => request(`/jobs/${encodeURIComponent(item.jobId)}/runs`,
      { agentId, runId: path.basename(item.root), searchId: item.searchId, uploadToken: access.uploadToken }, item.leaseToken),
    item => atomicJson(activePath, item));
  await atomicJson(path.join(active.root, 'control-lease.json'), { confirmedAt: new Date().toISOString() });
}

async function uploadAccess(active) {
  const file = path.join(active.root, 'control-upload.json');
  let access;
  try { access = await readJson(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    access = { jobId: active.jobId, runId: path.basename(active.root), agentId, uploadToken: crypto.randomBytes(32).toString('base64url') };
    await atomicJson(file, access);
  }
  if (access.jobId !== active.jobId || access.runId !== path.basename(active.root) || access.agentId !== agentId)
    throw Error('UPLOAD_RUN_IDENTITY_INVALID');
  return access;
}

async function ensureUploadRegistered(active) {
  const access = await uploadAccess(active);
  if (!active.uploadRegistered) {
    await request(`/jobs/${encodeURIComponent(active.jobId)}/runs`, { ...access, searchId: active.searchId }, active.leaseToken);
    active.uploadRegistered = true;
    await atomicJson(activePath, active);
  }
  return access;
}

async function syncCatalog() {
  const result = await request('/filter-catalog/claim', { agentId });
  if (!result.request) return;
  try {
    const cityCountries = (process.env.BAYT_CATALOG_CITY_COUNTRIES || '').split(',').map(value => value.trim()).filter(Boolean);
    const catalog = await ego({ action: 'catalog', cityCountries });
    await request('/filter-catalog/complete', { agentId, requestId: result.request.id, catalog });
  } catch (error) {
    await request('/filter-catalog/fail', { agentId, requestId: result.request.id, message: String(error.message).slice(0, 200) });
  }
}

async function startRun(job, leaseToken) {
  assertNewSearchAllowed(job);
  if (await blockedByExistingRun()) throw Error('EXISTING_LOCAL_RUN_REQUIRES_REVIEW');
  const result = await ego({ action: 'startSearch', searchSpec: job.searchSpec });
  if (!result.searchId || result.page !== 1 || result.keyword !==
    [job.searchSpec.keyword, job.searchSpec.approximateLocationKeyword].filter(Boolean).join(' ') ||
    !result.ids?.length || result.ids.length > 50 || new Set(result.ids).size !== result.ids.length) {
    throw Error('SEARCH_RESULT_IDENTITY_UNVERIFIED');
  }
  const inputPath = path.join(queueDir, `init-${job.id}.json`);
  await atomicJson(inputPath, { spaceId, job: { id: job.id, searchSpec: job.searchSpec, limits: job.limits, startedAt: job.startedAt },
    actualKeyword: result.keyword, supervisorPid: process.pid });
  let root;
  try {
    const result = await runProcess(process.execPath, ['--experimental-strip-types', path.join(here, 'local-ego-soak.mjs'), 'init-job', inputPath]);
    root = result.out.trim().split('\n').at(-1);
  } finally { await fsp.unlink(inputPath).catch(() => undefined); }
  if (!root?.startsWith(base + path.sep)) throw Error('RUN_ROOT_INVALID');
  const active = { jobId: job.id, leaseToken, root, checkpointedPages: [], searchId: result.searchId,
    registrationPending: true,
    matchedCount: Number.isInteger(result.matchedCount) ? result.matchedCount : null,
    actualFilterLabels: result.actualFilterLabels || [] };
  // Save the exact prepared run before the network call. If 108 is unreachable
  // or this process exits, the next start sees this run and cannot re-search.
  await atomicJson(activePath, active);
  await ensureRunRegistered(active, await readJson(path.join(root, 'checkpoint.json')));
  await runProcess(process.execPath, ['--experimental-strip-types', path.join(here, 'local-ego-soak.mjs'), 'activate-run', root, job.id]);
  launchWorkers(root);
  return active;
}

async function startResume(job, leaseToken, runId) {
  const root = path.join(base, runId || '');
  if (!runId || path.basename(root) !== runId || await blockedByExistingRun())
    throw Error('CHECKPOINT_RESUME_RUN_UNAVAILABLE');
  const state = await readJson(path.join(root, 'checkpoint.json'));
  const receipts = [];
  for (const page of state.pages || []) {
    const name = `${String(page.page).padStart(4, '0')}.json`;
    let receipt = null;
    try { receipt = await readJson(path.join(root, 'upload-receipts', name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const manifestFile = await fsp.readFile(path.join(root, 'batches', String(page.page).padStart(4, '0'), 'manifest.json'));
    if (receipt && (receipt.status !== 'uploaded' || receipt.manifestSha256 !== crypto.createHash('sha256').update(manifestFile).digest('hex')))
      throw Error('CHECKPOINT_RESUME_MANIFEST_MISMATCH');
    receipts.push(receipt);
  }
  assertResumeClaim(job, runId, state, receipts);
  await runProcess(process.execPath, ['--experimental-strip-types', path.join(here, 'local-ego-soak.mjs'), 'verify-resume', root, job.id]);
  let userVerified = false;
  try {
    const marker = await readJson(path.join(queueDir, 'awaiting-verification.json'));
    userVerified = marker.status === 'verified' && Date.parse(marker.verifiedAt) >= Date.parse(state.challenge?.notifiedAt || state.updatedAt);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state.status === 'awaiting_verification' && !userVerified) throw Error('USER_VERIFICATION_REQUIRED');
  const active = { jobId: job.id, leaseToken, root, checkpointedPages: job.pages.map(page => page.page), userVerified,
    searchId: job.searchId, matchedCount: job.matchedCount, actualFilterLabels: job.actualFilterLabels,
    recoveryPending: true, needsRebind: true };
  await atomicJson(activePath, active);
  return active;
}

function launchWorkers(root) {
  const lockAlive = lock => {
    try { const pid = JSON.parse(fs.readFileSync(lock, 'utf8')).pid; process.kill(pid, 0); return true; }
    catch { return false; }
  };
  if (!lockAlive(path.join(root, 'worker.lock'))) {
    const soak = spawn(process.execPath, ['--experimental-strip-types', path.join(here, 'local-ego-soak.mjs'), 'run', root],
      { cwd: here, env: process.env, stdio: 'ignore' });
    soak.on('error', () => {});
  }
  launchUploader(root);
}

function launchUploader(root) {
  let alive = false;
  try { process.kill(JSON.parse(fs.readFileSync(path.join(root, 'uploader.lock'), 'utf8')).pid, 0); alive = true; }
  catch { /* Only launch if the previous uploader is not alive. */ }
  if (!alive) {
    const upload = spawn(process.execPath, ['--experimental-strip-types', path.join(here, 'local-ego-upload.mjs'), root],
      { cwd: here, env: process.env, stdio: 'ignore', detached: true });
    upload.on('error', () => {});
    upload.unref();
  }
}

async function restoreUploadBacklogs() {
  const entries = await fsp.readdir(base, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('local-ego-')) continue;
    const root = path.join(base, entry.name);
    try {
      const access = await readJson(path.join(root, 'control-upload.json'));
      const state = await readJson(path.join(root, 'checkpoint.json'));
      if (access.runId !== state.runId || access.jobId !== state.queueJobId || access.agentId !== agentId) continue;
      for (const page of state.pages) {
        let receipt;
        try { receipt = await readJson(path.join(root, 'upload-receipts', `${String(page.page).padStart(4, '0')}.json`)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!receipt?.controlAcknowledged && receipt?.status !== 'blocked') { launchUploader(root); break; }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(JSON.stringify({ event: 'upload_backlog_review', runId: entry.name }));
    }
  }
}

async function checkpointUploaded(active, state) {
  for (const page of state.pages || []) {
    if (active.checkpointedPages.includes(page.page)) continue;
    let receipt;
    try { receipt = await readJson(path.join(active.root, 'upload-receipts', `${String(page.page).padStart(4, '0')}.json`)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (receipt.status === 'blocked') throw Error('UPLOAD_BLOCKED');
    const input = checkpointInput(page, receipt);
    await request(`/jobs/${encodeURIComponent(active.jobId)}/checkpoints`, { agentId, ...input }, active.leaseToken);
    active.checkpointedPages.push(page.page);
    await atomicJson(activePath, active);
  }
}

async function terminal(active, code, message) {
  await request(`/jobs/${encodeURIComponent(active.jobId)}/safety-stop`, { agentId, code, message }, active.leaseToken);
  await fsp.unlink(activePath);
}

async function scheduleActiveRecovery(active, error) {
  const kind = recoveryKind(String(error.message || error));
  if (!kind) return false;
  active.recovery = scheduleRecovery(active.recovery, kind, active.root ? 'checkpoint_resume' : 'start_search', crypto.randomUUID());
  await atomicJson(activePath, active);
  return true;
}

async function checkActiveRecovery(active) {
  const r = active.recovery;
  if (!r) return 'ready';
  if (Date.now() < Date.parse(r.nextCheckAt)) return 'waiting';
  if (r.stage !== 'probing') { r.stage = 'probing'; r.attempts++; await atomicJson(activePath, active); }
  const result = await ego({ action: 'automaticRecovery', recovery: r,
    attemptDirectory: path.join(active.root || queueDir, 'recovery-attempts') });
  if (result.kind === 'rate_limit') {
    active.recovery = scheduleRecovery(r, 'rate_limit', r.resumePhase, r.id, Date.now(), retryAfterTime(result.retryAfter));
    await atomicJson(activePath, active); return 'waiting';
  }
  if (result.kind !== 'ready') {
    r.stage = 'manual_required'; await atomicJson(activePath, active);
    await handOffStartChallenge(active.jobId, { code: 'BAYT_VERIFICATION_REQUIRED', rayId: result.rayId });
    await terminal(active, 'BAYT_VERIFICATION_REQUIRED', '自动验证未完成或需要登录，已交还 Ego');
    return 'manual';
  }
  active.recovery = null; active.userVerified = true;
  await atomicJson(activePath, active);
  return 'ready';
}

async function startupPulse(active) {
  const job = await request(`/jobs/${encodeURIComponent(active.jobId)}/heartbeat`, { agentId,
    evidence: { phase: active.recovery ? 'automatic_recovery' : 'start_search', recovery: active.recovery || null,
      noDownloadIntent: true, nextActionAt: active.recovery?.nextCheckAt || null } }, active.leaseToken);
  if (job.pauseRequested) {
    await request(`/jobs/${encodeURIComponent(active.jobId)}/pause-ack`, { agentId }, active.leaseToken);
    await fsp.unlink(activePath); return null;
  }
  if (job.limits.durationHours && Date.now() >= Date.parse(job.startedAt) + job.limits.durationHours * 3_600_000) {
    await terminal(active, 'JOB_HAS_NO_COMPLETE_PAGE', '持续时长已到，搜索阶段未产生完整页面'); return null;
  }
  try {
    const outcome = await checkActiveRecovery(active);
    if (outcome === 'manual') return null;
    if (outcome === 'waiting') return active;
    return await startRun(job, active.leaseToken);
  } catch (error) {
    const saved = await readJson(activePath);
    if (saved.root) return saved; // A prepared run must never be replaced by another search.
    if (await scheduleActiveRecovery(active, error)) return active;
    const failure = startSearchFailure(error);
    if (failure.code === 'BAYT_VERIFICATION_REQUIRED') await handOffStartChallenge(active.jobId, failure);
    await terminal(active, failure.code, failure.message); return null;
  }
}

async function activePulse(active) {
  let state = await readJson(path.join(active.root, 'checkpoint.json'));
  const job = await request(`/jobs/${encodeURIComponent(active.jobId)}/heartbeat`, {
    agentId, evidence: { searchId: active.searchId, matchedCount: active.matchedCount,
      actualFilterLabels: active.actualFilterLabels, phase: active.recovery || state.recovery ? 'automatic_recovery' : state.phase,
      recovery: active.recovery || state.recovery || null, noDownloadIntent: !state.intent,
      nextActionAt: active.recovery?.nextCheckAt || state.nextActionAt } }, active.leaseToken);
  await atomicJson(path.join(active.root, 'control-lease.json'), { confirmedAt: new Date().toISOString() });
  if (job.pauseRequested) await atomicJson(path.join(active.root, 'stop-requested.json'), { at: new Date().toISOString(), reason: 'queue_pause' });
  if (state.status === 'safety_stopped' && automaticRecovery(state.recovery) &&
    ['LOCAL_LEASE_HEARTBEAT_LOST', 'QUEUE_SUPERVISOR_LOST'].includes(state.stopReason) && !state.intent) {
    await runProcess(process.execPath, ['--experimental-strip-types', path.join(here, 'local-ego-soak.mjs'), 'rebind-supervisor', active.root, String(process.pid)]);
    state = await readJson(path.join(active.root, 'checkpoint.json'));
  }
  // Register an independent, run-bound uploader before releasing any collection lease.
  if (state.status !== 'prepared') await ensureUploadRegistered(active);
  if (active.recoveryPending) {
    try {
      if (job.pauseRequested) {
        await request(`/jobs/${encodeURIComponent(active.jobId)}/pause-ack`, { agentId }, active.leaseToken);
        await fsp.unlink(activePath); return false;
      }
      if (active.recovery) {
        const outcome = await checkActiveRecovery(active);
        if (outcome === 'manual') return false;
        if (outcome === 'waiting') return true;
      }
      if (['safety_stopped', 'operator_stopped', 'awaiting_verification'].includes(state.status)) {
        await runProcess(process.execPath, ['--experimental-strip-types', path.join(here, 'local-ego-soak.mjs'), active.userVerified ? 'resume-verified' : 'recover', active.root]);
        state = await readJson(path.join(active.root, 'checkpoint.json'));
      }
      if (state.status === 'awaiting_verification') {
        await atomicJson(path.join(queueDir, 'awaiting-verification.json'), {
          jobId: active.jobId, at: new Date().toISOString(), status: 'awaiting_verification',
          code: 'BAYT_VERIFICATION_REQUIRED', rayId: state.challenge?.rayId || null });
        await terminal(active, 'BAYT_VERIFICATION_REQUIRED', '官网验证需要人工接手；检查点保持不变');
        return false;
      }
      if (!['running', 'completed'].includes(state.status)) throw Error('CHECKPOINT_RECOVERY_NOT_RUNNING');
      active.recoveryPending = false;
      await atomicJson(activePath, active);
    } catch (error) {
      if (await scheduleActiveRecovery(active, error)) return true;
      const failure = startSearchFailure(error);
      if (failure.code === 'BAYT_VERIFICATION_REQUIRED') await handOffStartChallenge(active.jobId, failure);
      await terminal(active, ['BAYT_VERIFICATION_REQUIRED', 'BAYT_429'].includes(failure.code) ? failure.code : 'CHECKPOINT_RESUME_BLOCKED', String(error.message).slice(0, 180));
      return false;
    }
  }
  const activated = await bootstrapRun(active, state, {
    register: ensureRunRegistered,
    activate: item => runProcess(process.execPath,
      ['--experimental-strip-types', path.join(here, 'local-ego-soak.mjs'), 'activate-run', item.root, item.jobId]),
    rebind: item => runProcess(process.execPath,
      ['--experimental-strip-types', path.join(here, 'local-ego-soak.mjs'), 'rebind-supervisor', item.root, String(process.pid)]),
  });
  if (activated) state = await readJson(path.join(active.root, 'checkpoint.json'));
  await ensureUploadRegistered(active);
  const pages = (state.pages || []).map(localPageInput);
  await request(`/jobs/${encodeURIComponent(active.jobId)}/local-pages`,
    { agentId, runId: path.basename(active.root), pages }, active.leaseToken);
  launchUploader(active.root);
  if (state.status === 'running') { launchWorkers(active.root); return true; }
  if (state.status === 'operator_stopped' && job.pauseRequested) {
    await request(`/jobs/${encodeURIComponent(active.jobId)}/pause-ack`, { agentId }, active.leaseToken);
    await fsp.unlink(activePath); return false;
  }
  if (state.status === 'completed') {
    if (!state.pages?.length) { await terminal(active, 'JOB_HAS_NO_COMPLETE_PAGE', '任务没有经校验的完整页面'); return false; }
    const access = await uploadAccess(active);
    await request(`/jobs/${encodeURIComponent(active.jobId)}/collection-complete`,
      { ...access, pages, cooldownUntil: state.browserCooldownUntil || null }, active.leaseToken);
    await fsp.unlink(activePath); return false;
  }
  if (state.status === 'awaiting_verification') {
    await atomicJson(path.join(queueDir, 'awaiting-verification.json'), {
      jobId: active.jobId, at: new Date().toISOString(), status: 'awaiting_verification',
      code: 'BAYT_VERIFICATION_REQUIRED', rayId: state.challenge?.rayId || null });
    await terminal(active, 'BAYT_VERIFICATION_REQUIRED', '官网验证需要人工接手；本机任务已停在检查点'); return false;
  }
  await terminal(active, state.stopReason || 'LOCAL_RUN_STOPPED', '本机采集已安全停止，请核对检查点和未确定下载');
  return false;
}

export async function withLeaseHeartbeat(owner, operation, send = request, intervalMs = 30_000) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await send(`/jobs/${encodeURIComponent(owner.jobId)}/heartbeat`, { agentId }, owner.leaseToken);
      if (owner.root && send === request) await atomicJson(path.join(owner.root, 'control-lease.json'), { confirmedAt: new Date().toISOString() });
    }
    catch (error) { console.error(JSON.stringify({ event: 'lease_heartbeat_error', code: String(error.message).slice(0, 100) })); }
    finally { busy = false; }
  }, intervalMs);
  try { return await operation(); }
  finally { clearInterval(timer); }
}

async function handleVerificationRequest() {
  const markerPath = path.join(queueDir, 'awaiting-verification.json');
  const marker = await readJson(markerPath);
  const id = verificationId(marker);
  const item = marker.requestId ? { id: marker.requestId, interrupted: true } :
    (await request('/verification/claim', { agentId, verificationId: id })).request;
  if (!item) return false;
  if (!marker.requestId) await atomicJson(markerPath, { ...marker, requestId: item.id });
  const resultPath = path.join(queueDir, `verification-${item.id}.json`);
  let result;
  try { result = await readJson(resultPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A crash after dispatch is uncertain: never repeat a takeover without another user confirmation.
    let verified = false;
    if (!item.interrupted) {
      try { verified = (await ego({ action: 'verifySession' })).verified === true; }
      catch { /* Remain handed off. */ }
    }
    result = { requestId: item.id, verificationId: id, verified, at: new Date().toISOString() };
    await atomicJson(resultPath, result);
  }
  await request('/verification/complete', { agentId, ...result });
  if (!result.verified) {
    await atomicJson(markerPath, { ...marker, requestId: null, lastVerificationFailedAt: result.at });
    return false;
  }
  // Never erase a newer challenge marker that appeared while checking this one.
  if (verificationId(await readJson(markerPath)) !== id) return false;
  await atomicJson(markerPath, { ...marker, status: 'verified', verifiedAt: result.at, requestId: item.id });
  return true;
}

async function main() {
  if (!/^https:\/\//.test(controlUrl) || token.length < 32 || !Number.isInteger(spaceId) || spaceId < 1) throw Error('QUEUE_CONFIG_REQUIRED');
  await fsp.mkdir(queueDir, { recursive: true, mode: 0o700 });
  let active = null;
  try { active = await readJson(activePath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Rebinding and pending registration happen inside the ordinary retry loop.
  // A temporary 108 outage during startup must not discard this active run.
  if (active) active.needsRebind = true;
  let waitReason = null, waitUntil = null;
  while (true) {
    try {
      await restoreUploadBacklogs();
      const needsVerification = await verificationPending();
      const marker = needsVerification ? await readJson(path.join(queueDir, 'awaiting-verification.json')) : null;
      const currentRecovery = active?.recovery || (active?.root ? (await readJson(path.join(active.root, 'checkpoint.json'))).recovery : null);
      await request('/heartbeat', { agentId, name: '本机 Ego Agent', version: '4', currentJobId: active?.jobId || null,
        chromeReady: enabled && !needsVerification && !currentRecovery,
        loginState: !enabled ? 'login_required' : needsVerification ? 'verification_required' : 'logged_in',
        verificationId: marker ? verificationId(marker) : null, waitReason: needsVerification ? marker.lastVerificationFailedAt ? 'verification_failed' : 'verification_required' : currentRecovery ? 'automatic_recovery' : waitReason,
        nextActionAt: currentRecovery?.nextCheckAt || waitUntil });
      if (!enabled) { await delay(30_000); continue; }
      if (needsVerification) {
        if (active) {
          await terminal(active, 'BAYT_VERIFICATION_REQUIRED', '官网验证等待用户确认；保留检查点');
          active = null;
        }
        await handleVerificationRequest(); await delay(30_000); continue;
      }
      if (active) {
        if (active.startPending) active = await withLeaseHeartbeat(active, () => startupPulse(active));
        else if (!(await withLeaseHeartbeat(active, () => activePulse(active)))) active = null;
      } else if (!(await blockedByExistingRun())) {
        await syncCatalog();
        const claim = await request('/jobs/claim', { agentId });
        waitReason = claim.waitReason || null; waitUntil = claim.waitUntil || null;
        if (claim.job && claim.leaseToken) {
          let heartbeatBusy = false;
          const keepLease = setInterval(async () => {
            if (heartbeatBusy) return;
            heartbeatBusy = true;
            try { await request(`/jobs/${encodeURIComponent(claim.job.id)}/heartbeat`, { agentId }, claim.leaseToken); }
            catch (error) { console.error(JSON.stringify({ event: 'lease_heartbeat_error', code: String(error.message).slice(0, 80) })); }
            finally { heartbeatBusy = false; }
          }, 30_000);
          try {
            if (claim.resumeRunId) active = await startResume(claim.job, claim.leaseToken, claim.resumeRunId);
            else {
              active = { jobId: claim.job.id, leaseToken: claim.leaseToken, startPending: true, recovery: null };
              await atomicJson(activePath, active);
            }
          }
          catch (error) {
            let persisted = null;
            try { persisted = await readJson(activePath); }
            catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
            active = claimedActive(persisted, claim);
            if (active) {
              active.needsRebind = true;
              console.error(JSON.stringify({ event: 'run_bootstrap_deferred',
                code: String(error.message).slice(0, 120), jobId: active.jobId }));
            } else {
              const classified = startSearchFailure(error);
              const failure = claim.resumeRunId && !['BAYT_VERIFICATION_REQUIRED', 'BAYT_429'].includes(classified.code)
                ? { code: 'CHECKPOINT_RESUME_BLOCKED', message: String(error.message).slice(0, 180), rayId: null }
                : classified;
              if (failure.code === 'BAYT_VERIFICATION_REQUIRED') {
                await handOffStartChallenge(claim.job.id, failure);
              }
              await request(`/jobs/${encodeURIComponent(claim.job.id)}/safety-stop`, {
                agentId, code: failure.code, message: failure.message }, claim.leaseToken);
            }
          } finally { clearInterval(keepLease); }
        }
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'queue_agent_error', code: String(error.message).slice(0, 120) }));
      if (active && /INVALID_JOB_LEASE|CONTROL_HTTP_409/.test(String(error.message))) {
        try {
          const remote = await request(`/jobs/${encodeURIComponent(active.jobId)}/state`, { agentId });
          const local = active.root ? await readJson(path.join(active.root, 'checkpoint.json')) : { status: 'prepared' };
          if (remote.status === 'cancelled') {
            if (active.root) await atomicJson(path.join(active.root, 'stop-requested.json'), { at: new Date().toISOString(), reason: 'cancelled' });
            await fsp.unlink(activePath); active = null; continue;
          }
          const recovery = active.recovery || local.recovery;
          if (automaticRecovery(recovery) && !local.intent && ['running', 'pause_requested'].includes(remote.status)) {
            if (active.root) await runProcess(process.execPath, ['--experimental-strip-types', path.join(here, 'local-ego-soak.mjs'), 'verify-recovery', active.root]);
            if (!active.reclaimToken) { active.reclaimToken = crypto.randomBytes(32).toString('base64url'); await atomicJson(activePath, active); }
            await request(`/jobs/${encodeURIComponent(active.jobId)}/recovery/claim`,
              { agentId, newLeaseToken: active.reclaimToken, recoveryId: recovery.id }, active.leaseToken);
            active.leaseToken = active.reclaimToken; delete active.reclaimToken;
            active.needsRebind = true; await atomicJson(activePath, active);
            if (active.root) await atomicJson(path.join(active.root, 'control-lease.json'), { confirmedAt: new Date().toISOString() });
            continue;
          }
          if (terminalAcknowledged(active, local, remote)) {
            if (local.status === 'awaiting_verification') await atomicJson(path.join(queueDir, 'awaiting-verification.json'), {
              jobId: active.jobId, at: new Date().toISOString(), status: 'awaiting_verification',
              code: 'BAYT_VERIFICATION_REQUIRED', rayId: local.challenge?.rayId || null });
            await fsp.unlink(activePath);
            active = null;
            console.error(JSON.stringify({ event: 'terminal_ack_recovered', jobId: remote.id, status: remote.status }));
          }
        } catch (reconcileError) {
          console.error(JSON.stringify({ event: 'terminal_reconcile_deferred', code: String(reconcileError.message).slice(0, 100) }));
        }
      }
    }
    await delay(30_000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(String(error.message).slice(0, 200)); process.exitCode = 1; });
}
