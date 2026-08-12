import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/lib/api";
import {
  ApplicationJourneyActions
} from "../src/components/subscription-journey/application-journey-actions";
import {
  SubscriptionJourneyExceptionActions,
  requireJourneyCancelReason,
  runJourneyMutation
} from "../src/components/order-workspace/subscription-journey-exception-actions";
import { SubscriptionJourneyCard } from "../src/components/order-workspace/subscription-journey-card";
import {
  getJourneyVehicleConfirmation,
  type AdminSubscriptionJourney
} from "../src/lib/subscription-journey-view-model";

describe("subscription journey Admin UI", () => {
  it("renders application decisions only with their task-specific permissions", () => {
    const noPermission = renderToStaticMarkup(
      <ApplicationJourneyActions
        journey={journey({ availableActions: ["FINAL_PLAN_DECISION"] })}
        onChanged={vi.fn()}
        permissions={new Set(["subscription_journey:view"])}
      />
    );
    const planPermission = renderToStaticMarkup(
      <ApplicationJourneyActions
        journey={journey({ availableActions: ["FINAL_PLAN_DECISION"] })}
        onChanged={vi.fn()}
        permissions={new Set(["subscription_journey:plan_decide"])}
      />
    );
    const vehiclePermission = renderToStaticMarkup(
      <ApplicationJourneyActions
        journey={journey({
          application: finalVehicleApplication(),
          availableActions: ["FINAL_VEHICLE_ALLOCATION"],
          currentStepCode: "FINAL_VEHICLE_ALLOCATION",
          currentStepStatus: "WAITING_MANUAL"
        })}
        onChanged={vi.fn()}
        permissions={new Set(["subscription_journey:vehicle_allocate"])}
      />
    );

    expect(noPermission).not.toContain("提交最终方案");
    expect(planPermission).toContain("提交最终方案");
    expect(vehiclePermission).toContain("确认沿用已软锁车辆");
  });

  it("shows the self-service soft-reserved vehicle without a raw UUID input", () => {
    const html = renderToStaticMarkup(
      <ApplicationJourneyActions
        journey={journey({
          application: finalVehicleApplication(),
          availableActions: ["FINAL_VEHICLE_ALLOCATION"],
          currentStepCode: "FINAL_VEHICLE_ALLOCATION",
          currentStepStatus: "WAITING_MANUAL"
        })}
        onChanged={vi.fn()}
        permissions={new Set(["subscription_journey:vehicle_allocate"])}
      />
    );

    expect(html).toContain("已软锁车辆");
    expect(html).toContain("确认沿用已软锁车辆");
    expect(html).toContain("VEH-1");
    expect(html).toContain("NIO ES6");
    expect(html).toContain("沪DGU578");
    expect(html).toContain("VIN-1");
    expect(html).not.toContain("分配车辆 ID");
    expect(
      getJourneyVehicleConfirmation(
        journey({
          application: finalVehicleApplication(),
          currentStepCode: "FINAL_VEHICLE_ALLOCATION"
        })
      ).vehicleId
    ).toBe("vehicle-1");
  });

  it("blocks final vehicle allocation when the final plan has no vehicle", () => {
    const html = renderToStaticMarkup(
      <ApplicationJourneyActions
        journey={journey({
          availableActions: ["FINAL_VEHICLE_ALLOCATION"],
          currentStepCode: "FINAL_VEHICLE_ALLOCATION",
          currentStepStatus: "WAITING_MANUAL"
        })}
        onChanged={vi.fn()}
        permissions={new Set(["subscription_journey:vehicle_allocate"])}
      />
    );

    expect(html).toContain("最终方案缺少车辆，请返回最终方案步骤选择车辆");
    expect(html).not.toContain("确认最终车辆");
    expect(html).not.toContain("确认沿用已软锁车辆");
    expect(html).not.toContain("分配车辆 ID");
  });

  it("renders evidence review, retry, pause/resume and cancel by exact permission", () => {
    const evidenceJourney = journey({
      availableActions: ["DELIVERY_EVIDENCE_DECISION"],
      currentTask: {
        id: "task-1",
        inputSnapshot: {
          applicationId: "application-1",
          finalPlanRevision: 2,
          handoverId: "handover-1",
          manifestHash: "a".repeat(64),
          workOrderId: "work-order-1"
        },
        status: "OPEN",
        taskType: "DELIVERY_EVIDENCE_DECISION",
        version: 0
      }
    });
    const evidenceHtml = renderToStaticMarkup(
      <SubscriptionJourneyCard
        journey={evidenceJourney}
        onChanged={vi.fn()}
        permissions={new Set(["subscription_journey:delivery_evidence_decide"])}
      />
    );
    const recoveryHtml = renderToStaticMarkup(
      <SubscriptionJourneyExceptionActions
        journey={journey({ availableActions: ["RETRY", "PAUSE", "CANCEL"] })}
        onChanged={vi.fn()}
        permissions={new Set([
          "subscription_journey:recover",
          "subscription_journey:cancel"
        ])}
      />
    );

    expect(evidenceHtml).toContain("通过证据");
    expect(evidenceHtml).toContain("驳回证据");
    expect(recoveryHtml).toContain("重试失败步骤");
    expect(recoveryHtml).toContain("暂停流程");
    expect(recoveryHtml).toContain("取消流程");
  });

  it("refetches on stale-version 409 and requires an explicit cancel reason", async () => {
    const onStale = vi.fn(async () => undefined);

    await expect(
      runJourneyMutation(
        async () => Promise.reject(new ApiError("conflict", 409)),
        onStale
      )
    ).rejects.toThrow("conflict");
    expect(onStale).toHaveBeenCalledOnce();
    expect(() => requireJourneyCancelReason("  ")).toThrow("请输入取消原因");
    expect(requireJourneyCancelReason(" 客户主动取消 ")).toBe("客户主动取消");
  });

  it("names the failed step in retry confirmation and keeps page integration incremental", () => {
    const retryHtml = renderToStaticMarkup(
      <SubscriptionJourneyExceptionActions
        journey={journey({
          availableActions: ["RETRY"],
          currentStepCode: "FADADA_SIGNING_AND_ARCHIVE",
          status: "EXCEPTION"
        })}
        onChanged={vi.fn()}
        permissions={new Set(["subscription_journey:recover"])}
      />
    );
    const applicationSource = source("../src/app/applications/[id]/page.tsx");
    const orderSource = source("../src/app/orders/[id]/page.tsx");
    const ordersSource = source("../src/app/orders/page.tsx");
    const contractSource = source("../src/app/contracts/[id]/page.tsx");

    expect(retryHtml).toContain("法大大签署与归档");
    expect(applicationSource).toContain("<ApplicationJourneyActions");
    expect(applicationSource).toContain("journey ? null");
    expect(orderSource).toContain("<SubscriptionJourneyCard");
    expect(orderSource).toContain("journeyManaged={Boolean(journey)}");
    expect(orderSource).toContain("delivery?.depositReceivedConfirmed === true");
    expect(orderSource).toContain("历史只读字段");
    expect(contractSource).toContain("订阅 Golden Path 托管");
    expect(contractSource).toContain("archiveStatus.canArchive && !journey");
    expect(ordersSource).toContain('searchParams.get("journeyStatus")');
    expect(ordersSource).toContain("移除异常筛选");
  });
});

function source(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

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
    steps: [
      {
        attemptCount: 1,
        code: "FADADA_SIGNING_AND_ARCHIVE",
        completedAt: null,
        id: "step-1",
        lastErrorCode: "FADADA_UNAVAILABLE",
        startedAt: "2026-08-06T00:00:00.000Z",
        status: "EXCEPTION",
        waitingAt: null
      }
    ],
    version: 3,
    ...overrides
  };
}

function finalVehicleApplication(): AdminSubscriptionJourney["application"] {
  return {
    applicationNo: "APP-1",
    applicationSource: "SELF_SERVICE",
    finalPlanSnapshot: {
      vehicleSnapshot: {
        brand: "NIO",
        model: "ES6",
        plateNo: "沪DGU578",
        vehicleNo: "VEH-1",
        vin: "VIN-1"
      }
    },
    finalVehicleId: "vehicle-1",
    id: "application-1",
    softReservedVehicleId: "vehicle-1",
    status: "APPROVED"
  };
}
