import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class UpdateApplicationDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  intendedModel?: string;

  @IsInt()
  @IsOptional()
  @Max(60)
  @Min(1)
  intendedPeriodMonths?: number;
}
