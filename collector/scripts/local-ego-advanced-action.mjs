// Runs inside `ego-browser nodejs`. Only ordinary, visible Bayt form controls are used.
const cfg = JSON.parse(globalThis.BAYT_EGO_ACTION_JSON || '{}');
const task = cfg.action === 'verifySession' ? await takeOverTaskSpace(cfg.spaceId) : await taskSpace(cfg.spaceId);
if (task.ownership !== 'agent') throw Error('EGO_USER_CONTROL_REQUIRED');
const page = task.page('p1');
const SEARCH_URL = 'https://www.bayt.com/en/employers/cv-search/';

async function rejectVisibleChallenge(title) {
  if (!/请稍候|just a moment|security verification/i.test(title || '')) return;
  const rayId = await page.evaluate(() => (document.body?.innerText || '')
    .match(/Ray ID:\s*([a-f0-9]{8,64})/i)?.[1] || null);
  throw Error(`BAYT_VERIFICATION_REQUIRED${rayId ? ` rayId=${rayId}` : ''}`);
}

// This function is serialized into the Bayt page by Ego. Keep it self-contained.
function inspectActionableTarget({ selector, text = null, textMode = 'exact', nth = null }) {
  const normalize = value => (value || '').replace(/[\uE000-\uF8FF]/g, '').trim();
  const all = [...document.querySelectorAll(selector)].filter(element =>
    text === null || (textMode === 'contains'
      ? normalize(element.innerText).includes(text) : normalize(element.innerText) === text));
  const matches = nth === null ? all : all[nth] ? [all[nth]] : [];
  const actionable = [];
  let visible = 0, inViewport = 0;
  for (const element of matches) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden' ||
      element.disabled || element.getAttribute('aria-disabled') === 'true') continue;
    visible++;
    const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    if (left >= right || top >= bottom) continue;
    inViewport++;
    const x = (left + right) / 2, y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === element || element.contains(hit))) actionable.push({ x, y });
  }
  if (actionable.length === 1) return { status: 'ok', ...actionable[0] };
  return { status: actionable.length > 1 ? 'ambiguous' : !matches.length ? 'missing' :
    !visible ? 'hidden' : !inViewport ? 'offscreen' : 'covered', matches: matches.length };
}

function inspectCityControl(row) {
  const form = [...document.querySelectorAll('form[name="ExperienceLocationForm"]')]
    .find(element => element.getBoundingClientRect().width > 0);
  const input = [...(form?.querySelectorAll('input[name="city__v"]') || [])][row];
  const select = [...(form?.querySelectorAll('select[name="city"]') || [])][row];
  return { present: !!input, visible: !!input && input.getBoundingClientRect().width > 0 &&
    input.getBoundingClientRect().height > 0, optionCount: select?.options.length || 0 };
}

function cityControlReady(row) {
  const form = [...document.querySelectorAll('form[name="ExperienceLocationForm"]')]
    .find(element => element.getBoundingClientRect().width > 0);
  const input = [...(form?.querySelectorAll('input[name="city__v"]') || [])][row];
  return !!input && input.getBoundingClientRect().width > 0 && input.getBoundingClientRect().height > 0;
}

async function clickControl(selector, phase, label, options = {}) {
  let target;
  // Wait briefly for ordinary modal/scroll animations, but never repeat a click.
  for (let attempt = 0; attempt < 10; attempt++) {
    target = await page.evaluate(inspectActionableTarget, { selector, ...options });
    if (target.status === 'ok' || target.status === 'ambiguous') break;
    if (attempt < 9) await page.waitForTimeout(250);
  }
  if (target.status !== 'ok') throw Error(`FORM_CONTROL_${phase}_${target.status.toUpperCase()}`);
  try {
    await page.mouse.click(target.x, target.y, { label });
  } catch {
    throw Error(`FORM_CLICK_${phase}_FAILED`);
  }
}

async function visibleAnchor(label) {
  await clickControl('a', `OPEN_${label.replace(/\W+/g, '_').toUpperCase()}`,
    `打开官网${label}控件`, { text: label });
}

