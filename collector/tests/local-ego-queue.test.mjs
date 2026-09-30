import assert from 'node:assert/strict';
import test from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertNewSearchAllowed, assertResumeClaim, blockedByExistingRun, bootstrapRun, checkpointInput,
  claimedActive, completeRunRegistration, startSearchFailure, terminalAcknowledged, verificationPending, withLeaseHeartbeat } from '../scripts/local-ego-queue.mjs';

const manifest = { page: 1, selectedCount: 2, cvIdSetSha256: 'c'.repeat(64),
  files: { excel: { sha256: 'a'.repeat(64), sizeBytes: 120 }, pdfArchive: { sha256: 'b'.repeat(64), sizeBytes: 500 } },
  verification: { exactMatch: true, zipCrcFailures: 0, pdfEntries: 2 } };
const page = { page: 1, count: 2, cvIdSetSha256: manifest.cvIdSetSha256, manifest };
const receipt = { status: 'uploaded', page: 1, manifestSha256: 'd'.repeat(64),
  excelSha256: 'a'.repeat(64), pdfSha256: 'b'.repeat(64), remoteBatch: '/opt/bayt-intelligence/data/incoming/local-ego-test/batch-0001' };

test('only a verified complete-page upload receipt becomes a 108 checkpoint', () => {
  assert.equal(checkpointInput(page, receipt).pdfEntries, 2);
  assert.throws(() => checkpointInput(page, { ...receipt, status: 'blocked' }), /RECEIPT_INVALID/);
  assert.throws(() => checkpointInput(page, { ...receipt, excelSha256: 'e'.repeat(64) }), /RECEIPT_INVALID/);
  assert.throws(() => checkpointInput({ ...page, manifest: { ...manifest,
    verification: { ...manifest.verification, zipCrcFailures: 1 } } }, receipt), /RECEIPT_INVALID/);
});

test('a prepared run blocks a new claim even when status.json was not written', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bayt-queue-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'local-ego-prepared');
  await fsp.mkdir(run);
  await fsp.writeFile(path.join(run, 'checkpoint.json'), JSON.stringify({ status: 'prepared' }));
  assert.equal(await blockedByExistingRun(root), true);
  await fsp.writeFile(path.join(run, 'checkpoint.json'), JSON.stringify({ status: 'completed' }));
  assert.equal(await blockedByExistingRun(root), false);
  await fsp.writeFile(path.join(run, 'checkpoint.json'), JSON.stringify({ status: 'unknown' }));
  assert.equal(await blockedByExistingRun(root), true);
  await fsp.writeFile(path.join(run, 'checkpoint.json'), '{broken');
  assert.equal(await blockedByExistingRun(root), true);
  await fsp.unlink(path.join(run, 'checkpoint.json'));
  assert.equal(await blockedByExistingRun(root), true);
});

test('a job with an existing registered search is rejected before a fresh Bayt search', () => {
  assert.doesNotThrow(() => assertNewSearchAllowed({ searchId: null }));
  assert.throws(() => assertNewSearchAllowed({ searchId: 'CTsNqMVJ' }),
    /EXISTING_SEARCH_ID_REQUIRES_CHECKPOINT_RESUME/);
});

test('checkpoint resume requires the same job, run, search, pages and no uncertain download', () => {
  const searchSpec = { schemaVersion: 2, keyword: 'logistics' };
  const limits = { maxPages: 2 };
  const job = { id: 'job-a', searchId: 'search-a', searchSpec, limits,
    pages: [{ page: 1, selectedCount: 2, cvIdSetSha256: manifest.cvIdSetSha256,
      excelSha256: manifest.files.excel.sha256, pdfSha256: manifest.files.pdfArchive.sha256,
      remoteBatch: receipt.remoteBatch }] };
  const state = { schemaVersion: 2, runId: 'local-ego-test', queueJobId: job.id,
    searchId: job.searchId, searchSpec, limits, status: 'safety_stopped', phase: 'stopped',
    stopReason: 'NEXT_PAGE_OVERLAP', intent: null, deadlineAt: '2100-01-01T00:00:00.000Z',
    pages: [{ ...page, count: 2 }], current: { page: 1, ids: ['1', '2'] }, seenIds: ['1', '2'] };
  assert.doesNotThrow(() => assertResumeClaim(job, state.runId, state, [receipt]));
  assert.throws(() => assertResumeClaim(job, state.runId, { ...state, intent: { format: 'pdf' } }, [receipt]), /IDENTITY_INVALID/);
  assert.throws(() => assertResumeClaim(job, state.runId, { ...state, searchId: 'other' }, [receipt]), /IDENTITY_INVALID/);
  assert.throws(() => assertResumeClaim(job, state.runId, { ...state, seenIds: ['1', '1'] }, [receipt]), /PAGES_INVALID/);
  assert.throws(() => assertResumeClaim(job, state.runId, state, [{ ...receipt, excelSha256: 'e'.repeat(64) }]), /RECEIPT_INVALID/);
  // Expired runs may be finalized from their existing pages, never restarted with a new deadline.
  assert.doesNotThrow(() => assertResumeClaim(job, state.runId, { ...state, deadlineAt: '2020-01-01T00:00:00Z' }, [receipt]));
});

test('startup challenge keeps Ray evidence and requests user verification instead of generic form failure', () => {
  assert.deepEqual(startSearchFailure(Error('BAYT_VERIFICATION_REQUIRED rayId=a430b2c99ce81fba')),
    { code: 'BAYT_VERIFICATION_REQUIRED', message: '官网验证需要人工接手；Ray ID a430b2c99ce81fba',
      rayId: 'a430b2c99ce81fba' });
  assert.equal(startSearchFailure(Error('FORM_CONTROL_HIDDEN')).code, 'SEARCH_FORM_UNVERIFIED');
  assert.equal(startSearchFailure(Error('EGO_USER_CONTROL_REQUIRED')).code, 'BAYT_VERIFICATION_REQUIRED');
});

