import { describe, expect, it } from "vitest";

import {
  automationErrorText,
  formatAutomationDate,
  jobStatusView,
  scheduleStatusView
} from "../src/lib/billing-automation-view-model";

describe("billing automation view model", () => {
  it("maps schedule statuses to operational labels", () => {
    expect(scheduleStatusView("ACTIVE")).toEqual({
      color: "green",
      label: "运行中"
    });
    expect(scheduleStatusView("PAUSED")).toEqual({
      color: "orange",
      label: "已暂停"
    });
    expect(scheduleStatusView("unexpected")).toEqual({
      color: "default",
      label: "未知状态"
    });
  });

  it("makes dead-letter jobs visually explicit", () => {
    expect(jobStatusView("DEAD_LETTER")).toEqual({
      color: "red",
      label: "需人工处理"
    });
    expect(jobStatusView("PENDING")).toEqual({
      color: "blue",
      label: "待执行"
    });
  });

  it("formats dates safely and never displays raw unknown errors", () => {
    expect(formatAutomationDate("2026-08-10T00:30:00.000Z")).toBe("2026-08-10 08:30");
    expect(formatAutomationDate("not-a-date")).toBe("-");
    expect(
      automationErrorText("BILLING_CONFIGURATION_ERROR", "customer=13800138000 token=secret")
    ).toBe("账单自动化配置不完整，请修复后重试。");
    expect(automationErrorText("unknown", "customer=13800138000 token=secret")).toBe(
      "自动化任务执行失败，请检查配置或重试。"
    );
  });
});
