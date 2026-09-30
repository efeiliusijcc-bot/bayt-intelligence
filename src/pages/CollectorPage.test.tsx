import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { appTheme } from "../theme";
import type { CollectionQueueJob, CollectorFilterCatalog, CollectorSearchTemplate } from "../types";
import { CollectorPage } from "./CollectorPage";

const catalog: CollectorFilterCatalog = {
  version: "bayt-catalog-1", status: "ready", synchronizedAt: new Date().toISOString(), agentId: "local-ego-test",
  filters: [
    { key: "last-updated", label: "Last updated", controlType: "single", supported: true, options: [{ key: "six-months", label: "Within last 6 months" }] },
    { key: "unstable", label: "Search tips Search tips", controlType: "unsupported", supported: false, options: [], reason: "The control or its options could not be identified reliably" },
  ],
  sorts: [{ key: "recent", label: "Most recently updated" }],
  advanced: { keywordModes: [{ key: "any", label: "Any words" }, { key: "exact", label: "Exact order" }],
    nameSupported: true, locations: [{ key: "syria", label: "Syria", cities: [{ key: "jisr", label: "Jisr ash Shughur" }] }],
    jobRoles: [{ key: "logistics", label: "Logistics and Transportation" }],
    industries: [{ key: "nonprofit", label: "Non-profit Organization" }], exclusionSupported: true, reliable: true },
};
const template: CollectorSearchTemplate = {
  id: "template-1", name: "软件工程师", searchSpec: { schemaVersion: 2, keyword: "Software Engineer", keywordMode: "any", filterSchemaVersion: catalog.version,
    filters: [], sortKey: "recent", pastJobLocations: [], includeJobRoles: [], excludeJobRoles: [], includeIndustries: [], excludeIndustries: [], approximateLocationKeyword: null },
  createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z",
};
const job: CollectionQueueJob = {
  id: "job-1", templateId: template.id, scheduleId: null, source: "manual", name: template.name, searchSpec: template.searchSpec,
  limits: { targetCount: 100 }, status: "queued", queuePosition: 1, currentPage: 0, completedPages: 0, exportedCount: 0,
  xlsCount: 0, pdfCount: 0, uploadedCount: 0, searchId: null, matchedCount: null, actualFilterLabels: [], pauseRequested: false,
  agentId: null, leaseExpiresAt: null, errorCode: null, errorMessage: null, scheduledFor: null, createdAt: "2026-08-27T00:00:00Z",
  startedAt: null, completedAt: null, pages: [],
};

afterEach(() => { vi.unstubAllGlobals(); });

test("采集页展示本机Ego高级目录、模板与串行队列并能直接入队", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let payload: unknown = {};
    if (url.endsWith("/filter-catalog")) payload = { catalog, syncRequest: null };
    else if (url.endsWith("/search-templates")) payload = { items: [template] };
    else if (url.endsWith("/jobs")) payload = init?.method === "POST" ? job : { items: [job], control: { globallyPaused: false, pauseCode: null, pauseMessage: null, pausedAt: null, runningJobId: null, queuedCount: 1, dailyExportedCount: 0, dailyLimit: 500 }, agents: [{ id: "local-ego-test", name: "本机 Ego Agent", version: "2", status: "online", lastHeartbeatAt: new Date().toISOString(), currentJobId: null, chromeReady: true, loginState: "logged_in" }] };
    else if (url.endsWith("/schedules")) payload = { items: [] };
    return new Response(JSON.stringify(payload), { status: init?.method === "POST" ? 202 : 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rendered = render(<QueryClientProvider client={queryClient}><FluentProvider theme={appTheme}><MemoryRouter><CollectorPage /></MemoryRouter></FluentProvider></QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "采集任务" })).toBeInTheDocument();
  expect((await screen.findAllByText("软件工程师")).length).toBeGreaterThan(0);
  expect(screen.getByRole("heading", { name: "高级筛选" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "任意词" })).toBeInTheDocument();
  expect(screen.getByText("过去工作地点")).toBeInTheDocument();
  expect(screen.getByText("本机 Ego Agent")).toBeInTheDocument();
  expect(screen.getAllByText("Software Engineer").length).toBeGreaterThan(0);
  expect(screen.getByText(/持续时长任务按整页完成/)).toBeInTheDocument();
  expect(screen.getByText("持续小时（人数不限）")).toBeInTheDocument();
  expect(screen.queryByLabelText("采集操作员口令")).not.toBeInTheDocument();
  expect(screen.getByText("本站会话保护")).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText("职位、经历或技能"), { target: { value: "Backend Engineer" } });
  fireEvent.click(screen.getAllByRole("button", { name: "加入队列" })[0]);
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/jobs") && init?.method === "POST")).toBe(true));
  const request = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/jobs") && init?.method === "POST");
  const body = JSON.parse(String(request?.[1]?.body));
  expect(body.searchSpec.schemaVersion).toBe(2);
  expect(body.searchSpec.keyword).toBe("Backend Engineer");
  expect(body.clientRequestId).toBeTruthy();
  expect(new Headers(request?.[1]?.headers).has("X-Collector-Operator")).toBe(false);
  expect(new Headers(request?.[1]?.headers).get("X-Requested-With")).toBe("Bayt-Intelligence");
  fireEvent.change(screen.getByPlaceholderText("候选人姓氏"), { target: { value: "al-Turkistani" } });
  expect(screen.getByText(/官网姓名筛选不接受数字或特殊字符/)).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "加入队列" })[0]).toBeDisabled();
  rendered.unmount(); queryClient.clear();
});

