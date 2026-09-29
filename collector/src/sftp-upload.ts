/**
 * Windows到108的SFTP上传器。
 * 每个文件先传为`.part`，完成后再rename，避免服务端把半文件当成正式结果。
 */
import { spawn } from "node:child_process";
import path from "node:path";

const SFTP_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** SFTP连接配置。密钥和known_hosts只传路径，不把秘密写进代码。 */
export interface SftpUploadConfig {
  executable: string;
  host: string;
  port: number;
  user: string;
  identityFile: string;
  knownHostsFile: string;
  remoteRoot: string;
}

/** 一页批次需要一起发布的三个文件。 */
export interface SftpBatchFiles {
  runId: string;
  batchNo: number;
  excelPath: string;
  pdfArchivePath: string;
  manifestPath: string;
}

/** 只允许安全字符进入远端目录名，阻止`../`等路径穿越。 */
function safeSegment(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

/** 把SFTP批处理参数包在双引号中，并转义路径里的特殊字符。 */
function sftpQuote(value: string): string {
  return `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
}

/** 使用远端统一的`/`拼接路径，并压缩重复斜杠。`...parts`是剩余参数语法。 */
function remoteJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/{2,}/g, "/");
}

/** 生成交给`sftp -b -`执行的批处理命令文本，本函数本身不联网。 */
export function buildSftpUploadBatch(config: SftpUploadConfig, files: SftpBatchFiles): string {
  const runId = safeSegment(files.runId, "run id");
  if (!Number.isInteger(files.batchNo) || files.batchNo < 1 || files.batchNo > 10_000) {
    throw new Error("Invalid batch number");
  }
  const batchName = `batch-${String(files.batchNo).padStart(4, "0")}`;
  const root = config.remoteRoot.replace(/\/+$/, "") || "/incoming";
  const runRoot = remoteJoin(root, runId);
  const batchRoot = remoteJoin(runRoot, batchName);
  // `as const`让TypeScript保留元组中每一项的精确只读类型。
  const entries = [
    [files.excelPath, remoteJoin(batchRoot, "source.xls")],
    [files.pdfArchivePath, remoteJoin(batchRoot, "bayt-cvs.zip")],
    [files.manifestPath, remoteJoin(batchRoot, "manifest.json")],
  ] as const;
  const commands = [
    `-mkdir ${sftpQuote(root)}`,
    `-mkdir ${sftpQuote(runRoot)}`,
    `-mkdir ${sftpQuote(batchRoot)}`,
  ];
  // 数组解构`[localPath, remotePath]`一次取出一对本地/远端路径。
  for (const [localPath, remotePath] of entries) {
    commands.push(`put ${sftpQuote(path.resolve(localPath))} ${sftpQuote(`${remotePath}.part`)}`);
    commands.push(`rename ${sftpQuote(`${remotePath}.part`)} ${sftpQuote(remotePath)}`);
    // The app reads the read-only incoming mount as uid 1000, in the shared
    // directory group. SFTP otherwise preserves a local 0600 manifest mode.
    commands.push(`chmod 640 ${sftpQuote(remotePath)}`);
  }
  commands.push(`ls -l ${sftpQuote(batchRoot)}`, "bye");
  return `${commands.join("\n")}\n`;
}

/** 启动系统SFTP子进程，将批处理命令写入其标准输入，并收集输出。 */
export function runSftp(config: SftpUploadConfig, batch: string): Promise<string> {
  const args = [
    "-b",
    "-",
    "-P",
    String(config.port),
    "-i",
    config.identityFile,
    "-oBatchMode=yes",
    "-oIdentitiesOnly=yes",
    "-oStrictHostKeyChecking=yes",
    `-oUserKnownHostsFile=${config.knownHostsFile}`,
    `${config.user}@${config.host}`,
  ];
  // Promise把子进程的事件回调包装成可`await`的异步结果。
  return new Promise((resolve, reject) => {
    const child = spawn(config.executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, output = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(output);
    };
    // SFTP子进程本身没有请求级超时；失联时必须终止，不能让Agent永久占着任务租约。
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`SFTP upload timed out after ${SFTP_UPLOAD_TIMEOUT_MS}ms`));
    }, SFTP_UPLOAD_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish(null, stdout);
      else finish(new Error(`SFTP upload failed with exit code ${code}: ${stderr.slice(-1000)}`));
    });
    child.stdin.end(batch);
  });
}

/** 上传一页完整批次；全部命令成功后返回服务端批次目录。 */
export async function uploadBatchAtomically(
  config: SftpUploadConfig,
  files: SftpBatchFiles,
): Promise<{ remoteBatch: string }> {
  const batch = buildSftpUploadBatch(config, files);
  await runSftp(config, batch);
  return {
    remoteBatch: remoteJoin(
      config.remoteRoot.replace(/\/+$/, "") || "/incoming",
      files.runId,
      `batch-${String(files.batchNo).padStart(4, "0")}`,
    ),
  };
}
