import {
  CreateSignTaskInput,
  CreateSignTaskResult,
  ESignProvider,
  GetSignerUrlInput,
  GetSignerUrlResult,
  VerifyCallbackResult
} from "../esign.provider";
import { ContractPdfArtifactService } from "../contract-pdf-artifact.service";
import { PrismaService } from "../../prisma/prisma.service";
import { FadadaApiClient } from "./fadada-api.client";
import { verifyFadadaCallbackDigest } from "./fadada-digest";
import { FadadaConfig, FadadaSignCallbackPayload } from "./fadada.types";

export const FADADA_PROVIDER_STAGE_B2_REQUIRED = "FADADA_PROVIDER_STAGE_B2_REQUIRED";
export const FADADA_SIGN_URL_STAGE_B2_REQUIRED = "FADADA_SIGN_URL_STAGE_B2_REQUIRED";
export const FADADA_PROVIDER_DEPENDENCY_MISSING = "FADADA_PROVIDER_DEPENDENCY_MISSING";
export const FADADA_SIGN_URL_NOT_AVAILABLE = "FADADA_SIGN_URL_NOT_AVAILABLE";

export class FadadaESignProvider implements ESignProvider {
  readonly providerType = "FADADA";

  constructor(
    private readonly config: FadadaConfig,
    private readonly apiClient?: FadadaApiClient,
    private readonly pdfArtifactService?: ContractPdfArtifactService,
    private readonly prisma?: PrismaService
  ) {}

  async createSignTask(input: CreateSignTaskInput): Promise<CreateSignTaskResult> {
    if (!this.apiClient || !this.pdfArtifactService) {
      throw new Error(`${FADADA_PROVIDER_DEPENDENCY_MISSING}: Fadada B2-A dependencies are not wired`);
    }

    const artifact = await this.pdfArtifactService.getContractPdfArtifact(input.contractId);
    const providerContractId = input.taskNo;
    const customerSigner = input.signers.find((signer) => signer.signerType === "CUSTOMER");
    if (!customerSigner?.customerId) {
      throw new Error("FADADA_CUSTOMER_SIGNER_MISSING: customer signer is required");
    }

    const uploadResult = await this.apiClient.uploadDocs({
      contractId: providerContractId,
      docTitle: input.documentName,
      fileName: artifact.fileName,
      pdf: artifact.buffer
    });
    const transactionId = buildTransactionId(input.taskNo, 1);
    const signUrlResult = await this.apiClient.createExternalSignUrl({
      contractId: providerContractId,
      customerId: customerSigner.customerId,
      docTitle: input.documentName,
      notifyUrl: input.callbackUrl ?? this.config.signNotifyUrl ?? "",
      quantity: this.config.signUrlQuantity,
      returnUrl: input.redirectUrl ?? this.config.signReturnUrl ?? "",
      signerMobile: customerSigner.phone,
      signerName: customerSigner.name,
      transactionId,
      validityMinutes: this.config.signUrlValidityMinutes
    });

    return {
      documentObjectKey: artifact.objectKey,
      providerEnvelopeId: providerContractId,
      providerTaskId: transactionId,
      rawResponse: {
        artifact: {
          fileName: artifact.fileName,
          objectKey: artifact.objectKey,
          size: artifact.size,
          source: artifact.source
        },
        signUrl: signUrlResult.raw,
        upload: uploadResult.raw
      },
      signUrl: signUrlResult.signUrl,
      signUrlExpiresAt: signUrlResult.signUrlExpiresAt,
      signers: [{
        customerId: customerSigner.customerId,
        providerSignerId: transactionId,
        signUrl: signUrlResult.signUrl,
        signUrlExpiresAt: signUrlResult.signUrlExpiresAt,
        signerType: "CUSTOMER"
      }]
    };
  }

  async getSignerUrl(input: GetSignerUrlInput): Promise<GetSignerUrlResult> {
    if (!this.prisma || !input.taskId) {
      throw new Error(`${FADADA_SIGN_URL_NOT_AVAILABLE}: no local signer lookup context`);
    }

    const signer = await this.prisma.contractESignSigner.findFirst({
      where: {
        deletedAt: null,
        ...(input.signerId ? { id: input.signerId } : {}),
        taskId: input.taskId
      }
    });

    if (!signer?.signUrl || isExpired(signer.signUrlExpiresAt)) {
      throw new Error(`${FADADA_SIGN_URL_NOT_AVAILABLE}: no non-expired local Fadada signer URL`);
    }

    return {
      expiresAt: signer.signUrlExpiresAt ?? undefined,
      rawResponse: {
        providerSignerId: signer.providerSignerId,
        source: "LOCAL_SIGNER_URL"
      },
      signUrl: signer.signUrl
    };
  }

  async verifyCallback(payload: unknown): Promise<VerifyCallbackResult> {
    const record = normalizeCallbackPayload(payload);
    const transactionId = stringOrUndefined(record.transaction_id);
    const providerContractId = stringOrUndefined(record.contract_id);
    const timestamp = stringOrUndefined(record.timestamp);
    const receivedMsgDigest = stringOrUndefined(record.msg_digest);
    const resultCode = stringOrUndefined(record.result_code);
    const resultDescription = stringOrUndefined(record.result_desc);
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
      eventType: mapFadadaResultCode(resultCode),
      payload: sanitizeCallbackPayload(record),
      providerContractId,
      providerTaskId: transactionId,
      resultCode,
      resultDescription,
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
      return resultCode ? "FADADA_SIGN_UNKNOWN" : undefined;
  }
}

function normalizeCallbackPayload(value: unknown): FadadaSignCallbackPayload {
  if (value instanceof URLSearchParams) {
    return Object.fromEntries(value.entries());
  }
  if (typeof value === "string") {
    return Object.fromEntries(new URLSearchParams(value).entries());
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      Array.isArray(item) ? item[0] : item
    ])
  ) as FadadaSignCallbackPayload;
}

function sanitizeCallbackPayload(payload: FadadaSignCallbackPayload): FadadaSignCallbackPayload {
  return {
    ...payload,
    ...(payload.download_url ? { download_url: "[redacted-url]" } : {}),
    ...(payload.viewpdf_url ? { viewpdf_url: "[redacted-url]" } : {})
  };
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function buildTransactionId(taskNo: string, index: number) {
  return `${taskNo}-${index}`;
}

function isExpired(value: Date | null | undefined) {
  return value ? value.getTime() <= Date.now() : false;
}
