import { IsEnum } from "class-validator";

export enum CustomerESignOnboardingRetryStep {
  REALNAME_VERIFY = "REALNAME_VERIFY",
  START = "START",
  STATUS_REFRESH = "STATUS_REFRESH"
}

export class RetryCustomerESignOnboardingDto {
  @IsEnum(CustomerESignOnboardingRetryStep)
  step!: CustomerESignOnboardingRetryStep;
}
