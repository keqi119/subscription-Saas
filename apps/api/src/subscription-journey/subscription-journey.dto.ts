import {
  SubscriptionJourneyManualDecision,
  SubscriptionJourneyStatus
} from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateIf
} from "class-validator";

export class JourneyVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
}

export class JourneyReasonDto extends JourneyVersionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class FinalPlanDecisionDto extends JourneyVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  finalPeriodMonths!: number;

  @IsUUID()
  finalSubscriptionPlanId!: string;

  @IsUUID()
  finalVehicleId!: string;
}

export class VehicleAllocationDecisionDto extends JourneyVersionDto {
  @IsUUID()
  vehicleId!: string;
}

export class DeliveryEvidenceDecisionDto extends JourneyVersionDto {
  @IsEnum(SubscriptionJourneyManualDecision)
  decision!: SubscriptionJourneyManualDecision;

  @Matches(/^sha256:[0-9a-f]{64}$/i)
  manifestHash!: string;

  @ValidateIf(
    (dto: DeliveryEvidenceDecisionDto) =>
      dto.decision === SubscriptionJourneyManualDecision.REJECTED
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  notes?: string;

  @IsUUID()
  workOrderId!: string;
}

export class ListSubscriptionJourneysQueryDto {
  @IsOptional()
  @IsEnum(SubscriptionJourneyStatus)
  status?: SubscriptionJourneyStatus;
}
