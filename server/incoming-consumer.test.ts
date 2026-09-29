import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IncomingConsumer } from "./incoming-consumer.ts";
import type { ImportService } from "./import-service.ts";
import type { PeopleRepository } from "./people-repository.ts";

const runId = "local-ego-unit-test";

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "bayt-incoming-test-"));
  const incoming = path.join(root, "incoming");
  const batchDir = path.join(incoming, runId, "batch-0002");
  await fsp.mkdir(batchDir, { recursive: true });
  const manifest = {
    runId, page: 2, selectedCount: 2, cvIdSetSha256: crypto.createHash("sha256").update("1\n2").digest("hex"),
    files: { excel: { name: "resumes.xls", sha256: "a" }, pdfArchive: { name: "resumes.zip", sha256: "b" } },
    verification: { pdfEntries: 2 },
  };
  await fsp.writeFile(path.join(batchDir, "source.xls"), "xls");
  await fsp.writeFile(path.join(batchDir, "bayt-cvs.zip"), "zip");
  await fsp.writeFile(path.join(batchDir, "manifest.json"), JSON.stringify(manifest));
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
    { attachments: [{ kind: "bayt_pdf", status: "downloaded" }] } : null } as unknown as PeopleRepository;
  const consumer = new IncomingConsumer(imports, people, incoming, path.join(root, "runtime"), "/remote/incoming",
    async () => {});
  return { root, batchDir, consumer, batches, counts: () => ({ preflights, commits }) };
}

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
  const data = await fixture();
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
