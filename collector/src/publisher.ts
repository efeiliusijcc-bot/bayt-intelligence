/**
 * 把已验收数据发布成只读版本快照，并原子切换`current`链接。
 * 这样前端永远读取完整版本，不会看到复制到一半的数据。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CANDIDATES_DIR, DATABASE_PATH, PUBLISH_ROOT, nowIso } from "./config.ts";

/** 以流式方式计算大文件SHA-256，避免一次性把整个数据库读进内存。 */
async function sha256(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** 创建独立发布版本、生成清单、切换当前版本，并只保留最近4版。 */
export async function publishVerifiedSnapshot(releaseId: string): Promise<{ releaseId: string; releasePath: string }> {
  if (!/^run-[a-z0-9-]+$/i.test(releaseId)) throw new Error("Invalid release id");
  const releasesRoot = path.join(PUBLISH_ROOT, "releases");
  const releasePath = path.join(releasesRoot, releaseId);
  if (fs.existsSync(releasePath)) return { releaseId, releasePath };
  await fsp.mkdir(releasePath, { recursive: true, mode: 0o700 });
  const snapshotPath = path.join(releasePath, "collection.db");
  // SQLite的VACUUM INTO会生成一致性快照，不直接复制可能仍在变化的WAL文件。
  const source = new DatabaseSync(DATABASE_PATH);
  try {
    const escaped = snapshotPath.replaceAll("'", "''");
    source.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    source.close();
  }
  // 改为DELETE日志模式并清理旁路文件，让快照可以单文件独立读取。
  const standalone = new DatabaseSync(snapshotPath);
  try { standalone.exec("PRAGMA journal_mode=DELETE; PRAGMA wal_checkpoint(TRUNCATE);"); } finally { standalone.close(); }
  await Promise.all([
    fsp.rm(`${snapshotPath}-wal`, { force: true }),
    fsp.rm(`${snapshotPath}-shm`, { force: true }),
  ]);
  // 复制候选人附件目录；recursive表示递归子目录，preserveTimestamps保留文件时间。
  await fsp.cp(CANDIDATES_DIR, path.join(releasePath, "candidates"), { recursive: true, preserveTimestamps: true });
  const database = new DatabaseSync(snapshotPath, { readOnly: true });
  let candidates = 0;
  let documents = 0;
  try {
    candidates = Number((database.prepare("SELECT COUNT(*) AS total FROM candidates").get() as { total: number }).total);
    documents = Number((database.prepare("SELECT COUNT(*) AS total FROM documents").get() as { total: number }).total);
  } finally {
    database.close();
  }
  // release.json是这个快照的最小验收凭证。
  const manifest = { releaseId, publishedAt: nowIso(), candidates, documents, databaseSha256: await sha256(snapshotPath) };
  await fsp.writeFile(path.join(releasePath, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  // 先建立临时符号链接，再rename成current；rename在同一磁盘上是原子操作。
  const temporaryLink = path.join(PUBLISH_ROOT, `.current-${process.pid}`);
  await fsp.rm(temporaryLink, { force: true });
  await fsp.symlink(path.relative(PUBLISH_ROOT, releasePath), temporaryLink);
  await fsp.rename(temporaryLink, path.join(PUBLISH_ROOT, "current"));
  // 链式调用：过滤目录 -> 取目录名 -> 排序 -> 反转为最新优先。
  const releases = (await fsp.readdir(releasesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const expired of releases.slice(4)) await fsp.rm(path.join(releasesRoot, expired), { recursive: true, force: true });
  return { releaseId, releasePath };
}
