import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import mime from "mime-types";
import multer from "multer";
import yauzl from "yauzl";
import { AuditStore } from "./audit.ts";
import { BrowserAuthStore } from "./browser-auth.ts";
import { assertProductionConfiguration, config } from "./config.ts";
import { AnalyticsFilterError, DashboardAnalyticsService } from "./dashboard-analytics.ts";
import { ImportService } from "./import-service.ts";
import { IncomingConsumer } from "./incoming-consumer.ts";
import { PeopleRepository } from "./people-repository.ts";
import { ResearchService } from "./research-service.ts";
import type { ResearchPolicy } from "./research-types.ts";
import { authenticatedUser, browserSessionGuard, clearSessionCookie, currentSession, issueFileToken,
  requireLoginCsrf, requireSameOrigin, requireSessionCsrf, securityHeaders, sessionCookie, sessionToken, verifyFileToken } from "./security.ts";
import { CollectorClientError, collectorRequest, requireCollectorBrowserMutation } from "./collector-client.ts";
import { CollectorControlStore } from "./collector-control.ts";
import { collectorRouteError, createCollectorAgentRouter, createCollectorControlRouter } from "./collector-routes.ts";

assertProductionConfiguration();
fs.mkdirSync(config.runtimeDirectory, { recursive: true, mode: 0o700 });
const uploadDirectory = path.join(config.runtimeDirectory, "uploads");
fs.mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });

const app = express();
const peopleRepository = new PeopleRepository();
const dashboardAnalyticsService = new DashboardAnalyticsService(peopleRepository);
const importService = new ImportService(peopleRepository);
const collectorControl = new CollectorControlStore(config.collectorControlDbPath);
const incomingConsumer = new IncomingConsumer(importService, peopleRepository,
  config.collectorIncomingRoot, config.runtimeDirectory, config.collectorIncomingRemoteRoot,
  undefined, collectorControl);
const researchService = new ResearchService(peopleRepository);
const audit = new AuditStore();
const browserAuth = new BrowserAuthStore(config.authSessionDbPath, () => ({
  user: config.appUser, password: config.appPassword, secret: config.previewSecret,
}));
const upload = multer({
  dest: uploadDirectory,
  limits: { fileSize: 30 * 1024 * 1024, files: 2, fields: 5 },
});

app.disable("x-powered-by");
app.use(securityHeaders);
app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "bayt-intelligence", dataSource: fs.existsSync(config.collectionDbPath) ? "connected" : "empty" });
});
app.use(express.json({ limit: "1mb" }));
app.use("/api/v1/collector/agent", createCollectorAgentRouter(collectorControl, config.collectorAgentToken, {
  localRoot: config.collectorIncomingRoot,
  remoteRoot: config.collectorIncomingRemoteRoot,
}));
app.post("/api/v1/auth/login", requireSameOrigin, requireLoginCsrf, (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const user = typeof request.body?.user === "string" ? request.body.user : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  if (user.length > 256 || password.length > 1024) {
    response.status(400).json({ error: { code: "LOGIN_INVALID", message: "账号或密码错误" } });
    return;
  }
  const clientIp = String(request.headers["x-real-ip"] || request.socket.remoteAddress || "unknown");
  const result = browserAuth.login(user, password, clientIp);
  if (result.status === "limited") {
    audit.record({ action: "AUTH_LOGIN_LIMITED", actor: null });
    response.setHeader("Retry-After", String(result.retryAfterSeconds));
    response.status(429).json({ error: { code: "LOGIN_RATE_LIMITED", message: "尝试次数过多，请稍后重试" } });
    return;
  }
  if (result.status === "invalid") {
    audit.record({ action: "AUTH_LOGIN_FAILED", actor: null });
    response.status(401).json({ error: { code: "LOGIN_INVALID", message: "账号或密码错误" } });
    return;
  }
  browserAuth.revoke(sessionToken(request));
  response.setHeader("Set-Cookie", sessionCookie(result.token));
  audit.record({ action: "AUTH_LOGIN", actor: result.session.user });
  response.json(result.session);
});
app.use("/api", browserSessionGuard(browserAuth), requireSessionCsrf);
app.get("/api/v1/auth/me", (request, response) => response.json(currentSession(request)));
app.post("/api/v1/auth/logout", (request, response) => {
  browserAuth.revoke(sessionToken(request));
  response.setHeader("Set-Cookie", clearSessionCookie());
  audit.record({ action: "AUTH_LOGOUT", actor: authenticatedUser(request) });
  response.sendStatus(204);
});

