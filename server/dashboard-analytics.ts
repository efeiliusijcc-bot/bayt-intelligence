import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { PeopleRepository } from "./people-repository.ts";
import type { PersonView } from "./types.ts";

export const UPDATED_RANGE_VALUES = [
  "all",
  "today",
  "1_7",
  "8_30",
  "31_90",
  "91_180",
  "181_365",
  "over_365",
  "unknown",
] as const;

export type AnalyticsSource = "BAYT" | "USER_UPLOAD";
export type UpdatedRange = (typeof UPDATED_RANGE_VALUES)[number];

export interface AnalyticsFilters {
  batch: string;
  source: "all" | AnalyticsSource;
  country: string;
  updatedRange: UpdatedRange;
}

export interface AnalyticsDistributionItem {
  key: string;
  label: string;
  count: number;
  percentage: number;
}

export interface CollectionRunAnalytics {
  id: string;
  query: string;
  targetCount: number;
  uniqueCount: number;
  completedAt: string;
  candidateIds: string[];
}

interface CollectionRunRow {
  run_id: string;
  query: string;
  target_count: number;
  unique_count: number;
  completed_at: string;
}

interface RunCandidateRow {
  run_id: string;
  cv_id: string;
}

interface AnalyticsPerson {
  person: PersonView;
  source: AnalyticsSource;
  batchIds: Set<string>;
}

export class AnalyticsFilterError extends Error {
  readonly code = "INVALID_ANALYTICS_FILTER";
}

const UPDATED_RANGE_OPTIONS: Array<{ value: UpdatedRange; label: string }> = [
  { value: "all", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "1_7", label: "近7天" },
  { value: "8_30", label: "8-30天" },
  { value: "31_90", label: "31-90天" },
  { value: "91_180", label: "91-180天" },
  { value: "181_365", label: "181-365天" },
  { value: "over_365", label: "1年以上" },
  { value: "unknown", label: "未知" },
];

const EXPERIENCE_ORDER = [
  ["0_2", "0-2年"],
  ["2_5", "2-5年"],
  ["5_10", "5-10年"],
  ["10_15", "10-15年"],
  ["15_plus", "15年以上"],
  ["unknown", "未知"],
] as const;

const SENIORITY_ORDER = [
  ["director", "负责人/总监"],
  ["manager", "管理者"],
  ["senior", "高级"],
  ["junior", "初级"],
  ["mid", "中级"],
  ["unknown", "未分类"],
] as const;

const FUNCTION_ORDER = [
  ["management_product", "管理/产品"],
  ["fullstack", "全栈"],
  ["mobile", "移动端"],
  ["data_ai", "数据与AI"],
  ["devops_cloud", "DevOps与云"],
  ["quality", "测试"],
  ["security", "信息安全"],
  ["frontend", "前端"],
  ["backend", "后端"],
  ["software", "通用软件工程"],
  ["other", "其他"],
] as const;

const EDUCATION_ORDER = [
  ["doctorate", "博士"],
  ["master", "硕士"],
  ["bachelor", "本科"],
  ["diploma", "专科/文凭"],
  ["high_school", "高中及同等学历"],
  ["other", "其他"],
  ["unknown", "未知"],
] as const;

function roundPercentage(count: number, total: number): number {
  return total ? Math.round((count / total) * 1000) / 10 : 0;
}

function hasText(value: unknown): boolean {
  return typeof value === "string" ? Boolean(value.trim()) : Boolean(value);
}

export function hasCompleteCoreProfile(person: PersonView): boolean {
  const hasRealName = hasText(person.displayName) && !/^CV\s+\d+$/i.test(person.displayName.trim());
  return [
    hasRealName,
    hasText(person.headline),
    hasText(person.nationality),
    hasText(person.residence),
    person.educations.length > 0,
    person.experiences.length > 0,
    person.skills.length > 0,
    person.languages.length > 0,
    hasText(person.lastCvUpdate),
  ].every(Boolean);
}

export function extractResidenceCountry(residence: string | null): string {
  if (!residence?.trim()) return "未知";
  return residence.split(/\s+[-\u2013\u2014]\s+/)[0]?.trim() || "未知";
}

