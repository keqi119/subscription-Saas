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
  closureCaseId: string;
  idempotencyKey: string;
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
