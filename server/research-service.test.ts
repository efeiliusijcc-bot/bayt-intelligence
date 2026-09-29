import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_RESEARCH_POLICY, ResearchService, scorePerson } from "./research-service.ts";
import type { PersonView } from "./types.ts";

const fixedNow = new Date("2026-08-25T00:00:00.000Z");

function person(overrides: Partial<PersonView> = {}): PersonView {
  const cvId = overrides.cvId || "CV-1001";
  return {
    id: cvId,
    cvId,
    displayName: "Ali Example",
    headline: "Senior Software Engineer",
    nationality: "Jordan",
    residence: "Dubai - UAE",
    lastCvUpdate: "2026-08-20",
    topSkills: [
      { name: "TypeScript", source: "EXCEL" },
      { name: "Node", source: "EXCEL" },
    ],
    skills: [
      { name: "TypeScript", source: "EXCEL" },
      { name: "JavaScript", source: "EXCEL" },
      { name: "Node", source: "EXCEL" },
      { name: "SQL", source: "EXCEL" },
    ],
    experiences: [{ organization: "Example Labs", position: "Senior Software Engineer", years: "5", source: "EXCEL" }],
    educations: [{ description: "Bachelor of Computer Science", source: "EXCEL" }],
    languages: [{ name: "English", level: "Fluent", source: "EXCEL" }],
    summary: null,
    avatarStatus: "missing",
    hasAvatar: false,
    attachments: [{
      id: `${cvId}:bayt_pdf`,
      kind: "bayt_pdf",
      label: "Bayt 生成简历",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      status: "downloaded",
      previewable: true,
      originalName: `${cvId}.pdf`,
    }],
    professionalScore: null,
    researchPriorityScore: null,
    enrichmentStatus: "NOT_CONFIGURED",
    sourceTags: ["EXCEL"],
    importedAt: null,
    ...overrides,
  };
}

