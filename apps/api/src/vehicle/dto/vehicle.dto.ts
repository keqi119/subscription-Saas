import { Type } from "class-transformer";
import { VehicleBatteryUsageType, VehicleModel, VehicleSalePriceReviewType, VehicleStatus } from "@prisma/client";
import { IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from "class-validator";

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

  @IsEnum(VehicleModel)
  vehicleModel!: VehicleModel;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999.99)
  batteryCapacityKwh?: number | null;

  @IsOptional()
  @IsEnum(VehicleBatteryUsageType)
  batteryUsageType?: VehicleBatteryUsageType;

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

  @IsOptional()
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel | null;

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
