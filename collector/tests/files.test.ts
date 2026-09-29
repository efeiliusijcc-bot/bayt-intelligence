import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { PDFINFO_PATH, PROJECT_ROOT, SOFFICE_PATH } from "../src/config.ts";
import { convertOfficeToPdf, inspectPdf } from "../src/files.ts";

function createDocx(outputPath: string): Promise<void> {
  const script = [
    "from docx import Document",
    "import sys",
    "doc = Document()",
    "doc.add_heading('Bayt collector conversion test', 0)",
    "doc.add_paragraph('CV 12345678')",
    "doc.add_paragraph('This document validates DOCX to PDF conversion.')",
    "doc.save(sys.argv[1])",
  ].join("; ");
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_PATH || "python3", ["-c", script, outputPath]);
    let output = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(output))));
  });
}

test("preserves DOCX and creates a valid PDF copy", async (context) => {
  const prerequisites = [
    [process.env.PYTHON_PATH || "python3", ["-c", "import docx"]],
    [SOFFICE_PATH, ["--version"]],
    [PDFINFO_PATH, ["-v"]],
  ] as const;
  if (prerequisites.some(([command, args]) => spawnSync(command, args).status !== 0)) {
    context.skip("Requires python-docx, LibreOffice and pdfinfo");
    return;
  }
  const directory = path.join(PROJECT_ROOT, "tmp", "pdfs", "conversion-test");
  await fsp.rm(directory, { recursive: true, force: true });
  await fsp.mkdir(directory, { recursive: true });
  const source = path.join(directory, "original.docx");
  const destination = path.join(directory, "original-converted.pdf");
  await createDocx(source);
  const converted = await convertOfficeToPdf(source, destination);
  const sourceStat = await fsp.stat(source);
  assert.ok(sourceStat.size > 0);
  assert.equal(converted.extension, ".pdf");
  const inspection = await inspectPdf(destination);
  assert.equal(inspection.ok, true);
  assert.ok((inspection.pages || 0) >= 1);
  assert.deepEqual(inspection.refs, ["12345678"]);
});
