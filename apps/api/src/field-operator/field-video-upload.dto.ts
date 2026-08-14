import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";

import { MAX_FIELD_VIDEO_SIZE_BYTES } from "./field-video-upload.constants";

export class CreateFieldVideoUploadSessionDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @Matches(/^[a-f0-9]{64}$/)
  fingerprintSha256!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  lastModifiedMs!: number;

  @IsString()
  @MaxLength(128)
  mimeType!: string;

  @IsOptional()
  @IsUUID()
  replaceEvidenceFileId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_FIELD_VIDEO_SIZE_BYTES)
  sizeBytes!: number;
}
