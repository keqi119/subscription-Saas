import {
  ESignProviderAccountStatus,
  ESignProviderAccountType,
  ESignProviderCertBindingStatus,
  ESignProviderRealNameStatusSource,
  ESignProviderType,
  ESignRealNameStatus
} from "@prisma/client";

import {
  AutoSealTaskInput,
  AutoSealTaskResult,
  CreateSignTaskInput,
  CreateSignTaskResult,
  ESignProvider,
  ESignSlotId,
  ESignSigningSlot,
  ESignSigningSlotCoordinate,
  GetSignerUrlInput,
  GetSignerUrlResult,
  VerifyCallbackResult
} from "../esign.provider";
import {
  ContractPdfArtifactService,
  ResolvedContractPdfArtifactSlotCoordinate
} from "../contract-pdf-artifact.service";
import { PrismaService } from "../../prisma/prisma.service";
import { assertFadadaTransactionId, FadadaApiClient, FADADA_TRANSACTION_ID_INVALID } from "./fadada-api.client";
import { verifyFadadaCallbackDigest } from "./fadada-digest";
import { resolveFadadaSignerCustomerId } from "./fadada-signer-customer-resolver";
import { FadadaConfig, FadadaSignCallbackPayload } from "./fadada.types";

export const FADADA_PROVIDER_STAGE_B2_REQUIRED = "FADADA_PROVIDER_STAGE_B2_REQUIRED";
export const FADADA_SIGN_URL_STAGE_B2_REQUIRED = "FADADA_SIGN_URL_STAGE_B2_REQUIRED";
export const FADADA_PROVIDER_DEPENDENCY_MISSING = "FADADA_PROVIDER_DEPENDENCY_MISSING";
export const FADADA_SIGN_URL_NOT_AVAILABLE = "FADADA_SIGN_URL_NOT_AVAILABLE";
export const FADADA_PLATFORM_AUTO_SEAL_CONFIG_MISSING = "FADADA_PLATFORM_AUTO_SEAL_CONFIG_MISSING";
export const FADADA_PLATFORM_AUTO_SEAL_POSITIONING_MISSING = "FADADA_PLATFORM_AUTO_SEAL_POSITIONING_MISSING";
export const FADADA_STAGE1_MULTI_SLOT_MAPPING_NOT_IMPLEMENTED =
  "FADADA_STAGE1_MULTI_SLOT_MAPPING_NOT_IMPLEMENTED";
export const FADADA_STAGE1_CUSTOMER_SLOT_MISSING = "FADADA_STAGE1_CUSTOMER_SLOT_MISSING";
export const FADADA_STAGE1_CUSTOMER_SLOT_COORDINATES_MISSING =
  "FADADA_STAGE1_CUSTOMER_SLOT_COORDINATES_MISSING";
export const FADADA_STAGE1_PLATFORM_SLOT_MISSING = "FADADA_STAGE1_PLATFORM_SLOT_MISSING";
export const FADADA_STAGE1_PLATFORM_SLOT_COORDINATES_MISSING =
  "FADADA_STAGE1_PLATFORM_SLOT_COORDINATES_MISSING";
export const FADADA_STAGE2_CUSTOMER_MAPPING_INVALID = "FADADA_STAGE2_CUSTOMER_MAPPING_INVALID";
export const FADADA_STAGE2_CUSTOMER_COORDINATE_INVALID = "FADADA_STAGE2_CUSTOMER_COORDINATE_INVALID";
export const FADADA_STAGE2_PLATFORM_MAPPING_INVALID = "FADADA_STAGE2_PLATFORM_MAPPING_INVALID";
export const FADADA_SIGNING_STAGE_UNSUPPORTED = "FADADA_SIGNING_STAGE_UNSUPPORTED";

const STAGE1_CUSTOMER_SLOT_IDS: ESignSlotId[] = [
  "STAGE1_BODY_CUSTOMER",
  "STAGE1_ATTACHMENT1_CUSTOMER"
];
const STAGE1_PLATFORM_SLOT_IDS: ESignSlotId[] = [
  "STAGE1_BODY_PLATFORM",
  "STAGE1_ATTACHMENT1_PLATFORM"
];
const STAGE2_CUSTOMER_SLOT_ID = "STAGE2_HANDOVER_CUSTOMER";
const STAGE2_PLATFORM_SLOT_ID = "STAGE2_HANDOVER_PLATFORM";

