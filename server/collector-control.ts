import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { automaticRecovery, validRecovery, type BrowserRecovery } from "../collector/src/recovery.ts";

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
  advanced?: AdvancedFilterCatalog | null;
}

export interface AdvancedFilterCatalog {
  keywordModes: FilterOption[];
  nameSupported: boolean;
  locations: Array<FilterOption & { cities: FilterOption[] }>;
  jobRoles: FilterOption[];
  industries: FilterOption[];
  exclusionSupported: boolean;
  reliable: boolean;
  reason?: string | null;
}

export interface FilterSelection {
  key: string;
  optionKeys?: string[];
  value?: string;
  min?: number;
  max?: number;
}

export interface SearchSpec {
  schemaVersion?: 2;
  keyword: string;
  filterSchemaVersion: string;
  filters: FilterSelection[];
  sortKey: string | null;
  keywordMode?: string;
  name?: string | null;
  pastJobLocations?: Array<{ countryKey: string; cityKey: string | null }>;
  includeJobRoles?: string[];
  excludeJobRoles?: string[];
  includeIndustries?: string[];
  excludeIndustries?: string[];
  approximateLocationKeyword?: string | null;
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
  collectedPages: number;
  collectedCount: number;
  displayedCount: number;
  collectionFinishedAt: string | null;
  phase: string | null;
  nextActionAt: string | null;
  deliveryError: string | null;
  resumeMode: "new_search" | "checkpoint" | "review";
  recovery: BrowserRecovery | null;
}

