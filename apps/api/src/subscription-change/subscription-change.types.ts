import {
  Prisma,
  SubscriptionChangePricingMode,
  SubscriptionChangeType,
  SubscriptionContractSegment
} from "@prisma/client";

export const SUBSCRIPTION_CHANGE_ACTIONS = [
  "CREATE_QUOTE",
  "APPROVE",
  "PUBLISH_CUSTOMER_CONFIRMATION",
  "GENERATE_CONTRACT",
  "START_ESIGN",
  "EXECUTE",
  "RETRY",
  "CANCEL",
  "MANUAL_TAKEOVER"
] as const;

export type SubscriptionChangeAction = (typeof SUBSCRIPTION_CHANGE_ACTIONS)[number];

interface CreateSubscriptionChangeBase {
  idempotencyKey?: string;
  orderId: string;
}

export interface CreateExtensionChangeInput extends CreateSubscriptionChangeBase {
  changeType: typeof SubscriptionChangeType.EXTENSION;
  detail: {
    discountedMonthlyFeeAmount?: bigint;
    extensionMonths: number;
    priceOverrideReason?: string;
    pricingMode: SubscriptionChangePricingMode;
    requestedVehicleBaseFeeAmount?: bigint;
    subscriptionPlanId?: string;
  };
}

export interface CreateVehicleSwapChangeInput extends CreateSubscriptionChangeBase {
  changeType: typeof SubscriptionChangeType.VEHICLE_SWAP;
  detail: {
    plannedSwapAt: string;
    targetSubscriptionPlanId: string;
    targetVehicleId: string;
    targetVehiclePackageId?: string;
  };
}

export interface CreateEarlyTerminationChangeInput extends CreateSubscriptionChangeBase {
  changeType: typeof SubscriptionChangeType.EARLY_TERMINATION;
  detail: {
    effectiveDate: string;
    reason: string;
  };
}

export interface CreateManagedOtherChangeInput extends CreateSubscriptionChangeBase {
  changeType: typeof SubscriptionChangeType.MANAGED_OTHER;
  detail: {
    beforeSnapshot?: Record<string, unknown>;
    effectiveDate: string;
    evidence: ReadonlyArray<Readonly<Record<string, unknown>>>;
    operation: string;
    reason: string;
  };
}

export type CreateSubscriptionChangeInput =
  | CreateExtensionChangeInput
  | CreateVehicleSwapChangeInput
  | CreateEarlyTerminationChangeInput
  | CreateManagedOtherChangeInput;

export interface ContractSegmentTerms {
  segmentId: string;
  startDate: Date;
  endDate: Date;
  monthlyFeeAmount: bigint;
  mileageLimitKm: number;
  overMileageFeeAmount: bigint;
  planSnapshot: Prisma.JsonValue;
}

export interface ExtensionVehicleFacts {
  currentSalePriceAmount: bigint | null;
  id: string;
  modelDefinitionId: string;
  purchasePriceAmount: bigint;
  status: string;
}

export interface ExtensionPricingInput {
  asOf?: Date;
  discountedMonthlyFeeAmount?: bigint;
  extensionMonths?: number;
  pricingMode: SubscriptionChangePricingMode;
  requestedVehicleBaseFeeAmount?: bigint;
  sourceSegment: SubscriptionContractSegment;
  subscriptionPlanId?: string;
  vehicle: ExtensionVehicleFacts;
}

export interface ExtensionQuotePreview {
  baselineMonthlyFeeAmount?: bigint;
  energyLimitCount: number | null;
  energyLimitKwh: number | null;
  mileageLimitKm: number;
  monthlyFeeAmount: bigint;
  overMileageFeeAmount: bigint;
  planSnapshot: Prisma.InputJsonValue;
  priceRuleSnapshot: Prisma.InputJsonValue;
  productId: string | null;
  productVersionId: string | null;
  pricingMode: SubscriptionChangePricingMode;
  quoteSnapshot: Prisma.InputJsonValue;
  subscriptionPlanId: string | null;
  targetEndDate: Date;
  targetStartDate: Date;
}

export interface VehicleSwapPricingInput {
  currentDepositAmount: bigint;
  plannedSwapAt: Date;
  sourceSegment: SubscriptionContractSegment;
  sourceVehicle: ExtensionVehicleFacts;
  targetSubscriptionPlanId: string;
  targetVehicle: ExtensionVehicleFacts;
  targetVehiclePackageId: string;
}

export interface VehicleSwapQuotePreview {
  classification: "OUT_OF_PACKAGE" | "PACKAGE_INCLUDED";
  commercialSnapshot: Prisma.InputJsonValue;
  commercialSnapshotHash: string;
  depositAmount: bigint;
  depositDeltaAmount: bigint;
  energyLimitCount: number | null;
  energyLimitCountDelta: number | null;
  energyLimitKwh: number | null;
  energyLimitKwhDelta: number | null;
  mileageLimitDeltaKm: number;
  mileageLimitKm: number;
  monthlyFeeAmount: bigint;
  monthlyFeeDeltaAmount: bigint;
  overMileageFeeAmount: bigint;
  planSnapshot: Prisma.InputJsonValue;
  priceRuleSnapshot: Prisma.InputJsonValue;
  pricingMode: SubscriptionChangePricingMode;
  productId: string | null;
  productVersionId: string | null;
  quoteSnapshot: Prisma.InputJsonValue;
  targetSubscriptionPlanId: string;
  targetVehiclePackageId: string;
}
