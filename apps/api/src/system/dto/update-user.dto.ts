import { UserStatus } from "@prisma/client";
import { IsArray, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MinLength } from "class-validator";

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @MinLength(8)
  @IsOptional()
  password?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  mobile?: string;

  @IsEnum(UserStatus)
  @IsOptional()
  status?: UserStatus;

  @IsArray()
  @IsUUID("4", { each: true })
  @IsOptional()
  roleIds?: string[];
}
