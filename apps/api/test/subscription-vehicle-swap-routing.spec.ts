import {
  CustomerAccountStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import { PortalSubscriptionChangeService } from "../src/portal/portal-subscription-change.service";
import { SubscriptionChangeService } from "../src/subscription-change/subscription-change.service";

describe("vehicle-swap subscription-change routing", () => {
  it("dispatches Admin quote publication and cancellation to the vehicle-swap service", async () => {
    const repository = {
      findChange: vi.fn(async () => ({ changeType: SubscriptionChangeType.VEHICLE_SWAP }))
    };
    const extension = {
      createFormalQuote: vi.fn(),
      previewQuote: vi.fn(),
      submitCustomerConfirmation: vi.fn()
    };
    const swap = {
      cancel: vi.fn(async () => ({
        changeType: SubscriptionChangeType.VEHICLE_SWAP,
        earlyTerminationDetail: null,
        extensionDetail: null,
        extensionMonths: null,
        id: "swap-1",
        managedOtherDetail: null,
        pricingMode: null,
        sourceSegment: null,
        sourceSegmentId: null,
        status: SubscriptionChangeStatus.CANCELLED,
        targetEndDate: null,
        targetStartDate: null,
        vehicleSwapDetail: { targetVehicleId: "vehicle-target" }
      })),
      createFormalQuote: vi.fn(async () => ({ id: "quote-swap" })),
      previewQuote: vi.fn(async () => ({ classification: "PACKAGE_INCLUDED" })),
      publishCustomerConfirmation: vi.fn(async () => ({ id: "swap-1" }))
    };
    const service = new SubscriptionChangeService(
      repository as never,
      { write: vi.fn() } as never,
      extension as never,
      { enabled: true, now: () => new Date("2026-08-27T00:00:00.000Z"), quoteValidityHours: 72 },
      swap as never
    );
    const actor = adminActor();
    const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };

    await service.previewQuote("swap-1", {}, actor);
    await service.createFormalQuote(
      "swap-1",
      { idempotencyKey: "quote-swap", version: 0 },
      actor,
      context
    );
    await service.submitCustomerConfirmation(
      "swap-1",
      { idempotencyKey: "publish-swap", version: 1 },
      actor,
      context
    );
    await service.cancel(
      "swap-1",
      { idempotencyKey: "cancel-swap", reason: "changed", version: 2 },
      actor,
      context
    );

    expect(swap.previewQuote).toHaveBeenCalled();
    expect(swap.createFormalQuote).toHaveBeenCalled();
    expect(swap.publishCustomerConfirmation).toHaveBeenCalled();
    expect(swap.cancel).toHaveBeenCalled();
    expect(extension.previewQuote).not.toHaveBeenCalled();
  });

  it("routes customer confirmation by persisted change type and requires the swap hash", async () => {
    const prisma = {
      subscriptionChangeOrder: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
          changeType:
            where.id === "swap-1"
              ? SubscriptionChangeType.VEHICLE_SWAP
              : SubscriptionChangeType.EXTENSION
        }))
      }
    };
    const renewal = { confirmQuote: vi.fn(async () => ({ id: "extension-1" })) };
    const swap = { confirmQuote: vi.fn(async () => ({ id: "swap-1" })) };
    const service = new PortalSubscriptionChangeService(
      prisma as never,
      renewal as never,
      swap as never
    );
    const customer = {
      accountStatus: CustomerAccountStatus.ACTIVE,
      customerAccountId: "account-1",
      customerId: "customer-1",
      phone: "13800000000"
    };
    const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };

    await service.confirmQuote(
      "swap-1",
      {
        commercialSnapshotHash: "a".repeat(64),
        quoteId: "quote-swap",
        revision: 1,
        version: 2
      },
      customer,
      context
    );
    await service.confirmQuote(
      "extension-1",
      { quoteId: "quote-extension", revision: 1, version: 2 },
      customer,
      context
    );

    expect(swap.confirmQuote).toHaveBeenCalledOnce();
    expect(renewal.confirmQuote).toHaveBeenCalledOnce();
  });
});

function adminActor() {
  return {
    id: "operator-1",
    menus: [],
    name: "Operator",
    permissions: [
      PermissionCode.SUBSCRIPTION_CHANGE_QUOTE,
      PermissionCode.SUBSCRIPTION_CHANGE_SUBMIT,
      PermissionCode.SUBSCRIPTION_CHANGE_CANCEL
    ],
    roles: ["OP"],
    username: "operator"
  };
}
