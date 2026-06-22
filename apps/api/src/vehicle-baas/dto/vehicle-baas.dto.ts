import { Transform, Type } from "class-transformer";
import {
  VehicleBaasBillingCycle,
  VehicleBaasContractAttachmentType,
  VehicleBaasContractStatus,
  VehicleBaasCostRecordStatus,
  VehicleBaasCostSource
} from "@prisma/client";
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";

export class VehicleBaasContractsQueryDto {
  @IsOptional()
  @IsUUID("4")
  vehicleId?: string;

  @IsOptional()
  @IsEnum(VehicleBaasContractStatus)
  contractStatus?: VehicleBaasContractStatus;

  @IsOptional()
  @IsString()
  providerName?: string;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string;

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

export class CreateVehicleBaasContractDto {
  @IsOptional()
  @IsString()
  contractNo?: string | null;

  @IsString()
  providerName!: string;

  @IsOptional()
  @IsString()
  providerContractNo?: string | null;

  @IsOptional()
  @IsString()
  batteryPackageName?: string | null;

  @IsOptional()
  @IsString()
  batterySerialNo?: string | null;

  @IsOptional()
  @IsEnum(VehicleBaasContractStatus)
  contractStatus?: VehicleBaasContractStatus;

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsEnum(VehicleBaasBillingCycle)
  billingCycle?: VehicleBaasBillingCycle;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  rentalAmount!: number;

  @IsOptional()
  @IsString()
  currency?: string | null;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  paymentDayOfMonth!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  graceDays?: number | null;

  @IsOptional()
  @Transform(booleanField)
  @IsBoolean()
  invoiceRequired?: boolean;

  @IsOptional()
  @Transform(booleanField)
  @IsBoolean()
  taxIncluded?: boolean;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateVehicleBaasContractDto {
  @IsOptional()
  @IsString()
  contractNo?: string;

  @IsOptional()
  @IsString()
  providerName?: string;

  @IsOptional()
  @IsString()
  providerContractNo?: string | null;

  @IsOptional()
  @IsString()
  batteryPackageName?: string | null;

  @IsOptional()
  @IsString()
  batterySerialNo?: string | null;

  @IsOptional()
  @IsEnum(VehicleBaasContractStatus)
  contractStatus?: VehicleBaasContractStatus;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsEnum(VehicleBaasBillingCycle)
  billingCycle?: VehicleBaasBillingCycle;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  rentalAmount?: number;

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  paymentDayOfMonth?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  graceDays?: number | null;

  @IsOptional()
  @Transform(booleanField)
  @IsBoolean()
  invoiceRequired?: boolean;

  @IsOptional()
  @Transform(booleanField)
  @IsBoolean()
  taxIncluded?: boolean;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UploadVehicleBaasContractAttachmentDto {
  @IsOptional()
  @IsEnum(VehicleBaasContractAttachmentType)
  attachmentType?: VehicleBaasContractAttachmentType;

  @IsOptional()
  @IsString()
  title?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;
}

export class GenerateVehicleBaasCostRecordsDto {
  @IsString()
  fromPeriod!: string;

  @IsString()
  toPeriod!: string;

  @IsOptional()
  @Transform(booleanField)
  @IsBoolean()
  dryRun?: boolean;
}

export class VehicleBaasCostRecordsQueryDto {
  @IsOptional()
  @IsUUID("4")
  contractId?: string;

  @IsOptional()
  @IsUUID("4")
  vehicleId?: string;

  @IsOptional()
  @IsString()
  costPeriod?: string;

  @IsOptional()
  @IsEnum(VehicleBaasCostRecordStatus)
  costStatus?: VehicleBaasCostRecordStatus;

  @IsOptional()
  @IsString()
  dueFrom?: string;

  @IsOptional()
  @IsString()
  dueTo?: string;

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

export class CreateVehicleBaasCostRecordDto {
  @IsString()
  costPeriod!: string;

  @IsOptional()
  @IsString()
  periodStart?: string;

  @IsOptional()
  @IsString()
  periodEnd?: string;

  @IsOptional()
  @IsString()
  dueDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  costAmount?: number;

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @IsEnum(VehicleBaasCostRecordStatus)
  costStatus?: VehicleBaasCostRecordStatus;

  @IsOptional()
  @IsEnum(VehicleBaasCostSource)
  costSource?: VehicleBaasCostSource;

  @IsOptional()
  @IsString()
  paymentRefNo?: string | null;

  @IsOptional()
  @IsString()
  invoiceNo?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateVehicleBaasCostRecordDto {
  @IsOptional()
  @IsString()
  dueDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  costAmount?: number;

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @IsEnum(VehicleBaasCostRecordStatus)
  costStatus?: VehicleBaasCostRecordStatus;

  @IsOptional()
  @IsString()
  paymentRefNo?: string | null;

  @IsOptional()
  @IsString()
  invoiceNo?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class VehicleBaasCostRecordActionDto {
  @IsOptional()
  @IsString()
  paymentRefNo?: string | null;

  @IsOptional()
  @IsString()
  invoiceNo?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

function booleanField({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return value === "true" || value === "1";
}