function actor(request: Request): string {
  return authenticatedUser(request) || "local-user";
}

function parsePositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

app.get("/api/v1/dashboard", (_request, response) => {
  const people = peopleRepository.list().map((person) => researchService.decoratePerson(person));
  const availableBaytPdfs = people.filter((person) => person.attachments.some((item) => item.kind === "bayt_pdf" && item.status === "downloaded")).length;
  const originals = people.filter((person) => person.attachments.some((item) => item.kind === "original" && item.status === "downloaded")).length;
  const avatars = people.filter((person) => person.hasAvatar).length;
  const imports = importService.list();
  const research = researchService.summary();
  const providers = researchService.providers();
  response.json({
    peopleTotal: people.length,
    baytPdfAvailable: availableBaytPdfs,
    originalAvailable: originals,
    avatarsAvailable: avatars,
    scored: research.scored,
    researchQueued: research.eligible,
    reviewPending: research.reviewRequired,
    scoringConfigured: true,
    researchConfigured: providers.tavilyConfigured,
    latestImport: imports[0] || null,
  });
});

app.get("/api/v1/dashboard/analytics", (request, response) => {
  try {
    const result = dashboardAnalyticsService.get({
      batch: request.query.batch,
      source: request.query.source,
      country: request.query.country,
      updatedRange: request.query.updatedRange,
    });
    const research = researchService.summary();
    response.json({
      ...result,
      kpis: {
        ...result.kpis,
        researchConfigured: researchService.providers().tavilyConfigured,
        researchCandidates: research.eligible,
      },
    });
  } catch (error) {
    if (error instanceof AnalyticsFilterError) {
      response.status(400).json({ error: { code: error.code, message: error.message } });
      return;
    }
    throw error;
  }
});

app.get("/api/v1/people", (request, response) => {
  const query = String(request.query.q || "").trim().toLocaleLowerCase();
  const nationality = String(request.query.nationality || "").trim().toLocaleLowerCase();
  const attachment = String(request.query.attachment || "").trim();
  const page = parsePositiveInteger(request.query.page, 1, 100000);
  const pageSize = parsePositiveInteger(request.query.pageSize, 12, 50);
  let people = peopleRepository.list().map((person) => researchService.decoratePerson(person));
  if (query) {
    people = people.filter((person) =>
      [person.displayName, person.cvId, person.headline, person.nationality, person.residence, ...person.skills.map((skill) => skill.name)]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query)),
    );
  }
  if (nationality) people = people.filter((person) => person.nationality?.toLocaleLowerCase() === nationality);
  if (attachment === "bayt") people = people.filter((person) => person.attachments.some((item) => item.kind === "bayt_pdf" && item.status === "downloaded"));
  if (attachment === "original") people = people.filter((person) => person.attachments.some((item) => item.kind === "original" && item.status === "downloaded"));
  if (attachment === "missing") people = people.filter((person) => !person.attachments.some((item) => item.status === "downloaded"));
  const sort = String(request.query.sort || "name");
  people.sort((left, right) => {
    if (sort === "updated") return String(right.lastCvUpdate || "").localeCompare(String(left.lastCvUpdate || ""));
    return left.displayName.localeCompare(right.displayName);
  });
  const start = (page - 1) * pageSize;
  const nationalities = [...new Set(peopleRepository.list().map((person) => person.nationality).filter(Boolean))].sort();
  const selected = people.slice(start, start + pageSize);
  const sources = collectorControl.sourcesForPeople(selected.map((person) => person.cvId),
    (runId, sourcePage) => incomingConsumer.isDisplayed(runId, sourcePage));
  response.json({ items: selected.map((person) => ({ ...person, collectionTasks: sources.get(person.cvId) || [] })),
    page, pageSize, total: people.length, facets: { nationalities } });
});

