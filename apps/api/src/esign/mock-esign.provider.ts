import { ConfigService } from "@nestjs/config";

import {
  AutoSealTaskInput,
  AutoSealTaskResult,
  CreateSignTaskInput,
  CreateSignTaskResult,
  ESignProvider,
  GetSignerUrlInput,
  GetSignerUrlResult,
  VerifyCallbackResult
} from "./esign.provider";

export class MockESignProvider implements ESignProvider {
  constructor(private readonly configService: ConfigService) {}

  async createSignTask(input: CreateSignTaskInput): Promise<CreateSignTaskResult> {
    if (input.signingStage === "STAGE2_DELIVERY_HANDOVER") {
      const transactionId = requireMockTransactionId(input.transactionId);
      requireStage2MockSlot(
        input.documentType,
        input.signingSlots,
        "STAGE2_HANDOVER_CUSTOMER",
        "CUSTOMER",
        "CUSTOMER_MANUAL_SIGN"
      );
      if (!input.sourcePdfHash || !/^[a-f0-9]{64}$/i.test(input.sourcePdfHash)) {
        throw new Error("MOCK_STAGE2_SOURCE_HASH_INVALID");
      }
      const expiresAt = this.signUrlExpiresAt();
      const signUrl = this.buildMockSignUrl(input.contractId, input.taskId);
      return {
        actions: [{
          coveredSlotIds: ["STAGE2_HANDOVER_CUSTOMER"],
          providerActionType: "CUSTOMER_MANUAL_SIGN",
          providerSignerId: transactionId,
          providerTransactionId: transactionId,
          signUrl,
          signUrlExpiresAt: expiresAt,
          signerType: "CUSTOMER",
          signingStage: "STAGE2_DELIVERY_HANDOVER"
        }],
        providerEnvelopeId: input.taskNo,
        providerTaskId: transactionId,
        rawResponse: {
          mock: true,
          signingStage: "STAGE2_DELIVERY_HANDOVER"
        },
        signUrl,
        signUrlExpiresAt: expiresAt,
        signers: [{
          coveredSlotIds: ["STAGE2_HANDOVER_CUSTOMER"],
          customerId: input.signers.find(
            (signer) => signer.signerType === "CUSTOMER"
          )?.customerId,
          documentType: "DELIVERY_HANDOVER",
          providerActionType: "CUSTOMER_MANUAL_SIGN",
          providerSignerId: transactionId,
          providerTransactionId: transactionId,
          signUrl,
          signUrlExpiresAt: expiresAt,
          signerType: "CUSTOMER",
          signingStage: "STAGE2_DELIVERY_HANDOVER",
          slotId: "STAGE2_HANDOVER_CUSTOMER"
        }]
      };
    }

    const expiresAt = this.signUrlExpiresAt();
    const signUrl = this.buildMockSignUrl(input.contractId, input.taskId);

    return {
      providerTaskId: `mock_${input.taskNo}`,
      rawResponse: {
        mock: true,
        signUrl
      },
      signUrl,
      signUrlExpiresAt: expiresAt
    };
  }

  async autoSealTask(input: AutoSealTaskInput): Promise<AutoSealTaskResult> {
    if (input.signingStage !== "STAGE2_DELIVERY_HANDOVER") {
      throw new Error("ESIGN_PLATFORM_AUTO_SEAL_UNSUPPORTED");
    }
    const transactionId = requireMockTransactionId(input.transactionId);
    requireStage2MockSlot(
      input.documentType,
      input.signingSlots,
      "STAGE2_HANDOVER_PLATFORM",
      "PLATFORM",
      "PLATFORM_AUTO_SEAL"
    );
    return {
      coveredSlotIds: ["STAGE2_HANDOVER_PLATFORM"],
      providerActionType: "PLATFORM_AUTO_SEAL",
      providerSignerId: transactionId,
      providerTransactionId: transactionId,
      rawResponse: {
        mock: true,
        signingStage: "STAGE2_DELIVERY_HANDOVER"
      },
      resultCode: "MOCK_COMPLETED",
      resultDescription: "Mock Stage 2 platform seal completed.",
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      status: "COMPLETED"
    };
  }

  async getSignerUrl(input: GetSignerUrlInput): Promise<GetSignerUrlResult> {
    const signUrl = this.buildMockSignUrl(input.contractId, input.taskId);

    return {
      expiresAt: this.signUrlExpiresAt(),
      rawResponse: {
        mock: true,
        providerTaskId: input.providerTaskId,
        signUrl
      },
      signUrl
    };
  }

  async verifyCallback(payload: unknown): Promise<VerifyCallbackResult> {
    const record = asRecord(payload);

    return {
      eventType: stringOrUndefined(record.eventType) ?? stringOrUndefined(record.event),
      payload,
      providerTaskId: stringOrUndefined(record.providerTaskId),
      verified: true
    };
  }

  private buildMockSignUrl(contractId?: string, taskId?: string) {
    const portalBaseUrl = trimTrailingSlash(
      this.configService.get<string>("PORTAL_BASE_URL") ?? "http://localhost:3000"
    );
    const contractSegment = encodeURIComponent(contractId ?? "");
    const taskQuery = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";

    return `${portalBaseUrl}/portal/contracts/${contractSegment}/sign${taskQuery}`;
  }

  private signUrlExpiresAt() {
    const seconds = Number(this.configService.get<string>("ESIGN_SIGN_URL_EXPIRES_SECONDS") ?? "1800");
    return new Date(Date.now() + Math.max(seconds, 60) * 1000);
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requireMockTransactionId(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9]{1,32}$/.test(value)) {
    throw new Error("MOCK_PROVIDER_TRANSACTION_ID_INVALID");
  }
  return value;
}

function requireStage2MockSlot(
  documentType: string | undefined,
  slots: CreateSignTaskInput["signingSlots"],
  slotId: "STAGE2_HANDOVER_CUSTOMER" | "STAGE2_HANDOVER_PLATFORM",
  signerRole: "CUSTOMER" | "PLATFORM",
  providerActionType: "CUSTOMER_MANUAL_SIGN" | "PLATFORM_AUTO_SEAL"
) {
  const slot = slots?.[0];
  if (
    documentType !== "DELIVERY_HANDOVER" ||
    slots?.length !== 1 ||
    slot?.documentType !== "DELIVERY_HANDOVER" ||
    slot.providerActionType !== providerActionType ||
    slot.required === false ||
    slot.signerRole !== signerRole ||
    slot.signingStage !== "STAGE2_DELIVERY_HANDOVER" ||
    slot.slotId !== slotId
  ) {
    throw new Error("MOCK_STAGE2_MAPPING_INVALID");
  }
}
