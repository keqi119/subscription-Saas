import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import {
  ContractStatus,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  ESignDocumentType,
  ESignProviderActionType,
  ESignSignerStatus,
  ESignSignerType,
  ESignSigningStage,
  ESignSlotId,
  ESignTaskStatus,
  Prisma
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { DeliveryEvidenceService } from "../delivery-evidence/delivery-evidence.service";
import { hasCompleteStage2HandoverArchive } from "./stage2-handover-archive-state";

export const STAGE2_DELIVERY_HANDOVER_SIGNING_STAGE = "STAGE2_DELIVERY_HANDOVER" as const;
export const STAGE2_HANDOVER_CUSTOMER_SLOT_ID = "STAGE2_HANDOVER_CUSTOMER" as const;
export const STAGE2_HANDOVER_PLATFORM_SLOT_ID = "STAGE2_HANDOVER_PLATFORM" as const;
export const DELIVERY_HANDOVER_ARCHIVE_BLOCKS_DELIVERY_CONFIRMATION = false;
export const DELIVERY_HANDOVER_NOT_READY_MESSAGE = "交付交接确认书尚未完成签署。";
export const DELIVERY_HANDOVER_ARCHIVE_WARNING_MESSAGE = "交付交接确认书已签署，已签 PDF 尚未完成归档。";

const TERMINAL_HANDOVER_STATUSES = [
  DeliveryHandoverStatus.CANCELLED,
  DeliveryHandoverStatus.FAILED
] as const;

type DeliveryHandoverRecord = Prisma.VehicleDeliveryHandoverGetPayload<object>;
type DeliveryHandoverDb = Prisma.TransactionClient | PrismaService;

export const deliveryHandoverConfirmationInclude = {
  handoverContract: {
    select: {
      deletedAt: true,
      fileId: true,
      id: true,
      status: true
    }
  },
  handoverESignTask: {
    include: {
      signers: true
    }
  }
} satisfies Prisma.VehicleDeliveryHandoverInclude;

export async function findDeliveryHandoverForConfirmation(
  db: DeliveryHandoverDb,
  orderId: string
) {
  const handover = await db.vehicleDeliveryHandover.findFirst({
    include: deliveryHandoverConfirmationInclude,
    orderBy: { createdAt: "desc" },
    where: {
      deletedAt: null,
      orderId,
      status: { notIn: [...TERMINAL_HANDOVER_STATUSES] }
    }
  });
  if (!handover) {
    return null;
  }

  const fileSelect = {
    id: true,
    mimeType: true,
    objectKey: true,
    sizeBytes: true
  } as const;
  const [sourceDocumentFile, signedDocumentFile] = await Promise.all([
    handover.sourceDocumentFileId
      ? db.fileObject.findUnique({
          select: fileSelect,
          where: { id: handover.sourceDocumentFileId }
        })
      : null,
    handover.signedDocumentFileId
      ? db.fileObject.findUnique({
          select: fileSelect,
          where: { id: handover.signedDocumentFileId }
        })
      : null
  ]);
  return {
    ...handover,
    signedDocumentFile,
    sourceDocumentFile
  };
}

type DeliveryHandoverConfirmationRecord = NonNullable<
  Awaited<ReturnType<typeof findDeliveryHandoverForConfirmation>>
>;

@Injectable()
export class DeliveryHandoverService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly deliveryEvidenceService?: DeliveryEvidenceService
  ) {}

  async getOrCreateDraftHandover(
    orderId: string,
    actorId?: string,
    db: DeliveryHandoverDb = this.prisma
  ) {
    const existing = await this.findActiveHandover(orderId, db);
    if (existing) {
      return existing;
    }

    return this.createHandoverRecord(orderId, actorId, db);
  }

  async validateStage2Prerequisites(orderId: string, db: DeliveryHandoverDb = this.prisma) {
    const order = await db.subscriptionOrder.findUnique({
      include: {
        contract: true,
        deliveries: {
          orderBy: { createdAt: "desc" },
          take: 1,
          where: { deletedAt: null }
        }
      },
      where: { id: orderId }
    });

    if (!order || order.deletedAt) {
      throw new NotFoundException("订单不存在。");
    }
    if (
      !order.contract ||
      order.contract.deletedAt ||
      (
        order.contract.status !== ContractStatus.SIGNED &&
        order.contract.status !== ContractStatus.ARCHIVED
      )
    ) {
      throw new BadRequestException("Stage 1 合同尚未签署，不能创建交付交接签署。");
    }

    return {
      orderId: order.id,
      stage1ContractId: order.contract.id,
      vehicleDeliveryId: order.deliveries?.[0]?.id ?? null
    };
  }

  async linkStage1Contract(orderId: string) {
    return (await this.validateStage2Prerequisites(orderId)).stage1ContractId;
  }

  async createHandoverRecord(
    orderId: string,
    actorId?: string,
    db: DeliveryHandoverDb = this.prisma
  ) {
    const existing = await this.findActiveHandover(orderId, db);
    if (existing) {
      throw new BadRequestException("该订单已存在进行中的交付交接签署记录。");
    }

    const prerequisites = await this.validateStage2Prerequisites(orderId, db);
    return db.vehicleDeliveryHandover.create({
      data: {
        archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED,
        createdBy: actorId,
        orderId,
        snapshot: toJsonValue({
          archiveBlocksDeliveryConfirmation: DELIVERY_HANDOVER_ARCHIVE_BLOCKS_DELIVERY_CONFIRMATION,
          archiveRetryRequired: true,
          stage1ContractId: prerequisites.stage1ContractId
        }),
        stage1ContractId: prerequisites.stage1ContractId,
        status: DeliveryHandoverStatus.DRAFT,
        updatedBy: actorId,
        vehicleDeliveryId: prerequisites.vehicleDeliveryId
      }
    });
  }

  async markSourceGenerated(id: string, input: {
    handoverContractId?: string | null;
    sourceDocumentFileId?: string | null;
    sourceObjectKey?: string | null;
    updatedBy?: string;
  }) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        handoverContractId: input.handoverContractId,
        sourceDocumentFileId: input.sourceDocumentFileId,
        sourceObjectKey: input.sourceObjectKey,
        status: DeliveryHandoverStatus.SOURCE_GENERATED,
        updatedBy: input.updatedBy
      },
      where: { id }
    });
  }

  async markSigningStarted(id: string, input: {
    handoverESignTaskId?: string | null;
    updatedBy?: string;
  }) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        handoverESignTaskId: input.handoverESignTaskId,
        status: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
        updatedBy: input.updatedBy
      },
      where: { id }
    });
  }

  async markCustomerSigned(id: string, signedAt: Date, actorId?: string) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        customerSignedAt: signedAt,
        status: DeliveryHandoverStatus.PENDING_PLATFORM_SEAL,
        updatedBy: actorId
      },
      where: { id }
    });
  }

  async markPlatformSigned(id: string, signedAt: Date, actorId?: string) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        platformSignedAt: signedAt,
        updatedBy: actorId
      },
      where: { id }
    });
  }

  async markCompleted(id: string, completedAt: Date, actorId?: string) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        completedAt,
        status: DeliveryHandoverStatus.SIGNED,
        updatedBy: actorId
      },
      where: { id }
    });
  }

  async markArchived(id: string, input: {
    archivedAt: Date;
    signedDocumentFileId?: string | null;
    signedObjectKey?: string | null;
    updatedBy?: string;
  }) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        archivedAt: input.archivedAt,
        signedDocumentFileId: input.signedDocumentFileId,
        signedObjectKey: input.signedObjectKey,
        status: DeliveryHandoverStatus.ARCHIVED,
        updatedBy: input.updatedBy
      },
      where: { id }
    });
  }

  async markFailed(id: string, failureReason: string, actorId?: string) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
        failedAt: new Date(),
        failureReason,
        status: DeliveryHandoverStatus.FAILED,
        updatedBy: actorId
      },
      where: { id }
    });
  }

  async markArchiveFailed(id: string, failureReason: string, actorId?: string) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
        failedAt: new Date(),
        failureReason,
        updatedBy: actorId
      },
      where: { id }
    });
  }

  async markCancelled(id: string, actorId?: string) {
    return this.prisma.vehicleDeliveryHandover.update({
      data: {
        cancelledAt: new Date(),
        status: DeliveryHandoverStatus.CANCELLED,
        updatedBy: actorId
      },
      where: { id }
    });
  }

  async assertDeliveryCanBeConfirmed(
    orderId: string,
    db: DeliveryHandoverDb,
    currentEvidenceManifestDigest: string
  ) {
    const handover = await findDeliveryHandoverForConfirmation(
      db,
      orderId
    );
    assertDeliveryHandoverReadyForDelivery(
      handover,
      currentEvidenceManifestDigest
    );
    if (this.deliveryEvidenceService) {
      await this.deliveryEvidenceService.assertEvidenceReadyForDeliveryConfirmation(
        orderId,
        handover?.id ?? null,
        db
      );
    }
  }

  async assertStage2PdfCanBeGenerated(orderId: string, handoverId?: string | null) {
    if (!this.deliveryEvidenceService) {
      return;
    }
    await this.deliveryEvidenceService.assertEvidenceReadyForStage2Pdf(orderId, handoverId);
  }

  async assertStage2ESignCanStart(orderId: string, handoverId?: string | null) {
    if (!this.deliveryEvidenceService) {
      return;
    }
    await this.deliveryEvidenceService.assertEvidenceReadyForStage2ESign(orderId, handoverId);
  }

  private findActiveHandover(orderId: string, db: DeliveryHandoverDb = this.prisma) {
    return db.vehicleDeliveryHandover.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        orderId,
        status: { notIn: [...TERMINAL_HANDOVER_STATUSES] }
      }
    });
  }
}

