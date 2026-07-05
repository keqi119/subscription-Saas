import { Transform } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";
import { VehicleAssetPoolStatus, VehicleAssetPoolType } from "@prisma/client";

import { FleetOpsQueryDto } from "./fleet-ops-query.dto";

export class FleetOpsPoolParamDto {
  @IsUUID()
  poolId!: string;
}

export class FleetOpsPoolQueryDto extends FleetOpsQueryDto {
  @IsOptional()
  @IsEnum(VehicleAssetPoolType)
  poolType?: VehicleAssetPoolType;

  @IsOptional()
  @IsEnum(VehicleAssetPoolStatus)
  poolStatus?: VehicleAssetPoolStatus;

  @IsOptional()
  @Transform(optionalInt)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(optionalInt)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

function optionalInt({ value }: { value: unknown }) {
  if (value == null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : value;
}
