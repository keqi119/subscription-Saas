import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested
} from "class-validator";
import { CustomerGrade, CustomerStatus, CustomerType } from "@prisma/client";

export class CustomerIdentityDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  idCardNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  driverLicenseNo?: string;

  @IsOptional()
  @IsString()
  licenseValidUntil?: string;

  @IsBoolean()
  @IsOptional()
  realnameVerified?: boolean;
}

export class CustomerProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  occupation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  companyName?: string;

  @IsInt()
  @IsOptional()
  @Min(0)
  monthlyIncomeAmount?: number;

  @IsInt()
  @IsOptional()
  @Min(0)
  socialSecurityMonths?: number;

  @IsInt()
  @IsOptional()
  @Min(0)
  housingFundMonths?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  residenceAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  emergencyContactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  emergencyContactMobile?: string;
}

export class CreateCustomerDto {
  @IsString()
  @MaxLength(64)
  name!: string;

  @IsString()
  @MaxLength(32)
  mobile!: string;

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
