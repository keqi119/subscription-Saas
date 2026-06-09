import { Type } from "class-transformer";
import {
  RevenueRightAssigneeType,
  RevenueRightAssignmentStatus,
  RevenueRightAssignmentType,
  RevenueRightTargetType,
  RevenueShareBasis,
  RevenueShareRuleType,
  RevenueShareSettlementCycle
} from "@prisma/client";
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class RevenueRightAssignmentsQueryDto {
  @IsOptional()
  @IsEnum(RevenueRightAssignmentType)
  assignmentType?: RevenueRightAssignmentType;

  @IsOptional()
  @IsEnum(RevenueRightAssignmentStatus)
  assignmentStatus?: RevenueRightAssignmentStatus;

  @IsOptional()
  @IsEnum(RevenueRightTargetType)
  targetType?: RevenueRightTargetType;

  @IsOptional()
  @IsString()
  vehicleId?: string;

  @IsOptional()
  @IsString()
  orderId?: string;

  @IsOptional()
  @IsString()
  billId?: string;

  @IsOptional()
  @IsString()
  financingInstrumentId?: string;

  @IsOptional()
  @IsEnum(RevenueRightAssigneeType)
  assigneeType?: RevenueRightAssigneeType;

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

export class CreateRevenueRightAssignmentDto {
  @IsEnum(RevenueRightAssignmentType)
  assignmentType!: RevenueRightAssignmentType;

  @IsEnum(RevenueRightTargetType)
  targetType!: RevenueRightTargetType;

  @IsOptional()
  @IsString()
  vehicleId?: string | null;

  @IsOptional()
  @IsString()
  orderId?: string | null;

  @IsOptional()
  @IsString()
  billId?: string | null;

  @IsOptional()
  @IsString()
  financingInstrumentId?: string | null;

  @IsEnum(RevenueRightAssigneeType)
  assigneeType!: RevenueRightAssigneeType;

  @IsOptional()
  @IsString()
  assigneeName?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priority?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  shareRatioBps?: number | null;

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class ReleaseRevenueRightAssignmentDto {
  @IsString()
  releasedAt!: string;

  @IsOptional()
  @IsString()
  releaseReason?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class CreateRevenueShareRuleDto {
  @IsEnum(RevenueShareRuleType)
  ruleType!: RevenueShareRuleType;

  @IsEnum(RevenueShareBasis)
  shareBasis!: RevenueShareBasis;

  @IsOptional()
  @IsString()
  ownerName?: string | null;

  @IsOptional()
  @IsString()
  ownerContact?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  ownerShareBps?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  platformShareBps?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fixedMonthlyAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minimumGuaranteeAmount?: number | null;

  @IsOptional()
  @IsEnum(RevenueShareSettlementCycle)
  settlementCycle?: RevenueShareSettlementCycle;

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class DeactivateRevenueShareRuleDto {
  @IsString()
  effectiveTo!: string;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class RevenueSharePreviewQueryDto {
  @IsString()
  startDate!: string;

  @IsString()
  endDate!: string;
}
