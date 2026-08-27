import { ApplicationMaterialType } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min
} from "class-validator";

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

export class PrecheckPortalSelfServiceApplicationDto {
  @IsUUID()
  vehicleId!: string;

  @IsUUID()
  subscriptionPlanId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  subscriptionPeriodMonths?: number;
}

export class UploadPortalApplicationMaterialDto {
  @IsEnum(ApplicationMaterialType)
  materialType!: ApplicationMaterialType;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class RejectPortalFinalPlanDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ConfirmPortalFinalPlanDto {
  @IsOptional()
  @Matches(/^sha256:[0-9a-f]{64}$/i)
  commercialHash?: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  revision!: number;
}
