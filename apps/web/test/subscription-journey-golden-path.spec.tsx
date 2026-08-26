import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PortalJourneyNextActionCard } from "../src/components/portal/portal-journey-next-action-card";
import { SubscriptionJourneyCard } from "../src/components/order-workspace/subscription-journey-card";
import { ApplicationJourneyActions } from "../src/components/subscription-journey/application-journey-actions";
import { shouldHideLegacyJourneyAction } from "../src/lib/action-guards";
import {
  nextAction,
  type PortalJourneyActionType,
  type PortalSubscriptionJourney
} from "../src/lib/portal-journey-view-model";
import {
  getRecommendedOperatorAction,
  type AdminSubscriptionJourney
} from "../src/lib/subscription-journey-view-model";

const STEPS = [
  "APPLICATION_VALIDATION",
  "FINAL_PLAN_DECISION",
  "FINAL_VEHICLE_ALLOCATION",
  "CUSTOMER_PLAN_CONFIRMATION",
  "ORDER_AND_CONTRACT_CREATION",
  "FADADA_SIGNING_AND_ARCHIVE",
  "INITIAL_BILLING",
  "CUSTOMER_JSAPI_PAYMENT",
  "HANDOVER_AND_STAGE2_CREATION",
  "DELIVERY_EVIDENCE_DECISION",
  "AUTHORITATIVE_ACTIVATION"
] as const;

