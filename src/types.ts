export interface SkillItem {
  name: string;
  level?: string;
  source: "EXCEL" | "BAYT_PROFILE" | "PDF" | "MANUAL";
}

export interface ExperienceItem {
  organization: string;
  position?: string;
  years?: string;
  source: "EXCEL" | "BAYT_PROFILE" | "PDF" | "MANUAL";
}

export interface AttachmentView {
  id: string;
  kind: "bayt_pdf" | "original" | "original_pdf";
  label: string;
  mimeType: string | null;
  sizeBytes: number | null;
  status: string;
  previewable: boolean;
  originalName: string | null;
}

export interface PersonView {
  id: string;
  cvId: string;
  displayName: string;
  headline: string | null;
  nationality: string | null;
  residence: string | null;
  lastCvUpdate: string | null;
  topSkills: SkillItem[];
  skills: SkillItem[];
  experiences: ExperienceItem[];
  educations: Array<{ description: string; source: string }>;
  languages: Array<{ name: string; level?: string; source: string }>;
  summary: string | null;
  avatarStatus: "photo" | "placeholder" | "missing";
  hasAvatar: boolean;
  attachments: AttachmentView[];
  professionalScore: number | null;
  researchPriorityScore: number | null;
  enrichmentStatus:
    | "NOT_CONFIGURED"
    | "NOT_ELIGIBLE"
    | "SCORED_ONLY"
    | "WAITING_PROVIDER"
    | "DEFERRED_BUDGET"
    | "QUEUED"
    | "SEARCHING"
    | "VERIFIED"
    | "NO_RELIABLE_RESULT"
    | "WRONG_PERSON"
    | "REVIEW_REQUIRED"
    | "CONFLICT"
    | "FAILED";
  sourceTags: string[];
  importedAt: string | null;
  collectionTasks?: Array<{ id: string; name: string; page: number; importedAt: string }>;
}

export interface CollectorJobPeopleResponse {
  items: Array<{ cvId: string; runId: string; page: number; importBatchId: string; importedAt: string; person: PersonView }>;
  page: number;
  pageSize: number;
  total: number;
  exportedCount: number;
  pendingImportCount: number;
  pendingPages: number;
  blockedPages: number;
}

export interface PeopleResponse {
  items: PersonView[];
  page: number;
  pageSize: number;
  total: number;
  facets: { nationalities: string[] };
}

export interface ImportMatch {
  cvId: string;
  displayName: string | null;
  pdfFile: string | null;
  method: "CV_ID_EXACT" | "MISSING";
  status: "SUCCESS" | "MISSING";
}

export interface ImportBatch {
  id: string;
  name: string;
  status: "READY" | "COMPLETED" | "FAILED";
  excelPersonCount: number;
  excelUniqueCvIdCount: number;
  attachmentCount: number;
  attachmentUniqueCvIdCount: number;
  matchedCount: number;
  missingAttachmentCount: number;
  extraAttachmentCount: number;
  duplicatedCvIdCount: number;
  invalidPdfCount: number;
  createdAt: string;
  completedAt?: string;
  source: "BUILT_IN_SAMPLE" | "USER_UPLOAD" | "LOCAL_COLLECTOR";
  matches: ImportMatch[];
  issues: Array<{ level: "BLOCKING" | "WARNING"; code: string; message: string }>;
}

export interface IncomingBatchStatus {
  runId: string;
  page: number;
  status: "pending" | "processing" | "displayed" | "blocked";
  count: number;
  importBatchId: string | null;
  reason: string | null;
  updatedAt: string;
}

export interface DashboardData {
  peopleTotal: number;
  baytPdfAvailable: number;
  originalAvailable: number;
  avatarsAvailable: number;
  scored: number;
  researchQueued: number;
  reviewPending: number;
  scoringConfigured: boolean;
  researchConfigured: boolean;
  latestImport: ImportBatch | null;
}

export interface AnalyticsOption {
  value: string;
  label: string;
}

export interface AnalyticsDistributionItem {
  key: string;
  label: string;
  count: number;
  percentage: number;
}

