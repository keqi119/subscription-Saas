import { DeliveryEvidenceMediaType } from "@prisma/client";
import { IsBoolean, IsEnum, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Min } from "class-validator";

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

  @IsOptional()
  @IsString()
  phone?: string;
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

export class VoidHandoverWorkOrderDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsIn(["VOIDED", "FAILED", "CANCELLED"])
  status?: "VOIDED" | "FAILED" | "CANCELLED";
}

export class OpsReviewDto {
  @IsOptional()
  @IsString()
  notes?: string;
}
