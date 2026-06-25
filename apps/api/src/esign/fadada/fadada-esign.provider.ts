import {
  CreateSignTaskInput,
  CreateSignTaskResult,
  ESignProvider,
  GetSignerUrlInput,
  GetSignerUrlResult,
  VerifyCallbackResult
} from "../esign.provider";
import { verifyFadadaCallbackDigest } from "./fadada-digest";
import { FadadaCallbackPayload, FadadaConfig } from "./fadada.types";

export const FADADA_PROVIDER_STAGE_B2_REQUIRED = "FADADA_PROVIDER_STAGE_B2_REQUIRED";
export const FADADA_SIGN_URL_STAGE_B2_REQUIRED = "FADADA_SIGN_URL_STAGE_B2_REQUIRED";

export class FadadaESignProvider implements ESignProvider {
  readonly providerType = "FADADA";

  constructor(private readonly config: FadadaConfig) {}

  async createSignTask(_input: CreateSignTaskInput): Promise<CreateSignTaskResult> {
    void _input;
    throw new Error(`${FADADA_PROVIDER_STAGE_B2_REQUIRED}: 法大大真实签署创建将在 Stage 10D-B2 接入`);
  }

  async getSignerUrl(_input: GetSignerUrlInput): Promise<GetSignerUrlResult> {
    void _input;
    throw new Error(`${FADADA_SIGN_URL_STAGE_B2_REQUIRED}: 法大大签署链接获取将在 Stage 10D-B2 接入`);
  }

  async verifyCallback(payload: unknown): Promise<VerifyCallbackResult> {
    const record = asRecord(payload) as FadadaCallbackPayload & Record<string, unknown>;
    const transactionId = stringOrUndefined(record.transaction_id);
    const timestamp = stringOrUndefined(record.timestamp);
    const receivedMsgDigest = stringOrUndefined(record.msg_digest);
    const verified =
      Boolean(transactionId && timestamp && receivedMsgDigest) &&
      verifyFadadaCallbackDigest({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        businessParams: record,
        explicitSortString: transactionId,
        receivedMsgDigest: receivedMsgDigest ?? "",
        timestamp: timestamp ?? ""
      });

    return {
      eventType: mapFadadaResultCode(stringOrUndefined(record.result_code)),
      payload,
      providerTaskId: transactionId,
      verified
    };
  }
}

function mapFadadaResultCode(resultCode: string | undefined) {
  switch (resultCode) {
    case "3000":
      return "FADADA_SIGN_COMPLETED";
    case "3001":
      return "FADADA_SIGN_FAILED";
    case "3003":
      return "FADADA_SIGN_REJECTED";
    default:
      return resultCode ? `FADADA_SIGN_${resultCode}` : undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
