import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IncomingConsumer } from "./incoming-consumer.ts";
import type { ImportService } from "./import-service.ts";
import type { PeopleRepository } from "./people-repository.ts";
import type { CollectorControlStore } from "./collector-control.ts";

const runId = "local-ego-unit-test";

async function fixture(queueJobId: string | null = null) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "bayt-incoming-test-"));
  const incoming = path.join(root, "incoming");
  const batchDir = path.join(incoming, runId, "batch-0002");
  await fsp.mkdir(batchDir, { recursive: true });
  const manifest = {
    ...(queueJobId ? { schemaVersion: 2, queueJobId } : {}),
    runId, page: 2, selectedCount: 2, cvIdSetSha256: crypto.createHash("sha256").update("1\n2").digest("hex"),
    files: { excel: { name: "resumes.xls", sha256: crypto.createHash("sha256").update("xls").digest("hex") },
      pdfArchive: { name: "resumes.zip", sha256: crypto.createHash("sha256").update("zip").digest("hex") } },
    verification: { pdfEntries: 2 },
  };
  await fsp.writeFile(path.join(batchDir, "source.xls"), "xls");
  await fsp.writeFile(path.join(batchDir, "bayt-cvs.zip"), "zip");
  await fsp.writeFile(path.join(batchDir, "manifest.json"), JSON.stringify(manifest));
  const pdfPath = path.join(root, "imported.pdf");
  await fsp.writeFile(pdfPath, "%PDF-1.4");
  const batches = new Map<string, any>();
  let preflights = 0;
  let commits = 0;
  const imports = {
    get: (id: string) => batches.get(id) || null,
    preflight: async (_xls: string, _zip: string, _name: string, _source: string, id: string) => {
      preflights++;
      const batch = { id, source: "LOCAL_COLLECTOR", status: "READY", excelPersonCount: 2, matchedCount: 2,
        missingAttachmentCount: 0, extraAttachmentCount: 0, issues: [], matches: [{ cvId: "1" }, { cvId: "2" }] };
      batches.set(id, batch); return batch;
    },
    commit: async (id: string) => { commits++; const batch = { ...batches.get(id), status: "COMPLETED" }; batches.set(id, batch); return batch; },
  } as unknown as ImportService;
  const people = { get: (id: string) => ["1", "2"].includes(id) ?
    { attachments: [{ kind: "bayt_pdf", status: "downloaded" }] } : null,
    list: () => ["1", "2"].map((cvId) => ({ cvId, attachments: [{ kind: "bayt_pdf", status: "downloaded" }] })),
    getAttachment: (id: string) => ["1:bayt_pdf", "2:bayt_pdf"].includes(id) ? { path: pdfPath } : null } as unknown as PeopleRepository;
  const links: Array<{ jobId: string; cvIds: string[] }> = [];
  const control = { jobForRun: () => queueJobId,
    recordDisplayedPeople: (input: { jobId: string; cvIds: string[] }) => links.push({ jobId: input.jobId, cvIds: input.cvIds }) } as unknown as CollectorControlStore;
  const consumer = new IncomingConsumer(imports, people, incoming, path.join(root, "runtime"), "/remote/incoming",
    async () => {}, queueJobId ? control : null);
  return { root, batchDir, consumer, batches, links, counts: () => ({ preflights, commits }) };
}

test("新版整页入库后记录任务人物关系，重复扫描不重复导入", async () => {
  const data = await fixture("job-source-one");
  try {
    await data.consumer.scan();
    await data.consumer.scan();
    assert.equal((await data.consumer.list())[0].status, "displayed");
    assert.deepEqual(data.counts(), { preflights: 1, commits: 1 });
    assert.deepEqual(data.links[0], { jobId: "job-source-one", cvIds: ["1", "2"] });
  } finally { await fsp.rm(data.root, { recursive: true, force: true }); }
});

