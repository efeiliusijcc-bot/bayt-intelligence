import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const source = await readFile(fileURLToPath(new URL('../scripts/local-ego-advanced-action.mjs', import.meta.url)), 'utf8');

function scriptFunction(name, nextName, dependencies = {}) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\n\nasync function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} must remain independently testable`);
  const names = Object.keys(dependencies);
  return Function(...names, `${source.slice(start, end)}; return ${name};`)(...Object.values(dependencies));
}

const inspectActionableTarget = scriptFunction('inspectActionableTarget', 'clickControl');
const inspectCityControl = scriptFunction('inspectCityControl', 'clickControl');
const cityControlReady = scriptFunction('cityControlReady', 'clickControl');

test('city control waits for the official form to reveal it asynchronously', async () => {
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  try {
    const page = await browser.newPage();
    await page.setContent(`<form name="ExperienceLocationForm">
      <input name="country__v" value="Jordan">
      <div id="city-row" style="display:none"><input name="city__v"></div>
    </form>`);
    assert.equal(await page.evaluate(cityControlReady, 0), false);
    await page.evaluate(() => setTimeout(() => { document.querySelector('#city-row').style.display = 'block'; }, 50));
    await page.waitForFunction(cityControlReady, 0, { timeout: 1_000 });
    assert.equal(await page.evaluate(cityControlReady, 0), true);
  } finally { await browser.close(); }
});

test('only the one hit-tested visible Bayt control is actionable', async () => {
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
    await page.setContent(`<!doctype html><html><body style="margin:0;height:2400px">
      <button id="blocked" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Search CVs</button>
      <button data-ok style="display:none">OK</button>
      <a id="offscreen" style="position:absolute;top:1900px;left:20px">Advanced filters</a>
      <div class="modal-wrap" style="position:fixed;inset:0;background:#fff;z-index:10">
        <form name="ExperienceLocationForm">
          <div class="u-none" style="display:none"><input name="city__v"><select name="city"><option value="">Choose city</option></select></div>
          <button id="apply" style="position:absolute;left:40px;top:80px;width:90px;height:40px">Apply</button>
          <button data-ok id="active-ok" style="position:absolute;left:40px;top:140px;width:90px;height:40px">OK</button>
          <button class="dupe" style="position:absolute;left:40px;top:200px;width:90px;height:40px">Confirm</button>
          <button class="dupe" style="position:absolute;left:140px;top:200px;width:90px;height:40px">Confirm</button>
        </form>
      </div>
    </body></html>`);
    const inspect = options => page.evaluate(inspectActionableTarget, options);
    assert.equal((await inspect({ selector: '#blocked' })).status, 'covered');
    assert.equal((await inspect({ selector: '#offscreen' })).status, 'offscreen');
    assert.equal((await inspect({ selector: 'button[data-ok]', nth: 0 })).status, 'hidden');
    const active = await inspect({ selector: 'button[data-ok]' });
    assert.equal(active.status, 'ok');
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, active), 'active-ok');
    assert.equal((await inspect({ selector: 'form[name="ExperienceLocationForm"] button', text: 'Apply' })).status, 'ok');
    assert.equal((await inspect({ selector: '.dupe', text: 'Confirm' })).status, 'ambiguous');
    assert.deepEqual(await page.evaluate(inspectCityControl, 0), { present: true, visible: false, optionCount: 1 });
  } finally {
    await browser.close();
  }
});

test('a covered control reports its stage without dispatching a click', async () => {
  const clickSource = source.slice(source.indexOf('async function clickControl('), source.indexOf('\n\nasync function visibleAnchor('));
  assert.ok(clickSource.startsWith('async function clickControl('));
  let clicks = 0, waits = 0;
  const page = { evaluate: async () => ({ status: 'covered' }), waitForTimeout: async () => { waits++; },
    mouse: { click: async () => { clicks++; } } };
  const clickControl = Function('page', 'inspectActionableTarget',
    `${clickSource}; return clickControl;`)(page, inspectActionableTarget);
  await assert.rejects(() => clickControl('button', 'APPLY_ExperienceLocationForm', 'apply', { text: 'Apply' }),
    /FORM_CONTROL_APPLY_ExperienceLocationForm_COVERED/);
  assert.equal(clicks, 0);
  assert.equal(waits, 9);
});