export function assertDeliveryHandoverReadyForDelivery(
  handover: DeliveryHandoverConfirmationRecord | null | undefined,
  currentEvidenceManifestDigest: string
) {
  if (
    !isDeliveryHandoverReadyForDelivery(handover) ||
    handover?.manifestHash !== currentEvidenceManifestDigest
  ) {
    throw new BadRequestException(DELIVERY_HANDOVER_NOT_READY_MESSAGE);
  }
}

export function isDeliveryHandoverReadyForDelivery(
  handover: DeliveryHandoverConfirmationRecord | null | undefined
) {
  if (!handover || handover.deletedAt) {
    return false;
  }
  const signed = handover.status === DeliveryHandoverStatus.SIGNED ||
    handover.status === DeliveryHandoverStatus.ARCHIVED;
  if (!signed) {
    return false;
  }
  return hasCompleteStage2SigningState(handover);
}

export function isDeliveryHandoverSigned(
  handover: Pick<
    DeliveryHandoverRecord,
    "deletedAt" | "status"
  > | null | undefined
) {
  return Boolean(
    handover &&
      !handover.deletedAt &&
      (handover.status === DeliveryHandoverStatus.SIGNED || handover.status === DeliveryHandoverStatus.ARCHIVED)
  );
}

export function getDeliveryHandoverArchiveWarning(handover: Pick<
  DeliveryHandoverConfirmationRecord,
  | "archiveStatus"
  | "archivedAt"
  | "artifactVersion"
  | "completedAt"
  | "customerSignedAt"
  | "deletedAt"
  | "failureReason"
  | "handoverContract"
  | "handoverContractId"
  | "handoverESignTask"
  | "handoverESignTaskId"
  | "id"
  | "manifestHash"
  | "orderId"
  | "platformSignedAt"
  | "signedDocumentFileId"
  | "signedDocumentFile"
  | "signedObjectKey"
  | "signedPdfHash"
  | "sourceDocumentFileId"
  | "sourceDocumentFile"
  | "sourceObjectKey"
  | "sourcePdfHash"
  | "status"
> | null | undefined) {
  if (!handover || !hasCompleteStage2SigningState(handover)) {
    return null;
  }
  if (hasCompleteStage2ArchiveState(handover)) {
    return null;
  }
  if (handover?.archiveStatus === DeliveryHandoverArchiveStatus.FAILED) {
    return handover.failureReason
      ? `交付交接确认书已签署，已签 PDF 归档失败：${handover.failureReason}`
      : "交付交接确认书已签署，已签 PDF 归档失败，请重试归档。";
  }
  return DELIVERY_HANDOVER_ARCHIVE_WARNING_MESSAGE;
}

