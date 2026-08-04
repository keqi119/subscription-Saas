import {
  DebitAttemptStatus,
  PaymentMandateStatus
} from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
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