async function openForm({ reset = false } = {}) {
  // A previous failed task can leave a modal over the listing. Each new search
  // starts from the official search page, not from that partially edited form.
  if (reset) await page.goto(SEARCH_URL);
  let state = await page.evaluate(() => ({ title: document.title, path: location.pathname,
    host: location.hostname }));
  await rejectVisibleChallenge(state.title);
  if (state.host !== 'www.bayt.com' ||
    !['/en/employers/cv-search/', '/en/employers/cv-search/listing/'].includes(state.path)) {
    await page.goto(SEARCH_URL);
    state = await page.evaluate(() => ({ title: document.title, path: location.pathname }));
  }
  await rejectVisibleChallenge(state.title);
  if (state.path === '/en/employers/cv-search/') {
    await clickControl('button', 'OPEN_SEARCH_CVS', '进入官网搜索列表', { text: 'Search CVs' });
  }
  await page.waitForFunction(() => location.pathname === '/en/employers/cv-search/listing/' &&
    [...document.querySelectorAll('a')].some(anchor => (anchor.innerText || '').trim().startsWith('Advanced filters') &&
      anchor.getBoundingClientRect().width > 0), undefined, { timeout: 20_000 });
  const expanded = await page.evaluate(() => [...document.querySelectorAll('a')].some(anchor =>
    (anchor.innerText || '').replace(/[\uE000-\uF8FF]/g, '').trim() === 'Job location' &&
    anchor.getBoundingClientRect().width > 0));
  if (!expanded) await visibleAnchor('Advanced filters');
  await page.waitForFunction(() => [...document.querySelectorAll('a')].some(anchor =>
    (anchor.innerText || '').replace(/[\uE000-\uF8FF]/g, '').trim() === 'Job location' &&
    anchor.getBoundingClientRect().width > 0), undefined, { timeout: 10_000 });
}

async function openModal(label, formName) {
  const expanded = await page.evaluate(() => [...document.querySelectorAll('a')].some(anchor =>
    (anchor.innerText || '').replace(/[\uE000-\uF8FF]/g, '').trim() === 'Job location' &&
    anchor.getBoundingClientRect().width > 0));
  if (!expanded) await visibleAnchor('Advanced filters');
  await visibleAnchor(label);
  await page.waitForFunction(name => {
    const visible = [...document.querySelectorAll(`form[name="${name}"]`)]
      .filter(form => form.getBoundingClientRect().width > 0 && form.getBoundingClientRect().height > 0);
    return visible.length === 1;
  }, formName, { timeout: 15_000 });
}

async function closeModal(formName) {
  await clickControl(`form[name="${formName}"] button`, `CANCEL_${formName}`,
    '关闭未提交的官网筛选', { text: 'Cancel' });
  await page.waitForFunction(name => [...document.querySelectorAll(`form[name="${name}"]`)]
    .every(form => form.getBoundingClientRect().width === 0), formName, { timeout: 15_000 });
}

async function applyModal(formName) {
  await clickControl(`form[name="${formName}"] button`, `APPLY_${formName}`,
    '应用官网可见筛选', { text: 'Apply' });
  await page.waitForFunction(name => {
    const visible = [...document.querySelectorAll(`form[name="${name}"]`)].filter(form => form.getBoundingClientRect().width > 0);
    return visible.length === 0 || visible.some(form => [...form.querySelectorAll('.form-value.has-error .form-hint')]
      .some(hint => hint.getBoundingClientRect().width > 0 && (hint.textContent || '').trim()));
  }, formName, { timeout: 15_000 });
  const rejected = await page.evaluate(name => [...document.querySelectorAll(`form[name="${name}"]`)]
    .filter(form => form.getBoundingClientRect().width > 0)
    .some(form => [...form.querySelectorAll('.form-value.has-error .form-hint')]
      .some(hint => hint.getBoundingClientRect().width > 0 && (hint.textContent || '').trim())), formName);
  if (rejected) throw Error(`BAYT_FILTER_VALIDATION_REJECTED_${formName}`);
}