function hasCompleteStage2SigningState(
  handover: Pick<
    DeliveryHandoverConfirmationRecord,
    | "artifactVersion"
    | "completedAt"
    | "customerSignedAt"
    | "handoverContract"
    | "handoverContractId"
    | "handoverESignTask"
    | "handoverESignTaskId"
    | "id"
    | "manifestHash"
    | "orderId"
    | "platformSignedAt"
    | "sourceDocumentFileId"
    | "sourceDocumentFile"
    | "sourceObjectKey"
    | "sourcePdfHash"
  >
) {
  const contract = handover.handoverContract;
  const task = handover.handoverESignTask;
  if (
    !handover.completedAt ||
    !handover.customerSignedAt ||
    !handover.platformSignedAt ||
    !contract ||
    contract.deletedAt ||
    contract.id !== handover.handoverContractId ||
    contract.fileId !== handover.sourceDocumentFileId ||
    (
      contract.status !== ContractStatus.SIGNED &&
      contract.status !== ContractStatus.ARCHIVED
    ) ||
    !task ||
    task.deletedAt ||
    task.id !== handover.handoverESignTaskId ||
    task.contractId !== handover.handoverContractId ||
    task.orderId !== handover.orderId ||
    task.documentType !== ESignDocumentType.DELIVERY_HANDOVER ||
    task.signingStage !== ESignSigningStage.STAGE2_DELIVERY_HANDOVER ||
    task.taskStatus !== ESignTaskStatus.COMPLETED ||
    !task.completedAt ||
    !hasSha256(handover.manifestHash) ||
    !hasSha256(handover.sourcePdfHash) ||
    !Number.isInteger(handover.artifactVersion) ||
    handover.artifactVersion < 1 ||
    !handover.sourceDocumentFileId ||
    !hasPdfFileIdentity(
      handover.sourceDocumentFile,
      handover.sourceDocumentFileId,
      handover.sourceObjectKey
    )
  ) {
    return false;
  }

  const snapshot = asRecord(task.requestSnapshot);
  if (
    snapshot?.artifactVersion !== handover.artifactVersion ||
    snapshot?.contractId !== task.contractId ||
    snapshot.contractId !== handover.handoverContractId ||
    snapshot?.handoverId !== handover.id ||
    snapshot?.manifestHash !== handover.manifestHash ||
    snapshot?.sourceDocumentFileId !== handover.sourceDocumentFileId ||
    snapshot?.sourcePdfHash !== handover.sourcePdfHash
  ) {
    return false;
  }

  if (
    task.signers.length !== 2 ||
    task.signers.some((signer) => signer.deletedAt !== null)
  ) {
    return false;
  }
  const customerSigners = task.signers.filter((signer) =>
    signerMatchesRequiredTuple(
      signer,
      ESignSlotId.STAGE2_HANDOVER_CUSTOMER,
      ESignSignerType.CUSTOMER,
      ESignProviderActionType.CUSTOMER_MANUAL_SIGN
    )
  );
  const platformSigners = task.signers.filter((signer) =>
    signerMatchesRequiredTuple(
      signer,
      ESignSlotId.STAGE2_HANDOVER_PLATFORM,
      ESignSignerType.PLATFORM,
      ESignProviderActionType.PLATFORM_AUTO_SEAL
    )
  );
  const customerSigner = customerSigners[0];
  const platformSigner = platformSigners[0];
  const customerTransactionId = buildStage2TransactionId(task.taskNo, "H1");
  const platformTransactionId = buildStage2TransactionId(task.taskNo, "H2");
  return Boolean(
    customerSigners.length === 1 &&
    platformSigners.length === 1 &&
    customerSigner?.customerId === task.customerId &&
    signerCompleted(customerSigner, customerTransactionId) &&
    signerCompleted(platformSigner, platformTransactionId)
  );
}

