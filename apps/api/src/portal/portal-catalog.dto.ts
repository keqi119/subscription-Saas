import { IsOptional, IsString, IsUUID } from "class-validator";

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
  city?: string;
}
