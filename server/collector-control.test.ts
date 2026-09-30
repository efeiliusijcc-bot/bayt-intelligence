import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createCollectorAgentRouter, collectorRouteError } from "./collector-routes.ts";
import { CollectorControlError, CollectorControlStore, type SearchSpec } from "./collector-control.ts";
import { config } from "./config.ts";
import { parseExcelCandidates } from "./import-service.ts";
import { verifyIncomingBatch } from "./collector-upload-verifier.ts";
import { scheduleRecovery } from "../collector/src/recovery.ts";

test("限流等待租约过期可凭原凭据恢复；不释放给其他任务、不解除安全暂停", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const first = store.createJob({ name: "recovery", searchSpec: spec(version), limits: { targetCount: 100 } });
    const second = store.createJob({ name: "next", searchSpec: spec(version), limits: { targetCount: 100 } });
    const claim = store.claimJob("local-ego-test");
    assert.equal(claim.job?.id, first.id);
    const recovery = scheduleRecovery(null, "rate_limit", "start_search", "episode-test");
    store.heartbeatJob(first.id, "local-ego-test", claim.leaseToken!, { recovery, noDownloadIntent: true }, -1000);
    assert.equal(store.recoverExpiredLeases(), 0);
    assert.equal(store.getControlState().globallyPaused, false);
    assert.equal(store.claimJob("local-ego-test").job, null);
    const nextToken = crypto.randomBytes(32).toString("base64url");
    assert.throws(() => store.reclaimRecovery(first.id, "local-ego-other", claim.leaseToken!, nextToken, recovery.id), /身份/);
    assert.throws(() => store.reclaimRecovery(first.id, "local-ego-test", "wrong", nextToken, recovery.id), /身份/);
    store.db.prepare("UPDATE collector_control_state SET globally_paused = 1 WHERE singleton = 1").run();
    assert.throws(() => store.reclaimRecovery(first.id, "local-ego-test", claim.leaseToken!, nextToken, recovery.id));
    assert.equal(store.getControlState().globallyPaused, true);
    store.db.prepare("UPDATE collector_control_state SET globally_paused = 0 WHERE singleton = 1").run();
    store.reclaimRecovery(first.id, "local-ego-test", claim.leaseToken!, nextToken, recovery.id);
    store.reclaimRecovery(first.id, "local-ego-test", claim.leaseToken!, nextToken, recovery.id); // Lost response is idempotent.
    assert.equal(store.getJob(first.id)?.recovery?.nextCheckAt, recovery.nextCheckAt);
    assert.throws(() => store.heartbeatJob(first.id, "local-ego-test", nextToken, { recovery, noDownloadIntent: false }), /下载意图/);
    store.cancelJob(first.id);
    assert.throws(() => store.reclaimRecovery(first.id, "local-ego-test", nextToken, nextToken, recovery.id), /身份/);
    assert.equal(store.claimJob("local-ego-test").job?.id, second.id);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("等待中暂停仍生效，正常采集租约过期继续要求人工复核", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const job = store.createJob({ name: "recovery", searchSpec: spec(version), limits: { targetCount: 100 } });
    const claim = store.claimJob("local-ego-test");
    const recovery = scheduleRecovery(null, "rate_limit", "start_search", "episode-test");
    store.heartbeatJob(job.id, "local-ego-test", claim.leaseToken!, { recovery, noDownloadIntent: true });
    store.pauseJob(job.id); store.acknowledgePause(job.id, "local-ego-test", claim.leaseToken!);
    assert.equal(store.getJob(job.id)?.status, "paused");
    store.cancelJob(job.id);
    store.createJob({ name: "ordinary", searchSpec: spec(version), limits: { targetCount: 100 } });
    const next = store.claimJob("local-ego-test", -1000);
    assert.equal(store.recoverExpiredLeases(), 1);
    assert.equal(store.getJob(next.job!.id)?.status, "safety_stopped");
    assert.equal(store.getControlState().globallyPaused, true);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

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
      locations: [{ key: "syria", label: "Syria", cities: [{ key: "sy,12,0", label: "Jisr ash Shughur" }] },
        { key: "afghanistan", label: "Afghanistan", cities: [] }],
      jobRoles: [{ key: "logistics", label: "Logistics and Transportation" }, { key: "teaching", label: "Teaching and Academics" }],
      industries: [{ key: "nonprofit", label: "Non-profit Organization" }, { key: "religion", label: "Religious Institution & Place of Worship" }],
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

const localEvidence = (page = 1) => ({ page, selectedCount: 2, cvIdSetSha256: "c".repeat(64),
  excelSha256: "a".repeat(64), excelSizeBytes: 100, pdfSha256: "b".repeat(64), pdfSizeBytes: 200,
  pdfEntries: 2, zipCrcOk: true });

test("同条件重建搜索保留原页、运行和起始时间；提交后崩溃可幂等恢复", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const job = store.createJob({ searchSpec: spec(version), limits: { targetCount: 150 } });
    const agent = "local-ego-test", runId = "local-ego-rebuild-test";
    const claim = store.claimJob(agent), lease = claim.leaseToken!;
    store.registerRun(job.id, agent, lease, runId, "search-old");
    const page = { ...localEvidence(), remoteBatch: `/incoming/${runId}/batch-0001` };
    store.checkpointPage(job.id, agent, lease, page);
    store.reportLocalPages(job.id, agent, lease, { runId, pages: [localEvidence()] });
    store.safetyStop(job.id, agent, lease, { code: "CHECKPOINT_RESUME_BLOCKED", message: "旧搜索无法翻页" });
    const requested = store.requestSearchRebuild(job.id);
    assert.equal(store.requestSearchRebuild(job.id).rebuildRequest?.id, requested.rebuildRequest?.id);
    store.resumeJob(job.id);
    const resumed = store.claimJob(agent), newLease = resumed.leaseToken!;
    const proof = { requestId: requested.rebuildRequest!.id, runId, oldSearchId: "search-old", newSearchId: "search-new",
      cvIdSetSha256: page.cvIdSetSha256, selectedCount: 2, noDownloadIntent: true, searchSpec: job.searchSpec };
    for (const change of [{ cvIdSetSha256: "d".repeat(64) }, { runId: "local-ego-other" },
      { searchSpec: spec(version, "Other") }, { noDownloadIntent: false }, { newSearchId: "search-old" }])
      assert.throws(() => store.applySearchRebuild(job.id, agent, newLease, { ...proof, ...change }), /不一致/);
    store.db.prepare("UPDATE collector_control_state SET globally_paused = 1 WHERE singleton = 1").run();
    assert.throws(() => store.applySearchRebuild(job.id, agent, newLease, proof), /不一致/);
    assert.equal(store.getJob(job.id)?.searchId, "search-old");
    store.db.prepare("UPDATE collector_control_state SET globally_paused = 0 WHERE singleton = 1").run();
    store.applySearchRebuild(job.id, agent, newLease, proof);
    const result = store.applySearchRebuild(job.id, agent, newLease, proof);
    assert.equal(result.searchId, "search-new");
    assert.equal(result.startedAt, claim.job!.startedAt);
    assert.deepEqual(result.limits, job.limits);
    assert.equal(result.completedPages, 1); assert.equal(result.collectedPages, 1);
    assert.equal(result.exportedCount, 2);
    assert.equal(store.jobForRun(runId), job.id);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM collector_search_rebuilds").get()!.n, 1);
    assert.throws(() => store.applySearchRebuild(job.id, agent, newLease, { ...proof, newSearchId: "search-third" }), /冲突/);
    // An independent uploader can still acknowledge the original immutable page.
    assert.equal(store.checkpointPage(job.id, agent, newLease, page).completedPages, 1);
  } finally { cleanup(store, directory); }
});

