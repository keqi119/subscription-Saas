import type {
  SalePriceStatus,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionType,
  VehicleStatus
} from "@prisma/client";

export enum VehicleAvailabilityPurpose {
  ALLOCATION = "ALLOCATION",
  DELIVERY = "DELIVERY",
  MARK_AVAILABLE = "MARK_AVAILABLE"
}

export type VehicleAvailabilityReasonCode =
  | "VEHICLE_NOT_FOUND"
  | "VEHICLE_DELETED"
  | "LIFECYCLE_STATUS_BLOCKED"
  | "SALE_PRICE_NOT_EFFECTIVE"
  | "SALE_PRICE_NOT_POSITIVE"
  | "ACTIVE_SUBSCRIPTION_PERIOD"
  | "ACTIVE_OPERATIONAL_RESTRICTION";

export interface VehicleAvailabilityInput {
  readonly purpose: VehicleAvailabilityPurpose;
  readonly vehicle: null | {
    readonly id: string;
    readonly status: VehicleStatus;
    readonly deletedAt: Date | null;
    readonly salePriceStatus: SalePriceStatus;
    readonly currentSalePriceAmount: bigint | null;
  };
  readonly activeSubscriptionPeriods: ReadonlyArray<{ id: string; orderId: string }>;
  readonly activeRestrictions: ReadonlyArray<{
    id: string;
    restrictionType: VehicleOperationalRestrictionType;
    severity: VehicleOperationalRestrictionSeverity;
    scopes: readonly VehicleOperationalRestrictionScope[];
    sourceType: string;
    sourceId: string;
    sourceKey: string;
    workOrderId: string | null;
  }>;
}

export interface VehicleAvailabilityDecision {
  readonly available: boolean;
  readonly purpose: VehicleAvailabilityPurpose;
  readonly reasons: ReadonlyArray<{
    code: VehicleAvailabilityReasonCode;
    restrictionId?: string;
    sourceId?: string;
    sourceType?: string;
    workOrderId?: string;
  }>;
}

export type VehicleAvailabilitySnapshot = Omit<VehicleAvailabilityInput, "purpose">;

type AvailabilityReason = VehicleAvailabilityDecision["reasons"][number];

const PURPOSE_STATUSES: Readonly<Record<VehicleAvailabilityPurpose, ReadonlySet<string>>> = {
  [VehicleAvailabilityPurpose.ALLOCATION]: new Set(["AVAILABLE"]),
  [VehicleAvailabilityPurpose.DELIVERY]: new Set(["RESERVED"]),
  [VehicleAvailabilityPurpose.MARK_AVAILABLE]: new Set([
    "DRAFT",
    "IN_PREPARATION",
    "RETURNED",
    "MAINTENANCE",
    "AVAILABLE"
  ])
};

const PURPOSE_SCOPES: Readonly<Record<VehicleAvailabilityPurpose, ReadonlySet<string>>> = {
  [VehicleAvailabilityPurpose.ALLOCATION]: new Set(["ALLOCATION"]),
  [VehicleAvailabilityPurpose.DELIVERY]: new Set(["DELIVERY"]),
  [VehicleAvailabilityPurpose.MARK_AVAILABLE]: new Set([
    "ALLOCATION",
    "DELIVERY",
    "INVENTORY_RELEASE"
  ])
};

export function evaluateVehicleAvailability(
  input: VehicleAvailabilityInput
): VehicleAvailabilityDecision {
  const reasons = new Map<string, AvailabilityReason>();
  const add = (reason: AvailabilityReason) => {
    const key = `${reason.code}\u0000${reason.restrictionId ?? ""}`;
    if (!reasons.has(key)) reasons.set(key, reason);
  };

  if (!input.vehicle) {
    add({ code: "VEHICLE_NOT_FOUND" });
  } else {
    if (input.vehicle.deletedAt) add({ code: "VEHICLE_DELETED" });
    if (!PURPOSE_STATUSES[input.purpose].has(input.vehicle.status)) {
      add({ code: "LIFECYCLE_STATUS_BLOCKED" });
    }
    if (input.purpose !== VehicleAvailabilityPurpose.DELIVERY) {
      if (input.vehicle.salePriceStatus !== "EFFECTIVE") {
        add({ code: "SALE_PRICE_NOT_EFFECTIVE" });
      }
      if (
        input.vehicle.currentSalePriceAmount === null ||
        input.vehicle.currentSalePriceAmount <= 0n
      ) {
        add({ code: "SALE_PRICE_NOT_POSITIVE" });
      }
    }
  }

  if (input.activeSubscriptionPeriods.length > 0) {
    add({ code: "ACTIVE_SUBSCRIPTION_PERIOD" });
  }

  const blockingScopes = PURPOSE_SCOPES[input.purpose];
  for (const restriction of input.activeRestrictions) {
    if (
      restriction.severity !== "BLOCKING" ||
      !restriction.scopes.some((scope) => blockingScopes.has(scope))
    ) {
      continue;
    }
    add({
      code: "ACTIVE_OPERATIONAL_RESTRICTION",
      restrictionId: restriction.id,
      sourceId: restriction.sourceId,
      sourceType: restriction.sourceType,
      ...(restriction.workOrderId ? { workOrderId: restriction.workOrderId } : {})
    });
  }

  const sorted = [...reasons.values()].sort((left, right) => {
    const code = compare(left.code, right.code);
    return code || compare(left.restrictionId ?? "", right.restrictionId ?? "");
  });
  return { available: sorted.length === 0, purpose: input.purpose, reasons: sorted };
}

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
