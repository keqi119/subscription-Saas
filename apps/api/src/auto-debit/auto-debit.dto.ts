import {
  DebitAttemptStatus,
  PaymentMandateStatus
} from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min
} from "class-validator";

export class CreatePortalMandateDto {
  @IsUUID()
  orderId!: string;
}

export class PortalMandateQueryDto {
  @IsOptional()
  @IsUUID()
  orderId?: string;
}

export class PortalDebitAttemptQueryDto {
  @IsOptional()
  @IsUUID()
  billId?: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;
}

export class AdminMandateQueryDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsString()
  orderNo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsEnum(PaymentMandateStatus)
  status?: PaymentMandateStatus;
}

export class AdminDebitAttemptQueryDto {
  @IsOptional()
  @IsUUID()
  billId?: string;

  @IsOptional()
  @IsUUID()
  mandateId?: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsEnum(DebitAttemptStatus)
  status?: DebitAttemptStatus;
}

export class AutoDebitActionReasonDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(255)
  reason!: string;
}

export class SetMockDebitResultDto extends AutoDebitActionReasonDto {
  @IsIn(["SUCCEEDED", "FAILED_RETRYABLE", "FAILED_FINAL", "UNKNOWN"])
  nextResult!:
    | "SUCCEEDED"
    | "FAILED_RETRYABLE"
    | "FAILED_FINAL"
    | "UNKNOWN";
}