test('lease renewals continue during a long recovery action and stop after it ends', async () => {
  let calls = 0;
  await withLeaseHeartbeat({ jobId: 'isolated', leaseToken: 'test' }, () => new Promise(resolve => setTimeout(resolve, 40)),
    async () => { calls++; }, 5);
  assert.ok(calls >= 2);
  const after = calls;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls, after);
});

test('lost collection-complete reply is recovered even while upload is still pending', () => {
  const active = { jobId: 'a', searchId: 's', checkpointedPages: [] };
  assert.equal(terminalAcknowledged(active, { status: 'completed', pages: [page] },
    { id: 'a', searchId: 's', status: 'completed', completedPages: 0, collectedPages: 1, collectionFinishedAt: 'now' }), true);
});

test('verification handoff marker blocks further queue claims until explicitly cleared', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bayt-verification-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'awaiting-verification.json');
  assert.equal(await verificationPending(marker), false);
  await fsp.writeFile(marker, JSON.stringify({ status: 'awaiting_verification' }));
  assert.equal(await verificationPending(marker), true);
  await fsp.writeFile(marker, JSON.stringify({ status: 'verified' }));
  assert.equal(await verificationPending(marker), false);
});

test('pending run registration retries the same run and persists acknowledgement only after 108 confirms', async () => {
  const active = { jobId: 'job-a', root: '/tmp/local-ego-same-run', searchId: 'search-a',
    registrationPending: true };
  const state = { schemaVersion: 2, status: 'prepared', queueJobId: 'job-a',
    runId: 'local-ego-same-run', searchId: 'search-a', pages: [], intent: null };
  let saved = null, sends = 0;
  const persist = async item => { saved = { ...item }; };
  await assert.rejects(() => completeRunRegistration(active, state, async () => {
    sends++; throw Error('network unavailable');
  }, persist), /network unavailable/);
  assert.equal(active.registrationPending, true);
  assert.equal(saved, null);
  await completeRunRegistration(active, state, async item => {
    sends++;
    assert.equal(item.root, '/tmp/local-ego-same-run');
    assert.equal(item.searchId, 'search-a');
  }, persist);
  assert.equal(sends, 2);
  assert.equal(saved.registrationPending, false);
  assert.equal(active.registrationPending, false);
  await completeRunRegistration(active, state, async () => { throw Error('unexpected repeat'); }, persist);
});

test('pending run identity mismatch cannot be registered', async () => {
  const active = { jobId: 'job-a', root: '/tmp/local-ego-same-run', searchId: 'search-a',
    registrationPending: true };
  const state = { schemaVersion: 2, status: 'prepared', queueJobId: 'job-a',
    runId: 'local-ego-same-run', searchId: 'different-search', pages: [], intent: null };
  await assert.rejects(() => completeRunRegistration(active, state,
    async () => { throw Error('must not send'); }, async () => { throw Error('must not persist'); }),
  /PENDING_RUN_IDENTITY_UNVERIFIED/);
});

test('a persisted active run is adopted only for the exact claimed job and lease', () => {
  const candidate = { jobId: 'job-a', leaseToken: 'lease-a', root: '/tmp/bayt-runs/local-ego-one',
    searchId: 'search-a', registrationPending: true };
  const claim = { job: { id: 'job-a' }, leaseToken: 'lease-a' };
  assert.equal(claimedActive(candidate, claim, '/tmp/bayt-runs'), candidate);
  assert.equal(claimedActive(candidate, { ...claim, leaseToken: 'other' }, '/tmp/bayt-runs'), null);
  assert.equal(claimedActive(candidate, { job: { id: 'job-b' }, leaseToken: 'lease-a' }, '/tmp/bayt-runs'), null);
  assert.equal(claimedActive({ ...candidate, root: '/tmp/other/local-ego-one' }, claim, '/tmp/bayt-runs'), null);
});

test('a temporary registration failure leaves prepared run unactivated for the same-run retry', async () => {
  const active = { registrationPending: true, needsRebind: true };
  const state = { status: 'prepared' };
  const calls = [];
  const handlers = {
    register: async () => { calls.push('register'); throw Error('108 unavailable'); },
    activate: async () => { calls.push('activate'); },
    rebind: async () => { calls.push('rebind'); },
  };
  await assert.rejects(() => bootstrapRun(active, state, handlers), /108 unavailable/);
  assert.deepEqual(calls, ['register']);
  assert.equal(active.registrationPending, true);
  handlers.register = async () => { calls.push('register'); active.registrationPending = false; };
  assert.equal(await bootstrapRun(active, state, handlers), true);
  assert.deepEqual(calls, ['register', 'register', 'activate', 'rebind']);
  assert.equal(active.needsRebind, false);
});

test('lost terminal acknowledgement releases only the exact verified completed run', () => {
  const active = { jobId: 'job-a', searchId: 'search-a', checkpointedPages: [1] };
  const local = { status: 'completed', pages: [{ page: 1 }] };
  const remote = { id: 'job-a', searchId: 'search-a', status: 'completed', completedPages: 1 };
  assert.equal(terminalAcknowledged(active, local, remote), true);
  assert.equal(terminalAcknowledged(active, local, { ...remote, searchId: 'other' }), false);
  assert.equal(terminalAcknowledged(active, local, { ...remote, completedPages: 0 }), false);
  assert.equal(terminalAcknowledged(active, { ...local, status: 'running' }, remote), false);
});
