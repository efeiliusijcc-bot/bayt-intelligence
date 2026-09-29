/**
 * HAR抓包文件的脱敏与生命周期管理。
 * 原始HAR可能含查询参数和鉴权信息，所以对外只保留路径、状态码、类型和耗时等摘要。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { CAPTURES_DIR } from "./config.ts";

// 只声明本模块真正会读取的HAR字段；`?` 表示该属性可以不存在。
interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request?: { method?: string; url?: string };
  response?: { status?: number; content?: { mimeType?: string; size?: number } };
}

/** 去掉URL的查询参数，只留下协议、域名和路径。解析失败时也保守删除`?`之后内容。 */
function sanitizedUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split("?")[0];
  }
}

/**
 * 将某次运行的原始HAR转换为脱敏JSON摘要。
 * `Promise<string | null>`表示异步返回摘要路径，失败时返回null而不是让采集崩溃。
 */
export async function sanitizeHar(runId: string): Promise<string | null> {
  const harPath = path.join(CAPTURES_DIR, `${runId}.har`);
  try {
    const parsed = JSON.parse(await fsp.readFile(harPath, "utf8")) as { log?: { entries?: HarEntry[] } };
    await fsp.chmod(harPath, 0o600);
    // `?.`是可选链：中间字段不存在时得到undefined；`map`把每条记录转换成安全结构。
    const entries = (parsed.log?.entries || []).map((entry) => ({
      startedAt: entry.startedDateTime || null,
      method: entry.request?.method || null,
      url: sanitizedUrl(entry.request?.url || ""),
      status: entry.response?.status || null,
      mimeType: entry.response?.content?.mimeType || null,
      sizeBytes: entry.response?.content?.size || null,
      durationMs: entry.time || null,
    }));
    const summaryPath = path.join(CAPTURES_DIR, `${runId}.summary.json`);
    await fsp.writeFile(summaryPath, `${JSON.stringify({ runId, generatedAt: new Date().toISOString(), entries }, null, 2)}\n`, { mode: 0o600 });
    return summaryPath;
  } catch {
    // HAR缺失或损坏不阻断主任务，由调用方通过null判断“没有摘要”。
    return null;
  }
}

/** 删除过期抓包：原始HAR保留24小时，脱敏摘要保留30天。 */
export async function purgeExpiredCaptures(now = Date.now()): Promise<void> {
  await fsp.mkdir(CAPTURES_DIR, { recursive: true, mode: 0o700 });
  for (const entry of await fsp.readdir(CAPTURES_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue; // `continue`跳过目录，继续处理下一个条目。
    const filePath = path.join(CAPTURES_DIR, entry.name);
    const stat = await fsp.stat(filePath);
    const retention = entry.name.endsWith(".summary.json") ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    if (now - stat.mtimeMs > retention) await fsp.unlink(filePath);
  }
}
