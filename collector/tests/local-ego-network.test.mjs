import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const advanced = await readFile(new URL('../scripts/local-ego-advanced-action.mjs', import.meta.url), 'utf8');
const action = await readFile(new URL('../scripts/local-ego-action.mjs', import.meta.url), 'utf8');
const sourceFunction = (source, name, next) => {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\n\n${next}`, start);
  assert.ok(start >= 0 && end > start);
  const isAsync = source.slice(start - 6, start) === 'async ';
  return `${isAsync ? 'async ' : ''}${source.slice(start, end)}`;
};
const responseSource = sourceFunction(advanced, 'checkSearchResponse', 'async function guardedStartSearch');
const verifySource = sourceFunction(advanced, 'verifySession', 'async function checkSearchResponse');
const stateSource = sourceFunction(action, 'browserState', 'async function inspect');
const preferences = '/v6/employer/myAccount/employerPreferences';
const results = '/v6/cvSearch/test-search/results';
const resource = (path, status, start = 1) => ({ name: new URL(path, 'https://www.bayt.com').href,
  responseStatus: status, startTime: start, serverTiming: status === 403 ? [{ name: 'chlray', description: '0123456789abcdef' }] : [] });

function runtime(entries, { labels = ['Search CVs'], searchVisible = true } = {}) {
  let handoffs = 0;
  const context = vm.createContext({ URL, location: new URL('https://www.bayt.com/en/employers/cv-search/listing/?searchId=test-search'),
    performance: { timeOrigin: Date.parse('2026-09-30T11:00:00Z'), getEntriesByType: () => entries },
    document: { body: { innerText: 'Search CVs' }, querySelector: selector => selector === '#searchBar' ?
      { value: 'religious', getBoundingClientRect: () => ({ width: searchVisible ? 100 : 0, height: 20 }) } : null,
      querySelectorAll: selector => selector === 'a,button' ? labels.map(innerText =>
        ({ innerText, getBoundingClientRect: () => ({ width: 100, height: 20 }) })) : [] },
    task: { handOff: async () => { handoffs++; } }, page: { evaluate: async fn => fn() } });
  vm.runInContext(`${responseSource}\n${verifySource}\n${stateSource}`, context);
  return { check: () => context.checkSearchResponse(), verify: () => context.verifySession(), state: () => context.browserState(), handoffs: () => handoffs };
}

test('hidden preferences challenge blocks an otherwise healthy search shell and preserves its Ray ID', async () => {
  const r = runtime([resource(preferences, 403), resource(results, 200, 2)]);
  await assert.rejects(r.check, /BAYT_VERIFICATION_REQUIRED rayId=0123456789abcdef/);
  await assert.rejects(r.verify, /BAYT_VERIFICATION_REQUIRED/);
  assert.equal(r.handoffs(), 1);
  assert.equal(r.state().warning, 'RESULTS_HTTP_403');
  assert.equal(r.state().resultResponse.path, preferences);
  assert.equal(r.state().resultResponse.rayId, '0123456789abcdef');
});

test('a later success for the same endpoint clears stale failure evidence', async () => {
  const r = runtime([resource(preferences, 403), resource(preferences, 200, 2)]);
  await r.check();
  assert.equal((await r.verify()).verified, true);
  assert.equal(r.handoffs(), 0);
  assert.equal(r.state().warning, null);
});

test('unrelated and third-party errors do not block collection', async () => {
  const r = runtime([resource('/analytics', 403), resource('https://example.invalid/v6/cvSearch/test-search/results', 403)]);
  await r.check();
  assert.equal((await r.verify()).verified, true);
  assert.equal(r.state().warning, null);
});

test('required-endpoint login and rate-limit failures remain stop conditions', async () => {
  for (const [status, error, warning] of [[401, /BAYT_VERIFICATION_REQUIRED/, 'LOGIN_REQUIRED'], [429, /BAYT_429/, 'RATE_LIMIT']]) {
    const r = runtime([resource(preferences, status)]);
    await assert.rejects(r.check, error);
    assert.equal(r.state().warning, warning);
  }
});

test('zero-result counts and filter badges are valid verified search pages', async () => {
  for (const labels of [['0 CVs'], ['Advanced filters\n1\n\uE004'], ['12,500 CVs']]) {
    const r = runtime([resource(preferences, 200), resource(results, 200, 2)], { labels });
    assert.equal((await r.verify()).verified, true);
    assert.equal(r.handoffs(), 0);
  }
  const blocked = runtime([resource(results, 403)], { labels: ['0 CVs'] });
  await assert.rejects(blocked.verify, /BAYT_VERIFICATION_REQUIRED/);
});

test('a count label alone cannot verify an absent or hidden search form', async () => {
  const r = runtime([resource(results, 200)], { labels: ['0 CVs'], searchVisible: false });
  assert.equal((await r.verify()).verified, false);
  assert.equal(r.handoffs(), 1);
});
