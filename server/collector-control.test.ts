import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CollectorControlError, CollectorControlStore, type SearchSpec } from "./collector-control.ts";
import { config } from "./config.ts";
import { parseExcelCandidates } from "./import-service.ts";
import { verifyIncomingBatch } from "./collector-upload-verifier.ts";

function fixtureStore(): { store: CollectorControlStore; directory: string; version: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bayt-control-"));
  const store = new CollectorControlStore(path.join(directory, "control.db"));
  const request = store.requestCatalogSync();
  store.claimCatalogSync("local-ego-test");
  const catalog = store.completeCatalogSync(String(request.id), "local-ego-test", {
    filters: [
      {
        key: "last-updated",
        label: "Last updated",
        controlType: "single",
        supported: true,
        options: [
          { key: "six-months", label: "Within last 6 months" },
          { key: "one-year", label: "Within last year" },
        ],
      },
      {
        key: "experience",
        label: "Years of experience",
        controlType: "range",
        supported: true,
        options: [],
        valueKind: "number",
      },
      {
        key: "unstable-control",
        label: "Unstable control",
        controlType: "unsupported",
        supported: false,
        options: [],
        reason: "DOM identity is not stable",
      },
    ],
    sorts: [{ key: "last-updated", label: "Last updated" }],
    advanced: {
      keywordModes: [{ key: "any", label: "Any words" }, { key: "exact", label: "Exact order" }],
      nameSupported: true,
      locations: [{ key: "jordan", label: "Jordan", cities: [{ key: "jo,1,0", label: "Amman" }] },
        { key: "oman", label: "Oman", cities: [] }],
      jobRoles: [{ key: "engineering", label: "Engineering" }, { key: "teaching", label: "Teaching and Academics" }],
      industries: [{ key: "software", label: "Software Services" }, { key: "education", label: "Education" }],
      exclusionSupported: true, reliable: true,
    },
  });
  return { store, directory, version: catalog.version };
}

function spec(version: string, keyword = "Software Engineer"): SearchSpec {
  return {
    schemaVersion: 2, keyword, keywordMode: "any", name: null,
    filterSchemaVersion: version,
    filters: [], pastJobLocations: [], includeJobRoles: [], excludeJobRoles: [], includeIndustries: [], excludeIndustries: [], approximateLocationKeyword: null,
    sortKey: "last-updated",
  };
}

function cleanup(store: CollectorControlStore, directory: string): void {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

test("Filter目录严格校验键、选项、版本和暂不支持项", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const legacy = { keyword: "Software Engineer", filterSchemaVersion: version, filters: [{ key: "last-updated", optionKeys: ["six-months"] }], sortKey: "last-updated" };
    assert.equal(store.validateSearchSpec(legacy).filters[0].key, "last-updated");
    assert.throws(
      () => store.validateSearchSpec({ ...legacy, filters: [{ key: "last-updated", optionKeys: ["made-up"] }] }),
      (error: unknown) => error instanceof CollectorControlError && error.code === "INVALID_FILTER_SELECTION",
    );
    assert.throws(
      () => store.validateSearchSpec({ ...legacy, filters: [{ key: "unstable-control", optionKeys: ["x"] }] }),
      /暂不支持/,
    );
    assert.throws(
      () => store.validateSearchSpec({ ...legacy, filterSchemaVersion: "old-version" }),
      (error: unknown) => error instanceof CollectorControlError && error.code === "FILTER_SCHEMA_MISMATCH",
    );
  } finally {
    cleanup(store, directory);
  }
});

test("Filter目录领取响应丢失后同一Agent可以幂等恢复", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bayt-control-"));
  const store = new CollectorControlStore(path.join(directory, "control.db"));
  try {
    const request = store.requestCatalogSync();
    const first = store.claimCatalogSync("local-ego-test");
    const recovered = store.claimCatalogSync("local-ego-test");
    assert.equal(first?.id, request.id);
    assert.deepEqual(recovered, first);
    assert.equal(store.claimCatalogSync("another-agent"), null);
  } finally {
    cleanup(store, directory);
  }
});

