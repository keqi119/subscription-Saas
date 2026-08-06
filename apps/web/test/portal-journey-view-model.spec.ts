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

  it("submits exactly the final plan revision displayed to the customer", () => {
    expect(buildPortalFinalPlanConfirmationRequest(7)).toEqual({
      body: JSON.stringify({ revision: 7 }),
      method: "POST"
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
