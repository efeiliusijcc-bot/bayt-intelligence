/**
 * 本文件只定义“数据长什么样”，不执行采集。
 * 初学者语法：`type` 用来声明类型别名；`interface` 描述对象必须有哪些字段；
 * `export` 表示其他文件可以 `import` 这些类型；`A | B` 表示值可以是 A 或 B。
 */

// 一次完整采集任务可能经历的状态。把状态限定成固定字符串，可避免拼写错误。
export type RunStatus =
  | "created"
  | "running"
  | "login_required"
  | "paused"
  | "completed"
  | "failed";

// 单个候选人或文件的处理状态，与上面的“整次任务状态”分开管理。
export type ItemStatus =
  | "pending"
  | "running"
  | "downloaded"
  | "not_available"
  | "skipped"
  | "failed";

// 保存到本地的文档类别。后续数据库和报告都使用这些稳定标识。
export type DocumentKind =
  | "bayt_pdf"
  | "original"
  | "original_pdf"
  | "avatar";

/** 搜索结果列表里能直接看到的候选人摘要。 */
export interface ListingCandidate {
  cvId: string;
  name: string;
  profileUrl: string;
  lastCvUpdate: string | null;
  avatarStatus: "photo" | "placeholder" | "missing";
  avatarUrl: string | null;
  listingText: string;
  pageNo: number;
  ordinal: number;
}

/** 从Bayt导出的Excel归并出来的一名候选人。`string[]`表示同一字段可能有多行值。 */
export interface ExcelCandidate {
  cvId: string;
  name: string | null;
  profileUrl: string | null;
  lastCvUpdate: string | null;
  fields: Record<string, string | string[]>;
  sourceRows: number[];
}

/** candidates数据库表对应的领域对象。`null`表示该字段目前未知或不存在。 */
export interface CandidateRecord {
  cvId: string;
  name: string | null;
  profileUrl: string | null;
  lastCvUpdate: string | null;
  excelJson: string | null;
  webJson: string | null;
  contentHash: string | null;
  avatarStatus: "photo" | "placeholder" | "missing";
  avatarUrl: string | null;
  avatarHash: string | null;
}

/** 一次采集运行的进度和结果。 */
export interface RunRecord {
  runId: string;
  command: string;
  query: string;
  targetCount: number;
  status: RunStatus;
  searchId: string | null;
  filtersJson: string | null;
  currentPage: number;
  uniqueCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}

/** 一份已下载文件在数据库中的索引；文件内容本身保存在磁盘。 */
export interface DocumentRecord {
  cvId: string;
  runId: string;
  kind: DocumentKind;
  originalName: string | null;
  mimeType: string | null;
  extension: string | null;
  path: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  status: ItemStatus;
  error: string | null;
}

/** 文件成功落盘后返回的校验信息。 */
export interface DownloadedFile {
  path: string;
  originalName: string;
  mimeType: string | null;
  extension: string;
  sha256: string;
  sizeBytes: number;
}

/** 从候选人详情页解析出的结构化内容。`Record<K, V>`表示键值对象。 */
export interface ParsedProfile {
  cvId: string;
  text: string;
  sections: Record<string, string>;
  viewedAt: string;
}
