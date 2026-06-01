import { Type } from "class-transformer";
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { CustomerGrade, RecordStatus } from "@prisma/client";

export class CreateDepositRuleDto {
  @IsEnum(CustomerGrade)
  grade!: CustomerGrade;

  @IsInt()
  @Min(0)
  @Type(() => Number)
  depositAmount!: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  customerRatio?: number | null;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  defaultRate!: number;

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsEnum(RecordStatus)
  @IsOptional()
  status?: RecordStatus;
}

export class UpdateDepositRuleDto {
  @IsEnum(CustomerGrade)
  @IsOptional()
  grade?: CustomerGrade;

  @IsInt()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  depositAmount?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  customerRatio?: number | null;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  defaultRate?: number;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsEnum(RecordStatus)
  @IsOptional()
  status?: RecordStatus;
}
