import { ESignRealNameStatus } from "@prisma/client";
import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";

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
