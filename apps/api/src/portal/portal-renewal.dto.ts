import { RenewalDecision } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min
} from "class-validator";

export class PortalRenewalDecisionDto {
  @IsEnum(RenewalDecision)
  decision!: RenewalDecision;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
}

export class PortalConfirmExtensionQuoteDto {
  @IsUUID()
  quoteId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;

  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/i)
  commercialSnapshotHash?: string;
}

export class PortalRejectExtensionQuoteDto extends PortalConfirmExtensionQuoteDto {
  @IsString()
  @MaxLength(2_000)
  reason!: string;
}
