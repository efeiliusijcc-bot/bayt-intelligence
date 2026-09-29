import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as XLSX from '@e965/xlsx';
import yazl from 'yazl';
import { POLICY, decision, dayKey, nextDay, hashIds, responseSummary, assertIdentity, NativeChrome, Soak, listingSnapshot } from '../scripts/native-soak.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const ids = Array.from({ length: 50 }, (_, i) => String(10000 + i));
const now = Date.parse('2026-09-06T16:00:00+08:00');
const state = () => ({ createdAt: now, status: 'running', pages: [], reservations: [], uniqueIds: [], current: null, intent: null, dueAt: now + 1000 });

test('existing policy never accelerates page or export interval', () => {
  assert.equal(POLICY.pageMin, 3600000); assert.equal(POLICY.pageMax, 4200000);
  assert.equal(POLICY.exportMin, 900000); assert.equal(POLICY.exportMax, 1200000);
});
test('CV IDs deduplicate case-independent numeric identifiers and hash a sorted set', () => {
  assert.equal(hashIds(ids), hashIds([...ids].reverse())); assert.equal(hashIds(ids), hashIds([...ids, ids[0]]));
});
test('Beijing natural day and next midnight are deterministic at boundary', () => {
  const t = Date.parse('2026-09-06T15:59:59.999Z');
  assert.equal(dayKey(t), '2026-09-06'); assert.equal(dayKey(t + 1), '2026-09-07');
  assert.equal(nextDay(t), t + 1);
});
test('daily cap counts exported rows, not distinct IDs, and permits an entire page only', () => {
  const s = state(); s.reservations = [{ count: 450, day: dayKey(now) }];
  assert.equal(decision(s, now).kind, 'next'); s.reservations[0].count = 451;
  assert.equal(decision(s, now).kind, 'wait_day');
  assert.equal(decision(s, nextDay(now)).kind, 'next');
});
test('completed XLS resumes PDF without re-downloading XLS or reserving twice', () => {
  const s = state(); s.current = { excel: { name: 'source.xls' } }; s.reservations = [{ count: 500, day: dayKey(now) }];
  assert.equal(decision(s, now).kind, 'pdf');
});
test('safety stop cannot be resumed by relaunch; uncertain click stops', () => {
  const s = state(); s.status = 'safety_stopped'; assert.equal(decision(s, now).kind, 'terminal');
  s.status = 'running'; s.intent = { format: 'xls' }; assert.equal(decision(s, now).reason, 'UNCERTAIN_PREVIOUS_ACTION');
});
test('500 distinct IDs requests file verification instead of a further export', () => {
  const s = state(); s.uniqueIds = Array.from({ length: 500 }, (_, i) => String(i)); assert.equal(decision(s, now).kind, 'verify');
  s.uniqueIds.pop(); assert.equal(decision(s, now).kind, 'next');
});
test('bounded time and page budgets stop incomplete collection', () => {
  const s = state(); assert.equal(decision(s, now + POLICY.maxDuration + 1).reason, 'TIME_BUDGET_REACHED');
  s.pages = Array(20).fill({}); assert.equal(decision(s, now).reason, 'PAGE_BUDGET_REACHED');
});
test('network summary excludes tokens, query parameters, body and third party errors', () => {
  assert.equal(responseSummary('https://px.ads.linkedin.com/wa/', 429, ''), null);
  assert.equal(responseSummary('https://fakebayt.com/anything', 429, ''), null);
  assert.deepEqual(responseSummary('https://www.bayt.com/v6/searchCv/secretid/getActionToken?token=secret', 429, 'application/json'), {
    route: 'getActionToken', status: 429, mime: 'application/json', authCritical: true,
  });
  assert.deepEqual(responseSummary('https://www.bayt.com/v6/conversations/api/statusByIcode?token=secret', 401, 'application/json', 'XHR'), {
    route: 'other_bayt', status: 401, mime: 'application/json', authCritical: false,
  });
});
test('listing identity changes stop instead of silently collecting different people', () => {
  const s = { keyword: 'Frontend Developer', searchId: 'a' };
  const p = { host: 'www.bayt.com', pathname: '/en/employers/cv-search/listing/', keyword: s.keyword, searchId: 'a', page: 1, ids };
  assert.doesNotThrow(() => assertIdentity(p, s, 1, ids));
  for (const mutation of [{ page: 2 }, { keyword: 'other' }, { searchId: 'b' }, { ids: ids.slice(1) }, { ids: [...ids.slice(1), ids[1]] }]) assert.throws(() => assertIdentity({ ...p, ...mutation }, s, 1, ids));
});

