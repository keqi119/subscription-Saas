import { Type } from "class-transformer";
import {
  IsInt,
  IsISO8601,
  IsJSON,
  IsOptional,
  Min
} from "class-validator";

import { MileageReviewListQueryDto } from "../mileage-review/dto/mileage-review.dto";

export class PortalMileageReviewListQueryDto extends MileageReviewListQueryDto {}

export class SavePortalMileageReviewDraftDto {
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

export class UploadPortalMileageReviewEvidenceDto {
  @IsOptional()
  @IsISO8601()
  capturedAt?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  lockVersion!: number;

  @IsOptional()
  @IsJSON()
  metadata?: string;
}

export class PortalMileageReviewVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  lockVersion!: number;
}
