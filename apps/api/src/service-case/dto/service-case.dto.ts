import {
  RescueType,
  ServiceCasePriority,
  ServiceCaseStatus,
  ServiceCaseType
} from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min
} from "class-validator";

export class ServiceCasePageQueryDto {
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

export class CreatePortalServiceCaseDto {
  @IsEnum(ServiceCaseType)
  caseType!: ServiceCaseType;

  @IsUUID()
  orderId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  contactPhone?: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  locationText?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsBoolean()
  accidentHasInjury?: boolean;

  @IsOptional()
  @IsBoolean()
  accidentPoliceReported?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  insuranceReportNo?: string;

  @IsOptional()
  @IsEnum(RescueType)
  rescueType?: RescueType;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  rescueAddress?: string;
}

export class PortalServiceCasesQueryDto extends ServiceCasePageQueryDto {
  @IsOptional()
  @IsEnum(ServiceCaseType)
  caseType?: ServiceCaseType;

  @IsOptional()
  @IsEnum(ServiceCaseStatus)
  caseStatus?: ServiceCaseStatus;
}

export class CancelPortalServiceCaseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class AdminServiceCasesQueryDto extends ServiceCasePageQueryDto {
  @IsOptional()
  @IsEnum(ServiceCaseType)
  caseType?: ServiceCaseType;

  @IsOptional()
  @IsEnum(ServiceCaseStatus)
  caseStatus?: ServiceCaseStatus;

  @IsOptional()
  @IsEnum(ServiceCasePriority)
  priority?: ServiceCasePriority;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsUUID()
  vehicleId?: string;
}

export class AcceptServiceCaseDto {
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

export class UpdateServiceCaseStatusDto {
  @IsEnum(ServiceCaseStatus)
  toStatus!: ServiceCaseStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

export class AddServiceCaseActionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  remark!: string;
}

export class CloseServiceCaseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  closeRemark!: string;
}