app.get("/api/v1/people/:cvId", (request, response) => {
  const storedPerson = peopleRepository.get(request.params.cvId);
  const person = storedPerson ? researchService.decoratePerson(storedPerson) : null;
  if (!person) {
    response.status(404).json({ error: { code: "PERSON_NOT_FOUND", message: "未找到该人物" } });
    return;
  }
  audit.record({ action: "VIEW_PERSON", cvId: person.cvId, actor: actor(request) });
  response.json({ ...person, collectionTasks: collectorControl.sourcesForPeople([person.cvId],
    (runId, sourcePage) => incomingConsumer.isDisplayed(runId, sourcePage)).get(person.cvId) || [] });
});

app.get("/api/v1/collector/jobs/:id/people", async (request, response, next) => {
  try {
    const job = collectorControl.getJob(String(request.params.id));
    if (!job) {
      response.status(404).json({ error: { code: "COLLECTION_JOB_NOT_FOUND", message: "采集任务不存在" } });
      return;
    }
    const page = parsePositiveInteger(request.query.page, 1, 100000);
    const pageSize = parsePositiveInteger(request.query.pageSize, 12, 50);
    const people = new Map(peopleRepository.list().map((person) => [person.cvId, person]));
    const records = collectorControl.peopleForJob(job.id).filter((item) => {
      if (!incomingConsumer.isDisplayed(item.runId, item.page)) return false;
      const person = people.get(item.cvId);
      const pdf = peopleRepository.getAttachment(`${item.cvId}:bayt_pdf`, person);
      const batch = importService.get(item.importBatchId, true);
      return !!person?.attachments.some((attachment) => attachment.kind === "bayt_pdf" && attachment.status === "downloaded") &&
        !!pdf?.path && fs.existsSync(pdf.path) && batch?.status === "COMPLETED" &&
        !!batch.files?.zipPath && fs.existsSync(batch.files.zipPath) &&
        batch.matches.some((match) => match.cvId === item.cvId && match.status === "SUCCESS" && match.pdfFile);
    });
    const sources = collectorControl.sourcesForPeople(records.slice((page - 1) * pageSize, page * pageSize).map((item) => item.cvId),
      (runId, sourcePage) => incomingConsumer.isDisplayed(runId, sourcePage));
    const items = records.slice((page - 1) * pageSize, page * pageSize).map((item) => ({
      ...item, person: { ...researchService.decoratePerson(people.get(item.cvId)!),
        collectionTasks: sources.get(item.cvId) || [] },
    }));
    const incoming = (await incomingConsumer.list()).filter((item) => collectorControl.jobForRun(item.runId) === job.id);
    audit.record({ action: "VIEW_COLLECTOR_JOB_PEOPLE", actor: actor(request), detail: job.id });
    response.json({ items, page, pageSize, total: records.length,
      exportedCount: job.exportedCount, pendingImportCount: job.searchSpec.schemaVersion === 2 ? Math.max(0, job.exportedCount - records.length) : 0,
      pendingPages: incoming.filter((item) => item.status === "pending" || item.status === "processing").length,
      blockedPages: incoming.filter((item) => item.status === "blocked").length });
  } catch (error) { next(error); }
});

function taskPdfSource(attachmentId: string): { cvId: string; zipPath: string; entryName: string } | null {
  const match = attachmentId.match(/^(job-[A-Za-z0-9_-]+):(\d+)$/);
  if (!match) return null;
  const source = collectorControl.personForJob(match[1], match[2]);
  if (!source || !incomingConsumer.isDisplayed(source.runId, source.page)) return null;
  const batch = importService.get(source.importBatchId, true);
  const entryName = batch?.matches.find((item) => item.cvId === match[2] && item.status === "SUCCESS")?.pdfFile;
  if (batch?.status !== "COMPLETED" || !batch.files?.zipPath || !entryName || !fs.existsSync(batch.files.zipPath)) return null;
  return { cvId: match[2], zipPath: batch.files.zipPath, entryName };
}

