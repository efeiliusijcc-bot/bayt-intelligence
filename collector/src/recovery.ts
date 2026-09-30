// Shared, deterministic recovery policy. Never performs a browser action.
export interface BrowserRecovery {
  id: string;
  kind: "rate_limit" | "verification";
  stage: "waiting" | "probing" | "manual_required";
  startedAt: string;
  nextCheckAt: string;
  attempts: number;
  rateLimits: number;
  resumePhase: string;
  notBefore: string | null;
  lastCode: string;
}
export const RECOVERY_FIRST_MS = 20 * 60_000;
export const RECOVERY_NEXT_MS = 10 * 60_000;

export function recoveryKind(message: string): BrowserRecovery["kind"] | null {
  if (/BAYT_RATE_LIMIT|BAYT_429|HTTP_429/.test(message)) return "rate_limit";
  if (/BAYT_RESULTS_HTTP_403|BAYT_CAPTCHA|BAYT_VERIFICATION_REQUIRED/.test(message)) return "verification";
  return null;
}

export function scheduleRecovery(previous: BrowserRecovery | null | undefined, kind: BrowserRecovery["kind"],
  phase: string, id: string, now = Date.now(), retryAfterAt: string | null = null, notBefore: string | null = null): BrowserRecovery {
  const rateLimits = (previous?.rateLimits || 0) + (kind === "rate_limit" ? 1 : 0);
  const wait = kind === "rate_limit" ? rateLimits === 1 ? RECOVERY_FIRST_MS : RECOVERY_NEXT_MS : 0;
  const retryAfter = retryAfterAt && Number.isFinite(Date.parse(retryAfterAt)) ? Date.parse(retryAfterAt) : 0;
  return { id: previous?.id || id, kind, stage: "waiting", startedAt: previous?.startedAt || new Date(now).toISOString(),
    nextCheckAt: new Date(Math.max(now + wait, retryAfter)).toISOString(), attempts: previous?.attempts || 0,
    rateLimits, resumePhase: previous?.resumePhase || phase, notBefore: previous?.notBefore || notBefore,
    lastCode: kind === "rate_limit" ? "BAYT_429" : "BAYT_VERIFICATION_REQUIRED" };
}

export function validRecovery(value: unknown): value is BrowserRecovery {
  const r = value as BrowserRecovery;
  return !!r && /^[A-Za-z0-9_-]{8,100}$/.test(r.id) && ["rate_limit", "verification"].includes(r.kind) &&
    ["waiting", "probing", "manual_required"].includes(r.stage) && Number.isFinite(Date.parse(r.startedAt)) &&
    Number.isFinite(Date.parse(r.nextCheckAt)) && Number.isInteger(r.attempts) && r.attempts >= 0 &&
    Number.isInteger(r.rateLimits) && r.rateLimits >= 0 && typeof r.resumePhase === "string" && r.resumePhase.length < 80 &&
    (r.notBefore === null || Number.isFinite(Date.parse(r.notBefore))) && typeof r.lastCode === "string" && r.lastCode.length < 100;
}

export function automaticRecovery(value: unknown): value is BrowserRecovery {
  return validRecovery(value) && value.stage !== "manual_required";
}

export function effectiveDeadline(state: { schemaVersion?: number; limits?: { durationHours?: number }; deadlineAt?: string | null }): string | null {
  // Count/page jobs have no implicit 48-hour expiration. Legacy timed soaks do.
  return state.schemaVersion === 2 && !state.limits?.durationHours ? null : state.deadlineAt || null;
}

export function retryAfterTime(value: string | null, now = Date.now()): string | null {
  if (!value) return null;
  const at = /^\d+$/.test(value.trim()) ? now + Number(value.trim()) * 1000 : Date.parse(value);
  return Number.isFinite(at) && at > now && at <= 8.64e15 ? new Date(at).toISOString() : null;
}
