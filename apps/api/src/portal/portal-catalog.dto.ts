import { IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";

const MODEL_CODE_PATTERN = /^[A-Z0-9_-]+$/;

export class PortalVehicleCatalogQueryDto {
  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  series?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsUUID()
  modelDefinitionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(MODEL_CODE_PATTERN)
  vehicleModel?: string;

  @IsOptional()
  @IsString()
  city?: string;
}
