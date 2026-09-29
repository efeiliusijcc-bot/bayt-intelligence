import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("capture summary strips query tokens, headers and response bodies", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "bayt-capture-"));
  process.env.BAYT_CAPTURES_ROOT = directory;
  const { sanitizeHar } = await import(`../src/capture.ts?test=${Date.now()}`);
  const runId = "run-test";
  await fsp.writeFile(path.join(directory, `${runId}.har`), JSON.stringify({ log: { entries: [{
    startedDateTime: "2026-08-22T00:00:00Z",
    request: { method: "GET", url: "https://www.bayt.com/download?token=secret", headers: [{ name: "Cookie", value: "secret" }] },
    response: { status: 200, content: { mimeType: "application/json", size: 25, text: "private-person-data" } },
    time: 42,
  }] } }), { mode: 0o600 });
  const summaryPath = await sanitizeHar(runId);
  const summary = await fsp.readFile(summaryPath!, "utf8");
  assert.match(summary, /https:\/\/www\.bayt\.com\/download/);
  assert.doesNotMatch(summary, /secret|private-person-data|Cookie/);
  await fsp.rm(directory, { recursive: true, force: true });
});