test("多地点、职能行业与排除条件以新版快照保存，近似地点必须分开入队", () => {
  const { store, directory, version } = fixtureStore();
  try {
    assert.throws(() => store.validateSearchSpec({ ...spec(version, ""), name: "Example-Surname" }),
      (error: unknown) => error instanceof CollectorControlError && error.code === "INVALID_NAME_FILTER");
    const exact = store.validateSearchSpec({ ...spec(version), pastJobLocations: [
      { countryKey: "jordan", cityKey: "jo,1,0" }, { countryKey: "oman", cityKey: null }],
      includeJobRoles: ["engineering", "teaching"], excludeIndustries: ["education"] });
    assert.equal(exact.pastJobLocations?.length, 2);
    assert.deepEqual(exact.includeJobRoles, ["engineering", "teaching"]);
    assert.throws(() => store.validateSearchSpec({ ...exact, approximateLocationKeyword: "Example Region" }),
      (error: unknown) => error instanceof CollectorControlError && error.code === "APPROXIMATE_LOCATION_CONFLICT");
    const approximate = store.validateSearchSpec({ ...spec(version, "Example Region"), approximateLocationKeyword: "Example Region" });
    assert.equal(approximate.approximateLocationKeyword, "Example Region");
    assert.throws(() => store.validateSearchSpec({ ...spec(version), pastJobLocations: [{ countryKey: "oman", cityKey: "unknown-city" }] }),
      (error: unknown) => error instanceof CollectorControlError && error.code === "INVALID_LOCATION_SELECTION");
  } finally { cleanup(store, directory); }
});

test("重复发布按请求键去重且旧模板不交给本机Ego领取", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const input = { name: "多地点", searchSpec: spec(version), limits: { maxPages: 2 }, clientRequestId: "request-20260929-1" };
    const first = store.createJob(input);
    assert.equal(store.createJob(input).id, first.id);
    assert.throws(() => store.createJob({ ...input, name: "其他任务" }),
      (error: unknown) => error instanceof CollectorControlError && error.code === "CLIENT_REQUEST_CONFLICT");
    const legacy = store.createJob({ name: "旧版", searchSpec: { keyword: "old", filterSchemaVersion: version, filters: [], sortKey: null }, limits: { maxPages: 1 } });
    assert.equal(store.claimJob("windows-agent").waitReason, "local_ego_only");
    assert.equal(store.claimJob("local-ego-one").job?.id, first.id);
    assert.equal(store.getJob(legacy.id)?.status, "queued");
  } finally { cleanup(store, directory); }
});

test("高级目录过期或版本变化时不执行排队任务", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const job = store.createJob({ searchSpec: spec(version), limits: { maxPages: 1 } });
    store.db.prepare("UPDATE collector_filter_catalogs SET synchronized_at = '2020-01-01T00:00:00.000Z' WHERE version = ?").run(version);
    assert.equal(store.claimJob("local-ego-one").waitReason, "catalog_unavailable");
    assert.equal(store.getJob(job.id)?.status, "queued");
    assert.throws(() => store.validateSearchSpec(spec(version)),
      (error: unknown) => error instanceof CollectorControlError && error.code === "ADVANCED_CATALOG_UNAVAILABLE");
  } finally { cleanup(store, directory); }
});

test("恢复单个任务不解除全局安全暂停；必须管理员单独确认并留审计", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const job = store.createJob({ searchSpec: spec(version), limits: { maxPages: 1 } });
    const claim = store.claimJob("local-ego-one");
    store.safetyStop(job.id, "local-ego-one", claim.leaseToken!, { code: "BAYT_HTTP_403", message: "人工验证" });
    store.resumeJob(job.id);
    const queuedWhilePaused = store.createJob({ name: "等待队列", searchSpec: spec(version, "Second query"), limits: { maxPages: 1 } });
    assert.equal(queuedWhilePaused.status, "queued");
    assert.equal(store.getControlState().globallyPaused, true);
    assert.equal(store.claimJob("local-ego-one").waitReason, "global_safety_pause");
    store.acknowledgeGlobalPause("人工核验后管理员确认");
    assert.equal(store.getControlState().globallyPaused, false);
    const audit = store.db.prepare("SELECT event_type FROM collector_schedule_events WHERE event_type = 'global_pause_acknowledged'").get();
    assert.ok(audit);
  } finally { cleanup(store, directory); }
});