export function classifySeniority(person: Pick<PersonView, "headline" | "experiences">): string {
  const corpus = [person.headline, ...person.experiences.map((item) => item.position)].filter(Boolean).join(" ").toLocaleLowerCase();
  if (/\b(director|head|chief|vp|vice president)\b/.test(corpus)) return "director";
  if (/\b(manager|management|supervisor)\b/.test(corpus)) return "manager";
  if (/\b(senior|sr\.?|lead|principal|architect|staff)\b/.test(corpus)) return "senior";
  if (/\b(junior|jr\.?|associate|intern|internship|trainee|graduate)\b/.test(corpus)) return "junior";
  if (/\b(engineer|developer)\b/.test(corpus)) return "mid";
  return "unknown";
}

export function classifyFunction(person: Pick<PersonView, "headline" | "skills">): string {
  const corpus = [person.headline, ...person.skills.map((item) => item.name)].filter(Boolean).join(" ").toLocaleLowerCase();
  if (/\b(product manager|product owner|project manager|engineering manager|technical manager|director|head of|scrum master)\b/.test(corpus)) return "management_product";
  if (/\b(full[ -]?stack)\b/.test(corpus)) return "fullstack";
  if (/\b(android|ios|flutter|react native|mobile|swift|kotlin)\b/.test(corpus)) return "mobile";
  if (/\b(machine learning|artificial intelligence|ai\b|data scientist|data engineer|big data|nlp|computer vision|deep learning|pytorch|tensorflow)\b/.test(corpus)) return "data_ai";
  if (/\b(devops|site reliability|sre\b|cloud|aws\b|azure\b|gcp\b|kubernetes|docker|platform engineer|terraform|jenkins)\b/.test(corpus)) return "devops_cloud";
  if (/\b(quality assurance|qa\b|tester|testing|test automation|selenium)\b/.test(corpus)) return "quality";
  if (/\b(cyber ?security|information security|security engineer|penetration|soc analyst|ethical hack)\b/.test(corpus)) return "security";
  if (/\b(front[ -]?end|ui developer|react(js)?\b|angular\b|vue(js)?\b|html5?\b|css3?\b)\b/.test(corpus)) return "frontend";
  if (/\b(back[ -]?end|java\b|spring boot|\.net\b|c#\b|php\b|laravel|node\.?js|django|ruby on rails|api developer)\b/.test(corpus)) return "backend";
  if (/\b(software|developer|engineer|programming)\b/.test(corpus)) return "software";
  return "other";
}

function parseExperienceYears(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  if (/^\s*<\s*1\b/.test(value)) return 0.5;
  const match = value.replace(/,/g, ".").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function experienceBucket(person: Pick<PersonView, "experiences">): string {
  const values = person.experiences.map((item) => parseExperienceYears(item.years)).filter((value): value is number => value !== null);
  if (!values.length) return "unknown";
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total < 2) return "0_2";
  if (total < 5) return "2_5";
  if (total < 10) return "5_10";
  if (total < 15) return "10_15";
  return "15_plus";
}

export function educationBucket(person: Pick<PersonView, "educations">): string {
  const corpus = person.educations.map((item) => item.description).join(" ").toLocaleLowerCase();
  if (!corpus.trim()) return "unknown";
  if (/\b(ph\.?d|doctorate|doctoral)\b/.test(corpus)) return "doctorate";
  if (/\b(master|m\.?sc|mba\b|postgraduate)\b/.test(corpus)) return "master";
  if (/\b(bachelor|b\.?sc|b\.?tech|undergraduate)\b/.test(corpus)) return "bachelor";
  if (/\b(diploma|associate degree|higher national)\b/.test(corpus)) return "diploma";
  if (/\b(high school|secondary school|equivalent)\b/.test(corpus)) return "high_school";
  return "other";
}

function localDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseDateKey(value: string | null): number | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function classifyUpdatedRange(value: string | null, now = new Date()): Exclude<UpdatedRange, "all"> {
  const updated = parseDateKey(value);
  const today = parseDateKey(localDateKey(now));
  if (updated === null || today === null) return "unknown";
  const days = Math.max(0, Math.floor((today - updated) / 86_400_000));
  if (days === 0) return "today";
  if (days <= 7) return "1_7";
  if (days <= 30) return "8_30";
  if (days <= 90) return "31_90";
  if (days <= 180) return "91_180";
  if (days <= 365) return "181_365";
  return "over_365";
}

function distributionFromOrder(
  counts: Map<string, number>,
  total: number,
  order: ReadonlyArray<readonly [string, string]>,
  includeZero = true,
): AnalyticsDistributionItem[] {
  if (!total) return [];
  return order
    .map(([key, label]) => ({ key, label, count: counts.get(key) || 0, percentage: roundPercentage(counts.get(key) || 0, total) }))
    .filter((item) => includeZero || item.count > 0);
}

function rankedDistribution(
  counts: Map<string, { count: number; label: string }>,
  total: number,
  limit: number,
  aggregateRemainder: boolean,
): AnalyticsDistributionItem[] {
  if (!total) return [];
  const ranked = [...counts.entries()]
    .map(([key, value]) => ({ key, label: value.label, count: value.count, percentage: roundPercentage(value.count, total) }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"));
  if (!aggregateRemainder || ranked.length <= limit) return ranked.slice(0, limit);
  const visible = ranked.slice(0, limit);
  const remainder = ranked.slice(limit).reduce((sum, item) => sum + item.count, 0);
  return [...visible, { key: "other", label: "其他", count: remainder, percentage: roundPercentage(remainder, total) }];
}

function addRankedCount(counts: Map<string, { count: number; label: string }>, rawLabel: string): void {
  const label = rawLabel.replace(/\s*\([^()]*\)\s*$/, "").replace(/\s+/g, " ").trim();
  if (!label) return;
  const key = label.toLocaleLowerCase();
  const current = counts.get(key);
  counts.set(key, { count: (current?.count || 0) + 1, label: current?.label || label });
}

function countBy(items: AnalyticsPerson[], classifier: (item: AnalyticsPerson) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = classifier(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function formatShanghaiTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+08:00`;
}

export function loadCollectionRuns(databasePath = config.collectionDbPath): CollectionRunAnalytics[] {
  if (!fs.existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const runs = database.prepare(
      `SELECT run_id, query, target_count, unique_count, completed_at
       FROM collection_runs
       WHERE status = 'completed' AND target_count >= 50 AND completed_at IS NOT NULL
       ORDER BY completed_at`,
    ).all() as unknown as CollectionRunRow[];
    const candidateRows = database.prepare(
      `SELECT rc.run_id, rc.cv_id
       FROM run_candidates rc
       JOIN collection_runs cr ON cr.run_id = rc.run_id
       WHERE cr.status = 'completed' AND cr.target_count >= 50
       ORDER BY rc.run_id, rc.ordinal`,
    ).all() as unknown as RunCandidateRow[];
    return runs.map((run) => ({
      id: run.run_id,
      query: run.query,
      targetCount: run.target_count,
      uniqueCount: run.unique_count,
      completedAt: run.completed_at,
      candidateIds: candidateRows.filter((item) => item.run_id === run.run_id).map((item) => item.cv_id),
    }));
  } finally {
    database.close();
  }
}

function normalizeFilterValue(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  return Array.isArray(value) ? value.join(",") : String(value);
}

export function validateAnalyticsFilters(
  raw: Partial<Record<keyof AnalyticsFilters, unknown>>,
  runs: CollectionRunAnalytics[],
  countries: string[],
): AnalyticsFilters {
  const filters: AnalyticsFilters = {
    batch: normalizeFilterValue(raw.batch, "all"),
    source: normalizeFilterValue(raw.source, "all") as AnalyticsFilters["source"],
    country: normalizeFilterValue(raw.country, "all"),
    updatedRange: normalizeFilterValue(raw.updatedRange, "all") as UpdatedRange,
  };
  const invalid =
    (filters.batch !== "all" && !runs.some((run) => run.id === filters.batch)) ||
    !(["all", "BAYT", "USER_UPLOAD"] as string[]).includes(filters.source) ||
    (filters.country !== "all" && !countries.includes(filters.country)) ||
    !(UPDATED_RANGE_VALUES as readonly string[]).includes(filters.updatedRange);
  if (invalid) throw new AnalyticsFilterError("筛选参数无效，请从接口提供的选项中选择");
  return filters;
}

export function buildDashboardAnalytics(
  people: PersonView[],
  runs: CollectionRunAnalytics[],
  rawFilters: Partial<Record<keyof AnalyticsFilters, unknown>> = {},
  now = new Date(),
) {
  const runMembership = new Map<string, Set<string>>();
  for (const run of runs) for (const cvId of run.candidateIds) {
    const memberships = runMembership.get(cvId) || new Set<string>();
    memberships.add(run.id);
    runMembership.set(cvId, memberships);
  }
  const globalPeople: AnalyticsPerson[] = people.map((person) => ({
    person,
    source: person.importedAt ? "USER_UPLOAD" : "BAYT",
    batchIds: runMembership.get(person.cvId) || new Set<string>(),
  }));
  const globalCountries = [...new Set(globalPeople.map((item) => extractResidenceCountry(item.person.residence)))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const filters = validateAnalyticsFilters(rawFilters, runs, globalCountries);
  const scoped = globalPeople.filter((item) => {
    if (filters.batch !== "all" && !item.batchIds.has(filters.batch)) return false;
    if (filters.source !== "all" && item.source !== filters.source) return false;
    if (filters.country !== "all" && extractResidenceCountry(item.person.residence) !== filters.country) return false;
    const range = classifyUpdatedRange(item.person.lastCvUpdate, now);
    return filters.updatedRange === "all" || range === filters.updatedRange;
  });
  const total = scoped.length;
  const completeCount = scoped.filter((item) => hasCompleteCoreProfile(item.person)).length;
  const hasAttachment = (item: AnalyticsPerson, kind: "bayt_pdf" | "original") =>
    item.person.attachments.some((attachment) => attachment.kind === kind && attachment.status === "downloaded");
  const baytPdfAvailable = scoped.filter((item) => hasAttachment(item, "bayt_pdf")).length;
  const originalAvailable = scoped.filter((item) => hasAttachment(item, "original")).length;
  const avatarsAvailable = scoped.filter((item) => item.person.hasAvatar).length;
  const updatedWithin90Days = scoped.filter((item) => ["today", "1_7", "8_30", "31_90"].includes(classifyUpdatedRange(item.person.lastCvUpdate, now))).length;
  const reviewPending = scoped.filter((item) =>
    !hasCompleteCoreProfile(item.person) || !hasAttachment(item, "bayt_pdf") || !hasAttachment(item, "original"),
  ).length;

  const countryCounts = new Map<string, { count: number; label: string }>();
  for (const item of scoped) addRankedCount(countryCounts, extractResidenceCountry(item.person.residence));
  const seniorityCounts = countBy(scoped, (item) => classifySeniority(item.person));
  const functionCounts = countBy(scoped, (item) => classifyFunction(item.person));
  const experienceCounts = countBy(scoped, (item) => experienceBucket(item.person));
  const educationCounts = countBy(scoped, (item) => educationBucket(item.person));
  const updatedCounts = countBy(scoped, (item) => classifyUpdatedRange(item.person.lastCvUpdate, now));
  const skillCounts = new Map<string, { count: number; label: string }>();
  const languageCounts = new Map<string, { count: number; label: string }>();
  for (const item of scoped) {
    const skills = new Map<string, string>();
    for (const skill of item.person.skills) {
      const label = skill.name.replace(/\s*\([^()]*\)\s*$/, "").replace(/\s+/g, " ").trim();
      if (label) skills.set(label.toLocaleLowerCase(), label);
    }
    for (const label of skills.values()) addRankedCount(skillCounts, label);
    const languages = new Map<string, string>();
    for (const language of item.person.languages) {
      const label = language.name.replace(/\s*\([^()]*\)\s*$/, "").replace(/\s+/g, " ").trim();
      if (label) languages.set(label.toLocaleLowerCase(), label);
    }
    for (const label of languages.values()) addRankedCount(languageCounts, label);
  }

  const functionLabels = new Map<string, string>(FUNCTION_ORDER);
  const functionRanked = new Map<string, { count: number; label: string }>();
  for (const [key, count] of functionCounts) functionRanked.set(key, { count, label: functionLabels.get(key) || "其他" });

  const cumulative = new Set<string>();
  const cumulativeByRun = new Map<string, number>();
  for (const run of runs) {
    for (const cvId of run.candidateIds) cumulative.add(cvId);
    cumulativeByRun.set(run.id, cumulative.size);
  }
  const peopleById = new Map(people.map((person) => [person.cvId, person]));
  const recentBatches = [...runs].reverse().slice(0, 3).map((run, reverseIndex) => {
    const batchPeople = run.candidateIds.map((cvId) => peopleById.get(cvId)).filter((person): person is PersonView => Boolean(person));
    const batchComplete = batchPeople.filter(hasCompleteCoreProfile).length;
    return {
      id: run.id,
      label: `采集批次 ${runs.length - reverseIndex}`,
      query: run.query,
      source: "BAYT" as const,
      completedAt: run.completedAt,
      addedCount: batchPeople.length,
      deduplicatedTotal: cumulativeByRun.get(run.id) || 0,
      completenessPercentage: roundPercentage(batchComplete, batchPeople.length),
      status: "completed" as const,
    };
  });
  const latestRunAt = runs.at(-1)?.completedAt || null;

  return {
    filterOptions: {
      batches: [{ value: "all", label: "全部批次" }, ...runs.map((run, index) => ({ value: run.id, label: `采集批次 ${index + 1} / ${run.uniqueCount}人` }))],
      sources: [
        { value: "all", label: "全部来源" },
        { value: "BAYT", label: "Bayt采集" },
        { value: "USER_UPLOAD", label: "用户导入" },
      ],
      countries: [{ value: "all", label: "全部国家/地区" }, ...globalCountries.map((country) => ({ value: country, label: country }))],
      updatedRanges: UPDATED_RANGE_OPTIONS,
    },
    scope: { peopleTotal: total, appliedFilters: filters },
    kpis: {
      peopleTotal: total,
      coreComplete: completeCount,
      coreCompletenessPercentage: roundPercentage(completeCount, total),
      baytPdfAvailable,
      originalAvailable,
      originalCoveragePercentage: roundPercentage(originalAvailable, total),
      avatarsAvailable,
      updatedWithin90Days,
      updatedWithin90DaysPercentage: roundPercentage(updatedWithin90Days, total),
      researchConfigured: false,
      researchCandidates: null,
      reviewPending,
      reviewPendingPercentage: roundPercentage(reviewPending, total),
    },
    distributions: {
      countries: rankedDistribution(countryCounts, total, 6, true),
      seniority: distributionFromOrder(seniorityCounts, total, SENIORITY_ORDER, false),
      functions: rankedDistribution(functionRanked, total, 10, true),
      experience: distributionFromOrder(experienceCounts, total, EXPERIENCE_ORDER),
      skills: rankedDistribution(skillCounts, total, 15, false),
      education: distributionFromOrder(educationCounts, total, EDUCATION_ORDER, false),
      languages: rankedDistribution(languageCounts, total, 10, false),
      updated: distributionFromOrder(updatedCounts, total, UPDATED_RANGE_OPTIONS.filter((item) => item.value !== "all").map((item) => [item.value, item.label] as const)),
    },
    recentBatches,
    processingStages: [
      { id: "database", label: "采集数据库", status: "healthy" as const, summary: `${people.length} 人只读连接正常`, lastRunAt: latestRunAt },
      { id: "profile", label: "资料解析", status: people.length ? "healthy" as const : "attention" as const, summary: `${people.length}/${people.length} 人已解析`, lastRunAt: latestRunAt },
      { id: "deduplication", label: "去重归并", status: new Set(people.map((person) => person.cvId)).size === people.length ? "healthy" as const : "attention" as const, summary: `${new Set(people.map((person) => person.cvId)).size} 个唯一 CV_ID`, lastRunAt: latestRunAt },
      { id: "bayt_pdf", label: "Bayt PDF映射", status: baytPdfAvailable === total ? "healthy" as const : "attention" as const, summary: `${baytPdfAvailable}/${total} 份可用`, lastRunAt: latestRunAt },
      { id: "original", label: "原始附件映射", status: originalAvailable === total ? "healthy" as const : "attention" as const, summary: `${originalAvailable}/${total} 份可用`, lastRunAt: latestRunAt },
    ],
    generatedAt: formatShanghaiTimestamp(now),
  };
}

export class DashboardAnalyticsService {
  private readonly peopleRepository: PeopleRepository;
  private readonly databasePath: string;

  constructor(
    peopleRepository: PeopleRepository,
    databasePath = config.collectionDbPath,
  ) {
    this.peopleRepository = peopleRepository;
    this.databasePath = databasePath;
  }

  get(filters: Partial<Record<keyof AnalyticsFilters, unknown>> = {}, now = new Date()) {
    return buildDashboardAnalytics(this.peopleRepository.list(), loadCollectionRuns(this.databasePath), filters, now);
  }
}
