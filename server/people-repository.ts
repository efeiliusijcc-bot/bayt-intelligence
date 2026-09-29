import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import type {
  AttachmentKind,
  AttachmentView,
  EducationItem,
  ExperienceItem,
  LanguageItem,
  PersonView,
  SkillItem,
  StoredAttachment,
} from "./types.ts";

interface CandidateRow {
  cv_id: string;
  name: string | null;
  last_cv_update: string | null;
  excel_json: string | null;
  web_json: string | null;
  avatar_status: "photo" | "placeholder" | "missing";
}

interface DocumentRow {
  cv_id: string;
  kind: AttachmentKind | "avatar";
  original_name: string | null;
  mime_type: string | null;
  path: string | null;
  size_bytes: number | null;
  status: string;
}

interface ExcelPayload {
  lastCvUpdate?: string | null;
  fields?: Record<string, string | string[]>;
}

interface PeopleRepositoryOptions {
  includeImported?: boolean;
}

function valueList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function firstValue(fields: Record<string, string | string[]>, key: string): string | null {
  return valueList(fields[key])[0] || null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function splitLabel(raw: string): { name: string; level?: string } {
  const match = raw.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  return match ? { name: match[1].trim(), level: match[2].trim() } : { name: raw.trim() };
}

function buildSkills(fields: Record<string, string | string[]>): SkillItem[] {
  const seen = new Set<string>();
  return valueList(fields.Skills)
    .map(splitLabel)
    .filter((skill) => {
      const key = skill.name.toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((skill) => ({ ...skill, source: "EXCEL" as const }));
}

function buildLanguages(fields: Record<string, string | string[]>): LanguageItem[] {
  return valueList(fields.Languages).map((language) => ({ ...splitLabel(language), source: "EXCEL" }));
}

function buildEducations(fields: Record<string, string | string[]>): EducationItem[] {
  return valueList(fields.Education).map((description) => ({ description, source: "EXCEL" }));
}

function buildExperiences(fields: Record<string, string | string[]>): ExperienceItem[] {
  const organizations = valueList(fields.Experience);
  const positions = valueList(fields.Position);
  const years = valueList(fields["Years Exp"]);
  return organizations.map((organization, index) => ({
    organization,
    position: positions[index] || positions[Math.min(index, positions.length - 1)] || undefined,
    years: years[index] || undefined,
    source: "EXCEL",
  }));
}

function extractSummary(webJson: string | null): string | null {
  const payload = parseJson<{ text?: string }>(webJson, {});
  const text = payload.text || "";
  const match = text.match(/Personal summary:\s*\n([\s\S]*?)\n\nPersonal information/i);
  if (!match) return null;
  return match[1].replace(/\s+/g, " ").trim().slice(0, 1200) || null;
}

function attachmentLabel(kind: AttachmentKind): string {
  if (kind === "bayt_pdf") return "Bayt 生成简历";
  if (kind === "original_pdf") return "原始简历 PDF 转换版";
  return "候选人原始简历";
}

function toAttachment(document: DocumentRow): StoredAttachment {
  const previewable =
    document.status === "downloaded" &&
    Boolean(document.path) &&
    (document.mime_type === "application/pdf" || document.kind === "original_pdf");
  return {
    id: `${document.cv_id}:${document.kind}`,
    cvId: document.cv_id,
    kind: document.kind as AttachmentKind,
    label: attachmentLabel(document.kind as AttachmentKind),
    mimeType: document.mime_type,
    sizeBytes: document.size_bytes,
    status: document.status,
    previewable,
    originalName: document.original_name,
    path: document.path,
  };
}

function buildPerson(
  candidate: CandidateRow,
  documents: DocumentRow[],
  importedAt: string | null = null,
): PersonView {
  const excel = parseJson<ExcelPayload>(candidate.excel_json, {});
  const fields = excel.fields || {};
  const skills = buildSkills(fields);
  const attachments = documents
    .filter((document) => document.kind !== "avatar")
    .map(toAttachment)
    .map(({ path: _path, cvId: _cvId, ...view }) => view);
  const avatar = documents.find((document) => document.kind === "avatar" && document.status === "downloaded");
  return {
    id: candidate.cv_id,
    cvId: candidate.cv_id,
    displayName: candidate.name || firstValue(fields, "Name") || `CV ${candidate.cv_id}`,
    headline: firstValue(fields, "Status"),
    nationality: firstValue(fields, "Nationality"),
    residence: firstValue(fields, "Residence"),
    lastCvUpdate: excel.lastCvUpdate || candidate.last_cv_update,
    topSkills: skills.slice(0, 6),
    skills,
    experiences: buildExperiences(fields),
    educations: buildEducations(fields),
    languages: buildLanguages(fields),
    summary: extractSummary(candidate.web_json),
    avatarStatus: candidate.avatar_status,
    hasAvatar: Boolean(avatar?.path),
    attachments,
    professionalScore: null,
    researchPriorityScore: null,
    enrichmentStatus: "NOT_CONFIGURED",
    sourceTags: candidate.web_json ? ["EXCEL", "BAYT_PROFILE"] : ["EXCEL"],
    importedAt,
  };
}

function withinAllowedDataPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const allowedRoots = [path.resolve(config.candidatesDirectory), path.resolve(config.runtimeDirectory)];
  return allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function resolveStoredDocumentPath(document: DocumentRow): string | null {
  if (!document.path || !/^\d+$/.test(document.cv_id)) return null;
  const directPath = path.resolve(document.path);
  if (withinAllowedDataPath(directPath) && fs.existsSync(directPath)) return directPath;

  const relocatedPath = path.join(
    path.resolve(config.candidatesDirectory),
    document.cv_id,
    path.basename(document.path),
  );
  if (withinAllowedDataPath(relocatedPath) && fs.existsSync(relocatedPath)) return relocatedPath;
  return null;
}

function normalizeDocument(document: DocumentRow): DocumentRow {
  return { ...document, path: resolveStoredDocumentPath(document) };
}

export class PeopleRepository {
  private database: DatabaseSync | null = null;
  private databaseRealPath: string | null = null;
  private readonly importedPeoplePath: string;
  private readonly includeImported: boolean;

  constructor(options: PeopleRepositoryOptions = {}) {
    this.importedPeoplePath = path.join(config.runtimeDirectory, "imported", "people.json");
    this.includeImported = options.includeImported ?? true;
    this.refreshDatabase();
  }

  private refreshDatabase(): void {
    const realPath = fs.existsSync(config.collectionDbPath) ? fs.realpathSync(config.collectionDbPath) : null;
    if (realPath === this.databaseRealPath) return;
    this.database?.close();
    this.database = realPath ? new DatabaseSync(realPath, { readOnly: true }) : null;
    this.databaseRealPath = realPath;
  }

  list(): PersonView[] {
    this.refreshDatabase();
    const people = new Map<string, PersonView>();
    if (this.database) {
      const candidates = this.database
        .prepare(
          `SELECT cv_id, name, last_cv_update, excel_json, web_json, avatar_status
           FROM candidates ORDER BY name COLLATE NOCASE, cv_id`,
        )
        .all() as unknown as CandidateRow[];
      const documents = this.database
        .prepare(
          `SELECT cv_id, kind, original_name, mime_type, path, size_bytes, status
           FROM documents ORDER BY cv_id, kind`,
        )
        .all() as unknown as DocumentRow[];
      const normalizedDocuments = documents.map(normalizeDocument);
      for (const candidate of candidates) {
        people.set(
          candidate.cv_id,
          buildPerson(
            candidate,
            normalizedDocuments.filter((document) => document.cv_id === candidate.cv_id),
          ),
        );
      }
    }
    if (this.includeImported && fs.existsSync(this.importedPeoplePath)) {
      const imported = parseJson<PersonView[]>(fs.readFileSync(this.importedPeoplePath, "utf8"), []);
      for (const person of imported) if (!people.has(person.cvId)) people.set(person.cvId, person);
    }
    return [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  get(cvId: string): PersonView | null {
    return this.list().find((person) => person.cvId === cvId) || null;
  }

  getAttachment(attachmentId: string): StoredAttachment | null {
    this.refreshDatabase();
    const separator = attachmentId.indexOf(":");
    if (separator < 1) return null;
    const cvId = attachmentId.slice(0, separator);
    const kind = attachmentId.slice(separator + 1) as AttachmentKind;
    if (!(["bayt_pdf", "original", "original_pdf"] as string[]).includes(kind)) return null;
    if (this.database) {
      const row = this.database
        .prepare(
          `SELECT cv_id, kind, original_name, mime_type, path, size_bytes, status
           FROM documents WHERE cv_id = ? AND kind = ?`,
        )
        .get(cvId, kind) as unknown as DocumentRow | undefined;
      if (row) {
        const attachment = toAttachment(normalizeDocument(row));
        if (!attachment.path || !withinAllowedDataPath(attachment.path)) return null;
        return attachment;
      }
    }
    const imported = this.get(cvId);
    const view = imported?.attachments.find((attachment) => attachment.id === attachmentId);
    if (!view) return null;
    const importedPath = path.join(config.runtimeDirectory, "imported", cvId, `${kind}.pdf`);
    if (!fs.existsSync(importedPath) || !withinAllowedDataPath(importedPath)) return null;
    return { ...view, cvId, path: importedPath };
  }

  getAvatar(cvId: string): string | null {
    this.refreshDatabase();
    if (this.database) {
      const row = this.database
        .prepare(
          `SELECT cv_id, kind, original_name, mime_type, path, size_bytes, status
           FROM documents WHERE cv_id = ? AND kind = 'avatar' AND status = 'downloaded'`,
        )
        .get(cvId) as unknown as DocumentRow | undefined;
      if (row) return resolveStoredDocumentPath(row);
    }
    return null;
  }

  saveImportedPeople(people: PersonView[]): void {
    fs.mkdirSync(path.dirname(this.importedPeoplePath), { recursive: true, mode: 0o700 });
    const existing = fs.existsSync(this.importedPeoplePath)
      ? parseJson<PersonView[]>(fs.readFileSync(this.importedPeoplePath, "utf8"), [])
      : [];
    const merged = new Map(existing.map((person) => [person.cvId, person]));
    for (const person of people) merged.set(person.cvId, person);
    const persisted = [...merged.values()].sort((left, right) => left.cvId.localeCompare(right.cvId));
    const temporaryPath = `${this.importedPeoplePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, this.importedPeoplePath);
  }
}

export function createImportedPerson(
  cvId: string,
  name: string | null,
  fields: Record<string, string | string[]>,
  pdfName: string,
  importedAt: string,
): PersonView {
  const candidate: CandidateRow = {
    cv_id: cvId,
    name,
    last_cv_update: firstValue(fields, "Last CV Update"),
    excel_json: JSON.stringify({ lastCvUpdate: firstValue(fields, "Last CV Update"), fields }),
    web_json: null,
    avatar_status: "missing",
  };
  const document: DocumentRow = {
    cv_id: cvId,
    kind: "bayt_pdf",
    original_name: pdfName,
    mime_type: "application/pdf",
    path: path.join(config.runtimeDirectory, "imported", cvId, "bayt_pdf.pdf"),
    size_bytes: null,
    status: "downloaded",
  };
  return buildPerson(candidate, [document], importedAt);
}
