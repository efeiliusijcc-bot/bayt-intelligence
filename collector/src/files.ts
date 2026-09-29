/**
 * 采集器的文件基础设施：安全目录、下载落盘、哈希、PDF检查和Office转PDF。
 * 这里集中处理文件权限与完整性，业务流程无需重复实现。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Download } from "playwright";
import {
  CANDIDATES_DIR,
  DATA_ROOT,
  DIAGNOSTICS_DIR,
  PROJECT_ROOT,
  RUNS_DIR,
  SOFFICE_PATH,
} from "./config.ts";
import type { DownloadedFile } from "./types.ts";

// 浏览器返回的MIME类型到本地扩展名映射。
const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/rtf": ".rtf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

// 只有这些Office格式允许交给LibreOffice转换。
const OFFICE_EXTENSIONS = new Set([".doc", ".docx", ".odt", ".rtf"]);

/** 创建数据目录，并尽量把权限收紧为仅当前用户可访问。 */
export async function ensureDataLayout(): Promise<void> {
  for (const directory of [DATA_ROOT, RUNS_DIR, CANDIDATES_DIR, DIAGNOSTICS_DIR]) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    // Windows可能不完整支持Unix权限，因此chmod失败被安全忽略。
    await fsp.chmod(directory, 0o700).catch(() => undefined);
  }
}

/** 根据纯数字CV_ID得到候选人目录；先校验可避免路径穿越。 */
export function candidateDirectory(cvId: string): string {
  if (!/^\d+$/.test(cvId)) throw new Error(`Invalid CV_ID: ${cvId}`);
  return path.join(CANDIDATES_DIR, cvId);
}

/** 生成某次运行中某个批次的标准目录，批次号补齐4位便于排序。 */
export function batchDirectory(runId: string, batchNo: number): string {
  return path.join(RUNS_DIR, runId, "batches", String(batchNo).padStart(4, "0"));
}

/** 创建并返回候选人目录。 */
export async function ensureCandidateDirectory(cvId: string): Promise<string> {
  const directory = candidateDirectory(cvId);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700).catch(() => undefined);
  return directory;
}

/** 创建并返回批次目录。 */
export async function ensureBatchDirectory(runId: string, batchNo: number): Promise<string> {
  const directory = batchDirectory(runId, batchNo);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700).catch(() => undefined);
  return directory;
}

/** 去掉操作系统不允许或危险的文件名字符，只保留basename。 */
export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim();
  return base || "download.bin";
}

/** 流式计算文件SHA-256；相同内容应产生相同哈希。 */
export async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** 对短文本直接计算SHA-256。箭头函数是`function`的简洁写法。 */
export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** 确认路径是非空普通文件，并返回字节数。 */
async function statFile(filePath: string): Promise<number> {
  const info = await fsp.stat(filePath);
  if (!info.isFile() || info.size === 0) throw new Error(`Downloaded file is empty: ${filePath}`);
  return info.size;
}

/** 优先根据MIME推断扩展名，其次尝试URL，最后保守使用.bin。 */
export function extensionFor(mimeType: string | null, sourceUrl?: string): string {
  if (mimeType && MIME_EXTENSIONS[mimeType.toLowerCase()]) return MIME_EXTENSIONS[mimeType.toLowerCase()];
  if (sourceUrl) {
    try {
      const extension = path.extname(new URL(sourceUrl).pathname).toLowerCase();
      if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
    } catch {
      // sourceUrl不一定是完整URL，也可能只是原始文件名。
      const extension = path.extname(sourceUrl).toLowerCase();
      if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
    }
  }
  return ".bin";
}

