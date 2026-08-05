import {
  Prisma,
  SubscriptionChangePricingMode,
  SubscriptionContractSegment
} from "@prisma/client";

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
