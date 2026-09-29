/**
 * Windows常驻Agent：主动连接控制面、领取一个串行任务、控制本机Chrome、验收并上传。
 * 重要边界：Bayt登录Cookie留在Windows；控制面只收到任务进度、哈希和已完成文件。
 */
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BaytBrowser, LoginRequiredError, SafetyStopError, type BrowserSearchSpec, type DiscoveredFilterCatalog } from "./bayt.ts";
import { verifyBulkBatch, writeBulkManifest, type BulkBatchManifest } from "./bulk-batch.ts";
import {
  ALLOW_INSECURE_CONTROL_PLANE, CONTROL_PLANE_TOKEN, CONTROL_PLANE_URL, EXPORT_INTERVAL_MAX_MS, EXPORT_INTERVAL_MIN_MS,
  PAGE_INTERVAL_MAX_MS, PAGE_INTERVAL_MIN_MS, WINDOWS_AGENT_ID, WINDOWS_AGENT_NAME,
  WINDOWS_CDP_ENDPOINT, WINDOWS_DATA_ROOT, WINDOWS_LOGIN_CHECK_INTERVAL_MS,
} from "./config.ts";
import { saveDownload, sha256File } from "./files.ts";
import { assertExcelMapping, parseExcelExport } from "./excel.ts";
import { uploadBatchAtomically, type SftpUploadConfig } from "./sftp-upload.ts";
import type { DownloadedFile } from "./types.ts";

// 前端任务可以按目标人数、最大页数或持续时长结束；服务端保证至少提供一种模式。
interface AgentLimits { targetCount?: number; maxPages?: number; durationHours?: number }

/** 控制面下发给Agent的不可变任务快照和已有页级检查点。 */
interface AgentJob {
  id: string;
  name: string;
  searchSpec: BrowserSearchSpec;
  limits: AgentLimits;
  status: string;
  currentPage: number;
  completedPages: number;
  exportedCount: number;
  pauseRequested: boolean;
  searchId: string | null;
  matchedCount: number | null;
  actualFilterLabels: string[];
  startedAt: string | null;
  pages: Array<{ page: number; cvIdSetSha256: string }>;
}

// 三种短小接口描述控制面响应；extends表示ServerCatalog继承目录字段并增加version。
interface ClaimResult { job: AgentJob | null; leaseToken?: string; waitReason?: string; waitUntil?: string }
/** Filter目录同步领取结果；null表示当前没有同步任务。 */
interface CatalogSyncClaim { request: { id: string } | null }
/** Windows识别的目录提交给控制面后，由服务端补充稳定版本号。 */
interface ServerCatalog extends DiscoveredFilterCatalog { version: string }

// 安全停止时写本地标记，防止进程重启后未经人工核实就继续。
const LOCAL_SAFETY_MARKER = path.join(WINDOWS_DATA_ROOT, "agent-state", "safety-stop.json");
const ACTIVE_BROWSER_STAGE_TIMEOUT_MS = 15 * 60 * 1000;
const PAGE_NAVIGATION_TIMEOUT_MS = 3 * 60 * 1000;
const LOCAL_VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;
const SFTP_STAGE_TIMEOUT_MS = 12 * 60 * 1000;
const CONTROL_STAGE_TIMEOUT_MS = 2 * 60 * 1000;

/** 携带HTTP状态和业务错误码的控制面异常。 */
class ControlPlaneError extends Error {
  status: number;
  code: string;
  /** 除普通错误消息外，同时保存HTTP状态和服务端业务码。 */
  constructor(message: string, status: number, code: string) {
    super(message); this.status = status; this.code = code;
  }
}

