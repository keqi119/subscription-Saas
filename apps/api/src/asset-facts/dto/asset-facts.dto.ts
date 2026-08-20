import { Type } from "class-transformer";
import {
  VehicleOwnershipPeriodEndReason,
  VehicleOwnershipPeriodStartReason,
  VehicleSubscriptionPeriodEndReason,
  VehicleSubscriptionPeriodStartReason
} from "@prisma/client";
import {
  IsDefined,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested
} from "class-validator";

export class AssetFactSourceDto {
  @IsUUID("4")
  id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  type!: string;
}

abstract class AssetFactCommandDto {
  @IsISO8601({ strict: true, strictSeparator: true })
  confirmedAt!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => AssetFactSourceDto)
  source!: AssetFactSourceDto;

  @IsOptional()
  @IsObject()
  snapshot?: Record<string, unknown>;
}

export class OpenSubscriptionPeriodDto extends AssetFactCommandDto {
  @IsUUID("4")
  vehicleId!: string;

  @IsUUID("4")
  orderId!: string;

  @IsUUID("4")
  customerId!: string;

  @IsOptional()
  @IsUUID("4")
  contractId?: string | null;

  @IsOptional()
  @IsUUID("4")
  contractSegmentId?: string | null;

  @IsISO8601({ strict: true, strictSeparator: true })
  startedAt!: string;

  @IsEnum(VehicleSubscriptionPeriodStartReason)
  reason!: VehicleSubscriptionPeriodStartReason;
}

export class CloseSubscriptionPeriodDto extends AssetFactCommandDto {
  @IsUUID("4")
  periodId!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  endedAt!: string;

  @IsEnum(VehicleSubscriptionPeriodEndReason)
  reason!: VehicleSubscriptionPeriodEndReason;
}

export class OpenOwnershipPeriodDto extends AssetFactCommandDto {
  @IsUUID("4")
  vehicleId!: string;

  @IsUUID("4")
  assetOwnerId!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  startedAt!: string;

  @IsEnum(VehicleOwnershipPeriodStartReason)
  reason!: VehicleOwnershipPeriodStartReason;
}

export class CloseOwnershipPeriodDto extends AssetFactCommandDto {
  @IsUUID("4")
  periodId!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  endedAt!: string;

  @IsEnum(VehicleOwnershipPeriodEndReason)
  reason!: VehicleOwnershipPeriodEndReason;
}
