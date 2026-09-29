import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.ts";

const authenticatedRequests = new WeakSet<Request>();

export function isAuthenticatedRequest(request: Request): boolean {
  return authenticatedRequests.has(request);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function basicAuth(request: Request, response: Response, next: NextFunction): void {
  if (!config.appUser && !config.appPassword && !config.production) {
    authenticatedRequests.add(request);
    next();
    return;
  }
  const header = request.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator > 0) {
      const user = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      if (safeEqual(user, config.appUser) && safeEqual(password, config.appPassword)) {
        authenticatedRequests.add(request);
        next();
        return;
      }
    }
  }
  response.setHeader("WWW-Authenticate", 'Basic realm="Bayt Intelligence", charset="UTF-8"');
  response.status(401).json({ error: { code: "AUTH_REQUIRED", message: "需要登录后访问人物库" } });
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
