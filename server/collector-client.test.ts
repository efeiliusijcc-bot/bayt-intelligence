import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { requireCollectorBrowserMutation } from "./collector-client.ts";
import { BrowserAuthStore } from "./browser-auth.ts";
import { config } from "./config.ts";
import { browserSessionGuard, requireLoginCsrf, requireSameOrigin, requireSessionCsrf, sessionCookie } from "./security.ts";

function responseRecorder(): { response: Response; state: { status: number; body: unknown } } {
  const state = { status: 200, body: null as unknown };
  const response = {
    status(code: number) { state.status = code; return this; },
    json(body: unknown) { state.body = body; return this; },
  } as unknown as Response;
  return { response, state };
}

test("采集写操作不再需要口令，但必须来自同源管理页面", () => {
  const blocked = responseRecorder();
  let blockedNext = false;
  requireCollectorBrowserMutation(
    { headers: {} } as Request,
    blocked.response,
    (() => { blockedNext = true; }) as NextFunction,
  );
  assert.equal(blockedNext, false);
  assert.equal(blocked.state.status, 403);
  assert.deepEqual(blocked.state.body, {
    error: { code: "COLLECTOR_BROWSER_REQUEST_REQUIRED", message: "采集操作必须从已登录的管理页面发起" },
  });

});

test("HTTP链路要求本站会话、CSRF和采集页面请求，不接受Basic代替", async () => {
  const previous = { appUser: config.appUser, appPassword: config.appPassword,
    appPublicOrigin: config.appPublicOrigin, appLegacyPublicOrigin: config.appLegacyPublicOrigin };
  config.appUser = "integration-admin";
  config.appPassword = "integration-password";
  config.appPublicOrigin = "http://127.0.0.1:9999";
  config.appLegacyPublicOrigin = "http://127.0.0.1:9998";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bayt-auth-test-"));
  const store = new BrowserAuthStore(path.join(directory, "sessions.db"), () => ({
    user: config.appUser, password: config.appPassword, secret: "test-secret" }));
  const app = express();
  app.use(express.json());
  app.post("/login", requireSameOrigin, requireLoginCsrf, (request, response) => {
    const result = store.login(request.body.user, request.body.password, "127.0.0.1");
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    response.setHeader("Set-Cookie", sessionCookie(result.token));
    response.json(result.session);
  });
  app.use(browserSessionGuard(store), requireSessionCsrf);
  app.post("/collector-change", requireCollectorBrowserMutation, (_request, response) => response.sendStatus(204));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/collector-change`;
    const origin = config.appPublicOrigin;

    const unauthenticated = await fetch(url, { method: "POST" });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("www-authenticate"), null);

    const basic = await fetch(url, { method: "POST", headers: { Authorization: `Basic ${Buffer.from("integration-admin:integration-password").toString("base64")}` } });
    assert.equal(basic.status, 401);

    const noLoginCsrf = await fetch(`http://127.0.0.1:${address.port}/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ user: config.appUser, password: config.appPassword }) });
    assert.equal(noLoginCsrf.status, 403);

    const login = await fetch(`http://127.0.0.1:${address.port}/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": "login-init" },
      body: JSON.stringify({ user: config.appUser, password: config.appPassword }) });
    assert.equal(login.status, 200);
    const csrfToken = (await login.json()).csrfToken as string;
    const cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
    assert.ok(cookie.startsWith("__Host-bayt_session="));

    const missingBrowserHeader = await fetch(url, { method: "POST", headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrfToken } });
    assert.equal(missingBrowserHeader.status, 403);

    const missingCsrf = await fetch(url, { method: "POST", headers: { Origin: origin, Cookie: cookie, "X-Requested-With": "Bayt-Intelligence" } });
    assert.equal(missingCsrf.status, 403);

    const authenticated = await fetch(url, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrfToken, "X-Requested-With": "Bayt-Intelligence" },
    });
    assert.equal(authenticated.status, 204);

    const legacyOrigin = await fetch(url, {
      method: "POST",
      headers: { Origin: config.appLegacyPublicOrigin, Cookie: cookie, "X-CSRF-Token": csrfToken,
        "X-Requested-With": "Bayt-Intelligence" },
    });
    assert.equal(legacyOrigin.status, 204);
  } finally {
    config.appUser = previous.appUser;
    config.appPassword = previous.appPassword;
    config.appPublicOrigin = previous.appPublicOrigin;
    config.appLegacyPublicOrigin = previous.appLegacyPublicOrigin;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
