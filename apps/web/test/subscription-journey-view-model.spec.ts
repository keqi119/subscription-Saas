import { describe, expect, it } from "vitest";

import {
  getCustomerWaitLabel,
  getApplicationValidationWaitPresentation,
  getJourneyStatusPresentation,
  getRecommendedOperatorAction,
  getSafeJourneyExceptionMessage,
  getStepStatusPresentation,
  getSubscriptionJourneyStepPresentation,
  parseJourneyManualTaskInput,
  type AdminSubscriptionJourney
} from "../src/lib/subscription-journey-view-model";

describe("subscription journey view model", () => {
  it.each([
    ["RUNNING", "进行中", "blue"],
    ["WAITING_CUSTOMER", "等待客户", "gold"],
    ["WAITING_MANUAL", "等待人工处理", "orange"],
    ["RETRY_SCHEDULED", "等待重试", "cyan"],
    ["PAUSED", "已暂停", "default"],
    ["EXCEPTION", "异常", "red"],
    ["COMPLETED", "已完成", "green"],
    ["CANCELLED", "已取消", "default"]
  ])("maps journey status %s to a safe Chinese presentation", (status, label, color) => {
    expect(getJourneyStatusPresentation(status)).toEqual({ color, label });
  });

  it.each([
    ["PENDING", "待处理"],
    ["RUNNING", "处理中"],
    ["WAITING_CUSTOMER", "等待客户"],
    ["WAITING_MANUAL", "等待人工"],
    ["RETRY_SCHEDULED", "等待重试"],
    ["EXCEPTION", "异常"],
    ["COMPLETED", "已完成"],
    ["SKIPPED", "已跳过"],
    ["CANCELLED", "已取消"]
  ])("maps every step status %s", (status, label) => {
    expect(getStepStatusPresentation(status).label).toBe(label);
  });

  it("maps all eleven steps and customer wait guidance", () => {
    const steps = [
      "APPLICATION_VALIDATION",
      "FINAL_PLAN_DECISION",
      "CUSTOMER_PLAN_CONFIRMATION",
      "FINAL_VEHICLE_ALLOCATION",
      "ORDER_AND_CONTRACT_CREATION",
      "FADADA_SIGNING_AND_ARCHIVE",
      "INITIAL_BILLING",
      "CUSTOMER_JSAPI_PAYMENT",
      "HANDOVER_AND_STAGE2_CREATION",
      "DELIVERY_EVIDENCE_DECISION",
      "AUTHORITATIVE_ACTIVATION"
    ];

    expect(steps.map((step) => getSubscriptionJourneyStepPresentation(step).label))
      .not.toContain("未知步骤");
    expect(getCustomerWaitLabel("CUSTOMER_PLAN_CONFIRMATION")).toBe("等待客户确认最终方案");
    expect(getCustomerWaitLabel("CUSTOMER_JSAPI_PAYMENT")).toBe("等待客户完成首付款");
  });

  it("never exposes unknown backend status or raw provider error text", () => {
    expect(getJourneyStatusPresentation("RAW_PROVIDER_STATE")).toEqual({
      color: "default",
      label: "未知状态"
    });
    expect(
      getSafeJourneyExceptionMessage({
        code: "UNKNOWN_PROVIDER_FAILURE",
        message: "token=secret provider stack trace"
      })
    ).toBe("自动化处理异常，请联系技术支持");
  });

  it("parses the exact three manual-task input shapes", () => {
    expect(
      parseJourneyManualTaskInput({
        inputSnapshot: { applicationId: "application-1", finalPlanRevision: 2 },
        taskType: "FINAL_PLAN_DECISION"
      })
    ).toEqual({ applicationId: "application-1", finalPlanRevision: 2, kind: "FINAL_PLAN_DECISION" });
    expect(
      parseJourneyManualTaskInput({
        inputSnapshot: { applicationId: "application-1", finalPlanRevision: 2 },
        taskType: "FINAL_VEHICLE_ALLOCATION"
      })
    ).toEqual({ applicationId: "application-1", finalPlanRevision: 2, kind: "FINAL_VEHICLE_ALLOCATION" });
    expect(
      parseJourneyManualTaskInput({
        inputSnapshot: {
          applicationId: "application-1",
          finalPlanRevision: 2,
          handoverId: "handover-1",
          manifestHash: `sha256:${"a".repeat(64)}`,
          workOrderId: "work-order-1"
        },
        taskType: "DELIVERY_EVIDENCE_DECISION"
      })
    ).toEqual({
      applicationId: "application-1",
      finalPlanRevision: 2,
      handoverId: "handover-1",
      kind: "DELIVERY_EVIDENCE_DECISION",
      manifestHash: `sha256:${"a".repeat(64)}`,
      workOrderId: "work-order-1"
    });
  });

  it("rejects a bare delivery-evidence manifest digest", () => {
    expect(
      parseJourneyManualTaskInput({
        inputSnapshot: {
          applicationId: "application-1",
          finalPlanRevision: 2,
          handoverId: "handover-1",
          manifestHash: "a".repeat(64),
          workOrderId: "work-order-1"
        },
        taskType: "DELIVERY_EVIDENCE_DECISION"
      })
    ).toMatchObject({ kind: "UNAVAILABLE" });
  });

  it("returns a recommended action and a reason when no action is available", () => {
    expect(getRecommendedOperatorAction(journey({ availableActions: ["RETRY"] }))).toMatchObject({
      action: "RETRY",
      label: "重试失败步骤"
    });
    expect(getRecommendedOperatorAction(journey({ availableActions: [] }))).toEqual({
      action: null,
      label: "当前无需人工操作",
      reason: "流程正在自动推进或等待客户处理"
    });
  });

  it("explains application-validation business waits from structured reasons", () => {
    expect(
      getApplicationValidationWaitPresentation(
        journey({
          currentStepCode: "APPLICATION_VALIDATION",
          currentStepStatus: "WAITING_MANUAL",
          status: "WAITING_MANUAL",
          steps: [
            {
              attemptCount: 1,
              code: "APPLICATION_VALIDATION",
              completedAt: null,
              id: "step-validation",
              lastErrorCode: null,
              startedAt: "2026-08-26T08:00:00.000Z",
              status: "WAITING_MANUAL",
              waitingAt: "2026-08-26T08:05:00.000Z",
              waitingReasonSnapshot: {
                factVersion: 3,
                reasonCodes: [
                  "MATERIAL_REVIEW_PENDING",
                  "DEPOSIT_CONFIRMATION_PENDING"
                ]
              }
            }
          ]
        })
      )
    ).toEqual({
      description: "等待材料审核、押金方案确认",
      factVersion: 3,
      title: "进件校验 · 等待人工",
      waitingAt: "2026-08-26T08:05:00.000Z"
    });
  });
});

function journey(overrides: Partial<AdminSubscriptionJourney> = {}): AdminSubscriptionJourney {
  return {
    application: { applicationNo: "APP-1", id: "application-1", status: "APPROVED" },
    availableActions: [],
    cancelledAt: null,
    completedAt: null,
    currentStepCode: "APPLICATION_VALIDATION",
    currentStepStatus: "RUNNING",
    currentTask: null,
    customerNextAction: null,
    events: [],
    exceptions: [],
    id: "journey-1",
    jobs: [],
    order: null,
    orderId: null,
    pausedFromStatus: null,
    startedAt: "2026-08-06T00:00:00.000Z",
    status: "RUNNING",
    steps: [],
    version: 1,
    ...overrides
  };
}
