import {
  BenefitType,
  MonthlyFeeMode,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  QuoteStatus,
  RecordStatus,
  SubscriptionPlanStatus,
  VehicleModel
} from "@prisma/client";
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min
} from "class-validator";

export class CreateProductDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @IsOptional()
  @IsString()
  description?: string | null;
}

export class CreateProductVersionDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsString()
  versionNo!: string;

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsEnum(ProductVersionStatus)
  status?: ProductVersionStatus;
}

export class UpdateProductVersionDto {
  @IsOptional()
  @IsString()
  versionNo?: string;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;
}

export class CreatePriceRuleDto {
  /** @deprecated Legacy compatibility only. Use modelDefinitionId. */
  @IsOptional()
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel;

  @IsOptional()
  @IsUUID()
  modelDefinitionId?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  monthlyFeeRate?: number;

  @IsInt()
  @Min(1)
  minPeriodMonths!: number;

  @IsInt()
  @Min(1)
  maxPeriodMonths!: number;

  @IsInt()
  @Min(0)
  baseMileageKm!: number;

  @IsInt()
  @Min(0)
  overMileageFeeAmount!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  energyLimitKwh?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  energyLimitCount?: number | null;

  @IsOptional()
  @IsEnum(RecordStatus)
  status?: RecordStatus;
}

export class UpdatePriceRuleDto {
  /** @deprecated Legacy compatibility only. Use modelDefinitionId. */
  @IsOptional()
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel;

  @IsOptional()
  @IsUUID()
  modelDefinitionId?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  monthlyFeeRate?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minPeriodMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxPeriodMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  baseMileageKm?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  overMileageFeeAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  energyLimitKwh?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  energyLimitCount?: number | null;

  @IsOptional()
  @IsEnum(RecordStatus)
  status?: RecordStatus;
}

export class CreateQuoteDto {
  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @IsOptional()
  buyoutAmount?: unknown;

  @IsOptional()
  downPaymentAmount?: unknown;

  @IsOptional()
  finalPaymentAmount?: unknown;

  @IsOptional()
  installmentPlan?: unknown;

  @IsOptional()
  rentToOwn?: unknown;

  @IsOptional()
  titleTransferTerms?: unknown;

  @IsOptional()
  @IsUUID()
  subscriptionPlanId?: string;

  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @IsOptional()
  @IsUUID()
  productVersionId?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsUUID()
  modelDefinitionId?: string;

  @IsOptional()
  @IsUUID()
  vehiclePackageId?: string;

  @IsOptional()
  @IsUUID()
  mileagePackageId?: string;

  @IsOptional()
  @IsUUID()
  energyPackageId?: string;

  @IsOptional()
  @IsUUID()
  benefitPackageId?: string | null;

  /** @deprecated Legacy compatibility only. Quote model display now uses snapshots where available. */
  @IsOptional()
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel;

  @IsOptional()
  @IsInt()
  @Min(1)
  vehiclePurchasePriceAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  monthlyFeeAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  vehicleBaseFeeAmount?: number;

  @IsInt()
  @Min(1)
  periodMonths!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  mileageLimitKm?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  energyLimitKwh?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  energyLimitCount?: number | null;
}

export class CreateSubscriptionPlanDto {
  @IsString()
  planName!: string;

  @IsUUID()
  productId!: string;

  @IsUUID()
  productVersionId!: string;

  @IsUUID()
  vehiclePackageId!: string;

  @IsUUID()
  mileagePackageId!: string;

  @IsUUID()
  energyPackageId!: string;

  @IsOptional()
  @IsUUID()
  benefitPackageId?: string | null;

  @IsOptional()
  @IsEnum(MonthlyFeeMode)
  monthlyFeeMode?: MonthlyFeeMode;

  @IsOptional()
  @IsInt()
  @Min(0)
  baseMonthlyFeeAmount?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  monthlyFeeRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  monthlyFeeCapRate?: number | null;

  @IsInt()
  @Min(1)
  minPeriodMonths!: number;

  @IsInt()
  @Min(1)
  maxPeriodMonths!: number;

