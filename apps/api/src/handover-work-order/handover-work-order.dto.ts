import {
  BusinessExceptionDecision,
  DeliveryEvidenceMediaType,
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateNested
} from "class-validator";

import type { HandoverFieldFactKey } from "./handover-work-order.service";

const HANDOVER_FIELD_FACT_KEYS: HandoverFieldFactKey[] = [
  "accessoryItems",
  "damageDeclared",
  "deliveryLocation",
  "energyLevelText",
  "fieldNotes",
  "fuelLevelText",
  "handoverMileageKm",
  "keyState",
  "noVisibleDamageDeclared",
  "primaryKeyCount",
  "registrationDocumentRemarks",
  "registrationDocumentState",
  "scheduledAt",
  "spareKeyCount",
  "vehicleConditionConfirmed",
  "vehicleConditionRemarks"
];

export class CreateHandoverWorkOrderDto {
  @IsOptional()
  @IsIn(["DELIVERY_OUTBOUND", "RETURN_INBOUND"])
  handoverType?: "DELIVERY_OUTBOUND" | "RETURN_INBOUND";
}

export class AssignInternalOperatorDto {
  @IsUUID()
  userId!: string;
}

export class AssignExternalOperatorDto {
  @IsOptional()
  @IsString()
  expiresAt?: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  organization?: string;

  @IsString()
  phone!: string;
}

export class HandoverAccessoryItemDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  code!: string;

  @IsString()
  @MaxLength(128)
  name!: string;

  @IsInt()
  @Min(0)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  @IsIn(["PRESENT", "MISSING", "DAMAGED"])
  state!: "PRESENT" | "MISSING" | "DAMAGED";
}

export class UpdateHandoverFieldFactsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => HandoverAccessoryItemDto)
  accessoryItems?: HandoverAccessoryItemDto[];

  @IsOptional()
  @IsBoolean()
  damageDeclared?: boolean;

  @IsOptional()
  @IsString()
  deliveryLocation?: string;

  @IsOptional()
  @IsString()
  energyLevelText?: string;

  @IsOptional()
  @IsString()
  fieldNotes?: string;

  @IsOptional()
  @IsString()
  fuelLevelText?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  handoverMileageKm?: number;

  @IsOptional()
  @IsIn(["COMPLETE", "PARTIAL", "MISSING", "DAMAGED"])
  keyState?: "COMPLETE" | "PARTIAL" | "MISSING" | "DAMAGED";

  @IsOptional()
  @IsBoolean()
  noVisibleDamageDeclared?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  primaryKeyCount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  registrationDocumentRemarks?: string;

  @IsOptional()
  @IsIn(["HANDED_OVER", "NOT_AVAILABLE", "DAMAGED"])
  registrationDocumentState?: "HANDED_OVER" | "NOT_AVAILABLE" | "DAMAGED";

  @IsOptional()
  @IsString()
  scheduledAt?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  spareKeyCount?: number;

  @IsOptional()
  @IsBoolean()
  vehicleConditionConfirmed?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  vehicleConditionRemarks?: string;
}

export class AttachFieldEvidenceFileDto {
  @IsUUID()
  fileId!: string;

  @IsEnum(DeliveryEvidenceMediaType)
  mediaType!: DeliveryEvidenceMediaType;
}

export class UploadFieldEvidenceDto {
  @IsOptional()
  @IsUUID()
  replaceEvidenceFileId?: string;
}

export class VoidHandoverWorkOrderDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsIn(["VOIDED", "FAILED", "CANCELLED"])
  status?: "VOIDED" | "FAILED" | "CANCELLED";
}

export class VoidStage2HandoverESignDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class Stage2WorkflowRecoveryJobDto {
  id!: string;
  jobStatus!: VehicleHandoverWorkflowJobStatus;
  jobType!: VehicleHandoverWorkflowJobType;
}

export class Stage2WorkflowRecoveryResultDto {
  created!: boolean;
  job!: Stage2WorkflowRecoveryJobDto;
}

export class StartFieldStage2ESignDto {
  @Equals(true)
  acknowledgement!: true;

  @IsInt()
  @Min(1)
  artifactVersion!: number;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  sourcePdfHash!: string;
}

export class StartAdminStage2ESignDto extends StartFieldStage2ESignDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value
  )
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class RequestStage2RegistrationExceptionDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value
  )
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class DecideStage2RegistrationExceptionDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value
  )
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  comment!: string;

  @IsEnum(BusinessExceptionDecision)
  decision!: BusinessExceptionDecision;

  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class OpsReviewDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

export class HandoverObjectionActionDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class HandoverObjectionResubmissionDto {
  @IsString()
  note!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID("4", { each: true })
  targetEvidenceItemIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(HANDOVER_FIELD_FACT_KEYS.length)
  @IsIn(HANDOVER_FIELD_FACT_KEYS, { each: true })
  targetFieldKeys?: HandoverFieldFactKey[];
}
