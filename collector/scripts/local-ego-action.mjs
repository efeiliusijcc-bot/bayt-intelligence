// Runs inside `ego-browser nodejs`. UI actions use only the documented Ego API.
const cfg = JSON.parse(globalThis.BAYT_EGO_ACTION_JSON || '{}');
const task = cfg.action === 'resumeInspect' ? await takeOverTaskSpace(cfg.spaceId) : await taskSpace(cfg.spaceId);
const page = task.page('p1');

function browserState() {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const body = document.body?.innerText || '';
  const dialogs = [...document.querySelectorAll('[role=dialog],dialog,.modal')]
    .filter(visible).map(element => element.innerText || '').join('\n');
  const boxes = [...document.querySelectorAll('input[type=checkbox][name]')]
    .filter(element => /^\d+$/.test(element.name));
  // Bayt can keep the old candidates visible after a rejected AJAX request.
  // The page number alone is therefore not proof that the next page loaded.
  const lastResultsResponse = performance.getEntriesByType('resource')
    .filter(entry => /\/v6\/cvSearch\/[^/]+\/results\/?(?:\?|$)/.test(entry.name))
    .at(-1);
  const resultResponse = lastResultsResponse ? {
    at: new Date(performance.timeOrigin + lastResultsResponse.startTime).toISOString(),
    status: lastResultsResponse.responseStatus || null,
    rayId: lastResultsResponse.serverTiming?.find(item => item.name.toLowerCase() === 'chlray')?.description || null,
  } : null;
  let warning = null;
  if (lastResultsResponse?.responseStatus === 403) warning = 'RESULTS_HTTP_403';
  else if (lastResultsResponse?.responseStatus === 429) warning = 'RATE_LIMIT';
  else if (lastResultsResponse?.responseStatus === 401) warning = 'LOGIN_REQUIRED';
  else if (/verify you are human|confirm you are human|complete the captcha|cloudflare|security verification/i.test(body)) warning = 'CAPTCHA';
  else if (/too many requests|unusually high search activity|rate limit|try again in a few minutes/i.test(body)) warning = 'RATE_LIMIT';
  else if (/session (?:has )?expired|sign in to continue|log in to continue/i.test(body) ||
    [...document.querySelectorAll('input[type=password]')].some(visible)) warning = 'LOGIN_REQUIRED';
  else if (/buy credits|purchase required|upgrade your plan|remaining credits/i.test(dialogs)) warning = 'QUOTA_OR_PURCHASE';
  return {
    host: location.hostname,
    path: location.pathname,
    searchId: new URL(location.href).searchParams.get('searchId'),
    keyword: document.querySelector('#searchBar')?.value?.trim() || '',
    page: Number(document.querySelector('input[name=p]')?.value || 0),
    ids: boxes.map(element => element.name),
    selected: boxes.filter(element => element.checked).length,
    hasNext: !!document.querySelector('.pagination-next:not(.is-disabled):not(.disabled) a'),
    filters: {
      freshness6Months: !!document.querySelector('input[data-automation-id="cv_freshness_cluster_4"]:checked'),
      experience2to5: !!document.querySelector('input[data-automation-id="experience_years_cluster_3"]:checked'),
      fullTime: !!document.querySelector('input[data-automation-id="employment_type_cluster_1"]:checked'),
    },
    warning,
    resultResponse,
  };
}

async function inspect() {
  const state = await page.evaluate(browserState);
  if (state.warning) throw Error(`BAYT_${state.warning}|${state.resultResponse?.at || ''}|${state.resultResponse?.status || ''}|${state.resultResponse?.rayId || ''}`);
  if (state.host !== 'www.bayt.com' || state.path !== '/en/employers/cv-search/listing/')
    throw Error('BAYT_LISTING_NOT_VISIBLE');
  return state;
}

