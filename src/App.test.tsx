import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { appTheme } from "./theme";

afterEach(() => vi.unstubAllGlobals());

test("未登录进入原页面会看到本站登录页，登录后返回原页面并可退出", async () => {
  let loggedIn = false;
  const session = { user: "operator", csrfToken: "csrf-test", expiresAt: "2026-10-07T00:00:00Z" };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/login")) { loggedIn = true; return Response.json(session); }
    if (url.endsWith("/auth/logout")) { loggedIn = false; return new Response(null, { status: 204 }); }
    if (url.endsWith("/auth/me")) return loggedIn ? Response.json(session) : Response.json({ error: { code: "AUTH_REQUIRED", message: "请登录后继续" } }, { status: 401 });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(<QueryClientProvider client={queryClient}><FluentProvider theme={appTheme}>
    <MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>
  </FluentProvider></QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "登录人才数据管理平台" })).toBeInTheDocument();
  expect(fetchMock.mock.calls.every(([, init]) => !new Headers(init?.headers).has("Authorization"))).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "账号" }), { target: { value: "operator" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password" } });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  expect(await screen.findByRole("heading", { name: "系统设置" })).toBeInTheDocument();
  const login = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/auth/login"));
  expect(new Headers(login?.[1]?.headers).get("X-CSRF-Token")).toBe("login-init");
  queryClient.setQueryData(["person", "private"], { cvId: "private" });
  fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "登录人才数据管理平台" })).toBeInTheDocument());
  expect(queryClient.getQueryData(["person", "private"])).toBeUndefined();
  const logout = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/auth/logout"));
  expect(new Headers(logout?.[1]?.headers).get("X-CSRF-Token")).toBe("csrf-test");
  rendered.unmount(); queryClient.clear();
});

test("会话失效会清除人物缓存并回到登录页", async () => {
  const session = { user: "operator", csrfToken: "csrf-test", expiresAt: "2026-10-07T00:00:00Z" };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(session)));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(<QueryClientProvider client={queryClient}><FluentProvider theme={appTheme}>
    <MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>
  </FluentProvider></QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "系统设置" })).toBeInTheDocument();
  queryClient.setQueryData(["person", "private"], { cvId: "private" });
  window.dispatchEvent(new Event("bayt-auth-expired"));
  expect(await screen.findByRole("heading", { name: "登录人才数据管理平台" })).toBeInTheDocument();
  expect(queryClient.getQueryData(["person", "private"])).toBeUndefined();
  rendered.unmount(); queryClient.clear();
});
