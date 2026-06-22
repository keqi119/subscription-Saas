import {
  CustomerProfileMaterialStatus,
  CustomerProfileMaterialType
} from "@prisma/client";
import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";

export class UploadPortalProfileMaterialDto {
  @IsEnum(CustomerProfileMaterialType)
  materialType!: CustomerProfileMaterialType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

export class UpdatePortalProfileMaterialDto {
  @IsOptional()
  @IsEnum(CustomerProfileMaterialStatus)
  materialStatus?: CustomerProfileMaterialStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}
