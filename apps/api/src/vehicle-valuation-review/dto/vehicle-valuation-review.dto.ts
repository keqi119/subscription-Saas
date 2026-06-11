import { Type } from "class-transformer";
import {
  VehicleValuationReviewSource,
  VehicleValuationReviewStatus
} from "@prisma/client";
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class CreateValuationReviewFromResidualForecastDto {
  @IsString()
  forecastPointId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requestedSalePriceAmount?: number | null;

  @IsOptional()
  @IsString()
  reason?: string | null;

  @IsOptional()
  @IsString()
  reviewRemark?: string | null;
}

export class VehicleValuationReviewQueryDto {
  @IsOptional()
  @IsEnum(VehicleValuationReviewStatus)
  reviewStatus?: VehicleValuationReviewStatus;

  @IsOptional()
  @IsEnum(VehicleValuationReviewSource)
  reviewSource?: VehicleValuationReviewSource;

  @IsOptional()
  @IsString()
  vehicleId?: string;

  @IsOptional()
  @IsString()
  vehicleNo?: string;

  @IsOptional()
  @IsString()
  vin?: string;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

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

export class ApproveVehicleValuationReviewDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  approvedSalePriceAmount!: number;

  @IsOptional()
  @IsString()
  reviewRemark?: string | null;
}

export class RejectVehicleValuationReviewDto {
  @IsString()
  rejectReason!: string;
}

export class CancelVehicleValuationReviewDto {
  @IsString()
  cancelReason!: string;
}
