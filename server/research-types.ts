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