test("已有搜索检查点的旧任务不能重新排队或被当成新搜索领取", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const job = store.createJob({ searchSpec: spec(version), limits: { maxPages: 2 } });
    const claim = store.claimJob("local-ego-one");
    store.registerRun(job.id, "local-ego-one", claim.leaseToken!, "local-ego-existing-run", "search-existing");
    store.safetyStop(job.id, "local-ego-one", claim.leaseToken!, { code: "NEXT_PAGE_OVERLAP", message: "overlap" });
    assert.throws(() => store.resumeJob(job.id),
      (error: unknown) => error instanceof CollectorControlError && error.code === "JOB_CHECKPOINT_RESUME_REQUIRED");
    assert.equal(store.getJob(job.id)?.status, "safety_stopped");

    // Also defend a legacy queued row created before this guard was deployed.
    store.db.prepare("UPDATE collector_jobs SET status = 'queued', queue_position = 1 WHERE id = ?").run(job.id);
    store.acknowledgeGlobalPause("检查旧运行归属后继续其他任务");
    assert.equal(store.claimJob("local-ego-two").waitReason, "checkpoint_resume_required");
    assert.equal(store.getJob(job.id)?.status, "queued");
  } finally { cleanup(store, directory); }
});

test("任务保存模板不可变快照且FIFO队列可以调整", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const template = store.createTemplate({ name: "软件工程师", searchSpec: spec(version) });
    const first = store.createJob({ templateId: template.id, limits: { targetCount: 100 } });
    const second = store.createJob({ templateId: template.id, name: "第二任务", limits: { maxPages: 2 } });
    store.updateTemplate(template.id, { searchSpec: spec(version, "Backend Engineer") });
    assert.equal(store.getJob(first.id)?.searchSpec.keyword, "Software Engineer");
    assert.equal(store.getTemplate(template.id)?.searchSpec.keyword, "Backend Engineer");
    assert.equal(store.moveJob(second.id, "up").queuePosition, 1);
    assert.equal(store.getJob(first.id)?.queuePosition, 2);
    assert.equal(store.cancelJob(first.id).status, "cancelled");
  } finally {
    cleanup(store, directory);
  }
});

test("全局运行锁、120秒租约与过期后安全停止保证串行领取", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const template = store.createTemplate({ name: "软件工程师", searchSpec: spec(version) });
    const first = store.createJob({ templateId: template.id, limits: { maxPages: 2 } });
    store.createJob({ templateId: template.id, name: "排队任务", limits: { maxPages: 2 } });
    const claim = store.claimJob("local-ego-one", 120_000);
    assert.equal(claim.job?.id, first.id);
    assert.ok(claim.leaseToken);
    assert.equal(store.claimJob("local-ego-two").waitReason, "another_job_running");
    store.db.prepare("UPDATE collector_jobs SET lease_expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", first.id);
    assert.equal(store.recoverExpiredLeases(), 1);
    assert.equal(store.getJob(first.id)?.status, "safety_stopped");
    assert.equal(store.getControlState().globallyPaused, true);
    assert.equal(store.claimJob("local-ego-two").waitReason, "global_safety_pause");
  } finally {
    cleanup(store, directory);
  }
});

test("页级检查点校验XLS、PDF、CRC并阻止重复写入和当日超过500条", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const template = store.createTemplate({ name: "软件工程师", searchSpec: spec(version) });
    const job = store.createJob({ templateId: template.id, limits: { targetCount: 500 } });
    const claim = store.claimJob("local-ego-one");
    const token = claim.leaseToken!;
    const runId = "local-ego-checkpoint-test";
    store.registerRun(job.id, "local-ego-one", token, runId, "search-checkpoint");
    for (let page = 1; page <= 10; page += 1) {
      const digit = String(page % 10);
      store.checkpointPage(job.id, "local-ego-one", token, {
        page,
        selectedCount: 50,
        cvIdSetSha256: digit.repeat(64),
        excelSha256: "a".repeat(64),
        excelSizeBytes: 1000 + page,
        pdfSha256: "b".repeat(64),
        pdfSizeBytes: 2000 + page,
        pdfEntries: 50,
        zipCrcOk: true,
        remoteBatch: `/incoming/${runId}/batch-${String(page).padStart(4, "0")}`,
      });
    }
    assert.equal(store.completeJob(job.id, "local-ego-one", token).exportedCount, 500);
    const next = store.createJob({ templateId: template.id, limits: { maxPages: 1 } });
    assert.equal(store.claimJob("local-ego-two").waitReason, "daily_limit");
    assert.equal(store.getJob(next.id)?.status, "queued");
  } finally {
    cleanup(store, directory);
  }
});