test("安全暂停可由已登录页面单击解除并保留审计原因", async () => {
  const prompt = vi.spyOn(window, "prompt").mockImplementation(() => { throw Error("不应要求再次输入"); });
  const confirm = vi.spyOn(window, "confirm").mockImplementation(() => { throw Error("不应弹出二次确认"); });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const payload = url.endsWith("/filter-catalog") ? { catalog, syncRequest: null }
      : url.endsWith("/search-templates") ? { items: [] }
        : url.endsWith("/jobs") ? { items: [], control: { globallyPaused: true, pauseCode: "SEARCH_FORM_UNVERIFIED", pauseMessage: "官网筛选失败", pausedAt: new Date().toISOString(), runningJobId: null, queuedCount: 0, dailyExportedCount: 0, dailyLimit: 500 }, agents: [] }
          : url.endsWith("/schedules") ? { items: [] }
            : { globallyPaused: false };
    return new Response(JSON.stringify(payload), { status: init?.method === "POST" ? 200 : 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rendered = render(<QueryClientProvider client={queryClient}><FluentProvider theme={appTheme}><MemoryRouter><CollectorPage /></MemoryRouter></FluentProvider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "解除全局安全暂停" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/control/acknowledge-safety") && init?.method === "POST")).toBe(true));
  const request = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/control/acknowledge-safety"));
  expect(JSON.parse(String(request?.[1]?.body)).reason).toContain("SEARCH_FORM_UNVERIFIED");
  expect(prompt).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  rendered.unmount(); queryClient.clear();
  prompt.mockRestore(); confirm.mockRestore();
});

test("本机等待验证时不显示队列正常，已有搜索只提供核验续跑", async () => {
  const checkpoint = { ...job, status: "safety_stopped" as const, queuePosition: null, resumeMode: "checkpoint" as const,
    searchId: "search-1", completedPages: 1, errorCode: "SEARCH_FORM_UNVERIFIED" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.endsWith("/filter-catalog") ? { catalog, syncRequest: null }
      : url.endsWith("/search-templates") ? { items: [] }
        : url.endsWith("/jobs") ? { items: [checkpoint], control: { globallyPaused: false, pauseCode: null,
          pauseMessage: null, pausedAt: null, runningJobId: null, queuedCount: 0, dailyExportedCount: 0, dailyLimit: 500 },
          agents: [{ id: "local-ego-test", name: "本机 Ego Agent", version: "2", status: "online",
            lastHeartbeatAt: new Date().toISOString(), currentJobId: null, chromeReady: false, loginState: "verification_required" }] }
          : { items: [] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(<QueryClientProvider client={queryClient}><FluentProvider theme={appTheme}><MemoryRouter><CollectorPage /></MemoryRouter></FluentProvider></QueryClientProvider>);
  expect(await screen.findByText("等待 Bayt 人工验证")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("请先在 Bayt 官网完成验证");
  expect(screen.getByRole("button", { name: "已完成官网验证，继续" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "核验续跑" })).toBeInTheDocument();
  expect(screen.queryByText("串行队列正常")).not.toBeInTheDocument();
  rendered.unmount(); queryClient.clear();
});

test("明确验证按钮绑定当前标记，提交后不顺带解除全局暂停", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const payload = url.endsWith("/filter-catalog") ? { catalog, syncRequest: null }
      : url.endsWith("/jobs") ? { items: [], control: { globallyPaused: true, queuedCount: 0 },
        agents: [{ id: "local-ego-test", name: "Agent", status: "online", loginState: "verification_required", verificationId: "current-marker", lastHeartbeatAt: new Date().toISOString() }] }
        : init?.method === "POST" ? { id: "request-one", status: "pending" } : { items: [] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rendered = render(<QueryClientProvider client={client}><FluentProvider theme={appTheme}><MemoryRouter><CollectorPage /></MemoryRouter></FluentProvider></QueryClientProvider>);
  const button = await screen.findByRole("button", { name: "已完成官网验证，继续" });
  fireEvent.click(button);
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/verification") && init?.method === "POST")).toBe(true));
  const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/verification") && init?.method === "POST");
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ agentId: "local-ego-test", verificationId: "current-marker" });
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("acknowledge-safety"))).toBe(false);
  rendered.unmount(); client.clear();
});
