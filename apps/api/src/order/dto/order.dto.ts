import {
  BusinessType,
  ContractTemplateType,
  ContractVersionStatus,
  CustomerGrade,
  OrderChangeType,
  OrderReviewStatus,
  VehicleDamageLevel,
  VehicleDamageResponsibleParty,
  VehicleDamageType,
  VehicleReturnType
} from "@prisma/client";
import { IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Min, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

export class CreateOrderFromQuoteDto {
  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType;
}

export class CreateCustomerOrderDto {
  @IsUUID()
  customerId!: string;

  @IsUUID()
  vehicleId!: string;

  @IsUUID()
  subscriptionPlanId!: string;

  @IsInt()
  @Min(1)
  periodMonths!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  vehicleBaseFeeAmount?: number;
}

export class ReviewOrderDto {
  @IsOptional()
  @IsEnum(OrderReviewStatus)
  status?: OrderReviewStatus;

  @IsOptional()
  @IsEnum(OrderReviewStatus)
  action?: OrderReviewStatus;

  @IsOptional()
  @IsEnum(CustomerGrade)
  customerGrade?: CustomerGrade;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @IsString()
  comment?: string;
}

export class CancelOrderDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class PrepareDeliveryDto {
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  deliveryLocation?: string;

  @IsOptional()
  @IsBoolean()
  depositReceivedConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  firstMonthlyFeeReceivedConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  insuranceValidConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  vehiclePreparedConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  vehiclePhotosConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  customerIdentityConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  handoverDocumentsConfirmed?: boolean;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class ConfirmDeliveryDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  handoverMileageKm?: number;

  @IsOptional()
  @IsDateString()
  deliveredAt?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class PrepareReturnDto {
  @IsOptional()
  @IsEnum(VehicleReturnType)
  returnType?: VehicleReturnType;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  returnLocation?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class ConfirmReturnDamageDto {
  @IsEnum(VehicleDamageType)
  damageType!: VehicleDamageType;

  @IsEnum(VehicleDamageLevel)
  damageLevel!: VehicleDamageLevel;

  @IsString()
  description!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedRepairAmount?: number;

  @IsOptional()
  @IsEnum(VehicleDamageResponsibleParty)
  responsibleParty?: VehicleDamageResponsibleParty;

  @IsOptional()
  @IsArray()
  photoUrls?: string[];
}

export class ConfirmReturnDto {
  @IsOptional()
  @IsEnum(VehicleReturnType)
  returnType?: VehicleReturnType;

  @IsOptional()
  @IsDateString()
  returnedAt?: string;

  @IsInt()
  @Min(0)
  returnMileageKm!: number;

  @IsOptional()
  @IsBoolean()
  keysReturnedConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  chargingEquipmentReturnedConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  vehicleDocumentsReturnedConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  customerItemsClearedConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  exteriorCheckedConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  interiorCheckedConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  batteryCheckedConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  mileageConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  violationCheckedConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  cleaningRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  maintenanceRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  damageFound?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConfirmReturnDamageDto)
  damages?: ConfirmReturnDamageDto[];

  @IsOptional()
  @IsString()
  remark?: string;
}

export class CreateContractVersionDto {
  @IsString()
  templateName!: string;

  @IsString()
  versionNo!: string;

  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType;

  @IsOptional()
  @IsEnum(ContractTemplateType)
  templateType?: ContractTemplateType;

  @IsString()
  contentTemplate!: string;

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsEnum(ContractVersionStatus)
  status?: ContractVersionStatus;
}

export class UpdateContractVersionDto {
  @IsOptional()
  @IsString()
  templateName?: string;

  @IsOptional()
  @IsString()
  versionNo?: string;

  @IsOptional()
  @IsString()
  contentTemplate?: string;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;
}

export class ArchiveContractDto {
  @IsOptional()
  @IsUUID()
  fileId?: string;
}

export class CreateOrderChangeDto {
  @IsEnum(OrderChangeType)
  changeType!: OrderChangeType;

  @IsOptional()
  @IsUUID()
  subscriptionPlanId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  periodMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  vehicleBaseFeeAmount?: number;

  @IsString()
  reason!: string;

  @IsOptional()
  beforeSnapshot?: unknown;

  @IsOptional()
  afterSnapshot?: unknown;
}