async function keywordModes() {
  return await page.evaluate(() => {
    const labels = ['Any words', 'Exact order', 'Boolean search', 'All words'];
    return labels.map(label => {
      const matches = [...document.querySelectorAll('label')].filter(element =>
        element.textContent?.trim() === label && element.getBoundingClientRect().width > 0);
      const input = matches.length === 1 ? document.getElementById(matches[0].htmlFor) : null;
      return input?.type === 'radio' && /^[a-z0-9][a-z0-9._:-]*$/i.test(input.value)
        ? { key: input.value, label, selector: `label[for="${input.id}"]` } : null;
    }).filter(Boolean);
  });
}

async function openOptions(inputSelector, phase = 'OPEN_OPTIONS') {
  const [selector, rawNth] = inputSelector.split(/\s*>>\s*nth=/);
  await clickControl(selector, phase, '展开官网可见选项',
    rawNth === undefined ? {} : { nth: Number(rawNth) });
  await page.waitForFunction(() => [...document.querySelectorAll('ul.options')].some(list =>
    list.getBoundingClientRect().width > 0 && list.querySelector('li[data-value]')), undefined, { timeout: 20_000 });
  const options = await page.evaluate(() => {
    const lists = [...document.querySelectorAll('ul.options')].filter(list =>
      list.getBoundingClientRect().width > 0 && list.getBoundingClientRect().height > 0);
    if (lists.length !== 1) return null;
    const entries = [...lists[0].querySelectorAll('li[data-value]')].filter(item => item.getBoundingClientRect().width > 0)
      .map(item => ({ key: item.dataset.value || '', label: (item.dataset.text || item.textContent || '').trim() }))
      .filter(item => item.key && item.label && /^[a-z0-9][a-z0-9._:,-]*$/i.test(item.key));
    return entries.length === new Set(entries.map(item => item.key)).size ? entries : null;
  });
  if (!options) throw Error('VISIBLE_OPTIONS_UNRELIABLE');
  return options;
}

async function closeOptions(inputSelector) {
  await page.press(`loc=css:${inputSelector}`, 'Escape');
}

async function chooseOption(key, label = '') {
  const kind = await page.evaluate(wanted => {
    const matches = [...document.querySelectorAll('ul.options li[data-value]')].filter(item =>
      item.dataset.value === wanted && item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0);
    if (matches.length !== 1) return null;
    return matches[0].closest('.select.is-active') ? 'multi' : matches[0].querySelector('a') ? 'single' : null;
  }, key);
  if (!kind) throw Error('VISIBLE_OPTION_CHANGED');
  if (kind === 'single') {
    const searchable = await page.evaluate(() => [...document.querySelectorAll('.popover.is-active input[data-search]')]
      .filter(input => input.getBoundingClientRect().width > 0).length === 1);
    if (searchable && label) await page.fill('loc=css:.popover.is-active input[data-search]', label);
    const position = await page.evaluate(wanted => {
      const matches = [...document.querySelectorAll('.popover.is-active li[data-value]')]
        .filter(item => item.dataset.value === wanted && item.getBoundingClientRect().width > 0);
      if (matches.length !== 1) return null;
      const rect = matches[0].getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return hit?.closest('li[data-value]') === matches[0] ? { x, y } : null;
    }, key);
    if (!position) throw Error('VISIBLE_OPTION_NOT_ACTIONABLE');
    await page.mouse.click(position.x, position.y, { label: '选择官网可见地点选项' });
    return;
  }
  // The visible checkbox label covers its <li>. A locator click on the <li>
  // fails actionability even though a normal pointer click on the label works.
  for (let attempt = 0; attempt < 30; attempt++) {
    const position = await page.evaluate(wanted => {
      const matches = [...document.querySelectorAll('.select.is-active ul.options li[data-value]')]
        .filter(item => item.dataset.value === wanted && item.getBoundingClientRect().width > 0);
      if (matches.length !== 1) return null;
      const item = matches[0], list = item.closest('ul.options');
      const rect = item.getBoundingClientRect(), viewport = list.getBoundingClientRect();
      const x = rect.left + Math.min(rect.width / 2, 120);
      const y = rect.top + rect.height / 2;
      return { x, y, scrollX: viewport.left + viewport.width / 2,
        scrollY: viewport.top + viewport.height / 2,
        direction: y < viewport.top + 4 ? -1 : y > viewport.bottom - 4 ? 1 : 0,
        clickable: y >= viewport.top + 4 && y <= viewport.bottom - 4 &&
          x >= viewport.left && x <= viewport.right && y >= 0 && y <= innerHeight,
        checked: item.querySelector('input[type=checkbox]')?.checked === true };
    }, key);
    if (!position) throw Error('VISIBLE_OPTION_CHANGED');
    if (position.checked) return;
    if (position.clickable) {
      await page.mouse.click(position.x, position.y, { label: '选择官网可见的多选项' });
      const checked = await page.evaluate(wanted => [...document.querySelectorAll('.select.is-active ul.options li[data-value]')]
        .filter(item => item.dataset.value === wanted && item.getBoundingClientRect().width > 0)
        .some(item => item.querySelector('input[type=checkbox]')?.checked === true), key);
      if (!checked) throw Error('MULTI_OPTION_NOT_VERIFIED');
      return;
    }
    await page.mouse.move(position.scrollX, position.scrollY);
    await page.mouse.wheel(0, 350 * position.direction, { label: '滚动官网可见选项' });
  }
  throw Error('VISIBLE_OPTION_NOT_REACHABLE');
}

