import { IsOptional, IsString } from "class-validator";

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
  @IsString()
  city?: string;
}