test("HTTP上传在采集租约释放后继续，108实际复核文件且重复回执幂等", { skip: !fs.existsSync(config.sampleExcelPath) || !fs.existsSync(config.sampleZipPath) }, async () => {
  const { store, directory, version } = fixtureStore();
  const token = crypto.randomBytes(32).toString("hex"), uploadToken = crypto.randomBytes(32).toString("base64url");
  const incoming = path.join(directory, "incoming"), runId = "local-ego-http-test";
  const app = express(); app.use(express.json());
  app.use(createCollectorAgentRouter(store, token, { localRoot: incoming, remoteRoot: "/incoming" }));
  app.use(collectorRouteError);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address() as { port: number };
    const call = (route: string, body: unknown, auth = token, lease?: string) => fetch(`http://127.0.0.1:${address.port}${route}`, {
      method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", ...(lease ? { "X-Collector-Lease": lease } : {}) }, body: JSON.stringify(body) });
    const job = store.createJob({ searchSpec: spec(version), limits: { maxPages: 1 } });
    const claim = store.claimJob("local-ego-http");
    store.registerRun(job.id, "local-ego-http", claim.leaseToken!, runId, "search-http", uploadToken);
    const dir = path.join(incoming, runId, "batch-0001"); fs.mkdirSync(dir, { recursive: true });
    const excel = path.join(dir, "source.xls"), zip = path.join(dir, "bayt-cvs.zip");
    fs.copyFileSync(config.sampleExcelPath, excel); fs.copyFileSync(config.sampleZipPath, zip);
    const ids = parseExcelCandidates(excel).map(item => item.cvId);
    const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const evidence = { ...localEvidence(), selectedCount: ids.length, pdfEntries: ids.length,
      cvIdSetSha256: crypto.createHash("sha256").update(ids.sort().join("\n")).digest("hex"),
      excelSha256: sha(excel), excelSizeBytes: fs.statSync(excel).size, pdfSha256: sha(zip), pdfSizeBytes: fs.statSync(zip).size };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 2, queueJobId: job.id, runId,
      page: 1, selectedCount: ids.length, cvIdSetSha256: evidence.cvIdSetSha256,
      files: { excel: { sha256: evidence.excelSha256 }, pdfArchive: { sha256: evidence.pdfSha256 } }, verification: { exactMatch: true, zipCrcFailures: 0 } }));
    const body = { agentId: "local-ego-http", runId, uploadToken, pages: [evidence], cooldownUntil: null };
    assert.equal((await call(`/jobs/${job.id}/collection-complete`, body, "wrong", claim.leaseToken)).status, 401);
    assert.equal((await call(`/jobs/${job.id}/collection-complete`, body, token, claim.leaseToken)).status, 200);
    assert.equal((await call(`/jobs/${job.id}/collection-complete`, body, token, claim.leaseToken)).status, 200);
    const upload = { ...body, ...evidence, remoteBatch: `/incoming/${runId}/batch-0001` };
    assert.equal((await call(`/jobs/${job.id}/uploads`, { ...upload, uploadToken: "wrong" })).status, 403);
    assert.equal((await call(`/jobs/${job.id}/uploads`, upload)).status, 200);
    assert.equal((await call(`/jobs/${job.id}/uploads`, upload)).status, 200);
    assert.equal(store.getJob(job.id)?.uploadedCount, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); cleanup(store, directory); }
});

