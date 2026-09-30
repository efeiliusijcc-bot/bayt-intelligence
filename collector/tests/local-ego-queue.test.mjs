import assert from 'node:assert/strict';
import test from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertNewSearchAllowed, blockedByExistingRun, bootstrapRun, checkpointInput,
  claimedActive, completeRunRegistration, startSearchFailure, verificationPending } from '../scripts/local-ego-queue.mjs';

const manifest = { selectedCount: 2, cvIdSetSha256: 'c'.repeat(64),
  files: { excel: { sha256: 'a'.repeat(64), sizeBytes: 120 }, pdfArchive: { sha256: 'b'.repeat(64), sizeBytes: 500 } },
  verification: { exactMatch: true, zipCrcFailures: 0, pdfEntries: 2 } };
const page = { page: 1, manifest };
const receipt = { status: 'uploaded', page: 1, manifestSha256: 'd'.repeat(64),
  excelSha256: 'a'.repeat(64), pdfSha256: 'b'.repeat(64), remoteBatch: '/incoming/local-ego-test/batch-0001' };

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
  assert.throws(() => assertNewSearchAllowed({ searchId: 'existing-search' }),
    /EXISTING_SEARCH_ID_REQUIRES_CHECKPOINT_RESUME/);
});

test('startup challenge keeps Ray evidence and requests user verification instead of generic form failure', () => {
  assert.deepEqual(startSearchFailure(Error('BAYT_VERIFICATION_REQUIRED rayId=0123456789abcdef')),
    { code: 'BAYT_VERIFICATION_REQUIRED', message: '官网验证需要人工接手；Ray ID 0123456789abcdef',
      rayId: '0123456789abcdef' });
  assert.equal(startSearchFailure(Error('FORM_CONTROL_HIDDEN')).code, 'SEARCH_FORM_UNVERIFIED');
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
