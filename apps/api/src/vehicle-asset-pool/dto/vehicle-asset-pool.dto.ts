import { Type } from "class-transformer";
import {
  VehicleAssetPoolStatus,
  VehicleAssetPoolType
} from "@prisma/client";
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min
} from "class-validator";

export class VehicleAssetPoolsQueryDto {
  @IsOptional()
  @IsEnum(VehicleAssetPoolType)
  poolType?: VehicleAssetPoolType;

  @IsOptional()
  @IsEnum(VehicleAssetPoolStatus)
  poolStatus?: VehicleAssetPoolStatus;

  @IsOptional()
  @IsString()
  poolName?: string;

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

export class CreateVehicleAssetPoolDto {
  @IsString()
  poolName!: string;

  @IsEnum(VehicleAssetPoolType)
  poolType!: VehicleAssetPoolType;

  @IsOptional()
  @IsString()
  purpose?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateVehicleAssetPoolDto {
  @IsOptional()
  @IsString()
  poolName?: string;

  @IsOptional()
  @IsEnum(VehicleAssetPoolType)
  poolType?: VehicleAssetPoolType;

  @IsOptional()
  @IsEnum(VehicleAssetPoolStatus)
  poolStatus?: VehicleAssetPoolStatus;

  @IsOptional()
  @IsString()
  purpose?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class ArchiveVehicleAssetPoolDto {
  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class AddVehicleAssetPoolVehicleDto {
  @IsString()
  @IsUUID("4")
  vehicleId!: string;

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class BatchAddVehicleAssetPoolVehiclesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID("4", { each: true })
  vehicleIds!: string[];

  @IsString()
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class RemoveVehicleAssetPoolVehicleDto {
  @IsString()
  effectiveTo!: string;

  @IsOptional()
  @IsString()
  remark?: string | null;
}
