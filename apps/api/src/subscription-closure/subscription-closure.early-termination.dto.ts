import type { Prisma } from "@prisma/client";

export type EarlyTerminationEvidence = Readonly<{
  reference: string;
  type: string;
}>;

export type InitiateEarlyTerminationInput = Readonly<{
  actorId: string;
  effectiveAt: Date;
  evidence: readonly EarlyTerminationEvidence[];
  idempotencyKey: string;
  orderId: string;
  reason: string;
}>;

export type ArchiveEarlyTerminationAgreementInput = Readonly<{
  actorId: string;
  agreementContractId?: string;
  closureCaseId: string;
  idempotencyKey: string;
  providerTaskId?: string;
  syntheticTestEvidence?: true;
}>;

export type ExecuteEarlyTerminationInput = Readonly<{
  actorId: string;
  closureCaseId: string;
  idempotencyKey: string;
}>;

export type CancelEarlyTerminationInput = Readonly<{
  actorId: string;
  closureCaseId: string;
  idempotencyKey: string;
  reason: string;
}>;

export type ArchivedEarlyTerminationAgreement = Readonly<{
  archivedRevisionId: string;
  generatedRevisionId: string;
  signedFileHash: string;
  signedFileId: string;
  signedRevisionId: string;
  wrote: boolean;
}>;

export type InitiatedEarlyTermination = Readonly<{
  authoritySnapshotHash: string;
  closureCaseId: string;
  wrote: boolean;
}>;

export type CancelledEarlyTermination = Readonly<{
  closureCaseId: string;
  wrote: boolean;
}>;

export type ExecutedEarlyTermination =
  | Readonly<{
      closureCaseId: string;
      outcome: "AGREEMENT_STALE";
      wrote: boolean;
    }>
  | Readonly<{
      closureCaseId: string;
      returnAssetWorkOrderId: string;
      returnHandoverWorkOrderId: string;
      returnManifestRevisionId: string;
      vehicleReturnId: string;
      wrote: boolean;
    }>;

export type EarlyTerminationTransactionAdapter<T> = (
  tx: Prisma.TransactionClient,
  result: T
) => Promise<void> | void;
