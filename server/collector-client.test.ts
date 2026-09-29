import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { requireCollectorBrowserMutation } from "./collector-client.ts";
import { config } from "./config.ts";
import { basicAuth } from "./security.ts";

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

test("HTTP链路要求管理员登录和同源变更请求，但不要求第二个口令", async () => {
  const previous = { appUser: config.appUser, appPassword: config.appPassword };
  config.appUser = "integration-admin";
  config.appPassword = "integration-password";
  const app = express();
  app.use(basicAuth);
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
    const authorization = `Basic ${Buffer.from("integration-admin:integration-password").toString("base64")}`;

    const unauthenticated = await fetch(url, { method: "POST" });
    assert.equal(unauthenticated.status, 401);

    const missingBrowserHeader = await fetch(url, { method: "POST", headers: { Authorization: authorization } });
    assert.equal(missingBrowserHeader.status, 403);

    const authenticated = await fetch(url, {
      method: "POST",
      headers: { Authorization: authorization, "X-Requested-With": "Bayt-Intelligence" },
    });
    assert.equal(authenticated.status, 204);
  } finally {
    config.appUser = previous.appUser;
    config.appPassword = previous.appPassword;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