async function discoverCatalog() {
  await openForm({ reset: true });
  const modes = await keywordModes();
  await openModal('Name', 'NameForm');
  const surname = await page.evaluate(() => {
    const input = document.querySelector('form[name="NameForm"] input[name="lName"]');
    return !!input && input.getBoundingClientRect().width > 0;
  });
  await closeModal('NameForm');

  await openModal('Job role and industry', 'JobRoleIndustryForm');
  const jobRoles = await openOptions('form[name="JobRoleIndustryForm"] input[placeholder="Choose role"]', 'CATALOG_JOB_ROLE');
  await closeOptions('form[name="JobRoleIndustryForm"] input[placeholder="Choose role"]');
  const industries = await openOptions('form[name="JobRoleIndustryForm"] input[placeholder="Choose industry"]', 'CATALOG_INDUSTRY');
  await closeOptions('form[name="JobRoleIndustryForm"] input[placeholder="Choose industry"]');
  await closeModal('JobRoleIndustryForm');

  await openModal('Job location', 'ExperienceLocationForm');
  const countryInput = 'form[name="ExperienceLocationForm"] input[name="country__v"] >> nth=0';
  const rawCountries = await openOptions(countryInput, 'CATALOG_COUNTRY');
  await closeOptions(countryInput);
  const countries = rawCountries.filter(item => !/^All .+ Countries$/i.test(item.label));
  const requested = new Set((cfg.cityCountries || []).map(value => String(value).toLowerCase()));
  const citiesByCountry = new Map();
  for (const country of countries.filter(item => requested.has(item.label.toLowerCase()))) {
    await openOptions(countryInput, 'CATALOG_COUNTRY');
    await chooseOption(country.key, country.label);
    await page.waitForFunction(cityControlReady, 0, { timeout: 20_000 });
    const cityInput = 'form[name="ExperienceLocationForm"] input[name="city__v"] >> nth=0';
    const cities = (await openOptions(cityInput, 'CATALOG_CITY')).filter(item => !/^All cities$/i.test(item.label));
    citiesByCountry.set(country.key, cities);
    await closeOptions(cityInput);
  }
  const multipleLocations = await page.evaluate(() => [...document.querySelectorAll('form[name="ExperienceLocationForm"] a')]
    .some(anchor => /Add another/.test(anchor.innerText || '') && anchor.getBoundingClientRect().width > 0));
  await closeModal('ExperienceLocationForm');
  const reliable = modes.length === 4 && surname && countries.length > 100 && jobRoles.length > 20 &&
    industries.length > 50 && multipleLocations && citiesByCountry.size === requested.size &&
    [...citiesByCountry.values()].every(cities => cities.length > 0);
  return { filters: [], sorts: [], advanced: {
    keywordModes: modes.map(({ key, label }) => ({ key, label })), nameSupported: surname,
    locations: countries.map(country => ({ ...country, cities: citiesByCountry.get(country.key) || [] })),
    jobRoles, industries, exclusionSupported: false, reliable,
    reason: reliable ? null : '新版官网筛选控件未全部可靠识别，暂不发布采集任务',
  } };
}

