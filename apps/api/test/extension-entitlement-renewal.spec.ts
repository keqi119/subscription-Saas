import {
  ContractSegmentStatus,
  EntitlementAccountStatus,
  EntitlementGrantStatus,
  EntitlementType,
  EntitlementUnit
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionExtensionActivationService } from "../src/subscription-change/subscription-extension-activation.service";

describe("extension entitlement renewal", () => {
  it("creates the new period entitlement from the extension segment snapshot with a segment-scoped key", async () => {
    const harness = createEntitlementHarness();

    await expect(
      harness.service.renewEntitlements(
        "segment-extension",
        new Date("2026-09-03T00:00:00.000Z")
      )
    ).resolves.toEqual({ created: 1, existing: 0 });

    expect(harness.grants).toEqual([
      expect.objectContaining({
        entitlementType: EntitlementType.MILEAGE,
        grantPeriodEnd: new Date("2026-10-02T00:00:00.000Z"),
        grantPeriodStart: new Date("2026-09-03T00:00:00.000Z"),
        remainingAmount: expect.objectContaining({}),
        snapshot: expect.objectContaining({
          contractSegmentId: "segment-extension",
          idempotencyKey:
            "extension-entitlement:order-1:segment-extension:2026-09-03:MILEAGE:KM",
          mileagePackage: { monthlyMileageKm: 1800, overMileageFeeAmount: 80 }
        }),
        status: EntitlementGrantStatus.ACTIVE,
        unit: EntitlementUnit.KM
      })
    ]);
  });

  it("does not duplicate grants when a recovered worker repeats the same renewal", async () => {
    const harness = createEntitlementHarness();
    const periodStart = new Date("2026-09-03T00:00:00.000Z");

    await harness.service.renewEntitlements("segment-extension", periodStart);
    await expect(
      harness.service.renewEntitlements("segment-extension", periodStart)
    ).resolves.toEqual({ created: 0, existing: 1 });

    expect(harness.grants).toHaveLength(1);
  });
});

function createEntitlementHarness() {
  const grants: Array<Record<string, unknown>> = [];
  const segment = {
    endDate: new Date("2027-03-02T00:00:00.000Z"),
    id: "segment-extension",
    order: { customerId: "customer-1" },
    orderId: "order-1",
    planSnapshot: {
      packageSnapshot: {
        mileagePackage: {
          monthlyMileageKm: 1800,
          overMileageFeeAmount: 80
        }
      }
    },
    startDate: new Date("2026-09-03T00:00:00.000Z"),
    status: ContractSegmentStatus.ACTIVE,
    subscriptionPlanId: "plan-extension"
  };
  const account = {
    accountStatus: EntitlementAccountStatus.ACTIVE,
    id: "account-1",
    periodEnd: new Date("2026-09-02T00:00:00.000Z")
  };
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "locked" }]),
    $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(prisma)),
    orderEntitlementAccount: {
      findFirst: vi.fn(async () => account),
      findUnique: vi.fn(async () => account),
      update: vi.fn(async ({ data }) => Object.assign(account, data))
    },
    orderEntitlementGrant: {
      create: vi.fn(async ({ data }) => {
        const grant = { id: `grant-${grants.length + 1}`, ...data };
        grants.push(grant);
        return grant;
      }),
      findFirst: vi.fn(async ({ where }) =>
        grants.find(
          (grant) =>
            grant.accountId === where.accountId &&
            (grant.snapshot as { idempotencyKey?: string } | undefined)?.idempotencyKey ===
              where.snapshot?.equals
        ) ?? null
      )
    },
    subscriptionContractSegment: {
      findUnique: vi.fn(async () => segment)
    }
  };
  const service = new SubscriptionExtensionActivationService(
    prisma as never,
    { enqueue: vi.fn() } as never,
    { resumeForExtension: vi.fn() } as never,
    { notifyExtensionEffectiveInApp: vi.fn() } as never,
    { write: vi.fn() } as never
  );
  return { grants, service };
}
