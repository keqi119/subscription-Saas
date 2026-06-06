import {
  BillType,
  CollectionActionResult,
  CollectionActionType,
  CollectionCaseStatus,
  CollectionLevel,
  ContactMethod,
  PaymentMethod
} from "@prisma/client";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Min, ValidateNested } from "class-validator";

export class GenerateMonthlyRentBillsDto {
  @IsDateString()
  billingDate!: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class CreatePaymentDto {
  @IsUUID()
  orderId!: string;

  @IsUUID()
  customerId!: string;

  @IsInt()
  @Min(1)
  paymentAmount!: number;

  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @IsDateString()
  receivedAt!: string;

  @IsOptional()
  @IsString()
  payerName?: string;

  @IsOptional()
  @IsString()
  payerAccount?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  paymentProofUrls?: string[];

  @IsOptional()
  @IsString()
  remark?: string;
}

export class WriteOffPaymentItemDto {
  @IsUUID()
  billId!: string;

  @IsInt()
  @Min(1)
  writeOffAmount!: number;
}

export class WriteOffPaymentDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WriteOffPaymentItemDto)
  items!: WriteOffPaymentItemDto[];

  @IsOptional()
  @IsString()
  remark?: string;
}

export class RefreshOverdueBillsDto {
  @IsDateString()
  asOfDate!: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class OverdueBillsQueryDto {
  @IsOptional()
  @IsString()
  orderNo?: string;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsEnum(BillType)
  billType?: BillType;

  @IsOptional()
  @IsEnum(CollectionLevel)
  collectionLevel?: CollectionLevel;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minOverdueDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxOverdueDays?: number;
}

export class CollectionCasesQueryDto {
  @IsOptional()
  @IsEnum(CollectionCaseStatus)
  caseStatus?: CollectionCaseStatus;

  @IsOptional()
  @IsEnum(CollectionLevel)
  collectionLevel?: CollectionLevel;

  @IsOptional()
  @IsString()
  assignedTo?: string;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsString()
  orderNo?: string;
}

export class CreateCollectionActionDto {
  @IsEnum(CollectionActionType)
  actionType!: CollectionActionType;

  @IsEnum(ContactMethod)
  contactMethod!: ContactMethod;

  @IsEnum(CollectionActionResult)
  actionResult!: CollectionActionResult;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsDateString()
  promisedPayAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  promisedAmount?: number;

  @IsOptional()
  @IsDateString()
  nextFollowUpAt?: string;
}

export class CloseCollectionCaseDto {
  @IsString()
  closeReason!: string;
}