export class FadadaESignProvider implements ESignProvider {
  readonly providerType = "FADADA";

  constructor(
    private readonly config: FadadaConfig,
    private readonly apiClient?: FadadaApiClient,
    private readonly pdfArtifactService?: ContractPdfArtifactService,
    private readonly prisma?: PrismaService
  ) {}

  async createSignTask(input: CreateSignTaskInput): Promise<CreateSignTaskResult> {
    if (input.signingStage === "STAGE1_CONTRACT") {
      return this.createStage1CustomerSignTask(input);
    }
    if (input.signingStage === "STAGE2_DELIVERY_HANDOVER") {
      return this.createStage2CustomerSignTask(input);
    }
    if (input.signingStage !== undefined) {
      throw new Error(`${FADADA_SIGNING_STAGE_UNSUPPORTED}: ${String(input.signingStage)}`);
    }

    if (!this.apiClient || !this.pdfArtifactService) {
      throw new Error(`${FADADA_PROVIDER_DEPENDENCY_MISSING}: Fadada B2-A dependencies are not wired`);
    }

    const customerSigner = input.signers.find((signer) => signer.signerType === "CUSTOMER");
    if (!customerSigner?.customerId) {
      throw new Error("FADADA_CUSTOMER_SIGNER_MISSING: customer signer is required");
    }
    const formalProviderCustomerId = await this.findVerifiedProviderCustomerId(customerSigner.customerId);
    const resolvedSignerCustomer = resolveFadadaSignerCustomerId({
      config: this.config,
      contractId: input.contractId,
      formalProviderCustomerId,
      localCustomerId: customerSigner.customerId,
      mode: this.config.fullSigningSmokeEnabled ? "FULL_SIGNING_SMOKE" : "NORMAL",
      orderId: undefined
    });

    const providerContractId = input.taskNo;
    const transactionId = buildTransactionId(input.taskNo, 1);
    const artifact = await this.pdfArtifactService.getContractPdfArtifact(input.contractId);
    const uploadResult = await this.apiClient.uploadDocs({
      contractId: providerContractId,
      docTitle: input.documentName,
      fileName: artifact.fileName,
      pdf: artifact.buffer
    });
    const signUrlResult = await this.apiClient.createExternalSignUrl({
      contractId: providerContractId,
      customerId: resolvedSignerCustomer.providerCustomerId,
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
        signerCustomer: {
          source: resolvedSignerCustomer.source
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
        providerCustomerId: resolvedSignerCustomer.providerCustomerId,
        signerType: "CUSTOMER"
      }]
    };
  }

