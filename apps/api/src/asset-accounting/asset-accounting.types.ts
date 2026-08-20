import type {
  BusinessExceptionApprovalStatus,
  BusinessExceptionDecision,
  BusinessExceptionSubjectType,
  BusinessExceptionType,
  VehicleCostActionType,
  VehicleCostCategory,
  VehicleCostEntryKind,
  VehicleCostResponsiblePartyType
} from "@prisma/client";

/** The immutable source identity shared by all asset-accounting commands. */
export type AssetAccountingSource = Readonly<{
  type: string;
  id: string;
  key: string;
}>;

/**
 * Values accepted by the canonical snapshot encoder.  Dates and BigInts are
 * deliberately retained here so that callers cannot silently lose precision
 * before hashing or projecting a persisted fact.
 */
export type AssetAccountingSnapshotValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | Date
  | AssetAccountingSnapshotObject
  | readonly AssetAccountingSnapshotValue[]
  | undefined;

export type AssetAccountingSnapshotObject = Readonly<{
  [key: string]: AssetAccountingSnapshotValue;
}>;

export type BusinessExceptionSnapshot = AssetAccountingSnapshotObject;

/** Public, traceable projection of an immutable vehicle cost fact. */
export interface VehicleCostLedgerEntrySnapshot {
  readonly id: string;
  readonly vehicleId: string;
  readonly orderId?: string | null;
  readonly contractId?: string | null;
  readonly customerId?: string | null;
  readonly assetOwnerId?: string | null;
  readonly workOrderId?: string | null;
  readonly evidenceId?: string | null;
  readonly assetOwnerSnapshot?: AssetAccountingSnapshotValue;
  readonly evidenceSnapshot?: AssetAccountingSnapshotValue;
  readonly responsibilitySnapshot?: AssetAccountingSnapshotValue;
  readonly entryKind: VehicleCostEntryKind;
  readonly actionType: VehicleCostActionType;
  readonly costCategory: VehicleCostCategory;
  readonly amountCents: bigint;
  readonly responsiblePartyType: VehicleCostResponsiblePartyType;
  readonly responsiblePartyId?: string | null;
  readonly occurredOn: Date;
  readonly accountingPeriod: string;
  readonly confirmedAt: Date;
  readonly confirmedBy: string;
  readonly reversalOfEntryId?: string | null;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceKey: string;
}

export interface VehicleCostSummaryBucket {
  readonly amountCents: bigint;
  readonly count: number;
}

export interface VehicleCostLedgerSummary {
  readonly totalAmountCents: bigint;
  readonly byActionType: Readonly<Record<VehicleCostActionType, VehicleCostSummaryBucket>>;
  readonly byResponsibility: Readonly<
    Record<VehicleCostResponsiblePartyType, VehicleCostSummaryBucket>
  >;
  readonly byResponsibleParty: Readonly<Record<string, VehicleCostSummaryBucket>>;
  readonly byCategory: Readonly<Record<VehicleCostCategory, VehicleCostSummaryBucket>>;
}

export interface BusinessExceptionApprovalSnapshot {
  readonly id: string;
  readonly approvalNo: string;
  readonly exceptionType: BusinessExceptionType;
  readonly subjectType: BusinessExceptionSubjectType;
  readonly subjectId: string;
  readonly subjectField: string;
  readonly subjectSnapshot: BusinessExceptionSnapshot;
  readonly subjectSnapshotHash: string;
  readonly requestReason: string;
  readonly requestEvidenceSnapshot?: AssetAccountingSnapshotValue;
  readonly status: BusinessExceptionApprovalStatus;
  readonly version: number;
  readonly decision?: BusinessExceptionDecision | null;
  readonly decisionComment?: string | null;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly requestSourceType: string;
  readonly requestSourceId: string;
  readonly requestSourceKey: string;
  readonly decidedBy?: string | null;
  readonly decidedAt?: Date | null;
  readonly expiryReason?: string | null;
  readonly expiredBy?: string | null;
  readonly expiredAt?: Date | null;
}
