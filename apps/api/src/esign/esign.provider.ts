export const ESIGN_PROVIDER_CLIENT = Symbol("ESIGN_PROVIDER_CLIENT");

export interface CreateSignTaskInput {
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
  providerTaskId?: string;
  verified: boolean;
}

export interface ESignProvider {
  createSignTask(input: CreateSignTaskInput): Promise<CreateSignTaskResult>;
  getSignerUrl(input: GetSignerUrlInput): Promise<GetSignerUrlResult>;
  verifyCallback(payload: unknown, headers?: Record<string, unknown>): Promise<VerifyCallbackResult>;
}
