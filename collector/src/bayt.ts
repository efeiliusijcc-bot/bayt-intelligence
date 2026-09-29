/**
 * Bayt浏览器适配层。
 * 上层只调用“创建搜索、翻页、列候选人、导出文件”等业务方法；本文件负责Playwright和页面DOM细节。
 * 初学者语法：class把数据和方法组合在一起；async方法返回Promise，调用时通常配合await。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Download,
  type Locator,
  type Page,
  type Route,
  type Response,
} from "playwright";
import {
  ALLOW_BUNDLED_BROWSER_FALLBACK,
  BAYT_EMPLOYER_LOGIN_URL,
  BAYT_HOME_URL,
  BAYT_SEARCH_URL,
  BROWSER_CHANNEL,
  BROWSER_PROFILE_DIR,
  DEFAULT_QUERY,
  DIAGNOSTICS_DIR,
  LOGIN_URL_PATTERN,
  PROFILE_URL_PATTERN,
  nowIso,
} from "./config.ts";
import { ensureDataLayout } from "./files.ts";
import type { ListingCandidate, ParsedProfile } from "./types.ts";

/** 需要人工重新登录时抛出的专用异常，方便上层区别普通失败。 */
export class LoginRequiredError extends Error {
  /** message有默认值，因此调用时可以不传参数。 */
  constructor(message = "Bayt employer login is required") {
    super(message);
    this.name = "LoginRequiredError";
  }
}

/** 命中验证码、限频、购买或映射风险时抛出的“停止而非重试”异常。 */
export class SafetyStopError extends Error {
  readonly reason: string;

  /** readonly表示reason在构造完成后不能被重新赋值。 */
  constructor(reason: string, message: string) {
    super(message);
    this.name = "SafetyStopError";
    this.reason = reason;
  }
}

/** 一个Bayt搜索创建或打开后的稳定状态。 */
export interface SearchState {
  searchId: string;
  query: string;
  lastUpdatedFilterApplied: boolean;
  displayedCount: number | null;
  pageCount: number | null;
  listingUrl: string;
}

/** 从官网动态识别的一项Filter定义。 */
export interface DiscoveredFilterDefinition {
  key: string;
  label: string;
  controlType: "single" | "multi" | "range" | "search" | "unsupported";
  supported: boolean;
  options: Array<{ key: string; label: string }>;
  valueKind?: "text" | "number";
  reason?: string | null;
}

/** 所有可识别Filter和排序选项的目录。 */
export interface DiscoveredFilterCatalog {
  filters: DiscoveredFilterDefinition[];
  sorts: Array<{ key: string; label: string }>;
}

/** 前端对某项Filter的选择；不同控件会使用optionKeys、value或min/max。 */
export interface BrowserFilterSelection {
  key: string;
  optionKeys?: string[];
  value?: string;
  min?: number;
  max?: number;
}

/** 一次搜索任务的完整且不可变条件。 */
export interface BrowserSearchSpec {
  keyword: string;
  filterSchemaVersion: string;
  filters: BrowserFilterSelection[];
  sortKey: string | null;
}

/** 浏览器启动选项；问号表示字段可省略。 */
interface BrowserOptions {
  headless?: boolean;
  capturePath?: string;
}

// 批量导出当前只允许Excel或PDF ZIP两种格式。
export type BulkExportFormat = "xls" | "pdf";

/** 逐人采集结果：解析资料、标准PDF以及可能不存在的原始附件。 */
interface CandidateDownloadResult {
  profile: ParsedProfile;
  standardDownload: Download | null;
  originalDownload: Download | null;
  originalStatus: "downloaded" | "not_available";
}

/** 从一次批量下载UI动作捕获的请求描述；只在同一浏览器会话里短暂使用。 */
interface CapturedBulkDownloadRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData: string | null;
}

// 页面文本经常含多余空白，统一压缩后再做精确比较。
const normalizeSpace = (value: string): string => value.replace(/\s+/g, " ").trim();

// 把人类标签变成稳定小写键，例如“Last Updated”变为“last-updated”。
const catalogKey = (value: string): string => normalizeSpace(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90);

// 集中维护需要安全停止的限频文案特征。
const RATE_LIMIT_PATTERN = /unusually high search activity|try again in a few minutes|unusual traffic|too many requests|rate.?limit/i;

/**
 * 只把Bayt简历搜索API的鉴权/限频响应归因给批量导出。
 * 返回稳定路由标签而不是原始URL，避免把查询参数、token或搜索ID写进日志。
 */
export function classifyBulkExportSafetyResponse(
  rawUrl: string,
  status: number,
): { reason: string; route: "downloadCV" | "getActionToken" | "searchCv" } | null {
  if (![401, 403, 429].includes(status)) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.hostname.toLocaleLowerCase() !== "www.bayt.com") return null;
  const pathname = url.pathname.toLocaleLowerCase();
  if (!pathname.startsWith("/v6/searchcv/")) return null;
  const route = pathname.includes("/downloadcv/") || pathname.endsWith("/downloadcv")
    ? "downloadCV"
    : pathname.includes("/getactiontoken/") || pathname.endsWith("/getactiontoken")
      ? "getActionToken"
      : "searchCv";
  return { reason: `bayt_${status}`, route };
}

// Filter选项尾部常带动态数量，如“Dubai (123)”，版本目录需要移除这个易变部分。
const stripDynamicOptionCount = (value: string): string => normalizeSpace(value)
  .replace(/\s*\(\s*[\d,.]+(?:[KMB])?\+?\s*\)\s*$/i, "")
  .trim();
// URL判定函数用于等待跳转，不依赖完整URL或参数顺序。
const isListingUrl = (url: URL): boolean => url.pathname.includes("/cv-search/listing/") && url.searchParams.has("searchId");

/** 判断URL是否是Bayt保存搜索后的中转页。 */
const isSavedSearchUrl = (url: URL): boolean =>
  /\/employers\/cv-search\/$/.test(url.pathname) && url.searchParams.has("searchId");

/** 统一封装一个浏览器上下文和一个工作标签页。 */
export class BaytBrowser {
  readonly context: BrowserContext;
  readonly page: Page;
  private readonly attachedBrowser: Browser | null;
  private readonly closeContextOnExit: boolean;

  /** 私有构造函数强制调用方使用下面的工厂方法创建实例。 */
  private constructor(
    context: BrowserContext,
    page: Page,
    attachedBrowser: Browser | null = null,
    closeContextOnExit = false,
  ) {
    this.context = context;
    this.page = page;
    this.attachedBrowser = attachedBrowser;
    this.closeContextOnExit = closeContextOnExit;
  }

  /** 测试专用：用测试已经创建的context/page组装实例。 */
  static fromTestContext(context: BrowserContext, page: Page): BaytBrowser {
    return new BaytBrowser(context, page);
  }

