import { Transform, Type } from "class-transformer";
import {
  AssetWorkOrderEvidenceAction,
  AssetWorkOrderEvidenceType,
  SubscriptionClosureStatus,
  VehicleCostActionType,
  VehicleCostCategory,
  VehicleCostResponsiblePartyType,
  VehicleDamageLevel,
  VehicleDamageResponsibleParty,
  VehicleDamageType
} from "@prisma/client";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
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
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface
} from "class-validator";

const CANONICAL_NONNEGATIVE_INT64 = /^(?:0|[1-9]\d*)$/;
const CANONICAL_POSITIVE_INT64 = /^[1-9]\d*$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const ACCOUNTING_PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;

function Trimmed(min: number, max: number) {
  return function (target: object, propertyKey: string) {
    Transform(({ value }) => (typeof value === "string" ? value.trim() : value))(
      target,
      propertyKey
    );
    IsString()(target, propertyKey);
    MinLength(min)(target, propertyKey);
    MaxLength(max)(target, propertyKey);
  };
}

@ValidatorConstraint({ name: "closureJson", async: false })
class ClosureJsonConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return jsonSafe(value, 0);
  }
  defaultMessage() {
    return "value must be a bounded plain JSON object";
  }
}

@ValidatorConstraint({ name: "closureInt64", async: false })
class ClosureInt64Constraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (typeof value !== "string" || !CANONICAL_NONNEGATIVE_INT64.test(value)) return false;
    try {
      return BigInt(value) <= MAX_INT64;
    } catch {
      return false;
    }
  }
}

export class ClosureCaseQueryDto {
  @IsOptional() @IsUUID("4") contractId?: string;
  @IsOptional() @IsUUID("4") customerId?: string;
  @IsOptional() @IsUUID("4") orderId?: string;
  @IsOptional() @IsEnum(SubscriptionClosureStatus) status?: SubscriptionClosureStatus;
  @IsOptional() @IsUUID("4") vehicleId?: string;
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? 50 : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class ClosureDamageDto {
  @IsUUID("4") checklistItemId!: string;
  @IsEnum(VehicleDamageLevel) damageLevel!: string;
  @IsEnum(VehicleDamageType) damageType!: string;
  @Trimmed(1, 2000) description!: string;
  @IsOptional() @Validate(ClosureInt64Constraint) estimatedRepairAmount?: string;
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsUUID("4", { each: true })
  evidenceIds!: string[];
  @IsOptional() @IsEnum(VehicleDamageResponsibleParty) responsibleParty?: string;
}

export class ConfirmClosurePhysicalReceiptDto {
  @IsUUID("4") checklistRevisionId!: string;
  @Matches(LOWERCASE_SHA256) checklistManifestHash!: string;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ClosureDamageDto)
  damages!: ClosureDamageDto[];
  @IsIn(["VOLUNTARY_RETURN", "RECOVERY"]) physicalControlMode!: "VOLUNTARY_RETURN" | "RECOVERY";
  @IsOptional() @Trimmed(1, 2000) remark?: string | null;
  @IsInt() @Min(0) @Max(10_000_000) returnMileageKm!: number;
  @IsIn(["NORMAL_RETURN", "EARLY_TERMINATION"]) returnType!: "NORMAL_RETURN" | "EARLY_TERMINATION";
  @IsISO8601({ strict: true, strictSeparator: true }) returnedAt!: string;
}

export class ReturnChecklistItemDto {
  @Trimmed(1, 64) itemCode!: string;
  @IsIn(["NORMAL", "MISSING", "DAMAGED", "NOT_APPLICABLE", "PENDING_VERIFICATION"])
  state!: "NORMAL" | "MISSING" | "DAMAGED" | "NOT_APPLICABLE" | "PENDING_VERIFICATION";
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) expectedQuantity?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) returnedQuantity?: number | null;
  @IsOptional() @Trimmed(1, 2000) remark?: string | null;
}

export class CaptureReturnChecklistDto {
  @IsIn(["CUSTOMER_SIGNED", "CUSTOMER_REFUSED", "CUSTOMER_ABSENT"])
  attestationMode!: "CUSTOMER_SIGNED" | "CUSTOMER_REFUSED" | "CUSTOMER_ABSENT";
  @IsOptional() @Trimmed(1, 2000) attestationReason?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID("4", { each: true })
  attestationEvidenceIds?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  witnesses?: string[];
  @IsOptional() @Trimmed(1, 2000) customerComments?: string | null;
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReturnChecklistItemDto)
  items!: ReturnChecklistItemDto[];
  @IsISO8601({ strict: true, strictSeparator: true }) capturedAt!: string;
}

