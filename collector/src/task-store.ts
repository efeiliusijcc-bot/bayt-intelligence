/**
 * 旧版采集Worker的轻量任务队列与状态存储，底层使用SQLite。
 * 它管理“任务模板”和“每次运行”两个层次，不直接控制浏览器。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONTROL_DATABASE_PATH, nowIso } from "./config.ts";

// 模板级状态：反映一个长期任务当前是否空闲、排队、运行或被安全暂停。
export type TaskStatus =
  | "idle"
  | "queued"
  | "running"
  | "paused"
  | "login_required"
  | "rate_limited"
  | "failed"
  | "disabled";

// 单次运行级状态，比模板多出验收和发布阶段。
export type WorkerRunStatus =
  | "queued"
  | "running"
  | "verifying"
  | "publishing"
  | "completed"
  | "paused"
  | "login_required"
  | "rate_limited"
  | "failed";

/** 数据库中的长期采集任务转换成前端容易使用的驼峰字段。 */
export interface CollectorTask {
  id: string;
  name: string;
  query: string;
  filters: Record<string, unknown>;
  scheduleHour: number;
  timezone: "Asia/Shanghai";
  maxPerRun: number;
  enabled: boolean;
  status: TaskStatus;
  cursorPage: number;
  preflightStatus: "required" | "passed" | "failed";
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 一次实际执行记录；同一个CollectorTask可以产生多次WorkerRun。 */
export interface WorkerRun {
  id: string;
  taskId: string;
  collectionRunId: string;
  mode: "preflight" | "scheduled" | "manual" | "resume";
  status: WorkerRunStatus;
  targetCount: number;
  uniqueCount: number;
  startPage: number;
  currentPage: number;
  pauseRequested: boolean;
  captureSummaryPath: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** 将SQLite的snake_case行转换成TypeScript的CollectorTask对象。 */
const taskFromRow = (row: Record<string, unknown>): CollectorTask => ({
  id: String(row.id),
  name: String(row.name),
  query: String(row.query),
  filters: JSON.parse(String(row.filters_json || "{}")) as Record<string, unknown>,
  scheduleHour: Number(row.schedule_hour),
  timezone: "Asia/Shanghai",
  maxPerRun: Number(row.max_per_run),
  enabled: Boolean(row.enabled),
  status: String(row.status) as TaskStatus,
  cursorPage: Number(row.cursor_page),
  preflightStatus: String(row.preflight_status) as CollectorTask["preflightStatus"],
  lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
  nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

/** 将SQLite运行记录转换成WorkerRun对象。 */
const runFromRow = (row: Record<string, unknown>): WorkerRun => ({
  id: String(row.id),
  taskId: String(row.task_id),
  collectionRunId: String(row.collection_run_id),
  mode: String(row.mode) as WorkerRun["mode"],
  status: String(row.status) as WorkerRunStatus,
  targetCount: Number(row.target_count),
  uniqueCount: Number(row.unique_count),
  startPage: Number(row.start_page),
  currentPage: Number(row.current_page),
  pauseRequested: Boolean(row.pause_requested),
  captureSummaryPath: row.capture_summary_path ? String(row.capture_summary_path) : null,
  error: row.error ? String(row.error) : null,
  createdAt: String(row.created_at),
  startedAt: row.started_at ? String(row.started_at) : null,
  completedAt: row.completed_at ? String(row.completed_at) : null,
});

/** 封装控制数据库的建表、查询和状态变更。 */
export class TaskStore {
  readonly db: DatabaseSync;

  /** 打开数据库并按需创建表。构造函数在`new TaskStore()`时自动执行。 */
  constructor(databasePath = CONTROL_DATABASE_PATH) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    // 反引号允许书写多行SQL；IF NOT EXISTS让重复启动保持幂等。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collector_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        query TEXT NOT NULL,
        filters_json TEXT NOT NULL DEFAULT '{}',
        schedule_hour INTEGER NOT NULL DEFAULT 2,
        max_per_run INTEGER NOT NULL DEFAULT 500,
        enabled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'disabled',
        cursor_page INTEGER NOT NULL DEFAULT 1,
        preflight_status TEXT NOT NULL DEFAULT 'required',
        last_run_at TEXT,
        next_run_at TEXT,
        last_scheduled_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collector_worker_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        collection_run_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        target_count INTEGER NOT NULL,
        unique_count INTEGER NOT NULL DEFAULT 0,
        start_page INTEGER NOT NULL DEFAULT 1,
        current_page INTEGER NOT NULL DEFAULT 0,
        pause_requested INTEGER NOT NULL DEFAULT 0,
        capture_summary_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (task_id) REFERENCES collector_tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_worker_runs_status ON collector_worker_runs(status, created_at);
    `);
  }

  /** 释放SQLite连接。 */
  close(): void {
    this.db.close();
  }

  /** 列出全部任务模板，最新创建的排在前面。 */
  listTasks(): CollectorTask[] {
    return (this.db.prepare("SELECT * FROM collector_tasks ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(taskFromRow);
  }

  /** 按ID读取一个任务；查不到时返回null。 */
  getTask(id: string): CollectorTask | null {
    const row = this.db.prepare("SELECT * FROM collector_tasks WHERE id = ?").get(id);
    return row ? taskFromRow(row as Record<string, unknown>) : null;
  }

  /** 创建默认禁用的任务，必须完成10人预检后才能启用定时。 */
  createTask(input: { name: string; query: string; filters?: Record<string, unknown>; maxPerRun?: number }): CollectorTask {
    const now = nowIso();
    const id = `task-${crypto.randomUUID()}`;
    const maxPerRun = Math.max(1, Math.min(500, Math.trunc(input.maxPerRun || 500)));
    this.db.prepare(`INSERT INTO collector_tasks (
      id, name, query, filters_json, max_per_run, enabled, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 'disabled', ?, ?)`)
      .run(id, input.name.slice(0, 80), input.query.slice(0, 160), JSON.stringify(input.filters || {}), maxPerRun, now, now);
    return this.getTask(id)!; // `!`告诉TypeScript：刚插入的记录在这里一定存在。
  }

  /** 局部更新任务。`Partial<T>`表示T中的每个字段都变成可选。 */
  updateTask(id: string, input: Partial<{ name: string; query: string; filters: Record<string, unknown>; maxPerRun: number; enabled: boolean }>): CollectorTask {
    const current = this.getTask(id);
    if (!current) throw new Error("Collector task was not found");
    // `??`只在左边为null/undefined时使用右边；false不会被误当成空值。
    const enabled = input.enabled ?? current.enabled;
    if (enabled && current.preflightStatus !== "passed") throw new Error("10-person preflight must pass before scheduling is enabled");
    this.db.prepare(`UPDATE collector_tasks SET
      name = ?, query = ?, filters_json = ?, max_per_run = ?, enabled = ?, status = ?, updated_at = ?
      WHERE id = ?`)
      .run(
        (input.name ?? current.name).slice(0, 80),
        (input.query ?? current.query).slice(0, 160),
        JSON.stringify(input.filters ?? current.filters),
        Math.max(1, Math.min(500, Math.trunc(input.maxPerRun ?? current.maxPerRun))),
        enabled ? 1 : 0,
        enabled ? (current.status === "disabled" ? "idle" : current.status) : "disabled",
        nowIso(),
        id,
      );
    return this.getTask(id)!;
  }

  /** 列出最近的运行记录，并限制最大返回数量。 */
  listRuns(limit = 100): WorkerRun[] {
    return (this.db.prepare("SELECT * FROM collector_worker_runs ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(runFromRow);
  }

  /** 按ID读取一次运行。 */
  getRun(id: string): WorkerRun | null {
    const row = this.db.prepare("SELECT * FROM collector_worker_runs WHERE id = ?").get(id);
    return row ? runFromRow(row as Record<string, unknown>) : null;
  }

  /** 将一次运行加入队列，同一任务不允许同时存在两个活跃运行。 */
  queueRun(taskId: string, mode: WorkerRun["mode"], targetCount: number): WorkerRun {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Collector task was not found");
    const active = this.db.prepare("SELECT id FROM collector_worker_runs WHERE task_id = ? AND status IN ('queued','running','verifying','publishing') LIMIT 1").get(taskId);
    if (active) throw new Error("This task already has an active run");
    const id = `run-${crypto.randomUUID()}`;
    // 恢复时回退两页，用去重逻辑覆盖分页移动造成的边界变化。
    const startPage = mode === "preflight" ? 1 : Math.max(1, task.cursorPage - 2);
    this.db.prepare(`INSERT INTO collector_worker_runs (
      id, task_id, collection_run_id, mode, status, target_count, start_page, created_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`)
      .run(id, taskId, id, mode, Math.max(1, Math.min(500, targetCount)), startPage, nowIso());
    this.db.prepare("UPDATE collector_tasks SET status = 'queued', updated_at = ? WHERE id = ?").run(nowIso(), taskId);
    return this.getRun(id)!;
  }

  /**
   * 原子领取最早排队任务。BEGIN IMMEDIATE防止两个Worker同时领取同一条记录。
   */
  dequeueRun(): WorkerRun | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM collector_worker_runs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as Record<string, unknown> | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const now = nowIso();
      this.db.prepare("UPDATE collector_worker_runs SET status = 'running', started_at = ?, pause_requested = 0 WHERE id = ?").run(now, row.id as string);
      this.db.prepare("UPDATE collector_tasks SET status = 'running', last_run_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.task_id as string);
      this.db.exec("COMMIT");
      return this.getRun(String(row.id));
    } catch (error) {
      // 事务中任何一步失败都回滚，数据库不会停留在半更新状态。
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 动态更新运行字段；字段名通过白名单mapping转换为数据库列名。 */
  updateRun(id: string, fields: Partial<{ status: WorkerRunStatus; uniqueCount: number; currentPage: number; captureSummaryPath: string | null; error: string | null; completedAt: string | null }>): WorkerRun {
    const mapping: Record<string, string> = { status: "status", uniqueCount: "unique_count", currentPage: "current_page", captureSummaryPath: "capture_summary_path", error: "error", completedAt: "completed_at" };
    const entries = Object.entries(fields);
    if (entries.length) {
      this.db.prepare(`UPDATE collector_worker_runs SET ${entries.map(([key]) => `${mapping[key]} = ?`).join(", ")} WHERE id = ?`)
        // `...`把值数组展开为run的多个参数；`[, value]`忽略键只取值。
        .run(...entries.map(([, value]) => value), id);
    }
    return this.getRun(id)!;
  }

  /** 结束一次运行，并同步更新长期任务的状态、游标和预检结果。 */
  finishRun(id: string, status: WorkerRunStatus, input: { uniqueCount?: number; currentPage?: number; error?: string | null; captureSummaryPath?: string | null } = {}): WorkerRun {
    const run = this.getRun(id);
    if (!run) throw new Error("Collector run was not found");
    const now = nowIso();
    this.updateRun(id, { status, uniqueCount: input.uniqueCount ?? run.uniqueCount, currentPage: input.currentPage ?? run.currentPage, error: input.error ?? null, captureSummaryPath: input.captureSummaryPath ?? run.captureSummaryPath, completedAt: now });
    const taskStatus: TaskStatus = status === "completed" ? "idle" : status === "rate_limited" || status === "login_required" || status === "paused" ? status : "failed";
    this.db.prepare("UPDATE collector_tasks SET status = ?, cursor_page = ?, preflight_status = CASE WHEN ? = 'preflight' THEN ? ELSE preflight_status END, updated_at = ? WHERE id = ?")
      .run(taskStatus, Math.max(1, input.currentPage ?? run.currentPage), run.mode, status === "completed" ? "passed" : "failed", now, run.taskId);
    return this.getRun(id)!;
  }

  /** 设置“请求暂停”标记；运行中的循环会主动读取并在安全点退出。 */
  requestPause(id: string): WorkerRun {
    const run = this.getRun(id);
    if (!run) throw new Error("Collector run was not found");
    this.db.prepare("UPDATE collector_worker_runs SET pause_requested = 1 WHERE id = ?").run(id);
    return this.getRun(id)!;
  }

  /** 把允许恢复的终态重新放回队列。 */
  resumeRun(id: string): WorkerRun {
    const run = this.getRun(id);
    if (!run || !["paused", "login_required", "rate_limited", "failed"].includes(run.status)) throw new Error("Collector run is not resumable");
    this.db.prepare("UPDATE collector_worker_runs SET mode = 'resume', status = 'queued', error = NULL, completed_at = NULL, pause_requested = 0 WHERE id = ?").run(id);
    this.db.prepare("UPDATE collector_tasks SET status = 'queued', updated_at = ? WHERE id = ?").run(nowIso(), run.taskId);
    return this.getRun(id)!;
  }

  /** 供执行循环快速查询管理员是否要求暂停。 */
  isPauseRequested(id: string): boolean {
    const row = this.db.prepare("SELECT pause_requested FROM collector_worker_runs WHERE id = ?").get(id) as { pause_requested?: number } | undefined;
    return Boolean(row?.pause_requested);
  }

  /** 统计指定时间窗口内已完成的唯一人数，用于每日上限。 */
  dailyCompletedCount(startIso: string, endIso: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(unique_count), 0) AS total FROM collector_worker_runs WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?").get(startIso, endIso) as { total: number };
    return Number(row.total);
  }

  /** 北京时间02:00后把当天尚未调度的合格任务依次加入队列。 */
  enqueueDueTasks(beijingDate: string, hour: number, dailyRemaining: number): void {
    if (hour < 2 || dailyRemaining <= 0) return;
    const tasks = this.db.prepare("SELECT id, max_per_run FROM collector_tasks WHERE enabled = 1 AND status = 'idle' AND preflight_status = 'passed' AND COALESCE(last_scheduled_date, '') <> ? ORDER BY created_at").all(beijingDate) as { id: string; max_per_run: number }[];
    let remaining = dailyRemaining;
    // 串行分配剩余额度，额度耗尽就停止继续入队。
    for (const task of tasks) {
      if (remaining <= 0) break;
      const target = Math.min(remaining, Number(task.max_per_run));
      this.queueRun(task.id, "scheduled", target);
      this.db.prepare("UPDATE collector_tasks SET last_scheduled_date = ?, updated_at = ? WHERE id = ?").run(beijingDate, nowIso(), task.id);
      remaining -= target;
    }
  }

  /** 签发短期控制台令牌；数据库只保存SHA-256，不保存明文令牌。 */
  issueConsoleSession(ttlMs = 15 * 60 * 1000): { token: string; expiresAt: string } {
    this.db.exec(`CREATE TABLE IF NOT EXISTS collector_console_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`);
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db.prepare("INSERT INTO collector_console_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)").run(crypto.createHash("sha256").update(token).digest("hex"), expiresAt, nowIso());
    return { token, expiresAt };
  }

  /** 对传入令牌计算同样哈希，并确认记录存在且没有过期。 */
  validateConsoleSession(token: string): boolean {
    if (!token) return false;
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const row = this.db.prepare("SELECT expires_at FROM collector_console_sessions WHERE token_hash = ?").get(hash) as { expires_at?: string } | undefined;
    return Boolean(row?.expires_at && Date.parse(row.expires_at) > Date.now());
  }
}
