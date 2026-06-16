import { IsOptional, IsString, MaxLength } from "class-validator";

export class ESignCallbackDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  eventType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  providerTaskId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  taskId?: string;
}
