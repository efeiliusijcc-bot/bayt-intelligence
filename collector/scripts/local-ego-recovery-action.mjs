// Ordinary UI recovery only. A durable intent prevents duplicate challenge clicks.
const cfg = JSON.parse(globalThis.BAYT_EGO_ACTION_JSON || '{}');
const fs = await import('node:fs/promises');
const path = await import('node:path');
const task = await taskSpace(cfg.spaceId);
if (task.ownership !== 'agent') throw Error('EGO_USER_CONTROL_REQUIRED');
const page = task.page('p1');
if (!cfg.attemptDirectory || !/^[A-Za-z0-9_-]{8,100}$/.test(cfg.recovery?.id || '')) throw Error('RECOVERY_CONFIG_INVALID');
await fs.mkdir(cfg.attemptDirectory, { recursive: true, mode: 0o700 });
const clickFile = path.join(cfg.attemptDirectory, `${cfg.recovery.id}-click.json`);
const loadFile = path.join(cfg.attemptDirectory, `${cfg.recovery.id}-load-${cfg.recovery.attempts}.json`);
async function intent(file) {
  try { await fs.writeFile(file, JSON.stringify({ at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}
function recoveryPageState() {
  const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const body = document.body?.innerText || '';
  const latest = new Map();
  for (const e of performance.getEntriesByType('resource')) {
    const u = new URL(e.name, location.href);
    if (u.origin === location.origin && (/^\/v6\/cvSearch\/[^/]+\/results\/?$/.test(u.pathname) ||
      /^\/v6\/cvSearch\/recentSearches\/?$/.test(u.pathname) || u.pathname === '/v6/employer/myAccount/employerPreferences')) latest.set(u.pathname, e);
  }
  const rate = [...latest.values()].find(e => e.responseStatus === 429);
  const blocked = [...latest.values()].find(e => [401,403].includes(e.responseStatus));
  const challenge = /请稍候|just a moment|security verification|verify you are human|请验证您是真人|正在进行安全验证/i.test(document.title + ' ' + body);
  const login = [...document.querySelectorAll('input[type=password]')].some(visible);
  const form = visible(document.querySelector('#searchBar'));
  const responseReady = [...latest.values()].some(e => e.responseStatus === 200 && /employerPreferences|\/results\/?$/.test(new URL(e.name).pathname));
  const ready = location.hostname === 'www.bayt.com' && responseReady &&
    ['/en/employers/cv-search/', '/en/employers/cv-search/listing/'].includes(location.pathname) && form;
  return { kind: rate || /too many requests|unusually high search activity|rate limit|try again in a few minutes/i.test(body) ? 'rate_limit' :
    login ? 'login' : challenge || blocked ? 'verification' : ready ? 'ready' : 'unready',
    path: location.pathname, status: rate?.responseStatus || blocked?.responseStatus || null,
    rayId: (rate || blocked)?.serverTiming?.find(e => e.name.toLowerCase() === 'chlray')?.description || null };
}
function checkboxRef(snapshot) {
  const matches = String(snapshot).split('\n').filter(line => /\bcheckbox\b/.test(line) &&
    /请验证您是真人|确认您是真人|verify (?:that )?you are human|verify you're human/i.test(line))
    .map(line => line.match(/\bref=(\d+)\b/)?.[1]).filter(Boolean);
  return matches.length === 1 ? `@${matches[0]}` : null;
}
async function observe() { return await page.evaluate(recoveryPageState); }
async function boundedWait() {
  try { await page.waitForFunction(() => /请稍候|just a moment|security verification/i.test(document.title) ||
    !!document.querySelector('input[type=password]') || performance.getEntriesByType('resource').some(e => {
      const u = new URL(e.name, location.href);
      const critical = /^\/v6\/cvSearch\/[^/]+\/results\/?$/.test(u.pathname) ||
        /^\/v6\/cvSearch\/recentSearches\/?$/.test(u.pathname) || u.pathname === '/v6/employer/myAccount/employerPreferences';
      return u.origin === location.origin && critical && ([401,403,429].includes(e.responseStatus) ||
        (e.responseStatus === 200 && /employerPreferences|\/results\/?$/.test(u.pathname) && !!document.querySelector('#searchBar')));
    }),
    undefined, { timeout: 20_000 }); } catch {}
}
let state = await observe();
let snapshot = state.kind === 'verification' ? await page.snapshot() : '';
let ref = checkboxRef(snapshot);
// A new response is required after a cooldown. Never replay API requests.
if (cfg.recovery.kind === 'rate_limit' || (state.kind === 'verification' && !ref)) {
  if (await intent(loadFile)) {
    await page.cdp('Network.enable');
    await page.reload();
    await boundedWait();
  }
  state = await observe();
  snapshot = state.kind === 'verification' ? await page.snapshot() : '';
  ref = checkboxRef(snapshot);
}
let clicked = false;
if (state.kind === 'verification' && ref && await intent(clickFile)) {
  clicked = true;
  await page.click(ref, { label: '尝试一次可见人机验证' });
  try { await page.waitForFunction(() => !/请稍候|just a moment|security verification/i.test(document.title) &&
    (!!document.querySelector('input[type=password]') || (!!document.querySelector('#searchBar') &&
      performance.getEntriesByType('resource').some(e => e.responseStatus > 0 && /\/v6\/(?:cvSearch|employer\/myAccount\/employerPreferences)/.test(new URL(e.name).pathname)))), undefined, { timeout: 25_000 }); } catch {}
  state = await observe();
}
let retryAfter = null;
// Read only Retry-After from passive network events; never log headers or credentials.
for (const event of await page.events()) {
  const response = event?.params?.response;
  if (event?.method !== 'Network.responseReceived' || response?.status !== 429 ||
    !response.url?.startsWith('https://www.bayt.com/')) continue;
  for (const [key, value] of Object.entries(response.headers || {})) if (key.toLowerCase() === 'retry-after') retryAfter = String(value);
}
if (!['ready', 'rate_limit'].includes(state.kind)) await task.handOff();
console.log(`BAYT_EGO_RESULT=${JSON.stringify({ ...state, clicked, retryAfter })}`);
