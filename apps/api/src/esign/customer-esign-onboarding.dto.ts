import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from "class-validator";

export enum CustomerESignOnboardingRetryStep {
  REALNAME_VERIFY = "REALNAME_VERIFY",
  START = "START",
  STATUS_REFRESH = "STATUS_REFRESH"
}

export class RetryCustomerESignOnboardingDto {
  @IsEnum(CustomerESignOnboardingRetryStep)
  step!: CustomerESignOnboardingRetryStep;
}

export class StartCustomerESignOnboardingRealNameDto {
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
