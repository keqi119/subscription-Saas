import { IsOptional, IsString, MaxLength } from "class-validator";

export class UpdatePortalProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  mobile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  idCardNo?: string;
}
