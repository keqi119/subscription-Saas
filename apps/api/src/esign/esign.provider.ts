import type { ApprovedSigningPlanRef } from "./enterprise-seal/enterprise-seal.types";

export const ESIGN_PROVIDER_CLIENT = Symbol("ESIGN_PROVIDER_CLIENT");

export type ESignSigningStage =
  | "STAGE1_CONTRACT"
  | "STAGE2_DELIVERY_HANDOVER"
  | "STAGE6_RETURN_MANIFEST";
export type ESignDocumentType =
  | "CONTRACT_BODY"
  | "ATTACHMENT1_SUBSCRIPTION_PLAN"
  | "DELIVERY_HANDOVER"
  | "RETURN_MANIFEST";
export type ESignSlotId =
  | "STAGE1_BODY_CUSTOMER"
  | "STAGE1_BODY_PLATFORM"
  | "STAGE1_ATTACHMENT1_CUSTOMER"
  | "STAGE1_ATTACHMENT1_PLATFORM"
  | "STAGE2_HANDOVER_CUSTOMER"
  | "STAGE2_HANDOVER_PLATFORM"
  | "RETURN_MANIFEST_CUSTOMER"
  | "RETURN_MANIFEST_PLATFORM";
export type ESignSignerRole = "CUSTOMER" | "PLATFORM";
export type ESignProviderActionType = "CUSTOMER_MANUAL_SIGN" | "PLATFORM_AUTO_SEAL";

export interface ESignSigningSlot {
  documentType: ESignDocumentType;
  keyx?: string;
  keyy?: string;
  keyword: string;
  positionType?: "KEYWORD" | "COORDINATE";
  providerActionType: ESignProviderActionType;
  required?: boolean;
  signerRole: ESignSignerRole;
  signingStage: ESignSigningStage;
  slotId: ESignSlotId;
}

export interface ESignSigningSlotCoordinate {
  pageNumber: number;
  slotId: ESignSlotId;
  x: number;
  y: number;
}

export interface ESignProviderActionResult {
  coveredSlotIds?: ESignSlotId[];
  providerActionType?: ESignProviderActionType;
  providerSignerId?: string;
  providerTransactionId?: string;
  signUrl?: string;
  signUrlExpiresAt?: Date;
  signerType?: ESignSignerRole;
  signingStage?: ESignSigningStage;
}

export interface CreateSignTaskInput {
  approvedSigningPlan?: ApprovedSigningPlanRef;
  callbackUrl?: string;
  contractId: string;
  documentName: string;
  documentType?: ESignDocumentType;
  redirectUrl?: string;
  signers: Array<{
    customerId?: string;
    name?: string;
    phone?: string;
    signerId?: string;
    signerType: "CUSTOMER" | "PLATFORM";
  }>;
  signingSlots?: ESignSigningSlot[];
  /**
   * Stage 2 customer signing uses persisted artifact coordinates as the source
   * of truth. When supplied, this must contain exactly the matching customer
   * coordinate and acts only as a fail-closed consistency assertion.
   */
  signingSlotCoordinates?: ESignSigningSlotCoordinate[];
  signingStage?: ESignSigningStage;
  sourcePdfHash?: string;
  taskId?: string;
  taskNo: string;
  transactionId?: string;
}

export interface CreateSignTaskResult {
  documentObjectKey?: string;
  providerEnvelopeId?: string;
  providerTaskId: string;
  rawResponse?: unknown;
  actions?: ESignProviderActionResult[];
  signUrl?: string;
  signUrlExpiresAt?: Date;
  signers?: Array<{
    coveredSlotIds?: ESignSlotId[];
    customerId?: string;
    documentType?: ESignDocumentType;
    providerActionType?: ESignProviderActionType;
    providerCustomerId?: string;
    providerSignerId?: string;
    providerTransactionId?: string;
    signUrl?: string;
    signUrlExpiresAt?: Date;
    signingStage?: ESignSigningStage;
    slotId?: ESignSlotId;
    signerType: "CUSTOMER" | "PLATFORM";
  }>;
}

export interface GetSignerUrlInput {
  contractId?: string;
  providerTaskId: string;
  redirectUrl?: string;
  signerId?: string;
  signingStage: ESignSigningStage;
  taskId?: string;
}

export interface GetSignerUrlResult {
  expiresAt?: Date;
  rawResponse?: unknown;
  signUrl: string;
}

export interface QuerySignerStatusInput {
  contractId: string;
  providerCustomerId: string;
  providerTaskId: string;
  providerTransactionId: string;
  signerId: string;
  slotId: ESignSlotId;
  taskId: string;
}

