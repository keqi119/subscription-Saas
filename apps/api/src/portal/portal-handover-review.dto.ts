import { IsBoolean, IsOptional, IsString } from "class-validator";

export class ConfirmPortalHandoverReviewDto {
  @IsOptional()
  @IsBoolean()
  acknowledgement?: boolean;
}

export class ObjectPortalHandoverReviewDto {
  @IsString()
  reason!: string;

  @IsOptional()
  @IsString()
  details?: string;
}
