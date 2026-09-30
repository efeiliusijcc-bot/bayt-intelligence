import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CollectorRecoveryStatus } from "./CollectorRecoveryStatus";

test("429等待明确显示下次检查且不要求用户恢复", () => {
  render(<CollectorRecoveryStatus recovery={{ id: "episode-test", kind: "rate_limit", stage: "waiting",
    startedAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + 1200_000).toISOString(), attempts: 3, rateLimits: 4 }} />);
  expect(screen.getByRole("status")).toHaveTextContent("官网限流，自动等待");
  expect(screen.getByRole("status")).toHaveTextContent("已检查 3 次");
  expect(screen.getByRole("status")).toHaveTextContent("无需点击恢复");
});
