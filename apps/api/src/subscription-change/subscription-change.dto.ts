import { Type } from "class-transformer";
import { SubscriptionChangePricingMode, SubscriptionChangeType } from "@prisma/client";
import {
  IsArray,
  IsDateString,
  IsDefined,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested
} from "class-validator";

const MONEY_PATTERN = /^\d+$/;

export class CreateExtensionChangeDetailDto {
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
}

export class CreateVehicleSwapChangeDetailDto {
  @IsUUID()
  targetVehicleId!: string;

  @IsUUID()
  targetSubscriptionPlanId!: string;

  @IsOptional()
  @IsUUID()
  targetVehiclePackageId?: string;

  @IsDateString()
  plannedSwapAt!: string;
}

export class CreateEarlyTerminationChangeDetailDto {
  @IsDateString()
  effectiveDate!: string;

  @IsString()
  @MaxLength(2_000)
  reason!: string;
}

export class CreateManagedOtherChangeDetailDto {
  @IsDateString()
  effectiveDate!: string;

  @IsString()
  @MaxLength(2_000)
  reason!: string;

  @IsArray()
  @IsObject({ each: true })
  evidence!: Array<Record<string, unknown>>;

  @IsString()
  @MaxLength(128)
  operation!: string;

  @IsOptional()
  @IsObject()
  beforeSnapshot?: Record<string, unknown>;
}

export type CreateSubscriptionChangeDetailDto =
  | CreateExtensionChangeDetailDto
  | CreateVehicleSwapChangeDetailDto
  | CreateEarlyTerminationChangeDetailDto
  | CreateManagedOtherChangeDetailDto;

export class CreateSubscriptionChangeDto {
  @IsUUID()
  orderId!: string;

  @IsEnum(SubscriptionChangeType)
  changeType!: SubscriptionChangeType;

  @ValidateNested()
  @IsDefined()
  @Type((options) => detailDtoFor(options?.object?.changeType))
  detail!: CreateSubscriptionChangeDetailDto;
}

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

function detailDtoFor(changeType: SubscriptionChangeType | undefined) {
  switch (changeType) {
    case SubscriptionChangeType.EXTENSION:
      return CreateExtensionChangeDetailDto;
    case SubscriptionChangeType.VEHICLE_SWAP:
      return CreateVehicleSwapChangeDetailDto;
    case SubscriptionChangeType.EARLY_TERMINATION:
      return CreateEarlyTerminationChangeDetailDto;
    case SubscriptionChangeType.MANAGED_OTHER:
      return CreateManagedOtherChangeDetailDto;
    default:
      return Object;
  }
}
