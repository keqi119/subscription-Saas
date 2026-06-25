export type FadadaEnv = "sandbox" | "production";

export type FadadaContentType =
  | "application/x-www-form-urlencoded;charset=UTF-8"
  | "multipart/form-data;charset=utf8";

export interface FadadaConfig {
  apiVersion: string;
  appId: string;
  appSecret: string;
  authPersonCustomerId?: string;
  baseUrl: string;
  enabled: boolean;
  env: FadadaEnv;
  platformCustomerId?: string;
  platformSignatureId?: string;
  requestTimeoutMs: number;
  signNotifyUrl?: string;
  signReturnUrl?: string;
  signUrlQuantity: number;
  signUrlValidityMinutes: number;
  verifyNotifyUrl?: string;
  verifyReturnUrl?: string;
}

export interface FadadaRequest {
  contentType: FadadaContentType;
  endpoint: FadadaEndpoint;
  method: "POST";
  params: Record<string, string>;
  url: string;
}

export type FadadaEndpoint =
  | "uploaddocs.api"
  | "extsign_validation.api"
  | "extsign.api"
  | "extsign_auto.api"
  | "query_sign_result.api"
  | "contract_status.api"
  | "downLoadContract.api"
  | "geturl.api"
  | "viewContract.api"
  | "contractFiling.api";

export interface BuildFadadaRequestInput {
  businessParams?: Record<string, unknown>;
  config: FadadaConfig;
  contentType?: FadadaContentType;
  endpoint: FadadaEndpoint;
  explicitMd5Seed?: string;
  explicitSortString?: string;
  timestamp?: string;
}

export interface FadadaCallbackPayload {
  contract_id?: unknown;
  download_url?: unknown;
  msg_digest?: unknown;
  result_code?: unknown;
  result_desc?: unknown;
  timestamp?: unknown;
  transaction_id?: unknown;
  viewpdf_url?: unknown;
}
