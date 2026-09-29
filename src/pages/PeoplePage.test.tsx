import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { expect, test, vi } from "vitest";
import { appTheme } from "../theme";
import type { PersonView } from "../types";
import { PeoplePage, PersonCard } from "./PeoplePage";

const person: PersonView = {
  id: "10001",
  cvId: "10001",
  displayName: "Test Candidate",
  headline: "Software Engineer",
  nationality: "Jordan",
  residence: "Amman",
  lastCvUpdate: "2026-08-20",
  topSkills: [{ name: "TypeScript", level: "Expert", source: "EXCEL" }],
  skills: [{ name: "TypeScript", level: "Expert", source: "EXCEL" }],
  experiences: [{ organization: "Example Org", position: "Engineer", source: "EXCEL" }],
  educations: [],
  languages: [],
  summary: null,
  avatarStatus: "missing",
  hasAvatar: false,
  attachments: [{ id: "10001:bayt_pdf", kind: "bayt_pdf", label: "Bayt 生成简历", mimeType: "application/pdf", sizeBytes: 1024, status: "downloaded", previewable: true, originalName: "cv.pdf" }],
  professionalScore: null,
  researchPriorityScore: null,
  enrichmentStatus: "NOT_CONFIGURED",
  sourceTags: ["EXCEL"],
  importedAt: null,
};

test("人物卡片展示真实附件状态且不伪造评分", async () => {
  const rendered = render(<FluentProvider theme={appTheme}><MemoryRouter><PersonCard person={person} /></MemoryRouter></FluentProvider>);
  expect(screen.getByText("Test Candidate")).toBeInTheDocument();
  expect(screen.getByText("Bayt PDF 已绑定")).toBeInTheDocument();
  expect(screen.getAllByText("未评分")).toHaveLength(2);
  expect(screen.queryByText(/\d+\s*\/\s*100/)).not.toBeInTheDocument();
  rendered.unmount();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

test("评分完成后人物卡片展示真实职业分和研究门槛结果", async () => {
  const scored = { ...person, professionalScore: 88, researchPriorityScore: 88, enrichmentStatus: "SCORED_ONLY" as const };
  const rendered = render(<FluentProvider theme={appTheme}><MemoryRouter><PersonCard person={scored} /></MemoryRouter></FluentProvider>);
  expect(screen.getAllByText("88 / 100")).toHaveLength(2);
  expect(screen.queryByText("未评分")).not.toBeInTheDocument();
  rendered.unmount();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

test("人物分页能够从第一页进入第二页", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://example.test");
    const page = Number(url.searchParams.get("page") || "1");
    return new Response(
      JSON.stringify({
        items: [{ ...person, id: String(page), cvId: String(10000 + page) }],
        page,
        pageSize: 12,
        total: 150,
        facets: { nationalities: ["Jordan"] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <FluentProvider theme={appTheme}>
        <MemoryRouter initialEntries={["/people?page=1"]}><PeoplePage /></MemoryRouter>
      </FluentProvider>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("第 1 / 13 页")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByText("第 2 / 13 页")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("page=2"), undefined);

  rendered.unmount();
  queryClient.clear();
  vi.unstubAllGlobals();
});
