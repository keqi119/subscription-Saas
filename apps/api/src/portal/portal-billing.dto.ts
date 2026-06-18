import {
  BillStatus,
  BillType,
  DepositTransactionType,
  EntitlementGrantStatus,
  OrderStatus,
  PaymentOrderStatus
} from "@prisma/client";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";

export class PortalPageQueryDto {
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
}

export class PortalOrdersQueryDto extends PortalPageQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  orderStatus?: OrderStatus;
}

export class PortalBillsQueryDto extends PortalPageQueryDto {
  @IsOptional()
  @IsEnum(BillStatus)
  billStatus?: BillStatus;

  @IsOptional()
  @IsEnum(BillType)
  billType?: BillType;

  @IsOptional()
  @IsUUID()
  orderId?: string;
}

export class PortalPaymentOrdersQueryDto extends PortalPageQueryDto {
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsEnum(PaymentOrderStatus)
  paymentStatus?: PaymentOrderStatus;
}

export class PortalDepositTransactionsQueryDto extends PortalPageQueryDto {
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsEnum(DepositTransactionType)
  transactionType?: DepositTransactionType;
}

export class PortalEntitlementsQueryDto extends PortalPageQueryDto {
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsEnum(EntitlementGrantStatus)
  status?: EntitlementGrantStatus;
}

export class PortalEntitlementUsagesQueryDto extends PortalPageQueryDto {
  @IsOptional()
  @IsUUID()
  grantId?: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;
}
