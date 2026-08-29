import { ConfigService } from "@nestjs/config";

import {
  AutoSealTaskInput,
  AutoSealTaskResult,
  CancelReturnManifestProviderTaskInput,
  CancelReturnManifestProviderTaskResult,
  CompleteReturnManifestProviderTaskInput,
  CompleteReturnManifestProviderTaskResult,
  CreateSignTaskInput,
  CreateSignTaskResult,
  ESignProvider,
  ESignProviderSignerStatusResult,
  GetSignerUrlInput,
  GetSignerUrlResult,
  QuerySignerStatusInput,
  ReturnManifestProviderTaskInput,
  ReturnManifestProviderTaskResult,
  VerifyCallbackResult
} from "./esign.provider";

export class MockESignProvider implements ESignProvider {
  private readonly returnManifestTasks =
    new Map<string, MockReturnManifestTask>();
  private readonly signerOperations =
    new Map<string, MockSignerOperation>();
  private readonly signerUrls = new Map<string, MockSignerUrl>();

  constructor(private readonly configService: ConfigService) {}

  async cancelReturnManifestTask(
    input: CancelReturnManifestProviderTaskInput
  ): Promise<CancelReturnManifestProviderTaskResult> {
    const existing = this.returnManifestTasks.get(input.providerTaskId);
    if (!existing) return { cancelled: true, replayed: true };
    if (
      existing.result.providerEnvelopeId !== input.providerEnvelopeId ||
      existing.result.providerTaskId !== input.providerTaskId ||
      existing.taskId !== input.taskId ||
      existing.taskNo !== input.taskNo
    ) {
      throw new Error("MOCK_RETURN_MANIFEST_PROVIDER_CANCELLATION_CONFLICT");
    }
    this.returnManifestTasks.delete(input.providerTaskId);
    return {
      cancelled: true,
      rawResponse: { providerTaskId: input.providerTaskId, status: "CANCELLED" }
    };
  }

  async createReturnManifestTask(
    input: ReturnManifestProviderTaskInput
  ): Promise<ReturnManifestProviderTaskResult> {
    if (
      !input.providerSourcePdf.buffer.subarray(0, 5).equals(Buffer.from("%PDF-", "utf8")) ||
      !/^[a-f0-9]{64}$/i.test(input.providerSourcePdf.sha256)
    ) {
      throw new Error("MOCK_RETURN_MANIFEST_PROVIDER_SOURCE_INVALID");
    }
    const result = await this.createSignTask({
      callbackUrl: input.callbackUrl,
      contractId: input.contractId,
      documentName: input.documentName,
      documentType: "RETURN_MANIFEST",
      signers: [
        {
          customerId: input.customer.customerId,
          name: input.customer.name,
          phone: input.customer.phone,
          signerId: input.customer.signerId,
          signerType: "CUSTOMER"
        }
      ],
      signingSlots: [
        {
          documentType: "RETURN_MANIFEST",
          keyword: "RETURN_MANIFEST_CUSTOMER_SIGNATURE",
          providerActionType: "CUSTOMER_MANUAL_SIGN",
          required: true,
          signerRole: "CUSTOMER",
          signingStage: "STAGE6_RETURN_MANIFEST",
          slotId: "RETURN_MANIFEST_CUSTOMER"
        }
      ],
      signingStage: "STAGE6_RETURN_MANIFEST",
      sourcePdfHash: input.providerSourcePdf.sha256,
      taskId: input.taskId,
      taskNo: input.taskNo,
      transactionId: input.transactionId
    });
    const customer = result.signers?.[0];
    if (
      !customer?.providerCustomerId ||
      !customer.providerSignerId ||
      !customer.providerTransactionId ||
      !result.providerEnvelopeId
    ) {
      throw new Error("MOCK_RETURN_MANIFEST_PROVIDER_RESULT_INVALID");
    }
    const returnManifestTask = {
      customer: {
        providerCustomerId: customer.providerCustomerId,
        providerSignerId: customer.providerSignerId,
        providerTransactionId: customer.providerTransactionId,
        signUrl: customer.signUrl,
        signUrlExpiresAt: customer.signUrlExpiresAt
      },
      providerEnvelopeId: result.providerEnvelopeId,
      providerTaskId: result.providerTaskId,
      rawResponse: result.rawResponse
    };
    this.returnManifestTasks.set(input.transactionId, {
      contractId: input.contractId,
      customerId: input.customer.customerId,
      documentName: input.documentName,
      providerSourcePdfHash: input.providerSourcePdf.sha256.toLowerCase(),
      result: returnManifestTask,
      signerId: input.customer.signerId,
      taskId: input.taskId,
      taskNo: input.taskNo,
      transactionId: input.transactionId
    });
    return returnManifestTask;
  }