  private async createStage2CustomerSignTask(input: CreateSignTaskInput): Promise<CreateSignTaskResult> {
    const customerSlot = resolveStage2CustomerSlot(input);
    if (!this.apiClient || !this.pdfArtifactService) {
      throw new Error(`${FADADA_PROVIDER_DEPENDENCY_MISSING}: Stage 2 Fadada dependencies are not wired`);
    }

    const customerSigner = input.signers.find((signer) => signer.signerType === "CUSTOMER");
    if (!customerSigner?.customerId) {
      throw new Error("FADADA_CUSTOMER_SIGNER_MISSING: customer signer is required");
    }
    const formalProviderCustomerId = await this.findVerifiedProviderCustomerId(customerSigner.customerId);
    const resolvedSignerCustomer = resolveFadadaSignerCustomerId({
      config: this.config,
      contractId: input.contractId,
      formalProviderCustomerId,
      localCustomerId: customerSigner.customerId,
      mode: this.config.fullSigningSmokeEnabled ? "FULL_SIGNING_SMOKE" : "NORMAL",
      orderId: undefined
    });

    const artifact = await this.pdfArtifactService.getContractPdfArtifact(input.contractId, {
      expectedSha256: input.sourcePdfHash,
      fadadaEnabled: true,
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: true,
      requireStage2SlotCoordinates: true
    });
    const coordinate = resolveStage2ArtifactCoordinate(
      artifact.slotCoordinates,
      STAGE2_CUSTOMER_SLOT_ID
    );
    assertStage2CustomerInputCoordinate(input.signingSlotCoordinates, coordinate);
    const providerContractId = input.taskNo;
    const transactionId =
      input.transactionId ?? buildStage2TransactionId(input.taskNo, "H1");
    assertFadadaTransactionId(transactionId);
    const signaturePositions = [{
      pagenum: coordinate.pageNumber,
      x: coordinate.x,
      y: coordinate.y
    }];

    const uploadResult = await this.apiClient.uploadDocs({
      contractId: providerContractId,
      docTitle: input.documentName,
      fileName: artifact.fileName,
      pdf: artifact.buffer
    });
    const signUrlResult = await this.apiClient.createExternalSignUrl({
      contractId: providerContractId,
      customerId: resolvedSignerCustomer.providerCustomerId,
      docTitle: input.documentName,
      notifyUrl: input.callbackUrl ?? this.config.signNotifyUrl ?? "",
      returnUrl: input.redirectUrl ?? this.config.signReturnUrl ?? "",
      signaturePositions,
      signerMobile: customerSigner.phone,
      signerName: customerSigner.name,
      transactionId
    });

    return {
      actions: [{
        coveredSlotIds: [customerSlot.slotId],
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerSignerId: transactionId,
        providerTransactionId: transactionId,
        signUrl: signUrlResult.signUrl,
        signUrlExpiresAt: signUrlResult.signUrlExpiresAt,
        signerType: "CUSTOMER",
        signingStage: "STAGE2_DELIVERY_HANDOVER"
      }],
      providerEnvelopeId: providerContractId,
      providerTaskId: transactionId,
      rawResponse: {
        artifact: {
          fileName: artifact.fileName,
          size: artifact.size,
          slotCoordinates: artifact.slotCoordinates?.length ?? 0,
          source: artifact.source
        },
        provider: {
          manualSignMapped: true,
          uploadAccepted: Boolean(uploadResult)
        },
        signerCustomer: {
          source: resolvedSignerCustomer.source
        }
      },
      signUrl: signUrlResult.signUrl,
      signUrlExpiresAt: signUrlResult.signUrlExpiresAt,
      signers: [{
        coveredSlotIds: [customerSlot.slotId],
        customerId: customerSigner.customerId,
        documentType: customerSlot.documentType,
        providerActionType: customerSlot.providerActionType,
        providerCustomerId: resolvedSignerCustomer.providerCustomerId,
        providerSignerId: transactionId,
        providerTransactionId: transactionId,
        signUrl: signUrlResult.signUrl,
        signUrlExpiresAt: signUrlResult.signUrlExpiresAt,
        signingStage: customerSlot.signingStage,
        slotId: customerSlot.slotId,
        signerType: "CUSTOMER"
      }]
    };
  }

