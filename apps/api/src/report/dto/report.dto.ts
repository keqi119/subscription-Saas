import {
  BillStatus,
  BillType,
  CollectionCaseStatus,
  CollectionLevel,
  DepositTransactionStatus,
  DepositTransactionType,
  EntitlementGrantStatus,
  EntitlementType,
  EntitlementUnit,
  EntitlementUsageSource,
  EntitlementUsageStatus,
  OrderSource,
  OrderStatus,
  VehicleModel,
  VehicleStatus
} from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min
} from "class-validator";

export class ReportDateRangeQueryDto {
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class OrderReportQueryDto extends ReportDateRangeQueryDto {
  @IsOptional()
  @IsEnum(OrderSource)
  orderSource?: OrderSource;

  @IsOptional()
  @IsEnum(OrderStatus)
  orderStatus?: OrderStatus;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel;
}

export class ReportDetailQueryDto extends ReportDateRangeQueryDto {
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

export class OrderDetailQueryDto extends ReportDetailQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  orderStatus?: OrderStatus;

  @IsOptional()
  @IsEnum(OrderSource)
  orderSource?: OrderSource;

  @IsOptional()
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel;

  @IsOptional()
  @IsUUID()
  subscriptionPlanId?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;
}

export class BillDetailQueryDto extends ReportDetailQueryDto {
  @IsOptional()
  @IsEnum(BillType)
  billType?: BillType;

  @IsOptional()
  @IsEnum(BillStatus)
  billStatus?: BillStatus;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsString()
  customerName?: string;
}

export class DepositLedgerDetailQueryDto extends ReportDetailQueryDto {
  @IsOptional()
  @IsEnum(DepositTransactionType)
  transactionType?: DepositTransactionType;

  @IsOptional()
  @IsEnum(DepositTransactionStatus)
  transactionStatus?: DepositTransactionStatus;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsString()
  customerName?: string;
}

export class OverdueBillDetailQueryDto extends ReportDetailQueryDto {
  @IsOptional()
  @IsEnum(CollectionLevel)
  collectionLevel?: CollectionLevel;

  @IsOptional()
  @IsEnum(BillType)
  billType?: BillType;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minOverdueDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxOverdueDays?: number;
}

export class CollectionCaseDetailQueryDto extends ReportDetailQueryDto {
  @IsOptional()
  @IsEnum(CollectionCaseStatus)
  caseStatus?: CollectionCaseStatus;

  @IsOptional()
  @IsEnum(CollectionLevel)
  collectionLevel?: CollectionLevel;

  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsString()
  orderNo?: string;
}

export class VehicleDetailQueryDto extends ReportDetailQueryDto {
  @IsOptional()
  @IsEnum(VehicleStatus)
  vehicleStatus?: VehicleStatus;

  @IsOptional()
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  series?: string;
}

export const assetProfitabilitySortFields = [
  "rentalPaidAmount",
  "utilizationRate",
  "simpleReturnRate",
  "currentSalePriceAmount",
  "purchasePriceAmount",
  "leasedDays"
] as const;

export const assetReturnTrialSortFields = [
  "trialRoa",
  "annualizedTrialRoa",
  "trialNetOperatingIncomeAmount",
  "operatingRevenueAmount",
  "operatingCostAmount",
  "rentalPaidAmount"
] as const;

export const sortOrders = ["asc", "desc"] as const;

export class AssetProfitabilityQueryDto extends ReportDateRangeQueryDto {
  @IsOptional()
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel;

  @IsOptional()
  @IsEnum(VehicleStatus)
  vehicleStatus?: VehicleStatus;
}

export class AssetProfitabilityVehicleListQueryDto extends AssetProfitabilityQueryDto {
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
  @IsIn(assetProfitabilitySortFields)
  sortBy?: (typeof assetProfitabilitySortFields)[number];

  @IsOptional()
  @IsIn(sortOrders)
  sortOrder?: (typeof sortOrders)[number];
}

export class AssetProfitabilityVehicleDetailQueryDto extends ReportDateRangeQueryDto {}

export class AssetReturnTrialQueryDto extends AssetProfitabilityQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(120)
  residualHorizonMonth?: number;
}

export class AssetReturnTrialVehicleListQueryDto extends AssetReturnTrialQueryDto {
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
  @IsIn(assetReturnTrialSortFields)
  sortBy?: (typeof assetReturnTrialSortFields)[number];

  @IsOptional()
  @IsIn(sortOrders)
  sortOrder?: (typeof sortOrders)[number];
}

export class AssetReturnTrialVehicleDetailQueryDto extends AssetReturnTrialQueryDto {}

export class EntitlementReportQueryDto extends ReportDateRangeQueryDto {
  @IsOptional()
  @IsEnum(EntitlementType)
  entitlementType?: EntitlementType;

  @IsOptional()
  @IsEnum(EntitlementUnit)
  unit?: EntitlementUnit;

  @IsOptional()
  @IsEnum(EntitlementGrantStatus)
  grantStatus?: EntitlementGrantStatus;

  @IsOptional()
  @IsEnum(OrderStatus)
  orderStatus?: OrderStatus;
}

export class EntitlementGrantDetailQueryDto extends ReportDetailQueryDto {
  @IsOptional()
  @IsEnum(EntitlementType)
  entitlementType?: EntitlementType;

  @IsOptional()
  @IsEnum(EntitlementUnit)
  unit?: EntitlementUnit;

  @IsOptional()
  @IsEnum(EntitlementGrantStatus)
  status?: EntitlementGrantStatus;

  @IsOptional()
  @IsString()
  orderNo?: string;

  @IsOptional()
  @IsString()
  customerName?: string;
}

export class EntitlementUsageDetailQueryDto extends ReportDetailQueryDto {
  @IsOptional()
  @IsEnum(EntitlementType)
  entitlementType?: EntitlementType;

  @IsOptional()
  @IsEnum(EntitlementUnit)
  unit?: EntitlementUnit;

  @IsOptional()
  @IsEnum(EntitlementUsageSource)
  usageSource?: EntitlementUsageSource;

  @IsOptional()
  @IsEnum(EntitlementUsageStatus)
  usageStatus?: EntitlementUsageStatus;

  @IsOptional()
  @IsString()
  orderNo?: string;

  @IsOptional()
  @IsString()
  customerName?: string;
}
