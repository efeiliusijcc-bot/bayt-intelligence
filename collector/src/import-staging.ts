/**
 * 将浏览器外部暂存区中的预检结果导入正式本地数据库。
 * 导入前会交叉核对候选人元数据、Excel、标准PDF ZIP、头像和原始附件。
 */
import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { nowIso } from "./config.ts";
import { CollectorDatabase } from "./db.ts";
import { assertExcelMapping, parseExcelExport } from "./excel.ts";
import {
  candidateDirectory,
  convertOfficeToPdf,
  ensureBatchDirectory,
  ensureCandidateDirectory,
  ensureDataLayout,
  inspectPdf,
  sha256File,
  sha256Text,
} from "./files.ts";
import { verifyRun, writeCandidateManifest, writeRunArtifacts } from "./reports.ts";
import type {
  DocumentKind,
  DocumentRecord,
  DownloadedFile,
  ItemStatus,
  ListingCandidate,
} from "./types.ts";

/** candidates.json中每名候选人的最小元数据结构。 */
interface StagedCandidate {
  position: number;
  cv_id: string;
  name: string;
  profile_url: string;
  last_updated: string | null;
  avatar_url: string | null;
  avatar_status: "photo" | "placeholder" | "missing";
}

/** 根据文件扩展名提供通用MIME类型；未知格式回退为二进制流。 */
const mimeForExtension = (extension: string): string => {
  // switch适合对一个值匹配多个固定分支；多个case可以共享同一个return。
  switch (extension.toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".rtf":
      return "application/rtf";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
};

/** 运行外部命令（这里主要是unzip），非零退出码转换为异常。 */
const runProcess = async (command: string, args: string[]): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${String(code)}: ${stderr.trim()}`));
    });
  });
};

/** 在目录里寻找唯一匹配文件；0个或多个都视为无法可靠归属。 */
const singleMatch = async (directory: string, pattern: RegExp, label: string): Promise<string> => {
  const matches = (await fsp.readdir(directory)).filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label} in ${directory}, found ${matches.length}`);
  }
  return path.join(directory, matches[0]);
};

/** 为已经存在于磁盘的文件计算统一DownloadedFile证据。 */
const downloadedFile = async (
  filePath: string,
  originalName = path.basename(filePath),
): Promise<DownloadedFile> => {
  const extension = path.extname(filePath).toLowerCase();
  return {
    path: filePath,
    originalName,
    mimeType: mimeForExtension(extension),
    extension,
    sizeBytes: (await fsp.stat(filePath)).size,
    sha256: await sha256File(filePath),
  };
};

/** 将文件证据和状态整理为数据库DocumentRecord。 */
const documentRecord = (
  runId: string,
  cvId: string,
  kind: DocumentKind,
  status: ItemStatus,
  file?: DownloadedFile,
  error: string | null = null,
): DocumentRecord => ({
  runId,
  cvId,
  kind,
  originalName: file?.originalName || null,
  mimeType: file?.mimeType || null,
  extension: file?.extension || null,
  path: file?.path || null,
  sha256: file?.sha256 || null,
  sizeBytes: file?.sizeBytes || null,
  status,
  error,
});

/** 复制文件、收紧权限，再生成大小和SHA-256证据。 */
const copyArtifact = async (source: string, destination: string): Promise<DownloadedFile> => {
  await fsp.copyFile(source, destination);
  await fsp.chmod(destination, 0o600);
  return downloadedFile(destination, path.basename(source));
};

/**
 * 将标准PDF ZIP解压到系统临时目录，并建立CV_ID到PDF路径的Map。
 * 目录使用显式栈pending递归遍历，因此ZIP里存在子目录也能处理。
 */
