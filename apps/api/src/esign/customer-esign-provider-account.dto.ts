import { ESignRealNameStatus } from "@prisma/client";
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from "class-validator";

export class ManualAttachFadadaProviderAccountDto {
  @IsString()
  @MaxLength(128)
  providerCustomerId!: string;

  @IsEnum(ESignRealNameStatus)
  @IsOptional()
  realNameStatus?: ESignRealNameStatus;
}

export class MarkFadadaRealNameStatusDto {
  @IsEnum(ESignRealNameStatus)
  realNameStatus!: ESignRealNameStatus;

  @IsString()
  @IsOptional()
  @MaxLength(128)
  verificationSerialNo?: string;

  @IsString()
  @IsOptional()
  @MaxLength(128)
  verificationTransactionNo?: string;
}

export class StartFadadaRealNameVerificationDto {
  @IsString()
  @MaxLength(64)
  name!: string;

  @IsString()
  @MaxLength(32)
  idCardNo!: string;

  @IsString()
  @MaxLength(32)
  mobile!: string;

  @IsBoolean()
  @IsOptional()
  certFlag?: boolean;

  @IsString()
  @IsOptional()
  @MaxLength(16)
  verifiedWay?: string;

  @IsString()
  @IsOptional()
  @MaxLength(16)
  pageModify?: string;

  @IsString()
  @IsOptional()
  @MaxLength(16)
  option?: string;
}
