import { Type } from "class-transformer";
import {
  FinancingCollateralType,
  FinancingInstrumentStatus,
  FinancingInstrumentType,
  FinancingRepaymentMethod
} from "@prisma/client";
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";

export class FinancingInstrumentsQueryDto {
  @IsOptional()
  @IsEnum(FinancingInstrumentType)
  instrumentType?: FinancingInstrumentType;

  @IsOptional()
  @IsEnum(FinancingInstrumentStatus)
  instrumentStatus?: FinancingInstrumentStatus;

  @IsOptional()
  @IsString()
  lenderName?: string;

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

export class CreateFinancingInstrumentDto {
  @IsEnum(FinancingInstrumentType)
  instrumentType!: FinancingInstrumentType;

  @IsOptional()
  @IsString()
  lenderName?: string | null;

  @IsOptional()
  @IsString()
  contractNo?: string | null;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  principalAmount!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  annualRateBps?: number | null;

  @IsString()
  startDate!: string;

  @IsOptional()
  @IsString()
  maturityDate?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  termMonths?: number | null;

  @IsOptional()
  @IsEnum(FinancingRepaymentMethod)
  repaymentMethod?: FinancingRepaymentMethod | null;

  @IsOptional()
  @IsEnum(FinancingCollateralType)
  collateralType?: FinancingCollateralType | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateFinancingInstrumentDto {
  @IsOptional()
  @IsEnum(FinancingInstrumentType)
  instrumentType?: FinancingInstrumentType;

  @IsOptional()
  @IsEnum(FinancingInstrumentStatus)
  instrumentStatus?: FinancingInstrumentStatus;

  @IsOptional()
  @IsString()
  lenderName?: string | null;

  @IsOptional()
  @IsString()
  contractNo?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  principalAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  annualRateBps?: number | null;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  maturityDate?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  termMonths?: number | null;

  @IsOptional()
  @IsEnum(FinancingRepaymentMethod)
  repaymentMethod?: FinancingRepaymentMethod | null;

  @IsOptional()
  @IsEnum(FinancingCollateralType)
  collateralType?: FinancingCollateralType | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class SettleFinancingInstrumentDto {
  @IsString()
  settledAt!: string;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class AllocateFinancingInstrumentVehicleDto {
  @IsString()
  @IsUUID("4", { message: "vehicleId 必须是系统车辆 ID，请在车辆下拉中选择车辆" })
  vehicleId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  allocatedPrincipalAmount!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  allocationRatioBps?: number | null;

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class ReleaseFinancingAllocationDto {
  @IsString()
  releasedAt!: string;

  @IsOptional()
  @IsString()
  remark?: string | null;
}