class FakeSocket {
  handlers = new Map();
  addEventListener(type, fn) { const a = this.handlers.get(type) || []; a.push(fn); this.handlers.set(type, a); }
  emit(type, value) { for (const fn of this.handlers.get(type) || []) fn(value); }
  send() { throw Error('No command should be sent'); }
}
for (const status of [401, 403, 429]) test(`Bayt ${status} prevents all subsequent clicks`, async () => {
  const ws = new FakeSocket(), browser = new NativeChrome(ws, () => {});
  ws.emit('message', { data: JSON.stringify({ method: 'Network.responseReceived', params: { type: 'XHR', response: { url: 'https://www.bayt.com/v6/searchCv/x/getActionToken', status, mimeType: 'application/json' } } }) });
  await assert.rejects(() => browser.click('confirm'), new RegExp('BAYT_' + status));
});
test('noncritical Bayt 401 is logged but does not invalidate a healthy listing session', async () => {
  const events = [], ws = new FakeSocket(), browser = new NativeChrome(ws, (event, fields) => events.push({ event, fields }));
  ws.emit('message', { data: JSON.stringify({ method: 'Network.responseReceived', params: { type: 'XHR', response: { url: 'https://www.bayt.com/v6/conversations/api/statusByIcode', status: 401, mimeType: 'application/json' } } }) });
  await assert.doesNotReject(() => browser.guard());
  assert.equal(events.some(item => item.event === 'noncritical_401'), true);
});
test('operator stop is checked before input dispatch', async () => {
  const browser = new NativeChrome(new FakeSocket(), () => {}); browser.stopRequested = () => true;
  await assert.rejects(() => browser.click('confirm'), /OPERATOR_STOP/);
});
test('fixture DOM detects login, rate, captcha and quota, without exporting page body', () => {
  const dom = new JSDOM('<body><div role="dialog"></div></body>', { url: 'https://www.bayt.com/en/employers/cv-search/listing/?searchId=x', runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 30 });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  for (const [text, expected] of [['Verify you are human', 'BAYT_CAPTCHA'], ['Too many requests', 'BAYT_RATE_MESSAGE'], ['Session expired', 'BAYT_LOGIN_REQUIRED'], ['Upgrade your account', 'BAYT_QUOTA_OR_UPGRADE']]) {
    dom.window.document.querySelector('div').textContent = text;
    const result = dom.window.eval('(' + listingSnapshot.toString() + ')()');
    assert.equal(result.warning, expected); assert.equal('text' in result, false);
  }
  dom.window.close();
});

async function zipFixture(file, values, corrupt = false) {
  const zip = new yazl.ZipFile(); for (const id of values) zip.addBuffer(Buffer.from(corrupt ? 'not a PDF' : '%PDF-1.7\nfixture\n%%EOF'), 'cv' + id + '.pdf', { compress: false });
  zip.end(); await new Promise((res, rej) => { const stream = fs.createWriteStream(file); zip.outputStream.pipe(stream); stream.once('close', res); stream.once('error', rej); });
}
test('offline adoption verifier detects CV mismatches, damaged PDFs and temporary files', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bayt-soak-test-'));
  try {
    const soak = new Soak(root), dir = soak.batchDir(1); await fsp.mkdir(path.join(dir, 'xls'), { recursive: true }); await fsp.mkdir(path.join(dir, 'pdf'));
    const xls = path.join(dir, 'xls', 'source.xls'), pdf = path.join(dir, 'pdf', 'source.zip');
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['CV_ID'], ...ids.map(id => [id])]), 'Data');
    await fsp.writeFile(xls, XLSX.write(wb, { type: 'buffer', bookType: 'biff8' })); await zipFixture(pdf, ids);
    const hash = async f => { const b = await fsp.readFile(f); const { createHash } = await import('node:crypto'); return { name: path.basename(f), sizeBytes: b.length, sha256: createHash('sha256').update(b).digest('hex') }; };
    const b = { page: 1, ids, excel: await hash(xls), pdf: await hash(pdf) }; soak.state = { runId: 'fixture', keyword: 'Frontend Developer', pages: [b] };
    const valid = await soak.validateBatch(b); assert.equal(valid.verification.pdfEntries, 50); assert.equal(valid.verification.zipCrcFailures, 0);
    const damaged = await fsp.readFile(pdf), byte = damaged.indexOf(Buffer.from('fixture')); damaged[byte] ^= 1;
    await fsp.writeFile(pdf, damaged); b.pdf = await hash(pdf); await assert.rejects(() => soak.validateBatch(b), /crcFailures=1/);
    await zipFixture(pdf, ids); b.pdf = await hash(pdf);
    await fsp.writeFile(path.join(dir, 'pdf', 'unfinished.crdownload'), 'x'); await assert.rejects(() => soak.validateBatch(b), /UNMATCHED_OR_TEMPORARY/); await fsp.unlink(path.join(dir, 'pdf', 'unfinished.crdownload'));
    await zipFixture(pdf, ids, true); b.pdf = await hash(pdf); await assert.rejects(() => soak.validateBatch(b), /invalidPdf=50/);
    await zipFixture(pdf, [...ids.slice(1), '999999']); b.pdf = await hash(pdf); await assert.rejects(() => soak.validateBatch(b), /zipMissing=1/);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});
