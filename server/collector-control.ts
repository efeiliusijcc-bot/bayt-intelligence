import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type FilterControlType = "single" | "multi" | "range" | "search" | "unsupported";
export type ScheduleKind = "once" | "daily" | "weekly";
export type CollectionJobStatus =
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "completed"
  | "cancelled"
  | "safety_stopped"
  | "failed";

export interface FilterOption {
  key: string;
  label: string;
}

export interface FilterDefinition {
  key: string;
  label: string;
  controlType: FilterControlType;
  supported: boolean;
  options: FilterOption[];
  valueKind?: "text" | "number";
  reason?: string | null;
}

export interface SortDefinition {
  key: string;
  label: string;
}

export interface FilterCatalog {
  version: string;
  status: "ready" | "stale";
  filters: FilterDefinition[];
  sorts: SortDefinition[];
  synchronizedAt: string;
  agentId: string;
}

export interface FilterSelection {
  key: string;
  optionKeys?: string[];
  value?: string;
  min?: number;
  max?: number;
}

export interface SearchSpec {
  keyword: string;
  filterSchemaVersion: string;
  filters: FilterSelection[];
  sortKey: string | null;
}

export interface CollectionLimits {
  targetCount?: number;
  maxPages?: number;
  durationHours?: number;
}

export interface SearchTemplate {
  id: string;
  name: string;
  searchSpec: SearchSpec;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionSchedule {
  id: string;
  name: string;
  templateId: string;
  kind: ScheduleKind;
  timezone: "Asia/Shanghai";
  localTime: string | null;
  weekday: number | null;
  runAt: string | null;
  limits: CollectionLimits;
  enabled: boolean;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobPageCheckpoint {
  page: number;
  selectedCount: number;
  cvIdSetSha256: string;
  excelSha256: string;
  excelSizeBytes: number;
  pdfSha256: string;
  pdfSizeBytes: number;
  pdfEntries: number;
  zipCrcOk: boolean;
  remoteBatch: string;
  uploadedAt: string;
}

export interface CollectionJob {
  id: string;
  templateId: string | null;
  scheduleId: string | null;
  source: "manual" | "schedule" | "legacy";
  name: string;
  searchSpec: SearchSpec;
  limits: CollectionLimits;
  status: CollectionJobStatus;
  queuePosition: number | null;
  currentPage: number;
  completedPages: number;
  exportedCount: number;
  xlsCount: number;
  pdfCount: number;
  uploadedCount: number;
  searchId: string | null;
  matchedCount: number | null;
  actualFilterLabels: string[];
  pauseRequested: boolean;
  agentId: string | null;
  leaseExpiresAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  scheduledFor: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  pages: JobPageCheckpoint[];
}

export interface AgentState {
  id: string;
  name: string;
  version: string;
  status: "online" | "offline";
  lastHeartbeatAt: string;
  currentJobId: string | null;
  chromeReady: boolean;
  loginState: "unknown" | "logged_in" | "login_required";
}

export class CollectorControlError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    message: string,
    code = "COLLECTOR_CONTROL_ERROR",
    status = 400,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const nowIso = (): string => new Date().toISOString();
const parseJson = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};
const hashToken = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
const randomId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;
const cleanText = (value: unknown, maximum: number, label: string): string => {
  const text = String(value || "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) throw new CollectorControlError(`${label}不能为空`, "INVALID_INPUT");
  return text.slice(0, maximum);
};

function beijingDateBounds(at = new Date()): { date: string; start: string; end: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  const startDate = new Date(`${date}T00:00:00+08:00`);
  return {
    date,
    start: startDate.toISOString(),
    end: new Date(startDate.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function normalizeLimits(input: unknown): CollectionLimits {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const limits: CollectionLimits = {};
  if (source.targetCount !== undefined && source.targetCount !== null && source.targetCount !== "") {
    const value = Number(source.targetCount);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      throw new CollectorControlError("目标人数必须是1到500的整数", "INVALID_COLLECTION_LIMITS");
    }
    limits.targetCount = value;
  }
  if (source.maxPages !== undefined && source.maxPages !== null && source.maxPages !== "") {
    const value = Number(source.maxPages);
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      throw new CollectorControlError("最大页数必须是1到10的整数", "INVALID_COLLECTION_LIMITS");
    }
    limits.maxPages = value;
  }
  if (source.durationHours !== undefined && source.durationHours !== null && source.durationHours !== "") {
    const value = Number(source.durationHours);
    if (!Number.isInteger(value) || value < 1 || value > 48) {
      throw new CollectorControlError("持续时长必须是1到48小时的整数", "INVALID_COLLECTION_LIMITS");
    }
    limits.durationHours = value;
  }
  if (limits.durationHours && (limits.targetCount || limits.maxPages)) {
    throw new CollectorControlError("持续时长模式不能同时设置目标人数或最大页数", "INVALID_COLLECTION_LIMITS");
  }
  if (!limits.targetCount && !limits.maxPages && !limits.durationHours) {
    throw new CollectorControlError("目标人数、最大页数和持续时长至少设置一项", "INVALID_COLLECTION_LIMITS");
  }
  return limits;
}

function normalizeCatalog(input: unknown, agentId: string): FilterCatalog {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const rawFilters = Array.isArray(source.filters) ? source.filters : [];
  const rawSorts = Array.isArray(source.sorts) ? source.sorts : [];
  const filterKeys = new Set<string>();
  const filters: FilterDefinition[] = rawFilters.map((item) => {
    const value = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const key = cleanText(value.key, 100, "Filter键");
    if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(key) || filterKeys.has(key)) {
      throw new CollectorControlError(`Filter键无效或重复: ${key}`, "INVALID_FILTER_CATALOG");
    }
    filterKeys.add(key);
    const controlType = String(value.controlType || "unsupported") as FilterControlType;
    if (!["single", "multi", "range", "search", "unsupported"].includes(controlType)) {
      throw new CollectorControlError(`Filter控件类型无效: ${controlType}`, "INVALID_FILTER_CATALOG");
    }
    const optionKeys = new Set<string>();
    const options = (Array.isArray(value.options) ? value.options : []).map((option) => {
      const raw = (option && typeof option === "object" ? option : {}) as Record<string, unknown>;
      const optionKey = cleanText(raw.key, 120, "Filter选项键");
      if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(optionKey) || optionKeys.has(optionKey)) {
        throw new CollectorControlError(`Filter选项键无效或重复: ${optionKey}`, "INVALID_FILTER_CATALOG");
      }
      optionKeys.add(optionKey);
      return { key: optionKey, label: cleanText(raw.label, 160, "Filter选项名称") };
    });
    const supported = Boolean(value.supported) && controlType !== "unsupported";
    return {
      key,
      label: cleanText(value.label, 160, "Filter名称"),
      controlType,
      supported,
      options,
      valueKind: value.valueKind === "number" ? "number" : value.valueKind === "text" ? "text" : undefined,
      reason: value.reason ? cleanText(value.reason, 240, "暂不支持原因") : null,
    };
  });
  const sortKeys = new Set<string>();
  const sorts: SortDefinition[] = rawSorts.map((item) => {
    const value = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const key = cleanText(value.key, 100, "排序键");
    if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(key) || sortKeys.has(key)) {
      throw new CollectorControlError(`排序键无效或重复: ${key}`, "INVALID_FILTER_CATALOG");
    }
    sortKeys.add(key);
    return { key, label: cleanText(value.label, 160, "排序名称") };
  });
  const signature = JSON.stringify({ filters, sorts });
  return {
    version: `bayt-${hashToken(signature).slice(0, 16)}`,
    status: "ready",
    filters,
    sorts,
    synchronizedAt: nowIso(),
    agentId,
  };
}

