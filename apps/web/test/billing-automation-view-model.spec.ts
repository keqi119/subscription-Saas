import { describe, expect, it } from "vitest";

import {
  autoDebitAttemptStatusView,
  autoDebitMandateStatusView,
  automationErrorText,
  buildAutoDebitSummaryView,
  formatAutomationDate,
  isAutoDebitJobType,
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

  it("summarizes mandate, processing, unknown, failure and unallocated states", () => {
    expect(
      buildAutoDebitSummaryView({
        attempts: {
          CREATED: 1,
          FAILED_FINAL: 2,
          FAILED_RETRYABLE: 3,
          PROCESSING: 4,
          SUBMITTING: 5,
          UNKNOWN: 6
        },
        deadLetterCount: 7,
        mandates: { ACTIVE: 8, PENDING: 9 },
        unallocatedPayments: { amount: "12345", count: 10 },
        unknownCount: 6
      })
    ).toEqual({
      activeMandates: 8,
      failedAttempts: 5,
      pendingMandates: 9,
      processingAttempts: 10,
      unknownAttempts: 6,
      unallocatedAmount: 12345,
      unallocatedCount: 10
    });
  });

  it("maps auto debit states and job types to explicit operator labels", () => {
    expect(autoDebitMandateStatusView("ACTIVE")).toEqual({ color: "green", label: "已生效" });
    expect(autoDebitAttemptStatusView("UNKNOWN")).toEqual({ color: "gold", label: "结果不明" });
    expect(autoDebitAttemptStatusView("FAILED_FINAL")).toEqual({ color: "red", label: "最终失败" });
    expect(isAutoDebitJobType("SUBMIT_BILL_DEBIT")).toBe(true);
    expect(isAutoDebitJobType("GENERATE_MONTHLY_RENT_BILL")).toBe(false);
  });
});
