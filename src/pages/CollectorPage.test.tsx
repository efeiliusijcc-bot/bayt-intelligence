import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { appTheme } from "../theme";
import type { CollectionQueueJob, CollectorFilterCatalog, CollectorSearchTemplate } from "../types";
import { CollectorPage } from "./CollectorPage";

const catalog: CollectorFilterCatalog = {
  version: "bayt-catalog-1", status: "ready", synchronizedAt: "2026-08-27T00:00:00Z", agentId: "windows-agent",
  filters: [
    { key: "last-updated", label: "Last updated", controlType: "single", supported: true, options: [{ key: "six-months", label: "Within last 6 months" }] },
    { key: "unstable", label: "Search tips Search tips", controlType: "unsupported", supported: false, options: [], reason: "The control or its options could not be identified reliably" },
  ],
  sorts: [{ key: "recent", label: "Most recently updated" }],
};
const template: CollectorSearchTemplate = {
  id: "template-1", name: "软件工程师", searchSpec: { keyword: "Software Engineer", filterSchemaVersion: catalog.version, filters: [{ key: "last-updated", optionKeys: ["six-months"] }], sortKey: "recent" },
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

test("采集页展示动态Filter、不可变模板和串行队列并能立即发布", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let payload: unknown = {};
    if (url.endsWith("/filter-catalog")) payload = { catalog, syncRequest: null };
    else if (url.endsWith("/search-templates")) payload = { items: [template] };
    else if (url.endsWith("/jobs")) payload = init?.method === "POST" ? job : { items: [job], control: { globallyPaused: false, pauseCode: null, pauseMessage: null, pausedAt: null, runningJobId: null, queuedCount: 1, dailyExportedCount: 0, dailyLimit: 500 }, agents: [{ id: "windows-agent", name: "Windows采集节点", version: "1", status: "online", lastHeartbeatAt: "2026-08-27T00:00:00Z", currentJobId: null, chromeReady: true, loginState: "logged_in" }] };
    else if (url.endsWith("/schedules")) payload = { items: [] };
    return new Response(JSON.stringify(payload), { status: init?.method === "POST" ? 202 : 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rendered = render(<QueryClientProvider client={queryClient}><FluentProvider theme={appTheme}><MemoryRouter><CollectorPage /></MemoryRouter></FluentProvider></QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "采集任务" })).toBeInTheDocument();
  expect((await screen.findAllByText("软件工程师")).length).toBeGreaterThan(0);
  expect(screen.getByText("简历更新时间")).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "最近更新" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "最近6个月" })).toBeInTheDocument();
  expect(screen.getByText("搜索提示")).toBeInTheDocument();
  expect(screen.getByText("无法稳定识别该筛选控件或其选项")).toBeInTheDocument();
  expect(screen.getByText("暂不支持")).toBeInTheDocument();
  expect(screen.getByText("Windows采集节点")).toBeInTheDocument();
  expect(screen.getByText("Software Engineer，1个筛选条件")).toBeInTheDocument();
  expect(screen.queryByText(/个Filter/)).not.toBeInTheDocument();
  expect(screen.getByText(/持续时长任务按整页完成/)).toBeInTheDocument();
  expect(screen.getByText("持续小时（人数不限）")).toBeInTheDocument();
  expect(screen.queryByLabelText("采集操作员口令")).not.toBeInTheDocument();
  expect(screen.getByText("管理员登录保护")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "立即发布" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/collector/jobs", expect.objectContaining({ method: "POST", body: JSON.stringify({ templateId: template.id, name: template.name, limits: { targetCount: 100 } }) })));
  const request = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/jobs") && init?.method === "POST");
  expect((request?.[1]?.headers as Record<string, string>)["X-Collector-Operator"]).toBeUndefined();
  expect((request?.[1]?.headers as Record<string, string>)["X-Requested-With"]).toBe("Bayt-Intelligence");
  rendered.unmount(); queryClient.clear();
});
