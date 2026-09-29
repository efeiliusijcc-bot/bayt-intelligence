/**
 * 采集业务数据库访问层。
 * 所有SQL都集中在这里：上层只调用方法，不需要知道表名和snake_case字段。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { DATABASE_PATH, nowIso } from "./config.ts";
import type {
  CandidateRecord,
  DocumentRecord,
  ItemStatus,
  ListingCandidate,
  RunRecord,
  RunStatus,
} from "./types.ts";

// SQLite参数允许的基础类型；不把任意对象直接交给SQL。
type SqlValue = string | number | bigint | null;

/** 将SQLite返回的一行转换成应用里的RunRecord。 */
const toRun = (row: Record<string, unknown>): RunRecord => ({
  runId: String(row.run_id),
  command: String(row.command),
  query: String(row.query),
  targetCount: Number(row.target_count),
  status: String(row.status) as RunStatus,
  searchId: row.search_id === null ? null : String(row.search_id),
  filtersJson: row.filters_json === null ? null : String(row.filters_json),
  currentPage: Number(row.current_page),
  uniqueCount: Number(row.unique_count),
  startedAt: String(row.started_at),
  updatedAt: String(row.updated_at),
  completedAt: row.completed_at === null ? null : String(row.completed_at),
  error: row.error === null ? null : String(row.error),
});

/** 封装采集库的建表、写入、查询和统计。 */
export class CollectorDatabase {
  readonly db: DatabaseSync;

  /** 打开数据库、启用WAL/外键/忙等待，并执行幂等迁移。 */
  constructor(databasePath = DATABASE_PATH) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  /** 关闭数据库文件句柄。 */
  close(): void {
    this.db.close();
  }

