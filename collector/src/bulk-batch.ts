/**
 * 整页批量导出验收器：证明“页面选中的CV_ID、Excel记录、ZIP内PDF”三者完全对应。
 * 本文件只检查本地文件，不向Bayt发送请求。
 */
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { parseExcelExport } from "./excel.ts";
import { sha256File, writeJsonAtomic } from "./files.ts";

/** 一页验收清单的固定结构，最终会序列化为manifest.json。 */
export interface BulkBatchManifest {
  schemaVersion: 1;
  runId: string;
  keyword: string;
  page: number;
  createdAt: string;
  selectedCount: number;
  cvIdSetSha256: string;
  files: {
    excel: FileEvidence;
    pdfArchive: FileEvidence;
  };
  verification: {
    excelUniqueCvIds: number;
    pdfEntries: number;
    pdfUniqueCvIds: number;
    invalidPdfEntries: number;
    zipCrcFailures: number;
    missingFromArchive: number;
    unexpectedInArchive: number;
    exactMatch: boolean;
  };
}

/** 单个文件最基本的可追溯证据。 */
interface FileEvidence {
  name: string;
  sizeBytes: number;
  sha256: string;
}

/** 扫描ZIP后得到的统计，不暴露简历正文。 */
interface ZipEvidence {
  entryCount: number;
  cvIds: string[];
  invalidPdfEntries: number;
  crcFailures: number;
}

// 预先计算CRC32查找表；ZIP里每个条目的CRC可用于发现传输或存储损坏。
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** 对去重、排序后的字符串集合计算稳定哈希，因此不受原数组顺序影响。 */
function setHash(values: string[]): string {
  return crypto.createHash("sha256").update([...new Set(values)].sort().join("\n")).digest("hex");
}

/** 将yauzl的回调式open包装成Promise，便于调用方使用await。 */
function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (error, zipFile) => {
      if (error || !zipFile) reject(error || new Error("PDF ZIP could not be opened"));
      else resolve(zipFile);
    });
  });
}

/** 打开ZIP中的单个条目流；流式读取避免一次性把所有PDF放进内存。 */
function openEntryStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error || new Error("PDF ZIP entry could not be opened"));
      else resolve(stream);
    });
  });
}