function streamTaskPdf(source: { cvId: string; zipPath: string; entryName: string }, response: Response, next: NextFunction): void {
  yauzl.open(source.zipPath, { lazyEntries: true, autoClose: true }, (error, zip) => {
    if (error || !zip) { next(error || new Error("PDF批次不可读取")); return; }
    let found = false;
    zip.on("entry", (entry) => {
      if (entry.fileName !== source.entryName) { zip.readEntry(); return; }
      found = true;
      if (entry.uncompressedSize > 25 * 1024 * 1024) { zip.close(); next(new Error("PDF条目超过上限")); return; }
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError || !stream) { zip.close(); next(streamError || new Error("PDF条目不可读取")); return; }
        response.setHeader("Cache-Control", "private, no-store");
        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(`${source.cvId}.pdf`)}`);
        stream.on("error", next);
        response.on("close", () => zip.close());
        stream.pipe(response);
      });
    });
    zip.on("end", () => { if (!found && !response.headersSent) response.status(404).json({ error: { code: "TASK_PDF_NOT_FOUND", message: "该任务简历不可用" } }); });
    zip.on("error", next);
    zip.readEntry();
  });
}

app.get("/api/v1/people/:cvId/avatar", (request, response) => {
  const avatarPath = peopleRepository.getAvatar(request.params.cvId);
  if (!avatarPath) {
    response.status(404).json({ error: { code: "AVATAR_NOT_AVAILABLE", message: "该人物没有可用头像" } });
    return;
  }
  response.setHeader("Cache-Control", "private, max-age=3600");
  response.type(mime.lookup(avatarPath) || "application/octet-stream");
  response.sendFile(avatarPath);
});

app.get("/api/v1/people/:cvId/audit", (request, response) => {
  response.json({ items: audit.list(request.params.cvId) });
});

app.get("/api/v1/attachments/:attachmentId/preview-url", (request, response) => {
  const taskSource = taskPdfSource(request.params.attachmentId);
  if (taskSource) {
    const token = issueFileToken(request.params.attachmentId, "inline");
    audit.record({ action: "PREVIEW_TASK_PDF", cvId: taskSource.cvId, attachmentId: request.params.attachmentId, actor: actor(request) });
    response.setHeader("Cache-Control", "no-store");
    response.json({ url: `/api/v1/files/${encodeURIComponent(request.params.attachmentId)}?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
    return;
  }
  const attachment = peopleRepository.getAttachment(request.params.attachmentId);
  if (!attachment || !attachment.previewable) {
    response.status(404).json({ error: { code: "PREVIEW_NOT_AVAILABLE", message: "该附件暂不支持在线预览" } });
    return;
  }
  const token = issueFileToken(attachment.id, "inline");
  audit.record({ action: "PREVIEW_ATTACHMENT", cvId: attachment.cvId, attachmentId: attachment.id, actor: actor(request) });
  response.setHeader("Cache-Control", "no-store");
  response.json({ url: `/api/v1/files/${encodeURIComponent(attachment.id)}?token=${encodeURIComponent(token)}`, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
});

app.get("/api/v1/attachments/:attachmentId/download-url", (request, response) => {
  const attachment = peopleRepository.getAttachment(request.params.attachmentId);
  if (!attachment?.path) {
    response.status(404).json({ error: { code: "DOWNLOAD_NOT_AVAILABLE", message: "该附件不可下载" } });
    return;
  }
  const token = issueFileToken(attachment.id, "attachment");
  audit.record({ action: "REQUEST_ATTACHMENT_DOWNLOAD", cvId: attachment.cvId, attachmentId: attachment.id, actor: actor(request) });
  response.setHeader("Cache-Control", "no-store");
  response.json({ url: `/api/v1/files/${encodeURIComponent(attachment.id)}?token=${encodeURIComponent(token)}`, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
});

app.get("/api/v1/files/:attachmentId", (request, response) => {
  const verified = verifyFileToken(String(request.query.token || ""));
  if (!verified || verified.attachmentId !== request.params.attachmentId) {
    response.status(403).json({ error: { code: "FILE_TOKEN_INVALID", message: "文件访问链接已失效，请重新获取" } });
    return;
  }
  const taskSource = taskPdfSource(verified.attachmentId);
  if (taskSource && verified.disposition === "inline") {
    audit.record({ action: "STREAM_TASK_PDF", cvId: taskSource.cvId, attachmentId: verified.attachmentId, actor: actor(request) });
    streamTaskPdf(taskSource, response, (error) => { if (!response.headersSent) response.status(500).json({ error: { code: "TASK_PDF_READ_FAILED", message: "任务PDF暂时无法读取" } }); else response.destroy(error as Error); });
    return;
  }
  const attachment = peopleRepository.getAttachment(verified.attachmentId);
  if (!attachment?.path || !fs.existsSync(attachment.path)) {
    response.status(404).json({ error: { code: "FILE_NOT_FOUND", message: "附件文件不存在" } });
    return;
  }
  if (verified.disposition === "inline" && !attachment.previewable) {
    response.status(415).json({ error: { code: "PREVIEW_UNSUPPORTED", message: "该文件格式不支持在线预览" } });
    return;
  }
  const fileName = (attachment.originalName || `${attachment.cvId}-${attachment.kind}`).replace(/[\r\n"\\/]/g, "_");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Type", attachment.mimeType || mime.lookup(attachment.path) || "application/octet-stream");
  response.setHeader("Content-Disposition", `${verified.disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  audit.record({
    action: verified.disposition === "inline" ? "STREAM_ATTACHMENT_PREVIEW" : "DOWNLOAD_ATTACHMENT",
    cvId: attachment.cvId,
    attachmentId: attachment.id,
    actor: actor(request),
  });
  response.sendFile(attachment.path);
});

app.get("/api/v1/import-batches", (_request, response) => {
  response.json({ items: importService.list() });
});

app.get("/api/v1/incoming-batches", async (_request, response, next) => {
  try { response.json({ items: await incomingConsumer.list() }); }
  catch (error) { next(error); }
});

app.get("/api/v1/import-batches/:batchId", (request, response) => {
  const batch = importService.get(request.params.batchId);
  if (!batch) {
    response.status(404).json({ error: { code: "BATCH_NOT_FOUND", message: "未找到该导入批次" } });
    return;
  }
  response.json(batch);
});

app.post(
  "/api/v1/import-batches/preflight",
  upload.fields([
    { name: "excel", maxCount: 1 },
    { name: "attachments", maxCount: 1 },
  ]),
  async (request, response, next) => {
    const files = request.files as Record<string, Express.Multer.File[]> | undefined;
    const excel = files?.excel?.[0];
    const attachments = files?.attachments?.[0];
    if (!excel || !attachments) {
      response.status(400).json({ error: { code: "FILES_REQUIRED", message: "请同时上传 Excel 和 ZIP 附件包" } });
      return;
    }
    try {
      const excelMagic = fs.readFileSync(excel.path).subarray(0, 8).toString("hex");
      const zipMagic = fs.readFileSync(attachments.path).subarray(0, 4).toString("hex");
      if (!excelMagic.startsWith("d0cf11e0") && !excelMagic.startsWith("504b0304")) throw new Error("Excel 文件类型与内容不一致");
      if (!zipMagic.startsWith("504b")) throw new Error("附件包不是有效 ZIP 文件");
      const batch = await importService.preflight(
        excel.path,
        attachments.path,
        String(request.body?.name || "Bayt 导入批次").slice(0, 80),
      );
      audit.record({ action: "IMPORT_PREFLIGHT", detail: batch.id, actor: actor(request) });
      response.status(201).json(batch);
    } catch (error) {
      next(error);
    } finally {
      for (const file of [excel, attachments]) {
        try {
          fs.unlinkSync(file.path);
        } catch {
          // Multer temporary file may already be moved or cleaned up.
        }
      }
    }
  },
);

app.post("/api/v1/import-batches/:batchId/commit", async (request, response, next) => {
  try {
    if (importService.get(request.params.batchId)?.source === "LOCAL_COLLECTOR") {
      response.status(409).json({ error: { code: "AUTO_IMPORT_MANAGED", message: "本机采集批次由接收器自动提交" } });
      return;
    }
    const batch = await importService.commit(request.params.batchId);
    audit.record({ action: "IMPORT_COMMIT", detail: batch.id, actor: actor(request) });
    if (config.researchAutoRun) {
      try {
        const run = researchService.createRun({ executeResearch: true });
        audit.record({ action: "RESEARCH_AUTO_RUN", detail: run.id, actor: actor(request) });
      } catch (error) {
        console.warn("research_auto_run_skipped", error instanceof Error ? error.message : "unknown");
      }
    }
    response.json(batch);
  } catch (error) {
    next(error);
  }
});

app.get("/api/v1/research-jobs", (_request, response) => {
  response.json(researchService.dashboard());
});

app.get("/api/v1/research-jobs/:cvId", (request, response) => {
  const item = researchService.getCase(request.params.cvId);
  if (!item) {
    response.status(404).json({ error: { code: "RESEARCH_CASE_NOT_FOUND", message: "该人物尚未执行评分" } });
    return;
  }
  response.json(item);
});

app.put("/api/v1/research-policy", (request, response, next) => {
  try {
    const policy = researchService.updatePolicy(request.body as ResearchPolicy);
    audit.record({ action: "RESEARCH_POLICY_UPDATE", detail: policy.id, actor: actor(request) });
    response.json(policy);
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1/research-runs", (request, response, next) => {
  try {
    const run = researchService.createRun({ executeResearch: request.body?.executeResearch !== false });
    audit.record({ action: "RESEARCH_RUN_START", detail: run.id, actor: actor(request) });
    response.status(202).json(run);
  } catch (error) {
    next(error);
  }
});

app.get("/api/v1/research-runs/:runId", (request, response) => {
  const run = researchService.getRun(request.params.runId);
  if (!run) {
    response.status(404).json({ error: { code: "RESEARCH_RUN_NOT_FOUND", message: "研究任务不存在" } });
    return;
  }
  response.json(run);
});

app.use("/api/v1/collector", createCollectorControlRouter(
  collectorControl,
  requireCollectorBrowserMutation,
  (request, action, detail) => audit.record({ action, actor: actor(request), detail }),
));

app.get("/api/v1/collector/tasks", async (_request, response, next) => {
  try { response.json(await collectorRequest("/tasks")); } catch (error) { next(error); }
});

app.post("/api/v1/collector/tasks", requireCollectorBrowserMutation, async (request, response, next) => {
  try {
    const result = await collectorRequest("/tasks", { method: "POST", body: JSON.stringify(request.body || {}) });
    audit.record({ action: "COLLECTOR_TASK_CREATE", actor: actor(request), detail: JSON.stringify(request.body || {}).slice(0, 500) });
    response.status(201).json(result);
  } catch (error) { next(error); }
});

app.patch("/api/v1/collector/tasks/:id", requireCollectorBrowserMutation, async (request, response, next) => {
  try {
    const id = String(request.params.id);
    const result = await collectorRequest(`/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(request.body || {}) });
    audit.record({ action: "COLLECTOR_TASK_UPDATE", actor: actor(request), detail: id });
    response.json(result);
  } catch (error) { next(error); }
});

app.post("/api/v1/collector/tasks/:id/run", requireCollectorBrowserMutation, async (request, response, next) => {
  try {
    const id = String(request.params.id);
    const result = await collectorRequest(`/tasks/${encodeURIComponent(id)}/run`, { method: "POST", body: JSON.stringify(request.body || {}) });
    audit.record({ action: "COLLECTOR_RUN_START", actor: actor(request), detail: id });
    response.status(202).json(result);
  } catch (error) { next(error); }
});

app.get("/api/v1/collector/runs", async (request, response, next) => {
  try { response.json(await collectorRequest(`/runs?limit=${encodeURIComponent(String(request.query.limit || 100))}`)); } catch (error) { next(error); }
});

app.get("/api/v1/collector/runs/:id", async (request, response, next) => {
  try { response.json(await collectorRequest(`/runs/${encodeURIComponent(String(request.params.id))}`)); } catch (error) { next(error); }
});

app.get("/api/v1/collector/runs/:id/captures", async (request, response, next) => {
  try { response.json(await collectorRequest(`/runs/${encodeURIComponent(String(request.params.id))}/captures`)); } catch (error) { next(error); }
});

for (const action of ["pause", "resume"] as const) {
  app.post(`/api/v1/collector/runs/:id/${action}`, requireCollectorBrowserMutation, async (request, response, next) => {
    try {
      const id = String(request.params.id);
      const result = await collectorRequest(`/runs/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
      audit.record({ action: `COLLECTOR_RUN_${action.toUpperCase()}`, actor: actor(request), detail: id });
      response.json(result);
    } catch (error) { next(error); }
  });
}

app.post("/api/v1/collector/login-sessions", requireCollectorBrowserMutation, async (request, response, next) => {
  try {
    const session = await collectorRequest<{ token: string; expiresAt: string }>("/login-sessions", { method: "POST", body: "{}" });
    audit.record({ action: "COLLECTOR_LOGIN_SESSION", actor: actor(request) });
    response.status(201).json({
      url: `/collector-console/vnc.html?autoconnect=1&resize=scale&path=collector-console%2Fwebsockify&token=${encodeURIComponent(session.token)}`,
      expiresAt: session.expiresAt,
    });
  } catch (error) { next(error); }
});

app.get("/api/v1/collector/console-auth", async (request, response) => {
  const original = String(request.headers["x-original-uri"] || "");
  let token = String(request.query.token || "");
  try { if (!token && original) token = new URL(original, "https://collector.local").searchParams.get("token") || ""; } catch { token = ""; }
  try {
    await collectorRequest(`/console-auth?token=${encodeURIComponent(token)}`);
    response.sendStatus(204);
  } catch {
    response.sendStatus(403);
  }
});

const staticDirectory = path.join(config.projectDirectory, "dist");
if (fs.existsSync(staticDirectory)) {
  app.use(express.static(staticDirectory, { index: false, maxAge: "1h" }));
  app.get("/{*path}", (_request, response) => response.sendFile(path.join(staticDirectory, "index.html")));
}

app.use(collectorRouteError);
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "系统处理失败";
  console.error("request_failed", message);
  if (error instanceof CollectorClientError) {
    response.status(error.status).json({ error: { code: error.code, message } });
    return;
  }
  response.status(400).json({ error: { code: "REQUEST_FAILED", message } });
});

await importService.initializeBuiltInSample();

if (process.env.NODE_ENV !== "test") {
  void incomingConsumer.scan().catch((error) => console.error("incoming_scan_failed", error instanceof Error ? error.message : String(error)));
  setInterval(() => {
    void incomingConsumer.scan().catch((error) => console.error("incoming_scan_failed", error instanceof Error ? error.message : String(error)));
  }, 30_000).unref();
  collectorControl.triggerDueSchedules();
  setInterval(() => {
    try {
      collectorControl.triggerDueSchedules();
      collectorControl.recoverExpiredLeases();
    } catch (error) {
      console.error("collector_scheduler_failed", error instanceof Error ? error.message : String(error));
    }
  }, 30_000).unref();
  app.listen(config.port, config.host, () => {
    console.log(`Bayt Intelligence listening on http://${config.host}:${config.port}`);
  });
}

export { app, collectorControl, importService, peopleRepository, researchService };
