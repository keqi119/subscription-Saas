import {
  BillingScheduleStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min
} from "class-validator";

export class BillingAutomationPageQueryDto {
  @IsInt()
  @IsOptional()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsInt()
  @IsOptional()
  @Max(100)
  @Min(1)
  @Type(() => Number)
  pageSize?: number;
}

export class BillingScheduleQueryDto extends BillingAutomationPageQueryDto {
  @IsUUID()
  @IsOptional()
  orderId?: string;

  @IsEnum(BillingScheduleStatus)
  @IsOptional()
  status?: BillingScheduleStatus;
}

export class BillingAutomationJobQueryDto extends BillingAutomationPageQueryDto {
  @Transform(({ value }) =>
    value === true || value === "true"
      ? true
      : value === false || value === "false"
        ? false
        : value
  )
  @IsBoolean()
  @IsOptional()
  actionableOnly?: boolean;

  @IsUUID()
  @IsOptional()
  billId?: string;

  @IsEnum(SubscriptionAutomationJobStatus)
  @IsOptional()
  jobStatus?: SubscriptionAutomationJobStatus;

  @IsEnum(SubscriptionAutomationJobType)
  @IsOptional()
  jobType?: SubscriptionAutomationJobType;

  @IsUUID()
  @IsOptional()
  orderId?: string;
}

export class ReconcileBillingSchedulesDto {
  @IsBoolean()
  @IsOptional()
  dryRun?: boolean;
}

export class PauseBillingScheduleDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsNotEmpty()
  @IsString()
  @Matches(/\S/)
  @MaxLength(255)
  reason!: string;
}