describe("Stage 1 subscription Journey UI Golden Path", () => {
  it("shows exactly the current Admin decision and enforces its permission", () => {
    const plan = adminJourney({ availableActions: ["FINAL_PLAN_DECISION"], currentStepCode: "FINAL_PLAN_DECISION" });
    const vehicle = adminJourney({
      application: {
        applicationNo: "APP-1",
        applicationSource: "SELF_SERVICE",
        finalPlanSnapshot: {
          vehicleSnapshot: { brand: "NIO", series: "ES6", vehicleNo: "VEH-1" }
        },
        finalVehicleId: "vehicle-1",
        id: "application-1",
        softReservedVehicleId: "vehicle-1",
        status: "APPROVED"
      },
      availableActions: ["FINAL_VEHICLE_ALLOCATION"],
      currentStepCode: "FINAL_VEHICLE_ALLOCATION"
    });
    const planHtml = renderToStaticMarkup(
      <ApplicationJourneyActions
        journey={plan}
        onChanged={vi.fn()}
        permissions={new Set(["subscription_journey:plan_decide"])}
      />
    );
    const deniedHtml = renderToStaticMarkup(
      <ApplicationJourneyActions journey={plan} onChanged={vi.fn()} permissions={new Set()} />
    );
    const vehicleHtml = renderToStaticMarkup(
      <ApplicationJourneyActions
        journey={vehicle}
        onChanged={vi.fn()}
        permissions={new Set(["subscription_journey:vehicle_allocate"])}
      />
    );

    expect(planHtml).toContain(getRecommendedOperatorAction(plan).label);
    expect(planHtml).toContain("提交最终方案并软锁车辆");
    expect(planHtml).not.toContain(getRecommendedOperatorAction(vehicle).label);
    expect(planHtml.match(/<button/g)).toHaveLength(1);
    expect(deniedHtml).not.toContain("<button");
    expect(vehicleHtml).toContain("确认沿用已软锁车辆");
    expect(vehicleHtml).not.toContain("分配车辆 ID");
    expect(vehicleHtml).not.toContain(getRecommendedOperatorAction(plan).label);
    expect(vehicleHtml.match(/<button/g)).toHaveLength(1);
  });

  it("renders evidence/recovery only when available and never reveals raw failures", () => {
    const evidence = adminJourney({
      availableActions: ["DELIVERY_EVIDENCE_DECISION"],
      currentStepCode: "DELIVERY_EVIDENCE_DECISION",
      currentStepStatus: "WAITING_MANUAL",
      currentTask: {
        id: "task-evidence",
        inputSnapshot: {
          applicationId: "application-1",
          finalPlanRevision: 3,
          handoverId: "handover-1",
          manifestHash: `sha256:${"a".repeat(64)}`,
          workOrderId: "work-order-1"
        },
        status: "OPEN",
        taskType: "DELIVERY_EVIDENCE_DECISION",
        version: 0
      }
    });
    const rawFailure = "raw Fadada callback plus WeChat payer details";
    const exception = adminJourney({
      availableActions: ["RETRY"],
      currentStepCode: "FADADA_SIGNING_AND_ARCHIVE",
      currentStepStatus: "EXCEPTION",
      exceptions: [
        {
          code: "UNKNOWN_PROVIDER_FAILURE",
          firstOccurredAt: "2026-08-06T00:00:00.000Z",
          id: "exception-1",
          lastOccurredAt: "2026-08-06T00:00:00.000Z",
          message: rawFailure,
          occurrenceCount: 1,
          retryable: true,
          status: "OPEN"
        }
      ],
      status: "EXCEPTION"
    });
    const evidenceHtml = renderToStaticMarkup(
      <SubscriptionJourneyCard
        journey={evidence}
        onChanged={vi.fn()}
        permissions={new Set(["subscription_journey:delivery_evidence_decide"])}
      />
    );
    const deniedEvidenceHtml = renderToStaticMarkup(
      <SubscriptionJourneyCard journey={evidence} onChanged={vi.fn()} permissions={new Set()} />
    );
    const exceptionHtml = renderToStaticMarkup(
      <SubscriptionJourneyCard
        journey={exception}
        onChanged={vi.fn()}
        permissions={new Set(["subscription_journey:recover"])}
      />
    );

    expect(evidenceHtml.match(/<button/g)).toHaveLength(2);
    expect(deniedEvidenceHtml).not.toContain("<button");
    expect(exceptionHtml.match(/<button/g)).toHaveLength(1);
    expect(exceptionHtml).not.toContain(rawFailure);
  });

  it.each(
    STEPS.map((step) => [step, expectedPortalAction(step)] as const)
  )("renders Portal step %s with at most its one approved action", (step, expectedType) => {
    const status = step === "AUTHORITATIVE_ACTIVATION" ? "COMPLETED" : "RUNNING";
    const journey = portalJourney({ currentStepCode: step, status });
    const action = nextAction(journey);
    const html = renderToStaticMarkup(
      <PortalJourneyNextActionCard initialJourney={journey} orderId="order-1" />
    );

    expect(action.type).toBe(expectedType);
    expect(html).toContain('data-testid="portal-journey-next-action"');
    expect((html.match(/<a /g) ?? []).length).toBeLessThanOrEqual(1);
    if (expectedType === "NONE") expect(html).not.toContain("<a ");
  });

  it("keeps provider/payment details out of Portal exceptions", () => {
    const rawFailure = "raw provider response: bank-card=622202...";
    const html = renderToStaticMarkup(
      <PortalJourneyNextActionCard
        initialJourney={portalJourney({ blockerText: rawFailure, status: "EXCEPTION" })}
        orderId="order-1"
      />
    );

    expect(html).not.toContain(rawFailure);
    expect(html).not.toMatch(/bank-card|provider response/i);
  });

  it("suppresses manual-paid, direct delivery activation, contract and bill shortcuts for Journey orders", () => {
    for (const action of [
      "CREATE_ORDER",
      "GENERATE_INITIAL_BILLS",
      "REGISTER_INITIAL_PAYMENT",
      "SIGN_OR_ARCHIVE_CONTRACT",
      "CONFIRM_DELIVERY"
    ] as const) {
      expect(shouldHideLegacyJourneyAction(true, action)).toBe(true);
    }
    const orderPage = source("../src/app/orders/[id]/page.tsx");
    expect(orderPage).toContain("journeyManaged={Boolean(journey)}");
    expect(orderPage.match(/journeyManaged \? null/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(orderPage).toContain("delivery?.depositReceivedConfirmed === true");
  });
});

function expectedPortalAction(step: string): PortalJourneyActionType {
  if (step === "CUSTOMER_PLAN_CONFIRMATION") return "CONFIRM_FINAL_PLAN";
  if (step === "FADADA_SIGNING_AND_ARCHIVE") return "SIGN_CONTRACT";
  if (step === "CUSTOMER_JSAPI_PAYMENT") return "PAY_INITIAL_BILLS";
  if (step === "HANDOVER_AND_STAGE2_CREATION") return "COOPERATE_HANDOVER";
  return "NONE";
}

function adminJourney(overrides: Partial<AdminSubscriptionJourney> = {}): AdminSubscriptionJourney {
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
    steps: STEPS.map((code, index) => ({
      attemptCount: 1,
      code,
      completedAt: index === 0 ? null : "2026-08-06T00:00:00.000Z",
      id: `step-${index}`,
      lastErrorCode: null,
      startedAt: "2026-08-06T00:00:00.000Z",
      status: index === 0 ? "RUNNING" : "COMPLETED",
      waitingAt: null
    })),
    version: 1,
    ...overrides
  };
}

function portalJourney(
  overrides: Partial<PortalSubscriptionJourney> = {}
): PortalSubscriptionJourney {
  return {
    blockerText: null,
    currentStepCode: "APPLICATION_VALIDATION",
    currentStepStatus: "RUNNING",
    finalPlanRevision: 3,
    id: "journey-1",
    links: {
      application: "/portal/applications/application-1",
      bills: ["/portal/bills/bill-1"],
      contract: "/portal/contracts/contract-1",
      contractSign: "/portal/contracts/contract-1/sign",
      order: "/portal/orders/order-1"
    },
    nextAction: null,
    polling: { enabled: false, intervalMs: 5000, maxAttempts: 24 },
    status: "RUNNING",
    version: 1,
    ...overrides
  };
}

function source(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}