/** 同时检查PDF文件头`%PDF-`和该ZIP条目的CRC32。 */
async function inspectEntry(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<{ pdfSignature: boolean; crcOk: boolean }> {
  const stream = await openEntryStream(zipFile, entry);
  return await new Promise((resolve, reject) => {
    const signature: number[] = [];
    let crc = 0xffffffff;
    // Node流通过data/end/error事件传递数据、完成和失败。
    stream.on("data", (chunk: Buffer) => {
      for (const byte of chunk) {
        if (signature.length < 5) signature.push(byte);
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      }
    });
    stream.on("end", () => resolve({
      pdfSignature: Buffer.from(signature).toString("ascii") === "%PDF-",
      crcOk: ((crc ^ 0xffffffff) >>> 0) === (entry.crc32 >>> 0),
    }));
    stream.on("error", reject);
  });
}

/** 逐条扫描ZIP，提取文件名中的CV_ID并汇总损坏/无效条目。 */
async function inspectZip(filePath: string): Promise<ZipEvidence> {
  const zipFile = await openZip(filePath);
  return await new Promise<ZipEvidence>((resolve, reject) => {
    let entryCount = 0;
    let invalidPdfEntries = 0;
    let crcFailures = 0;
    const cvIds: string[] = [];
    // lazyEntries模式要求每处理完一项后主动调用readEntry读取下一项。
    zipFile.on("entry", async (entry: yauzl.Entry) => {
      try {
        if (/\/$/.test(entry.fileName)) {
          zipFile.readEntry();
          return;
        }
        entryCount += 1;
        // `?.[1]`表示正则没匹配时不会报错；匹配时取第一个括号捕获组。
        const cvId = entry.fileName.match(/(?:^|[_-])cv(\d+)(?:[_-]|\b)/i)?.[1] || "";
        const inspection = await inspectEntry(zipFile, entry);
        const isPdf = /\.pdf$/i.test(entry.fileName) && inspection.pdfSignature;
        if (!inspection.crcOk) crcFailures += 1;
        if (!isPdf || !cvId) invalidPdfEntries += 1;
        else cvIds.push(cvId);
        zipFile.readEntry();
      } catch (error) {
        zipFile.close();
        reject(error);
      }
    });
    zipFile.on("end", () => resolve({ entryCount, cvIds, invalidPdfEntries, crcFailures }));
    zipFile.on("error", reject);
    zipFile.readEntry();
  });
}

/** 确认文件非空并生成名称、大小、SHA-256证据。 */
async function fileEvidence(filePath: string): Promise<FileEvidence> {
  const info = await fsp.stat(filePath);
  if (!info.isFile() || info.size <= 0) throw new Error(`Export file is empty: ${path.basename(filePath)}`);
  return {
    name: path.basename(filePath),
    sizeBytes: info.size,
    sha256: await sha256File(filePath),
  };
}

/**
 * 执行一页强校验。任一来源出现缺失、额外、重复、非PDF或CRC错误都会抛异常。
 * 抛异常意味着该页不能写“已完成”检查点。
 */
export async function verifyBulkBatch(input: {
  runId: string;
  keyword: string;
  page: number;
  expectedCvIds: string[];
  excelPath: string;
  pdfArchivePath: string;
}): Promise<BulkBatchManifest> {
  // 页面选择集合本身必须非空且无重复。
  const expected = new Set(input.expectedCvIds);
  if (!expected.size || expected.size !== input.expectedCvIds.length) {
    throw new Error("Selected CV_ID set is empty or contains duplicates");
  }
  const excel = await parseExcelExport(input.excelPath);
  const excelIds = excel.map((candidate) => candidate.cvId);
  const excelSet = new Set(excelIds);
  const zip = await inspectZip(input.pdfArchivePath);
  const zipSet = new Set(zip.cvIds);
  // `[...set]`使用展开语法把Set转换回数组，便于filter比较差集。
  const missingFromExcel = [...expected].filter((cvId) => !excelSet.has(cvId));
  const unexpectedInExcel = [...excelSet].filter((cvId) => !expected.has(cvId));
  const missingFromArchive = [...expected].filter((cvId) => !zipSet.has(cvId));
  const unexpectedInArchive = [...zipSet].filter((cvId) => !expected.has(cvId));
  // 所有差异都集中在一个失败条件里，错误消息给出各类数量但不泄露候选人正文。
  if (
    excelIds.length !== excelSet.size ||
    zip.cvIds.length !== zipSet.size ||
    missingFromExcel.length ||
    unexpectedInExcel.length ||
    missingFromArchive.length ||
    unexpectedInArchive.length ||
    zip.invalidPdfEntries ||
    zip.crcFailures
  ) {
    throw new Error(
      `Bulk export mapping failed; excelMissing=${missingFromExcel.length}; excelUnexpected=${unexpectedInExcel.length}; ` +
        `zipMissing=${missingFromArchive.length}; zipUnexpected=${unexpectedInArchive.length}; invalidPdf=${zip.invalidPdfEntries}; crcFailures=${zip.crcFailures}`,
    );
  }
  // 再比较集合哈希，作为一次独立的整体一致性检查。
  const expectedHash = setHash(input.expectedCvIds);
  if (setHash(excelIds) !== expectedHash || setHash(zip.cvIds) !== expectedHash) {
    throw new Error("Bulk export CV_ID set hashes do not match");
  }
  return {
    schemaVersion: 1,
    runId: input.runId,
    keyword: input.keyword,
    page: input.page,
    createdAt: new Date().toISOString(),
    selectedCount: expected.size,
    cvIdSetSha256: expectedHash,
    files: {
      excel: await fileEvidence(input.excelPath),
      pdfArchive: await fileEvidence(input.pdfArchivePath),
    },
    verification: {
      excelUniqueCvIds: excelSet.size,
      pdfEntries: zip.entryCount,
      pdfUniqueCvIds: zipSet.size,
      invalidPdfEntries: zip.invalidPdfEntries,
      zipCrcFailures: zip.crcFailures,
      missingFromArchive: missingFromArchive.length,
      unexpectedInArchive: unexpectedInArchive.length,
      exactMatch: true,
    },
  };
}

/** 将验收对象原子写入批次目录，并返回文件路径。 */
export async function writeBulkManifest(
  batchDirectory: string,
  manifest: BulkBatchManifest,
): Promise<string> {
  const filePath = path.join(batchDirectory, "manifest.json");
  await writeJsonAtomic(filePath, manifest);
  return filePath;
}
