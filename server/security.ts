import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "./config.ts";
import { BrowserAuthStore, SESSION_SECONDS, type BrowserSession } from "./browser-auth.ts";

const SESSION_COOKIE = "__Host-bayt_session";
const authenticatedRequests = new WeakMap<Request, BrowserSession>();

export function isAuthenticatedRequest(request: Request): boolean {
  return authenticatedRequests.has(request);
}

export function authenticatedUser(request: Request): string | null {
  return authenticatedRequests.get(request)?.user || null;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function sessionToken(request: Request): string | null {
  const cookie = request.headers.cookie?.split(";").map(part => part.trim())
    .find(part => part.startsWith(`${SESSION_COOKIE}=`));
  return cookie ? cookie.slice(SESSION_COOKIE.length + 1) : null;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function browserSessionGuard(store: BrowserAuthStore): RequestHandler {
  return (request, response, next) => {
    const devWithoutCredentials = !config.production && !config.appUser && !config.appPassword;
    const session = devWithoutCredentials
      ? { user: "local-dev", csrfToken: "local-dev-csrf", expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000).toISOString() }
      : store.get(sessionToken(request));
    if (!session) {
      response.status(401).json({ error: { code: "AUTH_REQUIRED", message: "请登录后继续" } });
      return;
    }
    authenticatedRequests.set(request, session);
    response.setHeader("Cache-Control", "private, no-store");
    next();
  };
}

export function currentSession(request: Request): BrowserSession | null {
  return authenticatedRequests.get(request) || null;
}

export function requireSameOrigin(request: Request, response: Response, next: NextFunction): void {
  const origin = request.headers.origin;
  if (!origin || (origin !== config.appPublicOrigin && origin !== config.appLegacyPublicOrigin)) {
    response.status(403).json({ error: { code: "ORIGIN_REQUIRED", message: "仅接受本站发起的登录和变更请求" } });
    return;
  }
  next();
}

export function requireLoginCsrf(request: Request, response: Response, next: NextFunction): void {
  // Before authentication there is no session-bound token. A custom header
  // plus strict Origin validation prevents a cross-site form login request.
  if (request.headers["x-csrf-token"] !== "login-init") {
    response.status(403).json({ error: { code: "CSRF_INVALID", message: "请从本站登录页面提交" } });
    return;
  }
  next();
}

export function requireSessionCsrf(request: Request, response: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) { next(); return; }
  if (!config.production && !config.appUser && !config.appPassword) { next(); return; }
  const session = currentSession(request);
  const supplied = String(request.headers["x-csrf-token"] || "");
  if (!session || !supplied || !safeEqual(supplied, session.csrfToken)) {
    response.status(403).json({ error: { code: "CSRF_INVALID", message: "页面安全凭据已失效，请刷新后重试" } });
    return;
  }
  requireSameOrigin(request, response, next);
}

export function securityHeaders(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
}

export function issueFileToken(attachmentId: string, disposition: "inline" | "attachment"): string {
  const expires = Math.floor(Date.now() / 1000) + 5 * 60;
  const payload = `${attachmentId}:${disposition}:${expires}`;
  const signature = crypto.createHmac("sha256", config.previewSecret).update(payload).digest("hex");
  return Buffer.from(`${payload}:${signature}`).toString("base64url");
}

export function verifyFileToken(
  token: string,
): { attachmentId: string; disposition: "inline" | "attachment" } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 5) return null;
    const [cvId, kind, disposition, expiresRaw, signature] = parts;
    if (!cvId || !kind || !signature || !["inline", "attachment"].includes(disposition)) return null;
    const expires = Number(expiresRaw);
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return null;
    const attachmentId = `${cvId}:${kind}`;
    const payload = `${attachmentId}:${disposition}:${expires}`;
    const expected = crypto.createHmac("sha256", config.previewSecret).update(payload).digest("hex");
    if (!safeEqual(signature, expected)) return null;
    return { attachmentId, disposition: disposition as "inline" | "attachment" };
  } catch {
    return null;
  }
}
