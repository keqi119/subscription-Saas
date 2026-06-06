import { PaymentMethod } from "@prisma/client";
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