/** 对控制面 Agent API的轻量客户端封装。 */
class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly token: string;

  /** 保存基础URL和Bearer令牌；private字段只能在类内部访问。 */
  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  /**
   * 统一发送POST请求并解析JSON。
   * `<T>`是泛型：调用者可指定期望的返回类型；`...body`把对象字段展开到请求体。
   */
  async request<T>(route: string, body: Record<string, unknown>, leaseToken?: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v1/collector/agent${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(leaseToken ? { "X-Collector-Lease": leaseToken } : {}),
      },
      body: JSON.stringify({ agentId: WINDOWS_AGENT_ID, ...body }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => null) as T & { error?: { code?: string; message?: string } };
    if (!response.ok) throw new ControlPlaneError(payload?.error?.message || `Control plane returned HTTP ${response.status}`, response.status, payload?.error?.code || "CONTROL_PLANE_REQUEST_FAILED");
    return payload as T;
  }

  // 以下方法只是为各API路径起清晰名字，最终都复用request。
  heartbeat(input: { currentJobId: string | null; chromeReady: boolean; loginState: string }): Promise<unknown> {
    return this.request("/heartbeat", { name: WINDOWS_AGENT_NAME, version: "1.0.0", ...input });
  }
  /** 尝试领取一个Filter目录同步请求。 */
  claimCatalogSync(): Promise<CatalogSyncClaim> { return this.request("/filter-catalog/claim", {}); }
  /** 提交成功识别的Filter目录。 */
  completeCatalogSync(requestId: string, catalog: DiscoveredFilterCatalog): Promise<ServerCatalog> { return this.request("/filter-catalog/complete", { requestId, catalog }); }
  /** 回报Filter同步失败，避免请求永远卡在运行中。 */
  failCatalogSync(requestId: string, message: string): Promise<unknown> { return this.request("/filter-catalog/fail", { requestId, message }); }
  /** 从全局串行队列领取一项任务和短期租约。 */
  claimJob(): Promise<ClaimResult> { return this.request("/jobs/claim", {}); }
  /** 为运行任务续租，并上报搜索证据。 */
  heartbeatJob(jobId: string, leaseToken: string, evidence: Record<string, unknown>): Promise<AgentJob> { return this.request(`/jobs/${encodeURIComponent(jobId)}/heartbeat`, { evidence }, leaseToken); }
  /** 提交一页已经验收并上传完成的检查点。 */
  checkpoint(jobId: string, leaseToken: string, input: Record<string, unknown>): Promise<AgentJob> { return this.request(`/jobs/${encodeURIComponent(jobId)}/checkpoints`, input, leaseToken); }
  /** 通知控制面整个任务已经完成。 */
  complete(jobId: string, leaseToken: string): Promise<AgentJob> { return this.request(`/jobs/${encodeURIComponent(jobId)}/complete`, {}, leaseToken); }
  /** 确认已在安全位置执行管理员暂停请求。 */
  pauseAck(jobId: string, leaseToken: string): Promise<AgentJob> { return this.request(`/jobs/${encodeURIComponent(jobId)}/pause-ack`, {}, leaseToken); }
  /** 上报不能自动恢复的安全停止原因。 */
  safetyStop(jobId: string, leaseToken: string, code: string, message: string): Promise<AgentJob> { return this.request(`/jobs/${encodeURIComponent(jobId)}/safety-stop`, { code, message }, leaseToken); }
}

/** 在闭区间内生成随机毫秒数，用于低频抖动间隔。 */
function randomDelay(minimum: number, maximum: number): number {
  if (maximum <= minimum) return minimum;
  return crypto.randomInt(minimum, maximum + 1);
}

/** 分段等待，每30秒执行一次暂停、心跳等运行守卫。 */
async function waitWithGuard(milliseconds: number, guard: () => void): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    guard();
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, deadline - Date.now())));
  }
  guard();
}

/**
 * 给单个活动阶段增加硬性截止时间。计划中的15-20分钟格式间隔和60-70分钟页间隔不走此计时器。
 */
