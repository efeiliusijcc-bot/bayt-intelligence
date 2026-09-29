// Independent full-page publisher. It never asks Bayt for data or waits for the import service.
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBulkBatch } from '../src/bulk-batch.ts';
import { sha256File } from '../src/files.ts';
import { runSftp, uploadBatchAtomically } from '../src/sftp-upload.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '../../data/local-runs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `"${String(value).replaceAll('\\', '/').replaceAll('"', '\\"')}"`;
const receiptPath = (root, page) => path.join(root, 'upload-receipts', `${String(page).padStart(4, '0')}.json`);
const remoteBatch = (config, runId, page) => `${config.remoteRoot.replace(/\/$/, '')}/${runId}/batch-${String(page).padStart(4, '0')}`;
const config = {
  executable: process.env.BAYT_SFTP_EXECUTABLE || '/usr/bin/sftp',
  host: process.env.BAYT_SFTP_HOST || '',
  port: Number(process.env.BAYT_SFTP_PORT || 22),
  user: process.env.BAYT_SFTP_USER || '',
  identityFile: process.env.BAYT_SFTP_IDENTITY_FILE || '',
  knownHostsFile: process.env.BAYT_SFTP_KNOWN_HOSTS || path.join(os.homedir(), '.ssh', 'known_hosts'),
  remoteRoot: process.env.BAYT_SFTP_REMOTE_ROOT || '/incoming',
};

function notifyBlocked() {
  const child = spawn('/usr/bin/osascript', ['-e', 'display notification "上传发现远端同路径内容冲突，已停止覆盖，请检查接收状态。" with title "Bayt 上传阻断"'],
    { stdio: 'ignore' });
  child.on('error', () => {});
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.rename(temp, file);
}

export function assertPageEvidence(saved, checked, statePage) {
  if (saved.runId !== checked.runId || saved.page !== checked.page || saved.page !== statePage.page ||
      saved.selectedCount !== checked.selectedCount || saved.cvIdSetSha256 !== checked.cvIdSetSha256 ||
      saved.files?.excel?.sha256 !== checked.files.excel.sha256 ||
      saved.files?.pdfArchive?.sha256 !== checked.files.pdfArchive.sha256 ||
      saved.verification?.exactMatch !== true || saved.verification?.zipCrcFailures !== 0 ||
      statePage.cvIdSetSha256 !== checked.cvIdSetSha256) throw Error('LOCAL_PAGE_EVIDENCE_CONFLICT');
}

export function remoteDecision(existing, expected) {
  for (const [name, existingHash] of Object.entries(existing)) {
    if (existingHash !== expected[name]) return 'conflict';
  }
  return Object.keys(existing).length === Object.keys(expected).length ? 'complete' : 'upload';
}

async function getRemote(config, remote, dir) {
  const names = ['source.xls', 'bayt-cvs.zip', 'manifest.json'];
  for (const name of names) {
    try { await fsp.unlink(path.join(dir, name)); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  await runSftp(config, `${names.map(name => `-get ${quote(`${remote}/${name}`)} ${quote(path.join(dir, name))}`).join('\n')}\nbye\n`);
  const result = {};
  for (const name of names) {
    try { result[name] = await sha256File(path.join(dir, name)); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return result;
}

async function publish(root, state, page) {
  const dir = path.join(root, 'batches', String(page.page).padStart(4, '0'));
  const manifestPath = path.join(dir, 'manifest.json');
  const saved = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const ids = (await (await import('../src/excel.ts')).parseExcelExport(path.join(dir, 'resumes.xls'))).map(row => row.cvId);
  const checked = await verifyBulkBatch({ runId: state.runId, keyword: state.keyword, page: page.page,
    expectedCvIds: ids, excelPath: path.join(dir, 'resumes.xls'), pdfArchivePath: path.join(dir, 'resumes.zip') });
  assertPageEvidence(saved, checked, page);
  const manifestHash = await sha256File(manifestPath);
  const receiptFile = receiptPath(root, page.page);
  let receipt = null;
  try { receipt = JSON.parse(await fsp.readFile(receiptFile, 'utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (receipt?.status === 'uploaded' && receipt.manifestSha256 === manifestHash) return;
  if (receipt?.status === 'blocked') return;
  const remote = remoteBatch(config, state.runId, page.page);
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'bayt-sftp-check-'));
  try {
    const before = await getRemote(config, remote, temp);
    const expected = { 'source.xls': checked.files.excel.sha256,
      'bayt-cvs.zip': checked.files.pdfArchive.sha256, 'manifest.json': manifestHash };
    const decision = remoteDecision(before, expected);
    if (decision === 'conflict') {
      await writeJson(receiptFile, { status: 'blocked', reason: 'REMOTE_CONTENT_CONFLICT',
        page: page.page, remoteBatch: remote, at: new Date().toISOString() });
      throw Error('REMOTE_CONTENT_CONFLICT');
    }
    if (decision === 'upload') {
      await uploadBatchAtomically(config, { runId: state.runId, batchNo: page.page,
        excelPath: path.join(dir, 'resumes.xls'), pdfArchivePath: path.join(dir, 'resumes.zip'), manifestPath });
    }
    const after = await getRemote(config, remote, temp);
    if (Object.keys(expected).some(name => after[name] !== expected[name])) throw Error('REMOTE_READBACK_HASH_MISMATCH');
    await writeJson(receiptFile, { status: 'uploaded', page: page.page, count: checked.selectedCount,
      remoteBatch: remote, manifestSha256: manifestHash, excelSha256: expected['source.xls'],
      pdfSha256: expected['bayt-cvs.zip'], at: new Date().toISOString() });
    console.log(JSON.stringify({ event: 'page_uploaded', page: page.page, count: checked.selectedCount }));
  } finally { await fsp.rm(temp, { recursive: true, force: true }); }
}

async function run(root) {
  if (!config.host || !config.user || !config.identityFile) throw Error('BAYT_SFTP_HOST, BAYT_SFTP_USER and BAYT_SFTP_IDENTITY_FILE are required');
  root = path.resolve(root || '');
  if (!root.startsWith(base + path.sep)) throw Error('RUN_ROOT_OUTSIDE_LOCAL_RUNS');
  const lock = path.join(root, 'uploader.lock');
  let handle;
  try { handle = await fsp.open(lock, 'wx', 0o600); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const previous = JSON.parse(await fsp.readFile(lock, 'utf8'));
    try { process.kill(previous.pid, 0); throw Error('UPLOADER_ALREADY_RUNNING'); }
    catch (check) { if (check?.code !== 'ESRCH') throw check; }
    await fsp.unlink(lock);
    handle = await fsp.open(lock, 'wx', 0o600);
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const retries = new Map();
    while (true) {
      const state = JSON.parse(await fsp.readFile(path.join(root, 'checkpoint.json'), 'utf8'));
      for (const page of state.pages) {
        const retry = retries.get(page.page) || { attempts: 0, next: 0 };
        if (Date.now() < retry.next) continue;
        try { await publish(root, state, page); retries.delete(page.page); }
        catch (error) {
          const message = String(error?.message || error).slice(0, 150);
          console.error(JSON.stringify({ event: 'upload_error', page: page.page, code: message }));
          if (message === 'REMOTE_CONTENT_CONFLICT') notifyBlocked();
          retry.attempts += 1;
          retry.next = Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(retry.attempts, 6));
          retries.set(page.page, retry);
        }
      }
      await delay(30_000);
    }
  } finally { await handle.close(); await fsp.unlink(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv[2]).catch(error => { console.error(String(error?.message || error)); process.exitCode = 1; });
}
