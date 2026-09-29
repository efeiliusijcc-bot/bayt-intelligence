import assert from "node:assert/strict";
import test from "node:test";
import {
  AnalyticsFilterError,
  buildDashboardAnalytics,
  classifyFunction,
  classifySeniority,
  classifyUpdatedRange,
  experienceBucket,
  hasCompleteCoreProfile,
} from "./dashboard-analytics.ts";
import type { PersonView } from "./types.ts";

function person(overrides: Partial<PersonView> = {}): PersonView {
  return {
    id: "1",
    cvId: "1",
    displayName: "Test Person",
    headline: "Software Engineer",
    nationality: "India",
    residence: "India - Bengaluru",
    lastCvUpdate: "2026-08-22",
    topSkills: [{ name: "TypeScript", source: "EXCEL" }],
    skills: [{ name: "TypeScript", source: "EXCEL" }],
    experiences: [{ organization: "Example", position: "Software Engineer", years: "2", source: "EXCEL" }],
    educations: [{ description: "Bachelor's degree", source: "EXCEL" }],
    languages: [{ name: "English", level: "Expert", source: "EXCEL" }],
    summary: null,
    avatarStatus: "photo",
    hasAvatar: true,
    attachments: [
      { id: "1:bayt_pdf", kind: "bayt_pdf", label: "Bayt", mimeType: "application/pdf", sizeBytes: 1, status: "downloaded", previewable: true, originalName: "bayt.pdf" },
      { id: "1:original", kind: "original", label: "Original", mimeType: "application/pdf", sizeBytes: 1, status: "downloaded", previewable: true, originalName: "original.pdf" },
    ],
    professionalScore: null,
    researchPriorityScore: null,
    enrichmentStatus: "NOT_CONFIGURED",
    sourceTags: ["EXCEL"],
    importedAt: null,
    ...overrides,
  };
}

test("核心资料完整率严格要求9项全部存在", () => {
  const complete = person();
  assert.equal(hasCompleteCoreProfile(complete), true);
  assert.equal(hasCompleteCoreProfile({ ...complete, languages: [] }), false);
  assert.equal(hasCompleteCoreProfile({ ...complete, displayName: "CV 1" }), false);
});
test("职级与职能按规则优先级归为单一主类", () => {
  assert.equal(classifySeniority(person({ headline: "Engineering Director and Senior Developer" })), "director");
  assert.equal(classifySeniority(person({ headline: "Engineering Manager and Lead Developer" })), "manager");
  assert.equal(classifySeniority(person({ headline: "Senior Software Engineer" })), "senior");
  assert.equal(classifySeniority(person({ headline: "Associate Software Engineer" })), "junior");
  assert.equal(classifyFunction(person({ headline: "Full Stack Mobile Developer", skills: [] })), "fullstack");
  assert.equal(classifyFunction(person({ headline: "Software Engineer", skills: [{ name: "Machine Learning", source: "EXCEL" }, { name: "React", source: "EXCEL" }] })), "data_ai");
});

test("经验累计、<1折算和分箱边界互斥", () => {
  assert.equal(experienceBucket(person({ experiences: [{ organization: "A", years: "< 1", source: "EXCEL" }] })), "0_2");
  assert.equal(experienceBucket(person({ experiences: [{ organization: "A", years: "2", source: "EXCEL" }] })), "2_5");
  assert.equal(experienceBucket(person({ experiences: [{ organization: "A", years: "4", source: "EXCEL" }, { organization: "B", years: "1", source: "EXCEL" }] })), "5_10");
  assert.equal(experienceBucket(person({ experiences: [{ organization: "A", source: "EXCEL" }] })), "unknown");
});

test("更新时间边界按Asia/Shanghai日期计算", () => {
  const now = new Date("2026-08-22T08:00:00Z");
  assert.equal(classifyUpdatedRange("2026-08-22", now), "today");
  assert.equal(classifyUpdatedRange("2026-08-15", now), "1_7");
  assert.equal(classifyUpdatedRange("2026-07-23", now), "8_30");
  assert.equal(classifyUpdatedRange("2026-05-24", now), "31_90");
  assert.equal(classifyUpdatedRange("2026-02-23", now), "91_180");
  assert.equal(classifyUpdatedRange("2025-08-22", now), "181_365");
  assert.equal(classifyUpdatedRange("2025-08-21", now), "over_365");
  assert.equal(classifyUpdatedRange(null, now), "unknown");
});

test("筛选组合、技能语言去重和分布分母保持一致", () => {
  const now = new Date("2026-08-22T08:00:00Z");
  const people = [
    person({ id: "1", cvId: "1", skills: [{ name: "Python (Expert)", source: "EXCEL" }, { name: "python", source: "EXCEL" }], languages: [{ name: "English", source: "EXCEL" }, { name: "english", source: "EXCEL" }] }),
    person({ id: "2", cvId: "2", displayName: "Uploaded", residence: "Egypt - Cairo", lastCvUpdate: "2026-07-01", importedAt: "2026-08-22T00:00:00Z" }),
    person({ id: "3", cvId: "3", displayName: "Other", residence: "India - Pune", lastCvUpdate: null }),
  ];
  const runs = [{ id: "batch-1", query: "Software Engineer", targetCount: 50, uniqueCount: 50, completedAt: "2026-08-22T00:00:00Z", candidateIds: ["1"] }];
  const all = buildDashboardAnalytics(people, runs, {}, now);
  assert.equal(all.distributions.skills.find((item) => item.key === "python")?.count, 1);
  assert.equal(all.distributions.languages.find((item) => item.key === "english")?.count, 3);
  for (const key of ["countries", "seniority", "functions", "experience", "education", "updated"] as const) {
    assert.equal(all.distributions[key].reduce((sum, item) => sum + item.count, 0), 3);
  }
  const scoped = buildDashboardAnalytics(people, runs, { batch: "batch-1", source: "BAYT", country: "India", updatedRange: "today" }, now);
  assert.equal(scoped.scope.peopleTotal, 1);
  assert.equal(scoped.kpis.peopleTotal, 1);
  assert.equal(scoped.distributions.skills[0]?.percentage, 100);
});

test("非法筛选抛出固定错误码", () => {
  assert.throws(
    () => buildDashboardAnalytics([person()], [], { source: "UNKNOWN" }),
    (error) => error instanceof AnalyticsFilterError && error.code === "INVALID_ANALYTICS_FILTER",
  );
});
