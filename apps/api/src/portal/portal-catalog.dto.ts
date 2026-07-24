import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

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
  vehicleModel?: string;

  @IsOptional()
  @IsString()
  city?: string;
}