export interface AgentState {
  id: string;
  name: string;
  version: string;
  status: "online" | "offline";
  lastHeartbeatAt: string;
  currentJobId: string | null;
  chromeReady: boolean;
  loginState: "unknown" | "logged_in" | "login_required" | "verification_required";
  waitReason?: string | null;
  nextActionAt?: string | null;
  verificationId?: string | null;
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
const optionalText = (value: unknown, maximum: number): string =>
  String(value || "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);

function pageEvidence(input: Record<string, unknown>): Record<string, unknown> {
  const page = Number(input.page), selectedCount = Number(input.selectedCount);
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(selectedCount) || selectedCount < 1 || selectedCount > 50 ||
    !["cvIdSetSha256", "excelSha256", "pdfSha256"].every(key => /^[a-f0-9]{64}$/.test(String(input[key] || ""))))
    throw new CollectorControlError("完整页证据无效", "INVALID_PAGE_CHECKPOINT", 409);
  if (![input.excelSizeBytes, input.pdfSizeBytes].every(n => Number.isInteger(n) && Number(n) > 0) ||
    input.pdfEntries !== selectedCount || input.zipCrcOk !== true)
    throw new CollectorControlError("完整页文件验收未通过", "INVALID_PAGE_CHECKPOINT", 409);
  return { page, selectedCount, cvIdSetSha256: input.cvIdSetSha256, excelSha256: input.excelSha256,
    excelSizeBytes: input.excelSizeBytes, pdfSha256: input.pdfSha256, pdfSizeBytes: input.pdfSizeBytes,
    pdfEntries: input.pdfEntries, zipCrcOk: true };
}

const checkpointResumeCodes = new Set(["NEXT_PAGE_OVERLAP", "CROSS_PAGE_CV_ID_OVERLAP", "SEARCH_FORM_UNVERIFIED",
  "BAYT_VERIFICATION_REQUIRED", "TRANSIENT_RETRY_EXHAUSTED", "QUEUE_SUPERVISOR_LOST", "LEASE_EXPIRED_REVIEW",
  "CHECKPOINT_RESUME_BLOCKED", "LOCAL_RUN_STOPPED", "LOCAL_STOP_REQUESTED", "LOCAL_LEASE_HEARTBEAT_LOST", "CHECKPOINT_RESUME_REQUESTED"]);

function normalizeAdvanced(input: unknown): AdvancedFilterCatalog | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const options = (value: unknown, label: string): FilterOption[] => {
    if (!Array.isArray(value)) throw new CollectorControlError(`${label}目录缺失`, "INVALID_FILTER_CATALOG");
    const seen = new Set<string>();
    return value.map((item) => {
      const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const key = cleanText(entry.key, 120, `${label}键`);
      if (!/^[a-z0-9][a-z0-9._:,-]*$/i.test(key) || seen.has(key)) throw new CollectorControlError(`${label}键无效或重复`, "INVALID_FILTER_CATALOG");
      seen.add(key);
      return { key, label: cleanText(entry.label, 160, `${label}名称`) };
    });
  };
  const countries = Array.isArray(raw.locations) ? raw.locations : [];
  const locationKeys = new Set<string>();
  const locations = countries.map((item) => {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const countryKey = cleanText(entry.key, 120, "国家键");
    if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(countryKey) || locationKeys.has(countryKey)) throw new CollectorControlError("国家键无效或重复", "INVALID_FILTER_CATALOG");
    locationKeys.add(countryKey);
    return { key: countryKey, label: cleanText(entry.label, 160, "国家名称"), cities: options(entry.cities, "城市") };
  });
  return {
    keywordModes: options(raw.keywordModes, "关键词模式"),
    nameSupported: raw.nameSupported === true,
    locations,
    jobRoles: options(raw.jobRoles, "职能"),
    industries: options(raw.industries, "行业"),
    exclusionSupported: raw.exclusionSupported === true,
    reliable: raw.reliable === true,
    reason: optionalText(raw.reason, 240) || null,
  };
}

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
  const advanced = normalizeAdvanced(source.advanced);
  const signature = JSON.stringify({ filters, sorts, advanced });
  return {
    version: `bayt-${hashToken(signature).slice(0, 16)}`,
    status: "ready",
    filters,
    sorts,
    advanced,
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
        agent_id TEXT NOT NULL,
        advanced_json TEXT
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
        client_request_id TEXT,
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
      CREATE TABLE IF NOT EXISTS collector_job_runs (
        run_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        search_id TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES collector_jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_collector_job_runs_job ON collector_job_runs(job_id);
      CREATE TABLE IF NOT EXISTS collector_job_people (
        job_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        page_no INTEGER NOT NULL,
        cv_id TEXT NOT NULL,
        import_batch_id TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (job_id, cv_id),
        FOREIGN KEY (job_id) REFERENCES collector_jobs(id),
        FOREIGN KEY (run_id) REFERENCES collector_job_runs(run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_collector_job_people_cv ON collector_job_people(cv_id);
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
    const catalogColumns = this.db.prepare("PRAGMA table_info(collector_filter_catalogs)").all() as Array<{ name: string }>;
    if (!catalogColumns.some((column) => column.name === "advanced_json")) this.db.exec("ALTER TABLE collector_filter_catalogs ADD COLUMN advanced_json TEXT");
    const jobColumns = this.db.prepare("PRAGMA table_info(collector_jobs)").all() as Array<{ name: string }>;
    if (!jobColumns.some((column) => column.name === "client_request_id")) this.db.exec("ALTER TABLE collector_jobs ADD COLUMN client_request_id TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_collector_jobs_client_request ON collector_jobs(client_request_id) WHERE client_request_id IS NOT NULL");
    for (const name of ["collection_finished_at", "collection_phase", "next_action_at", "delivery_error", "recovery_json"])
      if (!jobColumns.some(column => column.name === name)) this.db.exec(`ALTER TABLE collector_jobs ADD COLUMN ${name} TEXT`);
    const runColumns = this.db.prepare("PRAGMA table_info(collector_job_runs)").all() as Array<{ name: string }>;
    for (const name of ["agent_id", "upload_token_hash", "finished_json"])
      if (!runColumns.some(column => column.name === name)) this.db.exec(`ALTER TABLE collector_job_runs ADD COLUMN ${name} TEXT`);
    const agentColumns = this.db.prepare("PRAGMA table_info(collector_agents)").all() as Array<{ name: string }>;
    for (const name of ["wait_reason", "next_action_at", "verification_id"])
      if (!agentColumns.some(column => column.name === name)) this.db.exec(`ALTER TABLE collector_agents ADD COLUMN ${name} TEXT`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS collector_local_pages (
      job_id TEXT NOT NULL, run_id TEXT NOT NULL, page_no INTEGER NOT NULL, selected_count INTEGER NOT NULL,
      evidence_json TEXT NOT NULL, collected_at TEXT NOT NULL, PRIMARY KEY(job_id, page_no),
      FOREIGN KEY(job_id) REFERENCES collector_jobs(id), FOREIGN KEY(run_id) REFERENCES collector_job_runs(run_id));
      CREATE TABLE IF NOT EXISTS collector_verification_requests (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, verification_id TEXT NOT NULL, status TEXT NOT NULL,
      requested_at TEXT NOT NULL, completed_at TEXT, detail TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_active ON collector_verification_requests(agent_id, verification_id)
        WHERE status IN ('pending','checking');`);
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
        advanced: parseJson<AdvancedFilterCatalog | null>(row.advanced_json, null),
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
    if (!agentId.startsWith("local-ego-")) return null;
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
    if (catalog.advanced && !agentId.startsWith("local-ego-")) throw new CollectorControlError("高级目录只接受本机Ego同步", "ADVANCED_CATALOG_AGENT_MISMATCH", 409);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE collector_filter_catalogs SET status = 'stale' WHERE status = 'ready'").run();
      this.db.prepare(`INSERT OR REPLACE INTO collector_filter_catalogs(
        version, status, filters_json, sorts_json, synchronized_at, agent_id, advanced_json
      ) VALUES (?, 'ready', ?, ?, ?, ?, ?)`)
        .run(catalog.version, JSON.stringify(catalog.filters), JSON.stringify(catalog.sorts), catalog.synchronizedAt, agentId, JSON.stringify(catalog.advanced || null));
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
    if (source.schemaVersion === 2) return this.validateAdvancedSearchSpec(source);
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

  private validateAdvancedSearchSpec(source: Record<string, unknown>): SearchSpec {
    const catalog = this.getCatalog().catalog;
    if (!catalog || catalog.version !== source.filterSchemaVersion || catalog.status !== "ready" ||
      !catalog.advanced?.reliable || !catalog.agentId.startsWith("local-ego-") ||
      Date.now() - Date.parse(catalog.synchronizedAt) > 24 * 60 * 60 * 1000) {
      throw new CollectorControlError("本机Ego高级筛选目录不可用或已过期，请重新同步", "ADVANCED_CATALOG_UNAVAILABLE", 409);
    }
    const advanced = catalog.advanced;
    const keyword = optionalText(source.keyword, 160);
    const name = optionalText(source.name, 160);
    const approximateLocationKeyword = optionalText(source.approximateLocationKeyword, 160);
    if (!keyword && !name && !approximateLocationKeyword) throw new CollectorControlError("至少填写关键词、姓名或近似地点", "INVALID_SEARCH_SPEC");
    if (name && !/^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u.test(name)) {
      throw new CollectorControlError("官网姓名筛选不接受数字或特殊字符；带连字符的姓名可改用关键词近似搜索", "INVALID_NAME_FILTER", 422);
    }
    if ([keyword, name, approximateLocationKeyword].some((value) => /https?:\/\/|cookie|authorization|selector|request.?headers?/i.test(value))) {
      throw new CollectorControlError("条件包含不允许的请求信息", "UNSAFE_SEARCH_SPEC");
    }
    if (name && !advanced.nameSupported) throw new CollectorControlError("官网姓名控件不可用", "ADVANCED_CONTROL_UNAVAILABLE", 409);
    const keywordMode = String(source.keywordMode || "");
    if (!advanced.keywordModes.some((item) => item.key === keywordMode)) throw new CollectorControlError("关键词模式不在官网目录", "INVALID_SEARCH_SPEC");
    const locations = Array.isArray(source.pastJobLocations) ? source.pastJobLocations : [];
    if (locations.length > 8 || (locations.length && approximateLocationKeyword)) throw new CollectorControlError("精确地点与近似地点必须分别入队", "APPROXIMATE_LOCATION_CONFLICT");
    const pastJobLocations = locations.map((entry) => {
      const location = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      const countryKey = String(location.countryKey || "");
      const cityKey = location.cityKey ? String(location.cityKey) : null;
      const country = advanced.locations.find((item) => item.key === countryKey);
      if (!country || (cityKey && !country.cities.some((city) => city.key === cityKey))) throw new CollectorControlError("工作地点不在官网目录", "INVALID_LOCATION_SELECTION");
      return { countryKey, cityKey };
    });
    if (new Set(pastJobLocations.map((item) => `${item.countryKey}:${item.cityKey || ""}`)).size !== pastJobLocations.length) throw new CollectorControlError("工作地点不能重复", "INVALID_LOCATION_SELECTION");
    const keys = (field: string, allowed: FilterOption[]) => {
      const raw = source[field];
      if (!Array.isArray(raw) || raw.length > 30) throw new CollectorControlError(`${field}格式无效`, "INVALID_FILTER_SELECTION");
      const values = raw.map(String);
      if (new Set(values).size !== values.length || values.some((key) => !allowed.some((option) => option.key === key))) throw new CollectorControlError(`${field}选项不在官网目录`, "INVALID_FILTER_SELECTION");
      return values;
    };
    const includeJobRoles = keys("includeJobRoles", advanced.jobRoles);
    const excludeJobRoles = keys("excludeJobRoles", advanced.jobRoles);
    const includeIndustries = keys("includeIndustries", advanced.industries);
    const excludeIndustries = keys("excludeIndustries", advanced.industries);
    if ((!advanced.exclusionSupported && (excludeJobRoles.length || excludeIndustries.length)) ||
      includeJobRoles.some((key) => excludeJobRoles.includes(key)) || includeIndustries.some((key) => excludeIndustries.includes(key))) {
      throw new CollectorControlError("排除条件不可用或与包含条件冲突", "INVALID_EXCLUSION_SELECTION");
    }
    if (Array.isArray(source.filters) && source.filters.length) throw new CollectorControlError("新版条件不能混用旧Filter", "INVALID_SEARCH_SPEC");
    const sortKey = source.sortKey ? String(source.sortKey) : null;
    if (sortKey && !catalog.sorts.some((item) => item.key === sortKey)) throw new CollectorControlError("排序方式不在官网目录", "INVALID_SORT_KEY");
    return { schemaVersion: 2, keyword, keywordMode, name: name || null, filterSchemaVersion: catalog.version,
      filters: [], sortKey, pastJobLocations, includeJobRoles, excludeJobRoles, includeIndustries, excludeIndustries,
      approximateLocationKeyword: approximateLocationKeyword || null };
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
    const name = cleanText(input.name || template?.name || searchSpec.keyword, 100, "任务名称");
    const clientRequestId = input.clientRequestId ? String(input.clientRequestId) : null;
    if (clientRequestId && !/^[a-zA-Z0-9_-]{8,100}$/.test(clientRequestId)) throw new CollectorControlError("请求去重键无效", "INVALID_CLIENT_REQUEST_ID");
    const id = randomId("job");
    const createdAt = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (clientRequestId) {
        const existing = this.db.prepare("SELECT id FROM collector_jobs WHERE client_request_id = ?").get(clientRequestId) as { id: string } | undefined;
        if (existing) {
          const job = this.getJob(existing.id)!;
          if (job.name !== name || JSON.stringify(job.searchSpec) !== JSON.stringify(searchSpec) || JSON.stringify(job.limits) !== JSON.stringify(limits)) {
            throw new CollectorControlError("同一请求键对应不同任务", "CLIENT_REQUEST_CONFLICT", 409);
          }
          this.db.exec("COMMIT");
          return job;
        }
      }
      this.db.prepare(`INSERT INTO collector_jobs(
        id, template_id, schedule_id, source, name, search_spec_json, limits_json, status,
        queue_position, scheduled_for, created_at, client_request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
        .run(id, templateId, input.scheduleId ? String(input.scheduleId) : null, source, name,
          JSON.stringify(searchSpec), JSON.stringify(limits), this.nextQueuePosition(),
          input.scheduledFor ? String(input.scheduledFor) : null, createdAt, clientRequestId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getJob(id)!;
  }

  private jobFromRow(row: Record<string, unknown>): CollectionJob {
    const id = String(row.id);
    const pages = (this.db.prepare("SELECT * FROM collector_job_pages WHERE job_id = ? ORDER BY page_no").all(id) as Record<string, unknown>[]).map(pageFromRow);
    const local = this.db.prepare("SELECT COUNT(*) AS pages, COALESCE(SUM(selected_count),0) AS count FROM collector_local_pages WHERE job_id = ?").get(id) as { pages: number; count: number };
    const displayed = this.db.prepare("SELECT COUNT(*) AS count FROM collector_job_people WHERE job_id = ?").get(id) as { count: number };
    const runs = this.db.prepare("SELECT COUNT(*) AS count FROM collector_job_runs WHERE job_id = ? AND search_id = ?").get(id, String(row.search_id || "")) as { count: number };
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
      collectedPages: Math.max(Number(local.pages), Number(row.completed_pages)),
      collectedCount: Math.max(Number(local.count), Number(row.exported_count)),
      displayedCount: Number(displayed.count),
      collectionFinishedAt: row.collection_finished_at ? String(row.collection_finished_at) : null,
      phase: row.collection_phase ? String(row.collection_phase) : null,
      nextActionAt: row.next_action_at ? String(row.next_action_at) : null,
      deliveryError: row.delivery_error ? String(row.delivery_error) : null,
      recovery: parseJson<BrowserRecovery | null>(row.recovery_json, null),
      resumeMode: !row.search_id ? "new_search" : runs.count === 1 &&
        (row.status === "paused" || checkpointResumeCodes.has(String(row.error_code || ""))) ? "checkpoint" : "review",
    };
  }

  listJobs(limit = 200): CollectionJob[] {
    return (this.db.prepare("SELECT * FROM collector_jobs ORDER BY CASE WHEN status = 'running' THEN 0 WHEN status = 'queued' THEN 1 ELSE 2 END, queue_position, created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((row) => this.jobFromRow(row));
  }

  getJob(id: string): CollectionJob | null {
    const row = this.db.prepare("SELECT * FROM collector_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.jobFromRow(row) : null;
  }

  agentJobState(id: string, agentId: string): Pick<CollectionJob, "id" | "status" | "searchId" | "completedPages" | "collectedPages" | "collectionFinishedAt"> {
    const job = this.getJob(id);
    const ownedRun = this.db.prepare("SELECT run_id FROM collector_job_runs WHERE job_id = ? AND agent_id = ? LIMIT 1").get(id, agentId);
    if (!job || !agentId.startsWith("local-ego-") || (job.agentId !== agentId && !ownedRun))
      throw new CollectorControlError("Agent不可读取该任务", "AGENT_JOB_NOT_FOUND", 404);
    return { id: job.id, status: job.status, searchId: job.searchId, completedPages: job.completedPages,
      collectedPages: job.collectedPages, collectionFinishedAt: job.collectionFinishedAt };
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
    if (!job || !(job.status === "queued" || job.status === "paused" || (job.status === "running" && job.recovery)))
      throw new CollectorControlError("只有待执行、等待恢复或已暂停任务可以取消", "JOB_NOT_CANCELLABLE", 409);
    this.db.prepare("UPDATE collector_jobs SET status = 'cancelled', queue_position = NULL, lease_token_hash = NULL, lease_expires_at = NULL, completed_at = ? WHERE id = ?").run(nowIso(), id);
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
    if (job.searchId) throw new CollectorControlError("已有搜索检查点的任务必须保留原运行范围和截止时间", "CHECKPOINT_LIMITS_IMMUTABLE", 409);
    // Only an unstarted search may change its limits.
    this.db.prepare("UPDATE collector_jobs SET limits_json = ?, started_at = NULL WHERE id = ?").run(JSON.stringify(limits), id);
    return this.getJob(id)!;
  }

  resumeJob(id: string): CollectionJob {
    const job = this.getJob(id);
    if (!job || !["paused", "safety_stopped", "failed"].includes(job.status)) {
      throw new CollectorControlError("任务当前不可恢复", "JOB_NOT_RESUMABLE", 409);
    }
    if (job.searchId) {
      if (job.resumeMode !== "checkpoint") {
        throw new CollectorControlError("该检查点尚不支持自动续跑；需核对本机运行状态和下载意图", "JOB_CHECKPOINT_RESUME_REQUIRED", 409);
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE collector_jobs SET status = 'queued', queue_position = ?, pause_requested = 0,
        agent_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
        error_code = CASE WHEN search_id IS NULL THEN NULL ELSE COALESCE(error_code, 'CHECKPOINT_RESUME_REQUESTED') END,
        error_message = CASE WHEN search_id IS NULL THEN NULL ELSE error_message END,
        completed_at = NULL WHERE id = ?`).run(this.nextQueuePosition(), id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getJob(id)!;
  }

  acknowledgeGlobalPause(reason: unknown): Record<string, unknown> {
    const explanation = cleanText(reason, 500, "解除原因");
    const active = this.db.prepare("SELECT id FROM collector_jobs WHERE status IN ('running','pause_requested') LIMIT 1").get();
    if (active) throw new CollectorControlError("仍有运行任务，不能解除全局安全暂停", "ACTIVE_JOB_PRESENT", 409);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.getControlState();
      if (!state.globallyPaused) throw new CollectorControlError("当前没有全局安全暂停", "NOT_GLOBALLY_PAUSED", 409);
      this.db.prepare("INSERT INTO collector_schedule_events(id, schedule_id, event_type, detail, created_at) VALUES (?, ?, 'global_pause_acknowledged', ?, ?)")
        .run(randomId("audit"), "global", explanation, nowIso());
      this.db.prepare("UPDATE collector_control_state SET globally_paused = 0, pause_code = NULL, pause_message = NULL, paused_at = NULL, updated_at = ? WHERE singleton = 1").run(nowIso());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getControlState();
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
      browserNextActionAt: this.browserNextActionAt(),
    };
  }

  private browserNextActionAt(): string | null {
    const row = this.db.prepare("SELECT MAX(json_extract(finished_json, '$.cooldownUntil')) AS value FROM collector_job_runs WHERE finished_json IS NOT NULL").get() as { value: string | null };
    return row.value && Date.parse(row.value) > Date.now() ? row.value : null;
  }

  requestVerification(agentId: string, verificationId: string): Record<string, unknown> {
    const agent = this.listAgents().find(item => item.id === agentId);
    if (!agent || agent.status !== "online" || agent.loginState !== "verification_required" ||
      !verificationId || agent.verificationId !== verificationId)
      throw new CollectorControlError("验证状态已变化，请刷新后重试", "VERIFICATION_STATE_CHANGED", 409);
    const existing = this.db.prepare("SELECT * FROM collector_verification_requests WHERE agent_id = ? AND verification_id = ? AND status IN ('pending','checking')")
      .get(agentId, verificationId) as Record<string, unknown> | undefined;
    if (existing) return existing;
    const id = randomId("verification");
    this.db.prepare("INSERT INTO collector_verification_requests(id,agent_id,verification_id,status,requested_at) VALUES (?,?,?,'pending',?)")
      .run(id, agentId, verificationId, nowIso());
    return { id, status: "pending" };
  }

  claimVerification(agentId: string, verificationId: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM collector_verification_requests WHERE agent_id = ? AND verification_id = ? AND status IN ('pending','checking') ORDER BY requested_at LIMIT 1")
      .get(agentId, verificationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE collector_verification_requests SET status = 'checking' WHERE id = ?").run(String(row.id));
    return { id: row.id, verificationId: row.verification_id, interrupted: row.status === "checking" };
  }

  completeVerification(agentId: string, id: string, verificationId: string, verified: boolean): void {
    const row = this.db.prepare("SELECT * FROM collector_verification_requests WHERE id = ? AND agent_id = ? AND verification_id = ?")
      .get(id, agentId, verificationId) as Record<string, unknown> | undefined;
    const status = verified ? "verified" : "failed";
    if (!row || !["checking", status].includes(String(row.status)))
      throw new CollectorControlError("验证请求状态不匹配", "VERIFICATION_STATE_CHANGED", 409);
    this.db.prepare("UPDATE collector_verification_requests SET status = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?")
      .run(status, nowIso(), id);
    // Global pause is deliberately untouched, even on successful verification.
  }

  heartbeatAgent(input: Record<string, unknown>): AgentState {
    const id = cleanText(input.agentId, 100, "Agent ID");
    const timestamp = nowIso();
    const name = cleanText(input.name || id, 120, "Agent名称");
    const version = cleanText(input.version || "unknown", 80, "Agent版本");
    const loginState = ["unknown", "logged_in", "login_required", "verification_required"].includes(String(input.loginState)) ? String(input.loginState) : "unknown";
    this.db.prepare(`INSERT INTO collector_agents(id, name, version, last_heartbeat_at, current_job_id, chrome_ready, login_state)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version,
      last_heartbeat_at=excluded.last_heartbeat_at, current_job_id=excluded.current_job_id,
      chrome_ready=excluded.chrome_ready, login_state=excluded.login_state`)
      .run(id, name, version, timestamp, input.currentJobId ? String(input.currentJobId) : null, input.chromeReady ? 1 : 0, loginState);
    this.db.prepare("UPDATE collector_agents SET wait_reason = ?, next_action_at = ?, verification_id = ? WHERE id = ?")
      .run(optionalText(input.waitReason, 100) || null, input.nextActionAt && Number.isFinite(Date.parse(String(input.nextActionAt))) ? String(input.nextActionAt) : null,
        optionalText(input.verificationId, 128) || null, id);
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
      waitReason: row.wait_reason ? String(row.wait_reason) : null,
      nextActionAt: row.next_action_at ? String(row.next_action_at) : null,
      verificationId: row.verification_id ? String(row.verification_id) : null,
    }));
  }

  recoverExpiredLeases(at = new Date()): number {
    const expired = this.db.prepare("SELECT id FROM collector_jobs WHERE status IN ('running','pause_requested') AND lease_expires_at < ?").all(at.toISOString()) as { id: string }[];
    let unsafe = 0;
    for (const item of expired) {
      // Durable no-download recovery retains ownership across a restart. It
      // can only be reclaimed with the previous lease proof, never by another job.
      if (automaticRecovery(this.getJob(item.id)?.recovery)) continue;
      unsafe++;
      this.db.prepare(`UPDATE collector_jobs SET status = 'safety_stopped', queue_position = NULL, pause_requested = 0,
        agent_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
        error_code = 'LEASE_EXPIRED_REVIEW', error_message = '租约过期；需核对本机下载意图与完整页检查点后人工恢复' WHERE id = ?`)
        .run(item.id);
    }
      if (unsafe) this.db.prepare("UPDATE collector_control_state SET globally_paused = 1, pause_code = 'LEASE_EXPIRED_REVIEW', pause_message = '本机采集租约过期，检查未确定下载后再恢复', paused_at = ?, updated_at = ? WHERE singleton = 1")
      .run(nowIso(), nowIso());
    return unsafe;
  }

  reclaimRecovery(jobId: string, agentId: string, oldToken: string, newToken: string, recoveryId: string): CollectionJob {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(newToken)) throw new CollectorControlError("恢复令牌无效", "RECOVERY_TOKEN_INVALID", 409);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.getJob(jobId);
      const row = this.db.prepare("SELECT lease_token_hash FROM collector_jobs WHERE id = ?").get(jobId) as { lease_token_hash: string } | undefined;
      const other = this.db.prepare("SELECT id FROM collector_jobs WHERE id != ? AND status IN ('running','pause_requested') LIMIT 1").get(jobId);
      if (!job || job.agentId !== agentId || !["running", "pause_requested"].includes(job.status) ||
        !automaticRecovery(job.recovery) || job.recovery.id !== recoveryId || !row || other || this.getControlState().globallyPaused ||
        ![hashToken(oldToken), hashToken(newToken)].includes(row.lease_token_hash))
        throw new CollectorControlError("自动恢复身份、检查点或安全状态已改变", "RECOVERY_RECLAIM_BLOCKED", 409);
      this.db.prepare("UPDATE collector_jobs SET lease_token_hash = ?, lease_expires_at = ? WHERE id = ?")
        .run(hashToken(newToken), new Date(Date.now() + 120_000).toISOString(), jobId);
      this.db.exec("COMMIT");
      return this.getJob(jobId)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  dailyExportedCount(at = new Date()): number {
    const bounds = beijingDateBounds(at);
    const row = this.db.prepare(`SELECT COALESCE(SUM(selected_count), 0) AS total FROM (
      SELECT selected_count FROM collector_local_pages WHERE collected_at >= ? AND collected_at < ?
      UNION ALL SELECT p.selected_count FROM collector_job_pages p WHERE p.uploaded_at >= ? AND p.uploaded_at < ?
        AND NOT EXISTS(SELECT 1 FROM collector_local_pages l WHERE l.job_id = p.job_id AND l.page_no = p.page_no))`)
      .get(bounds.start, bounds.end, bounds.start, bounds.end) as { total: number };
    return Number(row.total);
  }

  claimJob(agentId: string, leaseMs = 120_000): { job: CollectionJob | null; leaseToken?: string; resumeRunId?: string; waitReason?: string; waitUntil?: string } {
    this.recoverExpiredLeases();
    if (!agentId.startsWith("local-ego-")) return { job: null, waitReason: "local_ego_only" };
    const state = this.getControlState();
    if (state.globallyPaused) return { job: null, waitReason: "global_safety_pause" };
    if (state.runningJobId) return { job: null, waitReason: "another_job_running" };
    if (state.browserNextActionAt) return { job: null, waitReason: "browser_cooldown", waitUntil: String(state.browserNextActionAt) };
    const agent = this.listAgents().find(item => item.id === agentId);
    if (agent?.loginState === "verification_required") return { job: null, waitReason: "verification_required" };
    const catalog = this.getCatalog().catalog;
    const catalogReady = Boolean(catalog?.advanced?.reliable && catalog.agentId.startsWith("local-ego-") &&
      Date.now() - Date.parse(catalog.synchronizedAt) <= 24 * 60 * 60 * 1000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const running = this.db.prepare("SELECT id FROM collector_jobs WHERE status IN ('running','pause_requested') LIMIT 1").get();
      if (running) {
        this.db.exec("COMMIT");
        return { job: null, waitReason: "another_job_running" };
      }
      const rows = this.db.prepare("SELECT * FROM collector_jobs WHERE status = 'queued' ORDER BY queue_position, created_at").all() as Record<string, unknown>[];
      const eligible = rows.map(row => this.jobFromRow(row)).find(job => job.searchSpec.schemaVersion === 2 &&
        (job.searchId ? job.resumeMode === "checkpoint" : catalogReady && job.searchSpec.filterSchemaVersion === catalog?.version));
      const row = eligible ? { id: eligible.id, search_id: eligible.searchId, error_code: eligible.errorCode } : undefined;
      let resumeRunId: string | undefined;
      if (row?.search_id) {
        const runs = this.db.prepare("SELECT run_id, search_id FROM collector_job_runs WHERE job_id = ?").all(row.id) as Array<{ run_id: string; search_id: string }>;
        if (runs.length !== 1 || runs[0].search_id !== row.search_id) {
          this.db.exec("COMMIT");
          return { job: null, waitReason: "checkpoint_resume_required" };
        }
        resumeRunId = runs[0].run_id;
      }
      if (!row?.id) {
        this.db.exec("COMMIT");
        const blocked = this.db.prepare("SELECT search_id FROM collector_jobs WHERE status = 'queued' LIMIT 1").get() as { search_id?: string | null } | undefined;
        return { job: null, waitReason: blocked?.search_id ? "checkpoint_resume_required" : blocked ? catalogReady ? "search_requires_revalidation" : "catalog_unavailable" : "queue_empty" };
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
      return { job: this.getJob(row.id), leaseToken, ...(resumeRunId ? { resumeRunId } : {}) };
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

  registerRun(jobId: string, agentId: string, leaseToken: string, runId: unknown, searchId: unknown, uploadToken?: unknown): void {
    const job = this.verifyLease(jobId, agentId, leaseToken);
    const run = String(runId || "");
    const search = String(searchId || "");
    if (!["running", "pause_requested"].includes(job.status) || job.searchSpec.schemaVersion !== 2 ||
      !/^local-ego-[A-Za-z0-9_-]{1,70}$/.test(run) || !/^[A-Za-z0-9_-]{4,200}$/.test(search) ||
      (job.searchId && job.searchId !== search)) {
      throw new CollectorControlError("任务运行标识不匹配", "RUN_JOB_LINK_INVALID", 409);
    }
    const existing = this.db.prepare("SELECT job_id, search_id, upload_token_hash FROM collector_job_runs WHERE run_id = ?").get(run) as
      { job_id: string; search_id: string; upload_token_hash: string | null } | undefined;
    if (existing && (existing.job_id !== jobId || existing.search_id !== search))
      throw new CollectorControlError("运行ID已绑定其他任务", "RUN_JOB_LINK_CONFLICT", 409);
    if (!existing && this.db.prepare("SELECT run_id FROM collector_job_runs WHERE job_id = ? LIMIT 1").get(jobId))
      throw new CollectorControlError("已有运行不能重新建搜索", "RUN_JOB_LINK_CONFLICT", 409);
    const token = uploadToken === undefined ? null : String(uploadToken);
    if (token !== null && !/^[A-Za-z0-9_-]{43,128}$/.test(token))
      throw new CollectorControlError("上传令牌无效", "UPLOAD_TOKEN_INVALID", 409);
    if (token && existing?.upload_token_hash && existing.upload_token_hash !== hashToken(token))
      throw new CollectorControlError("原运行上传令牌不匹配", "UPLOAD_TOKEN_CONFLICT", 409);
    this.db.prepare("INSERT OR IGNORE INTO collector_job_runs(run_id, job_id, search_id, registered_at) VALUES (?, ?, ?, ?)")
      .run(run, jobId, search, nowIso());
    this.db.prepare("UPDATE collector_jobs SET search_id = COALESCE(search_id, ?) WHERE id = ?").run(search, jobId);
    if (token) {
      this.db.prepare("UPDATE collector_job_runs SET agent_id = ?, upload_token_hash = ? WHERE run_id = ?")
        .run(agentId, hashToken(token), run);
    }
  }

  jobForRun(runId: string): string | null {
    const row = this.db.prepare("SELECT job_id FROM collector_job_runs WHERE run_id = ?").get(runId) as { job_id: string } | undefined;
    return row?.job_id || null;
  }

  recordDisplayedPeople(input: { jobId: string; runId: string; page: number; importBatchId: string; cvIds: string[]; importedAt?: string }): void {
    if (this.jobForRun(input.runId) !== input.jobId || !Number.isInteger(input.page) || input.page < 1 ||
      !input.importBatchId || !input.cvIds.length || input.cvIds.length > 50 ||
      new Set(input.cvIds).size !== input.cvIds.length || input.cvIds.some((id) => !/^\d+$/.test(id)))
      throw new CollectorControlError("人物溯源证据不匹配", "PERSON_PROVENANCE_INVALID", 409);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const importedAt = input.importedAt && Number.isFinite(Date.parse(input.importedAt)) ? input.importedAt : nowIso();
      for (const cvId of input.cvIds) {
        const existing = this.db.prepare("SELECT run_id, page_no, import_batch_id FROM collector_job_people WHERE job_id = ? AND cv_id = ?")
          .get(input.jobId, cvId) as { run_id: string; page_no: number; import_batch_id: string } | undefined;
        if (existing && (existing.run_id !== input.runId || existing.page_no !== input.page || existing.import_batch_id !== input.importBatchId))
          throw new CollectorControlError("同一任务的人物来源发生冲突", "PERSON_PROVENANCE_CONFLICT", 409);
        this.db.prepare("INSERT OR IGNORE INTO collector_job_people(job_id, run_id, page_no, cv_id, import_batch_id, imported_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(input.jobId, input.runId, input.page, cvId, input.importBatchId, importedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  peopleForJob(jobId: string): Array<{ cvId: string; runId: string; page: number; importBatchId: string; importedAt: string }> {
    return (this.db.prepare("SELECT cv_id, run_id, page_no, import_batch_id, imported_at FROM collector_job_people WHERE job_id = ? ORDER BY page_no, cv_id")
      .all(jobId) as Array<{ cv_id: string; run_id: string; page_no: number; import_batch_id: string; imported_at: string }> )
      .map((row) => ({ cvId: row.cv_id, runId: row.run_id, page: row.page_no, importBatchId: row.import_batch_id, importedAt: row.imported_at }));
  }

  personForJob(jobId: string, cvId: string): { importBatchId: string; runId: string; page: number } | null {
    const row = this.db.prepare("SELECT import_batch_id, run_id, page_no FROM collector_job_people WHERE job_id = ? AND cv_id = ?")
      .get(jobId, cvId) as { import_batch_id: string; run_id: string; page_no: number } | undefined;
    return row ? { importBatchId: row.import_batch_id, runId: row.run_id, page: row.page_no } : null;
  }

  sourcesForPeople(cvIds: string[], isDisplayed: (runId: string, page: number) => boolean = () => true): Map<string, Array<{ id: string; name: string; page: number; importedAt: string }>> {
    const result = new Map<string, Array<{ id: string; name: string; page: number; importedAt: string }>>();
    if (!cvIds.length) return result;
    const unique = [...new Set(cvIds)].filter((id) => /^\d+$/.test(id));
    if (!unique.length) return result;
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT p.cv_id, p.job_id, p.run_id, j.name, p.page_no, p.imported_at FROM collector_job_people p JOIN collector_jobs j ON j.id = p.job_id WHERE p.cv_id IN (${placeholders}) ORDER BY p.imported_at DESC, p.job_id`)
      .all(...unique) as Array<{ cv_id: string; job_id: string; run_id: string; name: string; page_no: number; imported_at: string }>;
    for (const row of rows) {
      if (!isDisplayed(row.run_id, row.page_no)) continue;
      const items = result.get(row.cv_id) || [];
      items.push({ id: row.job_id, name: row.name, page: row.page_no, importedAt: row.imported_at });
      result.set(row.cv_id, items);
    }
    return result;
  }

  heartbeatJob(jobId: string, agentId: string, leaseToken: string, evidence: Record<string, unknown> = {}, leaseMs = 120_000): CollectionJob {
    const job = this.verifyLease(jobId, agentId, leaseToken);
    if (evidence.recovery !== undefined) {
      if (evidence.recovery !== null && (!validRecovery(evidence.recovery) || evidence.noDownloadIntent !== true))
        throw new CollectorControlError("恢复检查点不完整或存在下载意图", "RECOVERY_EVIDENCE_INVALID", 409);
      this.db.prepare("UPDATE collector_jobs SET recovery_json = ? WHERE id = ?")
        .run(evidence.recovery ? JSON.stringify(evidence.recovery) : null, jobId);
    }
    if (job.searchId && evidence.searchId && evidence.searchId !== job.searchId)
      throw new CollectorControlError("搜索标识变化", "RUN_JOB_LINK_INVALID", 409);
    this.db.prepare(`UPDATE collector_jobs SET lease_expires_at = ?, search_id = COALESCE(?, search_id),
      matched_count = COALESCE(?, matched_count), actual_filter_labels_json = CASE WHEN ? IS NULL THEN actual_filter_labels_json ELSE ? END
      WHERE id = ?`).run(
        new Date(Date.now() + leaseMs).toISOString(),
        evidence.searchId ? String(evidence.searchId).slice(0, 200) : null,
        evidence.matchedCount !== null && evidence.matchedCount !== undefined &&
          Number.isInteger(Number(evidence.matchedCount)) && Number(evidence.matchedCount) >= 0 ? Number(evidence.matchedCount) : null,
        Array.isArray(evidence.actualFilterLabels) ? 1 : null,
        Array.isArray(evidence.actualFilterLabels) ? JSON.stringify(evidence.actualFilterLabels.map(String).slice(0, 100)) : null,
        jobId,
      );
    if (evidence.phase !== undefined) this.db.prepare("UPDATE collector_jobs SET collection_phase = ?, next_action_at = ? WHERE id = ?")
      .run(optionalText(evidence.phase, 80) || null,
        evidence.nextActionAt && Number.isFinite(Date.parse(String(evidence.nextActionAt))) ? String(evidence.nextActionAt) : null, jobId);
    return this.getJob(job.id)!;
  }

  checkpointPage(jobId: string, agentId: string, leaseToken: string, input: Record<string, unknown>): CollectionJob {
    const job = this.verifyLease(jobId, agentId, leaseToken);
    return this.storeUploadedPage(job, input);
  }

  authorizeUpload(jobId: string, agentId: string, runId: string, token: string): void {
    const row = this.db.prepare("SELECT job_id,agent_id,upload_token_hash FROM collector_job_runs WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    if (!row || row.job_id !== jobId || row.agent_id !== agentId || !token || row.upload_token_hash !== hashToken(token))
      throw new CollectorControlError("上传运行认证失败", "UPLOAD_RUN_UNAUTHORIZED", 403);
  }

  checkpointUpload(jobId: string, agentId: string, input: Record<string, unknown>): CollectionJob {
    this.authorizeUpload(jobId, agentId, String(input.runId || ""), String(input.uploadToken || ""));
    const match = String(input.remoteBatch || "").match(/\/(local-ego-[A-Za-z0-9_-]{1,70})\/batch-(\d{4})$/);
    if (!match || match[1] !== input.runId) throw new CollectorControlError("上传运行不匹配", "RUN_JOB_LINK_INVALID", 409);
    return this.storeUploadedPage(this.getJob(jobId)!, input);
  }

  private saveLocalPages(jobId: string, runId: string, input: unknown): void {
    if (this.jobForRun(runId) !== jobId || !Array.isArray(input) || input.length > 10000)
      throw new CollectorControlError("本机页检查点不匹配", "LOCAL_CHECKPOINT_INVALID", 409);
    const evidence = input.map(item => pageEvidence(item));
    const previous = this.db.prepare("SELECT page_no,run_id,evidence_json FROM collector_local_pages WHERE job_id = ? ORDER BY page_no").all(jobId) as Array<{ page_no: number; run_id: string; evidence_json: string }>;
    if (previous.length > evidence.length) throw new CollectorControlError("检查点不能倒退", "LOCAL_CHECKPOINT_REGRESSION", 409);
    for (let index = 0; index < evidence.length; index++) {
      const item = evidence[index];
      if (item.page !== index + 1 || (previous[index] && (previous[index].run_id !== runId || previous[index].evidence_json !== JSON.stringify(item))))
        throw new CollectorControlError("本机页证据发生变化", "PAGE_CHECKPOINT_CONFLICT", 409);
    }
    const job = this.getJob(jobId)!;
    for (const page of job.pages) {
      if (JSON.stringify(evidence[page.page - 1]) !== JSON.stringify(pageEvidence(page as unknown as Record<string, unknown>)))
        throw new CollectorControlError("本机页与已上传页不匹配", "PAGE_CHECKPOINT_CONFLICT", 409);
    }
    const freshCount = evidence.filter(item => !previous.some(p => p.page_no === item.page) && !job.pages.some(p => p.page === item.page))
      .reduce((sum, item) => sum + Number(item.selectedCount), 0);
    if (!job.limits.durationHours && this.dailyExportedCount() + freshCount > 500)
      throw new CollectorControlError("完整页超过每日上限", "DAILY_EXPORT_LIMIT", 409);
    for (const item of evidence) this.db.prepare("INSERT OR IGNORE INTO collector_local_pages(job_id,run_id,page_no,selected_count,evidence_json,collected_at) VALUES (?,?,?,?,?,?)")
      .run(jobId, runId, Number(item.page), Number(item.selectedCount), JSON.stringify(item), nowIso());
  }

  reportLocalPages(jobId: string, agentId: string, leaseToken: string, input: Record<string, unknown>): CollectionJob {
    this.verifyLease(jobId, agentId, leaseToken);
    this.db.exec("BEGIN IMMEDIATE");
    try { this.saveLocalPages(jobId, String(input.runId || ""), input.pages); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getJob(jobId)!;
  }

  finishCollection(jobId: string, agentId: string, leaseToken: string, input: Record<string, unknown>): CollectionJob {
    const runId = String(input.runId || "");
    this.authorizeUpload(jobId, agentId, runId, String(input.uploadToken || ""));
    if (!Array.isArray(input.pages) || !input.pages.length)
      throw new CollectorControlError("任务没有完整页检查点", "JOB_HAS_NO_COMPLETE_PAGE", 409);
    const cooldownUntil = input.cooldownUntil ? String(input.cooldownUntil) : null;
    if (cooldownUntil && !Number.isFinite(Date.parse(cooldownUntil)))
      throw new CollectorControlError("下次采集时间无效", "INVALID_COOLDOWN", 409);
    const receipt = JSON.stringify({ pages: input.pages.map(item => pageEvidence(item)), cooldownUntil });
    const prior = this.db.prepare("SELECT finished_json FROM collector_job_runs WHERE run_id = ?").get(runId) as { finished_json: string | null };
    if (prior.finished_json) {
      if (prior.finished_json !== receipt) throw new CollectorControlError("完成回执内容不一致", "FINISH_RECEIPT_CONFLICT", 409);
      return this.getJob(jobId)!;
    }
    this.verifyLease(jobId, agentId, leaseToken);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.saveLocalPages(jobId, runId, input.pages);
      this.db.prepare("UPDATE collector_job_runs SET finished_json = ? WHERE run_id = ?").run(receipt, runId);
      this.db.prepare(`UPDATE collector_jobs SET status = 'completed', pause_requested = 0,
        lease_token_hash = NULL, lease_expires_at = NULL, completed_at = ?, collection_finished_at = ?,
        collection_phase = 'finished', next_action_at = NULL, error_code = NULL, error_message = NULL WHERE id = ?`)
        .run(nowIso(), nowIso(), jobId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getJob(jobId)!;
  }

  reportDeliveryError(jobId: string, agentId: string, input: Record<string, unknown>): void {
    this.authorizeUpload(jobId, agentId, String(input.runId || ""), String(input.uploadToken || ""));
    this.db.prepare("UPDATE collector_jobs SET delivery_error = ? WHERE id = ?")
      .run(optionalText(input.code, 100) || "UPLOAD_RETRY_PENDING", jobId);
  }

  private storeUploadedPage(job: CollectionJob, input: Record<string, unknown>): CollectionJob {
    const jobId = job.id;
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
    if (job.searchSpec.schemaVersion === 2) {
      const match = remoteBatch.match(/\/(local-ego-[A-Za-z0-9_-]{1,70})\/batch-(\d{4})$/);
      if (!match || Number(match[2]) !== page || this.jobForRun(match[1]) !== jobId)
        throw new CollectorControlError("页级批次不属于该任务", "RUN_JOB_LINK_INVALID", 409);
    }
    const existing = this.db.prepare("SELECT * FROM collector_job_pages WHERE job_id = ? AND page_no = ?").get(jobId, page) as Record<string, unknown> | undefined;
    const local = this.db.prepare("SELECT evidence_json FROM collector_local_pages WHERE job_id = ? AND page_no = ?").get(jobId, page) as { evidence_json: string } | undefined;
    if (job.collectionFinishedAt && !local)
      throw new CollectorControlError("完成的任务不能增加新页", "FINISHED_RUN_PAGE_INVALID", 409);
    if (local && local.evidence_json !== JSON.stringify(pageEvidence(input)))
      throw new CollectorControlError("上传文件与本机完整页检查点冲突", "PAGE_CHECKPOINT_CONFLICT", 409);
    if (existing) {
      const previous = pageFromRow(existing);
      if (JSON.stringify(pageEvidence(previous as unknown as Record<string, unknown>)) !== JSON.stringify(pageEvidence(input)) || previous.remoteBatch !== remoteBatch) {
        throw new CollectorControlError("同一页的文件或CV_ID集合发生变化", "PAGE_CHECKPOINT_CONFLICT", 409);
      }
      return job;
    }
    if (!local && !job.limits.durationHours && this.dailyExportedCount() + selectedCount > 500) {
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
        xls_count = ?, pdf_count = ?, uploaded_count = ?, delivery_error = NULL WHERE id = ?`)
        .run(page, totals.pages, totals.exported, totals.pages, totals.pages, totals.pages, jobId);
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
      // Only proven task-local failures can release the queue without a shared pause.
      // Verification has its own durable agent gate and does not erase an existing global pause.
      const taskLocal = ["SEARCH_FORM_UNVERIFIED", "CHECKPOINT_RESUME_BLOCKED", "TRANSIENT_RETRY_EXHAUSTED", "LOCAL_STOP_REQUESTED", "JOB_HAS_NO_COMPLETE_PAGE"].includes(code);
      if (!taskLocal && code !== "BAYT_VERIFICATION_REQUIRED") this.db.prepare("UPDATE collector_control_state SET globally_paused = 1, pause_code = ?, pause_message = ?, paused_at = ?, updated_at = ? WHERE singleton = 1")
        .run(code, message, timestamp, timestamp);
      if (code === "BAYT_VERIFICATION_REQUIRED") this.db.prepare("UPDATE collector_agents SET login_state = 'verification_required' WHERE id = ?").run(agentId);
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
