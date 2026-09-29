import type { Request, Response, NextFunction } from "express";
import { config } from "./config.ts";
import { isAuthenticatedRequest } from "./security.ts";

export class CollectorClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 502, code = "COLLECTOR_UNAVAILABLE") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function collectorRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!config.collectorEnabled) throw new CollectorClientError("云端采集服务尚未启用", 503, "COLLECTOR_NOT_CONFIGURED");
  const response = await fetch(`${config.collectorApiUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.collectorApiToken}`,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null) as T & { error?: { code?: string; message?: string } };
  if (!response.ok) throw new CollectorClientError(body?.error?.message || "云端采集服务请求失败", response.status, body?.error?.code || "COLLECTOR_REQUEST_FAILED");
  return body as T;
}

export function requireCollectorBrowserMutation(request: Request, response: Response, next: NextFunction): void {
  if (!isAuthenticatedRequest(request) || request.headers["x-requested-with"] !== "Bayt-Intelligence") {
    response.status(403).json({ error: { code: "COLLECTOR_BROWSER_REQUEST_REQUIRED", message: "采集操作必须从已登录的管理页面发起" } });
    return;
  }
  next();
}
