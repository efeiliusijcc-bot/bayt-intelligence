import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { verifyIncomingBatch } from "./collector-upload-verifier.ts";
import { ImportService } from "./import-service.ts";
import { PeopleRepository } from "./people-repository.ts";
import { CollectorControlStore } from "./collector-control.ts";

type State = "pending" | "processing" | "displayed" | "blocked";
export interface IncomingBatchStatus {
  runId: string;
  page: number;
  status: State;
  count: number;
  importBatchId: string | null;
  reason: string | null;
  updatedAt: string;
  fingerprint: string | null;
}

const runPattern = /^local-ego-[A-Za-z0-9_-]{1,70}$/;
const batchPattern = /^batch-(\d{4})$/;
const receiptName = (runId: string, page: number) => `${runId}--${String(page).padStart(4, "0")}.json`;
const hash = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = (file: string) => new Promise<string>((resolve, reject) => {
  const digest = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  stream.on("data", (chunk) => digest.update(chunk));
  stream.on("error", reject);
  stream.on("end", () => resolve(digest.digest("hex")));
});
const deterministicId = (runId: string, page: number) => `BAYT-L-${hash(`${runId}/${page}`).slice(0, 24).toUpperCase()}`;

export class IncomingConsumer {
  private busy = false;
  private readonly receipts: string;
  private readonly imports: ImportService;
  private readonly people: PeopleRepository;
  private readonly incomingRoot: string;
  private readonly runtimeRoot: string;
  private readonly remoteRoot: string;
  private readonly verify: typeof verifyIncomingBatch;
  private readonly control: CollectorControlStore | null;

  constructor(imports: ImportService, people: PeopleRepository,
    incomingRoot = config.collectorIncomingRoot,
    runtimeRoot = config.runtimeDirectory,
    remoteRoot = config.collectorIncomingRemoteRoot,
    verify = verifyIncomingBatch,
    control: CollectorControlStore | null = null) {
    this.imports = imports;
    this.people = people;
    this.incomingRoot = incomingRoot;
    this.runtimeRoot = runtimeRoot;
    this.remoteRoot = remoteRoot;
    this.verify = verify;
    this.control = control;
    this.receipts = path.join(runtimeRoot, "incoming-receipts");
    fs.mkdirSync(this.receipts, { recursive: true, mode: 0o700 });
  }

  private receiptPath(runId: string, page: number): string {
    return path.join(this.receipts, receiptName(runId, page));
  }

  private async write(value: IncomingBatchStatus): Promise<void> {
    const file = this.receiptPath(value.runId, value.page);
    const temp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fsp.rename(temp, file);
  }

