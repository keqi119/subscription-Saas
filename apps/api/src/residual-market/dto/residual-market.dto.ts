import { Type } from "class-transformer";
import {
  MarketPriceImportStatus,
  MarketPriceObservationStatus,
  MarketPriceSource,
  MarketPriceType,
  MarketSellerType,
  ResidualModelAlgorithm,
  ResidualModelRunOutputType,
  ResidualModelRunStatus,
  ResidualModelRunType,
  ResidualModelTargetType,
  VehicleResidualForecastStatus,
  VehicleBatteryUsageType,
  VehicleResidualCurveMethod,
  VehicleResidualCurveStatus
} from "@prisma/client";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested
} from "class-validator";

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
  modelDefinitionId?: string;

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

  @IsOptional()
  @IsString()
  modelDefinitionId?: string | null;

  @IsOptional()
  @IsString()
  brand?: string | null;

  @IsOptional()
  @IsString()
  series?: string | null;

  @IsOptional()
  @IsString()
  model?: string | null;

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

  @IsOptional()
  @IsString()
  modelDefinitionId?: string | null;

  @IsOptional()
  @IsString()
  brand?: string | null;

  @IsOptional()
  @IsString()
  series?: string | null;

  @IsOptional()
  @IsString()
  model?: string | null;

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
  modelRunId?: string | null;

  @IsOptional()
  @IsBoolean()
  autoCreateModelRun?: boolean;

  @IsOptional()
  @IsString()
  modelRunName?: string | null;

  @IsOptional()
  @IsString()
  modelVersion?: string | null;

  @IsOptional()
  @IsString()
  modelProvider?: string | null;

  @IsOptional()
  @IsString()
  artifactUri?: string | null;

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
  modelDefinitionId?: string;

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

export class GenerateVehicleResidualForecastDto {
  @IsOptional()
  @IsString()
  asOfDate?: string | null;

  @IsOptional()
  @IsString()
  curveId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  horizonMonths?: number[];

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class VehicleResidualForecastQueryDto {
  @IsOptional()
  @IsEnum(VehicleResidualForecastStatus)
  forecastStatus?: VehicleResidualForecastStatus;

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

export class AdoptVehicleResidualForecastPointDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  adoptedResidualAmount!: number;

  @IsOptional()
  @IsString()
  adoptRemark?: string | null;
}

export class VoidVehicleResidualForecastDto {
  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class ResidualModelRunQueryDto {
  @IsOptional()
  @IsEnum(ResidualModelRunType)
  runType?: ResidualModelRunType;

  @IsOptional()
  @IsEnum(ResidualModelRunStatus)
  runStatus?: ResidualModelRunStatus;

  @IsOptional()
  @IsEnum(ResidualModelTargetType)
  targetType?: ResidualModelTargetType;

  @IsOptional()
  @IsString()
  modelVersion?: string;

  @IsOptional()
  @IsString()
  targetModelDefinitionId?: string;

  @IsOptional()
  @IsString()
  targetBrand?: string;

  @IsOptional()
  @IsString()
  targetSeries?: string;

  @IsOptional()
  @IsString()
  targetModel?: string;

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

export class CreateResidualModelRunDto {
  @IsOptional()
  @IsString()
  runName?: string | null;

  @IsEnum(ResidualModelRunType)
  runType!: ResidualModelRunType;

  @IsOptional()
  @IsEnum(ResidualModelRunStatus)
  runStatus?: ResidualModelRunStatus;

  @IsOptional()
  @IsString()
  modelName?: string | null;

  @IsOptional()
  @IsString()
  modelVersion?: string | null;

  @IsOptional()
  @IsString()
  modelProvider?: string | null;

  @IsOptional()
  @IsEnum(ResidualModelAlgorithm)
  algorithm?: ResidualModelAlgorithm | null;

  @IsEnum(ResidualModelTargetType)
  targetType!: ResidualModelTargetType;

  @IsOptional()
  @IsString()
  targetModelDefinitionId?: string | null;

  @IsOptional()
  @IsString()
  targetBrand?: string | null;

  @IsOptional()
  @IsString()
  targetSeries?: string | null;

  @IsOptional()
  @IsString()
  targetModel?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  targetModelYear?: number | null;

  @IsOptional()
  @IsString()
  targetTrim?: string | null;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  targetBatteryCapacityKwh?: number | null;

  @IsOptional()
  @IsEnum(VehicleBatteryUsageType)
  targetBatteryUsageType?: VehicleBatteryUsageType | null;

  @IsOptional()
  @IsString()
  trainingDataStartDate?: string | null;

  @IsOptional()
  @IsString()
  trainingDataEndDate?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sampleCount?: number | null;

  @IsOptional()
  @IsObject()
  featureSnapshot?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  parameterSnapshot?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  filterSnapshot?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class CompleteResidualModelRunOutputDto {
  @IsEnum(ResidualModelRunOutputType)
  outputType!: ResidualModelRunOutputType;

  @IsOptional()
  @IsString()
  curveId?: string | null;

  @IsOptional()
  @IsString()
  forecastId?: string | null;

  @IsOptional()
  @IsString()
  vehicleId?: string | null;

  @IsOptional()
  @IsString()
  outputNo?: string | null;

  @IsOptional()
  @IsObject()
  outputSnapshot?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class CompleteResidualModelRunDto {
  @IsOptional()
  @IsObject()
  metricsSnapshot?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  outputSnapshot?: Record<string, unknown> | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompleteResidualModelRunOutputDto)
  outputs?: CompleteResidualModelRunOutputDto[];

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class FailResidualModelRunDto {
  @IsOptional()
  @IsObject()
  errorSnapshot?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class CancelResidualModelRunDto {
  @IsOptional()
  @IsString()
  remark?: string | null;
}