test("新任务运行ID可信绑定，同一人物保留多个任务来源且重复扫描幂等", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const first = store.createJob({ name: "第一任务", searchSpec: spec(version), limits: { maxPages: 1 } });
    const second = store.createJob({ name: "第二任务", searchSpec: spec(version, "Other Engineer"), limits: { maxPages: 1 } });
    const firstLease = store.claimJob("local-ego-one").leaseToken!;
    store.registerRun(first.id, "local-ego-one", firstLease, "local-ego-first-run", "search-first");
    store.registerRun(first.id, "local-ego-one", firstLease, "local-ego-first-run", "search-first");
    assert.throws(() => store.registerRun(first.id, "local-ego-one", firstLease, "local-ego-first-run", "other-search"),
      (error: unknown) => error instanceof CollectorControlError && error.code === "RUN_JOB_LINK_INVALID");
    const firstPage = { jobId: first.id, runId: "local-ego-first-run", page: 1, importBatchId: "batch-first", cvIds: ["101", "102"] };
    store.recordDisplayedPeople(firstPage);
    store.recordDisplayedPeople(firstPage);
    assert.equal(store.peopleForJob(first.id).length, 2);
    assert.throws(() => store.recordDisplayedPeople({ ...firstPage, runId: "local-ego-other-run" }),
      (error: unknown) => error instanceof CollectorControlError && error.code === "PERSON_PROVENANCE_INVALID");
    store.checkpointPage(first.id, "local-ego-one", firstLease, { page: 1, selectedCount: 2,
      cvIdSetSha256: "c".repeat(64), excelSha256: "a".repeat(64), excelSizeBytes: 100,
      pdfSha256: "b".repeat(64), pdfSizeBytes: 200, pdfEntries: 2, zipCrcOk: true,
      remoteBatch: "/incoming/local-ego-first-run/batch-0001" });
    store.completeJob(first.id, "local-ego-one", firstLease);
    const secondLease = store.claimJob("local-ego-two").leaseToken!;
    store.registerRun(second.id, "local-ego-two", secondLease, "local-ego-second-run", "search-second");
    store.recordDisplayedPeople({ jobId: second.id, runId: "local-ego-second-run", page: 1,
      importBatchId: "batch-second", cvIds: ["101"] });
    assert.deepEqual(store.sourcesForPeople(["101", "999"]).get("101")?.map((item) => item.name).sort(), ["第一任务", "第二任务"]);
    assert.equal(store.sourcesForPeople(["999"]).size, 0);
    assert.throws(() => store.recordDisplayedPeople({ ...firstPage, cvIds: ["101"], importBatchId: "changed" }),
      (error: unknown) => error instanceof CollectorControlError && error.code === "PERSON_PROVENANCE_CONFLICT");
  } finally { cleanup(store, directory); }
});