  @IsOptional()
  @IsEnum(SubscriptionPlanStatus)
  status?: SubscriptionPlanStatus;

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateSubscriptionPlanDto {
  @IsOptional()
  @IsString()
  planName?: string;

  @IsOptional()
  @IsUUID()
  vehiclePackageId?: string;

  @IsOptional()
  @IsUUID()
  mileagePackageId?: string;

  @IsOptional()
  @IsUUID()
  energyPackageId?: string;

  @IsOptional()
  @IsUUID()
  benefitPackageId?: string | null;

  @IsOptional()
  @IsEnum(MonthlyFeeMode)
  monthlyFeeMode?: MonthlyFeeMode;

  @IsOptional()
  @IsInt()
  @Min(0)
  baseMonthlyFeeAmount?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  monthlyFeeRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  monthlyFeeCapRate?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  minPeriodMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxPeriodMonths?: number;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class CreateVehiclePackageDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  productVersionId!: string;

  @IsString()
  packageName!: string;

  /** @deprecated Legacy compatibility only. Use modelDefinitionId. */
  @IsOptional()
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel;

  @IsOptional()
  @IsUUID()
  modelDefinitionId?: string | null;

  @IsOptional()
  @IsString()
  vehicleModelName?: string | null;

  @IsOptional()
  @IsString()
  brand?: string | null;

  @IsOptional()
  @IsString()
  series?: string | null;

  @IsOptional()
  @IsString()
  configName?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  minPurchasePriceAmount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxPurchasePriceAmount?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  monthlyFeeRate?: number;

  @IsInt()
  @Min(1)
  minPeriodMonths!: number;

  @IsInt()
  @Min(1)
  maxPeriodMonths!: number;

  @IsOptional()
  @IsEnum(RecordStatus)
  status?: RecordStatus;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateVehiclePackageDto {
  /** @deprecated Legacy compatibility only. Use modelDefinitionId. */
  @IsOptional()
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel;

  @IsOptional()
  @IsUUID()
  modelDefinitionId?: string | null;

  @IsOptional()
  @IsString()
  packageName?: string;

  @IsOptional()
  @IsString()
  vehicleModelName?: string | null;

  @IsOptional()
  @IsString()
  brand?: string | null;

  @IsOptional()
  @IsString()
  series?: string | null;

  @IsOptional()
  @IsString()
  configName?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  minPurchasePriceAmount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxPurchasePriceAmount?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  monthlyFeeRate?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minPeriodMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxPeriodMonths?: number;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class CreateMileagePackageDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  productVersionId!: string;

  @IsString()
  packageName!: string;

  @IsInt()
  @Min(0)
  monthlyMileageKm!: number;

  @IsInt()
  @Min(0)
  overMileageFeeAmount!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceAmount?: number;

  @IsOptional()
  @IsEnum(RecordStatus)
  status?: RecordStatus;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateMileagePackageDto {
  @IsOptional()
  @IsString()
  packageName?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyMileageKm?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  overMileageFeeAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceAmount?: number;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class CreateEnergyPackageDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  productVersionId!: string;

  @IsString()
  packageName!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyEnergyKwh?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyEnergyCount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceAmount?: number;

  @IsOptional()
  @IsString()
  stationScope?: string | null;

  @IsOptional()
  @IsString()
  serviceDescription?: string | null;

  @IsOptional()
  @IsEnum(RecordStatus)
  status?: RecordStatus;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateEnergyPackageDto {
  @IsOptional()
  @IsString()
  packageName?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyEnergyKwh?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyEnergyCount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceAmount?: number;

  @IsOptional()
  @IsString()
  stationScope?: string | null;

  @IsOptional()
  @IsString()
  serviceDescription?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class CreateBenefitPackageDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  productVersionId!: string;

  @IsString()
  packageName!: string;

  @IsEnum(BenefitType)
  benefitType!: BenefitType;

  @IsOptional()
  @IsInt()
  @Min(0)
  benefitCount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceAmount?: number;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsEnum(RecordStatus)
  status?: RecordStatus;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateBenefitPackageDto {
  @IsOptional()
  @IsString()
  packageName?: string;

  @IsOptional()
  @IsEnum(BenefitType)
  benefitType?: BenefitType;

  @IsOptional()
  @IsInt()
  @Min(0)
  benefitCount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceAmount?: number;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateQuoteDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  monthlyFeeAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  periodMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  mileageLimitKm?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  energyLimitKwh?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  energyLimitCount?: number | null;

  @IsOptional()
  @IsEnum(QuoteStatus)
  status?: QuoteStatus;
}
