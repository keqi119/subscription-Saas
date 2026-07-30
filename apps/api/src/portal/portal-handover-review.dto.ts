import { Equals, IsBoolean, IsOptional, IsString, Matches } from "class-validator";

export class ConfirmPortalHandoverReviewDto {
  @IsBoolean()
  @Equals(true)
  acknowledgement!: boolean;

  @IsString()
  @Matches(/^sha256:[0-9a-f]{64}$/)
  manifestHash!: string;
}

export class ObjectPortalHandoverReviewDto {
  @IsString()
  reason!: string;

  @IsOptional()
  @IsString()
  details?: string;
}