test("24小时稳定性任务不受人数和每日500人限制且暂停后重新计时", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const template = store.createTemplate({ name: "软件工程师", searchSpec: spec(version) });
    assert.throws(
      () => store.createJob({ templateId: template.id, limits: { targetCount: 100, durationHours: 24 } }),
      (error: unknown) => error instanceof CollectorControlError && error.code === "INVALID_COLLECTION_LIMITS",
    );
    const original = store.createJob({ templateId: template.id, limits: { targetCount: 500 } });
    const originalClaim = store.claimJob("local-ego-one");
    store.pauseJob(original.id);
    store.acknowledgePause(original.id, "local-ego-one", originalClaim.leaseToken!);
    const changed = store.updatePausedJobLimits(original.id, { durationHours: 24 });
    assert.deepEqual(changed.limits, { durationHours: 24 });
    assert.equal(changed.startedAt, null);
    store.resumeJob(original.id);
    const claim = store.claimJob("local-ego-one");
    assert.equal(claim.job?.id, original.id);
    assert.ok(claim.job?.startedAt);
    assert.equal(store.getControlState().dailyLimit, null);
    const runId = "local-ego-duration-test";
    store.registerRun(original.id, "local-ego-one", claim.leaseToken!, runId, "search-duration");
    for (let page = 1; page <= 11; page += 1) {
      const digit = String(page % 10);
      store.checkpointPage(original.id, "local-ego-one", claim.leaseToken!, {
        page,
        selectedCount: 50,
        cvIdSetSha256: digit.repeat(64),
        excelSha256: "a".repeat(64),
        excelSizeBytes: 1000 + page,
        pdfSha256: "b".repeat(64),
        pdfSizeBytes: 2000 + page,
        pdfEntries: 50,
        zipCrcOk: true,
        remoteBatch: `/incoming/${runId}/batch-${String(page).padStart(4, "0")}`,
      });
    }
    assert.equal(store.getJob(original.id)?.exportedCount, 550);
  } finally {
    cleanup(store, directory);
  }
});

test("计划触发跳过同模板重复任务并保留事件", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const template = store.createTemplate({ name: "软件工程师", searchSpec: spec(version) });
    const schedule = store.createSchedule({
      name: "每日软件工程师",
      templateId: template.id,
      kind: "daily",
      localTime: "02:00",
      limits: { maxPages: 2 },
    });
    store.db.prepare("UPDATE collector_schedules SET next_run_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", schedule.id);
    assert.deepEqual(store.triggerDueSchedules(), { queued: 1, skipped: 0 });
    store.db.prepare("UPDATE collector_schedules SET next_run_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", schedule.id);
    assert.deepEqual(store.triggerDueSchedules(), { queued: 0, skipped: 1 });
    const events = store.db.prepare("SELECT event_type FROM collector_schedule_events ORDER BY created_at").all() as Array<{ event_type: string }>;
    assert.deepEqual(events.map((item) => item.event_type).sort(), ["queued", "skipped_duplicate"].sort());
  } finally {
    cleanup(store, directory);
  }
});

test("服务端独立核验SFTP落盘哈希、CV_ID映射、ZIP CRC且拒绝临时文件", { skip: !fs.existsSync(config.sampleExcelPath) || !fs.existsSync(config.sampleZipPath) }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bayt-incoming-"));
  try {
    const batch = path.join(directory, "run-test", "batch-0001");
    fs.mkdirSync(batch, { recursive: true });
    const excelPath = path.join(batch, "source.xls");
    const pdfPath = path.join(batch, "bayt-cvs.zip");
    fs.copyFileSync(config.sampleExcelPath, excelPath);
    fs.copyFileSync(config.sampleZipPath, pdfPath);
    const hash = (filePath: string) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    const candidates = parseExcelCandidates(excelPath);
    const cvIdSetSha256 = crypto.createHash("sha256").update(candidates.map((item) => item.cvId).sort().join("\n")).digest("hex");
    const input = {
      page: 1,
      selectedCount: candidates.length,
      cvIdSetSha256,
      excelSha256: hash(excelPath),
      excelSizeBytes: fs.statSync(excelPath).size,
      pdfSha256: hash(pdfPath),
      pdfSizeBytes: fs.statSync(pdfPath).size,
      pdfEntries: candidates.length,
      zipCrcOk: true,
      remoteBatch: "/remote/run-test/batch-0001",
    };
    fs.writeFileSync(path.join(batch, "manifest.json"), JSON.stringify({
      page: 1,
      selectedCount: candidates.length,
      cvIdSetSha256,
      files: { excel: { sha256: input.excelSha256 }, pdfArchive: { sha256: input.pdfSha256 } },
      verification: { exactMatch: true, zipCrcFailures: 0 },
    }));
    await verifyIncomingBatch(input, directory, "/remote");
    fs.writeFileSync(path.join(batch, "source.xls.part"), "partial");
    await assert.rejects(() => verifyIncomingBatch(input, directory, "/remote"), /临时文件/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