export class CancelReturnManifestSigningDto {
  @Trimmed(1, 180) idempotencyKey!: string;
  @Trimmed(2, 2000) reason!: string;
}

export class UploadReturnEvidenceDto {
  @IsISO8601({ strict: true, strictSeparator: true }) capturedAt!: string;
  @IsEnum(AssetWorkOrderEvidenceType) evidenceType!: AssetWorkOrderEvidenceType;
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsUUID("4") targetId!: string;
  @IsIn(["CHECKLIST_ITEM", "DAMAGE", "CASE_ATTESTATION"])
  targetType!: "CHECKLIST_ITEM" | "DAMAGE" | "CASE_ATTESTATION";
  @IsOptional() @IsUUID("4") supersedesEvidenceId?: string | null;
  @IsIn(["CUSTOMER_VISIBLE", "INTERNAL_ONLY"])
  visibility!: "CUSTOMER_VISIBLE" | "INTERNAL_ONLY";
}

export class GenerateReturnDeltaDto {
  @Trimmed(1, 180) idempotencyKey!: string;
}

export class ReturnDeltaResponsibilityDecisionDto {
  @Trimmed(1, 2000) decisionReason!: string;
  @IsUUID("4") itemId!: string;
  @IsIn(["CUSTOMER", "PLATFORM", "THIRD_PARTY", "NORMAL_WEAR"])
  responsibility!: "CUSTOMER" | "PLATFORM" | "THIRD_PARTY" | "NORMAL_WEAR";
}

export class ConfirmReturnDeltaDto {
  @IsUUID("4") baseRevisionId!: string;
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReturnDeltaResponsibilityDecisionDto)
  decisions!: ReturnDeltaResponsibilityDecisionDto[];
  @Trimmed(1, 180) idempotencyKey!: string;
}

export class ClosurePricingLineDto {
  @Trimmed(1, 64) chargeType!: string;
  @IsOptional() @IsUUID("4") clauseSnapshotId?: string | null;
  @IsOptional() @IsUUID("4") deltaItemId?: string | null;
  @IsOptional() @IsUUID("4") exceptionApprovalId?: string | null;
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID("4", { each: true })
  evidenceIds!: string[];
  @Trimmed(1, 64) lineCode!: string;
  @IsOptional() @Trimmed(1, 2000) manualBasis?: string | null;
  @IsOptional() @Validate(ClosureInt64Constraint) manualUnitPriceCents?: string | null;
  @IsInt() @Min(0) @Max(1_000_000) quantity!: number;
  @IsIn(["CUSTOMER", "PLATFORM", "THIRD_PARTY", "NORMAL_WEAR", "UNDETERMINED"])
  responsibility!: "CUSTOMER" | "PLATFORM" | "THIRD_PARTY" | "NORMAL_WEAR" | "UNDETERMINED";
}

export class CreateClosurePricingDto {
  @IsBoolean() finalize!: boolean;
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ClosurePricingLineDto)
  lines!: ClosurePricingLineDto[];
  @IsUUID("4") settlementRevisionId!: string;
}

export class RequestClosureApprovalDto {
  @IsIn(["PRICING_OVERRIDE", "WAIVER", "WRITE_OFF", "REGISTRATION_DOCUMENT_MISSING"])
  approvalType!: "PRICING_OVERRIDE" | "WAIVER" | "WRITE_OFF" | "REGISTRATION_DOCUMENT_MISSING";
  @IsOptional() @IsUUID("4") billId?: string;
  @IsOptional() @IsUUID("4") checklistItemId?: string;
  @IsOptional() @IsUUID("4") clauseSnapshotId?: string;
  @IsOptional() @IsUUID("4") deltaItemId?: string;
  @IsArray() @ArrayMaxSize(20) @IsUUID("4", { each: true }) evidenceIds!: string[];
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsOptional() @Trimmed(1, 2000) manualBasis?: string;
  @IsOptional() @Validate(ClosureInt64Constraint) manualUnitPriceCents?: string;
  @Trimmed(1, 2000) requestReason!: string;
  @IsOptional() @IsUUID("4") settlementRevisionId?: string;
}

export class DecideClosureApprovalDto {
  @IsIn(["APPROVED", "REJECTED"])
  decision!: "APPROVED" | "REJECTED";
  @Trimmed(1, 2000) decisionComment!: string;
  @IsInt() @Min(0) expectedVersion!: number;
  @Trimmed(1, 180) idempotencyKey!: string;
}

export class ClosureCustomerDisputeDto {
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID("4", { each: true })
  evidenceIds!: string[];
  @IsUUID("4") chargeLineId!: string;
  @Trimmed(1, 2000) reason!: string;
}