  /**
   * 创建所需表和索引。`IF NOT EXISTS`意味着重复执行不会删除旧数据。
   * 表职责：runs存任务，batches存批次，candidates存人员，documents存文件，events存审计事件。
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collection_runs (
        run_id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        query TEXT NOT NULL,
        target_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        search_id TEXT,
        filters_json TEXT,
        current_page INTEGER NOT NULL DEFAULT 0,
        unique_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS batches (
        run_id TEXT NOT NULL,
        batch_no INTEGER NOT NULL,
        page_no INTEGER NOT NULL,
        status TEXT NOT NULL,
        candidate_ids_json TEXT NOT NULL,
        xls_path TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        PRIMARY KEY (run_id, batch_no),
        FOREIGN KEY (run_id) REFERENCES collection_runs(run_id)
      );

      CREATE TABLE IF NOT EXISTS candidates (
        cv_id TEXT PRIMARY KEY,
        name TEXT,
        profile_url TEXT,
        last_cv_update TEXT,
        excel_json TEXT,
        web_json TEXT,
        content_hash TEXT,
        avatar_status TEXT NOT NULL DEFAULT 'missing',
        avatar_url TEXT,
        avatar_hash TEXT,
        avatar_checked_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_candidates (
        run_id TEXT NOT NULL,
        cv_id TEXT NOT NULL,
        batch_no INTEGER NOT NULL,
        page_no INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, cv_id),
        FOREIGN KEY (run_id) REFERENCES collection_runs(run_id),
        FOREIGN KEY (cv_id) REFERENCES candidates(cv_id)
      );

      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cv_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        original_name TEXT,
        mime_type TEXT,
        extension TEXT,
        path TEXT,
        sha256 TEXT,
        size_bytes INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (cv_id, kind),
        FOREIGN KEY (cv_id) REFERENCES candidates(cv_id),
        FOREIGN KEY (run_id) REFERENCES collection_runs(run_id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        cv_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES collection_runs(run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_run_candidates_status
        ON run_candidates(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_documents_run_status
        ON documents(run_id, status);
    `);
  }

  /** 新建一次运行，初始页数和唯一人数均为0。 */
  startRun(runId: string, command: string, query: string, targetCount: number): RunRecord {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO collection_runs (
        run_id, command, query, target_count, status, current_page,
        unique_count, started_at, updated_at
      ) VALUES (?, ?, ?, ?, 'created', 0, 0, ?, ?)
    `).run(runId, command, query, targetCount, now, now);
    return this.getRun(runId)!;
  }

  /** 按运行ID读取记录。SQL中的`?`是参数占位符，可避免字符串拼接注入。 */
  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM collection_runs WHERE run_id = ?").get(runId);
    return row ? toRun(row as Record<string, unknown>) : null;
  }

  /** 获取最近一条允许恢复的未完成运行。 */
  getLatestResumableRun(): RunRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM collection_runs
      WHERE status IN ('created', 'running', 'login_required', 'paused', 'failed')
      ORDER BY started_at DESC LIMIT 1
    `).get();
    return row ? toRun(row as Record<string, unknown>) : null;
  }

  /** 获取最近一次运行，不限制状态，常用于verify默认目标。 */
  getLatestRun(): RunRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM collection_runs ORDER BY started_at DESC LIMIT 1",
    ).get();
    return row ? toRun(row as Record<string, unknown>) : null;
  }

  /**
   * 只更新调用方提供的运行字段。
   * `Partial<{...}>`使字段可选；mapping是允许更新列的白名单。
   */
  updateRun(
    runId: string,
    fields: Partial<{
      status: RunStatus;
      searchId: string | null;
      filtersJson: string | null;
      currentPage: number;
      uniqueCount: number;
      completedAt: string | null;
      error: string | null;
    }>,
  ): void {
    const mapping: Record<string, string> = {
      status: "status",
      searchId: "search_id",
      filtersJson: "filters_json",
      currentPage: "current_page",
      uniqueCount: "unique_count",
      completedAt: "completed_at",
      error: "error",
    };
    const entries = Object.entries(fields);
    if (!entries.length) return;
    // 动态生成`列 = ?`，实际值仍通过绑定参数传入，不拼进SQL。
    const assignments = entries.map(([key]) => `${mapping[key]} = ?`);
    const values = entries.map(([, value]) => value as SqlValue);
    assignments.push("updated_at = ?");
    values.push(nowIso(), runId);
    this.db.prepare(`UPDATE collection_runs SET ${assignments.join(", ")} WHERE run_id = ?`).run(
      ...values,
    );
  }

  /** 新增或更新一个批次；upsert即“存在则更新，不存在则插入”。 */
  upsertBatch(
    runId: string,
    batchNo: number,
    pageNo: number,
    status: ItemStatus,
    candidateIds: string[],
    xlsPath: string | null = null,
    error: string | null = null,
  ): void {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO batches (
        run_id, batch_no, page_no, status, candidate_ids_json,
        xls_path, started_at, completed_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, batch_no) DO UPDATE SET
        page_no = excluded.page_no,
        status = excluded.status,
        candidate_ids_json = excluded.candidate_ids_json,
        xls_path = COALESCE(excluded.xls_path, batches.xls_path),
        completed_at = excluded.completed_at,
        error = excluded.error
    `).run(
      runId,
      batchNo,
      pageNo,
      status,
      JSON.stringify(candidateIds),
      xlsPath,
      now,
      ["downloaded", "failed", "skipped"].includes(status) ? now : null,
      error,
    );
  }

  /**
   * 把搜索列表候选人同时写入全局candidates和本次run_candidates。
   * 两步使用事务，确保不会只写成功一半。
   */
  upsertListingCandidate(runId: string, batchNo: number, candidate: ListingCandidate): void {
    const now = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO candidates (
          cv_id, name, profile_url, last_cv_update, avatar_status,
          avatar_url, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cv_id) DO UPDATE SET
          name = COALESCE(NULLIF(excluded.name, ''), candidates.name),
          profile_url = COALESCE(excluded.profile_url, candidates.profile_url),
          last_cv_update = COALESCE(excluded.last_cv_update, candidates.last_cv_update),
          avatar_status = excluded.avatar_status,
          avatar_url = COALESCE(excluded.avatar_url, candidates.avatar_url),
          last_seen_at = excluded.last_seen_at
      `).run(
        candidate.cvId,
        candidate.name,
        candidate.profileUrl,
        candidate.lastCvUpdate,
        candidate.avatarStatus,
        candidate.avatarUrl,
        now,
        now,
      );
      this.db.prepare(`
        INSERT INTO run_candidates (
          run_id, cv_id, batch_no, page_no, ordinal, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(run_id, cv_id) DO NOTHING
      `).run(runId, candidate.cvId, batchNo, candidate.pageNo, candidate.ordinal, now);
      this.db.exec("COMMIT");
    } catch (error) {
      // 任意SQL失败都回滚两张表，并把原异常继续抛给上层。
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 用Excel、网页、头像和内容哈希补全候选人主记录。 */
  updateCandidate(record: CandidateRecord): void {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO candidates (
        cv_id, name, profile_url, last_cv_update, excel_json, web_json,
        content_hash, avatar_status, avatar_url, avatar_hash,
        avatar_checked_at, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cv_id) DO UPDATE SET
        name = COALESCE(excluded.name, candidates.name),
        profile_url = COALESCE(excluded.profile_url, candidates.profile_url),
        last_cv_update = COALESCE(excluded.last_cv_update, candidates.last_cv_update),
        excel_json = COALESCE(excluded.excel_json, candidates.excel_json),
        web_json = COALESCE(excluded.web_json, candidates.web_json),
        content_hash = COALESCE(excluded.content_hash, candidates.content_hash),
        avatar_status = excluded.avatar_status,
        avatar_url = COALESCE(excluded.avatar_url, candidates.avatar_url),
        avatar_hash = COALESCE(excluded.avatar_hash, candidates.avatar_hash),
        avatar_checked_at = excluded.avatar_checked_at,
        last_seen_at = excluded.last_seen_at
    `).run(
      record.cvId,
      record.name,
      record.profileUrl,
      record.lastCvUpdate,
      record.excelJson,
      record.webJson,
      record.contentHash,
      record.avatarStatus,
      record.avatarUrl,
      record.avatarHash,
      now,
      now,
      now,
    );
  }

  /** 更新某候选人在本次运行中的处理状态和错误。 */
  setCandidateStatus(runId: string, cvId: string, status: ItemStatus, error: string | null = null): void {
    this.db.prepare(`
      UPDATE run_candidates
      SET status = ?, error = ?, updated_at = ?
      WHERE run_id = ? AND cv_id = ?
    `).run(status, error, nowIso(), runId, cvId);
  }

  /** 新增或更新一份文档索引；同一CV_ID和kind只保留一条当前记录。 */
  upsertDocument(document: DocumentRecord): void {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO documents (
        cv_id, run_id, kind, original_name, mime_type, extension,
        path, sha256, size_bytes, status, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cv_id, kind) DO UPDATE SET
        run_id = excluded.run_id,
        original_name = excluded.original_name,
        mime_type = excluded.mime_type,
        extension = excluded.extension,
        path = excluded.path,
        sha256 = excluded.sha256,
        size_bytes = excluded.size_bytes,
        status = excluded.status,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      document.cvId,
      document.runId,
      document.kind,
      document.originalName,
      document.mimeType,
      document.extension,
      document.path,
      document.sha256,
      document.sizeBytes,
      document.status,
      document.error,
      now,
      now,
    );
  }

  /** 写入结构化审计事件；payload会序列化成JSON文本。 */
  addEvent(runId: string, eventType: string, payload: unknown, cvId: string | null = null): void {
    this.db.prepare(`
      INSERT INTO events (run_id, cv_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, cvId, eventType, payload === undefined ? null : JSON.stringify(payload), nowIso());
  }

  /** 返回仍需处理的候选人，并关联候选人主表中的资料。 */
  getPendingCandidates(runId: string, limit?: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT rc.*, c.name, c.profile_url, c.last_cv_update,
             c.avatar_status, c.avatar_url, c.excel_json, c.web_json
      FROM run_candidates rc
      JOIN candidates c ON c.cv_id = rc.cv_id
      WHERE rc.run_id = ? AND rc.status IN ('pending', 'running', 'failed')
      ORDER BY rc.batch_no, rc.ordinal
      ${limit ? "LIMIT ?" : ""}
    `;
    return (limit
      ? this.db.prepare(sql).all(runId, limit)
      : this.db.prepare(sql).all(runId)) as Array<Record<string, unknown>>;
  }

  /** 统计某次运行已收录的唯一候选人数。 */
  countRunCandidates(runId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM run_candidates WHERE run_id = ?").get(
      runId,
    ) as { count: number };
    return Number(row.count);
  }

  /** 构造CV_ID到状态的Map，便于页面循环中快速去重和跳过已完成项。 */
  getRunCandidateStatuses(runId: string): Map<string, ItemStatus> {
    const rows = this.db.prepare(
      "SELECT cv_id, status FROM run_candidates WHERE run_id = ?",
    ).all(runId) as Array<{ cv_id: string; status: string }>;
    return new Map(rows.map((row) => [row.cv_id, row.status as ItemStatus]));
  }

  /** 取当前最大批次号加1；COALESCE把“还没有批次”的null变为0。 */
  getNextBatchNo(runId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(batch_no), 0) + 1 AS next_batch FROM batches WHERE run_id = ?",
    ).get(runId) as { next_batch: number };
    return Number(row.next_batch);
  }

  /** 按CV_ID读取候选人原始数据库行。 */
  getCandidate(cvId: string): Record<string, unknown> | null {
    return (this.db.prepare("SELECT * FROM candidates WHERE cv_id = ?").get(cvId) as
      | Record<string, unknown>
      | undefined) || null;
  }

  /** 查询某次运行产生的全部文档记录。 */
  getDocumentsForRun(runId: string): Array<Record<string, unknown>> {
    return this.db.prepare(
      "SELECT * FROM documents WHERE run_id = ? ORDER BY cv_id, kind",
    ).all(runId) as Array<Record<string, unknown>>;
  }

  /**
   * 将候选人和多种文档聚合成“一人一行”的manifest数据。
   * SQL中的CASE按文档kind选列，MAX把多行折叠成一行。
   */
  listManifestRows(runId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT
        rc.run_id, rc.batch_no, rc.page_no, rc.ordinal, rc.status AS candidate_status,
        rc.error AS candidate_error, c.cv_id, c.name, c.profile_url,
        c.last_cv_update, c.excel_json, c.web_json, c.content_hash, c.avatar_status, c.avatar_url,
        c.avatar_hash, c.first_seen_at, c.last_seen_at,
        MAX(CASE WHEN d.kind = 'bayt_pdf' THEN d.status END) AS bayt_pdf_status,
        MAX(CASE WHEN d.kind = 'bayt_pdf' THEN d.path END) AS bayt_pdf_path,
        MAX(CASE WHEN d.kind = 'original' THEN d.status END) AS original_status,
        MAX(CASE WHEN d.kind = 'original' THEN d.path END) AS original_path,
        MAX(CASE WHEN d.kind = 'original_pdf' THEN d.status END) AS original_pdf_status,
        MAX(CASE WHEN d.kind = 'original_pdf' THEN d.path END) AS original_pdf_path,
        MAX(CASE WHEN d.kind = 'avatar' THEN d.status END) AS avatar_file_status,
        MAX(CASE WHEN d.kind = 'avatar' THEN d.path END) AS avatar_path
      FROM run_candidates rc
      JOIN candidates c ON c.cv_id = rc.cv_id
      LEFT JOIN documents d ON d.cv_id = c.cv_id
      WHERE rc.run_id = ?
      GROUP BY rc.run_id, rc.batch_no, rc.page_no, rc.ordinal, rc.status,
               rc.error, c.cv_id, c.name, c.profile_url, c.last_cv_update,
               c.content_hash, c.avatar_status, c.avatar_url, c.avatar_hash,
               c.first_seen_at, c.last_seen_at
      ORDER BY rc.batch_no, rc.ordinal
    `).all(runId) as Array<Record<string, unknown>>;
  }

  /** 按候选人状态、文档种类/状态和批次状态生成汇总统计。 */
  summary(runId: string): Record<string, unknown> {
    const candidateCounts = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM run_candidates
      WHERE run_id = ? GROUP BY status ORDER BY status
    `).all(runId);
    const documentCounts = this.db.prepare(`
      SELECT kind, status, COUNT(*) AS count FROM documents
      WHERE run_id = ? GROUP BY kind, status ORDER BY kind, status
    `).all(runId);
    const batchCounts = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM batches
      WHERE run_id = ? GROUP BY status ORDER BY status
    `).all(runId);
    return { candidateCounts, documentCounts, batchCounts };
  }
}
