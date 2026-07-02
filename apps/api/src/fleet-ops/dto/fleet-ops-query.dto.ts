import { Transform } from "class-transformer";
import { IsBoolean, IsDateString, IsOptional, IsString, IsUUID } from "class-validator";

export class FleetOpsVehicleParamDto {
  @IsUUID()
  vehicleId!: string;
}

export class FleetOpsQueryDto {
  @IsOptional()
  @IsDateString()
  asOf?: string;

  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  includeDiagnostics?: boolean;

  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  includeEconomics?: boolean;

  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  includeRisk?: boolean;

  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  includeTimeline?: boolean;

  @IsOptional()
  @IsString()
  requestId?: string;

  @IsOptional()
  @IsString()
  traceId?: string;
}

function optionalBoolean({ value }: { value: unknown }) {
  if (value == null || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return value;
}
