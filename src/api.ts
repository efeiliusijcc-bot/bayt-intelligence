import type {
  CollectorRun,
  CollectionQueueJob,
  CollectorJobPeopleResponse,
  CollectorAgentState,
  CollectorControlState,
  CollectorFilterCatalog,
  CollectorLimits,
  CollectorSchedule,
  CollectorSearchSpec,
  CollectorSearchTemplate,
  CollectorTask,
  DashboardAnalyticsData,
  DashboardData,
  ImportBatch,
  IncomingBatchStatus,
  PeopleResponse,
  PersonView,
  ResearchCaseDetail,
  ResearchDashboardView,
  ResearchPolicy,
  ResearchRunView,
} from "./types";

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code = "REQUEST_FAILED",
    public readonly status = 0,
  ) {
    super(message);
  }
}

export interface AuthSession { user: string; csrfToken: string; expiresAt: string }

let csrfToken: string | null = null;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const method = (init?.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !url.endsWith("/auth/login") && csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(url, { ...init, headers, credentials: "same-origin" });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? ((await response.json()) as ApiErrorBody & T) : null;
  if (!response.ok) {
    if (response.status === 401 && !url.endsWith("/auth/login")) {
      csrfToken = null;
      window.dispatchEvent(new Event("bayt-auth-expired"));
    }
    throw new ApiError(body?.error?.message || "系统暂时无法完成该请求", body?.error?.code, response.status);
  }
  return body as T;
}

function collectorMutationInit(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { "Content-Type": "application/json", "X-Requested-With": "Bayt-Intelligence", ...(init.headers || {}) },
  };
}

