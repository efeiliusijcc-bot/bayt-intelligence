import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SESSION_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_FAILED_LOGINS = 5;

export interface BrowserSession {
  user: string;
  csrfToken: string;
  expiresAt: string;
}

export type LoginResult =
  | { status: "ok"; token: string; session: BrowserSession }
  | { status: "invalid" }
  | { status: "limited"; retryAfterSeconds: number };

interface Credentials { user: string; password: string; secret: string }

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export class BrowserAuthStore {
  private readonly db: DatabaseSync;
  private readonly credentials: () => Credentials;

  constructor(databasePath: string, credentials: () => Credentials) {
    this.credentials = credentials;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        credential_version TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_browser_sessions_expires ON browser_sessions(expires_at_ms);
      CREATE TABLE IF NOT EXISTS browser_login_failures (
        attempt_key TEXT NOT NULL,
        failed_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_browser_login_failures_key ON browser_login_failures(attempt_key, failed_at_ms);
    `);
  }

  private credentialVersion(): string {
    const { user, password, secret } = this.credentials();
    return crypto.createHmac("sha256", secret).update(`${user}\0${password}`).digest("hex");
  }

  login(user: string, password: string, clientIp: string, now = Date.now()): LoginResult {
    const current = this.credentials();
    // One local account: limit per client, not per submitted username, so an
    // attacker cannot reset the counter simply by changing that field.
    const attemptKey = crypto.createHmac("sha256", current.secret).update(clientIp).digest("hex");
    this.db.prepare("DELETE FROM browser_login_failures WHERE failed_at_ms <= ?").run(now - LOGIN_WINDOW_MS);
    const failures = this.db.prepare("SELECT failed_at_ms FROM browser_login_failures WHERE attempt_key = ? ORDER BY failed_at_ms")
      .all(attemptKey) as Array<{ failed_at_ms: number }>;
    if (failures.length >= MAX_FAILED_LOGINS) {
      return { status: "limited", retryAfterSeconds: Math.max(1, Math.ceil((failures[0].failed_at_ms + LOGIN_WINDOW_MS - now) / 1000)) };
    }
    if (!current.user || !current.password || !safeEqual(user, current.user) || !safeEqual(password, current.password)) {
      this.db.prepare("INSERT INTO browser_login_failures (attempt_key, failed_at_ms) VALUES (?, ?)").run(attemptKey, now);
      return { status: "invalid" };
    }
    this.db.prepare("DELETE FROM browser_login_failures WHERE attempt_key = ?").run(attemptKey);
    this.db.prepare("DELETE FROM browser_sessions WHERE expires_at_ms <= ? OR revoked_at_ms IS NOT NULL").run(now);
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    const expiresAtMs = now + SESSION_SECONDS * 1000;
    this.db.prepare(`INSERT INTO browser_sessions
      (token_hash, username, csrf_token, credential_version, created_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(tokenHash(token), current.user, csrfToken, this.credentialVersion(), now, expiresAtMs);
    return { status: "ok", token, session: { user: current.user, csrfToken, expiresAt: new Date(expiresAtMs).toISOString() } };
  }

  get(token: string | null, now = Date.now()): BrowserSession | null {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare(`SELECT username, csrf_token, credential_version, expires_at_ms
      FROM browser_sessions WHERE token_hash = ? AND revoked_at_ms IS NULL`)
      .get(tokenHash(token)) as { username: string; csrf_token: string; credential_version: string; expires_at_ms: number } | undefined;
    if (!row || row.expires_at_ms <= now || !safeEqual(row.credential_version, this.credentialVersion())) return null;
    return { user: row.username, csrfToken: row.csrf_token, expiresAt: new Date(row.expires_at_ms).toISOString() };
  }

  revoke(token: string | null, now = Date.now()): void {
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      this.db.prepare("UPDATE browser_sessions SET revoked_at_ms = ? WHERE token_hash = ? AND revoked_at_ms IS NULL")
        .run(now, tokenHash(token));
    }
  }

  close(): void { this.db.close(); }
}
