import { CustomerGrade, OrderReviewStatus } from "@prisma/client";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from "class-validator";

export class SubmitApplicationDto {
  @IsOptional()
  @IsString()
  comment?: string;
}

export class NeedMoreInfoDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  comment?: string;
}

export class ApproveApplicationDto {
  @IsEnum(CustomerGrade)
  grade!: CustomerGrade;

  @IsInt()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  riskScore?: number;

  @IsInt()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  maxVehiclePurchasePriceAmount?: number;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @IsString()
  comment?: string;
}

export class RejectApplicationDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  comment?: string;
}

export class ReviewApplicationDto {
  @IsOptional()
  @IsEnum(OrderReviewStatus)
  action?: OrderReviewStatus;

  @IsOptional()
  @IsEnum(OrderReviewStatus)
  status?: OrderReviewStatus;

  @IsOptional()
  @IsEnum(CustomerGrade)
  customerGrade?: CustomerGrade;

  @IsOptional()
  @IsUUID()
  finalSubscriptionPlanId?: string;

  @IsOptional()
  @IsUUID()
  finalVehicleId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  finalPeriodMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  finalVehicleBaseFeeAmount?: number;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @IsString()
  comment?: string;
}
