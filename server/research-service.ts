import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import type { PeopleRepository } from "./people-repository.ts";
import type {
  PublicSourceEvidence,
  ResearchCaseDetail,
  ResearchCaseStatus,
  ResearchCaseView,
  ResearchDashboardView,
  ResearchPolicy,
  ResearchProviderStatus,
  ResearchRunStatus,
  ResearchRunView,
  ResearchSummary,
  ScoreBreakdown,
} from "./research-types.ts";
import type { PersonView } from "./types.ts";

type FetchLike = typeof fetch;
type PeopleSource = Pick<PeopleRepository, "list">;

interface ResearchServiceOptions {
  databasePath?: string;
  fetchImpl?: FetchLike;
  tavilyApiKey?: string;
  tavilyEndpoint?: string;
  deepseekApiKey?: string;
  deepseekBaseUrl?: string;
  deepseekModel?: string;
  autoRunEnabled?: boolean;
  now?: () => Date;
}

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
  published_date?: unknown;
}

interface StoredCaseRow {
  cv_id: string;
  run_id: string;
  display_name: string;
  headline: string | null;
  professional_score: number;
  threshold: number;
  eligible: number;
  breakdown_json: string;
  status: ResearchCaseStatus;
  identity_confidence: number | null;
  evidence_count: number;
  accepted_evidence_count: number;
  conflicts_json: string;
  model_used: string | null;
  searched_at: string | null;
  updated_at: string;
}

interface StoredRunRow {
  id: string;
  status: ResearchRunStatus;
  execute_research: number;
  people_total: number;
  scored_total: number;
  eligible_total: number;
  scheduled_total: number;
  completed_total: number;
  verified_total: number;
  review_required_total: number;
  failed_total: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface IdentityDecision {
  status: ResearchCaseStatus;
  identityConfidence: number | null;
  conflicts: string[];
  modelUsed: string | null;
}

class ProviderPauseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderPauseError";
  }
}

const skillPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "research", "person-public-research.skill.md");

export const DEFAULT_RESEARCH_POLICY: ResearchPolicy = {
  id: "software-engineer-v1",
  name: "软件工程人才公开研究",
  targetRole: "Software Engineer",
  titleKeywords: [
    "software engineer",
    "software developer",
    "full stack",
    "backend",
    "frontend",
    "mobile developer",
    "devops",
    "data engineer",
    "solution architect",
  ],
  skillKeywords: [
    "software engineering",
    "javascript",
    "typescript",
    "java",
    "python",
    "c#",
    ".net",
    "react",
    "node",
    "sql",
    "cloud",
    "devops",
  ],
  minimumExperienceYears: 3,
  threshold: 70,
  maxCandidatesPerRun: 30,
  manualReviewMode: "exceptions_only",
  weights: { title: 25, skills: 30, experience: 20, completeness: 15, freshness: 10 },
  updatedAt: "2026-08-25T00:00:00.000Z",
};