  private async createStage1CustomerSignTask(input: CreateSignTaskInput): Promise<CreateSignTaskResult> {
    const customerSlots = resolveStage1CustomerSlots(input);
    if (!this.apiClient || !this.pdfArtifactService) {
      throw new Error(`${FADADA_PROVIDER_DEPENDENCY_MISSING}: Fadada B2-A dependencies are not wired`);
    }

    const customerSigner = input.signers.find((signer) => signer.signerType === "CUSTOMER");
    if (!customerSigner?.customerId) {
      throw new Error("FADADA_CUSTOMER_SIGNER_MISSING: customer signer is required");
    }
    const formalProviderCustomerId = await this.findVerifiedProviderCustomerId(customerSigner.customerId);
    const resolvedSignerCustomer = resolveFadadaSignerCustomerId({
      config: this.config,
      contractId: input.contractId,
      formalProviderCustomerId,
      localCustomerId: customerSigner.customerId,
      mode: this.config.fullSigningSmokeEnabled ? "FULL_SIGNING_SMOKE" : "NORMAL",
      orderId: undefined
    });

    const providerContractId = input.taskNo;
    const transactionId = buildTransactionId(input.taskNo, 1);
    const artifact = await this.pdfArtifactService.getContractPdfArtifact(input.contractId, {
      fadadaEnabled: true,
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: true,
      requireStage1SlotCoordinates: true
    });
    const coordinateSource = input.signingSlotCoordinates ?? artifact.slotCoordinates;
    const signaturePositions = customerSlots.map((slot) => {
      const coordinate = findSlotCoordinate(coordinateSource, slot.slotId);
      if (!coordinate) {
        throw new Error(`${FADADA_STAGE1_CUSTOMER_SLOT_COORDINATES_MISSING}: ${slot.slotId}`);
      }
      return {
        pagenum: coordinate.pageNumber,
        x: coordinate.x,
        y: coordinate.y
      };
    });

    const uploadResult = await this.apiClient.uploadDocs({
      contractId: providerContractId,
      docTitle: input.documentName,
      fileName: artifact.fileName,
      pdf: artifact.buffer
    });
    const signUrlResult = await this.apiClient.createExternalSignUrl({
      contractId: providerContractId,
      customerId: resolvedSignerCustomer.providerCustomerId,
      docTitle: input.documentName,
      notifyUrl: input.callbackUrl ?? this.config.signNotifyUrl ?? "",
      returnUrl: input.redirectUrl ?? this.config.signReturnUrl ?? "",
      signaturePositions,
      signerMobile: customerSigner.phone,
      signerName: customerSigner.name,
      transactionId
    });

    return {
      actions: [{
        coveredSlotIds: STAGE1_CUSTOMER_SLOT_IDS,
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerSignerId: transactionId,
        providerTransactionId: transactionId,
        signUrl: signUrlResult.signUrl,
        signUrlExpiresAt: signUrlResult.signUrlExpiresAt,
        signerType: "CUSTOMER",
        signingStage: "STAGE1_CONTRACT"
      }],
      documentObjectKey: artifact.objectKey,
      providerEnvelopeId: providerContractId,
      providerTaskId: transactionId,
      rawResponse: {
        artifact: {
          fileName: artifact.fileName,
          objectKey: artifact.objectKey,
          size: artifact.size,
          source: artifact.source,
          slotCoordinates: signaturePositions.length
        },
        signerCustomer: {
          source: resolvedSignerCustomer.source
        },
        signUrl: signUrlResult.raw,
        upload: uploadResult.raw
      },
      signUrl: signUrlResult.signUrl,
      signUrlExpiresAt: signUrlResult.signUrlExpiresAt,
      signers: [{
        coveredSlotIds: STAGE1_CUSTOMER_SLOT_IDS,
        customerId: customerSigner.customerId,
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerCustomerId: resolvedSignerCustomer.providerCustomerId,
        providerSignerId: transactionId,
        providerTransactionId: transactionId,
        signUrl: signUrlResult.signUrl,
        signUrlExpiresAt: signUrlResult.signUrlExpiresAt,
        signerType: "CUSTOMER",
        signingStage: "STAGE1_CONTRACT"
      }]
    };
  }

  async autoSealTask(input: AutoSealTaskInput): Promise<AutoSealTaskResult> {
    if (input.signingStage === "STAGE1_CONTRACT") {
      return this.autoSealStage1PlatformSlots(input);
    }
    if (input.signingStage === "STAGE2_DELIVERY_HANDOVER") {
      return this.autoSealStage2PlatformSlot(input);
    }
    if (input.signingStage !== undefined) {
      throw new Error(`${FADADA_SIGNING_STAGE_UNSUPPORTED}: ${String(input.signingStage)}`);
    }
    if (!this.apiClient) {
      throw new Error(`${FADADA_PROVIDER_DEPENDENCY_MISSING}: Fadada auto seal dependencies are not wired`);
    }
    const providerContractId = input.providerEnvelopeId ?? input.taskNo;
    const platformCustomerId = input.platformCustomerId ?? this.config.platformCustomerId;
    const platformSignatureId = input.platformSignatureId ?? this.config.platformSignatureId ?? input.sealId;
    if (!platformCustomerId || !platformSignatureId) {
      throw new Error(`${FADADA_PLATFORM_AUTO_SEAL_CONFIG_MISSING}: platform customer and signature IDs are required`);
    }
    if (!input.placement?.keyword?.trim()) {
      throw new Error(`${FADADA_PLATFORM_AUTO_SEAL_POSITIONING_MISSING}: platform seal keyword placement is required`);
    }

    const result = await this.apiClient.autoSealContract({
      contractId: providerContractId,
      customerId: platformCustomerId,
      docTitle: input.documentName,
      notifyUrl: input.callbackUrl ?? this.config.signNotifyUrl,
      placement: input.placement,
      signatureId: platformSignatureId,
      transactionId: input.transactionId
    });
    const completed = isSuccessfulAutoSealResult(result.resultCode);

    return {
      providerSignerId: result.transactionId,
      rawResponse: result.raw,
      resultCode: result.resultCode,
      resultDescription: result.resultDesc,
      status: completed ? "COMPLETED" : "FAILED"
    };
  }