async function challenge() {
  // One ordinary navigation is the only automatic attempt to expose the hidden XHR challenge.
  await page.reload();
  const visibleButton = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button,input[type=button]')].filter(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    const matches = buttons.map((element, index) => ({ element, index })).filter(({ element }) =>
      /^(verify you are human|verify|confirm you are human)$/i.test((element.innerText || element.value || '').trim()));
    return matches.length === 1 ? matches[0].index : -1;
  });
  if (visibleButton >= 0) {
    await page.click(`loc=css:button,input[type=button] >> nth=${visibleButton}`, { label: '点击页面可见的普通验证按钮' });
    await page.waitForTimeout(3000);
  }
  const state = await page.evaluate(browserState);
  if (state.host === 'www.bayt.com' && state.path === '/en/employers/cv-search/listing/' &&
    !state.warning && state.searchId === cfg.searchId && state.keyword === cfg.keyword &&
    (cfg.schemaVersion === 2 || Object.values(state.filters).every(Boolean)) && state.ids.length > 0) return { cleared: true, state, clicked: visibleButton >= 0 };
  return { cleared: false, state, clicked: visibleButton >= 0 };
}

function assertIdentity(state) {
  if (state.searchId !== cfg.searchId || state.keyword !== cfg.keyword)
    throw Error('SEARCH_IDENTITY_CHANGED');
  if (state.page !== cfg.page) throw Error('PAGE_NUMBER_CHANGED');
  if (!state.ids.length || state.ids.length > 50 || new Set(state.ids).size !== state.ids.length)
    throw Error('PAGE_CV_ID_INVALID');
  if (cfg.schemaVersion !== 2 && !Object.values(state.filters).every(Boolean)) throw Error('FILTER_CHANGED');
  if (cfg.ids && (state.ids.length !== cfg.ids.length || state.ids.some((id, index) => id !== cfg.ids[index])))
    throw Error('PAGE_MEMBERS_CHANGED');
}

async function selectPage(state) {
  if (state.selected === state.ids.length) return;
  if (state.selected !== 0) throw Error('PARTIAL_SELECTION');
  await page.mouse.move(1000, 450, { label: '定位简历列表' });
  await page.mouse.wheel(0, -3000, { label: '滚动到列表顶部' });
  const selector = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span')].filter(element =>
      element.textContent?.trim() === 'Select all' && element.getBoundingClientRect().width > 0);
    if (spans.length !== 1) return null;
    const label = spans[0].parentElement?.querySelector('label');
    return label?.htmlFor ? `label[for="${label.htmlFor}"]` : null;
  });
  if (!selector) throw Error('SELECT_ALL_CONTROL_MISSING');
  await page.click(`loc=css:${selector}`, { label: '选择当前页简历' });
  const after = await inspect();
  assertIdentity(after);
  if (after.selected !== after.ids.length) throw Error('SELECT_ALL_INCOMPLETE');
}

async function prepare(format) {
  let state = await inspect();
  assertIdentity(state);
  await selectPage(state);
  state = await inspect();
  assertIdentity(state);
  const modalOpen = await page.evaluate(() => [...document.querySelectorAll('button')]
    .some(element => element.innerText.trim() === 'Download without revealing' && element.getBoundingClientRect().width > 0));
  if (!modalOpen) {
    const index = await page.evaluate(() => {
      const actions = [...document.querySelectorAll('.bulkActions a')];
      const matches = actions.map((element, i) => ({ i, text: element.innerText.trim() }))
        .filter(item => item.text === 'Download CV');
      return matches.length === 1 ? matches[0].i : -1;
    });
    if (index < 0) throw Error('BULK_ACTION_MISSING');
    await page.click(`loc=css:.bulkActions a >> nth=${index}`, { label: '打开批量导出选项' });
  }
  const labelText = format === 'xls'
    ? 'Microsoft Excel (XLS file format)'
    : 'Adobe Acrobat (PDF file format) (maximum 50 CVs)';
  const formatSelector = await page.evaluate(text => {
    const matches = [...document.querySelectorAll('label')]
      .filter(element => element.innerText.trim() === text && element.getBoundingClientRect().width > 0);
    return matches.length === 1 && matches[0].htmlFor ? `label[for="${matches[0].htmlFor}"]` : null;
  }, labelText);
  if (!formatSelector) throw Error('EXPORT_FORMAT_MISSING');
  const checked = await page.evaluate(selector => {
    const label = document.querySelector(selector);
    return !!document.getElementById(label?.htmlFor || '')?.checked;
  }, formatSelector);
  if (!checked) await page.click(`loc=css:${formatSelector}`, { label: '选择安全导出格式' });
  const ready = await page.evaluate(selector => {
    const label = document.querySelector(selector);
    const button = [...document.querySelectorAll('button')]
      .find(element => element.innerText.trim() === 'Download without revealing');
    return !!document.getElementById(label?.htmlFor || '')?.checked && !!button && !button.disabled;
  }, formatSelector);
  if (!ready) throw Error('EXPORT_FORMAT_NOT_READY');
  state = await inspect();
  assertIdentity(state);
  if (state.selected !== state.ids.length) throw Error('PARTIAL_SELECTION');
  return { ready: true, selected: state.selected };
}

