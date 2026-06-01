import { IsArray, IsEmail, IsOptional, IsString, IsUUID, MinLength } from "class-validator";

export class CreateUserDto {
  @IsString()
  username!: string;

  @IsString()
  name!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  mobile?: string;

  @IsArray()
  @IsUUID("4", { each: true })
  @IsOptional()
  roleIds?: string[];
}
