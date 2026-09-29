/**
 * Bayt Excel解析器：把二维单元格矩阵归并为“每个CV_ID一条记录”。
 * Bayt的一名候选人可能占多行，因此不能简单地把每一行当成一个人。
 */
import fs from "node:fs";
import * as XLSX from "@e965/xlsx";
import type { ExcelCandidate } from "./types.ts";

// The ESM build does not auto-bind Node's filesystem adapter. Without this,
// readFile works in some bundled environments but fails in the Windows Agent.
XLSX.set_fs(fs);

/** 把任意单元格值安全转换成去空格文本；空值统一为null。 */
function cellText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

/**
 * 向动态字段对象追加值：第一次存字符串，出现不同的重复字段时升级为字符串数组。
 * `Record<string, ...>`表示键名在运行时才知道的普通对象。
 */
function appendField(
  fields: Record<string, string | string[]>,
  header: string,
  value: string,
): void {
  const current = fields[header];
  if (current === undefined) {
    fields[header] = value;
    return;
  }
  if (Array.isArray(current)) {
    if (!current.includes(value)) current.push(value);
    return;
  }
  if (current !== value) fields[header] = [current, value];
}

/** 解析二维表，识别新CV_ID行，并把其后的续行并入当前候选人。 */
export function normalizeExcelMatrix(matrix: unknown[][]): ExcelCandidate[] {
  if (!matrix.length) throw new Error("Excel export is empty");
  const headers = matrix[0].map((value) => cellText(value) || "");
  const cvIndex = headers.indexOf("CV_ID");
  if (cvIndex < 0) throw new Error("Excel export does not contain CV_ID");
  const candidates: ExcelCandidate[] = [];
  let current: ExcelCandidate | null = null;

  // 从1开始是因为第0行是表头；`let`表示变量会在循环中变化。
  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex] || [];
    const cvId = cellText(row[cvIndex]);
    if (cvId) {
      // 有CV_ID代表一名新候选人的起始行。
      if (!/^\d+$/.test(cvId)) throw new Error(`Invalid CV_ID in row ${rowIndex + 1}: ${cvId}`);
      current = {
        cvId,
        name: null,
        profileUrl: null,
        lastCvUpdate: null,
        fields: {},
        sourceRows: [],
      };
      candidates.push(current);
    }
    // 没见到首个CV_ID前的空白/说明行直接跳过。
    if (!current) continue;
    let hasValue = false;
    // 遍历这一行的每一列，将非空值按表头写入fields。
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      const header = headers[columnIndex];
      const value = cellText(row[columnIndex]);
      if (!header || value === null) continue;
      hasValue = true;
      appendField(current.fields, header, value);
    }
    if (hasValue) current.sourceRows.push(rowIndex + 1);
    current.name = cellText(current.fields.Name) || current.name;
    current.profileUrl = cellText(current.fields["CV Link"]) || current.profileUrl;
    current.lastCvUpdate = cellText(current.fields["Last CV Update"]) || current.lastCvUpdate;
  }

  // 同一份导出中CV_ID必须唯一；filter回调的index与首次位置不同即为重复。
  const duplicateIds = candidates
    .map((candidate) => candidate.cvId)
    .filter((cvId, index, all) => all.indexOf(cvId) !== index);
  if (duplicateIds.length) throw new Error(`Duplicate CV_ID values in Excel export: ${duplicateIds.join(", ")}`);
  return candidates;
}

/** 从磁盘读取第一个工作表，再交给纯函数normalizeExcelMatrix处理。 */
export async function parseExcelExport(inputPath: string): Promise<ExcelCandidate[]> {
  const workbook = XLSX.readFile(inputPath, { cellDates: true, raw: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("Excel export has no worksheets");
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });
  return normalizeExcelMatrix(matrix);
}

/** 比较Excel中的CV_ID与当前网页选中的CV_ID，分别给出缺失项和意外项。 */
export function assertExcelMapping(
  candidates: ExcelCandidate[],
  expectedCvIds: string[],
): { missing: string[]; unexpected: string[] } {
  // Set是“不允许重复值的集合”，适合快速执行has成员判断。
  const actual = new Set(candidates.map((candidate) => candidate.cvId));
  const expected = new Set(expectedCvIds);
  return {
    missing: expectedCvIds.filter((cvId) => !actual.has(cvId)),
    unexpected: candidates.map((candidate) => candidate.cvId).filter((cvId) => !expected.has(cvId)),
  };
}
