import { Transform, Type } from "class-transformer";
import {
  InsuranceClaimStatus,
  VehicleDocumentStatus,
  VehicleDocumentType,
  VehicleInsuranceCoverageType,
  VehicleInsurancePolicyStatus,
  VehicleInsurancePolicyType
} from "@prisma/client";
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested
} from "class-validator";

export class VehicleInsurancePoliciesQueryDto {
  @IsOptional()
  @IsUUID("4")
  vehicleId?: string;

  @IsOptional()
  @IsEnum(VehicleInsurancePolicyType)
  policyType?: VehicleInsurancePolicyType;

  @IsOptional()
  @IsEnum(VehicleInsurancePolicyStatus)
  policyStatus?: VehicleInsurancePolicyStatus;

  @IsOptional()
  @IsString()
  effectiveToFrom?: string;

  @IsOptional()
  @IsString()
  effectiveToTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  expiringWithinDays?: number;

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

export class VehicleInsuranceCoverageInputDto {
  @IsEnum(VehicleInsuranceCoverageType)
  coverageType!: VehicleInsuranceCoverageType;

  @IsOptional()
  @IsString()
  coverageName?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  insuredAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deductibleAmount?: number | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class CreateVehicleInsurancePolicyDto {
  @IsString()
  policyNo!: string;

  @IsEnum(VehicleInsurancePolicyType)
  policyType!: VehicleInsurancePolicyType;

  @IsOptional()
  @IsEnum(VehicleInsurancePolicyStatus)
  policyStatus?: VehicleInsurancePolicyStatus;

  @IsOptional()
  @IsString()
  insurerName?: string | null;

  @IsOptional()
  @IsString()
  policyHolderName?: string | null;

  @IsOptional()
  @IsString()
  insuredName?: string | null;

  @IsString()
  effectiveFrom!: string;

  @IsString()
  effectiveTo!: string;

  @IsOptional()
  @IsString()
  renewalReminderAt?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  premiumAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  insuredAmount?: number | null;

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VehicleInsuranceCoverageInputDto)
  coverages?: VehicleInsuranceCoverageInputDto[];
}

export class UpdateVehicleInsurancePolicyDto {
  @IsOptional()
  @IsString()
  policyNo?: string;

  @IsOptional()
  @IsEnum(VehicleInsurancePolicyType)
  policyType?: VehicleInsurancePolicyType;

  @IsOptional()
  @IsEnum(VehicleInsurancePolicyStatus)
  policyStatus?: VehicleInsurancePolicyStatus;

  @IsOptional()
  @IsString()
  insurerName?: string | null;

  @IsOptional()
  @IsString()
  policyHolderName?: string | null;

  @IsOptional()
  @IsString()
  insuredName?: string | null;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string;

  @IsOptional()
  @IsString()
  renewalReminderAt?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  premiumAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  insuredAmount?: number | null;

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VehicleInsuranceCoverageInputDto)
  coverages?: VehicleInsuranceCoverageInputDto[];
}

export class DeleteVehicleInsurancePolicyDto {
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim() : value
  )
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason!: string;
}

export class PutVehicleInsuranceCoveragesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VehicleInsuranceCoverageInputDto)
  coverages!: VehicleInsuranceCoverageInputDto[];
}

export class UploadVehicleDocumentDto {
  @IsEnum(VehicleDocumentType)
  documentType!: VehicleDocumentType;

  @IsOptional()
  @IsUUID("4")
  policyId?: string | null;

  @IsOptional()
  @IsString()
  title?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsString()
  effectiveFrom?: string | null;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @Transform(booleanField)
  @IsBoolean()
  customerVisible?: boolean;
}

export class UploadVehicleDocumentBatchDto extends UploadVehicleDocumentDto {}

export class UpdateVehicleDocumentDto {
  @IsOptional()
  @IsEnum(VehicleDocumentType)
  documentType?: VehicleDocumentType;

  @IsOptional()
  @IsEnum(VehicleDocumentStatus)
  documentStatus?: VehicleDocumentStatus;

  @IsOptional()
  @IsUUID("4")
  policyId?: string | null;

  @IsOptional()
  @IsString()
  title?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsString()
  effectiveFrom?: string | null;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @Transform(booleanField)
  @IsBoolean()
  customerVisible?: boolean;
}

export class InsuranceClaimsQueryDto {
  @IsOptional()
  @IsUUID("4")
  serviceCaseId?: string;

  @IsOptional()
  @IsUUID("4")
  vehicleId?: string;

  @IsOptional()
  @IsUUID("4")
  orderId?: string;

  @IsOptional()
  @IsUUID("4")
  customerId?: string;

  @IsOptional()
  @IsEnum(InsuranceClaimStatus)
  claimStatus?: InsuranceClaimStatus;

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

export class CreateInsuranceClaimDto {
  @IsOptional()
  @IsUUID("4")
  policyId?: string | null;

  @IsOptional()
  @IsString()
  claimNo?: string | null;

  @IsOptional()
  @IsEnum(InsuranceClaimStatus)
  claimStatus?: InsuranceClaimStatus;

  @IsOptional()
  @IsString()
  insurerClaimNo?: string | null;

  @IsOptional()
  @IsString()
  accidentAt?: string | null;

  @IsOptional()
  @IsString()
  submittedAt?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  estimatedAmount?: number | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateInsuranceClaimDto {
  @IsOptional()
  @IsUUID("4")
  policyId?: string | null;

  @IsOptional()
  @IsEnum(InsuranceClaimStatus)
  claimStatus?: InsuranceClaimStatus;

  @IsOptional()
  @IsString()
  insurerClaimNo?: string | null;

  @IsOptional()
  @IsString()
  accidentAt?: string | null;

  @IsOptional()
  @IsString()
  submittedAt?: string | null;

  @IsOptional()
  @IsString()
  acceptedAt?: string | null;

  @IsOptional()
  @IsString()
  closedAt?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  estimatedAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  approvedAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  paidAmount?: number | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateInsuranceClaimStatusDto {
  @IsEnum(InsuranceClaimStatus)
  claimStatus!: InsuranceClaimStatus;

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