export class ClosureCustomerResponseDto {
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsIn(["ACCEPTED", "PARTIALLY_DISPUTED", "DISPUTED"])
  status!: "ACCEPTED" | "PARTIALLY_DISPUTED" | "DISPUTED";
  @IsUUID("4") settlementRevisionId!: string;
  @Matches(LOWERCASE_SHA256) settlementHash!: string;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ClosureCustomerDisputeDto)
  disputes!: ClosureCustomerDisputeDto[];
}

export class RecordClosureNoResponseDto {
  @IsISO8601({ strict: true, strictSeparator: true }) deadlineAt!: string;
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsUUID("4") settlementRevisionId!: string;
  @Matches(LOWERCASE_SHA256) settlementHash!: string;
}

export class DecideClosureDisputeDto {
  @IsIn(["ACCEPTED_BY_PLATFORM", "REJECTED_BY_PLATFORM"])
  decision!: "ACCEPTED_BY_PLATFORM" | "REJECTED_BY_PLATFORM";
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID("4", { each: true })
  evidenceIds!: string[];
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) occurredAt!: string;
  @Trimmed(1, 2000) rationale!: string;
}

export class RecordClosureDispositionDto {
  @IsOptional() @IsUUID("4") approvalId?: string | null;
  @IsUUID("4") billId!: string;
  @IsOptional() @IsUUID("4") chargeLineId?: string | null;
  @IsIn([
    "OPEN",
    "MANUAL_PAYMENT_CONFIRMED",
    "WAIVED",
    "WRITTEN_OFF",
    "DISPUTED",
    "COLLECTION_PENDING"
  ])
  disposition!:
    | "OPEN"
    | "MANUAL_PAYMENT_CONFIRMED"
    | "WAIVED"
    | "WRITTEN_OFF"
    | "DISPUTED"
    | "COLLECTION_PENDING";
  @Trimmed(1, 180) idempotencyKey!: string;
  @Trimmed(1, 32) ownerType!: string;
  @IsOptional() @IsUUID("4") ownerId?: string | null;
  @IsOptional() @IsUUID("4") proofFileId?: string | null;
  @IsDefined() @IsObject() @Validate(ClosureJsonConstraint) detail!: Record<string, unknown>;
}

export class TransferClosureLegalCollectionDto {
  @IsUUID("4") billId!: string;
  @Matches(LOWERCASE_SHA256) evidencePackageHash!: string;
  @IsOptional() @Trimmed(1, 255) externalReference?: string | null;
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsUUID("4") ownerId!: string;
  @Trimmed(1, 32) ownerType!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) openedAt!: string;
}

export class RecordClosureLegalEventDto {
  @IsUUID("4") legalCaseId!: string;
  @IsIn([
    "NOTICE_SENT",
    "CLAIM_FILED",
    "JUDGMENT_RECORDED",
    "SETTLEMENT_RECORDED",
    "EXECUTION_RECEIVED",
    "CLOSED"
  ])
  eventType!:
    | "NOTICE_SENT"
    | "CLAIM_FILED"
    | "JUDGMENT_RECORDED"
    | "SETTLEMENT_RECORDED"
    | "EXECUTION_RECEIVED"
    | "CLOSED";
  @IsOptional()
  @Matches(CANONICAL_POSITIVE_INT64)
  @Validate(ClosureInt64Constraint)
  amountCents?: string | null;
  @IsDefined() @IsObject() @Validate(ClosureJsonConstraint) detail!: Record<string, unknown>;
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) occurredAt!: string;
  @IsOptional() @IsUUID("4") proofFileId?: string | null;
}

export class CompleteClosureOperationsDto {
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) occurredAt!: string;
}

export class ClosureEvidenceDto {
  @IsEnum(AssetWorkOrderEvidenceAction) action!: AssetWorkOrderEvidenceAction;
  @IsOptional() @IsISO8601({ strict: true, strictSeparator: true }) capturedAt?: string | null;
  @IsOptional() @IsObject() @Validate(ClosureJsonConstraint) captureMetadata?: Record<
    string,
    unknown
  > | null;
  @IsOptional() @Matches(LOWERCASE_SHA256) contentSha256?: string | null;
  @IsOptional() @IsUUID("4") eventId?: string | null;
  @IsEnum(AssetWorkOrderEvidenceType) evidenceType!: AssetWorkOrderEvidenceType;
  @IsOptional() @IsUUID("4") fileId?: string | null;
  @IsOptional() @IsUUID("4") supersedesEvidenceId?: string | null;
}

