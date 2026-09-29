import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSftpUploadBatch } from "../src/sftp-upload.ts";

const config = { executable: "/usr/bin/sftp", host: "example.test", port: 22, user: "sftp",
  identityFile: "/key", knownHostsFile: "/known", remoteRoot: "/incoming" };

test("SFTP publishes a complete page with manifest last and group-readable files", () => {
  const batch = buildSftpUploadBatch(config, { runId: "local-ego-test", batchNo: 2,
    excelPath: "/local/resumes.xls", pdfArchivePath: "/local/resumes.zip", manifestPath: "/local/manifest.json" });
  assert.ok(batch.indexOf("source.xls.part") < batch.indexOf("bayt-cvs.zip.part"));
  assert.ok(batch.indexOf("bayt-cvs.zip.part") < batch.indexOf("manifest.json.part"));
  assert.match(batch, /chmod 640 "\/incoming\/local-ego-test\/batch-0002\/manifest.json"/);
  assert.equal((batch.match(/chmod 640/g) || []).length, 3);
});

test("SFTP rejects a run path escape", () => {
  assert.throws(() => buildSftpUploadBatch(config, { runId: "../escape", batchNo: 2,
    excelPath: "/x", pdfArchivePath: "/y", manifestPath: "/z" }), /Invalid run id/);
});
