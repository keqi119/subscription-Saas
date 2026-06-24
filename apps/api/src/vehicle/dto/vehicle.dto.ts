import { Type } from "class-transformer";
import {
  VehicleAcquisitionMode,
  VehicleBatteryUsageType,
  VehicleCapitalEventType,
  VehicleDepreciationMethod,
  VehicleModel,
  VehicleSalePriceReviewType,
  VehicleStatus
} from "@prisma/client";
import { IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";

export class CreateVehicleDto {
  @IsString()
  brand!: string;

  @IsOptional()
  @IsString()
  series?: string | null;

  @IsOptional()
  @IsString()
  model?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1900)
  modelYear?: number | null;

  /** @deprecated Use modelDefinitionId. vehicleModel is derived from model master data. */
  @IsOptional()
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel | null;

  @IsOptional()
  @IsUUID("4")
  modelDefinitionId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999.99)
  batteryCapacityKwh?: number | null;

  @IsOptional()
  @IsEnum(VehicleBatteryUsageType)
  batteryUsageType?: VehicleBatteryUsageType;

  @IsOptional()
  @IsEnum(VehicleAcquisitionMode)
  acquisitionMode?: VehicleAcquisitionMode;

  @IsString()
  vin!: string;

  @IsOptional()
  @IsString()
  plateNo?: string | null;

  @IsInt()
  @Min(1)
  purchasePriceAmount!: number;

  @IsOptional()
  @IsString()
  purchaseDate?: string | null;

  @IsOptional()
  @IsString()
  registrationDate?: string | null;

  @IsOptional()
  @IsString()
  latestRegistrationDate?: string | null;

  @IsOptional()
  @IsString()
  insuranceStartDate?: string | null;

  @IsOptional()
  @IsString()
  insuranceEndDate?: string | null;

  @IsOptional()
  @IsEnum(VehicleStatus)
  status?: VehicleStatus;

  @IsOptional()
  @IsInt()
  @Min(0)
  currentMileageKm?: number;

  @IsOptional()
  @IsString()
  assetLocation?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  series?: string | null;

  @IsOptional()
  @IsString()
  model?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1900)
  modelYear?: number | null;

  /** @deprecated Use modelDefinitionId. vehicleModel is derived from model master data. */
  @IsOptional()
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel | null;

  @IsOptional()
  @IsUUID("4")
  modelDefinitionId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999.99)
  batteryCapacityKwh?: number | null;

  @IsOptional()
  @IsEnum(VehicleBatteryUsageType)
  batteryUsageType?: VehicleBatteryUsageType;

  @IsOptional()
  @IsEnum(VehicleAcquisitionMode)
  acquisitionMode?: VehicleAcquisitionMode;

  @IsOptional()
  @IsString()
  vin?: string | null;

  @IsOptional()
  @IsString()
  plateNo?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  purchasePriceAmount?: number;

  @IsOptional()
  @IsString()
  purchaseDate?: string | null;

  @IsOptional()
  @IsString()
  registrationDate?: string | null;

  @IsOptional()
  @IsString()
  latestRegistrationDate?: string | null;

  @IsOptional()
  @IsString()
  insuranceStartDate?: string | null;

  @IsOptional()
  @IsString()
  insuranceEndDate?: string | null;

  @IsOptional()
  @IsEnum(VehicleStatus)
  status?: VehicleStatus;

  @IsOptional()
  @IsInt()
  @Min(0)
  currentMileageKm?: number;

  @IsOptional()
  @IsString()
  assetLocation?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class InitializeSalePriceDto {
  @IsInt()
  @Min(1)
  currentSalePriceAmount!: number;

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsIn([VehicleSalePriceReviewType.INITIAL_POOL, VehicleSalePriceReviewType.RETURN_REINIT])
  reviewType?: VehicleSalePriceReviewType;

  @IsString()
  reason!: string;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class ReviewSalePriceDto {
  @IsInt()
  @Min(1)
  newSalePriceAmount!: number;

  @IsString()
  reviewQuarter!: string;

  @IsString()
  effectiveFrom!: string;

  @IsString()
  reason!: string;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateVehicleStatusDto {
  @IsEnum(VehicleStatus)
  status!: VehicleStatus;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpsertVehicleAssetCostProfileDto {
  @IsEnum(VehicleDepreciationMethod)
  depreciationMethod!: VehicleDepreciationMethod;

  @IsOptional()
  @IsString()
  depreciationStartDate?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  usefulLifeMonths!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  residualValueAmount!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  capitalCostRateBps?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  annualInsuranceCostAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  annualMaintenanceReserveAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  otherMonthlyCostAmount?: number | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class CreateVehicleCapitalEventDto {
  @IsEnum(VehicleCapitalEventType)
  eventType!: VehicleCapitalEventType;

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsEnum(VehicleAcquisitionMode)
  acquisitionMode?: VehicleAcquisitionMode | null;

  @IsOptional()
  @IsString()
  financingInstrumentId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  equityCapitalAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  debtPrincipalAmount?: number | null;

  @IsOptional()
  @IsString()
  externalOwnerName?: string | null;

  @IsOptional()
  @IsString()
  lessorName?: string | null;

  @IsOptional()
  @IsString()
  managedOwnerName?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateVehicleCapitalEventDto {
  @IsOptional()
  @IsEnum(VehicleCapitalEventType)
  eventType?: VehicleCapitalEventType;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsEnum(VehicleAcquisitionMode)
  acquisitionMode?: VehicleAcquisitionMode | null;

  @IsOptional()
  @IsString()
  financingInstrumentId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  equityCapitalAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  debtPrincipalAmount?: number | null;

  @IsOptional()
  @IsString()
  externalOwnerName?: string | null;

  @IsOptional()
  @IsString()
  lessorName?: string | null;

  @IsOptional()
  @IsString()
  managedOwnerName?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class CancelVehicleCapitalEventDto {
  @IsOptional()
  @IsString()
  remark?: string | null;
}