export interface DashboardAnalyticsData {
  filterOptions: {
    batches: AnalyticsOption[];
    sources: AnalyticsOption[];
    countries: AnalyticsOption[];
    updatedRanges: AnalyticsOption[];
  };
  scope: {
    peopleTotal: number;
    appliedFilters: {
      batch: string;
      source: string;
      country: string;
      updatedRange: string;
    };
  };
  kpis: {
    peopleTotal: number;
    coreComplete: number;
    coreCompletenessPercentage: number;
    baytPdfAvailable: number;
    originalAvailable: number;
    originalCoveragePercentage: number;
    avatarsAvailable: number;
    updatedWithin90Days: number;
    updatedWithin90DaysPercentage: number;
    researchConfigured: boolean;
    researchCandidates: number | null;
    reviewPending: number;
    reviewPendingPercentage: number;
  };
  distributions: {
    countries: AnalyticsDistributionItem[];
    seniority: AnalyticsDistributionItem[];
    functions: AnalyticsDistributionItem[];
    experience: AnalyticsDistributionItem[];
    skills: AnalyticsDistributionItem[];
    education: AnalyticsDistributionItem[];
    languages: AnalyticsDistributionItem[];
    updated: AnalyticsDistributionItem[];
  };
  recentBatches: Array<{
    id: string;
    label: string;
    query: string;
    source: "BAYT";
    completedAt: string;
    addedCount: number;
    deduplicatedTotal: number;
    completenessPercentage: number;
    status: "completed";
  }>;
  processingStages: Array<{
    id: string;
    label: string;
    status: "healthy" | "attention" | "not_configured";
    summary: string;
    lastRunAt: string | null;
  }>;
  generatedAt: string;
}

