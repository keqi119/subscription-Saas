import { VehicleModel } from "@prisma/client";
import { IsEnum, IsOptional, IsString, IsUUID } from "class-validator";

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
  @IsEnum(VehicleModel)
  vehicleModel?: VehicleModel;

  @IsOptional()
  @IsString()
  city?: string;
}

