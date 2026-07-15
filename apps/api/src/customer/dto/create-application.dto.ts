import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from "class-validator";

export class ApplicationCustomerIdentityDto {
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

export class CreateApplicationDto {
  @IsUUID()
  customerId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ApplicationCustomerIdentityDto)
  customerIdentity?: ApplicationCustomerIdentityDto;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  intendedModel?: string;

  @IsInt()
  @IsOptional()
  @Max(60)
  @Min(1)
  intendedPeriodMonths?: number;
}
