import { IsDateString, IsOptional } from "class-validator";

import { FleetOpsQueryDto } from "./fleet-ops-query.dto";

export class FleetOpsRangeQueryDto extends FleetOpsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