async function confirm(format) {
  const state = await inspect();
  assertIdentity(state);
  if (state.selected !== state.ids.length) throw Error('PARTIAL_SELECTION');
  const selectedFormat = await page.evaluate(() => {
    // The search sidebar has unrelated checked radio groups; inspect only export formats.
    const radios = [...document.querySelectorAll('input[type=radio]')]
      .filter(element => ['excel', 'pdf', 'rtf'].includes(element.value) && element.checked);
    return radios.map(element => element.value);
  });
  if (selectedFormat.length !== 1 || selectedFormat[0] !== (format === 'xls' ? 'excel' : 'pdf'))
    throw Error('EXPORT_FORMAT_CHANGED');
  const downloadPromise = page.waitForEvent('download', { timeout: 180_000 });
  await page.click('loc=role:button[name="Download without revealing"]', { label: '下载不显示联系方式的简历' });
  const download = await downloadPromise;
  const name = download.suggestedFilename();
  if (!name.toLowerCase().endsWith(format === 'xls' ? '.xls' : '.zip'))
    throw Error('DOWNLOAD_TYPE_MISMATCH');
  await download.saveAs(cfg.destination);
  if (await download.failure()) throw Error('DOWNLOAD_FAILED');
  return { saved: true, format, filename: name };
}

async function nextPage() {
  const state = await inspect();
  if (state.searchId !== cfg.searchId || state.keyword !== cfg.keyword || (cfg.schemaVersion !== 2 && !Object.values(state.filters).every(Boolean)))
    throw Error('SEARCH_IDENTITY_CHANGED');
  if (state.page === cfg.page + 1) {
    if (state.ids.some(id => cfg.ids.includes(id))) throw Error('NEXT_PAGE_OVERLAP');
    return state;
  }
  assertIdentity(state);
  if (!state.hasNext) return { ...state, endOfResults: true };
  await page.click('loc=css:.pagination-next a', { label: '进入下一页简历' });
  await page.waitForFunction(previous => {
    const lastResultsResponse = performance.getEntriesByType('resource')
      .filter(entry => /\/v6\/cvSearch\/[^/]+\/results\/?(?:\?|$)/.test(entry.name))
      .at(-1);
    if ([401, 403, 429].includes(lastResultsResponse?.responseStatus)) return true;
    const pageNumber = Number(document.querySelector('input[name=p]')?.value || 0);
    const ids = [...document.querySelectorAll('input[type=checkbox][name]')]
      .filter(element => /^\d+$/.test(element.name)).map(element => element.name);
    return pageNumber === previous.page + 1 && ids.length > 0 &&
      ids.length <= 50 && !ids.some(id => previous.ids.includes(id));
  }, { page: cfg.page, ids: cfg.ids }, { timeout: 45_000 });
  const after = await inspect();
  if (after.page !== cfg.page + 1 || after.ids.some(id => cfg.ids.includes(id)) ||
    after.searchId !== cfg.searchId || after.keyword !== cfg.keyword || (cfg.schemaVersion !== 2 && !Object.values(after.filters).every(Boolean)))
    throw Error('NEXT_PAGE_VALIDATION_FAILED');
  return after;
}

let result;
if (cfg.action === 'inspect') result = await inspect();
else if (cfg.action === 'inspectRaw') result = await page.evaluate(browserState);
else if (cfg.action === 'resumeInspect') result = await page.evaluate(browserState);
else if (cfg.action === 'handoff') { await task.handOff(); result = { handedOff: true }; }
else if (cfg.action === 'challenge') result = await challenge();
else if (cfg.action === 'prepare') result = await prepare(cfg.format);
else if (cfg.action === 'confirm') result = await confirm(cfg.format);
else if (cfg.action === 'next') result = await nextPage();
else throw Error('UNKNOWN_EGO_ACTION');
console.log(`BAYT_EGO_RESULT=${JSON.stringify(result)}`);
