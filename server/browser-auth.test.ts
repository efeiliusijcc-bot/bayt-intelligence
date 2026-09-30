import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserAuthStore, SESSION_SECONDS } from "./browser-auth.ts";
import { clearSessionCookie, sessionCookie } from "./security.ts";

test("会话仅保存令牌哈希，重启可恢复，7天到期和密码变更后失效", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bayt-session-test-"));
  const databasePath = path.join(directory, "sessions.db");
  const credentials = { user: "operator", password: "long-test-password", secret: "test-secret" };
  const now = Date.UTC(2026, 8, 30);
  let store = new BrowserAuthStore(databasePath, () => credentials);
  try {
    const result = store.login("operator", "long-test-password", "203.0.113.10", now);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(store.get(result.token, now)?.user, "operator");
    assert.equal(store.get(result.token, now + SESSION_SECONDS * 1000 - 1)?.user, "operator");
    assert.equal(store.get(result.token, now + SESSION_SECONDS * 1000), null);
    assert.equal(fs.readFileSync(databasePath).includes(result.token), false);
    assert.match(sessionCookie(result.token), /^__Host-bayt_session=.*; Max-Age=604800; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    assert.match(clearSessionCookie(), /Max-Age=0/);
    store.close();
    store = new BrowserAuthStore(databasePath, () => credentials);
    assert.equal(store.get(result.token, now + 1000)?.csrfToken, result.session.csrfToken);
    credentials.password = "rotated-password";
    assert.equal(store.get(result.token, now + 1000), null);
    const rotated = store.login("operator", credentials.password, "203.0.113.10", now + 2000);
    assert.equal(rotated.status, "ok");
    if (rotated.status === "ok") {
      store.revoke(rotated.token, now + 3000);
      assert.equal(store.get(rotated.token, now + 4000), null);
    }
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("同一客户端连续失败会限速，时间窗结束后可恢复", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bayt-login-limit-"));
  const store = new BrowserAuthStore(path.join(directory, "sessions.db"), () => ({ user: "operator", password: "valid", secret: "test-secret" }));
  try {
    for (let index = 0; index < 5; index++) {
      assert.equal(store.login(index % 2 ? "other" : "operator", "wrong", "203.0.113.20", index * 1000).status, "invalid");
    }
    const blocked = store.login("operator", "valid", "203.0.113.20", 5000);
    assert.equal(blocked.status, "limited");
    assert.equal(store.login("operator", "valid", "203.0.113.20", 15 * 60_000 + 1).status, "ok");
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
