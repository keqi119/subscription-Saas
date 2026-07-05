import { Transform } from "class-transformer";
import { IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
import { VehicleStatus } from "@prisma/client";

import { FleetOpsRangeQueryDto } from "./fleet-ops-range-query.dto";
import type { FleetOpsAgingBucket, FleetOpsConfidenceBand, FleetOpsScopeType } from "../fleet-ops.pool-read-model";

const scopeTypes: FleetOpsScopeType[] = ["ALL", "COHORT", "POOL"];
const agingBuckets: FleetOpsAgingBucket[] = ["D1", "D2", "D3", "D4", "D5", "NONE"];
const confidenceBands: FleetOpsConfidenceBand[] = ["HIGH", "LOW", "MEDIUM", "UNKNOWN"];

export class FleetOpsOverviewQueryDto extends FleetOpsRangeQueryDto {
  @IsOptional()
  @IsIn(scopeTypes)
  scopeType?: FleetOpsScopeType;

  @IsOptional()
  @IsUUID()
  poolId?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @Transform(optionalInt)
  @IsInt()
  modelYear?: number;

  @IsOptional()
  @IsEnum(VehicleStatus)
  vehicleStatus?: VehicleStatus;

  @IsOptional()
  @IsDateString()
  registrationDateFrom?: string;

  @IsOptional()
  @IsDateString()
  registrationDateTo?: string;

  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @IsOptional()
  @IsString()
  assetLocation?: string;

  @IsOptional()
  @IsString()
  riskLevel?: string;

  @IsOptional()
  @IsIn(agingBuckets)
  collectionLevel?: FleetOpsAgingBucket;

  @IsOptional()
  @IsIn(agingBuckets)
  agingBucket?: FleetOpsAgingBucket;

  @IsOptional()
  @IsIn(confidenceBands)
  confidenceBand?: FleetOpsConfidenceBand;

  @IsOptional()
  @IsString()
  warningType?: string;

  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  evidenceMissing?: boolean;

  @IsOptional()
  @IsIn(["NONE", "OVERDUE"])
  overdueStatus?: "NONE" | "OVERDUE";

  @IsOptional()
  @Transform(optionalInt)
  @IsInt()
  @Min(1)
  @Max(50)
  topN?: number;

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

  @IsOptional()
  @Transform(optionalInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

function optionalInt({ value }: { value: unknown }) {
  if (value == null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : value;
}

function optionalBoolean({ value }: { value: unknown }) {
  if (value == null || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return value;
}