function hasCompleteStage2ArchiveState(
  handover: Pick<
    DeliveryHandoverConfirmationRecord,
    | "archiveStatus"
    | "archivedAt"
    | "handoverESignTask"
    | "signedDocumentFileId"
    | "signedDocumentFile"
    | "signedObjectKey"
    | "signedPdfHash"
    | "status"
  >
) {
  return Boolean(
    hasCompleteStage2HandoverArchive(handover) &&
    handover.archivedAt &&
    hasPdfFileIdentity(
      handover.signedDocumentFile,
      handover.signedDocumentFileId!,
      handover.signedObjectKey!
    ) &&
    handover.handoverESignTask?.signedDocumentObjectKey ===
      handover.signedObjectKey
  );
}

type DeliveryHandoverSigner = NonNullable<
  DeliveryHandoverConfirmationRecord["handoverESignTask"]
>["signers"][number];

function signerMatchesRequiredTuple(
  signer: DeliveryHandoverSigner,
  slotId: ESignSlotId,
  signerType: ESignSignerType,
  providerActionType: ESignProviderActionType
) {
  return (
    signer.deletedAt === null &&
    signer.documentType === ESignDocumentType.DELIVERY_HANDOVER &&
    signer.providerActionType === providerActionType &&
    signer.required === true &&
    signer.signerType === signerType &&
    signer.slotId === slotId
  );
}