/** 保存Playwright下载对象，随后立即计算大小和哈希。 */
export async function saveDownload(
  download: Download,
  destinationBase: string,
  expectedExtension?: string,
): Promise<DownloadedFile> {
  const failure = await download.failure();
  if (failure) throw new Error(`Browser download failed: ${failure}`);
  const suggestedName = sanitizeFilename(download.suggestedFilename());
  const suggestedExtension = path.extname(suggestedName).toLowerCase();
  const extension = expectedExtension || suggestedExtension || ".bin";
  // 多行三元表达式：已有扩展名就直接用，否则把扩展名拼到基础路径后。
  const destination = destinationBase.endsWith(extension)
    ? destinationBase
    : `${destinationBase}${extension}`;
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await download.saveAs(destination);
  const sizeBytes = await statFile(destination);
  const sha256 = await sha256File(destination);
  return {
    path: destination,
    originalName: suggestedName,
    mimeType: null,
    extension,
    sha256,
    sizeBytes,
  };
}

/** 保存内存中的二进制Buffer，例如头像HTTP响应。 */
export async function saveBuffer(
  buffer: Buffer,
  destinationBase: string,
  mimeType: string | null,
  sourceUrl?: string,
): Promise<DownloadedFile> {
  if (!buffer.length) throw new Error("Received an empty file buffer");
  const extension = extensionFor(mimeType, sourceUrl);
  const destination = `${destinationBase}${extension}`;
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fsp.writeFile(destination, buffer, { mode: 0o600 });
  return {
    path: destination,
    originalName: sourceUrl ? sanitizeFilename(new URL(sourceUrl).pathname) : path.basename(destination),
    mimeType,
    extension,
    sha256: await sha256File(destination),
    sizeBytes: await statFile(destination),
  };
}

/**
 * 启动外部命令并收集stdout/stderr。
 * 子进程退出码0代表成功，其他退出码转换成异常。
 */
function runProcess(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
    });
  });
}

/** 检查PDF文件头，再调用专用脚本读取页数、加密状态和CV引用。 */
export async function inspectPdf(filePath: string): Promise<{
  ok: boolean;
  pages?: number;
  refs?: string[];
  text_chars?: number;
  encrypted?: boolean;
  error?: string;
}> {
  // `.then`与`await`都用于等待Promise，这里串接读取后的前5字节转换。
  const header = await fsp.readFile(filePath).then((buffer) => buffer.subarray(0, 5).toString("ascii"));
  if (header !== "%PDF-") return { ok: false, error: "File does not start with a PDF signature" };
  const script = path.join(PROJECT_ROOT, "scripts", "pdf_inspect.py");
  try {
    const { stdout } = await runProcess(process.env.PYTHON_PATH || "python3", [script, filePath]);
    return JSON.parse(stdout.trim()) as {
      ok: boolean;
      pages?: number;
      refs?: string[];
      text_chars?: number;
      encrypted?: boolean;
      error?: string;
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 使用LibreOffice在临时目录转换Office附件，并验收生成的PDF。 */
export async function convertOfficeToPdf(inputPath: string, outputPath: string): Promise<DownloadedFile> {
  const extension = path.extname(inputPath).toLowerCase();
  if (!OFFICE_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported office conversion format: ${extension || "none"}`);
  }
  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "bayt-convert-"));
  try {
    await runProcess(SOFFICE_PATH, [
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      temporaryDirectory,
      inputPath,
    ]);
    const generatedPath = path.join(
      temporaryDirectory,
      `${path.basename(inputPath, path.extname(inputPath))}.pdf`,
    );
    await fsp.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    await fsp.rename(generatedPath, outputPath);
    const inspection = await inspectPdf(outputPath);
    if (!inspection.ok || !inspection.pages) {
      throw new Error(`Converted PDF failed validation: ${inspection.error || "no pages"}`);
    }
    return {
      path: outputPath,
      originalName: path.basename(outputPath),
      mimeType: "application/pdf",
      extension: ".pdf",
      sha256: await sha256File(outputPath),
      sizeBytes: await statFile(outputPath),
    };
  } finally {
    // finally无论成功或失败都会执行，确保临时目录不会长期残留。
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** 先写临时文件再rename，避免进程中断时留下半个JSON。 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tempPath, filePath);
}