  private async autoSealStage2PlatformSlot(input: AutoSealTaskInput): Promise<AutoSealTaskResult> {
    const platformSlot = resolveStage2PlatformSlot(input);
    const coordinate = resolveSingleStage2ProviderCoordinate(
      input.signingSlotCoordinates,
      STAGE2_PLATFORM_SLOT_ID
    );
    if (!this.apiClient) {
      throw new Error(`${FADADA_PROVIDER_DEPENDENCY_MISSING}: Stage 2 auto seal dependencies are not wired`);
    }

    const platformCustomerId = input.platformCustomerId ?? this.config.platformCustomerId;
    const platformSignatureId = input.platformSignatureId ?? this.config.platformSignatureId;
    if (!platformCustomerId || !platformSignatureId) {
      throw new Error(
        `${FADADA_PLATFORM_AUTO_SEAL_CONFIG_MISSING}: platform customer and signature IDs are required`
      );
    }

    const providerContractId = input.providerEnvelopeId ?? input.taskNo;
    const transactionId = input.transactionId;
    assertFadadaTransactionId(transactionId);
    const result = await this.apiClient.autoSealContract({
      contractId: providerContractId,
      customerId: platformCustomerId,
      docTitle: input.documentName,
      notifyUrl: input.callbackUrl ?? this.config.signNotifyUrl,
      signatureId: platformSignatureId,
      signaturePositions: [{
        pagenum: coordinate.pageNumber,
        x: coordinate.x,
        y: coordinate.y
      }],
      transactionId
    });
    const completed = isSuccessfulAutoSealResult(result.resultCode);

    return {
      coveredSlotIds: [platformSlot.slotId],
      providerActionType: "PLATFORM_AUTO_SEAL",
      providerSignerId: transactionId,
      providerTransactionId: transactionId,
      rawResponse: {
        resultCode: result.resultCode
      },
      resultCode: result.resultCode,
      resultDescription: result.resultDesc,
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      status: completed ? "COMPLETED" : "FAILED"
    };
  }