  async reconcileReturnManifestTask(
    input: ReturnManifestProviderTaskInput
  ): Promise<ReturnManifestProviderTaskResult | null> {
    const existing = this.returnManifestTasks.get(input.transactionId);
    if (!existing) return null;
    if (
      existing.contractId !== input.contractId ||
      existing.customerId !== input.customer.customerId ||
      existing.documentName !== input.documentName ||
      existing.providerSourcePdfHash !== input.providerSourcePdf.sha256.toLowerCase() ||
      existing.signerId !== input.customer.signerId ||
      existing.taskId !== input.taskId ||
      existing.taskNo !== input.taskNo ||
      existing.transactionId !== input.transactionId
    ) {
      throw new Error("MOCK_RETURN_MANIFEST_PROVIDER_RECONCILIATION_CONFLICT");
    }
    return existing.result;
  }

  async completeReturnManifestTask(
    input: CompleteReturnManifestProviderTaskInput
  ): Promise<CompleteReturnManifestProviderTaskResult> {
    const customer = await this.querySignerStatus({
      contractId: input.taskNo,
      providerCustomerId: input.customer.providerCustomerId,
      providerTaskId: input.providerTaskId,
      providerTransactionId: input.customer.providerTransactionId,
      signerId: input.customer.signerId,
      slotId: "RETURN_MANIFEST_CUSTOMER",
      taskId: input.taskId
    });
    if (customer.status !== "SIGNED") {
      throw new Error("MOCK_RETURN_MANIFEST_CUSTOMER_NOT_SIGNED");
    }
    const platform = await this.autoSealTask({
      contractId: input.contractId,
      documentName: input.documentName,
      documentType: "RETURN_MANIFEST",
      platformCustomerId: "mock-platform",
      platformSignatureId: "mock-platform-seal",
      providerEnvelopeId: input.providerEnvelopeId,
      providerTaskId: input.providerTaskId,
      signerId: input.platform.signerId,
      signingSlots: [
        {
          documentType: "RETURN_MANIFEST",
          keyword: "RETURN_MANIFEST_PLATFORM_SEAL",
          providerActionType: "PLATFORM_AUTO_SEAL",
          required: true,
          signerRole: "PLATFORM",
          signingStage: "STAGE6_RETURN_MANIFEST",
          slotId: "RETURN_MANIFEST_PLATFORM"
        }
      ],
      signingStage: "STAGE6_RETURN_MANIFEST",
      taskId: input.taskId,
      taskNo: input.taskNo,
      transactionId: input.platform.transactionId
    });
    if (
      platform.status !== "COMPLETED" ||
      !platform.providerSignerId ||
      !platform.providerTransactionId
    ) {
      throw new Error("MOCK_RETURN_MANIFEST_PLATFORM_NOT_SIGNED");
    }
    return {
      customer: {
        providerTransactionId: input.customer.providerTransactionId,
        resultCode: customer.resultCode,
        resultDescription: customer.resultDescription
      },
      platform: {
        providerSignerId: platform.providerSignerId,
        providerTransactionId: platform.providerTransactionId,
        resultCode: platform.resultCode,
        resultDescription: platform.resultDescription
      },
      rawResponse: { mock: true, taskId: input.taskId },
      signedPdf: {
        buffer: Buffer.concat([
          input.providerSourcePdf,
          Buffer.from(`\n% RETURN_MANIFEST_SIGNED ${input.taskId}\n`, "utf8")
        ]),
        contentType: "application/pdf",
        fileName: input.documentName.replace(/\.pdf$/i, "-signed.pdf")
      }
    };
  }

