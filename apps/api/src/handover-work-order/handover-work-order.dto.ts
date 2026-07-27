import { DeliveryEvidenceMediaType } from "@prisma/client";
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  Min
} from "class-validator";

import type { HandoverFieldFactKey } from "./handover-work-order.service";

const HANDOVER_FIELD_FACT_KEYS: HandoverFieldFactKey[] = [
  "accessoryChecklist",
  "damageDeclared",
  "deliveryLocation",
  "energyLevelText",
  "fieldNotes",
  "fuelLevelText",
  "handoverMileageKm",
  "noVisibleDamageDeclared",
  "scheduledAt"
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

export class UpdateHandoverFieldFactsDto {
  @IsOptional()
  @IsObject()
  accessoryChecklist?: Record<string, unknown>;

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
  @IsBoolean()
  noVisibleDamageDeclared?: boolean;

  @IsOptional()
  @IsString()
  scheduledAt?: string;
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
