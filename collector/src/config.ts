/**
 * 采集器的集中配置。
 * 初学者语法：`process.env.NAME` 读取环境变量；`||` 在左边为空时使用默认值；
 * `path.resolve/join` 用跨平台方式组合绝对路径，避免手写斜杠。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

// ES Module没有CommonJS里的__dirname，所以从当前模块URL反推出目录。
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// 项目、数据、诊断、抓包和发布目录。环境变量可覆盖默认位置。
export const PROJECT_ROOT = path.resolve(moduleDir, "..");
export const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, "..");
export const DATA_ROOT = path.resolve(
  process.env.BAYT_DATA_ROOT || path.join(WORKSPACE_ROOT, "data"),
);
export const DATABASE_PATH = path.join(DATA_ROOT, "collection.db");
export const BROWSER_PROFILE_DIR = path.resolve(
  process.env.BAYT_BROWSER_PROFILE_DIR || path.join(DATA_ROOT, "browser-profile"),
);
export const DIAGNOSTICS_DIR = path.join(DATA_ROOT, "diagnostics");
export const RUNS_DIR = path.join(DATA_ROOT, "runs");
export const CANDIDATES_DIR = path.join(DATA_ROOT, "candidates");
export const CAPTURES_DIR = path.resolve(
  process.env.BAYT_CAPTURES_ROOT || path.join(DATA_ROOT, "captures"),
);
export const CONTROL_DATABASE_PATH = path.resolve(
  process.env.BAYT_CONTROL_DB || path.join(DATA_ROOT, "control.db"),
);
export const PUBLISH_ROOT = path.resolve(
  process.env.BAYT_PUBLISH_ROOT || path.join(DATA_ROOT, "published"),
);

// Bayt入口地址及浏览器选择。这里只保存公开URL，不保存Cookie或账号密码。
export const BAYT_HOME_URL = "https://www.bayt.com/";
export const BAYT_EMPLOYER_LOGIN_URL = "https://www.bayt.com/en/employers/login/";
export const BAYT_SEARCH_URL = "https://www.bayt.com/en/employers/cv-search/";
export const BROWSER_CHANNEL = process.env.BAYT_BROWSER_CHANNEL?.trim() || "chrome";
export const ALLOW_BUNDLED_BROWSER_FALLBACK =
  process.env.BAYT_ALLOW_BUNDLED_BROWSER_FALLBACK === "1";

// 本地采集的默认规模、预检规模和重试次数。
export const DEFAULT_QUERY = "Software Engineer";
export const DEFAULT_TARGET = 500;
export const PREFLIGHT_TARGET = 10;
export const MAX_RETRIES = 3;

// Math.max设置不可低于的安全间隔；即使环境变量填得更小，也会保留最低值。
export const CANDIDATE_MIN_INTERVAL_MS = Math.max(
  20_000,
  Number(process.env.BAYT_CANDIDATE_INTERVAL_MS || 20_000),
);
export const BATCH_MIN_INTERVAL_MS = Math.max(
  120_000,
  Number(process.env.BAYT_BATCH_INTERVAL_MS || 120_000),
);

// 控制面和 Windows Agent 之间的连接配置。
export const CONTROL_PLANE_URL = (process.env.BAYT_CONTROL_PLANE_URL || "").replace(/\/$/, "");
export const CONTROL_PLANE_TOKEN = process.env.BAYT_CONTROL_PLANE_TOKEN || "";
export const ALLOW_INSECURE_CONTROL_PLANE = process.env.BAYT_ALLOW_INSECURE_CONTROL_PLANE === "1";
export const WINDOWS_AGENT_ID = process.env.BAYT_WINDOWS_AGENT_ID || "windows-agent";
export const WINDOWS_AGENT_NAME = process.env.BAYT_WINDOWS_AGENT_NAME || "Windows采集节点";
export const WINDOWS_CDP_ENDPOINT = process.env.BAYT_WINDOWS_CDP_ENDPOINT || "http://127.0.0.1:19229";
export const WINDOWS_DATA_ROOT = path.resolve(process.env.BAYT_WINDOWS_DATA_ROOT || (process.platform === "win32" ? "D:\\bayt" : path.join(DATA_ROOT, "windows-agent")));

// Windows Agent的心跳/登录检查与两类低频间隔，全部使用毫秒。
export const WINDOWS_LOGIN_CHECK_INTERVAL_MS = Math.max(10 * 60 * 1000, Number(process.env.BAYT_WINDOWS_LOGIN_CHECK_INTERVAL_MS || 10 * 60 * 1000));
export const PAGE_INTERVAL_MIN_MS = Math.max(60 * 60 * 1000, Number(process.env.BAYT_PAGE_INTERVAL_MIN_MS || 60 * 60 * 1000));
export const PAGE_INTERVAL_MAX_MS = Math.max(PAGE_INTERVAL_MIN_MS, Number(process.env.BAYT_PAGE_INTERVAL_MAX_MS || 70 * 60 * 1000));
export const EXPORT_INTERVAL_MIN_MS = Math.max(15 * 60 * 1000, Number(process.env.BAYT_EXPORT_INTERVAL_MIN_MS || 15 * 60 * 1000));
export const EXPORT_INTERVAL_MAX_MS = Math.max(EXPORT_INTERVAL_MIN_MS, Number(process.env.BAYT_EXPORT_INTERVAL_MAX_MS || 20 * 60 * 1000));

// 外部工具路径：LibreOffice负责Office转PDF，Poppler负责检查/渲染PDF。
// `条件 ? A : B` 是三元表达式：条件成立取A，否则取B。
export const SOFFICE_PATH =
  process.env.SOFFICE_PATH ||
  "soffice";
export const PDFINFO_PATH =
  process.env.PDFINFO_PATH ||
  "pdfinfo";
export const PDFTOPPM_PATH =
  process.env.PDFTOPPM_PATH ||
  "pdftoppm";

// 用正则表达式识别当前页面是否是候选人详情页或登录页。
export const PROFILE_URL_PATTERN = /\/en\/employers\/cv-search\/profile\//;
export const LOGIN_URL_PATTERN = /\/en\/employers\/login\//;

// 所有时间统一写成ISO 8601字符串，便于数据库排序和跨时区传输。
export const nowIso = (): string => new Date().toISOString();
