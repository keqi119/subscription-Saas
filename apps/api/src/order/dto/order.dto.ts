import {
  BusinessType,
  ContractTemplateType,
  ContractVersionStatus,
  OrderChangeType
} from "@prisma/client";
import { IsEnum, IsOptional, IsString, IsUUID } from "class-validator";

export class CreateOrderFromQuoteDto {
  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType;
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

  @IsString()
  reason!: string;

  @IsOptional()
  beforeSnapshot?: unknown;

  @IsOptional()
  afterSnapshot?: unknown;
}
