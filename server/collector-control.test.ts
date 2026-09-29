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
  store.claimCatalogSync("windows-agent");
  const catalog = store.completeCatalogSync(String(request.id), "windows-agent", {
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
  });
  return { store, directory, version: catalog.version };
}

function spec(version: string, keyword = "Software Engineer"): SearchSpec {
  return {
    keyword,
    filterSchemaVersion: version,
    filters: [{ key: "last-updated", optionKeys: ["six-months"] }],
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
    assert.equal(store.validateSearchSpec(spec(version)).filters[0].key, "last-updated");
    assert.throws(
      () => store.validateSearchSpec({ ...spec(version), filters: [{ key: "last-updated", optionKeys: ["made-up"] }] }),
      (error: unknown) => error instanceof CollectorControlError && error.code === "INVALID_FILTER_SELECTION",
    );
    assert.throws(
      () => store.validateSearchSpec({ ...spec(version), filters: [{ key: "unstable-control", optionKeys: ["x"] }] }),
      /暂不支持/,
    );
    assert.throws(
      () => store.validateSearchSpec({ ...spec(version), filterSchemaVersion: "old-version" }),
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
    const first = store.claimCatalogSync("windows-agent");
    const recovered = store.claimCatalogSync("windows-agent");
    assert.equal(first?.id, request.id);
    assert.deepEqual(recovered, first);
    assert.equal(store.claimCatalogSync("another-agent"), null);
  } finally {
    cleanup(store, directory);
  }
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

test("全局运行锁、120秒租约与过期恢复保证串行领取", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const template = store.createTemplate({ name: "软件工程师", searchSpec: spec(version) });
    const first = store.createJob({ templateId: template.id, limits: { maxPages: 2 } });
    store.createJob({ templateId: template.id, name: "排队任务", limits: { maxPages: 2 } });
    const claim = store.claimJob("agent-one", 120_000);
    assert.equal(claim.job?.id, first.id);
    assert.ok(claim.leaseToken);
    assert.equal(store.claimJob("agent-two").waitReason, "another_job_running");
    store.db.prepare("UPDATE collector_jobs SET lease_expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", first.id);
    assert.equal(store.recoverExpiredLeases(), 1);
    assert.equal(store.getJob(first.id)?.status, "queued");
    assert.equal(store.claimJob("agent-two").job?.status, "running");
  } finally {
    cleanup(store, directory);
  }
});

test("页级检查点校验XLS、PDF、CRC并阻止重复写入和当日超过500条", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const template = store.createTemplate({ name: "软件工程师", searchSpec: spec(version) });
    const job = store.createJob({ templateId: template.id, limits: { targetCount: 500 } });
    const claim = store.claimJob("agent-one");
    const token = claim.leaseToken!;
    for (let page = 1; page <= 10; page += 1) {
      const digit = String(page % 10);
      store.checkpointPage(job.id, "agent-one", token, {
        page,
        selectedCount: 50,
        cvIdSetSha256: digit.repeat(64),
        excelSha256: "a".repeat(64),
        excelSizeBytes: 1000 + page,
        pdfSha256: "b".repeat(64),
        pdfSizeBytes: 2000 + page,
        pdfEntries: 50,
        zipCrcOk: true,
        remoteBatch: `/incoming/${job.id}/batch-${String(page).padStart(4, "0")}`,
      });
    }
    assert.equal(store.completeJob(job.id, "agent-one", token).exportedCount, 500);
    const next = store.createJob({ templateId: template.id, limits: { maxPages: 1 } });
    assert.equal(store.claimJob("agent-two").waitReason, "daily_limit");
    assert.equal(store.getJob(next.id)?.status, "queued");
  } finally {
    cleanup(store, directory);
  }
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
    const originalClaim = store.claimJob("agent-one");
    store.pauseJob(original.id);
    store.acknowledgePause(original.id, "agent-one", originalClaim.leaseToken!);
    const changed = store.updatePausedJobLimits(original.id, { durationHours: 24 });
    assert.deepEqual(changed.limits, { durationHours: 24 });
    assert.equal(changed.startedAt, null);
    store.resumeJob(original.id);
    const claim = store.claimJob("agent-one");
    assert.equal(claim.job?.id, original.id);
    assert.ok(claim.job?.startedAt);
    assert.equal(store.getControlState().dailyLimit, null);
    for (let page = 1; page <= 11; page += 1) {
      const digit = String(page % 10);
      store.checkpointPage(original.id, "agent-one", claim.leaseToken!, {
        page,
        selectedCount: 50,
        cvIdSetSha256: digit.repeat(64),
        excelSha256: "a".repeat(64),
        excelSizeBytes: 1000 + page,
        pdfSha256: "b".repeat(64),
        pdfSizeBytes: 2000 + page,
        pdfEntries: 50,
        zipCrcOk: true,
        remoteBatch: `/incoming/${original.id}/batch-${String(page).padStart(4, "0")}`,
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
