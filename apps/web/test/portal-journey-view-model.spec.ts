import { describe, expect, it } from "vitest";

import {
  buildPortalFinalPlanConfirmationRequest,
  nextAction,
  toPortalJourneyCardModel,
  type PortalSubscriptionJourney
} from "../src/lib/portal-journey-view-model";

describe("Portal journey view model", () => {
  it.each([
    ["CUSTOMER_PLAN_CONFIRMATION", "/portal/applications/application-1"],
    ["FADADA_SIGNING_AND_ARCHIVE", "/portal/contracts/contract-1/sign"],
    ["CUSTOMER_JSAPI_PAYMENT", "/portal/orders/order-1#bills"]
  ] as const)("routes %s to its existing Portal capability", (step, href) => {
    expect(nextAction(journey({ currentStepCode: step })).href).toBe(href);
  });

  it.each([
    ["RUNNING", "平台处理中"],
    ["RETRY_SCHEDULED", "正在自动重试"],
    ["EXCEPTION", "需要协助"],
    ["COMPLETED", "流程已完成"]
  ] as const)("renders the %s state safely", (status, title) => {
    expect(toPortalJourneyCardModel(journey({ status })).title).toBe(title);
  });

  it("submits exactly the final plan revision and commercial hash displayed to the customer", () => {
    const commercialHash = `sha256:${"a".repeat(64)}`;
    expect(buildPortalFinalPlanConfirmationRequest(7, commercialHash)).toEqual({
      body: JSON.stringify({ commercialHash, revision: 7 }),
      method: "POST"
    });
  });

  it("presents validation waits as review or supplementation instead of exceptions", () => {
    expect(
      toPortalJourneyCardModel(
        journey({
          blockerText: "平台正在完成材料、信用与押金审核。",
          currentStepCode: "APPLICATION_VALIDATION",
          currentStepStatus: "WAITING_MANUAL",
          nextAction: null,
          status: "WAITING_MANUAL"
        })
      )
    ).toMatchObject({
      action: null,
      description: "平台正在完成材料、信用与押金审核。",
      title: "资料审核中",
      tone: "info"
    });
    expect(
      toPortalJourneyCardModel(
        journey({
          currentStepCode: "APPLICATION_VALIDATION",
          currentStepStatus: "WAITING_CUSTOMER",
          nextAction: {
            href: "/portal/applications/application-1",
            label: "补充申请资料",
            type: "SUPPLEMENT_APPLICATION_MATERIALS"
          },
          status: "WAITING_CUSTOMER"
        })
      )
    ).toMatchObject({
      action: { label: "补充申请资料" },
      description: "请补充申请资料后重新提交审核。",
      title: "需要补充资料",
      tone: "warning"
    });
  });
});

function journey(
  overrides: Partial<PortalSubscriptionJourney> = {}
): PortalSubscriptionJourney {
  return {
    blockerText: null,
    currentStepCode: "CUSTOMER_PLAN_CONFIRMATION",
    currentStepStatus: "WAITING_CUSTOMER",
    finalPlanRevision: 3,
    id: "journey-1",
    links: {
      application: "/portal/applications/application-1",
      bills: ["/portal/bills/bill-1"],
      contract: "/portal/contracts/contract-1",
      contractSign: "/portal/contracts/contract-1/sign",
      order: "/portal/orders/order-1"
    },
    nextAction: {
      href: "/portal/applications/application-1",
      label: "确认最终方案",
      type: "CONFIRM_FINAL_PLAN"
    },
    polling: { enabled: false, intervalMs: 5000, maxAttempts: 24 },
    status: "WAITING_CUSTOMER",
    version: 4,
    ...overrides
  };
}
