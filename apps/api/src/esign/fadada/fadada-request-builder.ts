import { buildFadadaMsgDigest, buildFadadaMsgDigestFromParts, formatFadadaTimestamp } from "./fadada-digest";
import {
  BuildFadadaRequestInput,
  FadadaConfig,
  FadadaContentType,
  FadadaEndpoint,
  FadadaRequest
} from "./fadada.types";

const FORM_URLENCODED: FadadaContentType = "application/x-www-form-urlencoded;charset=UTF-8";
const MULTIPART_FORM: FadadaContentType = "multipart/form-data;charset=utf8";

export const FADADA_ENDPOINTS = {
  contractFiling: "contractFiling.api",
  contractStatus: "contract_status.api",
  downloadContract: "downLoadContract.api",
  extSign: "extsign.api",
  extSignAuto: "extsign_auto.api",
  extSignValidation: "extsign_validation.api",
  getUrl: "geturl.api",
  querySignResult: "query_sign_result.api",
  uploadDocs: "uploaddocs.api",
  viewContract: "viewContract.api"
} as const satisfies Record<string, FadadaEndpoint>;

export function buildFadadaRequest(input: BuildFadadaRequestInput): FadadaRequest {
  const timestamp = input.timestamp ?? formatFadadaTimestamp(new Date());
  const businessParams = stringifyParams(input.businessParams ?? {});
  // Fadada uses endpoint-specific digest formulas for several page/download APIs.
  // B1 only builds request metadata; B2 must confirm every endpoint formula before enabling real HTTP calls.
  const msgDigest = input.explicitMd5Seed
    ? buildFadadaMsgDigestFromParts({
        appId: input.config.appId,
        appSecret: input.config.appSecret,
        md5Seed: input.explicitMd5Seed,
        secretSortString: input.explicitSortString ?? ""
      })
    : buildFadadaMsgDigest({
        appId: input.config.appId,
        appSecret: input.config.appSecret,
        businessParams,
        explicitSortString: input.explicitSortString,
        timestamp
      });

  return {
    contentType: input.contentType ?? FORM_URLENCODED,
    endpoint: input.endpoint,
    method: "POST",
    params: {
      ...businessParams,
      app_id: input.config.appId,
      msg_digest: msgDigest,
      timestamp,
      v: input.config.apiVersion
    },
    url: buildEndpointUrl(input.config.baseUrl, input.endpoint)
  };
}

export function buildUploadDocsRequest(input: {
  businessParams: Record<string, unknown>;
  config: FadadaConfig;
  timestamp?: string;
}): FadadaRequest {
  return buildFadadaRequest({
    businessParams: input.businessParams,
    config: input.config,
    contentType: MULTIPART_FORM,
    endpoint: FADADA_ENDPOINTS.uploadDocs,
    timestamp: input.timestamp
  });
}

export function buildExtSignValidationRequest(input: {
  businessParams: Record<string, unknown>;
  config: FadadaConfig;
  explicitSortString?: string;
  timestamp?: string;
}): FadadaRequest {
  return buildFadadaRequest({
    businessParams: input.businessParams,
    config: input.config,
    endpoint: FADADA_ENDPOINTS.extSignValidation,
    explicitMd5Seed: extSignValidationMd5Seed(input.businessParams),
    explicitSortString: input.explicitSortString,
    timestamp: input.timestamp
  });
}

export function buildExtSignRequest(input: {
  businessParams: Record<string, unknown>;
  config: FadadaConfig;
  explicitSortString?: string;
  timestamp?: string;
}): FadadaRequest {
  return buildFadadaRequest({
    businessParams: input.businessParams,
    config: input.config,
    endpoint: FADADA_ENDPOINTS.extSign,
    explicitSortString: input.explicitSortString,
    timestamp: input.timestamp
  });
}

export function buildExtSignAutoRequest(input: {
  businessParams: Record<string, unknown>;
  config: FadadaConfig;
  explicitSortString?: string;
  timestamp?: string;
}): FadadaRequest {
  return buildFadadaRequest({
    businessParams: input.businessParams,
    config: input.config,
    endpoint: FADADA_ENDPOINTS.extSignAuto,
    explicitSortString: input.explicitSortString,
    timestamp: input.timestamp
  });
}

export function buildQuerySignResultRequest(input: {
  businessParams: Record<string, unknown>;
  config: FadadaConfig;
  explicitSortString?: string;
  timestamp?: string;
}): FadadaRequest {
  return buildFadadaRequest({
    businessParams: input.businessParams,
    config: input.config,
    endpoint: FADADA_ENDPOINTS.querySignResult,
    explicitSortString: input.explicitSortString,
    timestamp: input.timestamp
  });
}

export function buildContractStatusRequest(input: {
  businessParams: Record<string, unknown>;
  config: FadadaConfig;
  explicitSortString?: string;
  timestamp?: string;
}): FadadaRequest {
  return buildFadadaRequest({
    businessParams: input.businessParams,
    config: input.config,
    endpoint: FADADA_ENDPOINTS.contractStatus,
    explicitSortString: input.explicitSortString,
    timestamp: input.timestamp
  });
}

export function buildDownloadContractRequest(input: {
  businessParams: Record<string, unknown>;
  config: FadadaConfig;
  explicitSortString?: string;
  timestamp?: string;
}): FadadaRequest {
  return buildFadadaRequest({
    businessParams: input.businessParams,
    config: input.config,
    endpoint: FADADA_ENDPOINTS.downloadContract,
    explicitSortString: input.explicitSortString,
    timestamp: input.timestamp
  });
}

export function buildGetUrlRequest(input: {
  businessParams: Record<string, unknown>;
  config: FadadaConfig;
  explicitSortString?: string;
  timestamp?: string;
}): FadadaRequest {
  return buildFadadaRequest({
    businessParams: input.businessParams,
    config: input.config,
    endpoint: FADADA_ENDPOINTS.getUrl,
    explicitSortString: input.explicitSortString,
    timestamp: input.timestamp
  });
}

export function buildViewContractRequest(input: {
  businessParams: Record<string, unknown>;
  config: FadadaConfig;
  explicitSortString?: string;
  timestamp?: string;
}): FadadaRequest {
  return buildFadadaRequest({
    businessParams: input.businessParams,
    config: input.config,
    endpoint: FADADA_ENDPOINTS.viewContract,
    explicitSortString: input.explicitSortString,
    timestamp: input.timestamp
  });
}

export function buildContractFilingRequest(input: {
  businessParams: Record<string, unknown>;
  config: FadadaConfig;
  explicitSortString?: string;
  timestamp?: string;
}): FadadaRequest {
  return buildFadadaRequest({
    businessParams: input.businessParams,
    config: input.config,
    endpoint: FADADA_ENDPOINTS.contractFiling,
    explicitSortString: input.explicitSortString,
    timestamp: input.timestamp
  });
}

function buildEndpointUrl(baseUrl: string, endpoint: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint}`;
}

function stringifyParams(params: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)])
  );
}

function extSignValidationMd5Seed(params: Record<string, unknown>) {
  const transactionId = params.transaction_id;
  const timestamp = params.timestamp;
  const validity = params.validity;
  const quantity = params.quantity;

  if (
    transactionId === undefined ||
    timestamp === undefined ||
    validity === undefined ||
    quantity === undefined
  ) {
    return undefined;
  }

  return `${transactionId}${timestamp}${validity}${quantity}`;
}
