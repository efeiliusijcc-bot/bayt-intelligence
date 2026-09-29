import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "@e965/xlsx";
import yauzl from "yauzl";
import { config } from "./config.ts";
import { createImportedPerson, PeopleRepository } from "./people-repository.ts";
import type { ImportBatchView, ImportCandidate, ImportMatch, PersonView } from "./types.ts";

interface ZipPdf {
  fileName: string;
  cvId: string;
  validPdf: boolean;
  uncompressedSize: number;
}

const batchesDirectory = path.join(config.runtimeDirectory, "import-batches");
XLSX.set_fs(fs);
const maxTotalUncompressedBytes = 250 * 1024 * 1024;
const maxEntryBytes = 25 * 1024 * 1024;

function cellText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const normalized = String(value).trim();
  return normalized || null;
}

function appendField(fields: Record<string, string | string[]>, key: string, value: string): void {
  const current = fields[key];
  if (!current) {
    fields[key] = value;
  } else if (Array.isArray(current)) {
    if (!current.includes(value)) current.push(value);
  } else if (current !== value) {
    fields[key] = [current, value];
  }
}

export function parseExcelCandidates(filePath: string): ImportCandidate[] {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("Excel 文件没有工作表");
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
    header: 1,
    raw: false,
    blankrows: false,
    defval: "",
  });
  if (!matrix.length) throw new Error("Excel 文件为空");
  const headers = matrix[0].map((value) => cellText(value) || "");
  const cvIndex = headers.indexOf("CV_ID");
  if (cvIndex < 0) throw new Error("Excel 缺少 CV_ID 列");
  const candidates: ImportCandidate[] = [];
  let current: ImportCandidate | null = null;
  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex] || [];
    const cvId = cellText(row[cvIndex]);
    if (cvId) {
      if (!/^\d+$/.test(cvId)) throw new Error(`第 ${rowIndex + 1} 行 CV_ID 格式无效`);
      current = { cvId, name: null, fields: {}, sourceRows: [] };
      candidates.push(current);
    }
    if (!current) continue;
    let hasValue = false;
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      const header = headers[columnIndex];
      const value = cellText(row[columnIndex]);
      if (!header || !value) continue;
      appendField(current.fields, header, value);
      hasValue = true;
    }
    if (hasValue) current.sourceRows.push(rowIndex + 1);
    current.name = cellText(current.fields.Name) || current.name;
  }
  return candidates;
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true, decodeStrings: true }, (error, zipFile) => {
      if (error || !zipFile) reject(error || new Error("ZIP 文件无法打开"));
      else resolve(zipFile);
    });
  });
}

function openEntryStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error || new Error("ZIP 条目无法读取"));
      else resolve(stream);
    });
  });
}

async function inspectPdfEntry(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<boolean> {
  const stream = await openEntryStream(zipFile, entry);
  return await new Promise<boolean>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    stream.on("data", (chunk: Buffer) => {
      if (length < 8) {
        chunks.push(chunk.subarray(0, 8 - length));
        length += Math.min(chunk.length, 8 - length);
      }
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).subarray(0, 5).toString("ascii") === "%PDF-"));
    stream.on("error", reject);
  });
}

export async function inspectZipPdfs(filePath: string): Promise<ZipPdf[]> {
  const zipFile = await openZip(filePath);
  return await new Promise<ZipPdf[]>((resolve, reject) => {
    const entries: ZipPdf[] = [];
    let totalSize = 0;
    zipFile.on("entry", async (entry: yauzl.Entry) => {
      try {
        if (/\/$/.test(entry.fileName)) {
          zipFile.readEntry();
          return;
        }
        if (entry.uncompressedSize > maxEntryBytes) throw new Error("ZIP 中存在超过25MB的单个文件");
        totalSize += entry.uncompressedSize;
        if (totalSize > maxTotalUncompressedBytes) throw new Error("ZIP 解压后总大小超过250MB限制");
        if (!/\.pdf$/i.test(entry.fileName)) {
          zipFile.readEntry();
          return;
        }
        const cvId = entry.fileName.match(/cv(\d+)/i)?.[1] || "";
        const validPdf = await inspectPdfEntry(zipFile, entry);
        entries.push({
          fileName: entry.fileName,
          cvId,
          validPdf,
          uncompressedSize: entry.uncompressedSize,
        });
        zipFile.readEntry();
      } catch (error) {
        zipFile.close();
        reject(error);
      }
    });
    zipFile.on("end", () => resolve(entries));
    zipFile.on("error", reject);
    zipFile.readEntry();
  });
}

