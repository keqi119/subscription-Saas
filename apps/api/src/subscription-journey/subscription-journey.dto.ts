import {
  SubscriptionJourneyManualDecision,
  SubscriptionJourneyStatus
} from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsHash,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
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
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  finalPeriodMonths?: number;

  @IsOptional()
  @IsUUID()
  finalSubscriptionPlanId?: string;

  @IsOptional()
  @IsUUID()
  finalVehicleId?: string;
}

export class VehicleAllocationDecisionDto extends JourneyVersionDto {
  @IsUUID()
  vehicleId!: string;
}

export class DeliveryEvidenceDecisionDto extends JourneyVersionDto {
  @IsEnum(SubscriptionJourneyManualDecision)
  decision!: SubscriptionJourneyManualDecision;

  @IsHash("sha256")
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
