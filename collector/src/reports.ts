/**
 * 生成候选人清单、运行级CSV/JSONL和验收报告。
 * 验收会重新检查磁盘文件与数据库哈希，而不是只相信“下载成功”状态。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { RUNS_DIR } from "./config.ts";
import { CollectorDatabase } from "./db.ts";
import { candidateDirectory, inspectPdf, sha256File, writeJsonAtomic } from "./files.ts";

/** 按CSV规则转义逗号、引号和换行；内部引号必须写成两个引号。 */
const csvEscape = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** 为单个候选人写manifest.json，汇总数据库资料和本次运行的文档记录。 */
export async function writeCandidateManifest(
  database: CollectorDatabase,
  runId: string,
  cvId: string,
): Promise<void> {
  const candidate = database.getCandidate(cvId);
  if (!candidate) throw new Error(`Candidate ${cvId} does not exist in the database`);
  // 链式调用先取本次运行文档，再过滤到当前CV_ID。
  const documents = database
    .getDocumentsForRun(runId)
    .filter((document) => String(document.cv_id) === cvId);
  await writeJsonAtomic(path.join(candidateDirectory(cvId), "manifest.json"), {
    runId,
    candidate,
    documents,
  });
}

/** 生成运行级CSV、JSONL和Markdown验收报告，并返回三个文件路径。 */
export async function writeRunArtifacts(database: CollectorDatabase, runId: string): Promise<{
  manifestCsv: string;
  manifestJsonl: string;
  reportPath: string;
}> {
  const run = database.getRun(runId);
  if (!run) throw new Error(`Run ${runId} was not found`);
  const directory = path.join(RUNS_DIR, runId);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const rows = database.listManifestRows(runId);
  // 有数据时自动使用查询列名；无数据时仍输出一个稳定的最小表头。
  const headers = rows.length
    ? Object.keys(rows[0]).filter((key) => !["excel_json", "web_json"].includes(key))
    : ["run_id", "cv_id", "candidate_status"];
  const manifestCsv = path.join(directory, "manifest.csv");
  const manifestJsonl = path.join(directory, "manifest.jsonl");
  // 展开语法`...rows.map(...)`把每一行接在表头数组后面。
  await fsp.writeFile(
    manifestCsv,
    [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join(
      "\n",
    ) + "\n",
    { mode: 0o600 },
  );
  await fsp.writeFile(
    manifestJsonl,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
    { mode: 0o600 },
  );

  const summary = database.summary(runId);
  const verification = await verifyRun(database, runId, false);
  const reportPath = path.join(directory, "verification_report.md");
  // 用字符串数组逐行构造Markdown，比大段字符串更容易按条件插入错误/警告。
  const report = [
    "# Bayt CV collection verification report",
    "",
    `- Run ID: ${runId}`,
    `- Query: ${run.query}`,
    `- Target: ${run.targetCount}`,
    `- Status: ${run.status}`,
    `- Unique candidates: ${rows.length}`,
    `- Search ID: ${run.searchId || "not assigned"}`,
    `- Started: ${run.startedAt}`,
    `- Updated: ${run.updatedAt}`,
    "",
    "## Database summary",
    "",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
    "",
    "## Verification",
    "",
    `- Errors: ${verification.errors.length}`,
    `- Warnings: ${verification.warnings.length}`,
    "",
    ...verification.errors.map((error) => `- ERROR: ${error}`),
    ...verification.warnings.map((warning) => `- WARNING: ${warning}`),
    "",
  ].join("\n");
  await fsp.writeFile(reportPath, report, { mode: 0o600 });
  return { manifestCsv, manifestJsonl, reportPath };
}

/**
 * 验证数据库映射、PDF引用、原始附件、转换PDF、头像状态、文件存在性和SHA-256。
 * strictTarget=false用于运行中的阶段性报告；最终验收通常要求true。
 */
export async function verifyRun(
  database: CollectorDatabase,
  runId: string,
  strictTarget = true,
): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const run = database.getRun(runId);
  if (!run) return { ok: false, errors: [`Run ${runId} was not found`], warnings: [] };
  const rows = database.listManifestRows(runId);
  const documents = database.getDocumentsForRun(runId);
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = rows.map((row) => String(row.cv_id));
  if (new Set(ids).size !== ids.length) errors.push("Manifest contains duplicate CV_ID values");
  if (strictTarget && ids.length !== run.targetCount) {
    errors.push(`Expected ${run.targetCount} candidates, found ${ids.length}`);
  }

  // 第一轮按候选人检查业务规则和文件映射。
  for (const row of rows) {
    const cvId = String(row.cv_id);
    if (!row.excel_json) errors.push(`${cvId}: Excel mapping is missing`);
    if (row.candidate_status !== "downloaded") {
      errors.push(`${cvId}: candidate status is ${String(row.candidate_status)}`);
    }
    if (row.bayt_pdf_status !== "downloaded" || !row.bayt_pdf_path) {
      errors.push(`${cvId}: standard Bayt PDF is not downloaded`);
    } else {
      const pdfPath = String(row.bayt_pdf_path);
      const inspection = await inspectPdf(pdfPath);
      if (!inspection.ok) errors.push(`${cvId}: standard PDF is invalid (${inspection.error})`);
      else if (inspection.refs?.length && !inspection.refs.includes(cvId)) {
        errors.push(`${cvId}: standard PDF refers to ${inspection.refs.join(", ")}`);
      } else if (!inspection.refs?.length) {
        warnings.push(`${cvId}: standard PDF has no extractable CV reference; mapping relies on download context`);
      }
    }

    if (!row.original_status) errors.push(`${cvId}: original attachment status is missing`);
    if (row.original_status === "downloaded" && !row.original_path) {
      errors.push(`${cvId}: original attachment is marked downloaded but has no path`);
    }
    if (row.original_path) {
      const extension = path.extname(String(row.original_path)).toLowerCase();
      if ([".doc", ".docx", ".odt", ".rtf"].includes(extension) && !row.original_pdf_path) {
        errors.push(`${cvId}: office attachment has no converted PDF`);
      }
    }
    if (row.avatar_status === "photo" && !row.avatar_path) {
      errors.push(`${cvId}: real avatar was detected but no avatar file is stored`);
    }
    if (row.avatar_status === "placeholder" && row.avatar_path) {
      errors.push(`${cvId}: placeholder avatar should not be stored as a file`);
    }
  }

  // 第二轮对每个标记为downloaded的文件重新读取并计算哈希。
  for (const document of documents) {
    if (document.status !== "downloaded") continue;
    const filePath = document.path ? String(document.path) : "";
    if (!filePath) {
      errors.push(`${String(document.cv_id)}:${String(document.kind)} has no file path`);
      continue;
    }
    try {
      await fsp.access(filePath);
      const actualHash = await sha256File(filePath);
      if (document.sha256 && actualHash !== document.sha256) {
        errors.push(`${String(document.cv_id)}:${String(document.kind)} hash mismatch`);
      }
    } catch (error) {
      // 文件缺失、无权限或读取失败都进入验收错误列表，而不是让整个报告中断。
      errors.push(`${String(document.cv_id)}:${String(document.kind)} file missing (${String(error)})`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