function jsonParse<T>(value: string | null, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function normalized(value: string | null | undefined): string {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string | null | undefined): string[] {
  return [...new Set(normalized(value).split(" ").filter((item) => item.length > 1))];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function experienceYears(person: PersonView): number {
  return round(
    person.experiences.reduce((total, experience) => {
      const raw = String(experience.years || "").trim();
      if (!raw) return total;
      if (/^<\s*1/.test(raw)) return total + 0.5;
      const match = raw.match(/\d+(?:\.\d+)?/);
      return total + (match ? Number(match[0]) : 0);
    }, 0),
  );
}

function freshnessRatio(lastCvUpdate: string | null, now: Date): number {
  if (!lastCvUpdate) return 0;
  const parsed = new Date(`${lastCvUpdate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return 0;
  const days = Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 86_400_000));
  if (days <= 30) return 1;
  if (days <= 90) return 0.8;
  if (days <= 180) return 0.5;
  if (days <= 365) return 0.2;
  return 0;
}

function policyTerms(values: string[]): string[] {
  return [...new Set(values.map(normalized).filter(Boolean))].slice(0, 30);
}

export function validateResearchPolicy(input: ResearchPolicy): ResearchPolicy {
  const weights = input.weights;
  const weightValues = [weights.title, weights.skills, weights.experience, weights.completeness, weights.freshness];
  if (weightValues.some((value) => !Number.isFinite(value) || value < 0) || round(weightValues.reduce((sum, value) => sum + value, 0), 3) !== 100) {
    throw new Error("评分权重合计必须等于100");
  }
  if (!input.id.trim() || !input.name.trim() || !input.targetRole.trim()) throw new Error("评分策略ID、名称和目标职位不能为空");
  if (!Number.isFinite(input.threshold) || input.threshold < 0 || input.threshold > 100) throw new Error("研究门槛必须在0到100之间");
  if (!Number.isFinite(input.minimumExperienceYears) || input.minimumExperienceYears < 0 || input.minimumExperienceYears > 60) throw new Error("最低经验年限必须在0到60之间");
  if (!Number.isInteger(input.maxCandidatesPerRun) || input.maxCandidatesPerRun < 1 || input.maxCandidatesPerRun > 100) throw new Error("单次研究人数必须在1到100之间");
  const titleKeywords = policyTerms(input.titleKeywords);
  const skillKeywords = policyTerms(input.skillKeywords);
  if (!titleKeywords.length || !skillKeywords.length) throw new Error("职位关键词和技能关键词均不能为空");
  return {
    ...input,
    id: input.id.trim().slice(0, 80),
    name: input.name.trim().slice(0, 80),
    targetRole: input.targetRole.trim().slice(0, 120),
    titleKeywords,
    skillKeywords,
    manualReviewMode: "exceptions_only",
  };
}

export function scorePerson(person: PersonView, policy: ResearchPolicy, now = new Date()): { score: number; breakdown: ScoreBreakdown } {
  const headline = normalized(person.headline);
  const titleMatches = policyTerms(policy.titleKeywords).filter((keyword) => headline.includes(keyword));
  const titleRatio = titleMatches.length ? Math.min(1, 0.65 + titleMatches.length * 0.15) : 0;

  const skillText = normalized(person.skills.map((skill) => skill.name).join(" "));
  const skillMatches = policyTerms(policy.skillKeywords).filter((keyword) => skillText.includes(keyword));
  const skillRatio = Math.min(1, skillMatches.length / Math.min(4, Math.max(1, policy.skillKeywords.length)));

  const years = experienceYears(person);
  const experienceRatio = policy.minimumExperienceYears === 0 ? 1 : Math.min(1, years / policy.minimumExperienceYears);
  const completenessSignals = [
    Boolean(person.headline),
    person.experiences.length > 0,
    person.skills.length > 0,
    person.educations.length > 0,
    person.languages.length > 0,
    Boolean(person.lastCvUpdate),
    person.attachments.some((attachment) => attachment.kind === "bayt_pdf" && attachment.status === "downloaded"),
  ];
  const completenessRatio = completenessSignals.filter(Boolean).length / completenessSignals.length;
  const freshness = freshnessRatio(person.lastCvUpdate, now);

  const breakdown: ScoreBreakdown = {
    title: round(titleRatio * policy.weights.title),
    skills: round(skillRatio * policy.weights.skills),
    experience: round(experienceRatio * policy.weights.experience),
    completeness: round(completenessRatio * policy.weights.completeness),
    freshness: round(freshness * policy.weights.freshness),
    matchedTitleKeywords: titleMatches,
    matchedSkillKeywords: skillMatches,
    experienceYears: years,
  };
  const score = round(breakdown.title + breakdown.skills + breakdown.experience + breakdown.completeness + breakdown.freshness);
  return { score: clamp(score, 0, 100), breakdown };
}

function sourceLevel(domain: string): "A" | "B" | "C" {
  const name = domain.toLocaleLowerCase();
  if (/(^|\.)(gov|edu|ac|int)(\.|$)/.test(name)) return "A";
  if (/(facebook|instagram|x\.com|twitter|tiktok|pinterest|reddit|medium)\./.test(name)) return "C";
  return "B";
}

function independentSourceKey(domain: string): string {
  const labels = domain.toLocaleLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const suffix = labels.slice(-2).join(".");
  const commonSecondLevelSuffixes = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.in", "co.jp", "com.br"]);
  return commonSecondLevelSuffixes.has(suffix) ? labels.slice(-3).join(".") : suffix;
}

function cleanSnippet(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function cleanUrl(value: unknown): { url: string; domain: string } | null {
  try {
    const parsed = new URL(String(value || ""));
    if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) return null;
    parsed.search = "";
    parsed.hash = "";
    return { url: parsed.toString(), domain: parsed.hostname.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

function tokenCoverage(needles: string[], haystack: string): number {
  if (!needles.length) return 0;
  const matched = needles.filter((needle) => haystack.includes(needle)).length;
  return matched / needles.length;
}

function identityScore(person: PersonView, title: string, snippet: string): number {
  const text = normalized(`${title} ${snippet}`);
  const nameScore = tokenCoverage(tokens(person.displayName), text);
  const organizations = person.experiences.slice(0, 3).flatMap((experience) => tokens(experience.organization));
  const organizationScore = tokenCoverage(organizations, text);
  const roleScore = tokenCoverage(tokens(person.headline).slice(0, 8), text);
  const locationScore = tokenCoverage(tokens(person.residence).slice(0, 4), text);
  return round(nameScore * 0.55 + organizationScore * 0.2 + roleScore * 0.15 + locationScore * 0.1, 3);
}

function publicIdentityQuery(person: PersonView): string {
  const organization = person.experiences.find((experience) => experience.organization)?.organization || "";
  const role = String(person.headline || "").split(/[,/|]/)[0].trim();
  const location = String(person.residence || "").split(/[-,]/)[0].trim();
  return [`"${person.displayName.replace(/["\r\n]/g, " ").trim()}"`, organization && `"${organization}"`, role && `"${role}"`, location]
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);
}

function caseFromRow(row: StoredCaseRow): ResearchCaseView {
  return {
    cvId: row.cv_id,
    displayName: row.display_name,
    headline: row.headline,
    score: row.professional_score,
    threshold: row.threshold,
    eligible: Boolean(row.eligible),
    scoreBreakdown: jsonParse<ScoreBreakdown>(row.breakdown_json, {
      title: 0,
      skills: 0,
      experience: 0,
      completeness: 0,
      freshness: 0,
      matchedTitleKeywords: [],
      matchedSkillKeywords: [],
      experienceYears: 0,
    }),
    status: row.status,
    identityConfidence: row.identity_confidence,
    evidenceCount: row.evidence_count,
    acceptedEvidenceCount: row.accepted_evidence_count,
    conflicts: jsonParse<string[]>(row.conflicts_json, []),
    modelUsed: row.model_used,
    searchedAt: row.searched_at,
    updatedAt: row.updated_at,
  };
}

