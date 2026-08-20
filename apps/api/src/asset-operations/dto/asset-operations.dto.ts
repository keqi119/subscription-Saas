import { Transform, Type } from "class-transformer";
import {
  AssetWorkOrderEvidenceAction,
  AssetWorkOrderEvidenceType,
  AssetWorkOrderPriority,
  AssetWorkOrderStatus,
  AssetWorkOrderType,
  Prisma,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionStatus,
  VehicleOperationalRestrictionType
} from "@prisma/client";
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  Validate,
  type ValidationArguments,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface
} from "class-validator";

import { VehicleAvailabilityPurpose } from "../vehicle-availability";

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

function TrimmedString(minLength: number, maxLength: number) {
  return function (target: object, propertyKey: string) {
    Transform(({ value }) => (typeof value === "string" ? value.trim() : value))(
      target,
      propertyKey
    );
    IsString()(target, propertyKey);
    MinLength(minLength)(target, propertyKey);
    MaxLength(maxLength)(target, propertyKey);
  };
}

export class AssetOperationSourceDto {
  @IsUUID("4")
  id!: string;

  @TrimmedString(1, 255)
  key!: string;

  @TrimmedString(1, 64)
  type!: string;
}

abstract class AssetOperationCommandDto {
  @IsISO8601({ strict: true, strictSeparator: true })
  occurredAt!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => AssetOperationSourceDto)
  source!: AssetOperationSourceDto;
}

export class CreateAssetWorkOrderDto extends AssetOperationCommandDto {
  @IsOptional()
  @IsUUID("4")
  assetOwnerId?: string | null;

  @IsOptional()
  @IsUUID("4")
  contractId?: string | null;

  @IsBoolean()
  costConfirmationRequired!: boolean;

  @IsOptional()
  @IsUUID("4")
  customerId?: string | null;

  @IsOptional()
  @TrimmedString(1, 2000)
  description?: string | null;

  @IsOptional()
  @IsObject()
  metadata?: Prisma.InputJsonObject | null;

  @IsOptional()
  @IsUUID("4")
  orderId?: string | null;

  @IsEnum(AssetWorkOrderPriority)
  priority!: AssetWorkOrderPriority;

  @IsOptional()
  @IsUUID("4")
  relatedWorkOrderId?: string | null;

  @IsUUID("4")
  vehicleId!: string;

  @IsEnum(AssetWorkOrderType)
  workOrderType!: AssetWorkOrderType;
}

export class AssignAssetWorkOrderDto extends AssetOperationCommandDto {
  @IsUUID("4")
  assignedUserId!: string;

  @IsObject()
  detailSnapshot!: Prisma.InputJsonObject;

  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  scheduledAt?: string | null;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  slaDueAt?: string | null;
}

export class TransitionAssetWorkOrderDto extends AssetOperationCommandDto {
  @IsOptional()
  @TrimmedString(1, 1000)
  closeReason?: string | null;

  @IsObject()
  detailSnapshot!: Prisma.InputJsonObject;

  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsOptional()
  @TrimmedString(1, 4000)
  solution?: string | null;

  @IsEnum(AssetWorkOrderStatus)
  targetStatus!: AssetWorkOrderStatus;
}

export class AppendAssetWorkOrderNoteDto extends AssetOperationCommandDto {
  @TrimmedString(1, 4000)
  note!: string;
}

@ValidatorConstraint({ name: "assetWorkOrderEvidenceShape", async: false })
class AssetWorkOrderEvidenceShapeConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const input = args.object as AppendAssetWorkOrderEvidenceDto;
    const hasFile = typeof input.fileId === "string";
    const hasHash = typeof input.contentSha256 === "string";
    const hasSuperseded = typeof input.supersedesEvidenceId === "string";

    if (input.action === AssetWorkOrderEvidenceAction.ATTACH) {
      return hasFile && hasHash && !hasSuperseded;
    }
    if (input.action === AssetWorkOrderEvidenceAction.SUPERSEDE) {
      return hasFile && hasHash && hasSuperseded;
    }
    if (input.action === AssetWorkOrderEvidenceAction.REMOVE) {
      return !hasFile && !hasHash && hasSuperseded;
    }
    return false;
  }

  defaultMessage() {
    return "Evidence action requires an exact file, hash, and supersession shape.";
  }
}

export class AppendAssetWorkOrderEvidenceDto extends AssetOperationCommandDto {
  @IsEnum(AssetWorkOrderEvidenceAction)
  @Validate(AssetWorkOrderEvidenceShapeConstraint)
  action!: AssetWorkOrderEvidenceAction;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  capturedAt?: string | null;

  @IsOptional()
  @IsObject()
  captureMetadata?: Prisma.InputJsonObject | null;

  @IsOptional()
  @Matches(LOWERCASE_SHA256)
  contentSha256?: string | null;

  @IsOptional()
  @IsUUID("4")
  eventId?: string | null;

  @IsEnum(AssetWorkOrderEvidenceType)
  evidenceType!: AssetWorkOrderEvidenceType;

  @IsOptional()
  @IsUUID("4")
  fileId?: string | null;

  @IsOptional()
  @IsUUID("4")
  supersedesEvidenceId?: string | null;
}

export class CreateVehicleOperationalRestrictionDto extends AssetOperationCommandDto {
  @IsObject()
  conditionsSnapshot!: Prisma.InputJsonObject;

  @IsOptional()
  @IsObject()
  evidenceSnapshot?: Prisma.InputJsonObject | null;

  @IsEnum(VehicleOperationalRestrictionType)
  restrictionType!: VehicleOperationalRestrictionType;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsEnum(VehicleOperationalRestrictionScope, { each: true })
  scopes!: VehicleOperationalRestrictionScope[];

  @IsEnum(VehicleOperationalRestrictionSeverity)
  severity!: VehicleOperationalRestrictionSeverity;

  @IsISO8601({ strict: true, strictSeparator: true })
  startedAt!: string;

  @IsOptional()
  @IsUUID("4")
  workOrderId?: string | null;
}

export class ReleaseVehicleOperationalRestrictionDto extends AssetOperationCommandDto {
  @TrimmedString(1, 2000)
  releaseReason!: string;

  @IsObject()
  releaseSnapshot!: Prisma.InputJsonObject;

  @IsIn([VehicleOperationalRestrictionStatus.RELEASED, VehicleOperationalRestrictionStatus.VOIDED])
  targetStatus!: Exclude<VehicleOperationalRestrictionStatus, "ACTIVE">;
}

export class VehicleAvailabilityQueryDto {
  @IsEnum(VehicleAvailabilityPurpose)
  purpose!: VehicleAvailabilityPurpose;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  asOf?: string;
}
