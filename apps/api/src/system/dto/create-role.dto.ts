import { RoleCode } from "@prisma/client";
import { IsEnum, IsOptional, IsString } from "class-validator";

export class CreateRoleDto {
  @IsEnum(RoleCode)
  code!: RoleCode;

  @IsString()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;
}