const RESEARCH_CONCLUSIONS: Record<ResearchCaseStatus, string> = {
  NOT_ELIGIBLE: "该人物未达到公开研究门槛，当前总结仅基于简历资料。",
  SCORED_ONLY: "该人物已完成职业匹配评分，但尚未执行公开信息搜索。",
  WAITING_PROVIDER: "公开信息搜索因服务状态暂停，当前不能形成完整研究结论。",
  DEFERRED_BUDGET: "该人物已进入后续研究批次，公开信息结论尚未形成。",
  QUEUED: "该人物正在等待公开信息搜索，当前总结仅基于简历资料。",
  SEARCHING: "公开信息仍在搜索中，以下内容不是最终研究结论。",
  VERIFIED: "公开来源已达到自动核验门槛，现有证据支持相关页面与该候选人为同一人。",
  NO_RELIABLE_RESULT: "公开搜索已完成，但没有形成足够可靠的身份来源组合；当前仅能确认简历中的职业资料。",
  WRONG_PERSON: "公开搜索结果被判断为同名或其他人物，未纳入该候选人的公开画像。",
  REVIEW_REQUIRED: "发现可能相关的公开页面，但身份关联仍有冲突或证据不足，不能作为已确认事实。",
  CONFLICT: "公开来源之间存在冲突，当前不能形成确定的身份或职业事实。",
  FAILED: "研究处理未完成，当前没有可发布的公开信息结论。",
};

function researchCareerProfile(person: PersonView | null, researchCase: ResearchCaseView): string {
  const parts: string[] = [];
  const headline = person?.headline || researchCase.headline;
  if (headline) parts.push(`职位方向为 ${cleanSnippet(headline).slice(0, 100)}`);
  if (researchCase.scoreBreakdown.experienceYears > 0) {
    parts.push(`简历记录累计经验约 ${researchCase.scoreBreakdown.experienceYears} 年`);
  }
  const recentRoles = (person?.experiences || []).slice(0, 2).map((item) => {
    const position = cleanSnippet(item.position || "");
    const organization = cleanSnippet(item.organization || "");
    return [position, organization].filter(Boolean).join(" @ ");
  }).filter(Boolean);
  if (recentRoles.length) parts.push(`代表性经历包括 ${recentRoles.join("、")}`);
  const skills = (person?.skills || []).map((item) => cleanSnippet(item.name)).filter(Boolean).slice(0, 8);
  const fallbackSkills = researchCase.scoreBreakdown.matchedSkillKeywords.slice(0, 8);
  const selectedSkills = skills.length ? skills : fallbackSkills;
  if (selectedSkills.length) parts.push(`核心技能包括 ${selectedSkills.join("、")}`);
  return parts.length ? `简历资料显示：${parts.join("；")}。` : "现有简历字段不足，暂时无法形成稳定的职业画像。";
}

export function buildResearchSynthesis(
  person: PersonView | null,
  researchCase: ResearchCaseView,
  evidence: PublicSourceEvidence[],
): ResearchCaseDetail["synthesis"] {
  const verified = researchCase.status === "VERIFIED";
  const relevantEvidence = (verified
    ? evidence.filter((item) => item.accepted)
    : evidence.filter((item) => item.sourceLevel !== "C" && item.identityScore >= 0.45)
  ).slice(0, 3);
  const publicFindings = relevantEvidence.map((item) => {
    const confirmed = verified && item.accepted;
    const title = cleanSnippet(item.title).slice(0, 120) || item.domain;
    const excerpt = cleanSnippet(item.snippet).slice(0, 220);
    return {
      text: `${confirmed ? "已核验来源" : "候选来源"}“${title}”${excerpt ? `提到：${excerpt}` : "未返回可用内容摘要"}`,
      evidenceIds: [item.sourceId],
      certainty: confirmed ? "confirmed" as const : "possible" as const,
    };
  });
  const highlights: string[] = [];
  if (researchCase.scoreBreakdown.matchedTitleKeywords.length) {
    highlights.push(`职位方向命中：${researchCase.scoreBreakdown.matchedTitleKeywords.slice(0, 4).join("、")}`);
  }
  if (researchCase.scoreBreakdown.matchedSkillKeywords.length) {
    highlights.push(`技能命中：${researchCase.scoreBreakdown.matchedSkillKeywords.slice(0, 6).join("、")}`);
  }
  if (researchCase.scoreBreakdown.experienceYears > 0) {
    highlights.push(`简历记录累计经验：${researchCase.scoreBreakdown.experienceYears} 年`);
  }
  const gaps = [...researchCase.conflicts];
  if (researchCase.status === "NO_RELIABLE_RESULT") {
    gaps.push("尚未形成一个A级来源或两个相互独立B级来源的证据组合。");
  } else if (["REVIEW_REQUIRED", "CONFLICT"].includes(researchCase.status)) {
    gaps.push("候选来源只能作为线索，需进一步核对机构、职位、地点或时间是否一致。");
  } else if (!researchCase.searchedAt) {
    gaps.push("尚未执行公开搜索，不能对简历之外的信息作出判断。");
  }
  const omitted = evidence.length - relevantEvidence.length;
  if (omitted > 0) gaps.push(`${omitted} 条低相关或未被采纳的搜索结果未写入人物事实。`);
  return {
    conclusion: RESEARCH_CONCLUSIONS[researchCase.status],
    careerProfile: researchCareerProfile(person, researchCase),
    highlights: highlights.slice(0, 4),
    publicFindings,
    gaps: [...new Set(gaps)].slice(0, 6),
    basis: "EVIDENCE_RULES",
    generatedAt: researchCase.updatedAt,
  };
}