  private async read(runId: string, page: number): Promise<IncomingBatchStatus | null> {
    try { return JSON.parse(await fsp.readFile(this.receiptPath(runId, page), "utf8")) as IncomingBatchStatus; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  isDisplayed(runId: string, page: number): boolean {
    try {
      const receipt = JSON.parse(fs.readFileSync(this.receiptPath(runId, page), "utf8")) as IncomingBatchStatus;
      return receipt.runId === runId && receipt.page === page && receipt.status === "displayed";
    } catch { return false; }
  }

  async list(): Promise<IncomingBatchStatus[]> {
    const result: IncomingBatchStatus[] = [];
    let runs: string[];
    try { runs = await fsp.readdir(this.incomingRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    for (const runId of runs.filter((name) => runPattern.test(name))) {
      const runPath = path.join(this.incomingRoot, runId);
      if (!(await fsp.lstat(runPath)).isDirectory()) continue;
      for (const batchName of await fsp.readdir(runPath)) {
        const match = batchName.match(batchPattern);
        if (!match) continue;
        const page = Number(match[1]);
        if (page < 1) continue;
        const batchPath = path.join(runPath, batchName);
        if (!(await fsp.lstat(batchPath)).isDirectory()) continue;
        const receipt = await this.read(runId, page);
        if (receipt) result.push(receipt);
        else result.push({ runId, page, status: "pending", count: 0, importBatchId: null,
          reason: null, updatedAt: new Date().toISOString(), fingerprint: null });
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async scan(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const item of await this.list()) {
        const batchPath = path.join(this.incomingRoot, item.runId, `batch-${String(item.page).padStart(4, "0")}`);
        const manifestPath = path.join(batchPath, "manifest.json");
        try {
          const stat = await fsp.lstat(manifestPath);
          if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) throw Error("MANIFEST_INVALID");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            if (item.status === "displayed") await this.block(item, "REMOTE_MANIFEST_DISAPPEARED");
            continue;
          }
          await this.block(item, "MANIFEST_INVALID"); continue;
        }
        await this.process(item, batchPath, manifestPath);
      }
    } finally { this.busy = false; }
  }

  private async block(item: IncomingBatchStatus, reason: string): Promise<void> {
    await this.write({ ...item, status: "blocked", reason, updatedAt: new Date().toISOString() });
    console.error("incoming_batch_blocked", item.runId, item.page, reason);
  }

  private async retry(item: IncomingBatchStatus, reason: string): Promise<void> {
    await this.write({ ...item, status: "pending", reason, updatedAt: new Date().toISOString() });
    console.warn("incoming_batch_retry", item.runId, item.page, reason);
  }

  private async process(item: IncomingBatchStatus, batchPath: string, manifestPath: string): Promise<void> {
    let fingerprint: string | null = null;
    try {
      if ((await fsp.readdir(batchPath)).some((name) => name.endsWith(".part") || name.endsWith(".tmp")))
        throw Error("INCOMPLETE_TRANSFER_PART");
      for (const name of ["source.xls", "bayt-cvs.zip", "manifest.json"]) {
        const stat = await fsp.lstat(path.join(batchPath, name));
        if (!stat.isFile() || stat.size < 1 || stat.size > 30 * 1024 * 1024) throw Error("FILE_SIZE_OR_TYPE_INVALID");
      }
      const raw = await fsp.readFile(manifestPath);
      fingerprint = hash(raw);
      if (item.fingerprint && item.fingerprint !== fingerprint) throw Error("REMOTE_CONTENT_CONFLICT");
      if (item.status === "blocked" && !item.reason?.startsWith("EACCES:")) return;
      const manifest = JSON.parse(raw.toString("utf8")) as Record<string, any>;
      if (manifest.runId !== item.runId || manifest.page !== item.page ||
        manifest.selectedCount < 1 || manifest.selectedCount > 50 ||
        manifest.files?.excel?.name !== "resumes.xls" || manifest.files?.pdfArchive?.name !== "resumes.zip")
        throw Error("MANIFEST_IDENTITY_INVALID");
      const queueJobId = manifest.schemaVersion === 2 ? String(manifest.queueJobId || "") : null;
      if ((manifest.schemaVersion === 2 && (!queueJobId || this.control?.jobForRun(item.runId) !== queueJobId)) ||
        (manifest.schemaVersion !== 2 && manifest.queueJobId)) throw Error("RUN_JOB_LINK_MISMATCH");
      const input = {
        remoteBatch: `${this.remoteRoot.replace(/\/$/, "")}/${item.runId}/batch-${String(item.page).padStart(4, "0")}`,
        page: item.page, selectedCount: manifest.selectedCount, cvIdSetSha256: manifest.cvIdSetSha256,
        excelSha256: manifest.files.excel.sha256, pdfSha256: manifest.files.pdfArchive.sha256,
        pdfEntries: manifest.verification?.pdfEntries,
      };
      if (item.status === "displayed") {
        // A displayed page has already passed XLS/PDF/CRC validation. Recheck its
        // immutable file hashes without reparsing every PDF on every scan.
        const [excelHash, pdfHash] = await Promise.all([
          hashFile(path.join(batchPath, "source.xls")),
          hashFile(path.join(batchPath, "bayt-cvs.zip")),
        ]);
        if (excelHash !== input.excelSha256 || pdfHash !== input.pdfSha256)
          throw Error("DISPLAYED_FILE_HASH_MISMATCH");
      } else await this.verify(input, this.incomingRoot, this.remoteRoot);
      const id = item.importBatchId || deterministicId(item.runId, item.page);
      if (item.status === "displayed") {
        const completed = this.imports.get(id);
        if (!completed || completed.status !== "COMPLETED" || !this.bindingsPresent(completed.matches.map((entry) => entry.cvId)))
          throw Error("DISPLAY_CHECK_FAILED");
        if (queueJobId) this.control!.recordDisplayedPeople({ jobId: queueJobId, runId: item.runId,
          page: item.page, importBatchId: id, cvIds: completed.matches.map((entry) => entry.cvId), importedAt: completed.completedAt });
        return;
      }
      await this.write({ ...item, status: "processing", count: manifest.selectedCount,
        fingerprint, importBatchId: id, reason: null, updatedAt: new Date().toISOString() });
      let batch = this.imports.get(id);
      if (!batch) batch = await this.imports.preflight(path.join(batchPath, "source.xls"),
        path.join(batchPath, "bayt-cvs.zip"), `${item.runId} 第${item.page}页`, "LOCAL_COLLECTOR", id);
      const batchCvIdHash = hash(batch.matches.map((entry) => entry.cvId).sort().join("\n"));
      if (batch.source !== "LOCAL_COLLECTOR" || batchCvIdHash !== manifest.cvIdSetSha256 ||
        batch.excelPersonCount !== manifest.selectedCount || batch.matchedCount !== manifest.selectedCount ||
        batch.missingAttachmentCount || batch.extraAttachmentCount || batch.issues.length) throw Error("PREFLIGHT_NOT_EXACT");
      if (batch.status !== "COMPLETED") batch = await this.imports.commit(id);
      if (!this.bindingsPresent(batch.matches.map((entry) => entry.cvId))) throw Error("PDF_BINDING_CHECK_FAILED");
      if (queueJobId) this.control!.recordDisplayedPeople({ jobId: queueJobId, runId: item.runId,
        page: item.page, importBatchId: id, cvIds: batch.matches.map((entry) => entry.cvId), importedAt: batch.completedAt });
      await this.write({ ...item, status: "displayed", count: manifest.selectedCount,
        fingerprint, importBatchId: id, reason: null, updatedAt: new Date().toISOString() });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 160) : "UNKNOWN_ERROR";
      if (["EACCES", "EPERM", "EBUSY", "EIO", "EMFILE", "ENOENT"].includes((error as NodeJS.ErrnoException).code || "") ||
        reason === "INCOMPLETE_TRANSFER_PART")
        await this.retry({ ...item, fingerprint: fingerprint || item.fingerprint }, reason);
      else await this.block({ ...item, fingerprint: fingerprint || item.fingerprint }, reason);
    }
  }

  private bindingsPresent(ids: string[]): boolean {
    const people = new Map(this.people.list().map((person) => [person.cvId, person]));
    return ids.length > 0 && ids.every((id) => {
      const person = people.get(id);
      const attachment = this.people.getAttachment(`${id}:bayt_pdf`, person);
      return !!person?.attachments.some((file) => file.kind === "bayt_pdf" && file.status === "downloaded") &&
        !!attachment?.path && fs.existsSync(attachment.path);
    });
  }
}
