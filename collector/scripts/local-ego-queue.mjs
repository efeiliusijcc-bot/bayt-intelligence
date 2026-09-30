// Local Ego queue worker. It never uses the 154 node or replays Bayt APIs.
// Activation requires the user to have completed the official-site challenge.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '../../data/local-runs');
const queueDir = path.resolve(here, '../../data/local-queue');
const activePath = path.join(queueDir, 'active.json');
const agentId = `local-ego-${os.hostname().replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
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

async function request(route, body, leaseToken) {
  const response = await fetch(`${controlUrl}/api/v1/collector/agent${route}`, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(leaseToken ? { 'x-collector-lease': leaseToken } : {}) }, body: JSON.stringify(body),
  });
  if (!response.ok) throw Error(`CONTROL_HTTP_${response.status}_${(await response.text()).slice(0, 100)}`);
  return response.status === 204 ? null : await response.json();
}

async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.rename(temp, file);
}

export function startSearchFailure(error) {
  const detail = String(error?.message || error);
  const rayId = detail.match(/rayId=([a-f0-9]{8,64})/i)?.[1] || null;
  if (/BAYT_VERIFICATION_REQUIRED/.test(detail)) return {
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
  const script = await fsp.readFile(path.join(here, 'local-ego-advanced-action.mjs'), 'utf8');
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
        if (!['completed', 'operator_stopped', 'safety_stopped'].includes(state.status)) return true;
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
  await completeRunRegistration(active, state,
    item => request(`/jobs/${encodeURIComponent(item.jobId)}/runs`,
      { agentId, runId: path.basename(item.root), searchId: item.searchId }, item.leaseToken),
    item => atomicJson(activePath, item));
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
  await atomicJson(inputPath, { spaceId, job: { id: job.id, searchSpec: job.searchSpec, limits: job.limits },
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
  if (!lockAlive(path.join(root, 'uploader.lock'))) {
    const upload = spawn(process.execPath, ['--experimental-strip-types', path.join(here, 'local-ego-upload.mjs'), root],
      { cwd: here, env: process.env, stdio: 'ignore', detached: true });
    upload.on('error', () => {});
    upload.unref();
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

async function activePulse(active) {
  let state = await readJson(path.join(active.root, 'checkpoint.json'));
  const job = await request(`/jobs/${encodeURIComponent(active.jobId)}/heartbeat`, {
    agentId, evidence: { searchId: active.searchId, matchedCount: active.matchedCount,
      actualFilterLabels: active.actualFilterLabels } }, active.leaseToken);
  if (job.pauseRequested) await atomicJson(path.join(active.root, 'stop-requested.json'), { at: new Date().toISOString(), reason: 'queue_pause' });
  const activated = await bootstrapRun(active, state, {
    register: ensureRunRegistered,
    activate: item => runProcess(process.execPath,
      ['--experimental-strip-types', path.join(here, 'local-ego-soak.mjs'), 'activate-run', item.root, item.jobId]),
    rebind: item => runProcess(process.execPath,
      ['--experimental-strip-types', path.join(here, 'local-ego-soak.mjs'), 'rebind-supervisor', item.root, String(process.pid)]),
  });
  if (activated) state = await readJson(path.join(active.root, 'checkpoint.json'));
  try { await checkpointUploaded(active, state); }
  catch (error) {
    if (/UPLOAD_BLOCKED|RECEIPT_INVALID|PAGE_CHECKPOINT_CONFLICT/.test(String(error.message))) {
      await terminal(active, 'UPLOAD_EVIDENCE_BLOCKED', '上传回执、文件或页级检查点冲突，已停止自动执行');
      return false;
    }
    throw error;
  }
  if (state.status === 'running') { launchWorkers(active.root); return true; }
  if ((state.pages || []).length > active.checkpointedPages.length) {
    if (!active.uploadBacklogSince) { active.uploadBacklogSince = new Date().toISOString(); await atomicJson(activePath, active); }
    if (Date.now() - Date.parse(active.uploadBacklogSince) < 60 * 60_000) return true;
    await terminal(active, 'UPLOAD_BACKLOG_TIMEOUT', '已完成页面上传超过一小时未能确认，请核对独立上传进程');
    return false;
  }
  if (state.status === 'operator_stopped' && job.pauseRequested) {
    await request(`/jobs/${encodeURIComponent(active.jobId)}/pause-ack`, { agentId }, active.leaseToken);
    await fsp.unlink(activePath); return false;
  }
  if (state.status === 'completed') {
    if ((state.pages || []).length !== active.checkpointedPages.length) return true;
    if (!state.pages?.length) { await terminal(active, 'JOB_HAS_NO_COMPLETE_PAGE', '任务没有经校验的完整页面'); return false; }
    await request(`/jobs/${encodeURIComponent(active.jobId)}/complete`, { agentId }, active.leaseToken);
    await fsp.unlink(activePath); return false;
  }
  if (state.status === 'awaiting_verification') {
    await terminal(active, 'BAYT_VERIFICATION_REQUIRED', '官网验证需要人工接手；本机任务已停在检查点'); return false;
  }
  await terminal(active, state.stopReason || 'LOCAL_RUN_STOPPED', '本机采集已安全停止，请核对检查点和未确定下载');
  return false;
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
  while (true) {
    try {
      const needsVerification = await verificationPending();
      await request('/heartbeat', { agentId, name: '本机 Ego Agent', version: '2', currentJobId: active?.jobId || null,
        chromeReady: enabled && !needsVerification,
        loginState: !enabled ? 'login_required' : needsVerification ? 'unknown' : 'logged_in' });
      if (!enabled) { await delay(30_000); continue; }
      if (needsVerification) { await delay(30_000); continue; }
      if (active) {
        if (!(await activePulse(active))) active = null;
      } else if (!(await blockedByExistingRun())) {
        await syncCatalog();
        const claim = await request('/jobs/claim', { agentId });
        if (claim.job && claim.leaseToken) {
          let heartbeatBusy = false;
          const keepLease = setInterval(async () => {
            if (heartbeatBusy) return;
            heartbeatBusy = true;
            try { await request(`/jobs/${encodeURIComponent(claim.job.id)}/heartbeat`, { agentId }, claim.leaseToken); }
            catch (error) { console.error(JSON.stringify({ event: 'lease_heartbeat_error', code: String(error.message).slice(0, 80) })); }
            finally { heartbeatBusy = false; }
          }, 30_000);
          try { active = await startRun(claim.job, claim.leaseToken); }
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
              const failure = startSearchFailure(error);
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
      if (active && /INVALID_JOB_LEASE|CONTROL_HTTP_409/.test(String(error.message))) throw error;
    }
    await delay(30_000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(String(error.message).slice(0, 200)); process.exitCode = 1; });
}