export const apiClient = {
  authMe: async () => { const session = await api<AuthSession>("/api/v1/auth/me"); csrfToken = session.csrfToken; return session; },
  authLogin: async (user: string, password: string) => {
    const session = await api<AuthSession>("/api/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": "login-init" }, body: JSON.stringify({ user, password }),
    });
    csrfToken = session.csrfToken;
    return session;
  },
  authLogout: async () => { await api<void>("/api/v1/auth/logout", { method: "POST" }); csrfToken = null; },
  dashboard: () => api<DashboardData>("/api/v1/dashboard"),
  dashboardAnalytics: (search: URLSearchParams) => api<DashboardAnalyticsData>(`/api/v1/dashboard/analytics?${search.toString()}`),
  people: (search: URLSearchParams) => api<PeopleResponse>(`/api/v1/people?${search.toString()}`),
  person: (cvId: string) => api<PersonView>(`/api/v1/people/${encodeURIComponent(cvId)}`),
  audit: (cvId: string) => api<{ items: Array<Record<string, unknown>> }>(`/api/v1/people/${encodeURIComponent(cvId)}/audit`),
  imports: () => api<{ items: ImportBatch[] }>("/api/v1/import-batches"),
  incomingBatches: () => api<{ items: IncomingBatchStatus[] }>("/api/v1/incoming-batches"),
  importBatch: (id: string) => api<ImportBatch>(`/api/v1/import-batches/${encodeURIComponent(id)}`),
  preflight: (formData: FormData) => api<ImportBatch>("/api/v1/import-batches/preflight", { method: "POST", body: formData }),
  commitImport: (id: string) => api<ImportBatch>(`/api/v1/import-batches/${encodeURIComponent(id)}/commit`, { method: "POST" }),
  previewUrl: (id: string) => api<{ url: string; expiresAt: string }>(`/api/v1/attachments/${encodeURIComponent(id)}/preview-url`),
  downloadUrl: (id: string) => api<{ url: string; expiresAt: string }>(`/api/v1/attachments/${encodeURIComponent(id)}/download-url`),
  research: () => api<ResearchDashboardView>("/api/v1/research-jobs"),
  researchCase: (cvId: string) => api<ResearchCaseDetail>(`/api/v1/research-jobs/${encodeURIComponent(cvId)}`),
  startResearchRun: (executeResearch: boolean) => api<ResearchRunView>("/api/v1/research-runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executeResearch }) }),
  researchRun: (runId: string) => api<ResearchRunView>(`/api/v1/research-runs/${encodeURIComponent(runId)}`),
  updateResearchPolicy: (policy: ResearchPolicy) => api<ResearchPolicy>("/api/v1/research-policy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(policy) }),
  collectorTasks: () => api<{ items: CollectorTask[] }>("/api/v1/collector/tasks"),
  collectorRuns: () => api<{ items: CollectorRun[] }>("/api/v1/collector/runs"),
  createCollectorTask: (input: { name: string; query: string; maxPerRun: number }) => api<CollectorTask>("/api/v1/collector/tasks", collectorMutationInit({ method: "POST", body: JSON.stringify(input) })),
  updateCollectorTask: (id: string, input: Partial<Pick<CollectorTask, "name" | "query" | "maxPerRun" | "enabled">>) => api<CollectorTask>(`/api/v1/collector/tasks/${encodeURIComponent(id)}`, collectorMutationInit({ method: "PATCH", body: JSON.stringify(input) })),
  runCollectorTask: (id: string, mode: "preflight" | "manual") => api<CollectorRun>(`/api/v1/collector/tasks/${encodeURIComponent(id)}/run`, collectorMutationInit({ method: "POST", body: JSON.stringify({ mode }) })),
  pauseCollectorRun: (id: string) => api<CollectorRun>(`/api/v1/collector/runs/${encodeURIComponent(id)}/pause`, collectorMutationInit({ method: "POST", body: "{}" })),
  resumeCollectorRun: (id: string) => api<CollectorRun>(`/api/v1/collector/runs/${encodeURIComponent(id)}/resume`, collectorMutationInit({ method: "POST", body: "{}" })),
  collectorLoginSession: () => api<{ url: string; expiresAt: string }>("/api/v1/collector/login-sessions", collectorMutationInit({ method: "POST", body: "{}" })),
  collectorFilterCatalog: () => api<{ catalog: CollectorFilterCatalog | null; syncRequest: { id: string; status: string; requestedAt: string; completedAt: string | null; error: string | null } | null }>("/api/v1/collector/filter-catalog"),
  syncCollectorFilterCatalog: () => api<{ id: string; status: string; requestedAt: string }>("/api/v1/collector/filter-catalog/sync", collectorMutationInit({ method: "POST", body: "{}" })),
  collectorSearchTemplates: () => api<{ items: CollectorSearchTemplate[] }>("/api/v1/collector/search-templates"),
  createCollectorSearchTemplate: (input: { name: string; searchSpec: CollectorSearchSpec }) => api<CollectorSearchTemplate>("/api/v1/collector/search-templates", collectorMutationInit({ method: "POST", body: JSON.stringify(input) })),
  updateCollectorSearchTemplate: (id: string, input: { name?: string; searchSpec?: CollectorSearchSpec }) => api<CollectorSearchTemplate>(`/api/v1/collector/search-templates/${encodeURIComponent(id)}`, collectorMutationInit({ method: "PATCH", body: JSON.stringify(input) })),
  copyCollectorSearchTemplate: (id: string) => api<CollectorSearchTemplate>(`/api/v1/collector/search-templates/${encodeURIComponent(id)}/copy`, collectorMutationInit({ method: "POST", body: "{}" })),
  deleteCollectorSearchTemplate: (id: string) => api<void>(`/api/v1/collector/search-templates/${encodeURIComponent(id)}`, collectorMutationInit({ method: "DELETE" })),
  collectorQueue: () => api<{ items: CollectionQueueJob[]; control: CollectorControlState; agents: CollectorAgentState[] }>("/api/v1/collector/jobs"),
  collectorJob: (id: string) => api<CollectionQueueJob>(`/api/v1/collector/jobs/${encodeURIComponent(id)}`),
  collectorJobPeople: (id: string, page: number) => api<CollectorJobPeopleResponse>(`/api/v1/collector/jobs/${encodeURIComponent(id)}/people?page=${page}&pageSize=12`),
  createCollectionJob: (input: { templateId?: string; name?: string; searchSpec?: CollectorSearchSpec; limits: CollectorLimits; clientRequestId?: string }) => api<CollectionQueueJob>("/api/v1/collector/jobs", collectorMutationInit({ method: "POST", body: JSON.stringify(input) })),
  acknowledgeCollectorSafety: (reason: string) => api<CollectorControlState>("/api/v1/collector/control/acknowledge-safety", collectorMutationInit({ method: "POST", body: JSON.stringify({ reason }) })),
  updateCollectionJobLimits: (id: string, limits: CollectorLimits) => api<CollectionQueueJob>(`/api/v1/collector/jobs/${encodeURIComponent(id)}/limits`, collectorMutationInit({ method: "PATCH", body: JSON.stringify(limits) })),
  collectorJobAction: (id: string, action: "pause" | "resume" | "cancel" | "move-up" | "move-down") => api<CollectionQueueJob>(`/api/v1/collector/jobs/${encodeURIComponent(id)}/${action}`, collectorMutationInit({ method: "POST", body: "{}" })),
  collectorSchedules: () => api<{ items: CollectorSchedule[] }>("/api/v1/collector/schedules"),
  createCollectorSchedule: (input: { name: string; templateId: string; kind: CollectorSchedule["kind"]; localTime?: string; weekday?: number; runAt?: string; limits: CollectorLimits }) => api<CollectorSchedule>("/api/v1/collector/schedules", collectorMutationInit({ method: "POST", body: JSON.stringify(input) })),
  updateCollectorSchedule: (id: string, input: Partial<CollectorSchedule>) => api<CollectorSchedule>(`/api/v1/collector/schedules/${encodeURIComponent(id)}`, collectorMutationInit({ method: "PATCH", body: JSON.stringify(input) })),
  deleteCollectorSchedule: (id: string) => api<void>(`/api/v1/collector/schedules/${encodeURIComponent(id)}`, collectorMutationInit({ method: "DELETE" })),
};

export function formatBytes(value: number | null): string {
  if (!value && value !== 0) return "大小未知";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

export function displayText(value: string | null | undefined, fallback = "未提供"): string {
  return value?.replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim() || fallback;
}