async function startSearch() {
  const spec = cfg.searchSpec;
  if (spec?.schemaVersion !== 2) throw Error('INVALID_SEARCH_SPEC');
  if (spec.excludeJobRoles?.length || spec.excludeIndustries?.length) throw Error('UNSUPPORTED_EXCLUSION_CONTROL');
  if (spec.name && !/^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u.test(spec.name)) throw Error('BAYT_NAME_FORMAT_UNSUPPORTED');
  await openForm({ reset: true });
  const modes = await keywordModes();
  const mode = modes.find(item => item.key === spec.keywordMode);
  if (!mode) throw Error('KEYWORD_MODE_CHANGED');
  const intendedKeyword = [spec.keyword, spec.approximateLocationKeyword].filter(Boolean).join(' ');
  // Choose the radio before typing: Bayt's keyword suggestions cover these
  // labels, and Escape on that popover also clears #searchBar.
  const alreadySelected = await page.evaluate(selector => {
    const label = document.querySelector(selector);
    return !!label && document.getElementById(label.htmlFor)?.checked === true;
  }, mode.selector);
  if (!alreadySelected) await clickControl(mode.selector, 'KEYWORD_MODE', '选择官网关键词匹配模式');
  const selectedMode = await page.evaluate(selector => {
    const label = document.querySelector(selector);
    return !!label && document.getElementById(label.htmlFor)?.checked === true;
  }, mode.selector);
  if (!selectedMode) throw Error('KEYWORD_MODE_NOT_VERIFIED');
  await page.fill('loc=css:#searchBar', intendedKeyword);
  const actualFilterLabels = [];

  if (spec.name) {
    await openModal('Name', 'NameForm');
    await page.fill('loc=css:form[name="NameForm"] input[name="lName"]', spec.name);
    const surname = await page.evaluate(() => document.querySelector('form[name="NameForm"] input[name="lName"]')?.value);
    if (surname !== spec.name) throw Error('SURNAME_NOT_VERIFIED');
    await applyModal('NameForm');
    actualFilterLabels.push(`Last name: ${spec.name}`);
  }

  if (spec.pastJobLocations?.length) {
    await openModal('Job location', 'ExperienceLocationForm');
    for (let index = 0; index < spec.pastJobLocations.length; index++) {
      if (index > 0) {
        await clickControl('form[name="ExperienceLocationForm"] a', 'LOCATION_ADD_ANOTHER',
          '添加官网地点条件', { text: 'Add another', textMode: 'contains' });
        await page.waitForFunction(count => [...document.querySelectorAll('form[name="ExperienceLocationForm"] input[name="country__v"]')]
          .filter(input => input.getBoundingClientRect().width > 0).length === count, index + 1, { timeout: 10_000 });
      }
      const location = spec.pastJobLocations[index];
      const countryInput = `form[name="ExperienceLocationForm"] input[name="country__v"] >> nth=${index}`;
      const countries = await openOptions(countryInput, `LOCATION_COUNTRY_${index + 1}`);
      const country = countries.find(item => item.key === location.countryKey && !/^All .+ Countries$/i.test(item.label));
      if (!country) throw Error('COUNTRY_OPTION_CHANGED');
      await chooseOption(country.key, country.label);
      actualFilterLabels.push(`Past job location: ${country.label}`);
      if (location.cityKey) {
        try {
          await page.waitForFunction(cityControlReady, index, { timeout: 20_000 });
        } catch {
          const city = await page.evaluate(inspectCityControl, index);
          throw Error(`BAYT_CITY_CONTROL_${city.visible ? 'TIMEOUT' : city.optionCount <= 1 ? 'UNAVAILABLE' : 'HIDDEN'}_LOCATION_${index + 1}`);
        }
        const cityInput = `form[name="ExperienceLocationForm"] input[name="city__v"] >> nth=${index}`;
        const cities = await openOptions(cityInput, `LOCATION_CITY_${index + 1}`);
        const city = cities.find(item => item.key === location.cityKey);
        if (!city) throw Error('CITY_OPTION_CHANGED');
        await chooseOption(city.key, city.label);
        actualFilterLabels[actualFilterLabels.length - 1] += ` / ${city.label}`;
      }
      const selected = await page.evaluate(row => {
        const form = document.querySelector('form[name="ExperienceLocationForm"]');
        return { country: [...form.querySelectorAll('select[name="country"]')][row]?.value,
          city: [...form.querySelectorAll('select[name="city"]')][row]?.value || '' };
      }, index);
      if (selected.country !== location.countryKey || selected.city !== (location.cityKey || '')) throw Error('LOCATION_NOT_VERIFIED');
    }
    await applyModal('ExperienceLocationForm');
  }

  if (spec.includeJobRoles?.length || spec.includeIndustries?.length) {
    await openModal('Job role and industry', 'JobRoleIndustryForm');
    for (const [field, placeholder, values, label] of [
      ['experience_role', 'Choose role', spec.includeJobRoles || [], 'Job role'],
      ['experience_industry', 'Choose industry', spec.includeIndustries || [], 'Industry'],
    ]) {
      if (!values.length) continue;
      const input = `form[name="JobRoleIndustryForm"] input[placeholder="${placeholder}"]`;
      const options = await openOptions(input, `FILTER_${field.toUpperCase()}`);
      for (const value of values) {
        const option = options.find(item => item.key === value);
        if (!option) throw Error('ADVANCED_OPTION_CHANGED');
        await chooseOption(value);
        actualFilterLabels.push(`${label}: ${option.label}`);
      }
      await clickControl('button[data-ok]', `CONFIRM_${field.toUpperCase()}`,
        '确认官网多选条件');
      const selected = await page.evaluate(name => {
        const form = document.querySelector('form[name="JobRoleIndustryForm"]');
        const select = form?.querySelector(`select[name="${name}"]`);
        const tags = [...(select?.closest('.select')?.querySelectorAll('a') || [])]
          .filter(anchor => anchor.getBoundingClientRect().width > 0).map(anchor => (anchor.innerText || '').trim());
        return { keys: [...(select?.selectedOptions || [])].map(option => option.value), tags };
      }, field);
      if (selected.keys.length !== values.length || values.some(value => !selected.keys.includes(value)) ||
        options.filter(item => values.includes(item.key)).some(item => !selected.tags.some(tag => tag.includes(item.label)))) {
        throw Error('MULTI_SELECTION_NOT_VERIFIED');
      }
    }
    await applyModal('JobRoleIndustryForm');
  }

  const chosen = await page.evaluate(() => ({ keyword: document.querySelector('#searchBar')?.value?.trim() || '' }));
  if (chosen.keyword !== intendedKeyword) throw Error('KEYWORD_NOT_VERIFIED');
  const submit = await page.evaluate(() => {
    const visible = element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const buttons = [...document.querySelectorAll('#cTop button')];
    const matches = buttons.map((button, index) => ({ button, index })).filter(({ button }) => visible(button) &&
      /^(?:search(?: cvs| candidates)?|\d[\d,]* cvs)$/i.test((button.innerText || '').trim()) &&
      button.closest('.row')?.querySelector('#searchBar'));
    return matches.length === 1 ? matches[0].index : null;
  });
  if (submit === null) throw Error('SEARCH_SUBMIT_UNRELIABLE');
  await clickControl('#cTop button', 'SUBMIT_SEARCH', '提交官网简历搜索', { nth: submit });
  await page.waitForFunction(() => location.pathname === '/en/employers/cv-search/listing/' &&
    !!new URL(location.href).searchParams.get('searchId') &&
    [...document.querySelectorAll('input[type=checkbox][name]')].some(element => /^\d+$/.test(element.name)),
    undefined, { timeout: 45_000 });
  return { ...await page.evaluate(() => ({ searchId: new URL(location.href).searchParams.get('searchId'),
    keyword: document.querySelector('#searchBar')?.value?.trim() || '',
    page: Number(document.querySelector('input[name=p]')?.value || 0),
    matchedCount: (() => {
      const candidates = [...document.querySelectorAll('[data-automation-id*=result-count],.results-count,.result-count')]
        .map(element => (element.textContent || '').replace(/,/g, '').match(/\b\d+\b/)?.[0]).filter(Boolean);
      return candidates.length === 1 ? Number(candidates[0]) : null;
    })(),
    ids: [...document.querySelectorAll('input[type=checkbox][name]')].filter(element => /^\d+$/.test(element.name)).map(element => element.name) })), actualFilterLabels };
}

