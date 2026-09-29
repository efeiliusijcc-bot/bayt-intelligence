import { render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { expect, test } from "vitest";
import { appTheme } from "../theme";
import type { ResearchCaseDetail } from "../types";
import { ResearchCaseContent } from "./PersonDetailPage";

const detail: ResearchCaseDetail = {
  cvId: "CV-1001",
  displayName: "Ali Example",
  headline: "Senior Software Engineer",
  score: 94,
  threshold: 90.1,
  eligible: true,
  scoreBreakdown: {
    title: 25,
    skills: 27,
    experience: 20,
    completeness: 15,
    freshness: 7,
    matchedTitleKeywords: ["software engineer"],
    matchedSkillKeywords: ["typescript", "node"],
    experienceYears: 8,
  },
  status: "NO_RELIABLE_RESULT",
  identityConfidence: 0.71,
  evidenceCount: 2,
  acceptedEvidenceCount: 0,
  conflicts: [],
  modelUsed: null,
  searchedAt: "2026-08-25T02:00:00.000Z",
  updatedAt: "2026-08-25T02:00:00.000Z",
  synthesis: {
    conclusion: "公开搜索已完成，但没有形成足够可靠的身份来源组合；当前仅能确认简历中的职业资料。",
    careerProfile: "简历资料显示：职位方向为 Senior Software Engineer；简历记录累计经验约 8 年；核心技能包括 TypeScript、Node。",
    highlights: ["职位方向命中：software engineer", "技能命中：typescript、node"],
    publicFindings: [{
      text: "候选来源“Ali Example - LinkedIn”提到：Senior Software Engineer",
      evidenceIds: ["src_001"],
      certainty: "possible",
    }],
    gaps: ["尚未形成一个A级来源或两个相互独立B级来源的证据组合。"],
    basis: "EVIDENCE_RULES",
    generatedAt: "2026-08-25T02:00:00.000Z",
  },
  evidence: [{
    sourceId: "src_001",
    title: "Ali Example - LinkedIn",
    domain: "linkedin.com",
    url: "https://linkedin.com/in/ali-example",
    publishedAt: null,
    sourceLevel: "B",
    identityScore: 0.71,
    snippet: "Senior Software Engineer",
    accepted: false,
  }],
};

test("公开信息页先展示证据约束总结，并可跳转到对应信源", () => {
  render(<FluentProvider theme={appTheme}><ResearchCaseContent data={detail} /></FluentProvider>);
  expect(screen.getByRole("heading", { name: "研究摘要" })).toBeInTheDocument();
  expect(screen.getByText(/没有形成足够可靠的身份来源组合/)).toBeInTheDocument();
  expect(screen.getByText(/简历记录累计经验约 8 年/)).toBeInTheDocument();
  expect(screen.getByText("候选线索，尚未确认")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "[src_001]" })).toHaveAttribute("href", "#evidence-src_001");
  expect(document.getElementById("evidence-src_001")).toBeInTheDocument();
});