test("三个任务串行接力，完成回执丢失和重启不重复采集，上传不占采集租约", () => {
  const fixture = fixtureStore();
  let store = fixture.store;
  try {
    const jobs = [1,2,3].map(n => store.createJob({ name: `接力${n}`, searchSpec: spec(fixture.version, `query${n}`), limits: { maxPages: 1 } }));
    for (const [index, job] of jobs.entries()) {
      const claim = store.claimJob("local-ego-test");
      assert.equal(claim.job?.id, job.id);
      assert.equal(store.claimJob("local-ego-other").waitReason, "another_job_running");
      const runId = `local-ego-serial-${index}`, uploadToken = crypto.randomBytes(32).toString("base64url");
      store.registerRun(job.id, "local-ego-test", claim.leaseToken!, runId, `search-${index}`, uploadToken);
      const input = { runId, uploadToken, pages: [localEvidence()], cooldownUntil: null };
      store.reportLocalPages(job.id, "local-ego-test", claim.leaseToken!, input);
      const finished = store.finishCollection(job.id, "local-ego-test", claim.leaseToken!, input);
      assert.equal(finished.status, "completed");
      assert.equal(finished.uploadedCount, 0);
      assert.equal(finished.collectedCount, 2);
      store.close(); store = new CollectorControlStore(path.join(fixture.directory, "control.db"));
      // Simulate commit success followed by a lost HTTP response and process restart.
      assert.equal(store.finishCollection(job.id, "local-ego-test", claim.leaseToken!, input).status, "completed");
      assert.throws(() => store.finishCollection(job.id, "local-ego-test", claim.leaseToken!, { ...input, pages: [localEvidence(), localEvidence(2)] }), /回执内容不一致/);
      const upload = { runId, uploadToken, ...localEvidence(), remoteBatch: `/incoming/${runId}/batch-0001` };
      assert.throws(() => store.checkpointUpload(job.id, "local-ego-test", { ...upload, uploadToken: "bad" }), /认证失败/);
      assert.throws(() => store.checkpointUpload(job.id, "local-ego-test", { ...upload, excelSha256: "d".repeat(64) }), /冲突/);
      store.checkpointUpload(job.id, "local-ego-test", upload);
      store.checkpointUpload(job.id, "local-ego-test", upload);
      assert.equal(store.getJob(job.id)?.uploadedCount, 1);
      assert.equal(store.dailyExportedCount(), (index + 1) * 2);
      const row = store.db.prepare("SELECT upload_token_hash FROM collector_job_runs WHERE run_id = ?").get(runId);
      assert.notEqual(row?.upload_token_hash, uploadToken);
    }
    assert.equal(store.claimJob("local-ego-test").waitReason, "queue_empty");
  } finally { cleanup(store, fixture.directory); }
});

