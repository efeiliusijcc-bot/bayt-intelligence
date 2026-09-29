import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../src/task-store.ts";
import { needsIncrementalCollection } from "../src/collector.ts";
import type { ListingCandidate } from "../src/types.ts";

test("requires a successful 10-person preflight before scheduling", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "bayt-task-store-"));
  const store = new TaskStore(path.join(directory, "control.db"));
  try {
    const task = store.createTask({ name: "Software", query: "Software Engineer", maxPerRun: 500 });
    assert.throws(() => store.updateTask(task.id, { enabled: true }), /preflight/i);
    const queued = store.queueRun(task.id, "preflight", 10);
    assert.equal(store.dequeueRun()?.id, queued.id);
    store.finishRun(queued.id, "completed", { uniqueCount: 10, currentPage: 1 });
    const enabled = store.updateTask(task.id, { enabled: true });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.preflightStatus, "passed");
  } finally {
    store.close();
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("incremental policy collects new and changed profiles and defers unknown dates for 30 days", () => {
  const candidate: ListingCandidate = { cvId: "1", name: "One", profileUrl: "https://example.test", lastCvUpdate: "2026-08-20", avatarStatus: "missing", avatarUrl: null, listingText: "", pageNo: 1, ordinal: 1 };
  assert.equal(needsIncrementalCollection(null, candidate), true);
  assert.equal(needsIncrementalCollection({ last_cv_update: "2026-08-20" }, candidate), false);
  assert.equal(needsIncrementalCollection({ last_cv_update: "2026-08-19" }, candidate), true);
  const unknown = { ...candidate, lastCvUpdate: null };
  assert.equal(needsIncrementalCollection({ last_seen_at: "2026-08-01T00:00:00Z" }, unknown, Date.parse("2026-08-20T00:00:00Z")), false);
  assert.equal(needsIncrementalCollection({ last_seen_at: "2026-07-01T00:00:00Z" }, unknown, Date.parse("2026-08-20T00:00:00Z")), true);
});