const extractStandardPdfs = async (archivePath: string): Promise<{
  directory: string;
  byCvId: Map<string, string>;
}> => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "bayt-standard-pdfs-"));
  await runProcess("unzip", ["-q", archivePath, "-d", directory]);
  const byCvId = new Map<string, string>();
  const pending = [directory];
  while (pending.length) {
    // `pop()!`取数组最后一项；循环条件已保证数组非空，所以这里可用非空断言。
    const current = pending.pop()!;
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (path.extname(entry.name).toLowerCase() !== ".pdf") continue;
      const relativeName = path.relative(directory, entryPath);
      // 从路径中的`CV123`提取数字ID；同一ID出现两个PDF立即失败。
      const cvId = relativeName.match(/cv(\d+)/i)?.[1];
      if (!cvId) throw new Error(`Standard PDF archive path has no CV_ID: ${relativeName}`);
      if (byCvId.has(cvId)) throw new Error(`Duplicate standard PDF for CV_ID ${cvId}`);
      byCvId.set(cvId, entryPath);
    }
  }
  return { directory, byCvId };
};

/** 查找候选人目录中以指定前缀开头的唯一附件，例如avatar.jpg。 */
const findCandidateFile = async (directory: string, prefix: string): Promise<string | null> => {
  const matches = (await fsp.readdir(directory)).filter((name) => name.startsWith(`${prefix}.`));
  if (matches.length > 1) throw new Error(`${directory} contains multiple ${prefix} files`);
  return matches.length ? path.join(directory, matches[0]) : null;
};

/**
 * 执行完整暂存导入：先验证整批映射，再逐人复制文件并写数据库，最后运行统一验收。
 */
