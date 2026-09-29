import assert from "node:assert/strict";
import test from "node:test";
import {
  agentRetryDelay,
  assertControlPlaneTransport,
  decideFilterCatalogVersion,
  isRetryableAgentLoopError,
  jobFinished,
} from "../src/windows-agent.ts";

test("Windows Agent retries transient control-plane failures with bounded backoff", () => {
  assert.equal(isRetryableAgentLoopError(new Error("fetch failed")), true);
  assert.equal(isRetryableAgentLoopError(new Error("ECONNRESET")), true);
  assert.equal(isRetryableAgentLoopError(new Error("403 Forbidden")), false);
  assert.deepEqual([1, 2, 3, 6, 20].map(agentRetryDelay), [30_000, 60_000, 120_000, 600_000, 600_000]);
});

test("Windows Agent requires an explicit opt-in before using an HTTP control plane", () => {
  assert.doesNotThrow(() => assertControlPlaneTransport("https://control.example.test", false));
  assert.doesNotThrow(() => assertControlPlaneTransport("http://collector.example.com:8443", true));
  assert.throws(
    () => assertControlPlaneTransport("http://collector.example.com:8443", false),
    /BAYT_ALLOW_INSECURE_CONTROL_PLANE=1/,
  );
  assert.throws(() => assertControlPlaneTransport("ftp://control.example.test", true), /HTTP or HTTPS/);
});

test("Windows Agent accepts a matching first Filter catalog scan", () => {
  assert.deepEqual(
    decideFilterCatalogVersion("bayt-task", "bayt-task"),
    { action: "accept_first", version: "bayt-task" },
  );
});

test("Windows Agent rescans once and accepts when the catalog returns to the task version", () => {
  assert.deepEqual(
    decideFilterCatalogVersion("bayt-task", "bayt-drift"),
    { action: "rescan", version: "bayt-drift" },
  );
  assert.deepEqual(
    decideFilterCatalogVersion("bayt-task", "bayt-drift", "bayt-task"),
    { action: "accept_second", version: "bayt-task" },
  );
});

test("Windows Agent treats two identical new Filter versions as a real structure change", () => {
  assert.deepEqual(
    decideFilterCatalogVersion("bayt-task", "bayt-new", "bayt-new"),
    { action: "structure_changed", version: "bayt-new" },
  );
});

test("Windows Agent safely stops when two mismatching Filter scans disagree", () => {
  assert.deepEqual(
    decideFilterCatalogVersion("bayt-task", "bayt-drift-a", "bayt-drift-b"),
    { action: "unstable", version: "bayt-drift-b" },
  );
});

test("Windows Agent duration mode stops by elapsed time rather than resume count", () => {
  const startedAt = "2026-09-09T05:00:00.000Z";
  const job = { limits: { durationHours: 24 }, startedAt } as Parameters<typeof jobFinished>[0];
  assert.equal(jobFinished(job, 5_000, 100, Date.parse("2026-09-10T04:59:59.999Z")), false);
  assert.equal(jobFinished(job, 0, 0, Date.parse("2026-09-10T05:00:00.000Z")), true);
});