  async createSignTask(input: CreateSignTaskInput): Promise<CreateSignTaskResult> {
    if (
      input.signingStage === "STAGE2_DELIVERY_HANDOVER" ||
      input.signingStage === "STAGE6_RETURN_MANIFEST"
    ) {
      const returnManifest = input.signingStage === "STAGE6_RETURN_MANIFEST";
      const customerSlotId = returnManifest
        ? "RETURN_MANIFEST_CUSTOMER"
        : "STAGE2_HANDOVER_CUSTOMER";
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
      requireMockSlot(
        input.documentType,
        input.signingSlots,
        customerSlotId,
        "CUSTOMER",
        "CUSTOMER_MANUAL_SIGN",
        input.signingStage
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
        slotId: customerSlotId,
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
          coveredSlotIds: [customerSlotId],
          providerActionType: "CUSTOMER_MANUAL_SIGN",
          providerSignerId: transactionId,
          providerTransactionId: transactionId,
          signUrl,
          signUrlExpiresAt: expiresAt,
          signerType: "CUSTOMER",
          signingStage: input.signingStage
        }],
        providerEnvelopeId: input.taskNo,
        providerTaskId: transactionId,
        rawResponse: {
          mock: true,
          signingStage: input.signingStage
        },
        signUrl,
        signUrlExpiresAt: expiresAt,
        signers: [{
          coveredSlotIds: [customerSlotId],
          customerId: customerSigner.customerId,
          documentType: returnManifest ? "RETURN_MANIFEST" : "DELIVERY_HANDOVER",
          providerActionType: "CUSTOMER_MANUAL_SIGN",
          providerCustomerId: customerSigner.customerId,
          providerSignerId: transactionId,
          providerTransactionId: transactionId,
          signUrl,
          signUrlExpiresAt: expiresAt,
          signerType: "CUSTOMER",
          signingStage: input.signingStage,
          slotId: customerSlotId
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
    if (
      input.signingStage !== "STAGE2_DELIVERY_HANDOVER" &&
      input.signingStage !== "STAGE6_RETURN_MANIFEST"
    ) {
      throw new Error("ESIGN_PLATFORM_AUTO_SEAL_UNSUPPORTED");
    }
    const returnManifest = input.signingStage === "STAGE6_RETURN_MANIFEST";
    const platformSlotId = returnManifest
      ? "RETURN_MANIFEST_PLATFORM"
      : "STAGE2_HANDOVER_PLATFORM";
    const transactionId = requireMockTransactionId(input.transactionId);
    requireMockSlot(
      input.documentType,
      input.signingSlots,
      platformSlotId,
      "PLATFORM",
      "PLATFORM_AUTO_SEAL",
      input.signingStage
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
      slotId: platformSlotId,
      status: "SIGNED",
      taskId: input.taskId
    });
    return {
      coveredSlotIds: [platformSlotId],
      providerActionType: "PLATFORM_AUTO_SEAL",
      providerSignerId: transactionId,
      providerTransactionId: transactionId,
      rawResponse: {
        mock: true,
        signingStage: input.signingStage
      },
      resultCode: "MOCK_COMPLETED",
      resultDescription: "Mock Stage 2 platform seal completed.",
      signingStage: input.signingStage,
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
      (input.signingStage !== "STAGE2_DELIVERY_HANDOVER" &&
        input.signingStage !== "STAGE6_RETURN_MANIFEST") ||
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
    const providerTaskId = stringOrUndefined(record.providerTaskId);
    const eventType = stringOrUndefined(record.eventType) ?? stringOrUndefined(record.event);
    if (providerTaskId && /signed|completed/i.test(eventType ?? "")) {
      const operation = this.signerOperations.get(providerTaskId);
      if (operation) operation.status = "SIGNED";
    }

    return {
      eventType,
      payload,
      providerTaskId,
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
    | "STAGE2_HANDOVER_PLATFORM"
    | "RETURN_MANIFEST_CUSTOMER"
    | "RETURN_MANIFEST_PLATFORM";
  status: "SIGNED" | "SIGNING";
  taskId: string;
}

interface MockReturnManifestTask {
  contractId: string;
  customerId: string;
  documentName: string;
  providerSourcePdfHash: string;
  result: ReturnManifestProviderTaskResult;
  signerId: string;
  taskId: string;
  taskNo: string;
  transactionId: string;
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

function requireMockSlot(
  documentType: string | undefined,
  slots: CreateSignTaskInput["signingSlots"],
  slotId:
    | "STAGE2_HANDOVER_CUSTOMER"
    | "STAGE2_HANDOVER_PLATFORM"
    | "RETURN_MANIFEST_CUSTOMER"
    | "RETURN_MANIFEST_PLATFORM",
  signerRole: "CUSTOMER" | "PLATFORM",
  providerActionType: "CUSTOMER_MANUAL_SIGN" | "PLATFORM_AUTO_SEAL",
  signingStage: "STAGE2_DELIVERY_HANDOVER" | "STAGE6_RETURN_MANIFEST"
) {
  const slot = slots?.[0];
  const expectedDocumentType =
    signingStage === "STAGE6_RETURN_MANIFEST" ? "RETURN_MANIFEST" : "DELIVERY_HANDOVER";
  if (
    documentType !== expectedDocumentType ||
    slots?.length !== 1 ||
    slot?.documentType !== expectedDocumentType ||
    slot.providerActionType !== providerActionType ||
    slot.required === false ||
    slot.signerRole !== signerRole ||
    slot.signingStage !== signingStage ||
    slot.slotId !== slotId
  ) {
    throw new Error("MOCK_SIGNING_MAPPING_INVALID");
  }
}
