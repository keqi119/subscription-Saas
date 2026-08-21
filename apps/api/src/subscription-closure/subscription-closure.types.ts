import type {
  SubscriptionClosureDocumentStage,
  SubscriptionClosureDocumentType,
  SubscriptionClosureEventType,
  SubscriptionClosureFinalDisposition,
  SubscriptionClosurePhysicalControlMode,
  SubscriptionClosureSettlementStage,
  SubscriptionClosureSettlementType,
  SubscriptionClosureStatus,
  SubscriptionClosureType
} from "@prisma/client";

export type SubscriptionClosureSource = Readonly<{
  type: string;
  id: string;
  key: string;
}>;

export type SubscriptionClosureSnapshotValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | Date
  | SubscriptionClosureSnapshotObject
  | readonly SubscriptionClosureSnapshotValue[]
  | undefined;

export type SubscriptionClosureSnapshotObject = Readonly<{
  [key: string]: SubscriptionClosureSnapshotValue;
}>;

export type SubscriptionClosureJsonValue =
  | null
  | boolean
  | number
  | string
  | SubscriptionClosureJsonObject
  | readonly SubscriptionClosureJsonValue[];

export type SubscriptionClosureJsonObject = Readonly<{
  [key: string]: SubscriptionClosureJsonValue;
}>;

export interface SubscriptionClosureProfile {
  readonly closureType: SubscriptionClosureType;
  readonly physicalControlMode: SubscriptionClosurePhysicalControlMode;
  readonly finalDisposition: SubscriptionClosureFinalDisposition;
}

export interface SubscriptionClosureCaseSnapshot extends SubscriptionClosureProfile {
  readonly id: string;
  readonly caseNo: string;
  readonly orderId: string;
  readonly vehicleId: string;
  readonly customerId: string;
  readonly contractId: string;
  readonly vehicleReturnId: string | null;
  readonly returnHandoverWorkOrderId: string | null;
  readonly returnAssetWorkOrderId: string | null;
  readonly recoveryAssetWorkOrderId: string | null;
  readonly reconditioningAssetWorkOrderId: string | null;
  readonly status: SubscriptionClosureStatus;
  readonly authoritySnapshot: SubscriptionClosureJsonObject;
  readonly authoritySnapshotHash: string;
  readonly effectiveAt: string;
  readonly physicalControlledAt: string | null;
  readonly settledAt: string | null;
  readonly closedAt: string | null;
  readonly currentSettlementRevisionId: string | null;
  readonly version: number;
  readonly createSource: SubscriptionClosureSource;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentDocuments: Readonly<
    Partial<Record<SubscriptionClosureDocumentType, SubscriptionClosureDocumentSnapshot>>
  >;
  readonly currentSettlement: SubscriptionClosureSettlementSnapshot | null;
}

export interface SubscriptionClosureEventSnapshot {
  readonly id: string;
  readonly closureCaseId: string;
  readonly sequence: number;
  readonly eventType: SubscriptionClosureEventType;
  readonly beforeStatus: SubscriptionClosureStatus | null;
  readonly afterStatus: SubscriptionClosureStatus;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly source: SubscriptionClosureSource;
  readonly detailSnapshot: SubscriptionClosureJsonObject;
}

export interface SubscriptionClosureDocumentSnapshot {
  readonly id: string;
  readonly closureCaseId: string;
  readonly revisionNumber: number;
  readonly documentType: SubscriptionClosureDocumentType;
  readonly stage: SubscriptionClosureDocumentStage;
  readonly documentSnapshot: SubscriptionClosureJsonObject;
  readonly documentSnapshotHash: string;
  readonly vehicleReturnId: string | null;
  readonly handoverWorkOrderId: string | null;
  readonly contractESignTaskId: string;
  readonly sourceFileId: string;
  readonly sourceFileHash: string;
  readonly signedFileId: string | null;
  readonly signedFileHash: string | null;
  readonly supersedesRevisionId: string | null;
  readonly source: SubscriptionClosureSource;
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly archivedBy: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
}

export interface SubscriptionClosureSettlementSnapshot {
  readonly id: string;
  readonly closureCaseId: string;
  readonly revisionNumber: number;
  readonly settlementType: SubscriptionClosureSettlementType;
  readonly stage: SubscriptionClosureSettlementStage;
  readonly ledgerInputSnapshot: SubscriptionClosureJsonObject;
  readonly billInputSnapshot: SubscriptionClosureJsonObject;
  readonly depositInputSnapshot: SubscriptionClosureJsonObject;
  readonly responsibilitySnapshot: SubscriptionClosureJsonObject;
  readonly waiverApprovalId: string | null;
  readonly writeOffApprovalId: string | null;
  readonly inputSnapshotHash: string;
  readonly costTotalCents: string;
  readonly receivableTotalCents: string;
  readonly paidTotalCents: string;
  readonly writeOffTotalCents: string;
  readonly waiverTotalCents: string;
  readonly depositAppliedCents: string;
  readonly depositRefundCents: string;
  readonly amountDueCents: string;
  readonly amountRefundableCents: string;
  readonly resultSnapshot: SubscriptionClosureJsonObject;
  readonly resultHash: string;
  readonly supersedesRevisionId: string | null;
  readonly source: SubscriptionClosureSource;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly finalizedBy: string | null;
  readonly finalizedAt: string | null;
  readonly settledBy: string | null;
  readonly settledAt: string | null;
}

export interface SubscriptionClosureWriteOutcome<T extends object> {
  readonly outcome: T;
  readonly wrote: boolean;
}
