import { Type } from "class-transformer";
import { SubscriptionChangePricingMode } from "@prisma/client";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min
} from "class-validator";

const MONEY_PATTERN = /^\d+$/;

export class CreateSubscriptionExtensionDto {
  @IsUUID()
  orderId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  extensionMonths!: number;

  @IsEnum(SubscriptionChangePricingMode)
  pricingMode!: SubscriptionChangePricingMode;

  @IsOptional()
  @IsUUID()
  subscriptionPlanId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  priceOverrideReason?: string;

  @IsOptional()
  @Matches(MONEY_PATTERN)
  discountedMonthlyFeeAmount?: string;

  @IsOptional()
  @Matches(MONEY_PATTERN)
  requestedVehicleBaseFeeAmount?: string;

  @IsOptional()
  @IsUUID()
  renewalConsiderationId?: string;
}

export class SubscriptionExtensionQuoteDto {
  @IsOptional()
  @IsUUID()
  subscriptionPlanId?: string;

  @IsOptional()
  @Matches(MONEY_PATTERN)
  discountedMonthlyFeeAmount?: string;

  @IsOptional()
  @Matches(MONEY_PATTERN)
  requestedVehicleBaseFeeAmount?: string;
}

export class CreateSubscriptionExtensionQuoteDto extends SubscriptionExtensionQuoteDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
}

export class ApproveSubscriptionExtensionPriceDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;

  @IsString()
  @MaxLength(2_000)
  reason!: string;
}

export class VersionedSubscriptionChangeDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
}

export class ReasonedSubscriptionChangeDto extends VersionedSubscriptionChangeDto {
  @IsString()
  @MaxLength(2_000)
  reason!: string;
}

export function optionalMoney(value: string | undefined) {
  return value === undefined ? undefined : BigInt(value);
}
