/**
 * 旧版逐候选人采集主流程。
 * 它负责把浏览器、Excel、数据库、文件保存、重试和最终验收串成一条流水线。
 */
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BaytBrowser, LoginRequiredError, SafetyStopError, type SearchState } from "./bayt.ts";
import {
  DEFAULT_QUERY,
  BATCH_MIN_INTERVAL_MS,
  CANDIDATE_MIN_INTERVAL_MS,
  CAPTURES_DIR,
  MAX_RETRIES,
  PREFLIGHT_TARGET,
  nowIso,
} from "./config.ts";
import { CollectorDatabase } from "./db.ts";
import { assertExcelMapping, parseExcelExport } from "./excel.ts";
import {
  candidateDirectory,
  convertOfficeToPdf,
  ensureBatchDirectory,
  ensureCandidateDirectory,
  ensureDataLayout,
  inspectPdf,
  saveBuffer,
  saveDownload,
  sha256Text,
} from "./files.ts";
import { verifyRun, writeCandidateManifest, writeRunArtifacts } from "./reports.ts";
import type {
  CandidateRecord,
  DocumentKind,
  DocumentRecord,
  DownloadedFile,
  ExcelCandidate,
  ItemStatus,
  ListingCandidate,
  RunRecord,
} from "./types.ts";

/** 调用方可以控制任务模式、目标、起始页、抓包和暂停检查。 */
export interface CollectionOptions {
  command: "preflight" | "collect" | "resume";
  target: number;
  query?: string;
  runId?: string;
  headless?: boolean;
  incremental?: boolean;
  allowPartial?: boolean;
  startPage?: number;
  capture?: boolean;
  shouldPause?: () => boolean | Promise<boolean>;
}

/**
 * 判断增量任务是否需要重新处理候选人：新出现、更新时间变化，或未知更新时间且30天未见。
 */
export function needsIncrementalCollection(
  existing: Record<string, unknown> | null,
  candidate: ListingCandidate,
  now = Date.now(),
): boolean {
  if (!existing) return true;
  const previousUpdate = existing.last_cv_update ? String(existing.last_cv_update) : null;
  if (candidate.lastCvUpdate) return candidate.lastCvUpdate !== previousUpdate;
  const lastSeen = existing.last_seen_at ? Date.parse(String(existing.last_seen_at)) : 0;
  return !lastSeen || now - lastSeen >= 30 * 24 * 60 * 60 * 1000;
}

/** 生成包含时间戳和随机后缀的运行ID，降低并发碰撞概率。 */
const newRunId = (): string => {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
};

/** 把可选的DownloadedFile转换成统一DocumentRecord，减少重复字段映射。 */
const documentRecord = (
  runId: string,
  cvId: string,
  kind: DocumentKind,
  status: ItemStatus,
  file?: DownloadedFile,
  error: string | null = null,
): DocumentRecord => ({
  runId,
  cvId,
  kind,
  originalName: file?.originalName || null,
  mimeType: file?.mimeType || null,
  extension: file?.extension || null,
  path: file?.path || null,
  sha256: file?.sha256 || null,
  sizeBytes: file?.sizeBytes || null,
  status,
  error,
});

/** 打开可见浏览器让用户人工登录；finally保证结束时释放浏览器连接。 */
export async function login(): Promise<void> {
  const browser = await BaytBrowser.open({ headless: false });
  try {
    await browser.loginInteractively();
    process.stdout.write("LOGIN_OK: Bayt企业登录已保存到专用浏览器会话。\n");
  } finally {
    await browser.close();
  }
}

/**
 * 采集总入口：创建/恢复运行，建立搜索，逐页分批处理，最后验收并落状态。
 */
