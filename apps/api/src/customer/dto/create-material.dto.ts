import { ApplicationMaterialType, MaterialStatus } from "@prisma/client";
import { IsEnum, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateMaterialDto {
  @IsEnum(ApplicationMaterialType)
  materialType!: ApplicationMaterialType;

  @IsOptional()
  @IsString()
  reviewRemark?: string;
}

export class ReviewMaterialDto {
  @IsEnum(MaterialStatus)
  status!: MaterialStatus;

  @IsOptional()
  @IsString()
  comment?: string;
}

export class DeleteMaterialFileDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
