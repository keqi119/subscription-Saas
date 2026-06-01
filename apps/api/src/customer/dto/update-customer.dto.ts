import { Type } from "class-transformer";
import { CustomerGrade, CustomerStatus, CustomerType } from "@prisma/client";
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from "class-validator";

import { CustomerIdentityDto, CustomerProfileDto } from "./create-customer.dto";

export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  mobile?: string;

  @IsEnum(CustomerType)
  @IsOptional()
  customerType?: CustomerType;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sourceChannel?: string;

  @IsEnum(CustomerGrade)
  @IsOptional()
  grade?: CustomerGrade;

  @IsEnum(CustomerStatus)
  @IsOptional()
  status?: CustomerStatus;

  @IsUUID()
  @IsOptional()
  ownerUserId?: string;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerIdentityDto)
  identity?: CustomerIdentityDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerProfileDto)
  profile?: CustomerProfileDto;
}
