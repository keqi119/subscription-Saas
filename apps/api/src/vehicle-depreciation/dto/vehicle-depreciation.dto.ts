import { Type } from "class-transformer";
import {
  VehicleDepreciationBasisSource,
  VehicleDepreciationMethod,
  VehicleDepreciationPolicyStatus,
  VehicleDepreciationRecordSource,
  VehicleDepreciationRecordStatus
} from "@prisma/client";
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";

export class VehicleDepreciationPoliciesQueryDto {
  @IsOptional()
  @IsUUID("4")
  vehicleId?: string;

  @IsOptional()
  @IsEnum(VehicleDepreciationPolicyStatus)
  policyStatus?: VehicleDepreciationPolicyStatus;

  @IsOptional()
  @IsEnum(VehicleDepreciationMethod)
  depreciationMethod?: VehicleDepreciationMethod;

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

export class CreateVehicleDepreciationPolicyDto {
  @IsOptional()
  @IsString()
  policyNo?: string | null;

  @IsOptional()
  @IsUUID("4")
  assetCostProfileId?: string | null;

  @IsEnum(VehicleDepreciationMethod)
  depreciationMethod!: VehicleDepreciationMethod;

  @IsOptional()
  @IsEnum(VehicleDepreciationBasisSource)
  basisSource?: VehicleDepreciationBasisSource;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  depreciationBasisAmount!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  residualValueAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  usefulLifeMonths?: number | null;

  @IsString()
  depreciationStartDate!: string;

  @IsOptional()
  @IsString()
  depreciationEndDate?: string | null;

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateVehicleDepreciationPolicyDto {
  @IsOptional()
  @IsString()
  policyNo?: string;

  @IsOptional()
  @IsUUID("4")
  assetCostProfileId?: string | null;

  @IsOptional()
  @IsEnum(VehicleDepreciationPolicyStatus)
  policyStatus?: VehicleDepreciationPolicyStatus;

  @IsOptional()
  @IsEnum(VehicleDepreciationMethod)
  depreciationMethod?: VehicleDepreciationMethod;

  @IsOptional()
  @IsEnum(VehicleDepreciationBasisSource)
  basisSource?: VehicleDepreciationBasisSource;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  depreciationBasisAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  residualValueAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  usefulLifeMonths?: number | null;

  @IsOptional()
  @IsString()
  depreciationStartDate?: string;

  @IsOptional()
  @IsString()
  depreciationEndDate?: string | null;

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class GenerateVehicleDepreciationSchedulesDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  dryRun?: boolean;
}

export class VehicleDepreciationScheduleActionDto {
  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class VehicleDepreciationRecordsQueryDto {
  @IsOptional()
  @IsUUID("4")
  policyId?: string;

  @IsOptional()
  @IsUUID("4")
  scheduleId?: string;

  @IsOptional()
  @IsUUID("4")
  vehicleId?: string;

  @IsOptional()
  @IsString()
  costPeriod?: string;

  @IsOptional()
  @IsEnum(VehicleDepreciationRecordStatus)
  recordStatus?: VehicleDepreciationRecordStatus;

  @IsOptional()
  @IsEnum(VehicleDepreciationRecordSource)
  recordSource?: VehicleDepreciationRecordSource;

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

export class CreateVehicleDepreciationRecordDto {
  @IsString()
  costPeriod!: string;

  @IsString()
  periodStart!: string;

  @IsString()
  periodEnd!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  depreciationAmount!: number;

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @IsEnum(VehicleDepreciationRecordStatus)
  recordStatus?: VehicleDepreciationRecordStatus;

  @IsOptional()
  @IsEnum(VehicleDepreciationRecordSource)
  recordSource?: VehicleDepreciationRecordSource;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateVehicleDepreciationRecordDto {
  @IsOptional()
  @IsString()
  costPeriod?: string;

  @IsOptional()
  @IsString()
  periodStart?: string;

  @IsOptional()
  @IsString()
  periodEnd?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  depreciationAmount?: number;

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @IsEnum(VehicleDepreciationRecordStatus)
  recordStatus?: VehicleDepreciationRecordStatus;

  @IsOptional()
  @IsEnum(VehicleDepreciationRecordSource)
  recordSource?: VehicleDepreciationRecordSource;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class VehicleDepreciationRecordActionDto {
  @IsOptional()
  @IsString()
  remark?: string | null;
}
