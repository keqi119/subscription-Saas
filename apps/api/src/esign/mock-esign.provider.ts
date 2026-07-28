import { ConfigService } from "@nestjs/config";

import {
  AutoSealTaskInput,
  AutoSealTaskResult,
  CreateSignTaskInput,
  CreateSignTaskResult,
  ESignProvider,
  ESignProviderSignerStatusResult,
  GetSignerUrlInput,
  GetSignerUrlResult,
  QuerySignerStatusInput,
  VerifyCallbackResult
} from "./esign.provider";

export class MockESignProvider implements ESignProvider {
  private readonly signerOperations =
    new Map<string, MockSignerOperation>();
  private readonly signerUrls = new Map<string, MockSignerUrl>();

  constructor(private readonly configService: ConfigService) {}

  async createSignTask(input: CreateSignTaskInput): Promise<CreateSignTaskResult> {
    if (input.signingStage === "STAGE2_DELIVERY_HANDOVER") {
      const transactionId = requireMockTransactionId(input.transactionId);
      const customerSigner = input.signers.find(
        (signer) => signer.signerType === "CUSTOMER"
      );
      if (
        !customerSigner?.customerId ||
        !customerSigner.signerId ||
        !input.taskId
      ) {
        throw new Error("MOCK_STAGE2_SIGNER_BINDING_INVALID");
      }
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
      this.signerOperations.set(transactionId, {
        contractId: input.taskNo,
        providerCustomerId: customerSigner.customerId,
        providerTaskId: transactionId,
        providerTransactionId: transactionId,
        signerId: customerSigner.signerId,
        slotId: "STAGE2_HANDOVER_CUSTOMER",
        status: "SIGNING",
        taskId: input.taskId
      });
      this.signerUrls.set(transactionId, {
        contractId: input.taskNo,
        expiresAt,
        signUrl,
        signerId: customerSigner.signerId,
        taskId: input.taskId
      });
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
          customerId: customerSigner.customerId,
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
    const providerTaskId = `mock_${input.taskNo}`;

    return {
      providerTaskId,
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
    if (
      !input.platformCustomerId ||
      !input.providerTaskId ||
      !input.signerId ||
      !input.taskId
    ) {
      throw new Error("MOCK_STAGE2_PLATFORM_BINDING_INVALID");
    }
    this.signerOperations.set(transactionId, {
      contractId: input.providerEnvelopeId ?? input.taskNo,
      providerCustomerId: input.platformCustomerId,
      providerTaskId: input.providerTaskId,
      providerTransactionId: transactionId,
      signerId: input.signerId,
      slotId: "STAGE2_HANDOVER_PLATFORM",
      status: "SIGNED",
      taskId: input.taskId
    });
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
    const operation = this.signerUrls.get(input.providerTaskId);
    if (
      input.signingStage === "STAGE1_CONTRACT" &&
      !operation &&
      input.providerTaskId.startsWith("mock_")
    ) {
      const signUrl = this.buildMockSignUrl(
        input.contractId,
        input.taskId
      );
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
    if (
      !operation ||
      input.signingStage !== "STAGE2_DELIVERY_HANDOVER" ||
      (
        input.contractId !== undefined &&
        operation.contractId !== input.contractId
      ) ||
      (
        input.signerId !== undefined &&
        operation.signerId !== undefined &&
        operation.signerId !== input.signerId
      ) ||
      (
        input.taskId !== undefined &&
        operation.taskId !== input.taskId
      )
    ) {
      throw new Error("MOCK_SIGNER_OPERATION_NOT_FOUND");
    }

    return {
      expiresAt: operation.expiresAt,
      rawResponse: {
        mock: true,
        providerTaskId: input.providerTaskId,
        signUrl: operation.signUrl
      },
      signUrl: operation.signUrl
    };
  }

  async querySignerStatus(
    input: QuerySignerStatusInput
  ): Promise<ESignProviderSignerStatusResult> {
    const operation = this.signerOperations.get(
      input.providerTransactionId
    );
    if (
      !operation ||
      operation.contractId !== input.contractId ||
      operation.providerCustomerId !== input.providerCustomerId ||
      operation.providerTaskId !== input.providerTaskId ||
      operation.providerTransactionId !==
        input.providerTransactionId ||
      operation.signerId !== input.signerId ||
      operation.slotId !== input.slotId ||
      operation.taskId !== input.taskId
    ) {
      return { status: "UNKNOWN" };
    }
    return {
      resultCode:
        operation.status === "SIGNED"
          ? "3000"
          : "MOCK_SIGNING",
      resultDescription:
        operation.status === "SIGNED"
          ? "Mock Stage 2 platform seal completed."
          : "Mock customer signing operation is active.",
      status: operation.status
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

interface MockSignerOperation {
  contractId: string;
  providerCustomerId: string;
  providerTaskId: string;
  providerTransactionId: string;
  signerId: string;
  slotId:
    | "STAGE2_HANDOVER_CUSTOMER"
    | "STAGE2_HANDOVER_PLATFORM";
  status: "SIGNED" | "SIGNING";
  taskId: string;
}

interface MockSignerUrl {
  contractId: string;
  expiresAt: Date;
  signUrl: string;
  signerId?: string;
  taskId?: string;
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