function lowScorePerson(cvId = "CV-LOW"): PersonView {
  return person({
    id: cvId,
    cvId,
    displayName: "Low Score",
    headline: "Sales Assistant",
    lastCvUpdate: null,
    topSkills: [],
    skills: [],
    experiences: [],
    educations: [],
    languages: [],
    attachments: [],
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function serviceFor(people: PersonView[], fetchImpl: typeof fetch, options: { deepseek?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bayt-research-"));
  const service = new ResearchService(
    { list: () => people },
    {
      databasePath: path.join(directory, "research.db"),
      fetchImpl,
      tavilyApiKey: "test-tavily-key",
      tavilyEndpoint: "https://tavily.test/search",
      deepseekApiKey: options.deepseek ? "test-deepseek-key" : "",
      deepseekBaseUrl: "https://deepseek.test/v1",
      deepseekModel: options.deepseek ? "deepseek-test" : "",
      now: () => fixedNow,
    },
  );
  return {
    service,
    cleanup: () => {
      service.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function runAndWait(service: ResearchService) {
  const run = service.createRun({ executeResearch: true });
  await service.waitForActiveRun();
  return service.getRun(run.id)!;
}

test("未达到70分门槛的人物不会调用Tavily", async () => {
  let calls = 0;
  const fixture = serviceFor([lowScorePerson()], (async () => {
    calls += 1;
    return jsonResponse({ results: [] });
  }) as typeof fetch);
  try {
    const run = await runAndWait(fixture.service);
    assert.equal(calls, 0);
    assert.equal(run.eligibleTotal, 0);
    assert.equal(fixture.service.getCase("CV-LOW")?.status, "NOT_ELIGIBLE");
  } finally {
    fixture.cleanup();
  }
});

test("达到门槛的人物才进入Tavily搜索", async () => {
  let calls = 0;
  const fixture = serviceFor([person(), lowScorePerson()], (async () => {
    calls += 1;
    return jsonResponse({ results: [] });
  }) as typeof fetch);
  try {
    const run = await runAndWait(fixture.service);
    assert.equal(calls, 1);
    assert.equal(run.eligibleTotal, 1);
    assert.equal(fixture.service.getCase("CV-1001")?.status, "NO_RELIABLE_RESULT");
    assert.equal(fixture.service.getCase("CV-LOW")?.status, "NOT_ELIGIBLE");
  } finally {
    fixture.cleanup();
  }
});

test("仅评分模式保存透明分数但不调用Tavily", () => {
  let calls = 0;
  const fixture = serviceFor([person()], (async () => {
    calls += 1;
    return jsonResponse({ results: [] });
  }) as typeof fetch);
  try {
    const run = fixture.service.createRun({ executeResearch: false });
    assert.equal(run.status, "SCORED");
    assert.equal(calls, 0);
    assert.equal(fixture.service.getCase("CV-1001")?.status, "SCORED_ONLY");
    assert.ok((fixture.service.getCase("CV-1001")?.score || 0) >= 70);
  } finally {
    fixture.cleanup();
  }
});

test("一个A级来源或两个独立B级来源可确定性自动通过", async (context) => {
  const scenarios = [
    {
      name: "one-a",
      results: [{ title: "Ali Example official profile", url: "https://gov.example/ali", content: "Ali Example Senior Software Engineer Example Labs Dubai UAE" }],
    },
    {
      name: "two-b",
      results: [
        { title: "Ali Example profile", url: "https://company.example/ali", content: "Ali Example Senior Software Engineer Example Labs Dubai UAE" },
        { title: "Ali Example conference", url: "https://industry.test/ali", content: "Ali Example Senior Software Engineer Example Labs Dubai UAE" },
      ],
    },
  ];
  for (const scenario of scenarios) await context.test(scenario.name, async () => {
    const fixture = serviceFor([person()], (async () => jsonResponse({ results: scenario.results })) as typeof fetch);
    try {
      await runAndWait(fixture.service);
      const result = fixture.service.getCase("CV-1001");
      assert.equal(result?.status, "VERIFIED");
      assert.equal(result?.modelUsed, null);
      assert.ok((result?.acceptedEvidenceCount || 0) >= 1);
      assert.match(result?.synthesis.conclusion || "", /自动核验门槛/);
      assert.equal(result?.synthesis.publicFindings[0]?.certainty, "confirmed");
      assert.equal(result?.synthesis.publicFindings[0]?.evidenceIds[0], result?.evidence[0]?.sourceId);
    } finally {
      fixture.cleanup();
    }
  });
});

test("同名弱匹配不误判，只有多个独立冲突来源才进入人工复核", async () => {
  const single = person({ id: "CV-SINGLE", cvId: "CV-SINGLE", displayName: "Single Example" });
  const conflict = person({ id: "CV-CONFLICT", cvId: "CV-CONFLICT", displayName: "Conflict Example" });
  const fixture = serviceFor([single, conflict], (async (_url, init) => {
    const query = String(JSON.parse(String(init?.body || "{}")).query || "");
    const displayName = query.includes("Single Example") ? "Single Example" : "Conflict Example";
    const results = query.includes("Single Example")
      ? [{ title: `${displayName} directory`, url: "https://directory.example/one", content: displayName }]
      : [
        { title: `${displayName} directory`, url: "https://directory.example/one", content: displayName },
        { title: `${displayName} profile`, url: "https://profile.test/two", content: displayName },
      ];
    return jsonResponse({ results });
  }) as typeof fetch);
  try {
    await runAndWait(fixture.service);
    assert.equal(fixture.service.getCase("CV-SINGLE")?.status, "NO_RELIABLE_RESULT");
    assert.equal(fixture.service.getCase("CV-CONFLICT")?.status, "REVIEW_REQUIRED");
    const singleResult = fixture.service.getCase("CV-SINGLE");
    assert.equal(singleResult?.synthesis.publicFindings[0]?.certainty, "possible");
    assert.ok(singleResult?.synthesis.gaps.some((item) => item.includes("A级来源")));
    const conflictResult = fixture.service.getCase("CV-CONFLICT");
    assert.ok(conflictResult?.synthesis.gaps.some((item) => item.includes("候选来源只能作为线索")));
  } finally {
    fixture.cleanup();
  }
});

test("评分不使用国籍等敏感属性", () => {
  const baseline = person({ nationality: "Jordan" });
  const changed = person({ nationality: "Brazil" });
  assert.deepEqual(scorePerson(baseline, DEFAULT_RESEARCH_POLICY, fixedNow), scorePerson(changed, DEFAULT_RESEARCH_POLICY, fixedNow));
});

test("相同人物查询在7天缓存期内不重复调用Tavily", async () => {
  let calls = 0;
  const people = [person(), person({ id: "CV-1002", cvId: "CV-1002" })];
  const fixture = serviceFor(people, (async () => {
    calls += 1;
    return jsonResponse({ results: [] });
  }) as typeof fetch);
  try {
    await runAndWait(fixture.service);
    assert.equal(calls, 1);
    assert.equal(fixture.service.summary().searched, 2);
  } finally {
    fixture.cleanup();
  }
});

test("多批研究会跳过已完成人物并继续下一批", async () => {
  let calls = 0;
  const people = Array.from({ length: 35 }, (_, index) => person({ id: `CV-${index + 1}`, cvId: `CV-${index + 1}`, displayName: `Candidate ${index + 1}` }));
  const fixture = serviceFor(people, (async () => {
    calls += 1;
    return jsonResponse({ results: [] });
  }) as typeof fetch);
  try {
    const first = await runAndWait(fixture.service);
    const second = await runAndWait(fixture.service);
    assert.equal(first.scheduledTotal, 30);
    assert.equal(second.scheduledTotal, 5);
    assert.equal(calls, 35);
    assert.equal(fixture.service.summary().noReliableResult, 35);
  } finally {
    fixture.cleanup();
  }
});

test("重新评分不会清空已核验状态和证据", async () => {
  const fixture = serviceFor([person()], (async () => jsonResponse({ results: [{ title: "Ali Example official profile", url: "https://gov.example/ali", content: "Ali Example Senior Software Engineer Example Labs Dubai UAE" }] })) as typeof fetch);
  try {
    await runAndWait(fixture.service);
    const verified = fixture.service.getCase("CV-1001");
    assert.equal(verified?.status, "VERIFIED");
    assert.equal(verified?.evidenceCount, 1);
    fixture.service.createRun({ executeResearch: false });
    const rescored = fixture.service.getCase("CV-1001");
    assert.equal(rescored?.status, "VERIFIED");
    assert.equal(rescored?.evidenceCount, 1);
    assert.equal(rescored?.searchedAt, verified?.searchedAt);
  } finally {
    fixture.cleanup();
  }
});

test("Tavily 401、403或429会暂停且每次只请求一次", async (context) => {
  for (const status of [401, 403, 429]) await context.test(String(status), async () => {
    let calls = 0;
    const fixture = serviceFor([person()], (async () => {
      calls += 1;
      return jsonResponse({ error: "provider rejected" }, status);
    }) as typeof fetch);
    try {
      const run = await runAndWait(fixture.service);
      assert.equal(calls, 1);
      assert.equal(run.status, "PARTIAL");
      assert.match(run.error || "", new RegExp(String(status)));
      assert.equal(fixture.service.getCase("CV-1001")?.status, "WAITING_PROVIDER");
    } finally {
      fixture.cleanup();
    }
  });
});

test("DeepSeek不能用不存在或不足的证据ID自动通过", async () => {
  let deepseekCalls = 0;
  const fixture = serviceFor([person()], (async (url) => {
    if (String(url).includes("deepseek.test")) {
      deepseekCalls += 1;
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ status: "VERIFIED", identity_confidence: 0.99, accepted_evidence_ids: ["src_missing"], conflicts: [] }) } }],
      });
    }
    return jsonResponse({ results: [
      { title: "Ali Example directory", url: "https://directory.example/ali", content: "Ali Example" },
      { title: "Ali Example profile", url: "https://profile.test/ali", content: "Ali Example" },
    ] });
  }) as typeof fetch, { deepseek: true });
  try {
    await runAndWait(fixture.service);
    const result = fixture.service.getCase("CV-1001");
    assert.equal(deepseekCalls, 1);
    assert.equal(result?.status, "REVIEW_REQUIRED");
    assert.ok(result?.conflicts.some((item) => item.includes("不存在的证据ID")));
  } finally {
    fixture.cleanup();
  }
});
