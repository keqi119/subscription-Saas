import { Type } from "class-transformer";
import {
  VehicleConditionItemArea,
  VehicleConditionItemResult,
  VehicleConditionItemSeverity,
  VehicleConditionItemType,
  VehicleListingConditionGrade
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
  Min
} from "class-validator";

export class CreateVehicleConditionReportDto {
  @IsOptional()
  @IsString()
  reportNo?: string | null;

  @IsOptional()
  @IsString()
  inspectionDate?: string | null;

  @IsOptional()
  @IsString()
  inspectorName?: string | null;

  @IsOptional()
  @IsString()
  inspectorOrg?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  odometerKm?: number | null;

  @IsOptional()
  @IsEnum(VehicleListingConditionGrade)
  overallGrade?: VehicleListingConditionGrade | null;

  @IsOptional()
  @IsString()
  summary?: string | null;
}

export class UpdateVehicleConditionReportDto {
  @IsOptional()
  @IsString()
  inspectionDate?: string | null;

  @IsOptional()
  @IsString()
  inspectorName?: string | null;

  @IsOptional()
  @IsString()
  inspectorOrg?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  odometerKm?: number | null;

  @IsOptional()
  @IsEnum(VehicleListingConditionGrade)
  overallGrade?: VehicleListingConditionGrade | null;

  @IsOptional()
  @IsString()
  summary?: string | null;

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
  exteriorSummary?: string | null;

  @IsOptional()
  @IsString()
  interiorSummary?: string | null;

  @IsOptional()
  @IsString()
  chassisSummary?: string | null;

  @IsOptional()
  @IsString()
  tireSummary?: string | null;

  @IsOptional()
  @IsString()
  brakeSummary?: string | null;

  @IsOptional()
  @IsString()
  glassLightSummary?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  batteryHealthPercent?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  batteryCycleCount?: number | null;

  @IsOptional()
  @IsString()
  batteryCheckedAt?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  batteryEstimatedRangeKm?: number | null;

  @IsOptional()
  @IsString()
  batteryWarrantyUntil?: string | null;

  @IsOptional()
  @IsString()
  batteryRemark?: string | null;

  @IsOptional()
  @IsString()
  safetyConclusion?: string | null;

  @IsOptional()
  @IsString()
  repairSuggestion?: string | null;

  @IsOptional()
  @IsString()
  customerSummary?: string | null;
}

export class CreateVehicleConditionReportItemDto {
  @IsEnum(VehicleConditionItemArea)
  area!: VehicleConditionItemArea;

  @IsEnum(VehicleConditionItemType)
  itemType!: VehicleConditionItemType;

  @IsOptional()
  @IsEnum(VehicleConditionItemSeverity)
  severity?: VehicleConditionItemSeverity;

  @IsOptional()
  @IsEnum(VehicleConditionItemResult)
  result?: VehicleConditionItemResult;

  @IsOptional()
  @IsString()
  partName?: string | null;

  @IsOptional()
  @IsString()
  title?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  affectsSafety?: boolean;

  @IsOptional()
  @IsBoolean()
  repairRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  customerVisible?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaIds?: string[] | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class UpdateVehicleConditionReportItemDto {
  @IsOptional()
  @IsEnum(VehicleConditionItemArea)
  area?: VehicleConditionItemArea;

  @IsOptional()
  @IsEnum(VehicleConditionItemType)
  itemType?: VehicleConditionItemType;

  @IsOptional()
  @IsEnum(VehicleConditionItemSeverity)
  severity?: VehicleConditionItemSeverity;

  @IsOptional()
  @IsEnum(VehicleConditionItemResult)
  result?: VehicleConditionItemResult;

  @IsOptional()
  @IsString()
  partName?: string | null;

  @IsOptional()
  @IsString()
  title?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  affectsSafety?: boolean;

  @IsOptional()
  @IsBoolean()
  repairRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  customerVisible?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaIds?: string[] | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}
