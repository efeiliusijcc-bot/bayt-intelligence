import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditStore } from "./audit.ts";
import { config } from "./config.ts";
import { inspectZipPdfs, parseExcelCandidates } from "./import-service.ts";
import { issueFileToken, verifyFileToken } from "./security.ts";

test("可选的本地Excel与ZIP能够按CV_ID完整匹配", { skip: !fs.existsSync(config.sampleExcelPath) || !fs.existsSync(config.sampleZipPath) }, async () => {
  const candidates = parseExcelCandidates(config.sampleExcelPath);
  const pdfs = await inspectZipPdfs(config.sampleZipPath);
  const excelIds = new Set(candidates.map((candidate) => candidate.cvId));
  const pdfIds = new Set(pdfs.map((pdf) => pdf.cvId));
  assert.equal(candidates.length, 50);
  assert.equal(excelIds.size, 50);
  assert.equal(pdfs.length, 50);
  assert.equal(pdfIds.size, 50);
  assert.deepEqual([...excelIds].filter((cvId) => !pdfIds.has(cvId)), []);
  assert.equal(pdfs.filter((pdf) => !pdf.validPdf).length, 0);
});

test("附件令牌能验证且篡改后失效", () => {
  const token = issueFileToken("10001:bayt_pdf", "inline");
  assert.deepEqual(verifyFileToken(token), { attachmentId: "10001:bayt_pdf", disposition: "inline" });
  assert.equal(verifyFileToken(`${token}x`), null);
});

test("审计记录按人物隔离", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bayt-audit-"));
  const databasePath = path.join(directory, "audit.db");
  const audit = new AuditStore(databasePath);
  audit.record({ action: "VIEW_PERSON", cvId: "10001", actor: "tester" });
  audit.record({ action: "VIEW_PERSON", cvId: "10002", actor: "tester" });
  assert.equal(audit.list("10001").length, 1);
  assert.equal(audit.list("10001")[0].cv_id, "10001");
});