  private async autoSealStage1PlatformSlots(input: AutoSealTaskInput): Promise<AutoSealTaskResult> {
    if (!this.apiClient) {
      throw new Error(`${FADADA_PROVIDER_DEPENDENCY_MISSING}: Fadada auto seal dependencies are not wired`);
    }
    const platformSlots = resolveStage1PlatformSlots(input);
    const providerContractId = input.providerEnvelopeId ?? input.taskNo;
    const platformCustomerId = input.platformCustomerId ?? this.config.platformCustomerId;
    const platformSignatureId = input.platformSignatureId ?? this.config.platformSignatureId ?? input.sealId;
    if (!platformCustomerId || !platformSignatureId) {
      throw new Error(`${FADADA_PLATFORM_AUTO_SEAL_CONFIG_MISSING}: platform customer and signature IDs are required`);
    }

    const signaturePositions = platformSlots.map((slot) => {
      const coordinate = findSlotCoordinate(input.signingSlotCoordinates, slot.slotId);
      if (!coordinate) {
        throw new Error(`${FADADA_STAGE1_PLATFORM_SLOT_COORDINATES_MISSING}: ${slot.slotId}`);
      }
      return {
        pagenum: coordinate.pageNumber,
        x: coordinate.x,
        y: coordinate.y
      };
    });

    const result = await this.apiClient.autoSealContract({
      contractId: providerContractId,
      customerId: platformCustomerId,
      docTitle: input.documentName,
      notifyUrl: input.callbackUrl ?? this.config.signNotifyUrl,
      signatureId: platformSignatureId,
      signaturePositions,
      transactionId: input.transactionId
    });
    const completed = isSuccessfulAutoSealResult(result.resultCode);

    return {
      coveredSlotIds: STAGE1_PLATFORM_SLOT_IDS,
      providerActionType: "PLATFORM_AUTO_SEAL",
      providerSignerId: result.transactionId,
      providerTransactionId: result.transactionId,
      rawResponse: result.raw,
      resultCode: result.resultCode,
      resultDescription: result.resultDesc,
      signingStage: "STAGE1_CONTRACT",
      status: completed ? "COMPLETED" : "FAILED"
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

  private async findVerifiedProviderCustomerId(customerId: string) {
    if (!this.prisma) {
      return undefined;
    }

    const account = await this.prisma.customerESignProviderAccount.findFirst({
      select: { providerCustomerId: true },
      where: {
        accountType: ESignProviderAccountType.PERSONAL,
        customerId,
        deletedAt: null,
        provider: ESignProviderType.FADADA,
        providerCustomerId: { not: null },
        certBindingStatus: ESignProviderCertBindingStatus.BOUND,
        realNameProviderStatusSource: { not: ESignProviderRealNameStatusSource.UNKNOWN },
        realNameStatus: ESignRealNameStatus.VERIFIED,
        registrationStatus: ESignProviderAccountStatus.REGISTERED
      }
    });

    return account?.providerCustomerId ?? undefined;
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

function resolveStage1CustomerSlots(input: CreateSignTaskInput) {
  const slots = input.signingSlots ?? [];
  const customerSlots = STAGE1_CUSTOMER_SLOT_IDS.map((slotId) => {
    const slot = slots.find((item) =>
      item.slotId === slotId &&
      item.signingStage === "STAGE1_CONTRACT" &&
      item.providerActionType === "CUSTOMER_MANUAL_SIGN" &&
      item.signerRole === "CUSTOMER"
    );
    if (!slot) {
      throw new Error(`${FADADA_STAGE1_CUSTOMER_SLOT_MISSING}: ${slotId}`);
    }
    return slot;
  });

  return customerSlots;
}

function resolveStage1PlatformSlots(input: AutoSealTaskInput) {
  const slots = input.signingSlots ?? [];
  const platformSlots = STAGE1_PLATFORM_SLOT_IDS.map((slotId) => {
    const slot = slots.find((item) =>
      item.slotId === slotId &&
      item.signingStage === "STAGE1_CONTRACT" &&
      item.providerActionType === "PLATFORM_AUTO_SEAL" &&
      item.signerRole === "PLATFORM"
    );
    if (!slot) {
      throw new Error(`${FADADA_STAGE1_PLATFORM_SLOT_MISSING}: ${slotId}`);
    }
    return slot;
  });

  return platformSlots;
}

function resolveStage2CustomerSlot(input: CreateSignTaskInput): ESignSigningSlot {
  return resolveStage2ActionSlot({
    documentType: input.documentType,
    errorCode: FADADA_STAGE2_CUSTOMER_MAPPING_INVALID,
    expectedAction: "CUSTOMER_MANUAL_SIGN",
    expectedRole: "CUSTOMER",
    expectedSlotId: STAGE2_CUSTOMER_SLOT_ID,
    slots: input.signingSlots
  });
}

function resolveStage2PlatformSlot(input: AutoSealTaskInput): ESignSigningSlot {
  return resolveStage2ActionSlot({
    documentType: input.documentType,
    errorCode: FADADA_STAGE2_PLATFORM_MAPPING_INVALID,
    expectedAction: "PLATFORM_AUTO_SEAL",
    expectedRole: "PLATFORM",
    expectedSlotId: STAGE2_PLATFORM_SLOT_ID,
    slots: input.signingSlots
  });
}

function resolveStage2ActionSlot(input: {
  documentType: CreateSignTaskInput["documentType"];
  errorCode: string;
  expectedAction: ESignSigningSlot["providerActionType"];
  expectedRole: ESignSigningSlot["signerRole"];
  expectedSlotId: ESignSlotId;
  slots: ESignSigningSlot[] | undefined;
}) {
  const slots = input.slots ?? [];
  const slot = slots[0];
  if (
    input.documentType !== "DELIVERY_HANDOVER" ||
    slots.length !== 1 ||
    !slot ||
    slot.documentType !== "DELIVERY_HANDOVER" ||
    slot.providerActionType !== input.expectedAction ||
    slot.required === false ||
    slot.signerRole !== input.expectedRole ||
    slot.signingStage !== "STAGE2_DELIVERY_HANDOVER" ||
    slot.slotId !== input.expectedSlotId
  ) {
    throw new Error(`${input.errorCode}: Stage 2 slot mapping does not match the requested action`);
  }

  return slot;
}

function resolveStage2ArtifactCoordinate(
  coordinates: ResolvedContractPdfArtifactSlotCoordinate[] | undefined,
  slotId: typeof STAGE2_CUSTOMER_SLOT_ID
) {
  const requiredSlotIds = [STAGE2_CUSTOMER_SLOT_ID, STAGE2_PLATFORM_SLOT_ID] as const;
  if (!coordinates || coordinates.length !== requiredSlotIds.length) {
    throw new Error(
      `${FADADA_STAGE2_CUSTOMER_COORDINATE_INVALID}: complete Stage 2 artifact coordinates are required`
    );
  }

  for (const requiredSlotId of requiredSlotIds) {
    const matches = coordinates.filter((coordinate) => coordinate.slotId === requiredSlotId);
    if (
      matches.length !== 1 ||
      matches[0]?.documentType !== "DELIVERY_HANDOVER" ||
      matches[0]?.signingStage !== "STAGE2_DELIVERY_HANDOVER" ||
      !isValidProviderCoordinate(matches[0])
    ) {
      throw new Error(
        `${FADADA_STAGE2_CUSTOMER_COORDINATE_INVALID}: ${requiredSlotId} coordinate is invalid`
      );
    }
  }

  return coordinates.find((coordinate) => coordinate.slotId === slotId)!;
}

function resolveSingleStage2ProviderCoordinate(
  coordinates: ESignSigningSlotCoordinate[] | undefined,
  slotId: typeof STAGE2_PLATFORM_SLOT_ID
) {
  if (
    coordinates?.length !== 1 ||
    coordinates[0]?.slotId !== slotId ||
    !isValidProviderCoordinate(coordinates[0])
  ) {
    throw new Error(
      `${FADADA_STAGE2_PLATFORM_MAPPING_INVALID}: exactly one valid platform coordinate is required`
    );
  }

  return coordinates[0];
}

function assertStage2CustomerInputCoordinate(
  coordinates: ESignSigningSlotCoordinate[] | undefined,
  persistedCoordinate: ResolvedContractPdfArtifactSlotCoordinate
) {
  if (coordinates === undefined) {
    return;
  }

  const coordinate = coordinates[0];
  if (
    coordinates.length !== 1 ||
    coordinate?.slotId !== STAGE2_CUSTOMER_SLOT_ID ||
    !isValidProviderCoordinate(coordinate) ||
    coordinate.pageNumber !== persistedCoordinate.pageNumber ||
    coordinate.x !== persistedCoordinate.x ||
    coordinate.y !== persistedCoordinate.y
  ) {
    throw new Error(
      `${FADADA_STAGE2_CUSTOMER_COORDINATE_INVALID}: input coordinate must match the persisted customer coordinate`
    );
  }
}

function isValidProviderCoordinate(
  coordinate: Pick<ESignSigningSlotCoordinate, "pageNumber" | "x" | "y"> | undefined
) {
  return Boolean(
    coordinate &&
    Number.isInteger(coordinate.pageNumber) &&
    coordinate.pageNumber >= 0 &&
    isFiniteNumberInRange(coordinate.x, 0, 800) &&
    isFiniteNumberInRange(coordinate.y, 0, 1131)
  );
}

function findSlotCoordinate(
  coordinates: ReadonlyArray<Pick<ESignSigningSlotCoordinate, "pageNumber" | "slotId" | "x" | "y">> | undefined,
  slotId: ESignSlotId
) {
  return coordinates?.find((coordinate) =>
    coordinate.slotId === slotId &&
    Number.isInteger(coordinate.pageNumber) &&
    coordinate.pageNumber >= 0 &&
    isFiniteNumberInRange(coordinate.x, 0, 800) &&
    isFiniteNumberInRange(coordinate.y, 0, 1131)
  );
}

function isSuccessfulAutoSealResult(resultCode: string | undefined) {
  return resultCode === "1000";
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

function isFiniteNumberInRange(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function buildTransactionId(taskNo: string, index: number) {
  const suffix = `S${index}`;
  return buildTransactionIdWithSuffix(taskNo, suffix);
}

function buildStage2TransactionId(taskNo: string, suffix: "H1" | "H2") {
  return buildTransactionIdWithSuffix(taskNo, suffix);
}

function buildTransactionIdWithSuffix(taskNo: string, suffix: string) {
  const maxBaseLength = 32 - suffix.length;
  const normalizedTaskNo = taskNo.replace(/[^A-Za-z0-9]/g, "");
  if (!normalizedTaskNo || maxBaseLength <= 0) {
    throw new Error(`${FADADA_TRANSACTION_ID_INVALID}: taskNo cannot produce a safe transaction_id`);
  }
  const transactionId = `${normalizedTaskNo.slice(0, maxBaseLength)}${suffix}`;
  assertFadadaTransactionId(transactionId);
  return transactionId;
}

function isExpired(value: Date | null | undefined) {
  return value ? value.getTime() <= Date.now() : false;
}