test("新版manifest任务ID与登记运行不符时阻断入库", async () => {
  const data = await fixture("job-source-one");
  try {
    const file = path.join(data.batchDir, "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(file, "utf8"));
    manifest.queueJobId = "another-job";
    await fsp.writeFile(file, JSON.stringify(manifest));
    await data.consumer.scan();
    assert.equal((await data.consumer.list())[0].reason, "RUN_JOB_LINK_MISMATCH");
    assert.deepEqual(data.counts(), { preflights: 0, commits: 0 });
  } finally { await fsp.rm(data.root, { recursive: true, force: true }); }
});

test("incoming page is imported once, and repeated scans use the receipt", async () => {
  const data = await fixture();
  try {
    await data.consumer.scan();
    await data.consumer.scan();
    const items = await data.consumer.list();
    assert.equal(items[0].status, "displayed");
    assert.equal(items[0].count, 2);
    assert.deepEqual(data.counts(), { preflights: 1, commits: 1 });
  } finally { await fsp.rm(data.root, { recursive: true, force: true }); }
});

test("changing content at the same run/page blocks instead of re-importing", async () => {
  const data = await fixture();
  try {
    await data.consumer.scan();
    const file = path.join(data.batchDir, "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(file, "utf8"));
    manifest.files.excel.sha256 = "changed";
    await fsp.writeFile(file, JSON.stringify(manifest));
    await data.consumer.scan();
    assert.equal((await data.consumer.list())[0].status, "blocked");
    assert.equal((await data.consumer.list())[0].reason, "REMOTE_CONTENT_CONFLICT");
    assert.deepEqual(data.counts(), { preflights: 1, commits: 1 });
  } finally { await fsp.rm(data.root, { recursive: true, force: true }); }
});

test("displayed page rechecks file hashes and blocks changed bytes", async () => {
  const data = await fixture("job-source-one");
  try {
    await data.consumer.scan();
    await fsp.writeFile(path.join(data.batchDir, "source.xls"), "tampered");
    await data.consumer.scan();
    assert.equal((await data.consumer.list())[0].status, "blocked");
    assert.equal((await data.consumer.list())[0].reason, "DISPLAYED_FILE_HASH_MISMATCH");
    assert.deepEqual(data.counts(), { preflights: 1, commits: 1 });
  } finally { await fsp.rm(data.root, { recursive: true, force: true }); }
});

test("unfinished .part waits and imports only after transfer finishes", async () => {
  const data = await fixture();
  try {
    await fsp.writeFile(path.join(data.batchDir, "bayt-cvs.zip.part"), "unfinished");
    await data.consumer.scan();
    assert.equal((await data.consumer.list())[0].status, "pending");
    await fsp.unlink(path.join(data.batchDir, "bayt-cvs.zip.part"));
    await data.consumer.scan();
    assert.equal((await data.consumer.list())[0].status, "displayed");
    assert.deepEqual(data.counts(), { preflights: 1, commits: 1 });
  } finally { await fsp.rm(data.root, { recursive: true, force: true }); }
});

test("completed import with a processing receipt recovers without a second commit", async () => {
  const data = await fixture("job-source-one");
  try {
    const id = `BAYT-L-${crypto.createHash("sha256").update(`${runId}/2`).digest("hex").slice(0, 24).toUpperCase()}`;
    data.batches.set(id, { id, source: "LOCAL_COLLECTOR", status: "COMPLETED", excelPersonCount: 2, matchedCount: 2,
      missingAttachmentCount: 0, extraAttachmentCount: 0, issues: [], matches: [{ cvId: "1" }, { cvId: "2" }] });
    const manifest = await fsp.readFile(path.join(data.batchDir, "manifest.json"));
    const receipts = path.join(data.root, "runtime", "incoming-receipts");
    await fsp.writeFile(path.join(receipts, `${runId}--0002.json`), JSON.stringify({ runId, page: 2,
      status: "processing", count: 2, importBatchId: id, reason: null, updatedAt: new Date().toISOString(),
      fingerprint: crypto.createHash("sha256").update(manifest).digest("hex") }));
    await data.consumer.scan();
    assert.equal((await data.consumer.list())[0].status, "displayed");
    assert.deepEqual(data.counts(), { preflights: 0, commits: 0 });
    assert.deepEqual(data.links[0], { jobId: "job-source-one", cvIds: ["1", "2"] });
  } finally { await fsp.rm(data.root, { recursive: true, force: true }); }
});

test("missing final manifest after display is blocked without deleting data", async () => {
  const data = await fixture();
  try {
    await data.consumer.scan();
    await fsp.unlink(path.join(data.batchDir, "manifest.json"));
    await data.consumer.scan();
    const status = (await data.consumer.list())[0];
    assert.equal(status.status, "blocked");
    assert.equal(status.reason, "REMOTE_MANIFEST_DISAPPEARED");
    assert.deepEqual(data.counts(), { preflights: 1, commits: 1 });
  } finally { await fsp.rm(data.root, { recursive: true, force: true }); }
});
