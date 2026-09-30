import { render, screen, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, test } from "vitest";
import { appTheme } from "../theme";
import { AuthContext } from "../auth";
import { AppLayout } from "./AppLayout";

test("主导航优先展示采集任务并隐藏导入任务入口", () => {
  render(
    <AuthContext.Provider value={{ session: { user: "admin", csrfToken: "test", expiresAt: "2026-10-06T00:00:00Z" },
      loading: false, login: async () => {}, logout: async () => {} }}>
    <FluentProvider theme={appTheme}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/dashboard" element={<div>总览内容</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </FluentProvider>
    </AuthContext.Provider>,
  );

  const sidebar = screen.getByRole("complementary", { name: "主导航" });
  const navigation = within(sidebar).getByRole("navigation");
  expect(within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
    "总览",
    "采集任务",
    "人物库",
    "人工复核",
    "系统设置",
  ]);
  expect(within(navigation).queryByRole("link", { name: "导入任务" })).not.toBeInTheDocument();
});