export class ClosureCostDto {
  @IsIn([VehicleCostActionType.ACTUAL_COST]) actionType!: VehicleCostActionType;
  @Matches(ACCOUNTING_PERIOD) accountingPeriod!: string;
  @Matches(CANONICAL_POSITIVE_INT64) @Validate(ClosureInt64Constraint) amountCents!: string;
  @IsOptional() @IsUUID("4") assetOwnerId?: string | null;
  @IsOptional() @IsObject() @Validate(ClosureJsonConstraint) assetOwnerSnapshot?: Record<
    string,
    unknown
  > | null;
  @IsEnum(VehicleCostCategory) costCategory!: VehicleCostCategory;
  @IsOptional() @IsUUID("4") evidenceId?: string | null;
  @IsOptional() @IsObject() @Validate(ClosureJsonConstraint) evidenceSnapshot?: Record<
    string,
    unknown
  > | null;
  @IsISO8601({ strict: true, strictSeparator: true }) occurredOn!: string;
  @Trimmed(1, 2000) reason!: string;
  @IsOptional() @IsUUID("4") responsiblePartyId?: string | null;
  @IsEnum(VehicleCostResponsiblePartyType) responsiblePartyType!: VehicleCostResponsiblePartyType;
  @IsDefined() @IsObject() @Validate(ClosureJsonConstraint) responsibilitySnapshot!: Record<
    string,
    unknown
  >;
  @IsISO8601({ strict: true, strictSeparator: true }) confirmedAt!: string;
}

export class ClosureInspectionDto {
  @IsBoolean() accepted!: boolean;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ClosureCostDto)
  costs!: ClosureCostDto[];
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ClosureEvidenceDto)
  evidence!: ClosureEvidenceDto[];
  @IsISO8601({ strict: true, strictSeparator: true }) occurredAt!: string;
  @IsBoolean() reconditioningRequired!: boolean;
}

export class ManagedSettlementDto {
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) occurredAt!: string;
  @IsOptional() @IsUUID("4") waiverApprovalId?: string | null;
  @IsOptional() @IsUUID("4") writeOffApprovalId?: string | null;
}

export class ReleaseClosureInventoryDto {
  @IsISO8601({ strict: true, strictSeparator: true }) occurredAt!: string;
  @Trimmed(1, 2000) releaseReason!: string;
}

export class RecoveryActionDto {
  @IsIn(["REJECT", "PAUSE", "RESUME", "CANCEL", "MANUAL_TAKEOVER"])
  action!: "REJECT" | "PAUSE" | "RESUME" | "CANCEL" | "MANUAL_TAKEOVER";
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) occurredAt!: string;
  @Trimmed(1, 2000) reason!: string;
}

export class RequestRecoveryApprovalDto {
  @Trimmed(1, 180) idempotencyKey!: string;
  @Trimmed(1, 2000) reason!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) requestedAt!: string;
}

export class DecideRecoveryApprovalDto {
  @IsIn(["APPROVED", "REJECTED"]) decision!: "APPROVED" | "REJECTED";
  @Trimmed(1, 2000) decisionComment!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) decidedAt!: string;
  @IsInt() @Min(0) expectedApprovalVersion!: number;
  @Trimmed(1, 180) idempotencyKey!: string;
}

export class ExecuteRecoveryDto {
  @IsUUID("4") approvalId!: string;
  @IsInt() @Min(0) expectedApprovalVersion!: number;
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) occurredAt!: string;
}

export class RecordRecoveryExecutionDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ClosureCostDto)
  costs!: ClosureCostDto[];
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ClosureEvidenceDto)
  evidence!: ClosureEvidenceDto[];
  @Trimmed(1, 180) idempotencyKey!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) occurredAt!: string;
}

export class EarlyTerminationEvidenceDto {
  @Trimmed(1, 512) reference!: string;
  @Trimmed(1, 64) type!: string;
}

export class InitiateEarlyTerminationDto {
  @IsISO8601({ strict: true, strictSeparator: true }) effectiveAt!: string;
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EarlyTerminationEvidenceDto)
  evidence!: EarlyTerminationEvidenceDto[];
  @Trimmed(1, 120) idempotencyKey!: string;
  @IsUUID("4") orderId!: string;
  @Trimmed(1, 2000) reason!: string;
}

export class CancelEarlyTerminationDto {
  @Trimmed(1, 120) idempotencyKey!: string;
  @Trimmed(1, 2000) reason!: string;
}

export class ExecuteEarlyTerminationDto {
  @Trimmed(1, 120) idempotencyKey!: string;
}

function jsonSafe(value: unknown, depth: number): boolean {
  if (depth > 32 || value === null || Array.isArray(value)) return false;
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((entry) => jsonValue(entry, depth + 1));
}

function jsonValue(value: unknown, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number")
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (depth > 32) return false;
  if (Array.isArray(value))
    return value.length <= 1000 && value.every((entry) => jsonValue(entry, depth + 1));
  return jsonSafe(value, depth);
}
