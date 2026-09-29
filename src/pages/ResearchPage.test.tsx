import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { appTheme } from "../theme";
import type { ResearchDashboardView } from "../types";
import { ResearchPage } from "./ResearchPage";

function dashboard(overrides: Partial<ResearchDashboardView> = {}): ResearchDashboardView {
  return {
    configured: false,
    providers: { tavilyConfigured: false, deepseekConfigured: false, deepseekModel: null, autoRunEnabled: false },
    policy: {
      id: "software-engineer-v1",
      name: "软件工程人才公开研究",
      targetRole: "Software Engineer",
      titleKeywords: ["software engineer", "backend"],
      skillKeywords: ["typescript", "java"],
      minimumExperienceYears: 3,
      threshold: 70,
      maxCandidatesPerRun: 30,
      manualReviewMode: "exceptions_only",
      weights: { title: 25, skills: 30, experience: 20, completeness: 15, freshness: 10 },
      updatedAt: "2026-08-25T00:00:00.000Z",
    },
    summary: { peopleTotal: 223, scored: 2, eligible: 1, searched: 0, verified: 0, noReliableResult: 0, reviewRequired: 0, waitingProvider: 0, failed: 0 },
    items: [{
      cvId: "CV-1001",
      displayName: "Ali Example",
      headline: "Senior Software Engineer",
      score: 91,
      threshold: 70,
      eligible: true,
      scoreBreakdown: { title: 20, skills: 30, experience: 20, completeness: 15, freshness: 6, matchedTitleKeywords: ["software engineer"], matchedSkillKeywords: ["typescript"], experienceYears: 5 },
      status: "SCORED_ONLY",
      identityConfidence: null,
      evidenceCount: 0,
      acceptedEvidenceCount: 0,
      conflicts: [],
      modelUsed: null,
      searchedAt: null,
      updatedAt: "2026-08-25T00:00:00.000Z",
    }],
    runs: [],
    message: "确定性评分可直接运行；配置TAVILY_API_KEY后，达标人物才会进入公开来源搜索。",
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rendered = render(<QueryClientProvider client={queryClient}><FluentProvider theme={appTheme}><MemoryRouter><ResearchPage /></MemoryRouter></FluentProvider></QueryClientProvider>);
  return { ...rendered, queryClient };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("未配置Tavily时仍展示真实评分、门槛和自动化边界", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(dashboard()), { status: 200, headers: { "content-type": "application/json" } })));
  const rendered = renderPage();
  expect(await screen.findByRole("heading", { name: "人工复核" })).toBeInTheDocument();
  expect(screen.getByText("未配置，当前只执行评分")).toBeInTheDocument();
  expect(screen.getByText("91")).toBeInTheDocument();
  expect(screen.getAllByText("已评分").length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText(/分数低于 70 的人物不会调用 Tavily/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "评分并研究达标人物" })).toBeEnabled();
  rendered.unmount();
  rendered.queryClient.clear();
});

test("研究按钮发送评分加达标搜索任务，不会把全部人物直接送给Provider", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/v1/research-runs") {
      return new Response(JSON.stringify({ id: "research-1", status: "SCORED", executeResearch: true, peopleTotal: 223, scoredTotal: 223, eligibleTotal: 18, scheduledTotal: 0, completedTotal: 0, verifiedTotal: 0, reviewRequiredTotal: 0, failedTotal: 0, error: null, createdAt: "2026-08-25T00:00:00.000Z", startedAt: null, completedAt: null }), { status: 202, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(dashboard()), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const rendered = renderPage();
  await screen.findByRole("heading", { name: "人工复核" });
  fireEvent.click(screen.getByRole("button", { name: "评分并研究达标人物" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/research-runs", expect.objectContaining({ method: "POST", body: JSON.stringify({ executeResearch: true }) })));
  rendered.unmount();
  rendered.queryClient.clear();
});

test("评分策略可修改门槛并提交完整确定性策略", async () => {
  let submittedBody = "";
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/v1/research-policy") {
      submittedBody = String(init?.body || "");
      return new Response(submittedBody, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(dashboard()), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const rendered = renderPage();
  await screen.findByRole("heading", { name: "评分策略" });
  fireEvent.change(screen.getByRole("spinbutton", { name: "研究门槛（0-100）" }), { target: { value: "75" } });
  fireEvent.click(screen.getByRole("button", { name: "保存策略" }));
  await waitFor(() => expect(submittedBody).not.toBe(""));
  const submitted = JSON.parse(submittedBody) as { threshold: number; weights: Record<string, number>; manualReviewMode: string };
  expect(submitted.threshold).toBe(75);
  expect(Object.values(submitted.weights).reduce((sum, value) => sum + value, 0)).toBe(100);
  expect(submitted.manualReviewMode).toBe("exceptions_only");
  rendered.unmount();
  rendered.queryClient.clear();
});