function writeBatch(batch: ImportBatchView): void {
  fs.mkdirSync(batchesDirectory, { recursive: true, mode: 0o700 });
  const filePath = path.join(batchesDirectory, `${batch.id}.json`);
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(batch, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function publicBatch(batch: ImportBatchView, includeMatches = true): ImportBatchView {
  const { files: _files, ...rest } = batch;
  return includeMatches ? rest : { ...rest, matches: [] };
}

export class ImportService {
  private readonly peopleRepository: PeopleRepository;

  constructor(peopleRepository: PeopleRepository) {
    this.peopleRepository = peopleRepository;
    fs.mkdirSync(batchesDirectory, { recursive: true, mode: 0o700 });
  }

  async initializeBuiltInSample(): Promise<void> {
    const sampleId = "BAYT-SAMPLE";
    if (fs.existsSync(path.join(batchesDirectory, `${sampleId}.json`))) return;
    if (!fs.existsSync(config.sampleExcelPath) || !fs.existsSync(config.sampleZipPath)) return;
    const batch = await this.preflight(
      config.sampleExcelPath,
      config.sampleZipPath,
      "2026-08-21 50人验证批次",
      "BUILT_IN_SAMPLE",
      sampleId,
      false,
    );
    writeBatch(batch);
  }

  async preflight(
    excelPath: string,
    zipPath: string,
    name: string,
    source: "BUILT_IN_SAMPLE" | "USER_UPLOAD" | "LOCAL_COLLECTOR" = "USER_UPLOAD",
    requestedId?: string,
    retainFiles = true,
  ): Promise<ImportBatchView> {
    const candidates = parseExcelCandidates(excelPath);
    const pdfs = await inspectZipPdfs(zipPath);
    const id = requestedId || `BAYT-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const candidateCounts = new Map<string, number>();
    for (const candidate of candidates) candidateCounts.set(candidate.cvId, (candidateCounts.get(candidate.cvId) || 0) + 1);
    const duplicatedCvIds = [...candidateCounts].filter(([, count]) => count > 1).map(([cvId]) => cvId);
    const pdfByCvId = new Map<string, ZipPdf>();
    for (const pdf of pdfs) if (pdf.cvId && !pdfByCvId.has(pdf.cvId)) pdfByCvId.set(pdf.cvId, pdf);
    const matches: ImportMatch[] = candidates.map((candidate) => {
      const pdf = pdfByCvId.get(candidate.cvId);
      return {
        cvId: candidate.cvId,
        displayName: candidate.name,
        pdfFile: pdf?.fileName || null,
        method: pdf ? "CV_ID_EXACT" : "MISSING",
        status: pdf && pdf.validPdf ? "SUCCESS" : "MISSING",
      };
    });
    const candidateIds = new Set(candidates.map((candidate) => candidate.cvId));
    const extraPdfs = [...pdfByCvId.keys()].filter((cvId) => !candidateIds.has(cvId));
    const invalidPdfs = pdfs.filter((pdf) => !pdf.cvId || !pdf.validPdf);
    const issues: ImportBatchView["issues"] = [];
    if (duplicatedCvIds.length) {
      issues.push({ level: "BLOCKING", code: "DUPLICATED_CV_ID_BLOCKING", message: `发现 ${duplicatedCvIds.length} 个重复 CV_ID` });
    }
    if (invalidPdfs.length) {
      issues.push({ level: "BLOCKING", code: "PDF_INVALID", message: `发现 ${invalidPdfs.length} 个无效或无法识别的 PDF` });
    }
    const missingCount = matches.filter((match) => match.status === "MISSING").length;
    if (missingCount) {
      issues.push({ level: "WARNING", code: "ATTACHMENT_MISSING", message: `${missingCount} 个人物缺少对应 PDF，可按部分成功导入` });
    }
    if (extraPdfs.length) {
      issues.push({ level: "WARNING", code: "ATTACHMENT_EXTRA", message: `ZIP 中有 ${extraPdfs.length} 份 PDF 未匹配 Excel 人物` });
    }

    let retainedExcel = excelPath;
    let retainedZip = zipPath;
    if (retainFiles) {
      const batchDirectory = path.join(batchesDirectory, id);
      fs.mkdirSync(batchDirectory, { recursive: true, mode: 0o700 });
      retainedExcel = path.join(batchDirectory, "source.xls");
      retainedZip = path.join(batchDirectory, "attachments.zip");
      fs.copyFileSync(excelPath, retainedExcel);
      fs.copyFileSync(zipPath, retainedZip);
      fs.chmodSync(retainedExcel, 0o600);
      fs.chmodSync(retainedZip, 0o600);
    }
    const batch: ImportBatchView = {
      id,
      name,
      status: "READY",
      excelPersonCount: candidates.length,
      excelUniqueCvIdCount: candidateCounts.size,
      attachmentCount: pdfs.length,
      attachmentUniqueCvIdCount: pdfByCvId.size,
      matchedCount: matches.filter((match) => match.status === "SUCCESS").length,
      missingAttachmentCount: missingCount,
      extraAttachmentCount: extraPdfs.length,
      duplicatedCvIdCount: duplicatedCvIds.length,
      invalidPdfCount: invalidPdfs.length,
      createdAt: new Date().toISOString(),
      source,
      matches,
      issues,
      files: { excelPath: retainedExcel, zipPath: retainedZip },
    };
    if (retainFiles) writeBatch(batch);
    return batch;
  }

  list(): ImportBatchView[] {
    if (!fs.existsSync(batchesDirectory)) return [];
    return fs
      .readdirSync(batchesDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(batchesDirectory, name), "utf8")) as ImportBatchView)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((batch) => publicBatch(batch, false));
  }

  get(id: string, includeFiles = false): ImportBatchView | null {
    if (!/^[A-Z0-9-]+$/i.test(id)) return null;
    const filePath = path.join(batchesDirectory, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    const batch = JSON.parse(fs.readFileSync(filePath, "utf8")) as ImportBatchView;
    return includeFiles ? batch : publicBatch(batch);
  }

  async commit(id: string): Promise<ImportBatchView> {
    const batch = this.get(id, true);
    if (!batch?.files) throw new Error("批次文件不存在或不可提交");
    if (batch.issues.some((issue) => issue.level === "BLOCKING")) throw new Error("批次存在阻塞错误，不能提交");
    if (batch.source === "BUILT_IN_SAMPLE") throw new Error("内置验证批次只用于预检展示，请上传文件后提交");
    const candidates = parseExcelCandidates(batch.files.excelPath);
    const successfulMatches = new Map(
      batch.matches.filter((match) => match.status === "SUCCESS" && match.pdfFile).map((match) => [match.cvId, match.pdfFile as string]),
    );
    const importedAt = new Date().toISOString();
    const people: PersonView[] = [];
    await extractSelectedPdfs(batch.files.zipPath, successfulMatches);
    for (const candidate of candidates) {
      const pdfName = successfulMatches.get(candidate.cvId);
      if (!pdfName) continue;
      people.push(createImportedPerson(candidate.cvId, candidate.name, candidate.fields, pdfName, importedAt));
    }
    this.peopleRepository.saveImportedPeople(people);
    batch.status = "COMPLETED";
    batch.completedAt = importedAt;
    writeBatch(batch);
    return publicBatch(batch);
  }
}

async function extractSelectedPdfs(zipPath: string, selected: Map<string, string>): Promise<void> {
  const names = new Map([...selected].map(([cvId, fileName]) => [fileName, cvId]));
  const zipFile = await openZip(zipPath);
  await new Promise<void>((resolve, reject) => {
    zipFile.on("entry", async (entry: yauzl.Entry) => {
      try {
        const cvId = names.get(entry.fileName);
        if (!cvId) {
          zipFile.readEntry();
          return;
        }
        const destinationDirectory = path.join(config.runtimeDirectory, "imported", cvId);
        fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
        const destinationPath = path.join(destinationDirectory, "bayt_pdf.pdf");
        const temporaryPath = `${destinationPath}.tmp`;
        const input = await openEntryStream(zipFile, entry);
        const output = fs.createWriteStream(temporaryPath, { mode: 0o600 });
        input.pipe(output);
        output.on("finish", () => {
          fs.renameSync(temporaryPath, destinationPath);
          names.delete(entry.fileName);
          zipFile.readEntry();
        });
        output.on("error", reject);
        input.on("error", reject);
      } catch (error) {
        reject(error);
      }
    });
    zipFile.on("end", () => {
      if (names.size) reject(new Error(`有 ${names.size} 份已匹配 PDF 未能解压`));
      else resolve();
    });
    zipFile.on("error", reject);
    zipFile.readEntry();
  });
}
