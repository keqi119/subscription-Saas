import { CustomerGrade } from "@prisma/client";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Min } from "class-validator";

export class SubmitApplicationDto {
  @IsOptional()
  @IsString()
  comment?: string;
}

export class NeedMoreInfoDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  comment?: string;
}

export class ApproveApplicationDto {
  @IsEnum(CustomerGrade)
  grade!: CustomerGrade;

  @IsInt()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  riskScore?: number;

  @IsInt()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  maxVehiclePurchasePriceAmount?: number;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @IsString()
  comment?: string;
}

export class RejectApplicationDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  comment?: string;
}
