import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "@e965/xlsx";
import { assertExcelMapping, normalizeExcelMatrix, parseExcelExport } from "../src/excel.ts";

test("normalizes Bayt continuation rows by CV_ID", () => {
  const matrix = [
    ["Number", "CV_ID", "CV Link", "Last CV Update", "Name", "Skills", "Experience"],
    ["1", "10001", "https://example.test/1", "2026-08-20", "Candidate One", "Node.js", "A"],
    [null, null, null, null, null, "TypeScript", "B"],
    ["2", "10002", "https://example.test/2", "2026-08-21", "Candidate Two", "Java", "C"],
  ];
  const candidates = normalizeExcelMatrix(matrix);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].cvId, "10001");
  assert.deepEqual(candidates[0].fields.Skills, ["Node.js", "TypeScript"]);
  assert.deepEqual(candidates[0].fields.Experience, ["A", "B"]);
  assert.deepEqual(candidates[0].sourceRows, [2, 3]);
  assert.deepEqual(assertExcelMapping(candidates, ["10001", "10002"]), {
    missing: [],
    unexpected: [],
  });
});

test("reports missing and unexpected CV_ID values", () => {
  const candidates = normalizeExcelMatrix([
    ["CV_ID", "Name"],
    ["10001", "One"],
    ["10003", "Three"],
  ]);
  assert.deepEqual(assertExcelMapping(candidates, ["10001", "10002"]), {
    missing: ["10002"],
    unexpected: ["10003"],
  });
});

test("reads an Excel export from disk through the ESM filesystem adapter", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "bayt-excel-test-"));
  const filePath = path.join(directory, "source.xls");
  try {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["CV_ID", "Name"],
      ["10001", "One"],
      ["10002", "Two"],
    ]), "Candidates");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xls" });
    await fsp.writeFile(filePath, bytes);
    const rows = await parseExcelExport(filePath);
    assert.deepEqual(rows.map((item) => item.cvId), ["10001", "10002"]);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
