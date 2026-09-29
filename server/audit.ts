import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

export interface AuditEvent {
  action: string;
  cvId?: string | null;
  attachmentId?: string | null;
  detail?: string | null;
  actor?: string | null;
}

export class AuditStore {
  private readonly database: DatabaseSync;

  constructor(databasePath = path.join(config.runtimeDirectory, "audit.db")) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        cv_id TEXT,
        attachment_id TEXT,
        detail TEXT,
        actor TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  record(event: AuditEvent): void {
    this.database
      .prepare(
        `INSERT INTO audit_events (action, cv_id, attachment_id, detail, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.action,
        event.cvId || null,
        event.attachmentId || null,
        event.detail || null,
        event.actor || null,
        new Date().toISOString(),
      );
  }

  list(cvId?: string): Array<Record<string, unknown>> {
    if (cvId) {
      return this.database
        .prepare("SELECT * FROM audit_events WHERE cv_id = ? ORDER BY id DESC LIMIT 100")
        .all(cvId) as Array<Record<string, unknown>>;
    }
    return this.database
      .prepare("SELECT * FROM audit_events ORDER BY id DESC LIMIT 100")
      .all() as Array<Record<string, unknown>>;
  }
}
