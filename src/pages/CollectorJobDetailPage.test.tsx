import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, test, vi } from "vitest";
import { appTheme } from "../theme";
import { CollectorJobDetailPage } from "./CollectorJobDetailPage";

test("任务详情只展示已入库且PDF可用的人物，并提供该任务PDF复核", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.includes("/preview-url") ? { url: "/api/v1/files/job-one%3A10001?token=short", expiresAt: "2026-09-29T10:00:00Z" }
      : url.includes("/people?") ? { page: 1, pageSize: 12, total: 1, exportedCount: 2,
        pendingImportCount: 1, pendingPages: 1, blockedPages: 0,
        items: [{ cvId: "10001", runId: "local-ego-one", page: 1, importBatchId: "batch-one", importedAt: "2026-09-29T01:00:00Z",
          person: { cvId: "10001", displayName: "Test Candidate", headline: "Engineer" } }] }
      : { id: "job-one", name: "第一任务", status: "running", searchSpec: { keyword: "Engineer" } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(<QueryClientProvider client={client}><FluentProvider theme={appTheme}>
    <MemoryRouter initialEntries={["/collector/jobs/job-one"]}><Routes><Route path="/collector/jobs/:jobId" element={<CollectorJobDetailPage />} /></Routes></MemoryRouter>
  </FluentProvider></QueryClientProvider>);
  expect(await screen.findByText("Test Candidate")).toBeInTheDocument();
  expect(screen.getByText("待入库人数")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Test Candidate" })).toHaveAttribute("href", "/people/10001");
  fireEvent.click(screen.getByRole("button", { name: "复核本任务PDF" }));
  expect(await screen.findByTitle("CV_ID 10001 任务简历预览")).toHaveAttribute("src", "/api/v1/files/job-one%3A10001?token=short");
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("job-one%3A10001/preview-url"))).toBe(true);
  rendered.unmount(); client.clear(); vi.unstubAllGlobals();
});