function runFromRow(row: StoredRunRow): ResearchRunView {
  return {
    id: row.id,
    status: row.status,
    executeResearch: Boolean(row.execute_research),
    peopleTotal: row.people_total,
    scoredTotal: row.scored_total,
    eligibleTotal: row.eligible_total,
    scheduledTotal: row.scheduled_total,
    completedTotal: row.completed_total,
    verifiedTotal: row.verified_total,
    reviewRequiredTotal: row.review_required_total,
    failedTotal: row.failed_total,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function caseNeedsResearch(row: StoredCaseRow | undefined, person: PersonView, now: Date): boolean {
  if (!row) return true;
  const searchedAt = row.searched_at ? new Date(row.searched_at) : null;
  const cvUpdatedAt = person.lastCvUpdate ? new Date(`${person.lastCvUpdate.slice(0, 10)}T00:00:00Z`) : null;
  if (searchedAt && cvUpdatedAt && !Number.isNaN(cvUpdatedAt.getTime()) && cvUpdatedAt.getTime() > searchedAt.getTime()) return true;
  if (["VERIFIED", "REVIEW_REQUIRED", "CONFLICT"].includes(row.status)) return false;
  if (["NO_RELIABLE_RESULT", "WRONG_PERSON"].includes(row.status)) {
    if (!searchedAt || Number.isNaN(searchedAt.getTime())) return true;
    return now.getTime() - searchedAt.getTime() >= 7 * 86_400_000;
  }
  return true;
}

export class ResearchService {
  private readonly db: DatabaseSync;
  private readonly peopleSource: PeopleSource;
  private readonly fetchImpl: FetchLike;
  private readonly tavilyApiKey: string;
  private readonly tavilyEndpoint: string;
  private readonly deepseekApiKey: string;
  private readonly deepseekBaseUrl: string;
  private readonly deepseekModel: string;
  private readonly autoRunEnabled: boolean;
  private readonly now: () => Date;
  private activeRun: Promise<void> | null = null;

  constructor(peopleSource: PeopleSource, options: ResearchServiceOptions = {}) {
    this.peopleSource = peopleSource;
    this.fetchImpl = options.fetchImpl || fetch;
    this.tavilyApiKey = options.tavilyApiKey ?? config.tavilyApiKey;
    this.tavilyEndpoint = options.tavilyEndpoint ?? config.tavilyEndpoint;
    this.deepseekApiKey = options.deepseekApiKey ?? config.deepseekApiKey;
    this.deepseekBaseUrl = (options.deepseekBaseUrl ?? config.deepseekBaseUrl).replace(/\/$/, "");
    this.deepseekModel = options.deepseekModel ?? config.deepseekModel;
    this.autoRunEnabled = options.autoRunEnabled ?? config.researchAutoRun;
    this.now = options.now || (() => new Date());
    const databasePath = options.databasePath || path.join(config.runtimeDirectory, "research", "research.db");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.migrate();
    this.recoverInterruptedRuns();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_policy (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        policy_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        execute_research INTEGER NOT NULL,
        policy_json TEXT NOT NULL,
        people_total INTEGER NOT NULL,
        scored_total INTEGER NOT NULL,
        eligible_total INTEGER NOT NULL,
        scheduled_total INTEGER NOT NULL,
        completed_total INTEGER NOT NULL DEFAULT 0,
        verified_total INTEGER NOT NULL DEFAULT 0,
        review_required_total INTEGER NOT NULL DEFAULT 0,
        failed_total INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS research_cases (
        cv_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        headline TEXT,
        professional_score REAL NOT NULL,
        threshold REAL NOT NULL,
        eligible INTEGER NOT NULL,
        breakdown_json TEXT NOT NULL,
        status TEXT NOT NULL,
        identity_confidence REAL,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        accepted_evidence_count INTEGER NOT NULL DEFAULT 0,
        conflicts_json TEXT NOT NULL DEFAULT '[]',
        model_used TEXT,
        searched_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_research_cases_status ON research_cases(status, professional_score DESC);
      CREATE TABLE IF NOT EXISTS research_evidence (
        source_id TEXT PRIMARY KEY,
        cv_id TEXT NOT NULL,
        title TEXT NOT NULL,
        domain TEXT NOT NULL,
        url TEXT NOT NULL,
        published_at TEXT,
        source_level TEXT NOT NULL,
        identity_score REAL NOT NULL,
        snippet TEXT NOT NULL,
        accepted INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_research_evidence_cv ON research_evidence(cv_id, accepted DESC, identity_score DESC);
      CREATE TABLE IF NOT EXISTS research_query_cache (
        query_hash TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const caseColumns = this.db.prepare("PRAGMA table_info(research_cases)").all() as Array<{ name: string }>;
    if (!caseColumns.some((column) => column.name === "searched_at")) {
      this.db.exec("ALTER TABLE research_cases ADD COLUMN searched_at TEXT");
    }
    const existing = this.db.prepare("SELECT singleton FROM research_policy WHERE singleton = 1").get();
    if (!existing) {
      const policy = { ...DEFAULT_RESEARCH_POLICY, updatedAt: this.now().toISOString() };
      this.db.prepare("INSERT INTO research_policy(singleton, policy_json, updated_at) VALUES(1, ?, ?)").run(JSON.stringify(policy), policy.updatedAt);
    }
  }

  private recoverInterruptedRuns(): void {
    const now = this.now().toISOString();
    this.db.prepare("UPDATE research_runs SET status = 'INTERRUPTED', error = '服务重启导致任务中断，可重新运行且缓存仍然有效', completed_at = ? WHERE status IN ('SCORING','QUEUED','RUNNING')").run(now);
    this.db.prepare("UPDATE research_cases SET status = 'QUEUED', updated_at = ? WHERE status = 'SEARCHING'").run(now);
  }

  providers(): ResearchProviderStatus {
    return {
      tavilyConfigured: Boolean(this.tavilyApiKey),
      deepseekConfigured: Boolean(this.deepseekApiKey && this.deepseekModel),
      deepseekModel: this.deepseekApiKey && this.deepseekModel ? this.deepseekModel : null,
      autoRunEnabled: this.autoRunEnabled,
    };
  }

  getPolicy(): ResearchPolicy {
    const row = this.db.prepare("SELECT policy_json FROM research_policy WHERE singleton = 1").get() as { policy_json: string };
    return validateResearchPolicy(jsonParse<ResearchPolicy>(row.policy_json, DEFAULT_RESEARCH_POLICY));
  }

  updatePolicy(input: ResearchPolicy): ResearchPolicy {
    const policy = validateResearchPolicy({ ...input, updatedAt: this.now().toISOString() });
    this.db.prepare("UPDATE research_policy SET policy_json = ?, updated_at = ? WHERE singleton = 1").run(JSON.stringify(policy), policy.updatedAt);
    return policy;
  }

  summary(): ResearchSummary {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS scored,
        SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END) AS eligible,
        SUM(CASE WHEN searched_at IS NOT NULL THEN 1 ELSE 0 END) AS searched,
        SUM(CASE WHEN status = 'VERIFIED' THEN 1 ELSE 0 END) AS verified,
        SUM(CASE WHEN status IN ('NO_RELIABLE_RESULT','WRONG_PERSON') THEN 1 ELSE 0 END) AS no_reliable,
        SUM(CASE WHEN status IN ('REVIEW_REQUIRED','CONFLICT') THEN 1 ELSE 0 END) AS review_required,
        SUM(CASE WHEN status = 'WAITING_PROVIDER' THEN 1 ELSE 0 END) AS waiting_provider,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
      FROM research_cases
    `).get() as Record<string, number | null>;
    return {
      peopleTotal: this.peopleSource.list().length,
      scored: Number(row.scored || 0),
      eligible: Number(row.eligible || 0),
      searched: Number(row.searched || 0),
      verified: Number(row.verified || 0),
      noReliableResult: Number(row.no_reliable || 0),
      reviewRequired: Number(row.review_required || 0),
      waitingProvider: Number(row.waiting_provider || 0),
      failed: Number(row.failed || 0),
    };
  }

  listCases(limit = 500): ResearchCaseView[] {
    const rows = this.db.prepare("SELECT * FROM research_cases ORDER BY professional_score DESC, display_name COLLATE NOCASE LIMIT ?").all(clamp(Math.trunc(limit), 1, 500)) as unknown as StoredCaseRow[];
    return rows.map(caseFromRow);
  }

  getCase(cvId: string): ResearchCaseDetail | null {
    const row = this.db.prepare("SELECT * FROM research_cases WHERE cv_id = ?").get(cvId) as unknown as StoredCaseRow | undefined;
    if (!row) return null;
    const evidence = this.db.prepare("SELECT source_id, title, domain, url, published_at, source_level, identity_score, snippet, accepted FROM research_evidence WHERE cv_id = ? ORDER BY accepted DESC, identity_score DESC").all(cvId) as Array<Record<string, unknown>>;
    const researchCase = caseFromRow(row);
    const mappedEvidence = evidence.map((item) => ({
        sourceId: String(item.source_id),
        title: String(item.title),
        domain: String(item.domain),
        url: String(item.url),
        publishedAt: item.published_at ? String(item.published_at) : null,
        sourceLevel: String(item.source_level) as "A" | "B" | "C",
        identityScore: Number(item.identity_score),
        snippet: String(item.snippet),
        accepted: Boolean(item.accepted),
      }));
    const person = this.peopleSource.list().find((item) => item.cvId === cvId) || null;
    return {
      ...researchCase,
      synthesis: buildResearchSynthesis(person, researchCase, mappedEvidence),
      evidence: mappedEvidence,
    };
  }

  listRuns(limit = 20): ResearchRunView[] {
    const rows = this.db.prepare("SELECT * FROM research_runs ORDER BY created_at DESC LIMIT ?").all(clamp(Math.trunc(limit), 1, 100)) as unknown as StoredRunRow[];
    return rows.map(runFromRow);
  }

  dashboard(): ResearchDashboardView {
    const providers = this.providers();
    return {
      configured: providers.tavilyConfigured,
      providers,
      policy: this.getPolicy(),
      summary: this.summary(),
      items: this.listCases(),
      runs: this.listRuns(),
      message: providers.tavilyConfigured
        ? "确定性评分已启用；仅达到门槛的人物进入Tavily，复杂冲突才调用DeepSeek。"
        : "确定性评分可直接运行；配置TAVILY_API_KEY后，达标人物才会进入公开来源搜索。",
    };
  }

  decoratePerson(person: PersonView): PersonView {
    const row = this.db.prepare("SELECT professional_score, eligible, status FROM research_cases WHERE cv_id = ?").get(person.cvId) as { professional_score: number; eligible: number; status: ResearchCaseStatus } | undefined;
    if (!row) return person;
    return {
      ...person,
      professionalScore: row.professional_score,
      researchPriorityScore: row.eligible ? row.professional_score : null,
      enrichmentStatus: row.status,
    };
  }

  createRun(input: { executeResearch?: boolean; startImmediately?: boolean } = {}): ResearchRunView {
    const active = this.db.prepare("SELECT id FROM research_runs WHERE status IN ('SCORING','QUEUED','RUNNING') LIMIT 1").get();
    if (active) throw new Error("已有研究任务正在运行，请等待完成后再启动");
    const executeResearch = input.executeResearch !== false;
    const policy = this.getPolicy();
    const people = this.peopleSource.list();
    const now = this.now().toISOString();
    const runId = `research-${now.replace(/[^0-9]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
    const scored = people.map((person) => ({ person, ...scorePerson(person, policy, this.now()) }));
    const eligible = scored.filter((item) => item.score >= policy.threshold).sort((left, right) => right.score - left.score);
    const existingRows = this.db.prepare("SELECT * FROM research_cases").all() as unknown as StoredCaseRow[];
    const existingById = new Map(existingRows.map((row) => [row.cv_id, row]));
    const researchQueue = executeResearch
      ? eligible.filter((item) => caseNeedsResearch(existingById.get(item.person.cvId), item.person, this.now()))
      : [];
    const scheduledIds = new Set(researchQueue.slice(0, policy.maxCandidatesPerRun).map((item) => item.person.cvId));
    const scheduledTotal = scheduledIds.size;

    this.db.prepare(`INSERT INTO research_runs(
      id, status, execute_research, policy_json, people_total, scored_total, eligible_total, scheduled_total,
      completed_total, verified_total, review_required_total, failed_total, created_at
    ) VALUES(?, 'SCORING', ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?)`)
      .run(runId, executeResearch ? 1 : 0, JSON.stringify(policy), people.length, scored.length, eligible.length, scheduledTotal, now);

    const upsert = this.db.prepare(`INSERT INTO research_cases(
      cv_id, run_id, display_name, headline, professional_score, threshold, eligible, breakdown_json,
      status, identity_confidence, evidence_count, accepted_evidence_count, conflicts_json, model_used, searched_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cv_id) DO UPDATE SET
      run_id=excluded.run_id, display_name=excluded.display_name, headline=excluded.headline,
      professional_score=excluded.professional_score, threshold=excluded.threshold, eligible=excluded.eligible,
      breakdown_json=excluded.breakdown_json, status=excluded.status,
      identity_confidence=excluded.identity_confidence, evidence_count=excluded.evidence_count,
      accepted_evidence_count=excluded.accepted_evidence_count, conflicts_json=excluded.conflicts_json,
      model_used=excluded.model_used, searched_at=excluded.searched_at, updated_at=excluded.updated_at`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of scored) {
        const existing = existingById.get(item.person.cvId);
        const isEligible = item.score >= policy.threshold;
        let status: ResearchCaseStatus = "NOT_ELIGIBLE";
        let caseRunId = runId;
        const researchNeeded = caseNeedsResearch(existing, item.person, this.now());
        if (isEligible && !researchNeeded && existing) {
          status = existing.status;
          caseRunId = existing.run_id;
        } else if (isEligible && !executeResearch) status = "SCORED_ONLY";
        else if (isEligible && !scheduledIds.has(item.person.cvId)) status = "DEFERRED_BUDGET";
        else if (isEligible && !this.tavilyApiKey) status = "WAITING_PROVIDER";
        else if (isEligible) status = "QUEUED";
        upsert.run(
          item.person.cvId,
          caseRunId,
          item.person.displayName,
          item.person.headline,
          item.score,
          policy.threshold,
          isEligible ? 1 : 0,
          JSON.stringify(item.breakdown),
          status,
          existing?.identity_confidence ?? null,
          existing?.evidence_count ?? 0,
          existing?.accepted_evidence_count ?? 0,
          existing?.conflicts_json || "[]",
          existing?.model_used ?? null,
          existing?.searched_at ?? null,
          now,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const shouldStart = executeResearch && Boolean(this.tavilyApiKey) && scheduledTotal > 0;
    this.db.prepare("UPDATE research_runs SET status = ? WHERE id = ?").run(shouldStart ? "QUEUED" : "SCORED", runId);
    if (shouldStart && input.startImmediately !== false) {
      this.activeRun = this.processRun(runId).finally(() => { this.activeRun = null; });
    }
    return this.getRun(runId)!;
  }

  getRun(runId: string): ResearchRunView | null {
    const row = this.db.prepare("SELECT * FROM research_runs WHERE id = ?").get(runId) as unknown as StoredRunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  async waitForActiveRun(): Promise<void> {
    await this.activeRun;
  }

  close(): void {
    this.db.close();
  }

  async processRun(runId: string): Promise<void> {
    if (!this.tavilyApiKey) return;
    const run = this.getRun(runId);
    if (!run || !(["QUEUED", "INTERRUPTED"] as ResearchRunStatus[]).includes(run.status)) return;
    const startedAt = this.now().toISOString();
    this.db.prepare("UPDATE research_runs SET status = 'RUNNING', started_at = ?, error = NULL WHERE id = ?").run(startedAt, runId);
    const rows = this.db.prepare("SELECT cv_id FROM research_cases WHERE run_id = ? AND status = 'QUEUED' ORDER BY professional_score DESC").all(runId) as Array<{ cv_id: string }>;
    let providerPaused = false;
    let providerError = "";
    for (const row of rows) {
      const person = this.peopleSource.list().find((item) => item.cvId === row.cv_id);
      if (!person) continue;
      try {
        await this.researchPerson(runId, person);
      } catch (error) {
        if (error instanceof ProviderPauseError) {
          providerPaused = true;
          providerError = error.message;
          this.db.prepare("UPDATE research_cases SET status = 'WAITING_PROVIDER', conflicts_json = ?, updated_at = ? WHERE cv_id = ?")
            .run(JSON.stringify([error.message.slice(0, 180)]), this.now().toISOString(), person.cvId);
          break;
        }
        this.updateCaseDecision(person.cvId, { status: "FAILED", identityConfidence: null, conflicts: [error instanceof Error ? error.message.slice(0, 180) : "研究失败"], modelUsed: null });
      }
      this.refreshRunCounters(runId);
    }
    this.refreshRunCounters(runId);
    const counters = this.getRun(runId)!;
    const completedAt = this.now().toISOString();
    const finalStatus: ResearchRunStatus = providerPaused ? "PARTIAL" : counters.failedTotal > 0 ? "PARTIAL" : "COMPLETED";
    this.db.prepare("UPDATE research_runs SET status = ?, error = ?, completed_at = ? WHERE id = ?").run(finalStatus, providerError || null, completedAt, runId);
  }

  private refreshRunCounters(runId: string): void {
    const counts = this.db.prepare(`SELECT
      SUM(CASE WHEN status IN ('VERIFIED','NO_RELIABLE_RESULT','WRONG_PERSON','REVIEW_REQUIRED','CONFLICT','FAILED') THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'VERIFIED' THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN status IN ('REVIEW_REQUIRED','CONFLICT') THEN 1 ELSE 0 END) AS review_required,
      SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
      FROM research_cases WHERE run_id = ?`).get(runId) as Record<string, number | null>;
    this.db.prepare("UPDATE research_runs SET completed_total = ?, verified_total = ?, review_required_total = ?, failed_total = ? WHERE id = ?")
      .run(Number(counts.completed || 0), Number(counts.verified || 0), Number(counts.review_required || 0), Number(counts.failed || 0), runId);
  }

  private async researchPerson(_runId: string, person: PersonView): Promise<void> {
    this.db.prepare("UPDATE research_cases SET status = 'SEARCHING', updated_at = ? WHERE cv_id = ?").run(this.now().toISOString(), person.cvId);
    const query = publicIdentityQuery(person);
    const results = await this.searchPublicSources(query);
    const searchedAt = this.now().toISOString();
    this.db.prepare("UPDATE research_cases SET searched_at = ?, updated_at = ? WHERE cv_id = ?")
      .run(searchedAt, searchedAt, person.cvId);
    const evidence = results.slice(0, 5).flatMap((result, index): PublicSourceEvidence[] => {
      const cleaned = cleanUrl(result.url);
      if (!cleaned) return [];
      const title = cleanSnippet(result.title).slice(0, 160) || cleaned.domain;
      const snippet = cleanSnippet(result.content);
      const score = identityScore(person, title, snippet);
      const level = sourceLevel(cleaned.domain);
      const accepted = (level === "A" && score >= 0.82) || (level === "B" && score >= 0.72);
      return [{
        sourceId: `src_${crypto.createHash("sha256").update(`${person.cvId}|${cleaned.url}|${index}`).digest("hex").slice(0, 16)}`,
        title,
        domain: cleaned.domain,
        url: cleaned.url,
        publishedAt: typeof result.published_date === "string" ? result.published_date.slice(0, 32) : null,
        sourceLevel: level,
        identityScore: score,
        snippet,
        accepted,
      }];
    });
    this.replaceEvidence(person.cvId, evidence);
    const acceptedA = evidence.filter((item) => item.accepted && item.sourceLevel === "A");
    const acceptedB = evidence.filter((item) => item.accepted && item.sourceLevel === "B");
    const independentBDomains = new Set(acceptedB.map((item) => independentSourceKey(item.domain)));
    if (acceptedA.length >= 1 || independentBDomains.size >= 2) {
      const accepted = acceptedA.length ? acceptedA : acceptedB;
      this.updateCaseDecision(person.cvId, {
        status: "VERIFIED",
        identityConfidence: Math.max(...accepted.map((item) => item.identityScore)),
        conflicts: [],
        modelUsed: null,
      });
      return;
    }

    const ambiguous = evidence.filter((item) => item.identityScore >= 0.45);
    const ambiguousPublisherCount = new Set(ambiguous.map((item) => independentSourceKey(item.domain))).size;
    if (ambiguousPublisherCount >= 2 && this.deepseekApiKey && this.deepseekModel) {
      const decision = await this.resolveWithDeepSeek(person, evidence);
      this.updateCaseDecision(person.cvId, decision);
      return;
    }
    if (ambiguousPublisherCount >= 2) {
      this.updateCaseDecision(person.cvId, {
        status: "REVIEW_REQUIRED",
        identityConfidence: Math.max(...ambiguous.map((item) => item.identityScore)),
        conflicts: ["存在多个可能同名来源，DeepSeek冲突裁决未配置"],
        modelUsed: null,
      });
      return;
    }
    this.updateCaseDecision(person.cvId, {
      status: "NO_RELIABLE_RESULT",
      identityConfidence: evidence.length ? Math.max(...evidence.map((item) => item.identityScore)) : null,
      conflicts: [],
      modelUsed: null,
    });
  }

  private async searchPublicSources(query: string): Promise<TavilyResult[]> {
    const queryHash = crypto.createHash("sha256").update(query).digest("hex");
    const cached = this.db.prepare("SELECT result_json FROM research_query_cache WHERE query_hash = ? AND expires_at > ?").get(queryHash, this.now().toISOString()) as { result_json: string } | undefined;
    if (cached) return jsonParse<TavilyResult[]>(cached.result_json, []);
    const response = await this.fetchImpl(this.tavilyEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.tavilyApiKey,
        query,
        topic: "general",
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if ([401, 403, 429].includes(response.status)) throw new ProviderPauseError(`Tavily返回${response.status}，研究任务已暂停且未自动重试`);
    if (!response.ok) throw new Error(`Tavily请求失败：HTTP ${response.status}`);
    const payload = await response.json() as { results?: TavilyResult[] };
    const results = Array.isArray(payload.results) ? payload.results.slice(0, 5) : [];
    const now = this.now();
    const expiresAt = new Date(now.getTime() + 7 * 86_400_000).toISOString();
    this.db.prepare("INSERT INTO research_query_cache(query_hash, result_json, expires_at, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(query_hash) DO UPDATE SET result_json=excluded.result_json, expires_at=excluded.expires_at, created_at=excluded.created_at")
      .run(queryHash, JSON.stringify(results), expiresAt, now.toISOString());
    return results;
  }

  private replaceEvidence(cvId: string, evidence: PublicSourceEvidence[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM research_evidence WHERE cv_id = ?").run(cvId);
      const insert = this.db.prepare("INSERT INTO research_evidence(source_id, cv_id, title, domain, url, published_at, source_level, identity_score, snippet, accepted, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const now = this.now().toISOString();
      for (const item of evidence) insert.run(item.sourceId, cvId, item.title, item.domain, item.url, item.publishedAt, item.sourceLevel, item.identityScore, item.snippet, item.accepted ? 1 : 0, now);
      this.db.prepare("UPDATE research_cases SET evidence_count = ?, accepted_evidence_count = ?, updated_at = ? WHERE cv_id = ?")
        .run(evidence.length, evidence.filter((item) => item.accepted).length, now, cvId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private updateCaseDecision(cvId: string, decision: IdentityDecision): void {
    this.db.prepare("UPDATE research_cases SET status = ?, identity_confidence = ?, conflicts_json = ?, model_used = ?, updated_at = ? WHERE cv_id = ?")
      .run(decision.status, decision.identityConfidence, JSON.stringify(decision.conflicts.slice(0, 5)), decision.modelUsed, this.now().toISOString(), cvId);
  }

  private async resolveWithDeepSeek(person: PersonView, evidence: PublicSourceEvidence[]): Promise<IdentityDecision> {
    const skill = fs.readFileSync(skillPath, "utf8").trim();
    const minimalIdentity = {
      person_id: person.cvId,
      name: person.displayName,
      location: person.residence,
      career_identifiers: [
        person.headline,
        ...person.experiences.slice(0, 2).flatMap((item) => [item.position, item.organization]),
        ...person.skills.slice(0, 5).map((item) => item.name),
      ].filter(Boolean).slice(0, 6),
      sources: evidence.slice(0, 5).map((item) => ({
        source_id: item.sourceId,
        source_level: item.sourceLevel,
        identity_score: item.identityScore,
        title: item.title,
        domain: item.domain,
        snippet: item.snippet.slice(0, 180),
      })),
    };
    const response = await this.fetchImpl(`${this.deepseekBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.deepseekApiKey}` },
      body: JSON.stringify({
        model: this.deepseekModel,
        temperature: 0,
        max_tokens: 350,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: skill },
          { role: "user", content: JSON.stringify(minimalIdentity) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if ([401, 403, 429].includes(response.status)) throw new ProviderPauseError(`DeepSeek返回${response.status}，复杂裁决已暂停且未自动重试`);
    if (!response.ok) throw new Error(`DeepSeek请求失败：HTTP ${response.status}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = payload.choices?.[0]?.message?.content || "{}";
    const parsed = jsonParse<Record<string, unknown>>(raw, {});
    const allowed = new Set(["VERIFIED", "REVIEW_REQUIRED", "CONFLICT", "WRONG_PERSON", "NO_RELIABLE_RESULT"]);
    let status = String(parsed.status || "REVIEW_REQUIRED") as ResearchCaseStatus;
    if (!allowed.has(status)) status = "REVIEW_REQUIRED";
    const confidence = clamp(Number(parsed.identity_confidence || 0), 0, 1);
    const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts.map(String).map((item) => item.slice(0, 180)).slice(0, 5) : [];
    const acceptedIds = Array.isArray(parsed.accepted_evidence_ids) ? parsed.accepted_evidence_ids.map(String) : [];
    const availableIds = new Set(evidence.map((item) => item.sourceId));
    if (acceptedIds.some((id) => !availableIds.has(id))) {
      status = "REVIEW_REQUIRED";
      conflicts.push("模型返回了不存在的证据ID");
    }
    const strictAccepted = evidence.filter((item) => item.accepted && acceptedIds.includes(item.sourceId));
    const strictA = strictAccepted.some((item) => item.sourceLevel === "A");
    const strictB = new Set(strictAccepted.filter((item) => item.sourceLevel === "B").map((item) => independentSourceKey(item.domain))).size >= 2;
    if (status === "VERIFIED" && !(strictA || strictB)) {
      status = "REVIEW_REQUIRED";
      conflicts.push("证据未达到一个A级或两个独立B级来源的自动通过门槛");
    }
    return { status, identityConfidence: confidence || null, conflicts, modelUsed: this.deepseekModel };
  }
}
