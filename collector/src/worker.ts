/**
 * 旧版云端Worker HTTP服务：提供任务API、串行执行、抓包摘要和发布快照。
 * Express负责HTTP路由；TaskStore负责SQLite；collector.ts负责实际采集。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import { login, runCollection } from "./collector.ts";
import { sanitizeHar, purgeExpiredCaptures } from "./capture.ts";
import { publishVerifiedSnapshot } from "./publisher.ts";
import { LoginRequiredError, SafetyStopError } from "./bayt.ts";
import { TaskStore, type WorkerRunStatus } from "./task-store.ts";
import { CAPTURES_DIR } from "./config.ts";

// 服务监听地址和API令牌。生产环境强制要求至少32字符。
const port = Number(process.env.PORT || 4191);
const host = process.env.HOST || "0.0.0.0";
const apiToken = process.env.COLLECTOR_API_TOKEN || "";
if (process.env.NODE_ENV === "production" && apiToken.length < 32) {
  throw new Error("Production requires COLLECTOR_API_TOKEN with at least 32 characters");
}

// 单例数据库和Express应用；busy是进程内串行锁，防止同时跑两个任务。
const store = new TaskStore();
const app = express();
let busy = false;

// 基础中间件：隐藏框架标识、限制JSON体积，并提供不鉴权的健康检查。
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.get("/health", (_request, response) => response.json({ status: "ok", service: "bayt-collector-worker", busy }));

// 后续路由统一校验Bearer Token；timingSafeEqual减少按比较耗时猜令牌的风险。
app.use((request, response, next) => {
  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const expected = Buffer.from(apiToken);
  const actual = Buffer.from(supplied);
  if (!expected.length || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    response.status(401).json({ error: { code: "WORKER_UNAUTHORIZED", message: "Worker authorization failed" } });
    return;
  }
  next();
});

// 任务模板API：查询、创建、修改和手动入队。
app.get("/tasks", (_request, response) => response.json({ items: store.listTasks() }));
app.post("/tasks", (request, response) => {
  const name = String(request.body?.name || "").trim();
  const query = String(request.body?.query || "").trim();
  if (!name || !query) {
    response.status(400).json({ error: { code: "TASK_FIELDS_REQUIRED", message: "Task name and query are required" } });
    return;
  }
  response.status(201).json(store.createTask({ name, query, filters: request.body?.filters, maxPerRun: request.body?.maxPerRun }));
});
app.patch("/tasks/:id", (request, response, next) => {
  try {
    response.json(store.updateTask(request.params.id, request.body || {}));
  } catch (error) { next(error); }
});
app.post("/tasks/:id/run", (request, response, next) => {
  try {
    const task = store.getTask(request.params.id);
    if (!task) { response.status(404).json({ error: { code: "TASK_NOT_FOUND", message: "Collector task was not found" } }); return; }
    const mode = request.body?.mode === "preflight" ? "preflight" : "manual";
    response.status(202).json(store.queueRun(task.id, mode, mode === "preflight" ? 10 : task.maxPerRun));
    void tick();
  } catch (error) { next(error); }
});

// 单次运行API：查看状态、暂停、恢复和读取脱敏抓包摘要。
app.get("/runs", (request, response) => response.json({ items: store.listRuns(Math.min(200, Number(request.query.limit || 100))) }));
app.get("/runs/:id", (request, response) => {
  const run = store.getRun(request.params.id);
  if (!run) { response.status(404).json({ error: { code: "RUN_NOT_FOUND", message: "Collector run was not found" } }); return; }
  response.json(run);
});
app.post("/runs/:id/pause", (request, response, next) => {
  try { response.json(store.requestPause(request.params.id)); } catch (error) { next(error); }
});
app.post("/runs/:id/resume", (request, response, next) => {
  try { response.json(store.resumeRun(request.params.id)); void tick(); } catch (error) { next(error); }
});
app.get("/runs/:id/captures", (request, response) => {
  const run = store.getRun(request.params.id);
  if (!run) { response.status(404).json({ error: { code: "RUN_NOT_FOUND", message: "Collector run was not found" } }); return; }
  if (!run.captureSummaryPath || !fs.existsSync(run.captureSummaryPath)) { response.json({ runId: run.id, entries: [] }); return; }
  response.type("application/json").sendFile(run.captureSummaryPath);
});

// 登录会话API：只有Worker空闲时才打开交互式浏览器，并返回短期控制台令牌。
app.post("/login-sessions", (_request, response) => {
  if (busy) { response.status(409).json({ error: { code: "WORKER_BUSY", message: "Collector worker is currently busy" } }); return; }
  const session = store.issueConsoleSession();
  busy = true;
  void login().catch((error) => process.stderr.write(`interactive_login_failed: ${error instanceof Error ? error.message : String(error)}\n`)).finally(() => { busy = false; });
  response.status(201).json(session);
});
app.get("/console-auth", (request, response) => {
  if (!store.validateConsoleSession(String(request.query.token || ""))) { response.sendStatus(403); return; }
  response.sendStatus(204);
});

// Express错误处理中间件必须有4个参数；所有路由异常最终变成统一JSON。
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Worker request failed";
  response.status(/not found/i.test(message) ? 404 : 400).json({ error: { code: "WORKER_REQUEST_FAILED", message } });
});

/** 计算当前北京时间自然日的起止ISO时间，供每日500人上限使用。 */
function beijingWindow(now = new Date()): { date: string; hour: number; startIso: string; endIso: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  // 内部小函数value从formatToParts数组中按类型取年、月、日、小时。
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  const start = new Date(`${date}T00:00:00+08:00`);
  return { date, hour: Number(value("hour")), startIso: start.toISOString(), endIso: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString() };
}

