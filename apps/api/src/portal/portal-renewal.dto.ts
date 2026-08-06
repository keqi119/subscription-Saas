import { RenewalDecision } from "@prisma/client";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsString, IsUUID, MaxLength, Min } from "class-validator";

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
}

export class PortalRejectExtensionQuoteDto extends PortalConfirmExtensionQuoteDto {
  @IsString()
  @MaxLength(2_000)
  reason!: string;
}