test("完成后仍保留浏览器冷却间隔；暂停续跑不重置范围和截止起点", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const job = store.createJob({ searchSpec: spec(version), limits: { maxPages: 1 } });
    const claim = store.claimJob("local-ego-test");
    const uploadToken = "u".repeat(43), runId = "local-ego-cooldown";
    store.registerRun(job.id, "local-ego-test", claim.leaseToken!, runId, "search-cooldown", uploadToken);
    store.pauseJob(job.id); store.acknowledgePause(job.id, "local-ego-test", claim.leaseToken!);
    assert.throws(() => store.updatePausedJobLimits(job.id, { durationHours: 24 }), /原运行范围/);
    const resumed = store.resumeJob(job.id);
    assert.equal(resumed.resumeMode, "checkpoint");
    assert.equal(resumed.startedAt, claim.job?.startedAt);
    const lease = store.claimJob("local-ego-test");
    assert.equal(lease.resumeRunId, runId);
    const cooldownUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    store.finishCollection(job.id, "local-ego-test", lease.leaseToken!, { runId, uploadToken, pages: [localEvidence()], cooldownUntil });
    store.createJob({ searchSpec: spec(version, "next"), limits: { maxPages: 1 } });
    assert.equal(store.claimJob("local-ego-test").waitReason, "browser_cooldown");
    assert.equal(store.getControlState().browserNextActionAt, cooldownUntil);
  } finally { cleanup(store, directory); }
});

test("官网验证必须显式请求，确认幂等且不解除已有全局暂停", () => {
  const { store, directory } = fixtureStore();
  try {
    store.heartbeatAgent({ agentId: "local-ego-test", loginState: "verification_required", verificationId: "marker-one" });
    store.db.prepare("UPDATE collector_control_state SET globally_paused = 1 WHERE singleton = 1").run();
    assert.equal(store.claimVerification("local-ego-test", "marker-one"), null);
    assert.throws(() => store.requestVerification("local-ego-test", "different-marker"), /状态已变化/);
    const req = store.requestVerification("local-ego-test", "marker-one");
    assert.equal(store.requestVerification("local-ego-test", "marker-one").id, req.id);
    assert.equal(store.claimVerification("local-ego-test", "marker-one")?.interrupted, false);
    assert.equal(store.claimVerification("local-ego-test", "marker-one")?.interrupted, true);
    store.completeVerification("local-ego-test", String(req.id), "marker-one", true);
    store.completeVerification("local-ego-test", String(req.id), "marker-one", true);
    assert.equal(store.getControlState().globallyPaused, true);
  } finally { cleanup(store, directory); }
});

