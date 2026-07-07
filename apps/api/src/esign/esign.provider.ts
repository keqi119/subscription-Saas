import type { ApprovedSigningPlanRef } from "./enterprise-seal/enterprise-seal.types";

export const ESIGN_PROVIDER_CLIENT = Symbol("ESIGN_PROVIDER_CLIENT");

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
  taskId?: string;
  taskNo: string;
}

export interface CreateSignTaskResult {
  documentObjectKey?: string;
  providerEnvelopeId?: string;
  providerTaskId: string;
  rawResponse?: unknown;
  signUrl?: string;
  signUrlExpiresAt?: Date;
  signers?: Array<{
    customerId?: string;
    providerSignerId?: string;
    signUrl?: string;
    signUrlExpiresAt?: Date;
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

export interface AutoSealTaskInput {
  callbackUrl?: string;
  contractId: string;
  documentName?: string;
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
