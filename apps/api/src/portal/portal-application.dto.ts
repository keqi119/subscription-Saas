import { ApplicationMaterialType } from "@prisma/client";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from "class-validator";

export class CreatePortalSelfServiceApplicationDto {
  @IsUUID()
  vehicleId!: string;

  @IsUUID()
  subscriptionPlanId!: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  subscriptionPeriodMonths!: number;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class UploadPortalApplicationMaterialDto {
  @IsEnum(ApplicationMaterialType)
  materialType!: ApplicationMaterialType;

  @IsOptional()
  @IsString()
  remark?: string;
}