async function withStageWatchdog<T>(
  phase: string,
  pageNo: number | null,
  timeoutMs: number,
  operation: () => Promise<T>,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void onTimeout();
          reject(new SafetyStopError(
            "job_stage_timeout",
            `Collector phase ${phase} timed out after ${timeoutMs}ms${pageNo === null ? "" : ` on page ${pageNo}`}`,
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 对Filter和排序目录生成版本号；官网结构变化后版本也随之变化。 */
export function filterCatalogVersion(catalog: DiscoveredFilterCatalog): string {
  const signature = JSON.stringify({ filters: catalog.filters, sorts: catalog.sorts });
  return `bayt-${crypto.createHash("sha256").update(signature).digest("hex").slice(0, 16)}`;
}

export type FilterCatalogVersionDecision =
  | { action: "accept_first"; version: string }
  | { action: "rescan"; version: string }
  | { action: "accept_second"; version: string }
  | { action: "structure_changed"; version: string }
  | { action: "unstable"; version: string };

/**
 * 对目录扫描版本做保守的二次确认。
 * 首次匹配直接使用；首次不匹配要求复扫；只有连续两次得到同一新版本才认定官网结构变化。
 */
export function decideFilterCatalogVersion(
  expectedVersion: string,
  firstVersion: string,
  secondVersion?: string,
): FilterCatalogVersionDecision {
  if (firstVersion === expectedVersion) return { action: "accept_first", version: firstVersion };
  if (secondVersion === undefined) return { action: "rescan", version: firstVersion };
  if (secondVersion === expectedVersion) return { action: "accept_second", version: secondVersion };
  if (secondVersion === firstVersion) return { action: "structure_changed", version: secondVersion };
  return { action: "unstable", version: secondVersion };
}

/** 从环境变量组装SFTP配置；缺少必填项立即失败，不猜默认凭据。 */
function sftpConfigFromEnvironment(): SftpUploadConfig {
  // 嵌套函数required只在当前函数内使用。
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Missing required Windows Agent setting: ${name}`);
    return value;
  };
  return {
    executable: process.env.BAYT_SFTP_EXECUTABLE || "sftp.exe",
    host: required("BAYT_SFTP_HOST"),
    port: Number(process.env.BAYT_SFTP_PORT || 22),
    user: required("BAYT_SFTP_USER"),
    identityFile: required("BAYT_SFTP_IDENTITY_FILE"),
    knownHostsFile: required("BAYT_SFTP_KNOWN_HOSTS_FILE"),
    remoteRoot: process.env.BAYT_SFTP_REMOTE_ROOT || "/incoming",
  };
}

/** 验证控制面传输；公网HTTP必须由运维显式确认，避免误配置时静默明文发送令牌。 */
export function assertControlPlaneTransport(controlPlaneUrl: string, allowInsecure: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(controlPlaneUrl);
  } catch {
    throw new Error("BAYT_CONTROL_PLANE_URL must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && allowInsecure) return;
  if (parsed.protocol === "http:") {
    throw new Error("HTTP control plane requires BAYT_ALLOW_INSECURE_CONTROL_PLANE=1");
  }
  throw new Error("BAYT_CONTROL_PLANE_URL must use HTTP or HTTPS");
}

/** 启动前验证控制面、令牌长度和CDP只能指向本机回环地址。 */
function validateSettings(): void {
  assertControlPlaneTransport(CONTROL_PLANE_URL, ALLOW_INSECURE_CONTROL_PLANE);
  if (CONTROL_PLANE_TOKEN.length < 32) throw new Error("BAYT_CONTROL_PLANE_TOKEN must contain at least 32 characters");
  if (!/^https?:\/\/127\.0\.0\.1:\d+$/.test(WINDOWS_CDP_ENDPOINT)) throw new Error("BAYT_WINDOWS_CDP_ENDPOINT must be a local loopback CDP endpoint");
}

/** 任一结束条件达到即返回true。Boolean(...)把结果明确转换成布尔值。 */
export function jobFinished(job: AgentJob, exportedCount: number, completedPages: number, now = Date.now()): boolean {
  const durationFinished = Boolean(
    job.limits.durationHours &&
    job.startedAt &&
    Number.isFinite(Date.parse(job.startedAt)) &&
    now >= Date.parse(job.startedAt) + job.limits.durationHours * 60 * 60 * 1000,
  );
  return Boolean(
    (job.limits.targetCount && exportedCount >= job.limits.targetCount) ||
    (job.limits.maxPages && completedPages >= job.limits.maxPages) ||
    durationFinished,
  );
}

function durationDeadline(job: AgentJob): number | null {
  if (!job.limits.durationHours || !job.startedAt) return null;
  const startedAt = Date.parse(job.startedAt);
  return Number.isFinite(startedAt) ? startedAt + job.limits.durationHours * 60 * 60 * 1000 : null;
}

/** 只把短暂网络故障归类为普通错误；401/403/429和验证码明确排除。 */
function isOrdinaryNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|fetch failed|socket|econnreset|econnaborted|enotfound|temporary|network changed|net::err_/i.test(message) && !/401|403|429|captcha|cloudflare/i.test(message);
}

/** 判断Agent主循环错误是否允许退避后重连控制面。 */
export function isRetryableAgentLoopError(error: unknown): boolean {
  if (error instanceof ControlPlaneError) return error.status === 408 || error.status === 425 || error.status >= 500;
  return isOrdinaryNetworkError(error);
}

/** 指数退避：失败次数越多等待越久，上限10分钟。`**`是乘方运算符。 */
export function agentRetryDelay(failureCount: number): number {
  return Math.min(10 * 60 * 1000, 30_000 * (2 ** Math.max(0, Math.min(5, failureCount - 1))));
}

/** 普通网络错误最多等待10分钟、30分钟重试；安全类错误直接抛出。 */
async function withNetworkRetry<T>(operation: () => Promise<T>): Promise<T> {
  const delays = [10 * 60 * 1000, 30 * 60 * 1000];
  // 中间条件留空的for是无限循环，只能通过return或throw退出。
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isOrdinaryNetworkError(error) || attempt >= delays.length) throw error;
      process.stdout.write(`ordinary_network_retry attempt=${attempt + 1} waitMs=${delays[attempt]}\n`);
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** 安全停止上报使用较短退避；只有控制面明确确认后才删除本地安全标记。 */
async function reportSafetyStop(
  client: ControlPlaneClient,
  jobId: string,
  leaseToken: string,
  code: string,
  message: string,
): Promise<void> {
  const delays = [0, 5_000, 15_000];
  let lastError: unknown = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    try {
      await client.safetyStop(jobId, leaseToken, code, message);
      process.stderr.write(`job_safety_stop_reported jobId=${jobId} code=${code} attempt=${attempt + 1}\n`);
      return;
    } catch (error) {
      lastError = error;
      process.stderr.write(`job_safety_stop_retry jobId=${jobId} code=${code} attempt=${attempt + 1}\n`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not report collector safety stop");
}

/** 从已完成页面的本地Excel重建CV_ID集合，确保恢复依据真实文件。 */
async function loadCompletedCvIds(job: AgentJob): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const page of job.pages) {
    const filePath = path.join(WINDOWS_DATA_ROOT, "runs", job.id, "batches", String(page.page).padStart(4, "0"), "source.xls");
    try {
      for (const candidate of await parseExcelExport(filePath)) ids.add(candidate.cvId);
    } catch {
      // 已完成页的本地证据缺失时不能盲目继续，否则可能重复采集。
      throw new SafetyStopError("checkpoint_file_missing", `Completed page ${page.page} cannot be reconstructed from local XLS`);
    }
  }
  return ids;
}

/** 读取已落盘的半页导出；存在但为空/类型不对时停止，而不是覆盖后重试。 */
async function existingDownload(filePath: string, extension: string): Promise<DownloadedFile | null> {
  try {
    const info = await fsp.stat(filePath);
    if (!info.isFile() || info.size <= 0) {
      throw new SafetyStopError("partial_export_invalid", `Existing partial export is empty or not a file: ${path.basename(filePath)}`);
    }
    return {
      path: filePath,
      originalName: path.basename(filePath),
      mimeType: null,
      extension,
      sha256: await sha256File(filePath),
      sizeBytes: info.size,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 由当前白名单目录重建应有的Filter证据，用于确认断点搜索仍属于同一任务。 */
function expectedFilterLabels(spec: BrowserSearchSpec, catalog: DiscoveredFilterCatalog): string[] {
  const definitions = new Map(catalog.filters.map((item) => [item.key, item]));
  return spec.filters.flatMap((selection) => {
    const definition = definitions.get(selection.key);
    if (!definition?.supported) throw new SafetyStopError("partial_search_mismatch", `Filter is unavailable during partial resume: ${selection.key}`);
    if (definition.controlType === "single" || definition.controlType === "multi") {
      return (selection.optionKeys || []).map((optionKey) => {
        const option = definition.options.find((item) => item.key === optionKey);
        if (!option) throw new SafetyStopError("partial_search_mismatch", `Filter option is unavailable during partial resume: ${selection.key}/${optionKey}`);
        return `${definition.label}: ${option.label}`;
      });
    }
    const value = definition.controlType === "range"
      ? `${selection.min ?? "any"}-${selection.max ?? "any"}`
      : selection.value || "";
    return [`${definition.label}: ${value}`];
  });
}

/** 已存在的Excel必须与当前页精确对应，验证失败时禁止再次点击Bayt导出。 */
async function validateReusableExcel(filePath: string, expectedCvIds: string[]): Promise<void> {
  const rows = await parseExcelExport(filePath);
  const mapping = assertExcelMapping(rows, expectedCvIds);
  if (rows.length !== expectedCvIds.length || mapping.missing.length || mapping.unexpected.length) {
    throw new SafetyStopError(
      "partial_export_mismatch",
      `Existing Excel does not match the resumed page; rows=${rows.length}; expected=${expectedCvIds.length}; missing=${mapping.missing.length}; unexpected=${mapping.unexpected.length}`,
    );
  }
}

/** 把异常归类为稳定安全码，供108暂停整个队列并展示原因。 */
function safetyCode(error: unknown): string | null {
  if (error instanceof LoginRequiredError) return "LOGIN_REQUIRED";
  if (error instanceof SafetyStopError) return error.reason.toUpperCase();
  if (error instanceof ControlPlaneError && [401, 403, 429].includes(error.status)) return `CONTROL_${error.status}`;
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b|unauthori[sz]ed/i.test(message)) return "BAYT_401";
  if (/\b403\b|forbidden|blocked/i.test(message)) return "BAYT_403";
  if (/\b429\b|rate.?limit/i.test(message)) return "BAYT_429";
  if (/captcha|cloudflare|challenge/i.test(message)) return "CAPTCHA_OR_CHALLENGE";
  if (/purchase|upgrade|quota|credit|pricing/i.test(message)) return "QUOTA_OR_UPGRADE";
  if (/filter|mapping|zip|crc|checkpoint|selected/i.test(message)) return "VALIDATION_FAILED";
  return null;
}

/** 错误会进入日志、控制面状态和本地标记，因此先移除URL令牌和Authorization值。 */
function operationalErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/([?&](?:token|access_token|actionToken|csrf)\s*=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .slice(0, 2_000);
}

/**
 * 执行一份任务：校验Filter版本、创建搜索、逐页导出双格式、验收、SFTP上传、写检查点。
 */
async function executeJob(client: ControlPlaneClient, browser: BaytBrowser, job: AgentJob, leaseToken: string): Promise<void> {
  let pauseRequested = false;
  let heartbeatHealthyAt = Date.now();
  let evidence: Record<string, unknown> = {};
  let activePhase = "initializing";
  let activePage: number | null = null;
  let heartbeatInFlight = false;

  const setPhase = (
    phase: string,
    pageNo: number | null,
    status: "started" | "completed" | "waiting" | "failed",
    nextActionAt?: string,
  ): void => {
    activePhase = phase;
    activePage = pageNo;
    const now = new Date().toISOString();
    evidence = {
      ...evidence,
      phase,
      phaseStatus: status,
      activePage: pageNo,
      lastProgressAt: now,
      ...(status === "started" ? { phaseStartedAt: now } : {}),
      ...(nextActionAt ? { nextActionAt } : { nextActionAt: null }),
    };
    process.stdout.write(`job_phase jobId=${job.id} page=${pageNo ?? 0} phase=${phase} status=${status}\n`);
  };

  const assertJobGuard = (): void => {
    if (pauseRequested) throw new SafetyStopError("operator_pause", "Operator requested a pause");
    if (Date.now() - heartbeatHealthyAt > 90_000) {
      throw new SafetyStopError("control_plane_heartbeat_lost", "Control plane heartbeat has been unavailable for more than 90 seconds");
    }
  };

  const runStage = async <T>(
    phase: string,
    pageNo: number | null,
    timeoutMs: number,
    operation: () => Promise<T>,
  ): Promise<T> => {
    setPhase(phase, pageNo, "started");
    try {
      const result = await withStageWatchdog(
        phase,
        pageNo,
        timeoutMs,
        operation,
        () => browser.abortCurrentOperation(`watchdog-${phase}-page-${pageNo ?? 0}`),
      );
      setPhase(phase, pageNo, "completed");
      return result;
    } catch (error) {
      setPhase(phase, pageNo, "failed");
      throw error;
    }
  };

  // 任务执行期间每30秒续租并读取暂停标记；void表示有意不等待这个后台Promise。
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void Promise.all([
      client.heartbeatJob(job.id, leaseToken, evidence),
      client.heartbeat({ currentJobId: job.id, chromeReady: true, loginState: "logged_in" }),
    ]).then(([state]) => {
      heartbeatHealthyAt = Date.now(); pauseRequested = state.pauseRequested === true || state.status === "pause_requested";
    }).catch((error) => process.stderr.write(`job_heartbeat_failed ${operationalErrorMessage(error)}\n`))
      .finally(() => { heartbeatInFlight = false; });
  }, 30_000);
  heartbeat.unref(); // unref让定时器本身不会阻止Node进程正常退出。
  try {
    // 首次目录不一致时立即复扫，避免把一次性DOM漂移误判成官网结构变化。
    let catalog = await runStage(
      "filter_catalog_scan",
      null,
      ACTIVE_BROWSER_STAGE_TIMEOUT_MS,
      () => withNetworkRetry(() => browser.discoverFilterCatalog({ resetToCanonicalSearch: true })),
    );
    const expectedVersion = job.searchSpec.filterSchemaVersion;
    const firstVersion = filterCatalogVersion(catalog);
    let catalogDecision = decideFilterCatalogVersion(expectedVersion, firstVersion);
    if (catalogDecision.action === "rescan") {
      const secondCatalog = await runStage(
        "filter_catalog_rescan",
        null,
        ACTIVE_BROWSER_STAGE_TIMEOUT_MS,
        () => withNetworkRetry(() => browser.discoverFilterCatalog()),
      );
      const secondVersion = filterCatalogVersion(secondCatalog);
      catalogDecision = decideFilterCatalogVersion(expectedVersion, firstVersion, secondVersion);
      if (catalogDecision.action === "accept_second") catalog = secondCatalog;
      else if (catalogDecision.action === "structure_changed") {
        throw new SafetyStopError("filter_structure_changed", `Filter catalog changed from ${expectedVersion} to ${secondVersion} in two consecutive scans`);
      } else if (catalogDecision.action === "unstable") {
        throw new SafetyStopError("filter_catalog_unstable", `Filter catalog was unstable across scans: ${firstVersion} then ${secondVersion}; expected ${expectedVersion}`);
      }
    }
    const nextPage = Math.max(1, job.currentPage + 1);
    const nextBatchDirectory = path.join(WINDOWS_DATA_ROOT, "runs", job.id, "batches", String(nextPage).padStart(4, "0"));
    const partialExcel = await existingDownload(path.join(nextBatchDirectory, "source.xls"), ".xls");
    let partialLabels: string[] | null = null;
    if (partialExcel) {
      // A completed Excel request must never be repeated merely because the
      // process was paused. Verify its stored immutable Filter evidence first;
      // a fresh search will then prove that the file still matches the live page.
      if (!job.searchId) throw new SafetyStopError("partial_search_missing", "Existing Excel has no saved searchId; operator review is required");
      partialLabels = expectedFilterLabels(job.searchSpec, catalog);
      if (JSON.stringify(job.actualFilterLabels) !== JSON.stringify(partialLabels)) {
        throw new SafetyStopError("partial_search_mismatch", "Existing Excel Filter evidence does not match the immutable task snapshot");
      }
    }
    const search = await runStage(
      "search_create",
      null,
      ACTIVE_BROWSER_STAGE_TIMEOUT_MS,
      () => withNetworkRetry(() => browser.createSearchFromSpec(job.searchSpec, catalog)),
    );
    if (partialLabels && JSON.stringify(search.actualFilterLabels) !== JSON.stringify(partialLabels)) {
      throw new SafetyStopError("partial_search_mismatch", "Fresh search Filter evidence does not match the partial Excel attempt");
    }
    evidence = { searchId: search.searchId, matchedCount: search.displayedCount, actualFilterLabels: search.actualFilterLabels };
    const state = await runStage(
      "search_checkpoint",
      null,
      CONTROL_STAGE_TIMEOUT_MS,
      () => client.heartbeatJob(job.id, leaseToken, evidence),
    );
    pauseRequested = state.pauseRequested === true || state.status === "pause_requested";
    // 从检查点恢复已完成CV_ID、计数和下一页编号。
    const seenCvIds = await loadCompletedCvIds(job);
    let exportedCount = job.exportedCount;
    let completedPages = job.completedPages;
    let pageNo = Math.max(1, job.currentPage + 1);
    const sftpConfig = sftpConfigFromEnvironment();

    // 每次循环只处理一个完整页面；一页成功后才推进检查点。
    while (!jobFinished(job, exportedCount, completedPages)) {
      assertJobGuard();
      const pageStartedAt = Date.now();
      await runStage(
        "page_navigation",
        pageNo,
        PAGE_NAVIGATION_TIMEOUT_MS,
        () => browser.goToPage(pageNo, search.searchId),
      );
      const candidates = await runStage(
        "listing_read",
        pageNo,
        PAGE_NAVIGATION_TIMEOUT_MS,
        () => browser.listCandidates(pageNo),
      );
      if (candidates.length < 1 || candidates.length > 50) throw new SafetyStopError("unexpected_page_size", `Page ${pageNo} contains ${candidates.length} candidates`);
      // 当前实现遇到跨页重复就安全停止，避免把重复人数错误计入目标。
      const duplicate = candidates.find((candidate) => seenCvIds.has(candidate.cvId));
      if (duplicate) throw new SafetyStopError("duplicate_cv_id", `CV_ID ${duplicate.cvId} appeared in more than one completed page`);
      const candidateIds = candidates.map((candidate) => candidate.cvId);
      const batchDirectory = path.join(WINDOWS_DATA_ROOT, "runs", job.id, "batches", String(pageNo).padStart(4, "0"));
      await fsp.mkdir(batchDirectory, { recursive: true });
      // 先Excel，等待安全间隔，再PDF ZIP；若进程在两种格式之间暂停，只复用
      // 与同一searchId当前页精确匹配的非空文件，绝不重复触发已完成的导出。
      const excelPath = path.join(batchDirectory, "source.xls");
      let excel = await existingDownload(excelPath, ".xls");
      if (excel) {
        await runStage(
          "excel_reuse_validation",
          pageNo,
          LOCAL_VALIDATION_TIMEOUT_MS,
          () => validateReusableExcel(excel!.path, candidateIds),
        );
      }
      else {
        const excelDownload = await runStage(
          "excel_export",
          pageNo,
          ACTIVE_BROWSER_STAGE_TIMEOUT_MS,
          () => browser.exportExcel(candidateIds),
        );
        excel = await saveDownload(excelDownload, path.join(batchDirectory, "source"), ".xls");
      }
      const excelMtime = (await fsp.stat(excel.path)).mtimeMs;
      const pdfNotBefore = excelMtime + randomDelay(EXPORT_INTERVAL_MIN_MS, EXPORT_INTERVAL_MAX_MS);
      setPhase("format_interval", pageNo, "waiting", new Date(pdfNotBefore).toISOString());
      await waitWithGuard(Math.max(0, pdfNotBefore - Date.now()), assertJobGuard);
      const pdfPath = path.join(batchDirectory, "bayt-cvs.zip");
      let pdfArchive = await existingDownload(pdfPath, ".zip");
      if (!pdfArchive) {
        const pdfDownload = await runStage(
          "pdf_export",
          pageNo,
          ACTIVE_BROWSER_STAGE_TIMEOUT_MS,
          () => browser.exportPdfArchive(candidateIds),
        );
        pdfArchive = await saveDownload(pdfDownload, path.join(batchDirectory, "bayt-cvs"), ".zip");
      }
      const manifest = await runStage(
        "batch_validation",
        pageNo,
        LOCAL_VALIDATION_TIMEOUT_MS,
        () => verifyBulkBatch({ runId: job.id, keyword: job.searchSpec.keyword, page: pageNo, expectedCvIds: candidateIds, excelPath: excel!.path, pdfArchivePath: pdfArchive!.path }),
      );
      const manifestPath = await writeBulkManifest(batchDirectory, manifest);
      const uploaded = await runStage(
        "sftp_upload",
        pageNo,
        SFTP_STAGE_TIMEOUT_MS,
        () => uploadBatchAtomically(sftpConfig, { runId: job.id, batchNo: pageNo, excelPath: excel!.path, pdfArchivePath: pdfArchive!.path, manifestPath }),
      );
      // 服务端检查点写成功后，这一页才正式成为“已完成”。
      await runStage(
        "page_checkpoint",
        pageNo,
        CONTROL_STAGE_TIMEOUT_MS,
        () => client.checkpoint(job.id, leaseToken, checkpointPayload(manifest, uploaded.remoteBatch)),
      );
      for (const cvId of candidateIds) seenCvIds.add(cvId);
      exportedCount += candidates.length;
      completedPages += 1;
      pageNo += 1;
      if (jobFinished(job, exportedCount, completedPages)) break;
      const pageInterval = randomDelay(PAGE_INTERVAL_MIN_MS, PAGE_INTERVAL_MAX_MS);
      const deadline = durationDeadline(job);
      const nextPageAt = deadline === null ? pageStartedAt + pageInterval : Math.min(pageStartedAt + pageInterval, deadline);
      setPhase("page_interval", pageNo + 1, "waiting", new Date(nextPageAt).toISOString());
      await waitWithGuard(Math.max(0, nextPageAt - Date.now()), assertJobGuard);
    }
    await runStage("job_complete", null, CONTROL_STAGE_TIMEOUT_MS, () => client.complete(job.id, leaseToken));
  } catch (error) {
    // 人工暂停单独确认；其他异常先写本地标记，再通知108进入安全停止。
    if (error instanceof SafetyStopError && error.reason === "operator_pause") await client.pauseAck(job.id, leaseToken);
    else {
      const code = safetyCode(error) || "AGENT_FAILED";
      const message = operationalErrorMessage(error);
      process.stderr.write(`job_failed jobId=${job.id} page=${activePage ?? 0} phase=${activePhase} code=${code} message=${message}\n`);
      await browser.writeDiagnostic(`job-failed-${code}-${activePhase}-page-${activePage ?? 0}`).catch(() => undefined);
      await fsp.mkdir(path.dirname(LOCAL_SAFETY_MARKER), { recursive: true });
      await fsp.writeFile(LOCAL_SAFETY_MARKER, JSON.stringify({ jobId: job.id, code, message, phase: activePhase, page: activePage, stoppedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      await reportSafetyStop(client, job.id, leaseToken, code, message);
      await fsp.rm(LOCAL_SAFETY_MARKER, { force: true });
    }
  } finally {
    // 清理心跳定时器，避免任务结束后继续续租。
    clearInterval(heartbeat);
  }
}

/** 从页级manifest挑出控制面需要保存的非敏感验收字段。 */
function checkpointPayload(manifest: BulkBatchManifest, remoteBatch: string): Record<string, unknown> {
  return {
    page: manifest.page,
    selectedCount: manifest.selectedCount,
    cvIdSetSha256: manifest.cvIdSetSha256,
    excelSha256: manifest.files.excel.sha256,
    excelSizeBytes: manifest.files.excel.sizeBytes,
    pdfSha256: manifest.files.pdfArchive.sha256,
    pdfSizeBytes: manifest.files.pdfArchive.sizeBytes,
    pdfEntries: manifest.verification.pdfEntries,
    zipCrcOk: manifest.verification.exactMatch && manifest.verification.invalidPdfEntries === 0 && manifest.verification.zipCrcFailures === 0,
    remoteBatch,
  };
}

/** Agent常驻主循环：检查登录、同步Filter、领取任务，空闲时每30秒轮询。 */
export async function runWindowsAgent(): Promise<void> {
  validateSettings();
  await fsp.mkdir(WINDOWS_DATA_ROOT, { recursive: true });
  try {
    // 安全标记存在时拒绝启动，必须由管理员核实原因。
    const marker = await fsp.readFile(LOCAL_SAFETY_MARKER, "utf8");
    throw new Error(`Local safety marker requires operator review: ${marker.slice(0, 500)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const client = new ControlPlaneClient(CONTROL_PLANE_URL, CONTROL_PLANE_TOKEN);
  const browser = await BaytBrowser.connectOverCdp(WINDOWS_CDP_ENDPOINT);
  let loginState: "unknown" | "logged_in" | "login_required" = "unknown";
  let automaticLoginAttemptedForEpisode = false;
  let nextLoginCheckAt = 0;
  let controlFailureCount = 0;
  process.stdout.write(`windows_agent_started id=${WINDOWS_AGENT_ID} dataRoot=${WINDOWS_DATA_ROOT}\n`);
  try {
    while (true) {
      try {
        // 登录状态不必每轮都访问Bayt，按配置间隔检查即可。
        if (Date.now() >= nextLoginCheckAt) {
          try {
            await browser.assertLoggedIn();
            loginState = "logged_in";
            automaticLoginAttemptedForEpisode = false;
          } catch (error) {
            loginState = error instanceof LoginRequiredError ? "login_required" : "unknown";
            if (error instanceof LoginRequiredError && !automaticLoginAttemptedForEpisode) {
              automaticLoginAttemptedForEpisode = true;
              try {
                const recovered = await browser.tryLoginWithSavedCredentials();
                if (recovered) {
                  loginState = "logged_in";
                  automaticLoginAttemptedForEpisode = false;
                  process.stdout.write("automatic_login_succeeded source=saved_browser_credentials\n");
                } else {
                  process.stdout.write("automatic_login_skipped reason=saved_credentials_unavailable_or_rejected\n");
                }
              } catch (loginError) {
                loginState = "login_required";
                process.stderr.write(
                  `automatic_login_blocked reason=${loginError instanceof SafetyStopError ? loginError.reason : "login_attempt_failed"}\n`,
                );
              }
            }
          }
          nextLoginCheckAt = Date.now() + WINDOWS_LOGIN_CHECK_INTERVAL_MS;
        }
        await client.heartbeat({ currentJobId: null, chromeReady: true, loginState });
        // Filter同步请求优先于普通采集任务。
        const catalogSync = await client.claimCatalogSync();
        if (catalogSync.request) {
          try {
            await browser.assertLoggedIn();
            loginState = "logged_in";
            nextLoginCheckAt = Date.now() + WINDOWS_LOGIN_CHECK_INTERVAL_MS;
            const catalog = await browser.discoverFilterCatalog({ resetToCanonicalSearch: true });
            await client.completeCatalogSync(catalogSync.request.id, catalog);
          } catch (error) {
            if (error instanceof LoginRequiredError) loginState = "login_required";
            await client.failCatalogSync(catalogSync.request.id, error instanceof Error ? error.message : String(error));
          }
          controlFailureCount = 0;
          continue;
        }
        // 未登录时只保持控制面心跳，不尝试创建Bayt搜索。
        if (loginState !== "logged_in") {
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          controlFailureCount = 0;
          continue;
        }
        // 控制面保证同一时刻只有一个Agent能取得有效任务租约。
        const claim = await client.claimJob();
        if (claim.job && claim.leaseToken) await executeJob(client, browser, claim.job, claim.leaseToken);
        else await new Promise((resolve) => setTimeout(resolve, 30_000));
        controlFailureCount = 0;
      } catch (error) {
        // 仅控制面短暂故障会重连；其他错误退出进程交给管理员检查。
        if (!isRetryableAgentLoopError(error)) throw error;
        controlFailureCount += 1;
        const retryMs = agentRetryDelay(controlFailureCount);
        process.stderr.write(`agent_control_plane_retry failureCount=${controlFailureCount} waitMs=${retryMs} reason=${error instanceof Error ? error.message : String(error)}\n`);
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }
  } finally {
    // 断开CDP连接，但Bayt官方Chrome进程由用户会话继续保留。
    await browser.close();
  }
}

// 直接运行本文件时启动Agent；作为模块导入测试时不自动执行。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runWindowsAgent().catch((error) => {
    process.stderr.write(`windows_agent_fatal ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