test("任务局部表单错误释放队列，下载不确定仍停止全局", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const first = store.createJob({ searchSpec: spec(version), limits: { maxPages: 1 } });
    const second = store.createJob({ searchSpec: spec(version, "next"), limits: { maxPages: 1 } });
    const a = store.claimJob("local-ego-test");
    store.safetyStop(first.id, "local-ego-test", a.leaseToken!, { code: "SEARCH_FORM_UNVERIFIED", message: "本任务控件不可用" });
    assert.equal(store.getControlState().globallyPaused, false);
    const b = store.claimJob("local-ego-test");
    assert.equal(b.job?.id, second.id);
    store.safetyStop(second.id, "local-ego-test", b.leaseToken!, { code: "UNCERTAIN_DOWNLOAD_RESULT", message: "下载结果不明" });
    assert.equal(store.getControlState().globallyPaused, true);
  } finally { cleanup(store, directory); }
});

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
    assert.throws(() => store.validateSearchSpec({ ...spec(version, ""), name: "al-Turkistani" }),
      (error: unknown) => error instanceof CollectorControlError && error.code === "INVALID_NAME_FILTER");
    const exact = store.validateSearchSpec({ ...spec(version), pastJobLocations: [
      { countryKey: "syria", cityKey: "sy,12,0" }, { countryKey: "afghanistan", cityKey: null }],
      includeJobRoles: ["logistics", "teaching"], excludeIndustries: ["religion"] });
    assert.equal(exact.pastJobLocations?.length, 2);
    assert.deepEqual(exact.includeJobRoles, ["logistics", "teaching"]);
    assert.throws(() => store.validateSearchSpec({ ...exact, approximateLocationKeyword: "Badakhshan" }),
      (error: unknown) => error instanceof CollectorControlError && error.code === "APPROXIMATE_LOCATION_CONFLICT");
    const approximate = store.validateSearchSpec({ ...spec(version, "Badakhshan"), approximateLocationKeyword: "Badakhshan" });
    assert.equal(approximate.approximateLocationKeyword, "Badakhshan");
    assert.throws(() => store.validateSearchSpec({ ...spec(version), pastJobLocations: [{ countryKey: "afghanistan", cityKey: "badakhshan" }] }),
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
    assert.equal(store.claimJob("windows-154").waitReason, "local_ego_only");
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

test("检查点任务只允许原运行ID续跑，不能被当成新搜索领取", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const job = store.createJob({ searchSpec: spec(version), limits: { maxPages: 2 } });
    const claim = store.claimJob("local-ego-one");
    store.registerRun(job.id, "local-ego-one", claim.leaseToken!, "local-ego-existing-run", "search-existing");
    store.safetyStop(job.id, "local-ego-one", claim.leaseToken!, { code: "NEXT_PAGE_OVERLAP", message: "overlap" });
    assert.equal(store.resumeJob(job.id).status, "queued");
    assert.equal(store.getControlState().globallyPaused, true);
    store.acknowledgeGlobalPause("检查旧运行归属后继续其他任务");
    const resumed = store.claimJob("local-ego-two");
    assert.equal(resumed.job?.id, job.id);
    assert.equal(resumed.resumeRunId, "local-ego-existing-run");
    assert.equal(resumed.job?.searchId, "search-existing");
    assert.deepEqual(store.agentJobState(job.id, "local-ego-two"), {
      id: job.id, status: "running", searchId: "search-existing", completedPages: 0,
      collectedPages: 0, collectionFinishedAt: null,
    });
    assert.throws(() => store.agentJobState(job.id, "local-ego-other"),
      (error: unknown) => error instanceof CollectorControlError && error.code === "AGENT_JOB_NOT_FOUND");
  } finally { cleanup(store, directory); }
});

test("不支持的旧检查点不能阻塞后续正常任务", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const old = store.createJob({ searchSpec: spec(version), limits: { maxPages: 2 } });
    const claim = store.claimJob("local-ego-one");
    store.registerRun(old.id, "local-ego-one", claim.leaseToken!, "local-ego-old-run", "search-old");
    store.safetyStop(old.id, "local-ego-one", claim.leaseToken!, { code: "UNCERTAIN_DOWNLOAD_RESULT", message: "uncertain" });
    assert.throws(() => store.resumeJob(old.id),
      (error: unknown) => error instanceof CollectorControlError && error.code === "JOB_CHECKPOINT_RESUME_REQUIRED");
    // Simulate a queued row written by an older release: it must be skipped,
    // not become a new search or hold the entire FIFO queue hostage.
    store.db.prepare("UPDATE collector_jobs SET status = 'queued', queue_position = 1 WHERE id = ?").run(old.id);
    const next = store.createJob({ searchSpec: spec(version, "Next"), limits: { maxPages: 1 } });
    store.acknowledgeGlobalPause("只允许后续安全任务执行");
    assert.equal(store.claimJob("local-ego-two").job?.id, next.id);
  } finally { cleanup(store, directory); }
});

test("搜索表单错误只能作为原检查点的核验续跑请求", () => {
  const { store, directory, version } = fixtureStore();
  try {
    const job = store.createJob({ searchSpec: spec(version), limits: { maxPages: 2 } });
    const claim = store.claimJob("local-ego-one");
    store.registerRun(job.id, "local-ego-one", claim.leaseToken!, "local-ego-form-run", "search-form");
    store.safetyStop(job.id, "local-ego-one", claim.leaseToken!, { code: "SEARCH_FORM_UNVERIFIED", message: "原页需核验" });
    store.resumeJob(job.id);
    assert.equal(store.getControlState().globallyPaused, false);
    const resumed = store.claimJob("local-ego-one");
    assert.equal(resumed.resumeRunId, "local-ego-form-run");
    assert.equal(resumed.job?.searchId, "search-form");
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

test("108独立核验SFTP落盘哈希、CV_ID映射、ZIP CRC且拒绝临时文件", { skip: !fs.existsSync(config.sampleExcelPath) || !fs.existsSync(config.sampleZipPath) }, async () => {
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
