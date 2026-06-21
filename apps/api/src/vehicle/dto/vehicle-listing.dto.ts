import { Transform, Type } from "class-transformer";
import {
  VehicleListingConditionGrade,
  VehicleListingMediaCategory,
  VehicleListingStatus
} from "@prisma/client";
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested
} from "class-validator";

export class UpsertVehicleListingProfileDto {
  @IsOptional()
  @IsEnum(VehicleListingStatus)
  listingStatus?: VehicleListingStatus;

  @IsOptional()
  @IsBoolean()
  portalVisible?: boolean;

  @IsOptional()
  @IsString()
  displayName?: string | null;

  @IsOptional()
  @IsString()
  shortTitle?: string | null;

  @IsOptional()
  @IsString()
  subtitle?: string | null;

  @IsOptional()
  @IsArray()
  sellingPoints?: unknown[] | null;

  @IsOptional()
  @IsArray()
  customerTags?: unknown[] | null;

  @IsOptional()
  @IsString()
  highlightSummary?: string | null;

  @IsOptional()
  @IsEnum(VehicleListingConditionGrade)
  conditionGrade?: VehicleListingConditionGrade | null;

  @IsOptional()
  @IsString()
  conditionSummary?: string | null;

  @IsOptional()
  @IsBoolean()
  hasMajorAccident?: boolean | null;

  @IsOptional()
  @IsBoolean()
  hasFloodDamage?: boolean | null;

  @IsOptional()
  @IsBoolean()
  hasFireDamage?: boolean | null;

  @IsOptional()
  @IsBoolean()
  hasStructuralDamage?: boolean | null;

  @IsOptional()
  @IsString()
  knownDefectsSummary?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  batteryHealthPercent?: number | null;

  @IsOptional()
  @IsString()
  batteryHealthCheckedAt?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  estimatedRangeKm?: number | null;

  @IsOptional()
  @IsString()
  batteryRemark?: string | null;

  @IsOptional()
  @IsArray()
  serviceHighlights?: unknown[] | null;

  @IsOptional()
  @IsString()
  feeDescription?: string | null;

  @IsOptional()
  @IsString()
  applicationNotice?: string | null;

  @IsOptional()
  @IsArray()
  faqSnapshot?: unknown[] | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class UploadVehicleListingMediaDto {
  @IsOptional()
  @IsEnum(VehicleListingMediaCategory)
  mediaCategory?: VehicleListingMediaCategory;

  @IsOptional()
  @IsString()
  caption?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @Transform(booleanField)
  @IsBoolean()
  isCover?: boolean;

  @IsOptional()
  @Transform(booleanField)
  @IsBoolean()
  customerVisible?: boolean;
}

export class UpdateVehicleListingMediaDto {
  @IsOptional()
  @IsEnum(VehicleListingMediaCategory)
  mediaCategory?: VehicleListingMediaCategory;

  @IsOptional()
  @IsString()
  caption?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @Transform(booleanField)
  @IsBoolean()
  isCover?: boolean;

  @IsOptional()
  @Transform(booleanField)
  @IsBoolean()
  customerVisible?: boolean;
}

export class VehicleListingPlanInputDto {
  @IsString()
  subscriptionPlanId!: string;

  @IsOptional()
  @IsBoolean()
  visible?: boolean;

  @IsOptional()
  @IsBoolean()
  recommended?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  displayMonthlyFeeAmount?: number | null;

  @IsOptional()
  @IsString()
  displayRemark?: string | null;
}

export class PutVehicleListingPlansDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VehicleListingPlanInputDto)
  plans!: VehicleListingPlanInputDto[];
}

function booleanField({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return value === "true" || value === "1";
}