  /** 连接已经运行的官方Chrome CDP端口，不负责启动或关闭整个Chrome。 */
  static async connectOverCdp(endpoint: string): Promise<BaytBrowser> {
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new Error("The Chrome CDP endpoint has no usable browser context");
    }
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(45_000);
    return new BaytBrowser(context, page, browser, false);
  }

  /** 启动带持久化profile的Chrome，可选择无头模式和HAR抓包。 */
  static async open(options: BrowserOptions = {}): Promise<BaytBrowser> {
    await ensureDataLayout();
    await fsp.mkdir(BROWSER_PROFILE_DIR, { recursive: true, mode: 0o700 });
    // `as const`保留各配置值的精确只读类型，满足Playwright参数约束。
    const launchOptions = {
      headless: options.headless ?? process.env.BAYT_HEADLESS === "1",
      acceptDownloads: true,
      viewport: null,
      locale: "en-US",
      recordHar: options.capturePath
        ? { path: options.capturePath, mode: "full" as const, content: "embed" as const }
        : undefined,
    } as const;

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
        ...launchOptions,
        channel: BROWSER_CHANNEL,
      });
    } catch (error) {
      // 明确允许时才回退到Playwright自带Chromium，否则避免浏览器环境悄然变化。
      if (!ALLOW_BUNDLED_BROWSER_FALLBACK) {
        throw new Error(
          `Required browser channel "${BROWSER_CHANNEL}" could not be launched; bundled-browser fallback is disabled`,
          { cause: error },
        );
      }
      context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, launchOptions);
    }
    const pages = context.pages();
    const page = pages[0] || (await context.newPage());
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(45_000);
    return new BaytBrowser(context, page, null, true);
  }

  /** 关闭本类拥有的资源；CDP模式只关工作页，不终止用户的持久Chrome。 */
  async close(): Promise<void> {
    if (this.closeContextOnExit) {
      await this.context.close();
      return;
    }
    await this.page.close().catch(() => undefined);
    // For connectOverCDP, closing Browser would terminate the user's persistent
    // Chrome. Let process exit disconnect the Playwright transport instead.
    void this.attachedBrowser;
  }

  /** 登录阶段等待人工完成验证码；自动化本身不尝试绕过挑战。 */
  private async waitForInteractiveClearance(deadlineMs: number): Promise<void> {
    let announced = false;
    while (true) {
      if (LOGIN_URL_PATTERN.test(this.page.url())) return;
      try {
        await this.safetyCheck();
        return;
      } catch (error) {
        if (error instanceof LoginRequiredError && LOGIN_URL_PATTERN.test(this.page.url())) return;
        if (!(error instanceof SafetyStopError) || error.reason !== "captcha_or_rate_limit") throw error;
        if (!announced) {
          process.stdout.write(
            "MANUAL_VERIFICATION_REQUIRED: 请在远程Chrome窗口人工完成Cloudflare或验证码验证；自动采集仍保持暂停。\n",
          );
          announced = true;
        }
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) throw error;
        await this.page.waitForTimeout(Math.min(1000, remainingMs));
      }
    }
  }

  /** 打开登录页面并等待用户人工登录成功，程序不读取密码。 */
  async loginInteractively(timeoutMs = 15 * 60 * 1000): Promise<void> {
    const deadlineMs = Date.now() + timeoutMs;
    await this.page.goto(BAYT_HOME_URL, { waitUntil: "domcontentloaded" });
    await this.waitForInteractiveClearance(deadlineMs);
    await this.page.goto(BAYT_EMPLOYER_LOGIN_URL, { waitUntil: "domcontentloaded" });
    await this.waitForInteractiveClearance(deadlineMs);
    if (LOGIN_URL_PATTERN.test(this.page.url())) {
      process.stdout.write(
        "LOGIN_REQUIRED: 请在打开的专用Chrome窗口完成Bayt企业账号登录。程序不会读取或保存密码。\n",
      );
      await this.page.waitForURL(
        (url) => !LOGIN_URL_PATTERN.test(url.pathname) && url.pathname.includes("/employers/"),
        { timeout: Math.max(1, deadlineMs - Date.now()) },
      );
    }
    await this.page.goto(BAYT_SEARCH_URL, { waitUntil: "domcontentloaded" });
    await this.waitForInteractiveClearance(deadlineMs);
    if (LOGIN_URL_PATTERN.test(this.page.url())) throw new LoginRequiredError("Login did not persist");
    await this.safetyCheck();
  }

  /**
   * 仅使用官方Chrome已经保存并自动填充的凭据尝试一次登录。
   * 只回传字段是否非空的布尔值，不读取、记录或填写账号密码；验证码仍需人工处理。
   */
  async tryLoginWithSavedCredentials(): Promise<boolean> {
    await this.page.goto(BAYT_EMPLOYER_LOGIN_URL, { waitUntil: "domcontentloaded" });
    await this.assertNoCaptchaOrRateLimit();
    if (!LOGIN_URL_PATTERN.test(this.page.url())) {
      await this.assertLoggedIn();
      return true;
    }

    const username = this.page.locator('input[name="LoginForm[username]"]:visible').first();
    const password = this.page.locator('input[name="LoginForm[password]"]:visible').first();
    const submit = this.page.locator('button[name="submit"]:visible').first();
    await this.page.waitForTimeout(1_000);
    const canSubmitSavedCredentials = await this.page.evaluate(() => {
      const usernameInput = document.querySelector('input[name="LoginForm[username]"]');
      const passwordInput = document.querySelector('input[name="LoginForm[password]"]');
      const submitButton = document.querySelector('button[name="submit"]');
      return usernameInput instanceof HTMLInputElement
        && passwordInput instanceof HTMLInputElement
        && submitButton instanceof HTMLButtonElement
        && usernameInput.value.length > 0
        && passwordInput.value.length > 0
        && !submitButton.disabled;
    });
    if (!canSubmitSavedCredentials || !(await username.count()) || !(await password.count()) || !(await submit.count())) {
      return false;
    }

    const leftLoginPage = await Promise.all([
      this.page.waitForURL((url) => !LOGIN_URL_PATTERN.test(url.pathname), {
        timeout: 45_000,
        waitUntil: "commit",
      }).then(() => true).catch(() => false),
      submit.click(),
    ]).then(([navigated]) => navigated);
    await this.assertNoCaptchaOrRateLimit();
    if (!leftLoginPage || LOGIN_URL_PATTERN.test(this.page.url())) return false;
    await this.assertLoggedIn();
    return true;
  }

  /** 访问企业搜索入口，用重定向和页面安全检查确认当前会话仍登录。 */
  async assertLoggedIn(): Promise<void> {
    await this.page.goto(BAYT_SEARCH_URL, { waitUntil: "domcontentloaded" });
    if (LOGIN_URL_PATTERN.test(this.page.url())) throw new LoginRequiredError();
    await this.safetyCheck();
  }

  /** 输入关键词并创建搜索；必要时处理Bayt先保存搜索、再从最近搜索打开的流程。 */
  async createSearch(query = DEFAULT_QUERY, applyRecentFilter = true): Promise<SearchState> {
    await this.assertLoggedIn();
    const searchInput = this.page.locator('input[placeholder="Search by title, skill, location, etc."]:visible').first();
    try {
      await searchInput.waitFor({ state: "visible" });
    } catch (error) {
      await this.safetyCheck();
      await this.writeDiagnostic("search-input-missing");
      throw error;
    }
    // Bayt hydrates this control after DOMContentLoaded. Writing during that
    // replacement loses the first characters while leaving the input looking
    // partially populated, so wait for the live control and verify its value.
    await this.page.waitForTimeout(5_000);
    let inputVerified = false;
    // 页面hydration可能替换输入框，因此最多重新定位和验证三次。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const currentInput = this.page.locator('input[placeholder="Search by title, skill, location, etc."]:visible').first();
      await currentInput.click();
      await currentInput.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await currentInput.pressSequentially(query, { delay: 50 });
      await this.page.waitForTimeout(500);
      if ((await currentInput.inputValue()) === query) {
        inputVerified = true;
        break;
      }
      await this.page.waitForTimeout(2_000);
    }
    if (!inputVerified) {
      await this.writeDiagnostic("search-input-unstable");
      throw new SafetyStopError("search_input_unstable", "Bayt did not retain the complete search keyword");
    }

    const submitCandidates = this.page.locator("button:visible").filter({
      hasText: /Search CVs|\d+[K+,.\s]*CVs?/i,
    });
    if (!(await submitCandidates.count())) {
      await this.writeDiagnostic("search-submit-missing");
      throw new Error("Could not find the Bayt CV search submit button");
    }
    // Promise.all同时“先监听跳转”和“点击按钮”，避免错过很快发生的导航事件。
    const [openedListing] = await Promise.all([
      this.page.waitForURL(isListingUrl, { timeout: 15_000, waitUntil: "commit" })
        .then(() => true)
        .catch(() => false),
      submitCandidates.first().click(),
    ]);
    // 部分情况下Bayt先落在Saved Search页，需要找到刚创建的搜索再打开。
    if (!openedListing) {
      await this.page.waitForURL((url) => isSavedSearchUrl(url), { timeout: 15_000, waitUntil: "commit" });
      await this.page.waitForLoadState("domcontentloaded").catch(() => undefined);
      const recentSearch = await this.findRecentSearchControl(query);
      if (!recentSearch) {
        await this.writeDiagnostic("recent-search-control-missing");
        throw new Error(`Bayt saved the search but its recent-search control was not found: ${query}`);
      }
      await Promise.all([
        this.page.waitForURL(isListingUrl, { timeout: 45_000, waitUntil: "commit" }),
        recentSearch.click(),
      ]);
    }
    await this.waitForListing();

    let lastUpdatedFilterApplied = false;
    if (applyRecentFilter) {
      lastUpdatedFilterApplied = await this.applyLastUpdatedFilter().catch(() => false);
    }

    const state = await this.readSearchState(query, lastUpdatedFilterApplied);
    return state;
  }

  /** 从当前列表URL和页面文字读取searchId、匹配人数、总页数等证据。 */
  async readSearchState(query: string, lastUpdatedFilterApplied: boolean): Promise<SearchState> {
    const url = new URL(this.page.url());
    const searchId = url.searchParams.get("searchId");
    if (!searchId) throw new Error(`Listing URL does not contain searchId: ${url}`);
    const body = normalizeSpace(await this.page.locator("body").innerText());
    const countMatch = body.match(/([0-9][0-9,.]*\s*[KMB]?\+?)\s*CVs matching your search/i);
    let displayedCount: number | null = null;
    if (countMatch) {
      // 支持12K/1.2M等缩写，并换算成普通整数。
      const value = countMatch[1].replace(/[,+\s]/g, "").toUpperCase();
      const suffix = value.match(/[KMB]$/)?.[0] || "";
      const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
      displayedCount = Math.round(Number.parseFloat(value.replace(/[KMB]$/, "")) * multiplier);
    }
    const pageInput = this.page.locator('input[name="p"]');
    let pageCount: number | null = null;
    if (await pageInput.count()) {
      const text = normalizeSpace(await pageInput.locator("xpath=parent::*").innerText().catch(() => ""));
      const match = text.match(/of\s+([0-9,]+)/i);
      if (match) pageCount = Number.parseInt(match[1].replaceAll(",", ""), 10);
    }
    return {
      searchId,
      query,
      lastUpdatedFilterApplied,
      displayedCount,
      pageCount,
      listingUrl: this.page.url(),
    };
  }

  /** 用已有searchId直接回到搜索列表，主要用于断点恢复。 */
  async openExistingSearch(searchId: string, query = DEFAULT_QUERY): Promise<SearchState> {
    await this.page.goto(
      `https://www.bayt.com/en/employers/cv-search/listing/?searchId=${encodeURIComponent(searchId)}`,
      { waitUntil: "domcontentloaded" },
    );
    if (LOGIN_URL_PATTERN.test(this.page.url())) throw new LoginRequiredError();
    await this.waitForListing();
    return await this.readSearchState(query, false);
  }

  /** 按可见标题找到一个Filter折叠面板的标题、开关和内容节点。 */
  private async accordionFilterControl(label: string): Promise<{ title: Locator; toggle: Locator; content: Locator } | null> {
    const titles = this.page.locator("label.accordion-title");
    for (let index = 0; index < (await titles.count()); index += 1) {
      const title = titles.nth(index);
      if (normalizeSpace(await title.innerText().catch(() => "")) !== label) continue;
      const toggle = title.locator('xpath=preceding-sibling::input[contains(concat(" ", normalize-space(@class), " "), " accordion-toggle ")][1]');
      const content = title.locator('xpath=following-sibling::div[contains(concat(" ", normalize-space(@class), " "), " accordion-content ")][1]');
      if ((await toggle.count()) && (await content.count())) return { title, toggle, content };
    }
    return null;
  }

  /** 将Filter折叠面板调整到指定展开状态，并等待异步内容注入。 */
  private async setAccordionExpanded(control: { title: Locator; toggle: Locator; content: Locator }, expanded: boolean): Promise<void> {
    const current = await control.toggle.isChecked().catch(() => false);
    if (current !== expanded) {
      // Some leaf accordions sit inside a collapsed parent. A DOM click on their
      // label still toggles the associated input without needing to change the
      // parent filter state or rely on viewport visibility.
      await control.title.evaluate((element: HTMLElement) => element.click());
      await this.page.waitForTimeout(100);
      if ((await control.toggle.isChecked().catch(() => !expanded)) !== expanded) {
        throw new Error(`Accordion did not ${expanded ? "expand" : "collapse"}`);
      }
    }
    if (expanded) {
      // Bayt hydrates many Filter bodies only after the first expansion. The
      // shell opens immediately, but its form controls can arrive seconds later.
      await control.content.locator(":scope > *")
        .first()
        .waitFor({ state: "attached", timeout: 5_000 })
        .catch(() => undefined);
      // An already-hydrated node can remain attached briefly while Bayt clears
      // and replaces it. Give the replacement request time to settle before
      // reading control types and options.
      await this.page.waitForTimeout(1_000);
    }
  }

  /**
   * 在某个Filter内容中按去掉动态数量后的文本寻找选项标签。
   * 新搜索页的Filter内容可能先挂载空壳，再异步注入真实选项；在短时窗口内等待目标值，
   * 超时仍返回null并由上层安全停止，避免把官网结构变化误当成可继续执行。
   */
  private async findFilterOption(root: Locator, expectedLabel: string): Promise<Locator | null> {
    const deadline = Date.now() + 15_000;
    do {
      const labels = root.locator("label:not(.accordion-title)");
      const texts = await labels.allTextContents().catch(() => []);
      const index = texts.findIndex((text) => stripDynamicOptionCount(text) === expectedLabel);
      if (index >= 0) return labels.nth(index);
      if (Date.now() >= deadline) return null;
      await this.page.waitForTimeout(250);
    } while (true);
  }

  /** 回读选项关联的真实input状态；折叠面板中的隐藏文字不参与判断。 */
  private async filterOptionIsSelected(root: Locator, expectedLabel: string): Promise<boolean> {
    const option = await this.findFilterOption(root, expectedLabel);
    if (!option) return false;
    return await option.evaluate((label: HTMLLabelElement) => {
      const input = label.htmlFor
        ? document.getElementById(label.htmlFor)
        : label.querySelector("input");
      return input instanceof HTMLInputElement && input.checked;
    }).catch(() => false);
  }

  /** 展开排序弹层后选择目标项；目标已经是当前排序时不重复点击。 */
  private async applySortOption(sort: { key: string; label: string }): Promise<void> {
    const options = this.page.locator("a[data-sortid]");
    let option: Locator | null = null;
    for (let index = 0; index < (await options.count()); index += 1) {
      const candidate = options.nth(index);
      const rawKey = catalogKey((await candidate.getAttribute("data-sortid")) || normalizeSpace(await candidate.innerText().catch(() => "")));
      if (rawKey === sort.key) { option = candidate; break; }
    }
    if (!option) throw new SafetyStopError("filter_structure_changed", `Sort option control is missing: ${sort.label}`);
    if ((await option.getAttribute("disabled")) === "true" || (await option.getAttribute("aria-disabled")) === "true") return;
    if (!(await option.isVisible().catch(() => false))) {
      const owner = option.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " popover-owner ")][1]');
      const trigger = owner.locator("button:visible, span.has-pointer:visible").first();
      if (!(await trigger.count())) throw new SafetyStopError("filter_structure_changed", `Sort menu trigger is missing: ${sort.label}`);
      await trigger.click();
      await option.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    }
    if (!(await option.isVisible().catch(() => false))) throw new SafetyStopError("filter_structure_changed", `Sort option control is not visible: ${sort.label}`);
    await option.click();
    await this.waitForListing();
  }

  /** 观察一个叶子Filter的DOM，推断单选、多选、区间、搜索或不支持。 */
  private async readAccordionFilterDefinition(
    label: string,
    control: { title: Locator; toggle: Locator; content: Locator },
  ): Promise<DiscoveredFilterDefinition> {
    await this.setAccordionExpanded(control, true);
    const radios = control.content.locator('input[type="radio"]');
    const checkboxes = control.content.locator('input[type="checkbox"]:not(.accordion-toggle)');
    const rangeInputs = control.content.locator('input[type="number"], input[type="range"]');
    const searchInputs = control.content.locator('input[type="search"], input[type="text"]');
    const deadline = Date.now() + 15_000;
    let stableSignature = "";
    let stableSince = 0;
    do {
      const optionLabels = await control.content.locator("label:not(.accordion-title)").allTextContents().catch(() => []);
      // 数组链依次完成清洗、过滤、忽略大小写去重、生成键、排序。
      const normalizedOptions = optionLabels
        .map(stripDynamicOptionCount)
        .filter((value) => value && value.length <= 160 && !/^(?:all|apply|clear|cancel)$/i.test(value));
      const options = normalizedOptions
        .filter((value, optionIndex) => normalizedOptions.findIndex((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase()) === optionIndex)
        .map((value) => ({ key: catalogKey(value), label: value }))
        .filter((item) => item.key)
        .sort((left, right) => left.key.localeCompare(right.key));
      // 索引访问类型`T["field"]`复用接口中已有的联合类型，避免写两遍。
      let controlType: DiscoveredFilterDefinition["controlType"] = "unsupported";
      if (await radios.count()) controlType = "single";
      else if (await checkboxes.count()) controlType = "multi";
      else if ((await rangeInputs.count()) >= 1) controlType = "range";
      else if ((await searchInputs.count()) >= 1) controlType = "search";
      const supported = controlType === "range" || controlType === "search" || ((controlType === "single" || controlType === "multi") && options.length > 0);
      if (supported) {
        // Bayt can inject a usable-looking partial option list before the leaf
        // finishes hydrating. Require the same definition for a short stable
        // window so catalog versions do not drift between otherwise identical scans.
        const signature = JSON.stringify({ controlType, options });
        if (signature !== stableSignature) {
          stableSignature = signature;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 750) {
          return {
            key: catalogKey(label),
            label,
            controlType,
            supported: true,
            options,
            valueKind: controlType === "range" ? "number" : controlType === "search" ? "text" : undefined,
            reason: null,
          };
        }
      } else {
        stableSignature = "";
        stableSince = 0;
        const contentText = normalizeSpace(await control.content.innerText().catch(() => ""));
        // A non-empty custom control is genuinely unsupported. An empty shell
        // (or loading placeholder) is transient and gets the full hydration window.
        if (contentText && !/^(?:loading|please wait)(?:\.{3})?$/i.test(contentText)) {
          return {
            key: catalogKey(label), label, controlType: "unsupported", supported: false, options: [],
            reason: "The control or its options could not be identified reliably",
          };
        }
      }
      if (Date.now() >= deadline) {
        return {
          key: catalogKey(label), label, controlType: "unsupported", supported: false, options: [],
          reason: "The control or its options could not be identified reliably",
        };
      }
      await this.page.waitForTimeout(250);
    } while (true);
  }

  /** 动态扫描官网Filter和排序目录，扫描结束后恢复原折叠状态。 */
  async discoverFilterCatalog(options: { resetToCanonicalSearch?: boolean } = {}): Promise<DiscoveredFilterCatalog> {
    // Filter中的热门雇主、职位等选项会随当前搜索词变化。版本校验和目录同步
    // 必须先回到同一默认搜索，否则任务页的业务差异会被误判为官网结构变化。
    if (options.resetToCanonicalSearch || !isListingUrl(new URL(this.page.url()))) {
      await this.createSearch(DEFAULT_QUERY, false);
    }
    await this.waitForListing();
    const titles = this.page.locator("label.accordion-title");
    const initialStates = new Map<string, boolean>();
    const filters: DiscoveredFilterDefinition[] = [];
    try {
      // 遍历所有accordion标题，但跳过只用于分组导航的父级面板。
      for (let index = 0; index < (await titles.count()); index += 1) {
        const title = titles.nth(index);
        const label = normalizeSpace(await title.innerText().catch(() => ""));
        if (!label || label.length > 100 || /search tips/i.test(label)) continue;
        const control = await this.accordionFilterControl(label);
        if (!control) continue;
        const identity = (await control.toggle.getAttribute("id")) || `${index}:${label}`;
        initialStates.set(identity, await control.toggle.isChecked().catch(() => false));
        // Category accordions only contain other accordions. They are navigation
        // groups, not selectable Filter definitions.
        if (await control.content.locator("label.accordion-title").count()) continue;
        try {
          let definition = await this.readAccordionFilterDefinition(label, control);
          if (!definition.supported) {
            // A first-time expansion can occasionally return an empty body
            // while Bayt warms the Filter endpoint. Retry that leaf once at a
            // low rate before declaring it unsupported.
            await this.setAccordionExpanded(control, false);
            await this.page.waitForTimeout(1_000);
            definition = await this.readAccordionFilterDefinition(label, control);
          }
          if (definition.key) filters.push(definition);
        } catch {
          // 单项识别失败不会伪造选项，而是明确标记unsupported。
          const key = catalogKey(label);
          if (key) filters.push({ key, label, controlType: "unsupported", supported: false, options: [], reason: "The control could not be opened reliably" });
        }
      }
    } finally {
      // Restore every accordion to its pre-discovery state. This keeps catalog
      // synchronization read-only with respect to the active search conditions.
      for (let index = (await titles.count()) - 1; index >= 0; index -= 1) {
        const title = titles.nth(index);
        const label = normalizeSpace(await title.innerText().catch(() => ""));
        const control = label ? await this.accordionFilterControl(label) : null;
        if (!control) continue;
        const identity = (await control.toggle.getAttribute("id")) || `${index}:${label}`;
        const initial = initialStates.get(identity);
        if (initial !== undefined) await this.setAccordionExpanded(control, initial);
      }
    }
    // Filter之后独立读取排序链接的稳定data-sortid和展示名称。
    const sorts: Array<{ key: string; label: string }> = [];
    const sortLinks = this.page.locator("a[data-sortid]");
    for (let index = 0; index < (await sortLinks.count()); index += 1) {
      const link = sortLinks.nth(index);
      const label = normalizeSpace(await link.innerText().catch(() => ""));
      const sortId = normalizeSpace((await link.getAttribute("data-sortid")) || "");
      const key = catalogKey(sortId || label);
      if (key && label && !sorts.some((item) => item.key === key)) sorts.push({ key, label });
    }
    if (!filters.length) {
      await this.writeDiagnostic("filter-catalog-empty");
      throw new SafetyStopError("filter_structure_changed", "No stable Bayt Filter controls could be identified");
    }
    return { filters, sorts };
  }

  /** 按前端任务快照创建搜索、逐项应用Filter/排序，并验证选择结果出现在页面。 */
  async createSearchFromSpec(spec: BrowserSearchSpec, catalog: DiscoveredFilterCatalog): Promise<SearchState & { actualFilterLabels: string[] }> {
    const state = await this.createSearch(spec.keyword, false);
    const definitions = new Map(catalog.filters.map((item) => [item.key, item]));
    const actualFilterLabels: string[] = [];
    for (const selection of spec.filters) {
      const definition = definitions.get(selection.key);
      if (!definition?.supported) throw new SafetyStopError("filter_structure_changed", `Filter is no longer supported: ${selection.key}`);
      const control = await this.accordionFilterControl(definition.label);
      if (!control) throw new SafetyStopError("filter_structure_changed", `Filter control is missing: ${definition.label}`);
      await this.setAccordionExpanded(control, true);
      const root = control.content;
      // 不同控件类型使用不同输入方式，但都必须来自已同步白名单目录。
      if (definition.controlType === "single" || definition.controlType === "multi") {
        for (const optionKey of selection.optionKeys || []) {
          const option = definition.options.find((item) => item.key === optionKey);
          if (!option) throw new SafetyStopError("filter_structure_changed", `Filter option is missing: ${selection.key}/${optionKey}`);
          const target = await this.findFilterOption(root, option.label);
          if (!target) throw new SafetyStopError("filter_structure_changed", `Filter option control is missing: ${option.label}`);
          await target.evaluate((element: HTMLElement) => element.click());
          actualFilterLabels.push(`${definition.label}: ${option.label}`);
        }
      } else if (definition.controlType === "range") {
        const inputs = root.locator('input[type="number"]:visible, input[type="range"]:visible, input[type="text"]:visible');
        if (!(await inputs.count())) throw new SafetyStopError("filter_structure_changed", `Range inputs are missing: ${definition.label}`);
        if (selection.min !== undefined) await inputs.first().fill(String(selection.min));
        if (selection.max !== undefined) await inputs.nth(Math.min(1, (await inputs.count()) - 1)).fill(String(selection.max));
        actualFilterLabels.push(`${definition.label}: ${selection.min ?? "any"}-${selection.max ?? "any"}`);
      } else if (definition.controlType === "search") {
        const input = root.locator('input[type="search"]:visible, input[type="text"]:visible').first();
        if (!(await input.count()) || !selection.value) throw new SafetyStopError("filter_structure_changed", `Search input is missing: ${definition.label}`);
        await input.fill(selection.value);
        actualFilterLabels.push(`${definition.label}: ${selection.value}`);
      }
      const apply = root.locator("button:visible").filter({ hasText: /^Apply(?:\s*\(|$)/i }).first();
      if (await apply.count()) await apply.click(); else await this.setAccordionExpanded(control, false);
      await this.waitForListing();
    }
    // sortKey为空表示保留官网默认排序。
    if (spec.sortKey) {
      const sort = catalog.sorts.find((item) => item.key === spec.sortKey);
      if (!sort) throw new SafetyStopError("filter_structure_changed", `Sort option is missing: ${spec.sortKey}`);
      await this.applySortOption(sort);
    }
    const verified = await this.readSearchState(spec.keyword, false);
    const body = normalizeSpace(await this.page.locator("body").innerText());
    // 单选/多选按关联input的checked状态验证，避免折叠面板隐藏文字造成误报。
    for (const selection of spec.filters) {
      const definition = definitions.get(selection.key)!;
      if (definition.controlType === "single" || definition.controlType === "multi") {
        const control = await this.accordionFilterControl(definition.label);
        if (!control) throw new SafetyStopError("filter_structure_changed", `Filter control is missing during verification: ${definition.label}`);
        await this.setAccordionExpanded(control, true);
        for (const optionKey of selection.optionKeys || []) {
          const option = definition.options.find((item) => item.key === optionKey);
          const selected = option ? await this.filterOptionIsSelected(control.content, option.label) : false;
          if (!option || !selected) {
            await this.writeDiagnostic(`filter-verification-failed-${selection.key}-${optionKey}`);
            throw new SafetyStopError("filter_verification_failed", `Applied Filter option is not selected: ${selection.key}/${optionKey}`);
          }
        }
      } else {
        const value = definition.controlType === "range"
          ? `${selection.min ?? "any"}-${selection.max ?? "any"}`
          : selection.value || "";
        if (value && !body.toLocaleLowerCase().includes(value.toLocaleLowerCase())) {
          await this.writeDiagnostic(`filter-verification-failed-${selection.key}`);
          throw new SafetyStopError("filter_verification_failed", `Applied Filter value is not visible: ${selection.key}`);
        }
      }
    }
    return { ...verified, actualFilterLabels };
  }

  /** 旧流程的便捷方法：尝试选择“最近6个月更新”Filter。 */
  private async applyLastUpdatedFilter(): Promise<boolean> {
    const control = await this.accordionFilterControl("Last updated");
    if (!control) return false;
    await this.setAccordionExpanded(control, true);
    const sixMonths = await this.findFilterOption(control.content, "Within last 6 months");
    if (!sixMonths) {
      await this.setAccordionExpanded(control, false).catch(() => undefined);
      return false;
    }
    await sixMonths.evaluate((element: HTMLElement) => element.click());
    const applyButton = control.content.locator("button:visible").filter({ hasText: /^Apply\s*\(/ });
    if (!(await applyButton.count())) throw new Error("Last-updated filter Apply button not found");
    await applyButton.click();
    await this.waitForListing();
    return true;
  }

  /**
   * 检查工作页是否仍是指定搜索的可用列表页。
   * Bayt完成批量导出后偶尔会退回带searchId的搜索表单；仅看进程存活无法发现这种状态丢失。
   */
  private async currentListingIsReady(expectedSearchId?: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(this.page.url());
    } catch {
      return false;
    }
    if (!isListingUrl(url)) return false;
    if (expectedSearchId && url.searchParams.get("searchId") !== expectedSearchId) return false;
    if (!(await this.page.locator('input[name="p"]').count())) return false;
    return await this.page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]')]
        .some((element) => /^\d+$/.test(element.name)),
    ).catch(() => false);
  }

  /**
   * 通过页码输入框翻页，并等待目标页和候选人复选框同时出现。
   * 若导出后页面退回搜索表单，只允许用当前任务的searchId恢复一次，禁止创建另一个搜索后继续。
   */
  async goToPage(pageNo: number, expectedSearchId?: string): Promise<void> {
    if (!Number.isInteger(pageNo) || pageNo < 1) {
      throw new SafetyStopError("listing_navigation_failed", `Invalid listing page number: ${pageNo}`);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.safetyCheck();
      if (!(await this.currentListingIsReady(expectedSearchId))) {
        if (!expectedSearchId) {
          await this.writeDiagnostic(`listing-context-lost-page-${pageNo}`);
          throw new SafetyStopError("listing_context_lost", `Bayt listing context was lost before page ${pageNo}`);
        }
        process.stdout.write(`listing_context_recovery page=${pageNo} attempt=${attempt + 1}\n`);
        await this.writeDiagnostic(`listing-context-recovery-page-${pageNo}`);
        await this.openExistingSearch(expectedSearchId);
      }

      try {
        const pageInput = this.page.locator('input[name="p"]');
        await pageInput.waitFor({ state: "attached", timeout: 15_000 });
        const current = Number.parseInt((await pageInput.inputValue()) || "1", 10);
        if (current === pageNo && (await this.currentListingIsReady(expectedSearchId))) return;
        // Bayt may update the page-number input before replacing the AJAX result list.
        // Capture the old membership so the next page cannot be read while its old CVs remain visible.
        const previousIds = await this.page.evaluate(() =>
          [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]')]
            .map((element) => element.name)
            .filter((name) => /^\d+$/.test(name))
            .sort(),
        );
        await pageInput.fill(String(pageNo));
        await pageInput.press("Enter");
        // waitForFunction中的函数在浏览器页面环境执行，可以访问document。
        await this.page.waitForFunction(
          ({ selector, expected, searchId, previousIds }) => {
            const input = document.querySelector<HTMLInputElement>(selector);
            const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]')]
              .filter((element) => /^\d+$/.test(element.name));
            const ids = boxes.map((element) => element.name).sort();
            const currentUrl = new URL(window.location.href);
            return input?.value === String(expected)
              && boxes.length > 0
              && (ids.length !== previousIds.length || ids.some((id, index) => id !== previousIds[index]))
              && (!searchId || currentUrl.searchParams.get("searchId") === searchId);
          },
          { selector: 'input[name="p"]', expected: pageNo, searchId: expectedSearchId || null, previousIds },
          { timeout: 45_000 },
        );
        await this.safetyCheck();
        if (!(await this.currentListingIsReady(expectedSearchId))) {
          throw new Error("Bayt listing context changed after page navigation");
        }
        return;
      } catch (error) {
        await this.safetyCheck();
        if (attempt === 0 && expectedSearchId) {
          process.stdout.write(`listing_navigation_recovery page=${pageNo} attempt=2\n`);
          await this.writeDiagnostic(`listing-navigation-recovery-page-${pageNo}`);
          continue;
        }
        if (error instanceof SafetyStopError || error instanceof LoginRequiredError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new SafetyStopError("listing_navigation_failed", `Could not restore Bayt listing page ${pageNo}: ${message}`);
      }
    }
    throw new SafetyStopError("listing_navigation_failed", `Could not restore Bayt listing page ${pageNo}`);
  }

  /** 从当前列表页提取CV_ID、姓名、资料链接、更新时间和头像状态。 */
  async listCandidates(pageNo: number): Promise<ListingCandidate[]> {
    await this.waitForListing();
    // page.evaluate中的回调运行在网页内部；外部变量必须通过第二个参数传入。
    const values = await this.page.evaluate((currentPage) => {
      const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]')]
        .filter((element) => /^\d+$/.test(element.name));
      return boxes.map((box, index) => {
        const item = box.closest("li");
        const links = item ? [...item.querySelectorAll<HTMLAnchorElement>('a[href*="/cv-search/profile/"]')] : [];
        const link = links.find((candidate) => candidate.href) || null;
        const image = item?.querySelector<HTMLImageElement>("img") || null;
        const source = image?.currentSrc || image?.src || "";
        const updateElement = item
          ? [...item.querySelectorAll<HTMLElement>("[title]")].find((element) =>
              (element.getAttribute("title") || "").startsWith("Last CV update date :"),
            )
          : null;
        const updateTitle = updateElement?.getAttribute("title") || "";
        const name = (link?.innerText || "").replace(/\s+/g, " ").trim();
        return {
          cvId: box.name,
          name,
          profileUrl: link?.href || "",
          lastCvUpdate: updateTitle ? updateTitle.replace("Last CV update date :", "").trim() : null,
          // 嵌套三元表达式按URL特征区分真实头像、默认占位图和缺失。
          avatarStatus: source.includes("/images/uploads/user_photos/")
            ? "photo"
            : source.includes("/images/people/no-photo")
              ? "placeholder"
              : "missing",
          avatarUrl: source || null,
          listingText: (item?.innerText || "").replace(/\s+/g, " ").trim(),
          pageNo: currentPage,
          ordinal: index + 1,
        };
      });
    }, pageNo);
    const candidates = values as ListingCandidate[];
    if (!candidates.length) {
      await this.writeDiagnostic(`listing-empty-page-${pageNo}`);
      throw new Error(`No candidates found on page ${pageNo}`);
    }
    for (const candidate of candidates) {
      if (!candidate.profileUrl || !PROFILE_URL_PATTERN.test(candidate.profileUrl)) {
        throw new Error(`Candidate ${candidate.cvId} has no usable profile URL`);
      }
    }
    return candidates;
  }

  /** 选中指定CV_ID并执行整页Excel或PDF ZIP导出。 */
  async exportBulk(candidateIds: string[], format: BulkExportFormat): Promise<Download> {
    // 先清空旧选择，再逐个点击本批次复选框，避免混入上一批人员。
    await this.clearCandidateSelection();
    for (const cvId of candidateIds) {
      const checkbox = this.page.locator(`input[type="checkbox"][name="${cvId}"]`);
      if (!(await checkbox.count())) throw new Error(`Candidate selection control is missing for ${cvId}`);
      await checkbox.evaluate((element: HTMLInputElement) => {
        if (!element.checked) element.click();
      });
    }
    // 回读页面真实选中集合，不能只相信click没有报错。
    const selected = await this.page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]')]
        .filter((element) => /^\d+$/.test(element.name) && element.checked)
        .map((element) => element.name),
    );
    if (selected.length !== candidateIds.length) {
      throw new Error(`Selected ${selected.length} candidates, expected ${candidateIds.length}`);
    }

    const bulkControl = await this.findBulkDownloadControl();
    if (!bulkControl) {
      await this.writeDiagnostic("bulk-download-control-missing");
      throw new Error("Could not find the bulk Download CV control");
    }
    await bulkControl.evaluate((element: HTMLElement) => element.click());

    // 打开格式弹窗并先检查限频、购买、联系方式揭示等不安全提示。
    const dialog = this.page.locator('[role="dialog"]:visible, .modal:visible').last();
    try {
      await dialog.waitFor({ state: "visible", timeout: 7_000 });
    } catch {
      await this.writeDiagnostic("bulk-download-dialog-missing");
      throw new Error("Bulk download format dialog did not appear");
    }
    await this.assertDialogSafe(dialog);
    const optionPattern = format === "xls" ? /Microsoft Excel|XLS file format/i : /Adobe Acrobat|PDF file format/i;
    const option = dialog.locator("label:visible").filter({ hasText: optionPattern }).first();
    if (!(await option.count())) {
      await this.writeDiagnostic(`bulk-${format}-option-missing`);
      throw new Error(`Bulk ${format.toUpperCase()} option was not found`);
    }
    await option.evaluate((element: HTMLLabelElement) => element.click());
    const confirm = dialog.getByRole("button", { name: /^Download without revealing$/i });
    if ((await confirm.count()) !== 1) {
      await this.writeDiagnostic("bulk-export-confirm-missing");
      throw new SafetyStopError(
        "contact_reveal",
        "The explicit Download without revealing control was not available",
      );
    }
    return await this.captureAndDownloadBulkExport(confirm, format);
  }

  /** Excel导出的语义化包装，调用者不用重复传格式字符串。 */
  async exportExcel(candidateIds: string[]): Promise<Download> {
    return await this.exportBulk(candidateIds, "xls");
  }

  /** PDF ZIP导出的语义化包装。 */
  async exportPdfArchive(candidateIds: string[]): Promise<Download> {
    return await this.exportBulk(candidateIds, "pdf");
  }

  /** 打开单个候选人资料，下载标准PDF和可选原始附件，再关闭资料层。 */
  async collectCandidate(candidate: ListingCandidate): Promise<CandidateDownloadResult> {
    await this.openProfile(candidate);
    const profile = await this.extractProfile(candidate.cvId);

    const standardControl = this.visibleControls(/^Download CV$/i).last();
    if (!(await standardControl.count())) {
      await this.writeDiagnostic(`standard-download-missing-${candidate.cvId}`);
      throw new Error(`Standard Download CV control not found for ${candidate.cvId}`);
    }
    // 有的按钮直接触发下载，有的先弹确认框，因此先试直接下载再走安全确认。
    let standardDownload = await this.clickExpectDownload(standardControl, 8_000);
    if (!standardDownload) standardDownload = await this.confirmSafeDownload("standard_cv");
    if (!standardDownload) throw new Error(`Standard CV download did not start for ${candidate.cvId}`);

    let originalDownload: Download | null = null;
    let originalStatus: "downloaded" | "not_available" = "not_available";
    // 原始附件不是每个人都有；没有页签或按钮时明确返回not_available。
    const attachmentTab = this.page.getByText("CV attachment", { exact: true }).last();
    if (await attachmentTab.count()) {
      await attachmentTab.click();
      const originalControl = this.visibleControls(/^Download original CV attachment$/i).last();
      if (await originalControl.count()) {
        originalDownload = await this.clickExpectDownload(originalControl, 8_000);
        if (!originalDownload) originalDownload = await this.confirmSafeDownload("original_attachment");
        if (originalDownload) originalStatus = "downloaded";
      }
    }

    await this.closeProfile();
    return { profile, standardDownload, originalDownload, originalStatus };
  }

  /** 使用当前浏览器上下文的登录会话下载真实头像二进制。 */
  async downloadAvatar(url: string): Promise<{ buffer: Buffer; mimeType: string | null }> {
    const response = await this.context.request.get(url, {
      headers: { Referer: "https://www.bayt.com/" },
      timeout: 30_000,
    });
    if (!response.ok()) throw new Error(`Avatar request returned HTTP ${response.status()}`);
    return {
      buffer: Buffer.from(await response.body()),
      mimeType: response.headers()["content-type"]?.split(";")[0] || null,
    };
  }

  /** 在当前列表中精确定位候选人链接，并等待资料层出现对应CV Ref。 */
  private async openProfile(candidate: ListingCandidate): Promise<void> {
    const encodedUrl = candidate.profileUrl;
    const links = this.page.locator('a[href*="/cv-search/profile/"]');
    let matched: Locator | null = null;
    // 首选URL精确匹配；姓名只作为找不到URL时的后备定位方式。
    for (let index = 0; index < (await links.count()); index += 1) {
      const link = links.nth(index);
      const href = await link.getAttribute("href");
      if (!href) continue;
      const absolute = new URL(href, this.page.url()).href;
      if (absolute === encodedUrl) {
        matched = link;
        break;
      }
    }
    if (!matched && candidate.name) {
      const byName = links.filter({ hasText: candidate.name }).last();
      if (await byName.count()) matched = byName;
    }
    if (!matched) throw new Error(`Profile link not found for ${candidate.cvId}`);
    await matched.click();
    await this.page.getByText(new RegExp(`Ref:\\s*CV${candidate.cvId}\\b`, "i")).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await this.safetyCheck();
  }

  /** 从资料层隔离正文，并按固定标题切分为sections。 */
  private async extractProfile(cvId: string): Promise<ParsedProfile> {
    const text = await this.page.evaluate((expectedCvId) => {
      const all = [...document.querySelectorAll<HTMLElement>("body *")];
      const ref = all.find(
        (element) =>
          element.children.length === 0 &&
          new RegExp(`Ref:\\s*CV${expectedCvId}\\b`, "i").test(element.innerText || ""),
      );
      if (!ref) return "";
      // 从Ref元素向父级爬升，找到同时包含资料标签和下载控件的完整容器。
      let node: HTMLElement | null = ref;
      while (node?.parentElement) {
        const parentText = node.parentElement.innerText || "";
        if (
          parentText.includes("Download CV") &&
          parentText.includes("Profile") &&
          parentText.includes("CV attachment") &&
          parentText.length > 300
        ) {
          node = node.parentElement;
          break;
        }
        node = node.parentElement;
      }
      return (node?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    }, cvId);
    if (!text || !new RegExp(`Ref:\\s*CV${cvId}\\b`, "i").test(text)) {
      throw new Error(`Profile text for ${cvId} could not be isolated`);
    }
    // 对每个已知标题，正文范围从本标题之后到下一个标题之前。
    const sections: Record<string, string> = {};
    for (const heading of [
      "Target job",
      "Personal information",
      "Work experience",
      "Education",
      "Trainings and certifications",
      "Skills",
      "Languages",
    ]) {
      const start = text.indexOf(heading);
      if (start < 0) continue;
      const later = [
        "Target job",
        "Personal information",
        "Work experience",
        "Education",
        "Trainings and certifications",
        "Skills",
        "Languages",
      ]
        .map((candidate) => text.indexOf(candidate, start + heading.length))
        .filter((index) => index > start)
        .sort((a, b) => a - b)[0];
      sections[heading] = text.slice(start + heading.length, later || undefined).trim();
    }
    return { cvId, text, sections, viewedAt: nowIso() };
  }

  /** 优先用Escape关闭资料层，仍可见时再寻找明确Close按钮。 */
  private async closeProfile(): Promise<void> {
    await this.page.keyboard.press("Escape");
    await this.page.waitForTimeout(300);
    const ref = this.page.getByText(/Ref:\s*CV\d+/i);
    if (!(await ref.count()) || !(await ref.last().isVisible().catch(() => false))) return;
    const close = this.page.locator('[aria-label="Close"]:visible, button:visible').filter({
      hasText: /^Close$|^×$/,
    });
    if (await close.count()) await close.last().click();
  }

  /** 处理下载确认弹窗，但拒绝会揭示联系方式的按钮。 */
  private async confirmSafeDownload(kind: string): Promise<Download | null> {
    const dialog = this.page.locator('[role="dialog"]:visible, .modal:visible').last();
    if (!(await dialog.count())) return null;
    await this.assertDialogSafe(dialog);
    const withoutReveal = dialog.getByRole("button", { name: /^Download without revealing$/i });
    // 首选语义最安全的“Download without revealing”，普通确认按钮只是后备。
    const confirm = (await withoutReveal.count())
      ? withoutReveal
      : dialog.locator("button:visible,a:visible").filter({
          hasText: /^(Download|Continue|Confirm|Yes)$/i,
        }).first();
    if (!(await confirm.count())) return null;
    if (/reveal|unlock contact/i.test(normalizeSpace(await confirm.innerText()))) {
      throw new SafetyStopError("contact_reveal", "Download confirmation would reveal contact information");
    }
    const download = await this.clickExpectDownload(confirm, 30_000);
    if (!download) await this.writeDiagnostic(`download-confirm-no-file-${kind}`);
    return download;
  }

  /** 检查弹窗文字，发现限频、购买或联系方式揭示立即安全停止。 */
  private async assertDialogSafe(dialog: Locator): Promise<void> {
    const text = normalizeSpace(await dialog.innerText());
    if (RATE_LIMIT_PATTERN.test(text)) {
      throw new SafetyStopError("rate_limited", "Bayt reported unusually high account search activity");
    }
    if (/buy|purchase|upgrade|payment|credit card|pricing/i.test(text)) {
      throw new SafetyStopError("purchase_required", `Download requires a purchase: ${text.slice(0, 300)}`);
    }
    if (/reveal contact|contact information.*reveal|unlock contact/i.test(text)) {
      throw new SafetyStopError("contact_reveal", "Download flow attempted to reveal contact information");
    }
  }

  /** 先监听download事件再点击，避免下载触发太快而错过事件。 */
  private async clickExpectDownload(locator: Locator, timeoutMs: number): Promise<Download | null> {
    const downloadPromise = this.page.waitForEvent("download", { timeout: timeoutMs }).catch(() => null);
    await locator.click();
    return await downloadPromise;
  }

  /**
   * 捕获一次UI触发的批量下载请求。
   * `let resolveCapture!`中的`!`是确定赋值断言：构造Promise时会立刻给它赋值。
   */
  private async captureBulkDownloadRequest(locator: Locator): Promise<CapturedBulkDownloadRequest> {
    const routePattern = "**/v6/searchCv/*/downloadCV/**";
    let resolveCapture!: (value: CapturedBulkDownloadRequest) => void;
    let rejectCapture!: (error: unknown) => void;
    const captured = new Promise<CapturedBulkDownloadRequest>((resolve, reject) => {
      resolveCapture = resolve;
      rejectCapture = reject;
    });
    // route处理器读取请求后中止UI原请求，避免同一点击产生两份下载。
    const handler = async (route: Route) => {
      try {
        const request = route.request();
        resolveCapture({
          url: request.url(),
          method: request.method(),
          headers: await request.allHeaders(),
          postData: request.postData(),
        });
        // Abort the UI-issued copy, then execute exactly one verified copy in
        // the same browser session so the response becomes a browser download.
        await route.abort("aborted");
      } catch (error) {
        rejectCapture(error);
        await route.abort("failed").catch(() => undefined);
      }
    };
    await this.page.route(routePattern, handler);
    let timeout: NodeJS.Timeout | null = null;
    let monitorStopped = false;
    // 后台轮询页面弹窗；Promise<never>表示只会抛错，不会正常产生结果。
    const dialogSafety = (async (): Promise<never> => {
      while (!monitorStopped) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (monitorStopped) break;
        const messages = await this.page.locator('[role="dialog"]:visible, .modal:visible, [role="alert"]:visible')
          .allInnerTexts()
          .catch(() => []);
        const text = normalizeSpace(messages.join(" "));
        if (RATE_LIMIT_PATTERN.test(text)) {
          throw new SafetyStopError("rate_limited", "Bayt reported unusually high account search activity");
        }
        if (/buy|purchase|upgrade|payment|credit card|pricing|reveal contact|unlock contact/i.test(text)) {
          throw new SafetyStopError("purchase_or_contact_reveal", "Bayt displayed an unsafe download confirmation");
        }
      }
      return await new Promise<never>(() => undefined);
    })();
    let rejectHttpSafety!: (error: unknown) => void;
    // 与页面文案并行监听401/403/429网络响应。
    const httpSafety = new Promise<never>((_resolve, reject) => { rejectHttpSafety = reject; });
    /** 只监听Bayt简历搜索API的鉴权或限流状态，忽略广告等无关资源的429。 */
    const responseHandler = (response: Response) => {
      const safety = classifyBulkExportSafetyResponse(response.url(), response.status());
      if (!safety) return;
      rejectHttpSafety(new SafetyStopError(
        safety.reason,
        `Bayt returned HTTP ${response.status()} from ${safety.route} during bulk export`,
      ));
    };
    this.page.on("response", responseHandler);
    try {
      await locator.evaluate((element: HTMLElement) => element.click());
      // Promise.race返回最先完成的一项：捕获成功、安全错误或超时。
      return await Promise.race([
        captured,
        dialogSafety,
        httpSafety,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Bulk download request capture timed out")), 60_000);
        }),
      ]);
    } finally {
      // 无论哪个分支先结束，都移除监听和路由，避免影响后续页面请求。
      monitorStopped = true;
      if (timeout) clearTimeout(timeout);
      this.page.off("response", responseHandler);
      await this.page.unroute(routePattern, handler).catch(() => undefined);
    }
  }

  /**
   * 在同一浏览器页面上下文中重放刚捕获的下载请求，并把响应转成浏览器Download。
   * 只保留下载所需头部；Cookie由`credentials: include`使用当前页面会话提供。
   */
  private async replayBulkDownloadRequest(request: CapturedBulkDownloadRequest, format: BulkExportFormat): Promise<Download> {
    const allowedHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLocaleLowerCase();
      if (["accept", "content-type", "x-requested-with"].includes(lower) || /token|csrf|action|authorization/.test(lower)) {
        allowedHeaders[name] = value;
      }
    }
    const downloadPromise = this.page.waitForEvent("download", { timeout: 60_000 });
    // 下面回调运行在网页中，因此可以使用该页面的登录态发fetch。
    const result = await this.page.evaluate(async (input) => {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.postData || undefined,
        credentials: "include",
        redirect: "follow",
      });
      const contentType = response.headers.get("content-type") || "";
      const disposition = response.headers.get("content-disposition") || "";
      if (!response.ok || [401, 403, 429].includes(response.status)) {
        return { ok: false, status: response.status, contentType, bytes: 0 };
      }
      // arrayBuffer读取二进制；HTML/JSON通常代表错误页，不能伪装成文件。
      const content = await response.arrayBuffer();
      if (!content.byteLength || /text\/html|application\/json/i.test(contentType)) {
        return { ok: false, status: response.status, contentType, bytes: content.byteLength };
      }
      const utf = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      const plain = disposition.match(/filename="?([^";]+)"?/i);
      let filename = input.format === "xls" ? "bayt-50-cvs.xls" : "bayt-50-cvs.zip";
      if (utf) {
        try { filename = decodeURIComponent(utf[1]); } catch { /* Keep safe fallback. */ }
      } else if (plain) {
        filename = plain[1];
      }
      const required = input.format === "xls" ? /\.xls$/i : /\.zip$/i;
      if (!required.test(filename)) filename = input.format === "xls" ? "bayt-50-cvs.xls" : "bayt-50-cvs.zip";
      // 创建临时Blob链接并点击隐藏a标签，让Playwright收到标准download事件。
      const blob = new Blob([content], { type: contentType || "application/octet-stream" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = filename;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
      return { ok: true, status: response.status, contentType, bytes: content.byteLength };
    }, {
      url: request.url,
      method: request.method,
      headers: allowedHeaders,
      postData: request.postData,
      format,
    });
    if (!result.ok) {
      void downloadPromise.catch(() => undefined);
      if ([401, 403, 429].includes(result.status)) {
        throw new SafetyStopError(`bayt_${result.status}`, `Bayt bulk download returned HTTP ${result.status}`);
      }
      throw new Error(`Bayt bulk download returned an invalid response: HTTP ${result.status}, ${result.contentType || "unknown content type"}, ${result.bytes} bytes`);
    }
    const download = await downloadPromise;
    const failure = await download.failure();
    if (failure) throw new Error(`Bulk ${format.toUpperCase()} browser download failed: ${failure}`);
    return download;
  }

  /** 串联“捕获UI请求”和“同会话下载”两个步骤。 */
  private async captureAndDownloadBulkExport(locator: Locator, format: BulkExportFormat): Promise<Download> {
    const request = await this.captureBulkDownloadRequest(locator);
    return await this.replayBulkDownloadRequest(request, format);
  }

  /** 返回当前可见按钮/链接中包含指定文字的Locator。 */
  private visibleControls(pattern: RegExp): Locator {
    return this.page.locator("button:visible,a:visible").filter({ hasText: pattern });
  }

  /** 按优先级寻找顶部批量下载控件，并处理操作栏延迟渲染。 */
  private async findBulkDownloadControl(): Promise<Locator | null> {
    const icon = this.page.locator('#bulkActionsBar i[data-text^="download"]:visible').first();
    const current = this.page.locator("#bulkActionsBar a:visible").filter({ hasText: /^Download CV$/i });
    // The action bar re-renders after the last checkbox change. The 50 checked
    // inputs are observable before its links become actionable, so wait for the
    // exact standard-CV control instead of treating that render gap as missing.
    await Promise.race([
      icon.waitFor({ state: "visible", timeout: 7_000 }),
      current.first().waitFor({ state: "visible", timeout: 7_000 }),
    ]).catch(() => undefined);
    if (await icon.isVisible().catch(() => false)) return icon.locator("xpath=parent::a");
    if ((await current.count()) === 1) return current;
    // 官网文案可能变化，因此后备匹配多个已知安全名称；多项时取候选列表上方的控件。
    for (const pattern of [/^Download CVs$/i, /^Export CVs$/i, /^Download selected/i, /^Export$/i]) {
      const locator = this.visibleControls(pattern);
      if ((await locator.count()) === 1) return locator;
      if ((await locator.count()) > 1) {
        const candidateTop = await this.numericCvCheckboxes().first().boundingBox();
        if (candidateTop) {
          for (let index = 0; index < (await locator.count()); index += 1) {
            const item = locator.nth(index);
            const box = await item.boundingBox();
            if (box && box.y < candidateTop.y) return item;
          }
        }
      }
    }
    return null;
  }

  /** 在Saved Search页按关键词寻找刚创建的最近搜索按钮。 */
  private async findRecentSearchControl(query: string): Promise<Locator | null> {
    const buttons = this.page.locator("button:visible");
    for (let index = 0; index < (await buttons.count()); index += 1) {
      const button = buttons.nth(index);
      const text = normalizeSpace(await button.innerText().catch(() => ""));
      if (text === query || text.startsWith(`${query} (`) || text.startsWith(`${query} +`)) return button;
    }
    return null;
  }

  /** 返回带name属性的候选人复选框集合，调用方还会验证name必须是数字。 */
  private numericCvCheckboxes(): Locator {
    return this.page.locator('input[type="checkbox"][name]');
  }

  /** 取消当前页所有已选候选人，确保下一批选择从干净状态开始。 */
  private async clearCandidateSelection(): Promise<void> {
    const selected = await this.page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]')]
        .filter((element) => /^\d+$/.test(element.name) && element.checked)
        .map((element) => element.name),
    );
    for (const cvId of selected) {
      // Bayt会把已选中的列表项移出可视区域；Locator.uncheck要求元素可见，
      // 因此在页面上下文触发原生click，同时仍让站点自己的事件处理器更新状态。
      const box = this.page.locator(`input[type="checkbox"][name="${cvId}"]`);
      if (!(await box.count())) throw new Error(`Selected candidate control disappeared for ${cvId}`);
      await box.evaluate((element: HTMLInputElement) => {
        if (element.checked) element.click();
      });
    }
    const remaining = await this.page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]')]
        .filter((element) => /^\d+$/.test(element.name) && element.checked)
        .map((element) => element.name),
    );
    if (remaining.length) {
      throw new Error(`Could not clear ${remaining.length} selected candidates`);
    }
  }

  /** 等待URL进入列表页并至少出现一个数字CV_ID复选框。 */
  private async waitForListing(): Promise<void> {
    await this.page.waitForURL(isListingUrl, {
      timeout: 45_000,
      waitUntil: "commit",
    });
    await this.page.waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]')].some(
          (element) => /^\d+$/.test(element.name),
        ),
      undefined,
      { timeout: 45_000 },
    );
    await this.safetyCheck();
  }

  /** 每个关键动作前后的统一安全门：登录失效、验证码或限频立即抛专用异常。 */
  private async safetyCheck(): Promise<void> {
    if (LOGIN_URL_PATTERN.test(this.page.url())) throw new LoginRequiredError();
    await this.assertNoCaptchaOrRateLimit();
  }

  /** 登录页也要检查挑战文案，但不能因为URL本身是登录页而提前返回。 */
  private async assertNoCaptchaOrRateLimit(): Promise<void> {
    const text = normalizeSpace(await this.page.locator("body").innerText().catch(() => ""));
    if (
      /captcha|verify you are human|unusually high search activity|try again in a few minutes|unusual traffic|too many requests|rate.?limit|sorry, you have been blocked|attention required.*cloudflare/i.test(
        text,
      )
    ) {
      throw new SafetyStopError("captcha_or_rate_limit", "Bayt displayed a CAPTCHA or rate-limit page");
    }
  }

  /** 保存当前页面截图和HTML，帮助定位UI变化；文件权限限制为当前用户。 */
  async writeDiagnostic(label: string): Promise<void> {
    await fsp.mkdir(DIAGNOSTICS_DIR, { recursive: true, mode: 0o700 });
    const safe = label.replace(/[^a-z0-9_-]+/gi, "_");
    const prefix = path.join(DIAGNOSTICS_DIR, `${Date.now()}-${safe}`);
    // 截图和HTML并行保存；单项失败不会覆盖原始业务异常。
    await Promise.all([
      this.page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => undefined),
      this.page.content().then((html) => fsp.writeFile(`${prefix}.html`, html, { mode: 0o600 })).catch(() => undefined),
    ]);
  }

  /**
   * 硬性看门狗触发后关闭Agent自己的工作页，以中断仍未结束的浏览器动作。
   * CDP连接的其他用户标签页和官方Chrome进程不会被关闭。
   */
  async abortCurrentOperation(label: string): Promise<void> {
    await this.writeDiagnostic(label).catch(() => undefined);
    await this.page.close({ runBeforeUnload: false }).catch(() => undefined);
  }
}