async function verifySession() {
  try {
    await checkSearchResponse();
    const verified = await page.evaluate(() => {
      const visible = el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
      const body = document.body?.innerText || '';
      if (location.hostname !== 'www.bayt.com' || !['/en/employers/cv-search/', '/en/employers/cv-search/listing/'].includes(location.pathname) ||
        /verify you are human|just a moment|security verification|complete the captcha|cloudflare|session expired/i.test(body) ||
        [...document.querySelectorAll('input[type=password]')].some(visible)) return false;
      const search = document.querySelector('#searchBar');
      // Loaded searches replace "Search CVs" with a count (including "0 CVs").
      // Advanced filters also carries a badge and icon; neither means a challenge.
      const formReady = !!search && visible(search) && [...document.querySelectorAll('a,button')].some(el => visible(el) &&
        /^(?:Search CVs|[\d,]+ CVs|Advanced filters(?: \d+)?)$/i.test((el.innerText || '')
          .replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim()));
      return formReady ||
        [...document.querySelectorAll('input[type=checkbox][name]')].some(el => /^\d+$/.test(el.name));
    });
    if (!verified) await task.handOff();
    return { verified };
  } catch (error) { await task.handOff(); throw error; }
}

async function checkSearchResponse() {
  const problem = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    // The shell can render normally while its preferences request is challenged.
    // Consider the latest response per required endpoint; unrelated 403s and a
    // recovered earlier failure must not keep a healthy session blocked.
    const latest = new Map();
    for (const entry of performance.getEntriesByType('resource')) {
      const url = new URL(entry.name, location.href);
      if (url.origin === location.origin && (/^\/v6\/cvSearch\/[^/]+\/results\/?$/.test(url.pathname) ||
        url.pathname === '/v6/employer/myAccount/employerPreferences')) latest.set(url.pathname, entry);
    }
    const last = [...latest.values()].filter(e => [401,403,429].includes(e.responseStatus))
      .sort((a, b) => a.startTime - b.startTime).at(-1);
    const visiblePassword = [...document.querySelectorAll('input[type=password]')].some(e => e.getBoundingClientRect().width > 0);
    return { status: last?.responseStatus || null, verification: /verify you are human|just a moment|security verification|complete the captcha/i.test(body),
      login: visiblePassword, rayId: last?.serverTiming?.find(e => e.name.toLowerCase() === 'chlray')?.description ||
        body.match(/Ray ID:\s*([a-f0-9]{8,64})/i)?.[1] || null };
  });
  if (problem.status === 429) throw Error('BAYT_429');
  if ([401,403].includes(problem.status) || problem.verification || problem.login)
    throw Error(`BAYT_VERIFICATION_REQUIRED${problem.rayId ? ` rayId=${problem.rayId}` : ''}`);
}

async function guardedStartSearch() {
  try { const result = await startSearch(); await checkSearchResponse(); return result; }
  catch (error) { await checkSearchResponse(); throw error; }
}

const result = cfg.action === 'verifySession' ? await verifySession() : cfg.action === 'catalog' ? await discoverCatalog() : cfg.action === 'startSearch' ? await guardedStartSearch() :
  cfg.action === 'handoff' ? (await task.handOff(), { handedOff: true }) : null;
if (!result) throw Error('UNKNOWN_ADVANCED_ACTION');
console.log(`BAYT_EGO_RESULT=${JSON.stringify(result)}`);