export interface ESignProviderSignerStatusResult {
  providerRecordAbsent?: boolean;
  resultCode?: string;
  resultDescription?: string;
  status: "SIGNED" | "SIGNING" | "FAILED" | "UNKNOWN";
}

export interface VerifyCallbackResult {
  eventType?: string;
  payload: unknown;
  providerContractId?: string;
  providerTaskId?: string;
  resultCode?: string;
  resultDescription?: string;
  verified: boolean;
}

export interface ReturnManifestProviderTaskInput {
  callbackUrl?: string;
  contractId: string;
  customer: {
    customerId: string;
    name: string;
    phone: string;
    signerId: string;
  };
  documentName: string;
  providerSourcePdf: {
    buffer: Buffer;
    fileName: string;
    sha256: string;
  };
  taskId: string;
  taskNo: string;
  transactionId: string;
}

export interface ReturnManifestProviderTaskResult {
  customer: {
    providerCustomerId: string;
    providerSignerId: string;
    providerTransactionId: string;
    signUrl?: string;
    signUrlExpiresAt?: Date;
  };
  providerEnvelopeId: string;
  providerTaskId: string;
  rawResponse?: unknown;
}

export interface CompleteReturnManifestProviderTaskInput {
  contractId: string;
  customer: {
    providerCustomerId: string;
    providerTransactionId: string;
    signerId: string;
  };
  documentName: string;
  platform: { signerId: string; transactionId: string };
  providerEnvelopeId: string;
  providerTaskId: string;
  providerSourcePdf: Buffer;
  taskId: string;
  taskNo: string;
}

export interface CompleteReturnManifestProviderTaskResult {
  customer: {
    providerTransactionId: string;
    resultCode?: string;
    resultDescription?: string;
  };
  platform: {
    providerSignerId: string;
    providerTransactionId: string;
    resultCode?: string;
    resultDescription?: string;
  };
  rawResponse?: unknown;
  signedPdf: { buffer: Buffer; contentType: "application/pdf"; fileName: string };
}

export interface AutoSealKeywordPlacement {
  keyx?: string;
  keyy?: string;
  keyword: string;
  keywordStrategy?: "0" | "1" | "2" | "3";
  searchIndex?: string;
  type: "KEYWORD";
}

export type AutoSealPlacement = AutoSealKeywordPlacement;

export interface AutoSealTaskInput {
  callbackUrl?: string;
  contractId: string;
  documentName?: string;
  documentType?: ESignDocumentType;
  placement?: AutoSealPlacement;
  platformCustomerId?: string;
  platformSignatureId?: string;
  providerEnvelopeId?: string;
  providerTaskId?: string;
  sealId?: string;
  signerId?: string;
  signingSlotCoordinates?: ESignSigningSlotCoordinate[];
  signingSlots?: ESignSigningSlot[];
  signingStage?: ESignSigningStage;
  taskId?: string;
  taskNo: string;
  transactionId: string;
}

export interface AutoSealTaskResult {
  coveredSlotIds?: ESignSlotId[];
  providerActionType?: ESignProviderActionType;
  providerSignerId?: string;
  providerTransactionId?: string;
  rawResponse?: unknown;
  resultCode?: string;
  resultDescription?: string;
  signingStage?: ESignSigningStage;
  status: "COMPLETED" | "PENDING" | "FAILED";
}

export interface CancelReturnManifestProviderTaskInput {
  providerEnvelopeId: string;
  providerTaskId: string;
  taskId: string;
  taskNo: string;
}

export interface CancelReturnManifestProviderTaskResult {
  cancelled: boolean;
  rawResponse?: unknown;
  replayed?: boolean;
}

export interface ESignProvider {
  autoSealTask?(input: AutoSealTaskInput): Promise<AutoSealTaskResult>;
  completeReturnManifestTask?(
    input: CompleteReturnManifestProviderTaskInput
  ): Promise<CompleteReturnManifestProviderTaskResult>;
  cancelReturnManifestTask?(
    input: CancelReturnManifestProviderTaskInput
  ): Promise<CancelReturnManifestProviderTaskResult>;
  createReturnManifestTask?(
    input: ReturnManifestProviderTaskInput
  ): Promise<ReturnManifestProviderTaskResult>;
  reconcileReturnManifestTask?(
    input: ReturnManifestProviderTaskInput
  ): Promise<ReturnManifestProviderTaskResult | null>;
  createSignTask(input: CreateSignTaskInput): Promise<CreateSignTaskResult>;
  getSignerUrl(input: GetSignerUrlInput): Promise<GetSignerUrlResult>;
  querySignerStatus(input: QuerySignerStatusInput): Promise<ESignProviderSignerStatusResult>;
  verifyCallback(
    payload: unknown,
    headers?: Record<string, unknown>
  ): Promise<VerifyCallbackResult>;
}
