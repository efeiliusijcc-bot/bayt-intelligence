export type SourceType = "EXCEL" | "BAYT_PROFILE" | "PDF" | "MANUAL";

export interface SkillItem {
  name: string;
  level?: string;
  source: SourceType;
}

export interface ExperienceItem {
  organization: string;
  position?: string;
  years?: string;
  source: SourceType;
}

export interface EducationItem {
  description: string;
  source: SourceType;
}

export interface LanguageItem {
  name: string;
  level?: string;
  source: SourceType;
}

export type AttachmentKind = "bayt_pdf" | "original" | "original_pdf";

export interface AttachmentView {
  id: string;
  kind: AttachmentKind;
  label: string;
  mimeType: string | null;
  sizeBytes: number | null;
  status: string;
  previewable: boolean;
  originalName: string | null;
  pageCount?: number | null;
}

export interface PersonView {
  id: string;
  cvId: string;
  displayName: string;
  headline: string | null;
  nationality: string | null;
  residence: string | null;
  lastCvUpdate: string | null;
  topSkills: SkillItem[];
  skills: SkillItem[];
  experiences: ExperienceItem[];
  educations: EducationItem[];
  languages: LanguageItem[];
  summary: string | null;
  avatarStatus: "photo" | "placeholder" | "missing";
  hasAvatar: boolean;
  attachments: AttachmentView[];
  professionalScore: number | null;
  researchPriorityScore: number | null;
  enrichmentStatus:
    | "NOT_CONFIGURED"
    | "NOT_ELIGIBLE"
    | "SCORED_ONLY"
    | "WAITING_PROVIDER"
    | "DEFERRED_BUDGET"
    | "QUEUED"
    | "SEARCHING"
    | "VERIFIED"
    | "NO_RELIABLE_RESULT"
    | "WRONG_PERSON"
    | "REVIEW_REQUIRED"
    | "CONFLICT"
    | "FAILED";
  sourceTags: SourceType[];
  importedAt: string | null;
  collectionTasks?: Array<{ id: string; name: string; page: number; importedAt: string }>;
}

export interface StoredAttachment extends AttachmentView {
  cvId: string;
  path: string | null;
}

export interface ImportCandidate {
  cvId: string;
  name: string | null;
  fields: Record<string, string | string[]>;
  sourceRows: number[];
}

export interface ImportMatch {
  cvId: string;
  displayName: string | null;
  pdfFile: string | null;
  method: "CV_ID_EXACT" | "MISSING";
  status: "SUCCESS" | "MISSING";
}

export interface ImportBatchView {
  id: string;
  name: string;
  status: "READY" | "COMPLETED" | "FAILED";
  excelPersonCount: number;
  excelUniqueCvIdCount: number;
  attachmentCount: number;
  attachmentUniqueCvIdCount: number;
  matchedCount: number;
  missingAttachmentCount: number;
  extraAttachmentCount: number;
  duplicatedCvIdCount: number;
  invalidPdfCount: number;
  createdAt: string;
  completedAt?: string;
  source: "BUILT_IN_SAMPLE" | "USER_UPLOAD" | "LOCAL_COLLECTOR";
  matches: ImportMatch[];
  issues: Array<{ level: "BLOCKING" | "WARNING"; code: string; message: string }>;
  files?: { excelPath: string; zipPath: string };
}
