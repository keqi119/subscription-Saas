import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";

export class CreateApplicationDto {
  @IsUUID()
  customerId!: string;

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
