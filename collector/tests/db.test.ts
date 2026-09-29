import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CollectorDatabase } from "../src/db.ts";
import type { ListingCandidate } from "../src/types.ts";

test("checkpoints candidate status without duplicating completed work", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "bayt-db-test-"));
  const database = new CollectorDatabase(path.join(directory, "collection.db"));
  try {
    database.startRun("run-1", "collect", "Software Engineer", 2);
    const first: ListingCandidate = {
      cvId: "10001",
      name: "One",
      profileUrl: "https://www.bayt.com/en/employers/cv-search/profile/?id=1",
      lastCvUpdate: "2026-08-20",
      avatarStatus: "placeholder",
      avatarUrl: "https://img.test/no-photo-large-m.png",
      listingText: "One",
      pageNo: 1,
      ordinal: 1,
    };
    database.upsertListingCandidate("run-1", 1, first);
    database.setCandidateStatus("run-1", "10001", "downloaded");
    database.upsertListingCandidate("run-1", 1, first);
    assert.equal(database.countRunCandidates("run-1"), 1);
    assert.equal(database.getRunCandidateStatuses("run-1").get("10001"), "downloaded");
    assert.equal(database.getPendingCandidates("run-1").length, 0);
    assert.equal(database.getNextBatchNo("run-1"), 1);
    database.upsertBatch("run-1", 1, 1, "downloaded", ["10001"]);
    assert.equal(database.getNextBatchNo("run-1"), 2);
  } finally {
    database.close();
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