export async function importStagedPreflight(
  stagingRoot: string,
  runId: string,
  searchId: string,
): Promise<{ runId: string; ok: boolean; errors: string[]; warnings: string[] }> {
  await ensureDataLayout();
  const database = new CollectorDatabase();
  let temporaryDirectory: string | null = null;
  try {
    // TypeScript的`as StagedCandidate[]`只声明期望类型；真正的数据一致性仍由后续检查保证。
    const candidates = JSON.parse(
      await fsp.readFile(path.join(stagingRoot, "candidates.json"), "utf8"),
    ) as StagedCandidate[];
    if (!candidates.length) throw new Error("Staging metadata contains no candidates");
    const candidateIds = candidates.map((candidate) => candidate.cv_id);
    if (new Set(candidateIds).size !== candidateIds.length) {
      throw new Error("Staging metadata contains duplicate CV_ID values");
    }

    // 第一阶段：整批核对Excel与PDF ZIP中的CV_ID集合。
    const downloadsDirectory = path.join(stagingRoot, "downloads");
    const sourceExcel = await singleMatch(downloadsDirectory, /\.xls$/i, "XLS export");
    const standardArchive = await singleMatch(downloadsDirectory, /\.zip$/i, "standard PDF ZIP");
    const excelCandidates = await parseExcelExport(sourceExcel);
    const excelMapping = assertExcelMapping(excelCandidates, candidateIds);
    if (excelMapping.missing.length || excelMapping.unexpected.length) {
      throw new Error(
        `Excel mapping mismatch; missing=${excelMapping.missing.join("|") || "none"}; unexpected=${excelMapping.unexpected.join("|") || "none"}`,
      );
    }
    const excelById = new Map(excelCandidates.map((candidate) => [candidate.cvId, candidate]));

    const extracted = await extractStandardPdfs(standardArchive);
    temporaryDirectory = extracted.directory;
    // 双方排序后序列化比较，避免顺序不同造成误判。
    const archiveIds = [...extracted.byCvId.keys()].sort();
    const expectedIds = [...candidateIds].sort();
    if (JSON.stringify(archiveIds) !== JSON.stringify(expectedIds)) {
      throw new Error(
        `Standard PDF ZIP mapping mismatch; expected=${expectedIds.join("|")}; actual=${archiveIds.join("|")}`,
      );
    }

    // 第二阶段：创建运行、批次目录，并保存原始Excel作为证据。
    database.startRun(runId, "preflight", "Software Engineer", candidates.length);
    database.updateRun(runId, {
      status: "running",
      searchId,
      filtersJson: JSON.stringify({
        query: "Software Engineer",
        lastUpdatedWithinSixMonths: true,
        source: "ego-browser authenticated session",
        stagingRoot,
      }),
      currentPage: 1,
      uniqueCount: 0,
      error: null,
    });
    database.upsertBatch(runId, 1, 1, "running", candidateIds);
    const batchDirectory = await ensureBatchDirectory(runId, 1);
    const batchExcelPath = path.join(batchDirectory, "source.xls");
    await fsp.copyFile(sourceExcel, batchExcelPath);
    await fsp.chmod(batchExcelPath, 0o600);

    // 第三阶段：逐候选人导入资料和文件；任一映射不明确就中止。
    for (const staged of candidates) {
      const listing: ListingCandidate = {
        cvId: staged.cv_id,
        name: staged.name,
        profileUrl: staged.profile_url,
        lastCvUpdate: staged.last_updated,
        avatarStatus: staged.avatar_status,
        avatarUrl: staged.avatar_url,
        listingText: "",
        pageNo: 1,
        ordinal: staged.position,
      };
      database.upsertListingCandidate(runId, 1, listing);
      await ensureCandidateDirectory(staged.cv_id);
      const destinationDirectory = candidateDirectory(staged.cv_id);
      const stagedDirectory = path.join(stagingRoot, "candidates", staged.cv_id);
      const profilePath = path.join(stagedDirectory, "profile.json");
      const profile = JSON.parse(await fsp.readFile(profilePath, "utf8")) as {
        cvId: string;
        text: string;
        viewedAt: string;
      };
      // 同时验证JSON字段和正文Ref，防止把甲的profile错配给乙。
      if (profile.cvId !== staged.cv_id || !new RegExp(`Ref:\\s*CV${staged.cv_id}\\b`, "i").test(profile.text)) {
        throw new Error(`${staged.cv_id}: staged profile CV_ID mismatch`);
      }
      await fsp.copyFile(profilePath, path.join(destinationDirectory, "profile.json"));
      await fsp.chmod(path.join(destinationDirectory, "profile.json"), 0o600);

      // 标准PDF在整批集合校验通过后按CV_ID精确取出。
      const standardSource = extracted.byCvId.get(staged.cv_id)!;
      const standardFile = await copyArtifact(
        standardSource,
        path.join(destinationDirectory, "bayt-cv.pdf"),
      );
      const standardInspection = await inspectPdf(standardFile.path);
      if (!standardInspection.ok) {
        throw new Error(`${staged.cv_id}: invalid standard PDF (${standardInspection.error})`);
      }
      if (standardInspection.refs?.length && !standardInspection.refs.includes(staged.cv_id)) {
        throw new Error(
          `${staged.cv_id}: standard PDF refers to ${standardInspection.refs.join(",")}`,
        );
      }
      database.upsertDocument(documentRecord(runId, staged.cv_id, "bayt_pdf", "downloaded", standardFile));

      // 只有元数据标记photo时才允许存在头像文件。
      let avatarHash: string | null = null;
      const stagedAvatar = await findCandidateFile(stagedDirectory, "avatar");
      if (staged.avatar_status === "photo") {
        if (!stagedAvatar) throw new Error(`${staged.cv_id}: real avatar is missing from staging`);
        const avatarFile = await copyArtifact(
          stagedAvatar,
          path.join(destinationDirectory, `avatar${path.extname(stagedAvatar).toLowerCase()}`),
        );
        avatarHash = avatarFile.sha256;
        database.upsertDocument(documentRecord(runId, staged.cv_id, "avatar", "downloaded", avatarFile));
      } else {
        if (stagedAvatar) throw new Error(`${staged.cv_id}: placeholder/missing avatar file must not be stored`);
        database.upsertDocument(
          documentRecord(
            runId,
            staged.cv_id,
            "avatar",
            staged.avatar_status === "placeholder" ? "skipped" : "not_available",
            undefined,
            staged.avatar_status,
          ),
        );
      }

      // 原始附件存在则保留；Office格式另生成可预览PDF，其他格式明确记不支持转换。
      const stagedOriginal = await findCandidateFile(stagedDirectory, "original");
      if (stagedOriginal) {
        const extension = path.extname(stagedOriginal).toLowerCase();
        const originalFile = await copyArtifact(
          stagedOriginal,
          path.join(destinationDirectory, `original${extension}`),
        );
        database.upsertDocument(documentRecord(runId, staged.cv_id, "original", "downloaded", originalFile));
        if (extension === ".pdf") {
          const inspection = await inspectPdf(originalFile.path);
          if (!inspection.ok) {
            throw new Error(`${staged.cv_id}: invalid original PDF (${inspection.error})`);
          }
          database.upsertDocument(
            documentRecord(
              runId,
              staged.cv_id,
              "original_pdf",
              "skipped",
              undefined,
              "original is already PDF",
            ),
          );
        } else if ([".doc", ".docx", ".odt", ".rtf"].includes(extension)) {
          const converted = await convertOfficeToPdf(
            originalFile.path,
            path.join(destinationDirectory, "original-converted.pdf"),
          );
          database.upsertDocument(
            documentRecord(runId, staged.cv_id, "original_pdf", "downloaded", converted),
          );
        } else {
          database.upsertDocument(
            documentRecord(
              runId,
              staged.cv_id,
              "original_pdf",
              "not_available",
              undefined,
              `conversion unsupported for ${extension || "unknown format"}`,
            ),
          );
        }
      } else {
        database.upsertDocument(
          documentRecord(
            runId,
            staged.cv_id,
            "original",
            "not_available",
            undefined,
            "Bayt profile has no original attachment download",
          ),
        );
        database.upsertDocument(
          documentRecord(runId, staged.cv_id, "original_pdf", "not_available", undefined, "no original"),
        );
      }

      // 将Excel和网页快照共同形成内容哈希，为后续增量判断提供依据。
      const excelJson = JSON.stringify(excelById.get(staged.cv_id));
      const webJson = JSON.stringify(profile);
      database.updateCandidate({
        cvId: staged.cv_id,
        name: staged.name,
        profileUrl: staged.profile_url,
        lastCvUpdate: staged.last_updated,
        excelJson,
        webJson,
        contentHash: sha256Text(`${excelJson}\n${webJson}`),
        avatarStatus: staged.avatar_status,
        avatarUrl: staged.avatar_url,
        avatarHash,
      });
      database.setCandidateStatus(runId, staged.cv_id, "downloaded");
      database.addEvent(
        runId,
        "profile_viewed",
        { viewedAt: profile.viewedAt, sideEffect: "Bayt may mark the profile as Viewed" },
        staged.cv_id,
      );
      await writeCandidateManifest(database, runId, staged.cv_id);
      database.updateRun(runId, {
        uniqueCount: database.countRunCandidates(runId),
        currentPage: 1,
      });
    }

    // 所有人成功后才把整批和整次运行标记completed。
    database.upsertBatch(runId, 1, 1, "downloaded", candidateIds, batchExcelPath);
    database.updateRun(runId, {
      status: "completed",
      currentPage: 1,
      uniqueCount: candidates.length,
      completedAt: nowIso(),
      error: null,
    });
    const verification = await verifyRun(database, runId, true);
    await writeRunArtifacts(database, runId);
    // 验收失败会把刚才的completed纠正成failed，并重新生成报告。
    if (!verification.ok) {
      database.updateRun(runId, {
        status: "failed",
        error: verification.errors.join("; "),
      });
      await writeRunArtifacts(database, runId);
    }
    return { runId, ...verification };
  } catch (error) {
    // 如果运行记录已经创建，失败信息也必须落库；创建前失败则直接上抛。
    const run = database.getRun(runId);
    if (run) {
      database.updateRun(runId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      await writeRunArtifacts(database, runId).catch(() => undefined);
    }
    throw error;
  } finally {
    // 无论成功失败都清理解压临时目录并关闭数据库。
    if (temporaryDirectory) {
      await fsp.rm(temporaryDirectory, { recursive: true, force: true });
    }
    database.close();
  }
}

/** 命令行包装：读取暂存根目录、可选runId/searchId并打印JSON结果。 */
async function main(): Promise<void> {
  const stagingRoot = path.resolve(process.argv[2] || "");
  const runId = process.argv[3] || `ego-preflight-${nowIso().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const searchId = process.argv[4] || "unknown";
  if (!process.argv[2]) {
    throw new Error("Usage: import-staging <staging-root> [run-id] [search-id]");
  }
  const result = await importStagedPreflight(stagingRoot, runId, searchId);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

// 只有“直接运行本文件”时才执行main；被测试或其他模块import时不会自动启动。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