/** 把不同异常映射成前端可理解的运行状态。 */
function classifyStatus(error: unknown): WorkerRunStatus {
  if (error instanceof LoginRequiredError) return "login_required";
  if (error instanceof SafetyStopError) {
    if (error.reason === "operator_pause") return "paused";
    if (error.reason.includes("rate_limit") || error.reason.includes("captcha")) return "rate_limited";
    return "paused";
  }
  return "failed";
}

/** 领取并完整处理一个队列任务；无任务时直接返回。 */
async function processNextRun(): Promise<void> {
  const queued = store.dequeueRun();
  if (!queued) return;
  const task = store.getTask(queued.taskId)!;
  try {
    // 将任务模式转换为底层采集命令，并注入“是否请求暂停”的回调。
    const collection = await runCollection({
      command: queued.mode === "resume" ? "resume" : queued.mode === "preflight" ? "preflight" : "collect",
      runId: queued.collectionRunId,
      target: queued.targetCount,
      query: task.query,
      headless: queued.mode !== "preflight",
      incremental: queued.mode !== "preflight",
      allowPartial: queued.mode !== "preflight",
      startPage: queued.startPage,
      capture: true,
      shouldPause: () => store.isPauseRequested(queued.id),
    });
    store.updateRun(queued.id, { status: "verifying", uniqueCount: collection.uniqueCount, currentPage: collection.currentPage });
    const captureSummaryPath = await sanitizeHar(queued.collectionRunId);
    // 10人预检只验证流程，不发布为正式数据版本。
    if (queued.mode !== "preflight") {
      store.updateRun(queued.id, { status: "publishing" });
      await publishVerifiedSnapshot(queued.id);
    }
    store.finishRun(queued.id, "completed", { uniqueCount: collection.uniqueCount, currentPage: collection.currentPage, captureSummaryPath });
  } catch (error) {
    // 即使失败也尽量生成脱敏抓包摘要，再保存明确失败状态。
    const captureSummaryPath = await sanitizeHar(queued.collectionRunId);
    store.finishRun(queued.id, classifyStatus(error), { error: error instanceof Error ? error.message : String(error), captureSummaryPath });
  }
}

/** 单次调度心跳：清理过期抓包、计算额度、加入到期任务、串行处理一个任务。 */
async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await purgeExpiredCaptures();
    const window = beijingWindow();
    const dailyRemaining = Math.max(0, 500 - store.dailyCompletedCount(window.startIso, window.endIso));
    store.enqueueDueTasks(window.date, window.hour, dailyRemaining);
    await processNextRun();
  } finally {
    // finally保证异常后也释放busy锁，否则Worker会永久显示忙碌。
    busy = false;
  }
}

// 顶层启动顺序：先清理旧抓包，再监听HTTP，每30秒触发一次调度并立即首轮执行。
await purgeExpiredCaptures();
app.listen(port, host, () => process.stdout.write(`bayt-collector-worker listening on ${host}:${port}; captures=${CAPTURES_DIR}\n`));
setInterval(() => void tick(), 30_000).unref();
void tick();
