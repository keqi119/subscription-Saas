import {
  DeliveryEvidenceMediaType
} from "@prisma/client";
import { IsEnum, IsOptional, IsString, IsUUID } from "class-validator";

export class AttachDeliveryEvidenceFileDto {
  @IsUUID()
  fileId!: string;

  @IsEnum(DeliveryEvidenceMediaType)
  mediaType!: DeliveryEvidenceMediaType;

  @IsOptional()
  @IsString()
  objectKey?: string;
}

export class RejectDeliveryEvidenceDto {
  @IsString()
  reason!: string;
}

export class DeclareNoVisibleDamageDto {
  @IsOptional()
  @IsString()
  remark?: string;
}

export class AddDamageCloseupDto {
  @IsOptional()
  @IsUUID()
  fileId?: string;

  @IsOptional()
  @IsEnum(DeliveryEvidenceMediaType)
  mediaType?: DeliveryEvidenceMediaType;

  @IsOptional()
  @IsString()
  description?: string;
}
