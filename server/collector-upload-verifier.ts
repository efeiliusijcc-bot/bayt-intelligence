import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { parseExcelCandidates, inspectZipPdfs } from "./import-service.ts";

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    import("node:fs").then(({ createReadStream }) => {
      const stream = createReadStream(filePath);
      stream.on("error", reject);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
    }).catch(reject);
  });
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (error, zip) => error || !zip ? reject(error || new Error("ZIP无法打开")) : resolve(zip)));
}

function verifyZipCrc(filePath: string): Promise<number> {
  return openZip(filePath).then((zip) => new Promise<number>((resolve, reject) => {
    let failures = 0;
    zip.on("entry", (entry: yauzl.Entry) => {
      if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { reject(error || new Error("ZIP条目无法读取")); return; }
        let crc = 0xffffffff;
        stream.on("data", (chunk: Buffer) => {
          for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        });
        stream.on("end", () => { if (((crc ^ 0xffffffff) >>> 0) !== (entry.crc32 >>> 0)) failures += 1; zip.readEntry(); });
        stream.on("error", reject);
      });
    });
    zip.on("end", () => resolve(failures));
    zip.on("error", reject);
    zip.readEntry();
  }));
}

export async function verifyIncomingBatch(input: Record<string, unknown>, localRoot: string, remoteRoot: string, expectedJobId?: string): Promise<void> {
  const remoteBatch = String(input.remoteBatch || "");
  const normalizedRemoteRoot = remoteRoot.replace(/\/$/, "");
  if (!remoteBatch.startsWith(`${normalizedRemoteRoot}/`) || remoteBatch.includes("..")) throw new Error("远端批次路径不在允许目录内");
  const relative = remoteBatch.slice(normalizedRemoteRoot.length + 1);
  const localBatch = path.resolve(localRoot, relative);
  const normalizedLocalRoot = `${path.resolve(localRoot)}${path.sep}`;
  if (!`${localBatch}${path.sep}`.startsWith(normalizedLocalRoot)) throw new Error("远端批次路径越界");
  const excelPath = path.join(localBatch, "source.xls");
  const pdfPath = path.join(localBatch, "bayt-cvs.zip");
  const manifestPath = path.join(localBatch, "manifest.json");
  const entries = await fsp.readdir(localBatch);
  if (entries.some((name) => name.endsWith(".part") || name.endsWith(".tmp"))) throw new Error("批次目录仍存在临时文件");
  for (const filePath of [excelPath, pdfPath, manifestPath]) {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) throw new Error(`批次文件为空: ${path.basename(filePath)}`);
  }
  const [excelHash, pdfHash, manifestText] = await Promise.all([sha256File(excelPath), sha256File(pdfPath), fsp.readFile(manifestPath, "utf8")]);
  if (excelHash !== input.excelSha256 || pdfHash !== input.pdfSha256) throw new Error("服务端落盘文件SHA-256与Agent检查点不一致");
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  if (expectedJobId) {
    const [runId, batchName] = relative.split("/");
    if (relative.split("/").length !== 2 || manifest.runId !== runId || batchName !== `batch-${String(input.page).padStart(4, "0")}`)
      throw new Error("manifest运行ID与批次路径不一致");
  }
  if (expectedJobId && (manifest.schemaVersion !== 2 || manifest.queueJobId !== expectedJobId))
    throw new Error("manifest采集任务ID与Agent租约不一致");
  const files = manifest.files as Record<string, Record<string, unknown>>;
  const verification = manifest.verification as Record<string, unknown>;
  if (manifest.page !== input.page || manifest.selectedCount !== input.selectedCount || manifest.cvIdSetSha256 !== input.cvIdSetSha256 || files?.excel?.sha256 !== input.excelSha256 || files?.pdfArchive?.sha256 !== input.pdfSha256 || verification?.exactMatch !== true || verification?.zipCrcFailures !== 0) {
    throw new Error("manifest与Agent检查点证据不一致");
  }
  const [excel, pdfs, crcFailures] = await Promise.all([Promise.resolve(parseExcelCandidates(excelPath)), inspectZipPdfs(pdfPath), verifyZipCrc(pdfPath)]);
  const excelIds = new Set(excel.map((item) => item.cvId));
  const pdfIds = new Set(pdfs.map((item) => item.cvId));
  const cvIdSetSha256 = crypto.createHash("sha256").update([...excelIds].sort().join("\n")).digest("hex");
  if (crcFailures || cvIdSetSha256 !== input.cvIdSetSha256 || excel.length !== Number(input.selectedCount) || excelIds.size !== excel.length || pdfs.length !== Number(input.pdfEntries) || pdfIds.size !== pdfs.length || pdfs.some((item) => !item.validPdf) || [...excelIds].some((id) => !pdfIds.has(id))) {
    throw new Error("服务端落盘XLS/PDF映射或ZIP CRC验收失败");
  }
}