function buildStage2TransactionId(
  taskNo: string | null | undefined,
  suffix: "H1" | "H2"
) {
  if (!taskNo) {
    return null;
  }
  const normalized = taskNo.replace(/[^A-Za-z0-9]/g, "");
  return normalized
    ? `${normalized.slice(0, 32 - suffix.length)}${suffix}`
    : null;
}

function signerCompleted(
  signer: DeliveryHandoverSigner | undefined,
  expectedTransactionId: string | null
) {
  return Boolean(
    signer &&
    expectedTransactionId &&
    signer.signedAt &&
    signer.signerStatus === ESignSignerStatus.SIGNED &&
    signer.providerTransactionId === expectedTransactionId
  );
}

function hasSha256(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function hasPdfFileIdentity(
  file: DeliveryHandoverConfirmationRecord["sourceDocumentFile"],
  expectedId: string,
  expectedObjectKey: string | null
) {
  return Boolean(
    file &&
    file.id === expectedId &&
    file.mimeType?.trim().toLowerCase() === "application/pdf" &&
    file.objectKey === expectedObjectKey &&
    file.sizeBytes > 0n
  );
}

function asRecord(value: unknown) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isDeliveryHandoverArchived(
  handover: Pick<DeliveryHandoverRecord, "archiveStatus" | "deletedAt"> | null | undefined
) {
  return Boolean(
    handover &&
      !handover.deletedAt &&
      handover.archiveStatus === DeliveryHandoverArchiveStatus.ARCHIVED
  );
}

function toJsonValue(value: unknown) {
  return value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}
