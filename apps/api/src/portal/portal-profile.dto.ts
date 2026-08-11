import { IsOptional, IsString, MaxLength } from "class-validator";

export class UpdatePortalProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  idCardNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  residenceProvince?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  residenceCity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  residenceDistrict?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  residenceDetail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  emergencyContactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  emergencyContactMobile?: string;
}
