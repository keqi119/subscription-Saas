import { Type } from "class-transformer";
import { OrderMileageReviewStatus } from "@prisma/client";
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min
} from "class-validator";

export class MileageReviewListQueryDto {
  @IsOptional()
  @IsString()
  orderId?: string;

  @IsOptional()
  @IsEnum(OrderMileageReviewStatus)
  status?: OrderMileageReviewStatus;

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

export class SaveAdminMileageReviewDraftDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  submittedMileageKm!: number;

  @IsISO8601()
  readingAt!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  lockVersion!: number;
}

export class AttachMileageReviewEvidenceDto {
  @IsString()
  fileId!: string;

  @IsOptional()
  @IsISO8601()
  capturedAt?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  lockVersion!: number;
}

export class MileageReviewVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  lockVersion!: number;
}

export class ConfirmMileageReviewDto extends MileageReviewVersionDto {
  @IsString()
  @MaxLength(128)
  idempotencyKey!: string;
}

export class ReturnMileageReviewDto extends MileageReviewVersionDto {
  @IsString()
  reason!: string;
}

export class VoidMileageReviewDto extends MileageReviewVersionDto {
  @IsString()
  reason!: string;
}
