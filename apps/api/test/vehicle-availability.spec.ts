import {
  SalePriceStatus,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  VehicleAvailabilityPurpose,
  evaluateVehicleAvailability,
  type VehicleAvailabilityInput
} from "../src/asset-operations/vehicle-availability";

const ALL_STATUSES = Object.values(VehicleStatus);

const ALLOWED_STATUSES = {
  [VehicleAvailabilityPurpose.ALLOCATION]: new Set([VehicleStatus.AVAILABLE]),
  [VehicleAvailabilityPurpose.DELIVERY]: new Set([VehicleStatus.RESERVED]),
  [VehicleAvailabilityPurpose.MARK_AVAILABLE]: new Set([
    VehicleStatus.DRAFT,
    VehicleStatus.IN_PREPARATION,
    VehicleStatus.RETURNED,
    VehicleStatus.MAINTENANCE,
    VehicleStatus.AVAILABLE
  ])
} as const;

describe("evaluateVehicleAvailability", () => {
  it.each(Object.values(VehicleAvailabilityPurpose))(
    "enforces every lifecycle status for %s",
    (purpose) => {
      for (const status of ALL_STATUSES) {
        const decision = evaluateVehicleAvailability(input({ purpose, status }));
        const lifecycleReasons = decision.reasons.filter(
          (reason) => reason.code === "LIFECYCLE_STATUS_BLOCKED"
        );
        expect(lifecycleReasons, `${purpose}:${status}`).toHaveLength(
          ALLOWED_STATUSES[purpose].has(status as never) ? 0 : 1
        );
      }
    }
  );

  it("fails closed for a missing vehicle and reports a deleted vehicle", () => {
    expect(evaluateVehicleAvailability({ ...input(), vehicle: null })).toEqual({
      available: false,
      purpose: VehicleAvailabilityPurpose.ALLOCATION,
      reasons: [{ code: "VEHICLE_NOT_FOUND" }]
    });

    expect(
      evaluateVehicleAvailability(input({ deletedAt: new Date("2026-08-19T00:00:00.000Z") }))
        .reasons
    ).toContainEqual({ code: "VEHICLE_DELETED" });
  });

  it.each([
    SalePriceStatus.PENDING_INITIALIZE,
    SalePriceStatus.REVIEW_DUE,
    SalePriceStatus.EXPIRED
  ])("rejects non-effective sale-price state %s for allocation and re-entry", (salePriceStatus) => {
    for (const purpose of [
      VehicleAvailabilityPurpose.ALLOCATION,
      VehicleAvailabilityPurpose.MARK_AVAILABLE
    ]) {
      expect(
        evaluateVehicleAvailability(input({ purpose, salePriceStatus })).reasons
      ).toContainEqual({ code: "SALE_PRICE_NOT_EFFECTIVE" });
    }
  });

  it.each([null, 0n, -1n])(
    "rejects non-positive sale price %s for allocation and re-entry",
    (currentSalePriceAmount) => {
      for (const purpose of [
        VehicleAvailabilityPurpose.ALLOCATION,
        VehicleAvailabilityPurpose.MARK_AVAILABLE
      ]) {
        expect(
          evaluateVehicleAvailability(input({ currentSalePriceAmount, purpose })).reasons
        ).toContainEqual({ code: "SALE_PRICE_NOT_POSITIVE" });
      }
    }
  );

  it("preserves the reviewed reserved price for delivery", () => {
    const decision = evaluateVehicleAvailability(
      input({
        currentSalePriceAmount: null,
        purpose: VehicleAvailabilityPurpose.DELIVERY,
        salePriceStatus: SalePriceStatus.EXPIRED,
        status: VehicleStatus.RESERVED
      })
    );

    expect(decision).toEqual({
      available: true,
      purpose: VehicleAvailabilityPurpose.DELIVERY,
      reasons: []
    });
  });

  it.each([1, 2])("reports one occupancy reason for %s open periods", (periodCount) => {
    const activeSubscriptionPeriods = Array.from({ length: periodCount }, (_, index) => ({
      id: `period-${index + 1}`,
      orderId: `order-${index + 1}`
    }));

    expect(evaluateVehicleAvailability(input({ activeSubscriptionPeriods })).reasons).toEqual([
      { code: "ACTIVE_SUBSCRIPTION_PERIOD" }
    ]);
  });

  it("ignores advisory restrictions for every purpose", () => {
    for (const purpose of Object.values(VehicleAvailabilityPurpose)) {
      const decision = evaluateVehicleAvailability(
        input({
          activeRestrictions: [
            restriction("restriction-advisory", {
              scopes: Object.values(VehicleOperationalRestrictionScope),
              severity: VehicleOperationalRestrictionSeverity.ADVISORY
            })
          ],
          purpose,
          status:
            purpose === VehicleAvailabilityPurpose.DELIVERY
              ? VehicleStatus.RESERVED
              : VehicleStatus.AVAILABLE
        })
      );
      expect(decision.available).toBe(true);
    }
  });

  it.each([
    [VehicleAvailabilityPurpose.ALLOCATION, VehicleOperationalRestrictionScope.ALLOCATION],
    [VehicleAvailabilityPurpose.DELIVERY, VehicleOperationalRestrictionScope.DELIVERY],
    [VehicleAvailabilityPurpose.MARK_AVAILABLE, VehicleOperationalRestrictionScope.ALLOCATION],
    [VehicleAvailabilityPurpose.MARK_AVAILABLE, VehicleOperationalRestrictionScope.DELIVERY],
    [
      VehicleAvailabilityPurpose.MARK_AVAILABLE,
      VehicleOperationalRestrictionScope.INVENTORY_RELEASE
    ]
  ])("blocks %s for a blocking %s restriction", (purpose, scope) => {
    const activeRestriction = restriction(`restriction-${scope}`, { scopes: [scope] });
    const decision = evaluateVehicleAvailability(
      input({
        activeRestrictions: [activeRestriction],
        purpose,
        status:
          purpose === VehicleAvailabilityPurpose.DELIVERY
            ? VehicleStatus.RESERVED
            : VehicleStatus.AVAILABLE
      })
    );

    expect(decision).toEqual({
      available: false,
      purpose,
      reasons: [
        {
          code: "ACTIVE_OPERATIONAL_RESTRICTION",
          restrictionId: activeRestriction.id,
          sourceId: activeRestriction.sourceId,
          sourceType: activeRestriction.sourceType,
          workOrderId: activeRestriction.workOrderId ?? undefined
        }
      ]
    });
  });

  it("does not apply customer-use or purpose-mismatched blocking scopes", () => {
    const decision = evaluateVehicleAvailability(
      input({
        activeRestrictions: [
          restriction("customer-use", {
            scopes: [VehicleOperationalRestrictionScope.CUSTOMER_USE]
          }),
          restriction("delivery-only", {
            scopes: [VehicleOperationalRestrictionScope.DELIVERY]
          })
        ]
      })
    );

    expect(decision.available).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it("accumulates, deduplicates, and sorts every reason by code and restriction id", () => {
    const restrictionB = restriction("restriction-b");
    const restrictionA = restriction("restriction-a", { workOrderId: null });
    const decision = evaluateVehicleAvailability(
      input({
        activeRestrictions: [restrictionB, restrictionA, restrictionA],
        activeSubscriptionPeriods: [
          { id: "period-1", orderId: "order-1" },
          { id: "period-2", orderId: "order-2" }
        ],
        currentSalePriceAmount: 0n,
        deletedAt: new Date("2026-08-19T00:00:00.000Z"),
        salePriceStatus: SalePriceStatus.EXPIRED,
        status: VehicleStatus.RETIRED
      })
    );

    expect(decision.available).toBe(false);
    expect(decision.reasons).toEqual([
      {
        code: "ACTIVE_OPERATIONAL_RESTRICTION",
        restrictionId: "restriction-a",
        sourceId: restrictionA.sourceId,
        sourceType: restrictionA.sourceType
      },
      {
        code: "ACTIVE_OPERATIONAL_RESTRICTION",
        restrictionId: "restriction-b",
        sourceId: restrictionB.sourceId,
        sourceType: restrictionB.sourceType,
        workOrderId: restrictionB.workOrderId ?? undefined
      },
      { code: "ACTIVE_SUBSCRIPTION_PERIOD" },
      { code: "LIFECYCLE_STATUS_BLOCKED" },
      { code: "SALE_PRICE_NOT_EFFECTIVE" },
      { code: "SALE_PRICE_NOT_POSITIVE" },
      { code: "VEHICLE_DELETED" }
    ]);
  });
});

type InputOverrides = Partial<{
  activeRestrictions: VehicleAvailabilityInput["activeRestrictions"];
  activeSubscriptionPeriods: VehicleAvailabilityInput["activeSubscriptionPeriods"];
  currentSalePriceAmount: bigint | null;
  deletedAt: Date | null;
  purpose: VehicleAvailabilityPurpose;
  salePriceStatus: SalePriceStatus;
  status: VehicleStatus;
}>;

function input(overrides: InputOverrides = {}): VehicleAvailabilityInput {
  const purpose = overrides.purpose ?? VehicleAvailabilityPurpose.ALLOCATION;
  return {
    activeRestrictions: overrides.activeRestrictions ?? [],
    activeSubscriptionPeriods: overrides.activeSubscriptionPeriods ?? [],
    purpose,
    vehicle: {
      currentSalePriceAmount: Object.hasOwn(overrides, "currentSalePriceAmount")
        ? (overrides.currentSalePriceAmount ?? null)
        : 10_000_000n,
      deletedAt: overrides.deletedAt ?? null,
      id: "vehicle-1",
      salePriceStatus: overrides.salePriceStatus ?? SalePriceStatus.EFFECTIVE,
      status:
        overrides.status ??
        (purpose === VehicleAvailabilityPurpose.DELIVERY
          ? VehicleStatus.RESERVED
          : VehicleStatus.AVAILABLE)
    }
  };
}

function restriction(
  id: string,
  overrides: Partial<VehicleAvailabilityInput["activeRestrictions"][number]> = {}
): VehicleAvailabilityInput["activeRestrictions"][number] {
  return {
    id,
    restrictionType: VehicleOperationalRestrictionType.MAINTENANCE_OR_ACCIDENT,
    scopes: [VehicleOperationalRestrictionScope.ALLOCATION],
    severity: VehicleOperationalRestrictionSeverity.BLOCKING,
    sourceId: `source-${id}`,
    sourceKey: `key-${id}`,
    sourceType: "VEHICLE_INCIDENT",
    workOrderId: `work-order-${id}`,
    ...overrides
  };
}
