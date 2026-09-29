import assert from 'node:assert/strict';
import test from 'node:test';
import { POLICY, classifyFailure, freshNextPage, challengeDecision, deadlineReached } from '../scripts/local-ego-soak.mjs';
import { assertPageEvidence, remoteDecision } from '../scripts/local-ego-upload.mjs';

test('local run is time-bounded but has no resume-count cap', () => {
  assert.equal(POLICY.durationMs, 24 * 60 * 60_000);
  assert.equal('target' in POLICY, false);
  assert.ok(POLICY.exportMinMs >= 15 * 60_000);
  assert.ok(POLICY.pageMinMs >= 60 * 60_000);
});

test('next page rejects stale CV_IDs even when page number advances', () => {
  const state = { searchId: 'abc', keyword: 'Backend Engineer', current: { page: 1 }, seenIds: ['1', '2'] };
  const page = { host: 'www.bayt.com', path: '/en/employers/cv-search/listing/', searchId: 'abc',
    keyword: 'Backend Engineer', page: 2, filters: { freshness6Months: true, experience2to5: true, fullTime: true }, ids: ['1', '2'] };
  assert.equal(freshNextPage(page, state), false);
  assert.equal(freshNextPage({ ...page, ids: ['3', '4'] }, state), true);
});

test('uploader rejects a changed manifest, CV_ID set, or local file hash', () => {
  const checked = { runId: 'r', page: 2, selectedCount: 2, cvIdSetSha256: 'ids',
    files: { excel: { sha256: 'xls' }, pdfArchive: { sha256: 'zip' } } };
  const saved = { ...checked, verification: { exactMatch: true, zipCrcFailures: 0 } };
  assert.doesNotThrow(() => assertPageEvidence(saved, checked, { page: 2, cvIdSetSha256: 'ids' }));
  assert.throws(() => assertPageEvidence({ ...saved, files: { ...saved.files, excel: { sha256: 'wrong' } } }, checked,
    { page: 2, cvIdSetSha256: 'ids' }), /LOCAL_PAGE_EVIDENCE_CONFLICT/);
  assert.throws(() => assertPageEvidence(saved, checked, { page: 2, cvIdSetSha256: 'old' }), /LOCAL_PAGE_EVIDENCE_CONFLICT/);
});

test('hidden challenge and stale IDs require handoff; one visible click is not success by itself', () => {
  const state = { phase: 'next', searchId: 'abc', keyword: 'Backend Engineer',
    current: { page: 1, ids: ['1', '2'] }, seenIds: ['1', '2'] };
  const page = { host: 'www.bayt.com', path: '/en/employers/cv-search/listing/', searchId: 'abc',
    keyword: 'Backend Engineer', page: 2, filters: { freshness6Months: true, experience2to5: true, fullTime: true }, ids: ['1', '2'] };
  assert.equal(challengeDecision({ cleared: false, clicked: false, state: page }, state), 'handoff');
  assert.equal(challengeDecision({ cleared: true, clicked: true, state: page }, state), 'handoff');
  assert.equal(challengeDecision({ cleared: true, clicked: true, state: { ...page, ids: ['3', '4'] } }, state), 'fresh_next');
});

test('interrupted upload resumes only matching files and never overwrites a hash conflict', () => {
  const expected = { 'source.xls': 'a', 'bayt-cvs.zip': 'b', 'manifest.json': 'c' };
  assert.equal(remoteDecision({}, expected), 'upload');
  assert.equal(remoteDecision({ 'source.xls': 'a' }, expected), 'upload');
  assert.equal(remoteDecision(expected, expected), 'complete');
  assert.equal(remoteDecision({ 'source.xls': 'different' }, expected), 'conflict');
});

test('original deadline is a hard boundary for starting another page', () => {
  const end = '2026-09-29T11:35:16.304Z';
  assert.equal(deadlineReached(end, Date.parse(end) - 1), false);
  assert.equal(deadlineReached(end, Date.parse(end)), true);
});

test('temporary navigation and rate errors receive cooldowns', () => {
  assert.equal(classifyFailure('Page timed out after 3000ms'), 'transient');
  assert.equal(classifyFailure('BAYT_LISTING_NOT_VISIBLE'), 'transient');
  assert.equal(classifyFailure('BAYT_RATE_LIMIT'), 'rate_limit');
  assert.deepEqual(POLICY.rateWaitsMs, [15, 30, 60].map(minutes => minutes * 60_000));
});

test('identity, anti-bot, and data-integrity errors are not retried blindly', () => {
  for (const code of ['BAYT_CAPTCHA', 'BAYT_LOGIN_REQUIRED', 'SEARCH_IDENTITY_CHANGED',
    'FILTER_CHANGED', 'CROSS_PAGE_CV_ID_OVERLAP', 'XLS_CV_ID_MAPPING_FAILED', 'ZIP_CRC_FAILURE']) {
    assert.equal(classifyFailure(code), 'safety', code);
  }
});
