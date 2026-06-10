import { Type } from "class-transformer";
import {
  MarketPriceImportStatus,
  MarketPriceObservationStatus,
  MarketPriceSource,
  MarketPriceType,
  MarketSellerType,
  VehicleBatteryUsageType,
  VehicleResidualCurveMethod,
  VehicleResidualCurveStatus
} from "@prisma/client";
import { IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";

export class MarketPriceObservationsQueryDto {
  @IsOptional()
  @IsEnum(MarketPriceSource)
  source?: MarketPriceSource;

  @IsOptional()
  @IsEnum(MarketPriceType)
  priceType?: MarketPriceType;

  @IsOptional()
  @IsEnum(MarketPriceObservationStatus)
  observationStatus?: MarketPriceObservationStatus;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  series?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  modelYear?: number;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minMileageKm?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxMileageKm?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPriceAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPriceAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class CreateMarketPriceObservationDto {
  @IsEnum(MarketPriceSource)
  source!: MarketPriceSource;

  @IsOptional()
  @IsString()
  sourceListingId?: string | null;

  @IsString()
  @IsNotEmpty()
  observedAt!: string;

  @IsString()
  @IsNotEmpty()
  brand!: string;

  @IsOptional()
  @IsString()
  series?: string | null;

  @IsString()
  @IsNotEmpty()
  model!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  modelYear?: number | null;

  @IsOptional()
  @IsString()
  trim?: string | null;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  batteryCapacityKwh?: number | null;

  @IsOptional()
  @IsEnum(VehicleBatteryUsageType)
  batteryUsageType?: VehicleBatteryUsageType | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  mileageKm?: number | null;

  @IsOptional()
  @IsString()
  registrationDate?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  vehicleAgeMonths?: number | null;

  @IsOptional()
  @IsString()
  province?: string | null;

  @IsOptional()
  @IsString()
  city?: string | null;

  @IsEnum(MarketPriceType)
  priceType!: MarketPriceType;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  priceAmount!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  listingPriceAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  transactionPriceAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  listingDays?: number | null;

  @IsOptional()
  @IsEnum(MarketSellerType)
  sellerType?: MarketSellerType | null;

  @IsOptional()
  @IsString()
  conditionGrade?: string | null;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  batteryHealthPercent?: number | null;

  @IsOptional()
  @IsBoolean()
  accidentFlag?: boolean | null;

  @IsOptional()
  @IsString()
  sourceUrl?: string | null;

  @IsOptional()
  @IsString()
  sourceUrlHash?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class ImportMarketPriceCsvDto {
  @IsEnum(MarketPriceSource)
  source!: MarketPriceSource;

  @IsOptional()
  @IsString()
  fileName?: string | null;

  @IsString()
  @IsNotEmpty()
  csvText!: string;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class VoidMarketPriceObservationDto {
  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class MarketPriceImportBatchesQueryDto {
  @IsOptional()
  @IsEnum(MarketPriceSource)
  source?: MarketPriceSource;

  @IsOptional()
  @IsEnum(MarketPriceImportStatus)
  importStatus?: MarketPriceImportStatus;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class GenerateResidualCurveDto {
  @IsOptional()
  @IsString()
  curveName?: string | null;

  @IsOptional()
  @IsString()
  curveVersion?: string | null;

  @IsString()
  @IsNotEmpty()
  brand!: string;

  @IsOptional()
  @IsString()
  series?: string | null;

  @IsString()
  @IsNotEmpty()
  model!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  modelYear?: number | null;

  @IsOptional()
  @IsString()
  trim?: string | null;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  batteryCapacityKwh?: number | null;

  @IsOptional()
  @IsEnum(VehicleBatteryUsageType)
  batteryUsageType?: VehicleBatteryUsageType | null;

  @IsOptional()
  @IsArray()
  @IsEnum(MarketPriceType, { each: true })
  priceTypes?: MarketPriceType[];

  @IsOptional()
  @IsString()
  sampleStartDate?: string | null;

  @IsOptional()
  @IsString()
  sampleEndDate?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  referencePriceAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  minSamplePerPoint?: number;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class ResidualCurveQueryDto {
  @IsOptional()
  @IsEnum(VehicleResidualCurveStatus)
  curveStatus?: VehicleResidualCurveStatus;

  @IsOptional()
  @IsEnum(VehicleResidualCurveMethod)
  curveMethod?: VehicleResidualCurveMethod;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  series?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  modelYear?: number;

  @IsOptional()
  @IsEnum(VehicleBatteryUsageType)
  batteryUsageType?: VehicleBatteryUsageType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class ActivateResidualCurveDto {
  @IsString()
  @IsNotEmpty()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class ArchiveResidualCurveDto {
  @IsOptional()
  @IsString()
  remark?: string | null;
}