export interface CollectorTask {
  id: string;
  name: string;
  query: string;
  filters: Record<string, unknown>;
  scheduleHour: number;
  timezone: "Asia/Shanghai";
  maxPerRun: number;
  enabled: boolean;
  status: "idle" | "queued" | "running" | "paused" | "login_required" | "rate_limited" | "failed" | "disabled";
  cursorPage: number;
  preflightStatus: "required" | "passed" | "failed";
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollectorRun {
  id: string;
  taskId: string;
  collectionRunId: string;
  mode: "preflight" | "scheduled" | "manual" | "resume";
  status: "queued" | "running" | "verifying" | "publishing" | "completed" | "paused" | "login_required" | "rate_limited" | "failed";
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

export type CollectorFilterControlType = "single" | "multi" | "range" | "search" | "unsupported";

export interface CollectorFilterCatalog {
  version: string;
  status: "ready" | "stale";
  filters: Array<{
    key: string;
    label: string;
    controlType: CollectorFilterControlType;
    supported: boolean;
    options: Array<{ key: string; label: string }>;
    valueKind?: "text" | "number";
    reason?: string | null;
  }>;
  sorts: Array<{ key: string; label: string }>;
  synchronizedAt: string;
  agentId: string;
  advanced?: {
    keywordModes: Array<{ key: string; label: string }>;
    nameSupported: boolean;
    locations: Array<{ key: string; label: string; cities: Array<{ key: string; label: string }> }>;
    jobRoles: Array<{ key: string; label: string }>;
    industries: Array<{ key: string; label: string }>;
    exclusionSupported: boolean;
    reliable: boolean;
    reason?: string | null;
  } | null;
}

export interface CollectorFilterSelection {
  key: string;
  optionKeys?: string[];
  value?: string;
  min?: number;
  max?: number;
}

export interface CollectorSearchSpec {
  schemaVersion?: 2;
  keyword: string;
  filterSchemaVersion: string;
  filters: CollectorFilterSelection[];
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

export interface CollectorLimits {
  targetCount?: number;
  maxPages?: number;
  durationHours?: number;
}

export interface CollectorSearchTemplate {
  id: string;
  name: string;
  searchSpec: CollectorSearchSpec;
  createdAt: string;
  updatedAt: string;
}

export interface CollectorSchedule {
  id: string;
  name: string;
  templateId: string;
  kind: "once" | "daily" | "weekly";
  timezone: "Asia/Shanghai";
  localTime: string | null;
  weekday: number | null;
  runAt: string | null;
  limits: CollectorLimits;
  enabled: boolean;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollectorPageCheckpoint {
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

export interface CollectionQueueJob {
  recovery?: { id: string; kind: "rate_limit" | "verification"; stage: "waiting" | "probing" | "manual_required";
    startedAt: string; nextCheckAt: string; attempts: number; rateLimits: number } | null;
  collectedPages?: number;
  collectedCount?: number;
  displayedCount?: number;
  collectionFinishedAt?: string | null;
  phase?: string | null;
  nextActionAt?: string | null;
  deliveryError?: string | null;
  resumeMode?: "new_search" | "checkpoint" | "review";
  id: string;
  templateId: string | null;
  scheduleId: string | null;
  source: "manual" | "schedule" | "legacy";
  name: string;
  searchSpec: CollectorSearchSpec;
  limits: CollectorLimits;
  status: "queued" | "running" | "pause_requested" | "paused" | "completed" | "cancelled" | "safety_stopped" | "failed";
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
  pages: CollectorPageCheckpoint[];
}

export interface CollectorAgentState {
  waitReason?: string | null;
  nextActionAt?: string | null;
  verificationId?: string | null;
  id: string;
  name: string;
  version: string;
  status: "online" | "offline";
  lastHeartbeatAt: string;
  currentJobId: string | null;
  chromeReady: boolean;
  loginState: "unknown" | "logged_in" | "login_required" | "verification_required";
}

export interface CollectorControlState {
  browserNextActionAt?: string | null;
  globallyPaused: boolean;
  pauseCode: string | null;
  pauseMessage: string | null;
  pausedAt: string | null;
  runningJobId: string | null;
  queuedCount: number;
  dailyExportedCount: number;
  dailyLimit: number | null;
}

export type ResearchCaseStatus =
  | "NOT_ELIGIBLE"
  | "SCORED_ONLY"
  | "WAITING_PROVIDER"
  | "DEFERRED_BUDGET"
  | "QUEUED"
  | "SEARCHING"
  | "VERIFIED"
  | "NO_RELIABLE_RESULT"
  | "WRONG_PERSON"
  | "REVIEW_REQUIRED"
  | "CONFLICT"
  | "FAILED";

export type ResearchRunStatus =
  | "SCORING"
  | "SCORED"
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "INTERRUPTED";

export interface ScoreWeights {
  title: number;
  skills: number;
  experience: number;
  completeness: number;
  freshness: number;
}

export interface ResearchPolicy {
  id: string;
  name: string;
  targetRole: string;
  titleKeywords: string[];
  skillKeywords: string[];
  minimumExperienceYears: number;
  threshold: number;
  maxCandidatesPerRun: number;
  manualReviewMode: "exceptions_only";
  weights: ScoreWeights;
  updatedAt: string;
}

export interface ScoreBreakdown {
  title: number;
  skills: number;
  experience: number;
  completeness: number;
  freshness: number;
  matchedTitleKeywords: string[];
  matchedSkillKeywords: string[];
  experienceYears: number;
}

export interface PublicSourceEvidence {
  sourceId: string;
  title: string;
  domain: string;
  url: string;
  publishedAt: string | null;
  sourceLevel: "A" | "B" | "C";
  identityScore: number;
  snippet: string;
  accepted: boolean;
}

export interface ResearchSynthesisFinding {
  text: string;
  evidenceIds: string[];
  certainty: "confirmed" | "possible";
}

export interface ResearchSynthesis {
  conclusion: string;
  careerProfile: string;
  highlights: string[];
  publicFindings: ResearchSynthesisFinding[];
  gaps: string[];
  basis: "EVIDENCE_RULES";
  generatedAt: string;
}

export interface ResearchCaseView {
  cvId: string;
  displayName: string;
  headline: string | null;
  score: number;
  threshold: number;
  eligible: boolean;
  scoreBreakdown: ScoreBreakdown;
  status: ResearchCaseStatus;
  identityConfidence: number | null;
  evidenceCount: number;
  acceptedEvidenceCount: number;
  conflicts: string[];
  modelUsed: string | null;
  searchedAt: string | null;
  updatedAt: string;
}

export interface ResearchCaseDetail extends ResearchCaseView {
  synthesis: ResearchSynthesis;
  evidence: PublicSourceEvidence[];
}

export interface ResearchRunView {
  id: string;
  status: ResearchRunStatus;
  executeResearch: boolean;
  peopleTotal: number;
  scoredTotal: number;
  eligibleTotal: number;
  scheduledTotal: number;
  completedTotal: number;
  verifiedTotal: number;
  reviewRequiredTotal: number;
  failedTotal: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ResearchSummary {
  peopleTotal: number;
  scored: number;
  eligible: number;
  searched: number;
  verified: number;
  noReliableResult: number;
  reviewRequired: number;
  waitingProvider: number;
  failed: number;
}

export interface ResearchProviderStatus {
  tavilyConfigured: boolean;
  deepseekConfigured: boolean;
  deepseekModel: string | null;
  autoRunEnabled: boolean;
}

export interface ResearchDashboardView {
  configured: boolean;
  providers: ResearchProviderStatus;
  policy: ResearchPolicy;
  summary: ResearchSummary;
  items: ResearchCaseView[];
  runs: ResearchRunView[];
  message: string;
}
