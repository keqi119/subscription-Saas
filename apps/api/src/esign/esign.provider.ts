import type { ApprovedSigningPlanRef } from "./enterprise-seal/enterprise-seal.types";

export const ESIGN_PROVIDER_CLIENT = Symbol("ESIGN_PROVIDER_CLIENT");

export type ESignSigningStage = "STAGE1_CONTRACT";
export type ESignDocumentType = "CONTRACT_BODY" | "ATTACHMENT1_SUBSCRIPTION_PLAN";
export type ESignSlotId =
  | "STAGE1_BODY_CUSTOMER"
  | "STAGE1_BODY_PLATFORM"
  | "STAGE1_ATTACHMENT1_CUSTOMER"
  | "STAGE1_ATTACHMENT1_PLATFORM";
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
  redirectUrl?: string;
  signers: Array<{
    customerId?: string;
    name?: string;
    phone?: string;
    signerType: "CUSTOMER" | "PLATFORM";
  }>;
  signingSlots?: ESignSigningSlot[];
  signingSlotCoordinates?: ESignSigningSlotCoordinate[];
  signingStage?: ESignSigningStage;
  taskId?: string;
  taskNo: string;
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
  taskId?: string;
}

export interface GetSignerUrlResult {
  expiresAt?: Date;
  rawResponse?: unknown;
  signUrl: string;
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
  placement?: AutoSealPlacement;
  platformCustomerId?: string;
  platformSignatureId?: string;
  providerEnvelopeId?: string;
  sealId?: string;
  taskId?: string;
  taskNo: string;
  transactionId: string;
}

export interface AutoSealTaskResult {
  providerSignerId?: string;
  rawResponse?: unknown;
  resultCode?: string;
  resultDescription?: string;
  status: "COMPLETED" | "PENDING" | "FAILED";
}

export interface ESignProvider {
  autoSealTask?(input: AutoSealTaskInput): Promise<AutoSealTaskResult>;
  createSignTask(input: CreateSignTaskInput): Promise<CreateSignTaskResult>;
  getSignerUrl(input: GetSignerUrlInput): Promise<GetSignerUrlResult>;
  verifyCallback(payload: unknown, headers?: Record<string, unknown>): Promise<VerifyCallbackResult>;
}
