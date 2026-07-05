import { Transform } from "class-transformer";
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class FleetOpsVehicleLookupQueryDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  q!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    return Number(value);
  })
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number = 10;
}
