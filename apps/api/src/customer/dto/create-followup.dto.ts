import { FollowupType } from "@prisma/client";
import { IsEnum, IsOptional, IsString } from "class-validator";

export class CreateFollowupDto {
  @IsEnum(FollowupType)
  @IsOptional()
  followupType?: FollowupType;

  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  nextFollowupAt?: string;
}
