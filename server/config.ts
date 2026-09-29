import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = path.resolve(projectDirectory, "..");

export const config = {
  projectDirectory,
  workspaceDirectory,
  port: Number(process.env.PORT || 4180),
  host: process.env.HOST || "127.0.0.1",
  collectionDbPath:
    process.env.BAYT_COLLECTION_DB || path.join(workspaceDirectory, "data", "collection.db"),
  candidatesDirectory:
    process.env.BAYT_CANDIDATES_DIR || path.join(workspaceDirectory, "data", "candidates"),
  sampleExcelPath:
    process.env.BAYT_SAMPLE_XLS ||
    path.join(workspaceDirectory, "data", "samples", "candidates.xls"),
  sampleZipPath:
    process.env.BAYT_SAMPLE_ZIP ||
    path.join(workspaceDirectory, "data", "samples", "candidates.zip"),
  runtimeDirectory: process.env.RUNTIME_DIR || path.join(projectDirectory, "runtime"),
  collectorControlDbPath:
    process.env.COLLECTOR_CONTROL_DB || path.join(process.env.RUNTIME_DIR || path.join(projectDirectory, "runtime"), "collector-control.db"),
  collectorIncomingRoot:
    process.env.COLLECTOR_INCOMING_ROOT || path.join(workspaceDirectory, "data", "incoming"),
  collectorIncomingRemoteRoot:
    process.env.COLLECTOR_INCOMING_REMOTE_ROOT || "/incoming",
  previewSecret: process.env.PREVIEW_SECRET || crypto.randomBytes(32).toString("hex"),
  appUser: process.env.APP_USER || "",
  appPassword: process.env.APP_PASSWORD || "",
  collectorApiUrl: process.env.COLLECTOR_API_URL || "",
  collectorApiToken: process.env.COLLECTOR_API_TOKEN || "",
  collectorAgentToken: process.env.COLLECTOR_AGENT_TOKEN || process.env.COLLECTOR_API_TOKEN || "",
  collectorEnabled: process.env.COLLECTOR_ENABLED === "1",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  tavilyEndpoint: process.env.TAVILY_ENDPOINT || "https://api.tavily.com/search",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
  deepseekModel: process.env.DEEPSEEK_MODEL || "",
  researchAutoRun: process.env.RESEARCH_AUTO_RUN === "1",
  production: process.env.NODE_ENV === "production",
};

export function assertProductionConfiguration(): void {
  if (!config.production) return;
  if (!config.appUser || !config.appPassword) {
    throw new Error("Production requires APP_USER and APP_PASSWORD");
  }
  if (!process.env.PREVIEW_SECRET || process.env.PREVIEW_SECRET.length < 32) {
    throw new Error("Production requires PREVIEW_SECRET with at least 32 characters");
  }
  if (config.collectorEnabled) {
    if (!config.collectorApiUrl || config.collectorApiToken.length < 32) {
      throw new Error("Collector integration requires COLLECTOR_API_URL and a 32-character COLLECTOR_API_TOKEN");
    }
  }
  if (config.collectorAgentToken.length < 32) {
    throw new Error("Windows collector Agent requires COLLECTOR_AGENT_TOKEN with at least 32 characters");
  }
}
