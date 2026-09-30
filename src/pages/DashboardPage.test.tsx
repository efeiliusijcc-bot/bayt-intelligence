import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { appTheme } from "../theme";
import type { DashboardAnalyticsData } from "../types";
import { DashboardPage } from "./DashboardPage";

vi.mock("@fluentui/react-charts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactElement }) => children,
  HorizontalBarChartWithAxis: () => <div data-testid="fluent-horizontal-chart" />,
  VerticalBarChart: () => <div data-testid="fluent-vertical-chart" />,
  DonutChart: () => <div data-testid="fluent-donut-chart" />,
}));

function distribution(key: string, label: string, count = 150) {
  return [{ key, label, count, percentage: count ? 100 : 0 }];
}

function analytics(overrides: Partial<DashboardAnalyticsData> = {}): DashboardAnalyticsData {
  return {
    filterOptions: {
      batches: [{ value: "all", label: "全部批次" }, { value: "batch-1", label: "采集批次 1 / 50人" }],
      sources: [{ value: "all", label: "全部来源" }, { value: "BAYT", label: "Bayt采集" }, { value: "USER_UPLOAD", label: "用户导入" }],
      countries: [{ value: "all", label: "全部国家/地区" }, { value: "India", label: "India" }],
      updatedRanges: [{ value: "all", label: "全部时间" }, { value: "today", label: "今天" }],
    },
    scope: { peopleTotal: 150, appliedFilters: { batch: "all", source: "all", country: "all", updatedRange: "all" } },
    kpis: {
      peopleTotal: 150,
      coreComplete: 143,
      coreCompletenessPercentage: 95.3,
      baytPdfAvailable: 150,
      originalAvailable: 149,
      originalCoveragePercentage: 99.3,
      avatarsAvailable: 130,
      updatedWithin90Days: 150,
      updatedWithin90DaysPercentage: 100,
      researchConfigured: false,
      researchCandidates: null,
      reviewPending: 8,
      reviewPendingPercentage: 5.3,
    },
    distributions: {
      countries: distribution("india", "India"),
      seniority: distribution("senior", "高级"),
      functions: distribution("software", "通用软件工程"),
      experience: distribution("5_10", "5-10年"),
      skills: distribution("typescript", "TypeScript"),
      education: distribution("bachelor", "本科"),
      languages: distribution("english", "English"),
      updated: distribution("today", "今天"),
    },
    recentBatches: [{ id: "batch-1", label: "采集批次 1", query: "Software Engineer", source: "BAYT", completedAt: "2026-08-22T07:21:50.204Z", addedCount: 50, deduplicatedTotal: 50, completenessPercentage: 96, status: "completed" }],
    processingStages: [{ id: "database", label: "采集数据库", status: "healthy", summary: "150 人只读连接正常", lastRunAt: "2026-08-22T07:21:50.204Z" }],
    generatedAt: "2026-08-22T16:00:00+08:00",
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderDashboard(initialEntry = "/dashboard") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <FluentProvider theme={appTheme}>
        <MemoryRouter initialEntries={[initialEntry]}><DashboardPage /><LocationProbe /></MemoryRouter>
      </FluentProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("首页展示6个真实指标、8个图表和未配置研究状态", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(analytics()), { status: 200, headers: { "content-type": "application/json" } })));
  const rendered = renderDashboard();
  expect(await screen.findByRole("heading", { name: "人员总体画像" })).toBeInTheDocument();
  for (const label of ["人物总数", "资料完整率", "原始附件覆盖", "近90天更新", "研究候选", "待人工复核"]) expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.getByText("未启用")).toBeInTheDocument();
  expect(screen.getByText("143 / 150 人完整9项核心资料")).toBeInTheDocument();
  for (const key of ["countries", "seniority", "functions", "experience", "skills", "education", "languages", "updated"]) expect(screen.getByTestId(`chart-${key}`)).toBeInTheDocument();
  expect(screen.getByText("采集批次 1")).toBeInTheDocument();
  expect(screen.getByText("采集数据库")).toBeInTheDocument();
  rendered.unmount();
  rendered.queryClient.clear();
});

test("筛选条件同步URL且重置一次清空全部条件", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://example.test");
    const country = url.searchParams.get("country") || "all";
    return new Response(JSON.stringify(analytics({ scope: { peopleTotal: country === "India" ? 58 : 150, appliedFilters: { batch: "all", source: "all", country, updatedRange: "all" } } })), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const rendered = renderDashboard();
  await screen.findByRole("heading", { name: "人员总体画像" });
  fireEvent.change(screen.getByRole("combobox", { name: "国家/地区" }), { target: { value: "India" } });
  await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent("country=India"));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("country=India"), expect.objectContaining({ credentials: "same-origin" })));
  fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
  await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent(/^$/));
  rendered.unmount();
  rendered.queryClient.clear();
});

test("空数据时8个图表统一显示空状态而不渲染坐标轴", async () => {
  const empty = analytics({
    scope: { peopleTotal: 0, appliedFilters: { batch: "all", source: "USER_UPLOAD", country: "all", updatedRange: "all" } },
    kpis: { ...analytics().kpis, peopleTotal: 0, coreComplete: 0, coreCompletenessPercentage: 0, baytPdfAvailable: 0, originalAvailable: 0, originalCoveragePercentage: 0, avatarsAvailable: 0, updatedWithin90Days: 0, updatedWithin90DaysPercentage: 0, reviewPending: 0, reviewPendingPercentage: 0 },
    distributions: { countries: [], seniority: [], functions: [], experience: [], skills: [], education: [], languages: [], updated: [] },
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(empty), { status: 200, headers: { "content-type": "application/json" } })));
  const rendered = renderDashboard("/dashboard?source=USER_UPLOAD");
  expect(await screen.findAllByText("当前筛选下暂无数据")).toHaveLength(8);
  expect(screen.queryByTestId("fluent-horizontal-chart")).not.toBeInTheDocument();
  expect(screen.queryByTestId("fluent-vertical-chart")).not.toBeInTheDocument();
  rendered.unmount();
  rendered.queryClient.clear();
});

test("API失败显示重试入口并能恢复首页", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: { code: "REQUEST_FAILED", message: "统计失败" } }), { status: 500, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(analytics()), { status: 200, headers: { "content-type": "application/json" } });
  }));
  const rendered = renderDashboard();
  expect(await screen.findByText("统计失败")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("heading", { name: "人员总体画像" })).toBeInTheDocument();
  rendered.unmount();
  rendered.queryClient.clear();
});
