import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { scheduleRecovery, effectiveDeadline, retryAfterTime, recoveryKind } from '../src/recovery.ts';
import { finishIfReady, finishExpiredRecovery } from '../scripts/local-ego-soak.mjs';

test('rate-limit waits stay within 15-60 minutes and survive serialization', () => {
  const now = Date.parse('2026-09-30T00:00:00Z');
  let r = null;
  for (let index = 0; index < 100; index++) {
    r = scheduleRecovery(JSON.parse(JSON.stringify(r)), 'rate_limit', 'next', 'episode-test', now);
    const wait = Date.parse(r.nextCheckAt) - now;
    assert.ok(wait >= 15 * 60_000 && wait <= 60 * 60_000, `wait ${wait} out of range`);
    assert.equal(r.rateLimits, index + 1);
  }
  assert.equal(r.startedAt, '2026-09-30T00:00:00.000Z');
});
test('server wait, existing pacing, and incident identity survive challenge transitions', () => {
  const now = Date.now(), serverWait = new Date(now + 90 * 60_000).toISOString();
  const r = scheduleRecovery(null, 'rate_limit', 'pdf_prepare', 'episode-test', now, serverWait, serverWait);
  assert.equal(r.nextCheckAt, serverWait);
  const challenge = scheduleRecovery(r, 'verification', 'other', 'another-id', now);
  assert.equal(challenge.id, r.id); assert.equal(challenge.notBefore, serverWait);
  const again = scheduleRecovery(challenge, 'rate_limit', 'other', 'another-id', now, null, null, () => 0);
  assert.equal(Date.parse(again.nextCheckAt), now + 15 * 60_000);
  const capped = scheduleRecovery(challenge, 'rate_limit', 'other', 'another-id', now, null, null, () => 0.999999);
  assert.ok(Date.parse(capped.nextCheckAt) - now <= 60 * 60_000);
  assert.equal(retryAfterTime('1800', now), new Date(now + 1800_000).toISOString());
  assert.equal(retryAfterTime('bad', now), null);
  assert.equal(retryAfterTime('99999999999999999999', now), null);
  assert.equal(recoveryKind('UNCERTAIN_DOWNLOAD_RESULT'), null);
});
test('count jobs have no 48-hour cutoff while explicit duration retains its deadline', () => {
  const state = { schemaVersion: 2, limits: { targetCount: 150 }, phase: 'excel_prepare', deadlineAt: '2020-01-01T00:00:00Z', pages: [], seenIds: [] };
  assert.equal(effectiveDeadline(state), null); assert.equal(finishIfReady(state), false);
  const timed = { ...state, limits: { durationHours: 24 }, recovery: { id: 'old-wait' } };
  assert.equal(finishIfReady(timed), true);
  assert.equal(timed.recovery, null);
});

const script = await fs.readFile(new URL('../scripts/local-ego-recovery-action.mjs', import.meta.url), 'utf8');
test('an explicit deadline finalizes a pending recovery without another site probe', () => {
  const state = { schemaVersion: 2, limits: { durationHours: 24 }, deadlineAt: '2020-01-01T00:00:00Z',
    phase: 'stopped', status: 'awaiting_verification', resumePhase: 'next', pages: [{}], seenIds: ['1'],
    recovery: { id: 'episode-test' }, current: { page: 1, pdf: {} } };
  assert.equal(finishExpiredRecovery({ ...state, limits: { targetCount: 150 } }), false);
  assert.equal(finishExpiredRecovery({ ...state, intent: { format: 'pdf' } }), false);
  assert.equal(finishExpiredRecovery({ ...state, resumePhase: 'pdf_prepare' }), false);
  assert.equal(finishExpiredRecovery(state), true);
  assert.equal(state.status, 'completed'); assert.equal(state.recovery, null);
});
async function simulated(directory, recovery, initial, afterLoad, afterClick) {
  let state = initial, clicks = 0, reloads = 0, handoffs = 0, result;
  const previousTask = globalThis.taskSpace, previousConfig = globalThis.BAYT_EGO_ACTION_JSON, previousLog = console.log;
  globalThis.BAYT_EGO_ACTION_JSON = JSON.stringify({ spaceId: 15, attemptDirectory: directory, recovery });
  globalThis.taskSpace = async () => ({ ownership: 'agent', handOff: async () => { handoffs++; }, page: () => ({
    evaluate: async () => state, snapshot: async () => 'iframe [ref=1]\n  checkbox "请验证您是真人" [ref=22]',
    click: async ref => { assert.equal(ref, '@22'); clicks++; state = afterClick; },
    reload: async () => { reloads++; state = afterLoad; }, cdp: async () => {}, waitForFunction: async () => {}, events: async () => [],
  }) });
  console.log = value => { if (String(value).startsWith('BAYT_EGO_RESULT=')) result = JSON.parse(value.slice(16)); };
  try { await import(`data:text/javascript;base64,${Buffer.from(script + '\n//' + crypto.randomUUID()).toString('base64')}`); }
  finally { globalThis.taskSpace = previousTask; globalThis.BAYT_EGO_ACTION_JSON = previousConfig; console.log = previousLog; }
  return { clicks, reloads, handoffs, result };
}
test('rate probe creates one fresh page response and returns to waiting without handing off', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bayt-recovery-'));
  const recovery = { ...scheduleRecovery(null, 'rate_limit', 'next', 'episode-test'), attempts: 1 };
  const r = await simulated(dir, recovery, { kind: 'rate_limit' }, { kind: 'rate_limit' }, { kind: 'ready' });
  assert.equal(r.reloads, 1); assert.equal(r.clicks, 0); assert.equal(r.handoffs, 0); assert.equal(r.result.kind, 'rate_limit');
});
test('a visible verification is clicked once; a successful page resumes without handoff', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bayt-recovery-'));
  const r = await simulated(dir, scheduleRecovery(null, 'verification', 'next', 'episode-test'),
    { kind: 'verification' }, { kind: 'verification' }, { kind: 'ready' });
  assert.equal(r.clicks, 1); assert.equal(r.reloads, 0); assert.equal(r.handoffs, 0);
});
test('restart and a new Ray cannot repeat the same challenge click', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bayt-recovery-'));
  const recovery = scheduleRecovery(null, 'verification', 'next', 'episode-test');
  const first = await simulated(dir, recovery, { kind: 'verification' }, {}, { kind: 'verification', rayId: 'new-ray' });
  const second = await simulated(dir, { ...recovery, attempts: 2 }, { kind: 'verification', rayId: 'another-ray' }, {}, {});
  assert.equal(first.clicks, 1); assert.equal(first.handoffs, 1); assert.equal(second.clicks, 0); assert.equal(second.handoffs, 1);
});
test('verification followed by 429 waits, but missing login requires handoff', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bayt-recovery-'));
  const r = await simulated(dir, scheduleRecovery(null, 'verification', 'next', 'episode-test'),
    { kind: 'verification' }, {}, { kind: 'rate_limit' });
  assert.equal(r.clicks, 1); assert.equal(r.handoffs, 0);
  const login = await simulated(dir, scheduleRecovery(null, 'verification', 'next', 'episode-other'), { kind: 'login' }, {}, {});
  assert.equal(login.clicks, 0); assert.equal(login.handoffs, 1);
});