export async function runCollection(options: CollectionOptions): Promise<RunRecord> {
  await ensureDataLayout();
  const database = new CollectorDatabase();
  let run: RunRecord;
  // resume复用原运行ID和检查点；其他模式创建全新运行记录。
  if (options.command === "resume") {
    run = options.runId ? database.getRun(options.runId)! : database.getLatestResumableRun()!;
    if (!run) {
      database.close();
      throw new Error("No resumable collection run was found");
    }
  } else {
    const runId = options.runId || newRunId();
    run = database.startRun(runId, options.command, options.query || DEFAULT_QUERY, options.target);
  }

  // 条件表达式决定是否为本次浏览器会话启用HAR抓包。
  const capturePath = options.capture
    ? path.join(CAPTURES_DIR, `${run.runId}.har`)
    : undefined;
  if (capturePath) await fsp.mkdir(CAPTURES_DIR, { recursive: true, mode: 0o700 });
  const browser = await BaytBrowser.open({ headless: options.headless, capturePath });
  try {
    database.updateRun(run.runId, { status: "running", error: null });
    let searchState: SearchState;
    // 有searchId说明是恢复；否则按关键词新建搜索。
    if (run.searchId) {
      searchState = await browser.openExistingSearch(run.searchId, run.query);
    } else {
      searchState = await browser.createSearch(run.query, true);
      // 最近6个月结果不足目标时，记录原因并重新创建不带时间限制的搜索。
      if (
        searchState.lastUpdatedFilterApplied &&
        searchState.displayedCount !== null &&
        searchState.displayedCount < run.targetCount
      ) {
        database.addEvent(run.runId, "recent_filter_removed", {
          displayedCount: searchState.displayedCount,
          targetCount: run.targetCount,
        });
        searchState = await browser.createSearch(run.query, false);
      }
      database.updateRun(run.runId, {
        searchId: searchState.searchId,
        filtersJson: JSON.stringify({
          query: searchState.query,
          lastUpdatedWithinSixMonths: searchState.lastUpdatedFilterApplied,
          displayedCount: searchState.displayedCount,
          pageCount: searchState.pageCount,
          listingUrl: searchState.listingUrl,
        }),
      });
    }

    // 起始页至少为1；恢复默认从数据库记录的当前页继续。
    let pageNo = Math.max(
      1,
      options.startPage || (options.command === "resume" ? run.currentPage || 1 : 1),
    );
    let batchNo = database.getNextBatchNo(run.runId);
    // 外层循环负责翻页，直到数据库唯一人数达到目标。
    while (database.countRunCandidates(run.runId) < run.targetCount) {
      if (await options.shouldPause?.()) {
        throw new SafetyStopError("operator_pause", "Collection was paused by an operator");
      }
      if (searchState.pageCount && pageNo > searchState.pageCount) {
        if (options.allowPartial) break;
        throw new Error(`Search exhausted after ${searchState.pageCount} pages with ${database.countRunCandidates(run.runId)} unique candidates`);
      }
      await browser.goToPage(pageNo, searchState.searchId);
      const pageCandidates = await browser.listCandidates(pageNo);

      // 内层循环从当前页切出一个或多个批次；首批最多10人作为强制预检门槛。
      while (database.countRunCandidates(run.runId) < run.targetCount) {
        const statuses = database.getRunCandidateStatuses(run.runId);
        const eligible = pageCandidates.filter((candidate) => {
          if (statuses.get(candidate.cvId) === "downloaded") return false;
          if (!options.incremental) return true;
          return needsIncrementalCollection(database.getCandidate(candidate.cvId), candidate);
        });
        if (!eligible.length) break;
        const remaining = run.targetCount - database.countRunCandidates(run.runId);
        const isFirstGate = statuses.size === 0 && run.targetCount > PREFLIGHT_TARGET;
        // Math.min确保不会超过预检大小、剩余目标或当前页可用人数。
        const limit = Math.min(isFirstGate ? PREFLIGHT_TARGET : 50, remaining, eligible.length);
        const batchCandidates = eligible.slice(0, limit);
        await processBatch(database, browser, run, searchState, batchNo, pageNo, batchCandidates);
        batchNo += 1;
        await writeRunArtifacts(database, run.runId);
        if (database.countRunCandidates(run.runId) < run.targetCount) {
          await delay(BATCH_MIN_INTERVAL_MS);
        }
      }

      database.updateRun(run.runId, {
        currentPage: pageNo,
        uniqueCount: database.countRunCandidates(run.runId),
      });
      pageNo += 1;
    }

    database.updateRun(run.runId, {
      status: "completed",
      uniqueCount: database.countRunCandidates(run.runId),
      completedAt: nowIso(),
      error: null,
    });
    // allowPartial=false时，最终唯一人数必须严格等于目标。
    const verification = await verifyRun(database, run.runId, !options.allowPartial);
    await writeRunArtifacts(database, run.runId);
    if (!verification.ok) {
      throw new Error(`Collection verification failed: ${verification.errors.slice(0, 10).join("; ")}`);
    }
    return database.getRun(run.runId)!;
  } catch (error) {
    // 不同异常映射成明确状态，便于前端决定要求登录、暂停还是显示失败。
    if (error instanceof LoginRequiredError) {
      database.updateRun(run.runId, { status: "login_required", error: error.message });
    } else if (error instanceof SafetyStopError) {
      database.updateRun(run.runId, { status: "paused", error: `${error.reason}: ${error.message}` });
      database.addEvent(run.runId, "safety_stop", { reason: error.reason, message: error.message });
    } else {
      database.updateRun(run.runId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await writeRunArtifacts(database, run.runId).catch(() => undefined);
    throw error;
  } finally {
    // 无论成功失败都关闭浏览器和数据库。
    await browser.close();
    database.close();
  }
}

/**
 * 处理一个批次：导出并核对Excel、更新候选人映射，再逐人下载相关文件。
 */
async function processBatch(
  database: CollectorDatabase,
  browser: BaytBrowser,
  run: RunRecord,
  searchState: SearchState,
  batchNo: number,
  pageNo: number,
  candidates: ListingCandidate[],
): Promise<void> {
  const candidateIds = candidates.map((candidate) => candidate.cvId);
  database.upsertBatch(run.runId, batchNo, pageNo, "running", candidateIds);
  // 单行for在这里只执行一次upsert；没有花括号是JavaScript允许的简写。
  for (const candidate of candidates) database.upsertListingCandidate(run.runId, batchNo, candidate);

  try {
    const directory = await ensureBatchDirectory(run.runId, batchNo);
    const excelDownload = await browser.exportExcel(candidateIds);
    const excelFile = await saveDownload(excelDownload, path.join(directory, "source"));
    const excelCandidates = await parseExcelExport(excelFile.path);
    // Excel必须与网页选择集合一一对应，缺失或多出都立即中止批次。
    const mapping = assertExcelMapping(excelCandidates, candidateIds);
    if (mapping.missing.length || mapping.unexpected.length) {
      throw new Error(
        `Excel mapping mismatch; missing=${mapping.missing.join("|") || "none"}; unexpected=${mapping.unexpected.join("|") || "none"}`,
      );
    }
    // Map让后续按CV_ID查询Excel记录接近常数时间。
    const excelById = new Map(excelCandidates.map((candidate) => [candidate.cvId, candidate]));
    // 候选人按列表顺序逐个处理，完成一人就立刻写检查点并等待安全间隔。
    for (const candidate of candidates) {
      updateExcelCandidate(database, candidate, excelById.get(candidate.cvId)!);
    }
    database.upsertBatch(
      run.runId,
      batchNo,
      pageNo,
      "running",
      candidateIds,
      excelFile.path,
    );

    for (const candidate of candidates) {
      const status = database.getRunCandidateStatuses(run.runId).get(candidate.cvId);
      if (status === "downloaded") continue;
      await processCandidateWithRetry(
        database,
        browser,
        run,
        searchState,
        candidate,
        pageNo,
      );
      database.updateRun(run.runId, {
        uniqueCount: database.countRunCandidates(run.runId),
        currentPage: pageNo,
      });
      await delay(CANDIDATE_MIN_INTERVAL_MS);
    }
    database.upsertBatch(run.runId, batchNo, pageNo, "downloaded", candidateIds, excelFile.path);
  } catch (error) {
    // 批次任一步失败都把批次标记failed，再把异常交给总流程处理。
    database.upsertBatch(
      run.runId,
      batchNo,
      pageNo,
      "failed",
      candidateIds,
      null,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

/** 将某人的Excel字段合并进候选人主记录，同时保留已有网页/哈希信息。 */
function updateExcelCandidate(
  database: CollectorDatabase,
  listing: ListingCandidate,
  excel: ExcelCandidate,
): void {
  const existing = database.getCandidate(listing.cvId);
  const excelJson = JSON.stringify(excel);
  database.updateCandidate({
    cvId: listing.cvId,
    name: excel.name || listing.name || null,
    profileUrl: excel.profileUrl || listing.profileUrl,
    lastCvUpdate: excel.lastCvUpdate || listing.lastCvUpdate,
    excelJson,
    webJson: existing?.web_json ? String(existing.web_json) : null,
    contentHash: existing?.content_hash ? String(existing.content_hash) : null,
    avatarStatus: listing.avatarStatus,
    avatarUrl: listing.avatarUrl,
    avatarHash: existing?.avatar_hash ? String(existing.avatar_hash) : null,
  });
}

/** 单人处理失败最多重试MAX_RETRIES次；登录和安全停止类异常不重试。 */
async function processCandidateWithRetry(
  database: CollectorDatabase,
  browser: BaytBrowser,
  run: RunRecord,
  searchState: SearchState,
  candidate: ListingCandidate,
  pageNo: number,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    database.setCandidateStatus(run.runId, candidate.cvId, "running");
    database.addEvent(run.runId, "candidate_attempt", { attempt, pageNo }, candidate.cvId);
    try {
      await processCandidate(database, browser, run, candidate);
      database.setCandidateStatus(run.runId, candidate.cvId, "downloaded");
      await writeCandidateManifest(database, run.runId, candidate.cvId);
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      database.addEvent(run.runId, "candidate_attempt_failed", { attempt, message }, candidate.cvId);
      if (error instanceof LoginRequiredError || error instanceof SafetyStopError) throw error;
      // 普通错误重试前返回原搜索和原页，避免浏览器留在详情页。
      if (attempt < MAX_RETRIES) {
        await browser.openExistingSearch(searchState.searchId, run.query);
        await browser.goToPage(pageNo, searchState.searchId);
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  database.setCandidateStatus(run.runId, candidate.cvId, "failed", message);
  throw new Error(`Candidate ${candidate.cvId} failed after ${MAX_RETRIES} attempts: ${message}`);
}

/**
 * 处理一名候选人：头像、标准PDF、原始附件、格式转换、网页资料和内容哈希。
 */
async function processCandidate(
  database: CollectorDatabase,
  browser: BaytBrowser,
  run: RunRecord,
  candidate: ListingCandidate,
): Promise<void> {
  await ensureCandidateDirectory(candidate.cvId);
  let avatarHash: string | null = null;
  // 真实头像才保存文件；占位图只记录状态，避免大量重复无意义文件。
  if (candidate.avatarStatus === "photo" && candidate.avatarUrl) {
    const avatar = await browser.downloadAvatar(candidate.avatarUrl);
    const avatarFile = await saveBuffer(
      avatar.buffer,
      path.join(candidateDirectory(candidate.cvId), "avatar"),
      avatar.mimeType,
      candidate.avatarUrl,
    );
    avatarHash = avatarFile.sha256;
    database.upsertDocument(documentRecord(run.runId, candidate.cvId, "avatar", "downloaded", avatarFile));
  } else {
    database.upsertDocument(
      documentRecord(
        run.runId,
        candidate.cvId,
        "avatar",
        candidate.avatarStatus === "placeholder" ? "skipped" : "not_available",
        undefined,
        candidate.avatarStatus,
      ),
    );
  }

  // collectCandidate会打开资料页并取得标准PDF/原附件；这里负责落盘和校验。
  const result = await browser.collectCandidate(candidate);
  const standardFile = await saveDownload(
    result.standardDownload!,
    path.join(candidateDirectory(candidate.cvId), "bayt-cv"),
    ".pdf",
  );
  standardFile.mimeType = "application/pdf";
  const standardInspection = await inspectPdf(standardFile.path);
  if (!standardInspection.ok) {
    throw new Error(`Standard CV PDF is invalid: ${standardInspection.error}`);
  }
  // 能从PDF提取Ref时必须与当前CV_ID一致；提取不到则记录较弱的映射依据。
  if (standardInspection.refs?.length && !standardInspection.refs.includes(candidate.cvId)) {
    throw new Error(
      `Standard CV PDF mapping mismatch: expected ${candidate.cvId}, found ${standardInspection.refs.join(",")}`,
    );
  }
  if (!standardInspection.refs?.length) {
    database.addEvent(
      run.runId,
      "standard_pdf_ref_unavailable",
      { mappingBasis: "active_download_context", path: standardFile.path },
      candidate.cvId,
    );
  }
  database.upsertDocument(documentRecord(run.runId, candidate.cvId, "bayt_pdf", "downloaded", standardFile));

  // 原始附件是可选项：存在则保留并尝试转PDF，不存在则明确写not_available。
  if (result.originalStatus === "downloaded" && result.originalDownload) {
    const originalFile = await saveDownload(
      result.originalDownload,
      path.join(candidateDirectory(candidate.cvId), "original"),
    );
    database.upsertDocument(documentRecord(run.runId, candidate.cvId, "original", "downloaded", originalFile));
    await handleOriginalConversion(database, run.runId, candidate.cvId, originalFile);
  } else {
    database.upsertDocument(
      documentRecord(
        run.runId,
        candidate.cvId,
        "original",
        "not_available",
        undefined,
        "Bayt profile has no original attachment download",
      ),
    );
    database.upsertDocument(
      documentRecord(run.runId, candidate.cvId, "original_pdf", "not_available", undefined, "no original"),
    );
  }

  const existing = database.getCandidate(candidate.cvId);
  const excelJson = existing?.excel_json ? String(existing.excel_json) : null;
  const webJson = JSON.stringify(result.profile);
  // Excel与网页JSON拼接后计算内容哈希，用于后续判断资料是否发生变化。
  const contentHash = sha256Text(`${excelJson || ""}\n${webJson}`);
  const record: CandidateRecord = {
    cvId: candidate.cvId,
    name: existing?.name ? String(existing.name) : candidate.name || null,
    profileUrl: candidate.profileUrl,
    lastCvUpdate: candidate.lastCvUpdate,
    excelJson,
    webJson,
    contentHash,
    avatarStatus: candidate.avatarStatus,
    avatarUrl: candidate.avatarUrl,
    avatarHash,
  };
  database.updateCandidate(record);
  database.addEvent(
    run.runId,
    "profile_viewed",
    { viewedAt: result.profile.viewedAt, sideEffect: "Bayt may mark the profile as Viewed" },
    candidate.cvId,
  );
}

/** 根据原始附件格式决定“无需转换、不支持转换、或调用LibreOffice转换”。 */
async function handleOriginalConversion(
  database: CollectorDatabase,
  runId: string,
  cvId: string,
  originalFile: DownloadedFile,
): Promise<void> {
  const extension = originalFile.extension.toLowerCase();
  if (extension === ".pdf") {
    const inspection = await inspectPdf(originalFile.path);
    if (!inspection.ok) throw new Error(`Original PDF is invalid: ${inspection.error}`);
    database.upsertDocument(
      documentRecord(runId, cvId, "original_pdf", "skipped", undefined, "original is already PDF"),
    );
    return;
  }
  // 非Office格式仍保留原件，但不伪造PDF转换成功。
  if (![".doc", ".docx", ".odt", ".rtf"].includes(extension)) {
    database.upsertDocument(
      documentRecord(
        runId,
        cvId,
        "original_pdf",
        "not_available",
        undefined,
        `conversion unsupported for ${extension || "unknown format"}`,
      ),
    );
    return;
  }
  const converted = await convertOfficeToPdf(
    originalFile.path,
    path.join(candidateDirectory(cvId), "original-converted.pdf"),
  );
  database.upsertDocument(documentRecord(runId, cvId, "original_pdf", "downloaded", converted));
}

/** 验证指定运行；未给runId时验证数据库里最近一次运行。 */
export async function verifyLatest(runId?: string): Promise<{
  run: RunRecord;
  ok: boolean;
  errors: string[];
  warnings: string[];
}> {
  const database = new CollectorDatabase();
  try {
    const run = runId ? database.getRun(runId) : database.getLatestRun();
    if (!run) throw new Error("No collection run was found");
    const verification = await verifyRun(database, run.runId, true);
    await writeRunArtifacts(database, run.runId);
    return { run, ...verification };
  } finally {
    database.close();
  }
}
