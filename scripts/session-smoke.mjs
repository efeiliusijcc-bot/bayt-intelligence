// Run only against an authorized deployment. This creates and revokes a login
// session and writes normal authentication audit events. Values are supplied
// through the environment, never printed or stored by this script.
import assert from "node:assert/strict";
import crypto from "node:crypto";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw Error(`${name} is required`);
  return value;
}

const baseUrl = new URL(required("AUTH_SMOKE_BASE"));
assert.ok(["http:", "https:"].includes(baseUrl.protocol));
assert.equal(baseUrl.username, "");
assert.equal(baseUrl.password, "");
assert.equal(baseUrl.pathname, "/");
assert.equal(baseUrl.search, "");
assert.equal(baseUrl.hash, "");
const base = baseUrl.origin;
const origin = required("APP_PUBLIC_ORIGIN");
const publicUrl = new URL(origin);
assert.equal(publicUrl.protocol, "https:");
assert.equal(publicUrl.origin, origin);
const user = required("APP_USER");
const password = required("APP_PASSWORD");
const headers = { Origin: origin, "Content-Type": "application/json" };
const protectedPaths = [
  "/api/v1/auth/me",
  "/api/v1/people?page=1&pageSize=1",
  "/api/v1/collector/jobs",
  "/api/v1/attachments/unknown/preview-url",
  "/api/v1/files/unknown?token=unknown",
];

const health = await fetch(`${base}/api/health`);
assert.equal(health.status, 200);
for (const route of protectedPaths) {
  const response = await fetch(`${base}${route}`);
  assert.equal(response.status, 401, route);
  assert.equal(response.headers.get("www-authenticate"), null, route);
}
const basic = Buffer.from(`${user}:${password}`).toString("base64");
const basicAttempt = await fetch(`${base}/api/v1/people`, { headers: { Authorization: `Basic ${basic}` } });
assert.equal(basicAttempt.status, 401);
const missingLoginCsrf = await fetch(`${base}/api/v1/auth/login`, {
  method: "POST", headers, body: JSON.stringify({ user, password }),
});
assert.equal(missingLoginCsrf.status, 403);

const wrong = await fetch(`${base}/api/v1/auth/login`, {
  method: "POST", headers: { ...headers, "X-CSRF-Token": "login-init" },
  body: JSON.stringify({ user, password: `invalid-${crypto.randomUUID()}` }),
});
assert.equal(wrong.status, 401);
const login = await fetch(`${base}/api/v1/auth/login`, {
  method: "POST", headers: { ...headers, "X-CSRF-Token": "login-init" },
  body: JSON.stringify({ user, password }),
});
assert.equal(login.status, 200);
const cookieHeader = login.headers.get("set-cookie") || "";
for (const flag of ["__Host-bayt_session=", "Max-Age=604800", "Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) {
  assert.ok(cookieHeader.includes(flag), flag);
}
const cookie = cookieHeader.split(";")[0];
const session = await login.json();
assert.equal(session.user, user);
assert.ok(session.csrfToken);
const me = await fetch(`${base}/api/v1/auth/me`, { headers: { Cookie: cookie } });
assert.equal(me.status, 200);
assert.equal((await me.json()).user, user);

const dashboardResponse = await fetch(`${base}/api/v1/dashboard`, { headers: { Cookie: cookie } });
assert.equal(dashboardResponse.status, 200);
const queueResponse = await fetch(`${base}/api/v1/collector/jobs`, { headers: { Cookie: cookie } });
assert.equal(queueResponse.status, 200);
const peopleResponse = await fetch(`${base}/api/v1/people?page=1&pageSize=1&attachment=bayt`, { headers: { Cookie: cookie } });
assert.equal(peopleResponse.status, 200);
const people = await peopleResponse.json();
const attachment = people.items?.[0]?.attachments?.find((item) => item.kind === "bayt_pdf" && item.previewable);
let pdfStatus = "not-available";
if (attachment) {
  const preview = await fetch(`${base}/api/v1/attachments/${encodeURIComponent(attachment.id)}/preview-url`, { headers: { Cookie: cookie } });
  assert.equal(preview.status, 200);
  const file = await fetch(`${base}${(await preview.json()).url}`, { headers: { Cookie: cookie } });
  assert.equal(file.status, 200);
  assert.ok((file.headers.get("content-type") || "").includes("application/pdf"));
  pdfStatus = "ok";
  await file.body?.cancel();
} else if (process.env.AUTH_SMOKE_REQUIRE_PDF === "1") {
  throw Error("No previewable Bayt PDF was returned");
}

let consoleStatus = "not-tested";
if (process.env.AUTH_SMOKE_CONSOLE === "1") {
  const ticket = await fetch(`${base}/api/v1/collector/login-sessions`, {
    method: "POST", headers: { ...headers, Cookie: cookie, "X-CSRF-Token": session.csrfToken,
      "X-Requested-With": "Bayt-Intelligence" }, body: "{}",
  });
  assert.equal(ticket.status, 201);
  const consolePage = await fetch(`${base}${(await ticket.json()).url}`, { headers: { Cookie: cookie } });
  assert.equal(consolePage.status, 200);
  consoleStatus = "ok";
  await consolePage.body?.cancel();
}

const missingCsrf = await fetch(`${base}/api/v1/auth/logout`, { method: "POST", headers: { Cookie: cookie, Origin: origin } });
assert.equal(missingCsrf.status, 403);
const wrongOrigin = await fetch(`${base}/api/v1/auth/logout`, {
  method: "POST", headers: { Cookie: cookie, Origin: "https://invalid.example", "X-CSRF-Token": session.csrfToken },
});
assert.equal(wrongOrigin.status, 403);
const logout = await fetch(`${base}/api/v1/auth/logout`, {
  method: "POST", headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.csrfToken },
});
assert.equal(logout.status, 204);
assert.equal((await fetch(`${base}/api/v1/auth/me`, { headers: { Cookie: cookie } })).status, 401);

console.log(JSON.stringify({ result: "ok", dashboard: dashboardResponse.status,
  queue: queueResponse.status, pdfStatus, consoleStatus }));
