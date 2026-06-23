import { Transform, Type } from "class-transformer";
import { VehicleModel } from "@prisma/client";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min
} from "class-validator";

const MODEL_CODE_PATTERN = /^[A-Z0-9_-]+$/;

function parseOptionalBoolean({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return value;
}

export class VehicleModelDefinitionsQueryDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  series?: string;

  @IsOptional()
  @Transform(parseOptionalBoolean)
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Transform(parseOptionalBoolean)
  @IsBoolean()
  portalVisible?: boolean;

  @IsOptional()
  @IsEnum(VehicleModel)
  legacyVehicleModel?: VehicleModel;

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

export class CreateVehicleModelDefinitionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(MODEL_CODE_PATTERN)
  modelCode!: string;

  @IsOptional()
  @IsEnum(VehicleModel)
  legacyVehicleModel?: VehicleModel | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  brand!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  series?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  modelName!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1990)
  @Max(2100)
  modelYear?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  variantName?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  customerDisplayName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  energyType?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  bodyType?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seatCount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  driveType?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  batteryCapacityKwh?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  officialRangeKm?: number | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  portalVisible?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsString()
  remark?: string | null;
}

export class UpdateVehicleModelDefinitionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(MODEL_CODE_PATTERN)
  modelCode?: string;

  @IsOptional()
  @IsEnum(VehicleModel)
  legacyVehicleModel?: VehicleModel | null;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  series?: string | null;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  modelName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1990)
  @Max(2100)
  modelYear?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  variantName?: string | null;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  customerDisplayName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  energyType?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  bodyType?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seatCount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  driveType?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  batteryCapacityKwh?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  officialRangeKm?: number | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  portalVisible?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsString()
  remark?: string | null;
}