function pageFromRow(row: Record<string, unknown>): JobPageCheckpoint {
  return {
    page: Number(row.page_no),
    selectedCount: Number(row.selected_count),
    cvIdSetSha256: String(row.cv_id_set_sha256),
    excelSha256: String(row.excel_sha256),
    excelSizeBytes: Number(row.excel_size_bytes),
    pdfSha256: String(row.pdf_sha256),
    pdfSizeBytes: Number(row.pdf_size_bytes),
    pdfEntries: Number(row.pdf_entries),
    zipCrcOk: Boolean(row.zip_crc_ok),
    remoteBatch: String(row.remote_batch),
    uploadedAt: String(row.uploaded_at),
  };
}

export class CollectorControlStore {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collector_filter_catalogs (
        version TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        sorts_json TEXT NOT NULL,
        synchronized_at TEXT NOT NULL,
        agent_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collector_catalog_sync_requests (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        agent_id TEXT,
        requested_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS collector_search_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        search_spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collector_schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        template_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        local_time TEXT,
        weekday INTEGER,
        run_at TEXT,
        limits_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        next_run_at TEXT,
        last_triggered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES collector_search_templates(id)
      );
      CREATE TABLE IF NOT EXISTS collector_jobs (
        id TEXT PRIMARY KEY,
        template_id TEXT,
        schedule_id TEXT,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        search_spec_json TEXT NOT NULL,
        limits_json TEXT NOT NULL,
        status TEXT NOT NULL,
        queue_position INTEGER,
        current_page INTEGER NOT NULL DEFAULT 0,
        completed_pages INTEGER NOT NULL DEFAULT 0,
        exported_count INTEGER NOT NULL DEFAULT 0,
        xls_count INTEGER NOT NULL DEFAULT 0,
        pdf_count INTEGER NOT NULL DEFAULT 0,
        uploaded_count INTEGER NOT NULL DEFAULT 0,
        search_id TEXT,
        matched_count INTEGER,
        actual_filter_labels_json TEXT NOT NULL DEFAULT '[]',
        pause_requested INTEGER NOT NULL DEFAULT 0,
        agent_id TEXT,
        lease_token_hash TEXT,
        lease_expires_at TEXT,
        error_code TEXT,
        error_message TEXT,
        scheduled_for TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (template_id) REFERENCES collector_search_templates(id),
        FOREIGN KEY (schedule_id) REFERENCES collector_schedules(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collector_jobs_queue_position
        ON collector_jobs(queue_position) WHERE status = 'queued';
      CREATE INDEX IF NOT EXISTS idx_collector_jobs_status ON collector_jobs(status, queue_position, created_at);
      CREATE TABLE IF NOT EXISTS collector_job_pages (
        job_id TEXT NOT NULL,
        page_no INTEGER NOT NULL,
        selected_count INTEGER NOT NULL,
        cv_id_set_sha256 TEXT NOT NULL,
        excel_sha256 TEXT NOT NULL,
        excel_size_bytes INTEGER NOT NULL,
        pdf_sha256 TEXT NOT NULL,
        pdf_size_bytes INTEGER NOT NULL,
        pdf_entries INTEGER NOT NULL,
        zip_crc_ok INTEGER NOT NULL,
        remote_batch TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        PRIMARY KEY (job_id, page_no),
        FOREIGN KEY (job_id) REFERENCES collector_jobs(id)
      );
      CREATE TABLE IF NOT EXISTS collector_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        current_job_id TEXT,
        chrome_ready INTEGER NOT NULL DEFAULT 0,
        login_state TEXT NOT NULL DEFAULT 'unknown'
      );
      CREATE TABLE IF NOT EXISTS collector_control_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        globally_paused INTEGER NOT NULL DEFAULT 0,
        pause_code TEXT,
        pause_message TEXT,
        paused_at TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO collector_control_state(singleton, globally_paused, updated_at)
        VALUES (1, 0, datetime('now'));
      CREATE TABLE IF NOT EXISTS collector_schedule_events (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getCatalog(): { catalog: FilterCatalog | null; syncRequest: Record<string, unknown> | null } {
    const row = this.db.prepare("SELECT * FROM collector_filter_catalogs ORDER BY synchronized_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    const syncRequest = this.db.prepare("SELECT * FROM collector_catalog_sync_requests ORDER BY requested_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    return {
      catalog: row ? {
        version: String(row.version),
        status: String(row.status) as FilterCatalog["status"],
        filters: parseJson<FilterDefinition[]>(row.filters_json, []),
        sorts: parseJson<SortDefinition[]>(row.sorts_json, []),
        synchronizedAt: String(row.synchronized_at),
        agentId: String(row.agent_id),
      } : null,
      syncRequest: syncRequest ? {
        id: String(syncRequest.id),
        status: String(syncRequest.status),
        requestedAt: String(syncRequest.requested_at),
        completedAt: syncRequest.completed_at ? String(syncRequest.completed_at) : null,
        error: syncRequest.error ? String(syncRequest.error) : null,
      } : null,
    };
  }

  requestCatalogSync(): Record<string, unknown> {
    const active = this.db.prepare("SELECT * FROM collector_catalog_sync_requests WHERE status IN ('queued','running') ORDER BY requested_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    if (active) return { id: String(active.id), status: String(active.status), requestedAt: String(active.requested_at) };
    const id = randomId("catalog-sync");
    const requestedAt = nowIso();
    this.db.prepare("INSERT INTO collector_catalog_sync_requests(id, status, requested_at) VALUES (?, 'queued', ?)").run(id, requestedAt);
    return { id, status: "queued", requestedAt };
  }

  claimCatalogSync(agentId: string): Record<string, unknown> | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owned = this.db.prepare(
        "SELECT * FROM collector_catalog_sync_requests WHERE status = 'running' AND agent_id = ? ORDER BY started_at LIMIT 1",
      ).get(agentId) as Record<string, unknown> | undefined;
      if (owned) {
        this.db.exec("COMMIT");
        return { id: String(owned.id), requestedAt: String(owned.requested_at) };
      }
      const row = this.db.prepare("SELECT * FROM collector_catalog_sync_requests WHERE status = 'queued' ORDER BY requested_at LIMIT 1").get() as Record<string, unknown> | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db.prepare("UPDATE collector_catalog_sync_requests SET status = 'running', agent_id = ?, started_at = ? WHERE id = ?").run(agentId, nowIso(), String(row.id));
      this.db.exec("COMMIT");
      return { id: String(row.id), requestedAt: String(row.requested_at) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeCatalogSync(requestId: string, agentId: string, input: unknown): FilterCatalog {
    const request = this.db.prepare("SELECT * FROM collector_catalog_sync_requests WHERE id = ?").get(requestId) as Record<string, unknown> | undefined;
    if (!request || request.status !== "running" || request.agent_id !== agentId) {
      throw new CollectorControlError("Filter同步请求不存在或不属于当前Agent", "CATALOG_SYNC_NOT_CLAIMED", 409);
    }
    const catalog = normalizeCatalog(input, agentId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE collector_filter_catalogs SET status = 'stale' WHERE status = 'ready'").run();
      this.db.prepare(`INSERT OR REPLACE INTO collector_filter_catalogs(
        version, status, filters_json, sorts_json, synchronized_at, agent_id
      ) VALUES (?, 'ready', ?, ?, ?, ?)`)
        .run(catalog.version, JSON.stringify(catalog.filters), JSON.stringify(catalog.sorts), catalog.synchronizedAt, agentId);
      this.db.prepare("UPDATE collector_catalog_sync_requests SET status = 'completed', completed_at = ?, error = NULL WHERE id = ?").run(nowIso(), requestId);
      this.db.exec("COMMIT");
      return catalog;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  failCatalogSync(requestId: string, agentId: string, message: string): void {
    this.db.prepare("UPDATE collector_catalog_sync_requests SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND agent_id = ?")
      .run(nowIso(), message.slice(0, 500), requestId, agentId);
  }

  validateSearchSpec(input: unknown): SearchSpec {
    const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const keyword = cleanText(source.keyword, 160, "搜索关键词");
    if (/https?:\/\/|cookie|authorization|selector|request.?headers?/i.test(keyword)) {
      throw new CollectorControlError("搜索关键词包含不允许的请求信息", "UNSAFE_SEARCH_SPEC");
    }
    const catalogState = this.getCatalog();
    const catalog = catalogState.catalog;
    if (!catalog || source.filterSchemaVersion !== catalog.version) {
      throw new CollectorControlError("Filter目录版本不是当前版本，请重新同步或刷新页面", "FILTER_SCHEMA_MISMATCH", 409);
    }
    const definitions = new Map(catalog.filters.map((item) => [item.key, item]));
    const filters: FilterSelection[] = (Array.isArray(source.filters) ? source.filters : []).map((raw) => {
      const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const key = String(value.key || "");
      const definition = definitions.get(key);
      if (!definition || !definition.supported) {
        throw new CollectorControlError(`Filter不在当前白名单或暂不支持: ${key}`, "INVALID_FILTER_SELECTION");
      }
      const selection: FilterSelection = { key };
      if (definition.controlType === "single" || definition.controlType === "multi") {
        const optionKeys = [...new Set((Array.isArray(value.optionKeys) ? value.optionKeys : []).map(String))];
        const allowed = new Set(definition.options.map((option) => option.key));
        if (!optionKeys.length || optionKeys.some((option) => !allowed.has(option))) {
          throw new CollectorControlError(`Filter选项无效: ${key}`, "INVALID_FILTER_SELECTION");
        }
        if (definition.controlType === "single" && optionKeys.length !== 1) {
          throw new CollectorControlError(`单选Filter只能选择一个选项: ${key}`, "INVALID_FILTER_SELECTION");
        }
        selection.optionKeys = optionKeys;
      } else if (definition.controlType === "range") {
        const min = value.min === undefined || value.min === null || value.min === "" ? undefined : Number(value.min);
        const max = value.max === undefined || value.max === null || value.max === "" ? undefined : Number(value.max);
        if ((min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max)) || (min === undefined && max === undefined) || (min !== undefined && max !== undefined && min > max)) {
          throw new CollectorControlError(`区间Filter值无效: ${key}`, "INVALID_FILTER_SELECTION");
        }
        selection.min = min;
        selection.max = max;
      } else if (definition.controlType === "search") {
        selection.value = cleanText(value.value, 160, `${definition.label}搜索值`);
      }
      return selection;
    });
    const uniqueKeys = new Set(filters.map((item) => item.key));
    if (uniqueKeys.size !== filters.length) {
      throw new CollectorControlError("同一个Filter不能重复提交", "INVALID_FILTER_SELECTION");
    }
    const sortKey = source.sortKey === null || source.sortKey === undefined || source.sortKey === "" ? null : String(source.sortKey);
    if (sortKey && !catalog.sorts.some((sort) => sort.key === sortKey)) {
      throw new CollectorControlError(`排序方式不在当前白名单: ${sortKey}`, "INVALID_SORT_KEY");
    }
    return { keyword, filterSchemaVersion: catalog.version, filters, sortKey };
  }

  listTemplates(): SearchTemplate[] {
    return (this.db.prepare("SELECT * FROM collector_search_templates ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      searchSpec: parseJson<SearchSpec>(row.search_spec_json, {} as SearchSpec),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  getTemplate(id: string): SearchTemplate | null {
    return this.listTemplates().find((item) => item.id === id) || null;
  }

  createTemplate(input: Record<string, unknown>): SearchTemplate {
    const id = randomId("template");
    const timestamp = nowIso();
    const name = cleanText(input.name, 80, "模板名称");
    const searchSpec = this.validateSearchSpec(input.searchSpec);
    this.db.prepare("INSERT INTO collector_search_templates(id, name, search_spec_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, JSON.stringify(searchSpec), timestamp, timestamp);
    return this.getTemplate(id)!;
  }

  updateTemplate(id: string, input: Record<string, unknown>): SearchTemplate {
    const current = this.getTemplate(id);
    if (!current) throw new CollectorControlError("搜索模板不存在", "SEARCH_TEMPLATE_NOT_FOUND", 404);
    const name = input.name === undefined ? current.name : cleanText(input.name, 80, "模板名称");
    const searchSpec = input.searchSpec === undefined ? current.searchSpec : this.validateSearchSpec(input.searchSpec);
    this.db.prepare("UPDATE collector_search_templates SET name = ?, search_spec_json = ?, updated_at = ? WHERE id = ?")
      .run(name, JSON.stringify(searchSpec), nowIso(), id);
    return this.getTemplate(id)!;
  }

  deleteTemplate(id: string): void {
    const dependent = this.db.prepare("SELECT id FROM collector_schedules WHERE template_id = ? LIMIT 1").get(id);
    if (dependent) throw new CollectorControlError("模板仍有关联计划，不能删除", "TEMPLATE_IN_USE", 409);
    const result = this.db.prepare("DELETE FROM collector_search_templates WHERE id = ?").run(id);
    if (!result.changes) throw new CollectorControlError("搜索模板不存在", "SEARCH_TEMPLATE_NOT_FOUND", 404);
  }

  duplicateTemplate(id: string, name?: string): SearchTemplate {
    const current = this.getTemplate(id);
    if (!current) throw new CollectorControlError("搜索模板不存在", "SEARCH_TEMPLATE_NOT_FOUND", 404);
    return this.createTemplate({ name: name || `${current.name} 副本`, searchSpec: current.searchSpec });
  }

  private nextQueuePosition(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(queue_position), 0) AS value FROM collector_jobs WHERE status = 'queued'").get() as { value: number };
    return Number(row.value) + 1;
  }

  createJob(input: Record<string, unknown>, source: CollectionJob["source"] = "manual"): CollectionJob {
    const templateId = input.templateId ? String(input.templateId) : null;
    const template = templateId ? this.getTemplate(templateId) : null;
    if (templateId && !template) throw new CollectorControlError("搜索模板不存在", "SEARCH_TEMPLATE_NOT_FOUND", 404);
    const searchSpec = template ? this.validateSearchSpec(template.searchSpec) : this.validateSearchSpec(input.searchSpec);
    const limits = normalizeLimits(input.limits);
    const id = randomId("job");
    const name = cleanText(input.name || template?.name || searchSpec.keyword, 100, "任务名称");
    const createdAt = nowIso();
    this.db.prepare(`INSERT INTO collector_jobs(
      id, template_id, schedule_id, source, name, search_spec_json, limits_json, status,
      queue_position, scheduled_for, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
      .run(
        id,
        templateId,
        input.scheduleId ? String(input.scheduleId) : null,
        source,
        name,
        JSON.stringify(searchSpec),
        JSON.stringify(limits),
        this.nextQueuePosition(),
        input.scheduledFor ? String(input.scheduledFor) : null,
        createdAt,
      );
    return this.getJob(id)!;
  }

  private jobFromRow(row: Record<string, unknown>): CollectionJob {
    const id = String(row.id);
    const pages = (this.db.prepare("SELECT * FROM collector_job_pages WHERE job_id = ? ORDER BY page_no").all(id) as Record<string, unknown>[]).map(pageFromRow);
    return {
      id,
      templateId: row.template_id ? String(row.template_id) : null,
      scheduleId: row.schedule_id ? String(row.schedule_id) : null,
      source: String(row.source) as CollectionJob["source"],
      name: String(row.name),
      searchSpec: parseJson<SearchSpec>(row.search_spec_json, {} as SearchSpec),
      limits: parseJson<CollectionLimits>(row.limits_json, {}),
      status: String(row.status) as CollectionJobStatus,
      queuePosition: row.queue_position === null || row.queue_position === undefined ? null : Number(row.queue_position),
      currentPage: Number(row.current_page),
      completedPages: Number(row.completed_pages),
      exportedCount: Number(row.exported_count),
      xlsCount: Number(row.xls_count),
      pdfCount: Number(row.pdf_count),
      uploadedCount: Number(row.uploaded_count),
      searchId: row.search_id ? String(row.search_id) : null,
      matchedCount: row.matched_count === null || row.matched_count === undefined ? null : Number(row.matched_count),
      actualFilterLabels: parseJson<string[]>(row.actual_filter_labels_json, []),
      pauseRequested: Boolean(row.pause_requested),
      agentId: row.agent_id ? String(row.agent_id) : null,
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
      errorCode: row.error_code ? String(row.error_code) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      scheduledFor: row.scheduled_for ? String(row.scheduled_for) : null,
      createdAt: String(row.created_at),
      startedAt: row.started_at ? String(row.started_at) : null,
      completedAt: row.completed_at ? String(row.completed_at) : null,
      pages,
    };
  }

  listJobs(limit = 200): CollectionJob[] {
    return (this.db.prepare("SELECT * FROM collector_jobs ORDER BY CASE WHEN status = 'running' THEN 0 WHEN status = 'queued' THEN 1 ELSE 2 END, queue_position, created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((row) => this.jobFromRow(row));
  }

  getJob(id: string): CollectionJob | null {
    const row = this.db.prepare("SELECT * FROM collector_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.jobFromRow(row) : null;
  }

  private normalizeQueue(): void {
    const rows = this.db.prepare("SELECT id FROM collector_jobs WHERE status = 'queued' ORDER BY queue_position, created_at").all() as { id: string }[];
    const temporaryOffset = 1000000;
    for (let index = 0; index < rows.length; index += 1) {
      this.db.prepare("UPDATE collector_jobs SET queue_position = ? WHERE id = ?").run(temporaryOffset + index + 1, rows[index].id);
    }
    for (let index = 0; index < rows.length; index += 1) {
      this.db.prepare("UPDATE collector_jobs SET queue_position = ? WHERE id = ?").run(index + 1, rows[index].id);
    }
  }

  moveJob(id: string, direction: "up" | "down"): CollectionJob {
    const job = this.getJob(id);
    if (!job || job.status !== "queued" || job.queuePosition === null) {
      throw new CollectorControlError("只有待执行任务可以调整顺序", "JOB_NOT_MOVABLE", 409);
    }
    const operator = direction === "up" ? "<" : ">";
    const order = direction === "up" ? "DESC" : "ASC";
    const neighbor = this.db.prepare(`SELECT id, queue_position FROM collector_jobs WHERE status = 'queued' AND queue_position ${operator} ? ORDER BY queue_position ${order} LIMIT 1`).get(job.queuePosition) as { id: string; queue_position: number } | undefined;
    if (!neighbor) return job;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE collector_jobs SET queue_position = -1 WHERE id = ?").run(id);
      this.db.prepare("UPDATE collector_jobs SET queue_position = ? WHERE id = ?").run(job.queuePosition, neighbor.id);
      this.db.prepare("UPDATE collector_jobs SET queue_position = ? WHERE id = ?").run(neighbor.queue_position, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getJob(id)!;
  }

  cancelJob(id: string): CollectionJob {
    const job = this.getJob(id);
    if (!job || job.status !== "queued") throw new CollectorControlError("只有待执行任务可以取消", "JOB_NOT_CANCELLABLE", 409);
    this.db.prepare("UPDATE collector_jobs SET status = 'cancelled', queue_position = NULL, completed_at = ? WHERE id = ?").run(nowIso(), id);
    this.normalizeQueue();
    return this.getJob(id)!;
  }

  pauseJob(id: string): CollectionJob {
    const job = this.getJob(id);
    if (!job || job.status !== "running") throw new CollectorControlError("只有运行中的任务可以暂停", "JOB_NOT_PAUSABLE", 409);
    this.db.prepare("UPDATE collector_jobs SET status = 'pause_requested', pause_requested = 1 WHERE id = ?").run(id);
    return this.getJob(id)!;
  }

  updatePausedJobLimits(id: string, input: unknown): CollectionJob {
    const job = this.getJob(id);
    if (!job || job.status !== "paused") {
      throw new CollectorControlError("只有已暂停任务可以调整运行范围", "JOB_LIMITS_NOT_EDITABLE", 409);
    }
    const limits = normalizeLimits(input);
    // 持续时长从恢复领取时重新计时，暂停和部署耗时不计入24小时样本。
    this.db.prepare("UPDATE collector_jobs SET limits_json = ?, started_at = NULL WHERE id = ?").run(JSON.stringify(limits), id);
    return this.getJob(id)!;
  }

  resumeJob(id: string): CollectionJob {
    const job = this.getJob(id);
    if (!job || !["paused", "safety_stopped", "failed"].includes(job.status)) {
      throw new CollectorControlError("任务当前不可恢复", "JOB_NOT_RESUMABLE", 409);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE collector_control_state SET globally_paused = 0, pause_code = NULL, pause_message = NULL, paused_at = NULL, updated_at = ? WHERE singleton = 1").run(nowIso());
      this.db.prepare(`UPDATE collector_jobs SET status = 'queued', queue_position = ?, pause_requested = 0,
        agent_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, error_code = NULL,
        error_message = NULL, completed_at = NULL WHERE id = ?`).run(this.nextQueuePosition(), id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getJob(id)!;
  }

  getControlState(): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM collector_control_state WHERE singleton = 1").get() as Record<string, unknown>;
    const running = this.db.prepare("SELECT id FROM collector_jobs WHERE status IN ('running','pause_requested') ORDER BY started_at LIMIT 1").get() as { id?: string } | undefined;
    const queued = this.db.prepare("SELECT COUNT(*) AS count FROM collector_jobs WHERE status = 'queued'").get() as { count: number };
    const activeJob = running?.id ? this.getJob(running.id) : null;
    return {
      globallyPaused: Boolean(row.globally_paused),
      pauseCode: row.pause_code ? String(row.pause_code) : null,
      pauseMessage: row.pause_message ? String(row.pause_message) : null,
      pausedAt: row.paused_at ? String(row.paused_at) : null,
      runningJobId: running?.id || null,
      queuedCount: Number(queued.count),
      dailyExportedCount: this.dailyExportedCount(),
      dailyLimit: activeJob?.limits.durationHours ? null : 500,
    };
  }

  heartbeatAgent(input: Record<string, unknown>): AgentState {
    const id = cleanText(input.agentId, 100, "Agent ID");
    const timestamp = nowIso();
    const name = cleanText(input.name || id, 120, "Agent名称");
    const version = cleanText(input.version || "unknown", 80, "Agent版本");
    const loginState = ["unknown", "logged_in", "login_required"].includes(String(input.loginState)) ? String(input.loginState) : "unknown";
    this.db.prepare(`INSERT INTO collector_agents(id, name, version, last_heartbeat_at, current_job_id, chrome_ready, login_state)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version,
      last_heartbeat_at=excluded.last_heartbeat_at, current_job_id=excluded.current_job_id,
      chrome_ready=excluded.chrome_ready, login_state=excluded.login_state`)
      .run(id, name, version, timestamp, input.currentJobId ? String(input.currentJobId) : null, input.chromeReady ? 1 : 0, loginState);
    return { id, name, version, status: "online", lastHeartbeatAt: timestamp, currentJobId: input.currentJobId ? String(input.currentJobId) : null, chromeReady: Boolean(input.chromeReady), loginState: loginState as AgentState["loginState"] };
  }

  listAgents(): AgentState[] {
    const cutoff = Date.now() - 90_000;
    return (this.db.prepare("SELECT * FROM collector_agents ORDER BY last_heartbeat_at DESC").all() as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      version: String(row.version),
      status: Date.parse(String(row.last_heartbeat_at)) >= cutoff ? "online" : "offline",
      lastHeartbeatAt: String(row.last_heartbeat_at),
      currentJobId: row.current_job_id ? String(row.current_job_id) : null,
      chromeReady: Boolean(row.chrome_ready),
      loginState: String(row.login_state) as AgentState["loginState"],
    }));
  }

  recoverExpiredLeases(at = new Date()): number {
    const expired = this.db.prepare("SELECT id FROM collector_jobs WHERE status IN ('running','pause_requested') AND lease_expires_at < ?").all(at.toISOString()) as { id: string }[];
    for (const item of expired) {
      this.db.prepare(`UPDATE collector_jobs SET status = 'queued', queue_position = ?, pause_requested = 0,
        agent_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
        error_code = 'LEASE_EXPIRED', error_message = 'Agent租约过期，已从最后完整页面恢复' WHERE id = ?`)
        .run(this.nextQueuePosition(), item.id);
    }
    return expired.length;
  }

  dailyExportedCount(at = new Date()): number {
    const bounds = beijingDateBounds(at);
    const row = this.db.prepare("SELECT COALESCE(SUM(selected_count), 0) AS total FROM collector_job_pages WHERE uploaded_at >= ? AND uploaded_at < ?").get(bounds.start, bounds.end) as { total: number };
    return Number(row.total);
  }

  claimJob(agentId: string, leaseMs = 120_000): { job: CollectionJob | null; leaseToken?: string; waitReason?: string; waitUntil?: string } {
    this.recoverExpiredLeases();
    const state = this.getControlState();
    if (state.globallyPaused) return { job: null, waitReason: "global_safety_pause" };
    if (state.runningJobId) return { job: null, waitReason: "another_job_running" };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const running = this.db.prepare("SELECT id FROM collector_jobs WHERE status IN ('running','pause_requested') LIMIT 1").get();
      if (running) {
        this.db.exec("COMMIT");
        return { job: null, waitReason: "another_job_running" };
      }
      const row = this.db.prepare("SELECT id FROM collector_jobs WHERE status = 'queued' ORDER BY queue_position, created_at LIMIT 1").get() as { id?: string } | undefined;
      if (!row?.id) {
        this.db.exec("COMMIT");
        return { job: null, waitReason: "queue_empty" };
      }
      const queuedJob = this.getJob(row.id);
      if (!queuedJob?.limits.durationHours && 500 - this.dailyExportedCount() < 50) {
        const bounds = beijingDateBounds();
        this.db.exec("COMMIT");
        return { job: null, waitReason: "daily_limit", waitUntil: bounds.end };
      }
      const leaseToken = crypto.randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + leaseMs).toISOString();
      this.db.prepare(`UPDATE collector_jobs SET status = 'running', queue_position = NULL, agent_id = ?,
        lease_token_hash = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?), pause_requested = 0
        WHERE id = ?`).run(agentId, hashToken(leaseToken), expiresAt, nowIso(), row.id);
      this.normalizeQueue();
      this.db.exec("COMMIT");
      return { job: this.getJob(row.id), leaseToken };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  verifyLease(jobId: string, agentId: string, leaseToken: string): CollectionJob {
    const row = this.db.prepare("SELECT * FROM collector_jobs WHERE id = ?").get(jobId) as Record<string, unknown> | undefined;
    if (!row || row.agent_id !== agentId || !row.lease_token_hash || hashToken(leaseToken) !== row.lease_token_hash || Date.parse(String(row.lease_expires_at)) <= Date.now()) {
      throw new CollectorControlError("任务租约无效或已过期", "INVALID_JOB_LEASE", 409);
    }
    return this.jobFromRow(row);
  }

  heartbeatJob(jobId: string, agentId: string, leaseToken: string, evidence: Record<string, unknown> = {}, leaseMs = 120_000): CollectionJob {
    const job = this.verifyLease(jobId, agentId, leaseToken);
    this.db.prepare(`UPDATE collector_jobs SET lease_expires_at = ?, search_id = COALESCE(?, search_id),
      matched_count = COALESCE(?, matched_count), actual_filter_labels_json = CASE WHEN ? IS NULL THEN actual_filter_labels_json ELSE ? END
      WHERE id = ?`).run(
        new Date(Date.now() + leaseMs).toISOString(),
        evidence.searchId ? String(evidence.searchId).slice(0, 200) : null,
        Number.isInteger(Number(evidence.matchedCount)) ? Number(evidence.matchedCount) : null,
        Array.isArray(evidence.actualFilterLabels) ? 1 : null,
        Array.isArray(evidence.actualFilterLabels) ? JSON.stringify(evidence.actualFilterLabels.map(String).slice(0, 100)) : null,
        jobId,
      );
    return this.getJob(job.id)!;
  }

  checkpointPage(jobId: string, agentId: string, leaseToken: string, input: Record<string, unknown>): CollectionJob {
    const job = this.verifyLease(jobId, agentId, leaseToken);
    const page = Number(input.page);
    const selectedCount = Number(input.selectedCount);
    if (!Number.isInteger(page) || page < 1 || page > 10_000 || !Number.isInteger(selectedCount) || selectedCount < 1 || selectedCount > 50) {
      throw new CollectorControlError("页级检查点数量无效", "INVALID_PAGE_CHECKPOINT");
    }
    const shaFields = ["cvIdSetSha256", "excelSha256", "pdfSha256"] as const;
    for (const field of shaFields) {
      if (!/^[a-f0-9]{64}$/.test(String(input[field] || ""))) {
        throw new CollectorControlError(`页级检查点哈希无效: ${field}`, "INVALID_PAGE_CHECKPOINT");
      }
    }
    const excelSize = Number(input.excelSizeBytes);
    const pdfSize = Number(input.pdfSizeBytes);
    const pdfEntries = Number(input.pdfEntries);
    const remoteBatch = String(input.remoteBatch || "");
    if (!Number.isInteger(excelSize) || excelSize <= 0 || !Number.isInteger(pdfSize) || pdfSize <= 0 || !Number.isInteger(pdfEntries) || pdfEntries !== selectedCount || input.zipCrcOk !== true || !/^\/[a-z0-9/._-]+$/i.test(remoteBatch) || remoteBatch.includes("..")) {
      throw new CollectorControlError("页级文件验收证据不完整", "INVALID_PAGE_CHECKPOINT");
    }
    const existing = this.db.prepare("SELECT * FROM collector_job_pages WHERE job_id = ? AND page_no = ?").get(jobId, page) as Record<string, unknown> | undefined;
    if (existing) {
      const previous = pageFromRow(existing);
      if (previous.cvIdSetSha256 !== input.cvIdSetSha256 || previous.excelSha256 !== input.excelSha256 || previous.pdfSha256 !== input.pdfSha256) {
        throw new CollectorControlError("同一页的文件或CV_ID集合发生变化", "PAGE_CHECKPOINT_CONFLICT", 409);
      }
      return job;
    }
    if (!job.limits.durationHours && this.dailyExportedCount() + selectedCount > 500) {
      throw new CollectorControlError("写入该完整页将超过北京时间当日500条上限", "DAILY_EXPORT_LIMIT", 409);
    }
    const uploadedAt = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO collector_job_pages(
        job_id, page_no, selected_count, cv_id_set_sha256, excel_sha256, excel_size_bytes,
        pdf_sha256, pdf_size_bytes, pdf_entries, zip_crc_ok, remote_batch, uploaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(jobId, page, selectedCount, String(input.cvIdSetSha256), String(input.excelSha256), excelSize, String(input.pdfSha256), pdfSize, pdfEntries, remoteBatch, uploadedAt);
      const totals = this.db.prepare("SELECT COUNT(*) AS pages, COALESCE(SUM(selected_count),0) AS exported FROM collector_job_pages WHERE job_id = ?").get(jobId) as { pages: number; exported: number };
      this.db.prepare(`UPDATE collector_jobs SET current_page = ?, completed_pages = ?, exported_count = ?,
        xls_count = ?, pdf_count = ?, uploaded_count = ?, lease_expires_at = ? WHERE id = ?`)
        .run(page, totals.pages, totals.exported, totals.pages, totals.pages, totals.pages, new Date(Date.now() + 120_000).toISOString(), jobId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getJob(jobId)!;
  }

  completeJob(jobId: string, agentId: string, leaseToken: string): CollectionJob {
    const job = this.verifyLease(jobId, agentId, leaseToken);
    if (!job.completedPages) throw new CollectorControlError("任务没有完整页检查点，不能完成", "JOB_HAS_NO_COMPLETE_PAGE", 409);
    this.db.prepare(`UPDATE collector_jobs SET status = 'completed', pause_requested = 0,
      lease_token_hash = NULL, lease_expires_at = NULL, completed_at = ?, error_code = NULL, error_message = NULL
      WHERE id = ?`).run(nowIso(), jobId);
    return this.getJob(jobId)!;
  }

  acknowledgePause(jobId: string, agentId: string, leaseToken: string): CollectionJob {
    this.verifyLease(jobId, agentId, leaseToken);
    this.db.prepare(`UPDATE collector_jobs SET status = 'paused', pause_requested = 0,
      lease_token_hash = NULL, lease_expires_at = NULL, completed_at = ? WHERE id = ?`).run(nowIso(), jobId);
    return this.getJob(jobId)!;
  }

  safetyStop(jobId: string, agentId: string, leaseToken: string, input: Record<string, unknown>): CollectionJob {
    this.verifyLease(jobId, agentId, leaseToken);
    const code = cleanText(input.code, 80, "安全停止代码");
    const message = cleanText(input.message, 500, "安全停止说明");
    const timestamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE collector_control_state SET globally_paused = 1, pause_code = ?, pause_message = ?, paused_at = ?, updated_at = ? WHERE singleton = 1")
        .run(code, message, timestamp, timestamp);
      this.db.prepare(`UPDATE collector_jobs SET status = 'safety_stopped', pause_requested = 0,
        lease_token_hash = NULL, lease_expires_at = NULL, error_code = ?, error_message = ?, completed_at = ? WHERE id = ?`)
        .run(code, message, timestamp, jobId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getJob(jobId)!;
  }

  private scheduleFromRow(row: Record<string, unknown>): CollectionSchedule {
    return {
      id: String(row.id),
      name: String(row.name),
      templateId: String(row.template_id),
      kind: String(row.kind) as ScheduleKind,
      timezone: "Asia/Shanghai",
      localTime: row.local_time ? String(row.local_time) : null,
      weekday: row.weekday === null || row.weekday === undefined ? null : Number(row.weekday),
      runAt: row.run_at ? String(row.run_at) : null,
      limits: parseJson<CollectionLimits>(row.limits_json, {}),
      enabled: Boolean(row.enabled),
      nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
      lastTriggeredAt: row.last_triggered_at ? String(row.last_triggered_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listSchedules(): CollectionSchedule[] {
    return (this.db.prepare("SELECT * FROM collector_schedules ORDER BY created_at DESC").all() as Record<string, unknown>[]).map((row) => this.scheduleFromRow(row));
  }

  getSchedule(id: string): CollectionSchedule | null {
    const row = this.db.prepare("SELECT * FROM collector_schedules WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.scheduleFromRow(row) : null;
  }

  private computeNextRun(kind: ScheduleKind, input: Record<string, unknown>, from = new Date()): string | null {
    if (kind === "once") {
      const runAt = new Date(String(input.runAt || ""));
      if (!Number.isFinite(runAt.getTime()) || runAt.getTime() <= from.getTime()) {
        throw new CollectorControlError("单次执行时间必须晚于当前时间", "INVALID_SCHEDULE");
      }
      return runAt.toISOString();
    }
    const localTime = String(input.localTime || "");
    const match = localTime.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) throw new CollectorControlError("计划时间必须使用HH:mm格式", "INVALID_SCHEDULE");
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(from);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
    const date = `${value("year")}-${value("month")}-${value("day")}`;
    const dayStart = new Date(`${date}T00:00:00+08:00`);
    let target = new Date(dayStart.getTime() + Number(match[1]) * 60 * 60 * 1000 + Number(match[2]) * 60 * 1000);
    if (kind === "daily") {
      if (target.getTime() <= from.getTime()) target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
    } else {
      const weekday = Number(input.weekday);
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new CollectorControlError("每周计划星期值必须为1到7", "INVALID_SCHEDULE");
      const currentDay = new Date(`${date}T12:00:00+08:00`).getUTCDay();
      const currentWeekday = currentDay === 0 ? 7 : currentDay;
      let offset = (weekday - currentWeekday + 7) % 7;
      if (offset === 0 && target.getTime() <= from.getTime()) offset = 7;
      target = new Date(target.getTime() + offset * 24 * 60 * 60 * 1000);
    }
    return target.toISOString();
  }

  createSchedule(input: Record<string, unknown>): CollectionSchedule {
    const templateId = String(input.templateId || "");
    if (!this.getTemplate(templateId)) throw new CollectorControlError("搜索模板不存在", "SEARCH_TEMPLATE_NOT_FOUND", 404);
    const kind = String(input.kind || "") as ScheduleKind;
    if (!["once", "daily", "weekly"].includes(kind)) throw new CollectorControlError("计划类型无效", "INVALID_SCHEDULE");
    const limits = normalizeLimits(input.limits);
    const id = randomId("schedule");
    const timestamp = nowIso();
    const nextRunAt = this.computeNextRun(kind, input);
    this.db.prepare(`INSERT INTO collector_schedules(
      id, name, template_id, kind, local_time, weekday, run_at, limits_json, enabled,
      next_run_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, cleanText(input.name, 100, "计划名称"), templateId, kind,
        kind === "once" ? null : String(input.localTime), kind === "weekly" ? Number(input.weekday) : null,
        kind === "once" ? nextRunAt : null, JSON.stringify(limits), input.enabled === false ? 0 : 1,
        input.enabled === false ? null : nextRunAt, timestamp, timestamp);
    return this.getSchedule(id)!;
  }

  updateSchedule(id: string, input: Record<string, unknown>): CollectionSchedule {
    const current = this.getSchedule(id);
    if (!current) throw new CollectorControlError("采集计划不存在", "SCHEDULE_NOT_FOUND", 404);
    const merged = {
      templateId: input.templateId ?? current.templateId,
      kind: input.kind ?? current.kind,
      localTime: input.localTime ?? current.localTime,
      weekday: input.weekday ?? current.weekday,
      runAt: input.runAt ?? current.runAt,
      limits: input.limits ?? current.limits,
    } as Record<string, unknown>;
    const templateId = String(merged.templateId);
    if (!this.getTemplate(templateId)) throw new CollectorControlError("搜索模板不存在", "SEARCH_TEMPLATE_NOT_FOUND", 404);
    const kind = String(merged.kind) as ScheduleKind;
    if (!["once", "daily", "weekly"].includes(kind)) throw new CollectorControlError("计划类型无效", "INVALID_SCHEDULE");
    const limits = normalizeLimits(merged.limits);
    const enabled = input.enabled === undefined ? current.enabled : Boolean(input.enabled);
    const nextRunAt = enabled ? this.computeNextRun(kind, merged) : null;
    this.db.prepare(`UPDATE collector_schedules SET name = ?, template_id = ?, kind = ?, local_time = ?,
      weekday = ?, run_at = ?, limits_json = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
      .run(input.name === undefined ? current.name : cleanText(input.name, 100, "计划名称"), templateId, kind,
        kind === "once" ? null : String(merged.localTime), kind === "weekly" ? Number(merged.weekday) : null,
        kind === "once" ? nextRunAt : null, JSON.stringify(limits), enabled ? 1 : 0, nextRunAt, nowIso(), id);
    return this.getSchedule(id)!;
  }

  deleteSchedule(id: string): void {
    const result = this.db.prepare("DELETE FROM collector_schedules WHERE id = ?").run(id);
    if (!result.changes) throw new CollectorControlError("采集计划不存在", "SCHEDULE_NOT_FOUND", 404);
  }

  triggerDueSchedules(at = new Date()): { queued: number; skipped: number } {
    const due = this.db.prepare("SELECT * FROM collector_schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at").all(at.toISOString()) as Record<string, unknown>[];
    let queued = 0;
    let skipped = 0;
    for (const row of due) {
      const schedule = this.scheduleFromRow(row);
      const duplicate = this.db.prepare("SELECT id FROM collector_jobs WHERE template_id = ? AND status IN ('queued','running','pause_requested') LIMIT 1").get(schedule.templateId);
      const eventId = randomId("schedule-event");
      if (duplicate) {
        skipped += 1;
        this.db.prepare("INSERT INTO collector_schedule_events(id, schedule_id, event_type, detail, created_at) VALUES (?, ?, 'skipped_duplicate', ?, ?)")
          .run(eventId, schedule.id, "同一模板已有待执行或运行任务", nowIso());
      } else {
        this.createJob({ templateId: schedule.templateId, scheduleId: schedule.id, name: schedule.name, limits: schedule.limits, scheduledFor: schedule.nextRunAt }, "schedule");
        queued += 1;
        this.db.prepare("INSERT INTO collector_schedule_events(id, schedule_id, event_type, detail, created_at) VALUES (?, ?, 'queued', NULL, ?)").run(eventId, schedule.id, nowIso());
      }
      const nextRunAt = schedule.kind === "once" ? null : this.computeNextRun(schedule.kind, schedule as unknown as Record<string, unknown>, new Date(at.getTime() + 1000));
      this.db.prepare("UPDATE collector_schedules SET enabled = ?, next_run_at = ?, last_triggered_at = ?, updated_at = ? WHERE id = ?")
        .run(schedule.kind === "once" ? 0 : 1, nextRunAt, nowIso(), nowIso(), schedule.id);
    }
    return { queued, skipped };
  }

  importLegacyTasks(tasks: Array<Record<string, unknown>>): number {
    let imported = 0;
    for (const task of tasks) {
      const legacyId = `legacy-${String(task.id || hashToken(JSON.stringify(task))).replace(/[^a-z0-9._-]/gi, "_").slice(0, 80)}`;
      if (this.db.prepare("SELECT id FROM collector_search_templates WHERE id = ?").get(legacyId)) continue;
      const catalog = this.getCatalog().catalog;
      const spec: SearchSpec = {
        keyword: cleanText(task.query || "Bayt Search", 160, "旧任务关键词"),
        filterSchemaVersion: catalog?.version || "legacy-unverified",
        filters: [],
        sortKey: null,
      };
      const timestamp = nowIso();
      this.db.prepare("INSERT INTO collector_search_templates(id, name, search_spec_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(legacyId, cleanText(task.name || task.query || "旧采集任务", 80, "旧任务名称"), JSON.stringify(spec), timestamp, timestamp);
      imported += 1;
    }
    return imported;
  }
}

export function normalizeCollectorLimits(input: unknown): CollectionLimits {
  return normalizeLimits(input);
}

export function normalizeFilterCatalog(input: unknown, agentId: string): FilterCatalog {
  return normalizeCatalog(input, agentId);
}
