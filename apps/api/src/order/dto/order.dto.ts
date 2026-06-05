import {
  BusinessType,
  ContractTemplateType,
  ContractVersionStatus,
  CustomerGrade,
  OrderChangeType,
  OrderReviewStatus
} from "@prisma/client";
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from "class-validator";

export class CreateOrderFromQuoteDto {
  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType;
}

export class CreateCustomerOrderDto {
  @IsUUID()
  customerId!: string;

  @IsUUID()
  vehicleId!: string;

  @IsUUID()
  subscriptionPlanId!: string;

  @IsInt()
  @Min(1)
  periodMonths!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  vehicleBaseFeeAmount?: number;
}

export class ReviewOrderDto {
  @IsEnum(OrderReviewStatus)
  status!: OrderReviewStatus;

  @IsOptional()
  @IsEnum(CustomerGrade)
  customerGrade?: CustomerGrade;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class CancelOrderDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class CreateContractVersionDto {
  @IsString()
  templateName!: string;

  @IsString()
  versionNo!: string;

  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType;

  @IsOptional()
  @IsEnum(ContractTemplateType)
  templateType?: ContractTemplateType;

  @IsString()
  contentTemplate!: string;

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsEnum(ContractVersionStatus)
  status?: ContractVersionStatus;
}

export class UpdateContractVersionDto {
  @IsOptional()
  @IsString()
  templateName?: string;

  @IsOptional()
  @IsString()
  versionNo?: string;

  @IsOptional()
  @IsString()
  contentTemplate?: string;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;
}

export class ArchiveContractDto {
  @IsOptional()
  @IsUUID()
  fileId?: string;
}

export class CreateOrderChangeDto {
  @IsEnum(OrderChangeType)
  changeType!: OrderChangeType;

  @IsOptional()
  @IsUUID()
  subscriptionPlanId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  periodMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  vehicleBaseFeeAmount?: number;

  @IsString()
  reason!: string;

  @IsOptional()
  beforeSnapshot?: unknown;

  @IsOptional()
  afterSnapshot?: unknown;
}
