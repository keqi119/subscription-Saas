import { Transform, Type } from "class-transformer";
import {
  BusinessExceptionApprovalStatus,
  BusinessExceptionSubjectType,
  VehicleCostActionType,
  VehicleCostCategory,
  VehicleCostResponsiblePartyType
} from "@prisma/client";
import {
  IsDefined,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface
} from "class-validator";

import type { AssetAccountingSnapshotObject } from "../asset-accounting.types";

const ACCOUNTING_PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_SNAPSHOT_DEPTH = 32;

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

function BoundedNonBlankString(maxLength: number) {
  return function (target: object, propertyKey: string) {
    IsString()(target, propertyKey);
    MinLength(1)(target, propertyKey);
    MaxLength(maxLength)(target, propertyKey);
    Matches(/\S/)(target, propertyKey);
  };
}

@ValidatorConstraint({ name: "positiveInt64String", async: false })
class PositiveInt64StringConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (typeof value !== "string" || !POSITIVE_DECIMAL.test(value)) return false;
    try {
      return BigInt(value) <= MAX_INT64;
    } catch {
      return false;
    }
  }

  defaultMessage() {
    return "amountCents must be a canonical positive signed-64-bit decimal string.";
  }
}

@ValidatorConstraint({ name: "assetAccountingSnapshot", async: false })
class AssetAccountingSnapshotConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return isSnapshotObject(value, 0);
  }

  defaultMessage() {
    return "Snapshot values must be plain JSON objects without unsafe integers.";
  }
}

export class AssetAccountingSourceDto {
  @IsUUID("4")
  id!: string;

  @BoundedNonBlankString(255)
  key!: string;

  @TrimmedString(1, 64)
  type!: string;
}

abstract class AssetAccountingWriteDto {
  @IsISO8601({ strict: true, strictSeparator: true })
  confirmedAt!: string;

  @TrimmedString(1, 2000)
  reason!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => AssetAccountingSourceDto)
  source!: AssetAccountingSourceDto;
}

export class AppendVehicleCostEntryDto extends AssetAccountingWriteDto {
  @IsEnum(VehicleCostActionType)
  actionType!: VehicleCostActionType;

  @Matches(ACCOUNTING_PERIOD)
  accountingPeriod!: string;

  @Validate(PositiveInt64StringConstraint)
  amountCents!: string;

  @IsOptional()
  @IsUUID("4")
  assetOwnerId?: string | null;

  @IsOptional()
  @Validate(AssetAccountingSnapshotConstraint)
  assetOwnerSnapshot?: AssetAccountingSnapshotObject | null;

  @IsOptional()
  @IsUUID("4")
  contractId?: string | null;

  @IsEnum(VehicleCostCategory)
  costCategory!: VehicleCostCategory;

  @IsOptional()
  @IsUUID("4")
  customerId?: string | null;

  @IsOptional()
  @IsUUID("4")
  evidenceId?: string | null;

  @IsOptional()
  @Validate(AssetAccountingSnapshotConstraint)
  evidenceSnapshot?: AssetAccountingSnapshotObject | null;

  @IsISO8601({ strict: true, strictSeparator: true })
  occurredOn!: string;

  @IsOptional()
  @IsUUID("4")
  orderId?: string | null;

  @IsOptional()
  @IsUUID("4")
  responsiblePartyId?: string | null;

  @IsEnum(VehicleCostResponsiblePartyType)
  responsiblePartyType!: VehicleCostResponsiblePartyType;

  @IsDefined()
  @Validate(AssetAccountingSnapshotConstraint)
  responsibilitySnapshot!: AssetAccountingSnapshotObject;

  @IsUUID("4")
  vehicleId!: string;

  @IsOptional()
  @IsUUID("4")
  workOrderId?: string | null;
}

export class ReverseVehicleCostEntryDto extends AssetAccountingWriteDto {}

export class ExceptionApprovalQueryDto {
  @IsOptional()
  @IsEnum(BusinessExceptionApprovalStatus)
  status?: BusinessExceptionApprovalStatus;

  @IsOptional()
  @IsUUID("4")
  subjectId?: string;

  @IsOptional()
  @IsEnum(BusinessExceptionSubjectType)
  subjectType?: BusinessExceptionSubjectType;
}

function isSnapshotObject(value: unknown, depth: number): value is AssetAccountingSnapshotObject {
  if (!isPlainObject(value) || depth > MAX_SNAPSHOT_DEPTH) return false;
  return Object.values(value).every((item) => isSnapshotValue(item, depth + 1));
}

function isSnapshotValue(value: unknown, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  }
  if (depth > MAX_SNAPSHOT_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => isSnapshotValue(item, depth + 1));
  return isSnapshotObject(value, depth);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
