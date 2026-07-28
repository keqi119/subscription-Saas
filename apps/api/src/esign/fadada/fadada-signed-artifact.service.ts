import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  ESignDocumentType,
  ESignProviderActionType,
  ESignProviderType,
  ESignSignerStatus,
  ESignSignerType,
  ESignSigningStage,
  ESignSlotId,
  ESignTaskStatus,
  Prisma
} from "@prisma/client";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import { RequestUser } from "../../auth/auth.types";
import {
  hasAuthoritativeStage2HandoverRelation,
  hasCompleteStage2HandoverArchive
} from "../../delivery-handover/stage2-handover-archive-state";
import { PrismaService } from "../../prisma/prisma.service";
import { CurrentCustomer } from "../../portal/portal-auth.types";
import { StorageService } from "../../storage/storage.service";
import { FadadaApiClient } from "./fadada-api.client";
import { loadFadadaConfig } from "./fadada.config";
import { FadadaHttpClient } from "./fadada-http-client";

export const FADADA_ARCHIVE_INVALID_TASK = "FADADA_ARCHIVE_INVALID_TASK";
export const FADADA_ARCHIVE_PROVIDER_CONTRACT_MISSING = "FADADA_ARCHIVE_PROVIDER_CONTRACT_MISSING";
export const FADADA_ARCHIVE_SIGNED_PDF_MISSING = "FADADA_ARCHIVE_SIGNED_PDF_MISSING";
export const FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF = "FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF";
export const FADADA_ARCHIVE_SIGNED_PDF_TOO_LARGE = "FADADA_ARCHIVE_SIGNED_PDF_TOO_LARGE";
export const STAGE2_HANDOVER_ARCHIVE_INVALID_TASK = "STAGE2_HANDOVER_ARCHIVE_INVALID_TASK";
export const STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH = "STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH";
export const STAGE2_HANDOVER_ARCHIVE_PROVIDER_FAILED = "STAGE2_HANDOVER_ARCHIVE_PROVIDER_FAILED";
export const STAGE2_HANDOVER_ARCHIVE_INCONSISTENT =
  "STAGE2_HANDOVER_ARCHIVE_INCONSISTENT";
export const STAGE2_HANDOVER_ARCHIVE_TYPED_ENDPOINT_REQUIRED =
  "STAGE2_HANDOVER_ARCHIVE_TYPED_ENDPOINT_REQUIRED";

const MAX_SIGNED_PDF_BYTES = 20 * 1024 * 1024;
const DEFAULT_STAGE2_ARCHIVE_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_STAGE2_ARCHIVE_CLAIM_TIMEOUT_MS = 1000;
const MAX_STAGE2_ARCHIVE_CLAIM_TIMEOUT_MS = 60 * 60 * 1000;
const STAGE2_ARCHIVE_CLAIM_TIMEOUT_ENV =
  "STAGE2_HANDOVER_ARCHIVE_CLAIM_TIMEOUT_MS";

const signedArtifactTaskInclude = {
  contract: {
    include: {
      order: {
        include: {
          application: { select: { salesUserId: true } }
        }
      }
    }
  },
  deliveryHandover: true,
  signers: {
    where: { deletedAt: null }
  }
} satisfies Prisma.ContractESignTaskInclude;

type SignedArtifactTask = Prisma.ContractESignTaskGetPayload<{ include: typeof signedArtifactTaskInclude }>;

export interface FadadaSignedArtifactApi {
  createContractFiling(input: { contractId: string }): Promise<{
    contractId: string;
    filingNo?: string;
    raw: unknown;
  }>;
  downloadSignedContract(input: { contractId: string; downloadUrl?: string }): Promise<{
    buffer: Buffer;
    contentType: string;
    fileName: string;
    raw?: unknown;
  }>;
  queryContractStatus(input: { contractId: string }): Promise<{
    contractId: string;
    raw: unknown;
    status?: string;
  }>;
  querySignResult(input: { contractId: string; customerId?: string; transactionId?: string }): Promise<{
    contractId: string;
    downloadUrl?: string;
    raw: unknown;
    resultCode?: string;
    resultDesc?: string;
    status?: "SIGNED" | "SIGNING" | "FAILED" | "UNKNOWN";
    transactionId?: string;
    viewPdfUrl?: string;
  }>;
}

export interface FadadaSignedContractPreview {
  contentType: "application/pdf";
  filename: string;
  sizeBytes: number;
  stream: Readable;
}

@Injectable()
export class FadadaSignedArtifactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService
  ) {}

  async archiveSignedContract(input: {
    force?: boolean;
    taskId: string;
  }): Promise<{
    archived: boolean;
    evidenceObjectKey?: string | null;
    signedPdfObjectKey?: string;
    skippedReason?: string;
  }> {
    const task = await this.findTaskByIdOrThrow(input.taskId);
    if (
      hasAuthoritativeStage2HandoverRelation(task.deliveryHandover) ||
      task.signingStage === ESignSigningStage.STAGE2_DELIVERY_HANDOVER ||
      task.documentType === ESignDocumentType.DELIVERY_HANDOVER
    ) {
      throw new BadRequestException({
        code: STAGE2_HANDOVER_ARCHIVE_TYPED_ENDPOINT_REQUIRED,
        message:
          `${STAGE2_HANDOVER_ARCHIVE_TYPED_ENDPOINT_REQUIRED}: ` +
          "Stage 2 handover tasks must use the typed handover archive workflow."
      });
    }
    this.assertArchiveableTask(task, Boolean(input.force));

    if (task.signedDocumentObjectKey && !input.force) {
      return {
        archived: false,
        evidenceObjectKey: task.evidenceObjectKey,
        signedPdfObjectKey: task.signedDocumentObjectKey,
        skippedReason: "SIGNED_PDF_ALREADY_ARCHIVED"
      };
    }

    const providerContractId = task.providerEnvelopeId;
    if (!providerContractId) {
      throw new BadRequestException(`${FADADA_ARCHIVE_PROVIDER_CONTRACT_MISSING}: missing Fadada contract_id`);
    }

    const apiClient = this.getApiClient();
    const providerCustomerId = findProviderCustomerId(task);
    const signResult = await apiClient.querySignResult({
      contractId: providerContractId,
      ...(providerCustomerId ? { customerId: providerCustomerId } : {}),
      ...(task.providerTaskId ? { transactionId: task.providerTaskId } : {})
    });
    const contractStatus = signResult.resultCode
      ? null
      : await apiClient.queryContractStatus({ contractId: providerContractId });
    const signedPdf = await apiClient.downloadSignedContract({
      contractId: providerContractId,
      downloadUrl: signResult.downloadUrl
    });
    assertSignedPdf(signedPdf.buffer);

    const stored = await this.storageService.putContractSignedArtifact({
      buffer: signedPdf.buffer,
      contentType: "application/pdf",
      contractId: task.contractId,
      metadata: {
        provider: "fadada",
        providerContractId,
        providerTaskId: task.providerTaskId ?? ""
      },
      originalName: `${sanitizeFileName(task.contract.contractNo)}-signed.pdf`,
      provider: "fadada"
    });

    let filing: Awaited<ReturnType<FadadaSignedArtifactApi["createContractFiling"]>>;
    try {
      filing = await apiClient.createContractFiling({ contractId: providerContractId });
    } catch (error) {
      filing = {
        contractId: providerContractId,
        raw: {
          error: error instanceof Error ? error.message : String(error),
          skippedEvidenceReport: true
        }
      };
    }

    const responseSnapshot = mergeResponseSnapshot(task.responseSnapshot, {
      fadadaSignedArtifactArchive: sanitizeProviderPayload({
        archivedAt: new Date(),
        contractFiling: filing,
        contractStatus,
        querySignResult: signResult.raw,
        signedPdf: {
          fileName: signedPdf.fileName,
          objectKeyPresent: true,
          size: signedPdf.buffer.length
        }
      })
    });

    await this.prisma.contractESignTask.update({
      data: {
        evidenceObjectKey: task.evidenceObjectKey,
        responseSnapshot: toJsonValue(responseSnapshot),
        signedDocumentObjectKey: stored.objectKey
      },
      where: { id: task.id }
    });

    return {
      archived: true,
      evidenceObjectKey: task.evidenceObjectKey,
      signedPdfObjectKey: stored.objectKey
    };
  }

  async archiveSignedStage2Handover(input: {
    actorId?: string;
    taskId: string;
  }): Promise<{
    archiveStatus: DeliveryHandoverArchiveStatus;
    archived: boolean;
    signedPdfHash?: string;
    skippedReason?: string;
  }> {
    const task = await this.findTaskByIdOrThrow(input.taskId);
    let handover = assertStage2ArchiveableTask(task);
    assertStage2ArchiveSourceBinding(task, handover);

    if (
      handover.archiveStatus === DeliveryHandoverArchiveStatus.ARCHIVED &&
      !hasCompleteStage2HandoverArchive(handover)
    ) {
      handover = await this.recoverIncompleteStage2Archive(
        task,
        handover,
        input.actorId
      );
    }
    if (hasCompleteStage2HandoverArchive(handover)) {
      return {
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        archived: false,
        skippedReason: "SIGNED_PDF_ALREADY_ARCHIVED"
      };
    }
    const platformCustomerId =
      loadFadadaConfig(this.configService).platformCustomerId;
    if (!platformCustomerId) {
      throw new BadRequestException({
        code: "FADADA_PLATFORM_CUSTOMER_ID_REQUIRED",
        message: "FADADA_PLATFORM_CUSTOMER_ID is required for Stage 2 signed-PDF archival."
      });
    }
    const originalName = `${sanitizeFileName(task.contract.contractNo)}-signed.pdf`;
    const attemptedAt = new Date();
    const claimTimeoutMs = readStage2ArchiveClaimTimeoutMs(this.configService);
    const stalePendingClaim =
      handover.archiveStatus === DeliveryHandoverArchiveStatus.PENDING &&
      !isFreshStage2ArchiveClaim(
        handover.archiveLastAttemptAt,
        attemptedAt,
        claimTimeoutMs
      );
    if (
      handover.archiveStatus === DeliveryHandoverArchiveStatus.PENDING &&
      !stalePendingClaim
    ) {
      return {
        archiveStatus: DeliveryHandoverArchiveStatus.PENDING,
        archived: false,
        skippedReason: "ARCHIVE_IN_PROGRESS"
      };
    }

    const claimStateWhere = stalePendingClaim
      ? {
          archiveLastAttemptAt: handover.archiveLastAttemptAt,
          archiveStatus: DeliveryHandoverArchiveStatus.PENDING
        }
      : {
          archiveStatus: {
            in: [
              DeliveryHandoverArchiveStatus.NOT_STARTED,
              DeliveryHandoverArchiveStatus.FAILED
            ]
          }
        };
    const previousUnlinkedObjectKey = handover.signedDocumentFileId
      ? null
      : handover.signedObjectKey;
    const claimed = await this.prisma.vehicleDeliveryHandover.updateMany({
      data: {
        archiveLastAttemptAt: attemptedAt,
        archiveLastError: null,
        archiveRetryCount: { increment: 1 },
        archiveStatus: DeliveryHandoverArchiveStatus.PENDING
      },
      where: {
        ...claimStateWhere,
        artifactVersion: handover.artifactVersion,
        deletedAt: null,
        handoverContractId: task.contractId,
        handoverESignTaskId: task.id,
        id: handover.id,
        manifestHash: handover.manifestHash,
        sourceDocumentFileId: handover.sourceDocumentFileId,
        sourcePdfHash: handover.sourcePdfHash,
        status: DeliveryHandoverStatus.SIGNED
      }
    });
    if (claimed.count !== 1) {
      let current = await this.prisma.vehicleDeliveryHandover.findUnique({
        where: { id: handover.id }
      });
      if (
        current?.archiveStatus === DeliveryHandoverArchiveStatus.ARCHIVED &&
        !hasCompleteStage2HandoverArchive(current)
      ) {
        current = await this.recoverIncompleteStage2Archive(
          task,
          current,
          input.actorId
        );
      }
      if (hasCompleteStage2HandoverArchive(current)) {
        return {
          archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
          archived: false,
          skippedReason: "SIGNED_PDF_ALREADY_ARCHIVED"
        };
      }
      if (
        current?.status === DeliveryHandoverStatus.SIGNED &&
        (
          current.archiveStatus === DeliveryHandoverArchiveStatus.NOT_STARTED ||
          current.archiveStatus === DeliveryHandoverArchiveStatus.FAILED
        )
      ) {
        return this.archiveSignedStage2Handover(input);
      }
      if (
        current?.archiveStatus === DeliveryHandoverArchiveStatus.PENDING &&
        isFreshStage2ArchiveClaim(
          current.archiveLastAttemptAt,
          new Date(),
          claimTimeoutMs
        )
      ) {
        return {
          archiveStatus: DeliveryHandoverArchiveStatus.PENDING,
          archived: false,
          skippedReason: "ARCHIVE_IN_PROGRESS"
        };
      }
      throw stage2ArchiveBadRequest(
        STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH,
        "The Stage 2 archive source changed before the archive claim."
      );
    }

    let signedPdfHash: string | null = null;
    let storedArtifact: { bucket: string; objectKey: string } | null = null;
    try {
      if (previousUnlinkedObjectKey) {
        const cleared = await this.prisma.vehicleDeliveryHandover.updateMany({
          data: {
            signedObjectKey: null
          },
          where: {
            archiveLastAttemptAt: attemptedAt,
            archiveStatus: DeliveryHandoverArchiveStatus.PENDING,
            handoverESignTaskId: task.id,
            id: handover.id,
            signedDocumentFileId: null,
            signedObjectKey: previousUnlinkedObjectKey
          }
        });
        if (cleared.count !== 1) {
          throw new Error(STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH);
        }
        try {
          await this.storageService.deleteContractSignedArtifactObject(
            previousUnlinkedObjectKey
          );
        } catch (error) {
          await this.prisma.vehicleDeliveryHandover.updateMany({
            data: {
              signedObjectKey: previousUnlinkedObjectKey
            },
            where: {
              archiveLastAttemptAt: attemptedAt,
              archiveStatus: DeliveryHandoverArchiveStatus.PENDING,
              handoverESignTaskId: task.id,
              id: handover.id,
              signedDocumentFileId: null,
              signedObjectKey: null
            }
          });
          throw error;
        }
      }
      const providerContractId = task.providerEnvelopeId;
      if (!providerContractId) {
        throw new Error(FADADA_ARCHIVE_PROVIDER_CONTRACT_MISSING);
      }
      const platformSigner = task.signers.find(
        (signer) => signer.slotId === ESignSlotId.STAGE2_HANDOVER_PLATFORM
      )!;
      const apiClient = this.getApiClient();
      const signResult = await apiClient.querySignResult({
        contractId: providerContractId,
        customerId: platformCustomerId,
        transactionId: platformSigner.providerTransactionId!
      });
      const signedPdf = await apiClient.downloadSignedContract({
        contractId: providerContractId,
        downloadUrl: signResult.downloadUrl
      });
      assertStage2SignedPdf(signedPdf.buffer, signedPdf.contentType);
      signedPdfHash = createHash("sha256")
        .update(signedPdf.buffer)
        .digest("hex");
      const objectIdentity =
        `${task.id}-v${handover.artifactVersion}-${signedPdfHash}`;
      const plannedObjectKey =
        this.storageService.buildContractSignedArtifactObjectKey(
          task.contractId,
          "fadada",
          originalName,
          objectIdentity
        );
      const objectClaimed =
        await this.prisma.vehicleDeliveryHandover.updateMany({
          data: {
            signedObjectKey: plannedObjectKey
          },
          where: {
            archiveLastAttemptAt: attemptedAt,
            archiveStatus: DeliveryHandoverArchiveStatus.PENDING,
            artifactVersion: handover.artifactVersion,
            handoverContractId: task.contractId,
            handoverESignTaskId: task.id,
            id: handover.id,
            manifestHash: handover.manifestHash,
            signedDocumentFileId: null,
            signedObjectKey: null,
            sourceDocumentFileId: handover.sourceDocumentFileId,
            sourcePdfHash: handover.sourcePdfHash
          }
        });
      if (objectClaimed.count !== 1) {
        throw new Error(STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH);
      }
      const stored = await this.storageService.putContractSignedArtifact({
        buffer: signedPdf.buffer,
        contentType: "application/pdf",
        contractId: task.contractId,
        metadata: {
          artifactVersion: String(handover.artifactVersion),
          manifestHash: handover.manifestHash!,
          provider: "fadada",
          signedPdfHash,
          sourcePdfHash: handover.sourcePdfHash!
        },
        originalName,
        objectIdentity,
        provider: "fadada"
      });
      storedArtifact = stored;
      if (stored.objectKey !== plannedObjectKey) {
        throw new Error(STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH);
      }

      try {
        await apiClient.createContractFiling({ contractId: providerContractId });
      } catch {
        // Provider filing is advisory here; the signed PDF archive remains authoritative.
      }

      const archivedAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        const fileObject = await tx.fileObject.create({
          data: {
            bucket: stored.bucket,
            mimeType: "application/pdf",
            objectKey: stored.objectKey,
            originalName,
            sizeBytes: BigInt(signedPdf.buffer.length),
            uploadedBy: input.actorId ?? null
          }
        });
        await tx.contractESignTask.update({
          data: {
            signedDocumentObjectKey: stored.objectKey
          },
          where: { id: task.id }
        });
        const finalized = await tx.vehicleDeliveryHandover.updateMany({
          data: {
            archiveLastAttemptAt: archivedAt,
            archiveLastError: null,
            archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
            archivedAt,
            signedDocumentFileId: fileObject.id,
            signedObjectKey: stored.objectKey,
            signedPdfHash,
            status: DeliveryHandoverStatus.ARCHIVED,
            updatedBy: input.actorId ?? null
          },
          where: {
            archiveLastAttemptAt: attemptedAt,
            archiveStatus: DeliveryHandoverArchiveStatus.PENDING,
            artifactVersion: handover.artifactVersion,
            handoverContractId: task.contractId,
            handoverESignTaskId: task.id,
            id: handover.id,
            manifestHash: handover.manifestHash,
            sourceDocumentFileId: handover.sourceDocumentFileId,
            sourcePdfHash: handover.sourcePdfHash
          }
        });
        if (finalized.count !== 1) {
          throw new Error(STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH);
        }
      });

      return {
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        archived: true,
        signedPdfHash
      };
    } catch (error) {
      const code = stage2ArchiveFailureCode(error);
      let current: {
        archiveLastAttemptAt: Date | null;
        archiveStatus: DeliveryHandoverArchiveStatus;
        signedDocumentFileId: string | null;
        signedObjectKey: string | null;
        signedPdfHash: string | null;
        status: DeliveryHandoverStatus;
      } | null = null;
      try {
        current = await this.prisma.vehicleDeliveryHandover.findUnique({
          where: { id: handover.id }
        });
      } catch {
        // Reconciliation is best-effort; retain the deterministic object pointer.
      }
      if (
        storedArtifact &&
        signedPdfHash &&
        hasCompleteStage2HandoverArchive(current) &&
        current.signedObjectKey === storedArtifact.objectKey &&
        current.signedPdfHash === signedPdfHash
      ) {
        return {
          archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
          archived: false,
          signedPdfHash,
          skippedReason: "SIGNED_PDF_ALREADY_ARCHIVED"
        };
      }
      let compensated = false;
      if (
        storedArtifact &&
        current &&
        (
          (
            current.archiveStatus === DeliveryHandoverArchiveStatus.PENDING &&
            current.archiveLastAttemptAt?.getTime() === attemptedAt.getTime() &&
            current.signedObjectKey === storedArtifact.objectKey &&
            !current.signedDocumentFileId
          ) ||
          current.signedObjectKey !== storedArtifact.objectKey
        )
      ) {
        try {
          await this.storageService.deleteObject(
            storedArtifact.bucket,
            storedArtifact.objectKey
          );
          compensated = true;
        } catch {
          // Keep the deterministic key on the claim for a later safe retry.
        }
      }
      await this.prisma.vehicleDeliveryHandover.updateMany({
        data: {
          archiveLastAttemptAt: new Date(),
          archiveLastError: code,
          archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
          ...(compensated ? { signedObjectKey: null } : {}),
          status: DeliveryHandoverStatus.SIGNED
        },
        where: {
          archiveLastAttemptAt: attemptedAt,
          archiveStatus: DeliveryHandoverArchiveStatus.PENDING,
          handoverESignTaskId: task.id,
          id: handover.id
        }
      });
      throw new BadGatewayException({
        code,
        message: "The signed Stage 2 PDF could not be archived and can be retried."
      });
    }
  }

  private async recoverIncompleteStage2Archive(
    task: SignedArtifactTask,
    handover: NonNullable<SignedArtifactTask["deliveryHandover"]>,
    actorId?: string
  ): Promise<NonNullable<SignedArtifactTask["deliveryHandover"]>> {
    if (
      handover.archiveStatus !== DeliveryHandoverArchiveStatus.ARCHIVED ||
      hasCompleteStage2HandoverArchive(handover)
    ) {
      return handover;
    }

    const resetAt = new Date();
    const reset = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.vehicleDeliveryHandover.updateMany({
        data: {
          archiveLastAttemptAt: resetAt,
          archiveLastError: STAGE2_HANDOVER_ARCHIVE_INCONSISTENT,
          archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
          archivedAt: null,
          signedDocumentFileId: null,
          signedObjectKey: null,
          signedPdfHash: null,
          status: DeliveryHandoverStatus.SIGNED,
          updatedBy: actorId ?? null
        },
        where: {
          archiveLastAttemptAt: handover.archiveLastAttemptAt,
          archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
          deletedAt: null,
          handoverESignTaskId: task.id,
          id: handover.id,
          signedDocumentFileId: handover.signedDocumentFileId,
          signedObjectKey: handover.signedObjectKey,
          signedPdfHash: handover.signedPdfHash,
          status: handover.status
        }
      });
      if (updated.count !== 1) {
        return false;
      }
      await tx.contractESignTask.update({
        data: { signedDocumentObjectKey: null },
        where: { id: task.id }
      });
      return true;
    });
    if (reset) {
      return {
        ...handover,
        archiveLastAttemptAt: resetAt,
        archiveLastError: STAGE2_HANDOVER_ARCHIVE_INCONSISTENT,
        archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
        archivedAt: null,
        signedDocumentFileId: null,
        signedObjectKey: null,
        signedPdfHash: null,
        status: DeliveryHandoverStatus.SIGNED,
        updatedBy: actorId ?? null
      };
    }

    const current = await this.prisma.vehicleDeliveryHandover.findUnique({
      where: { id: handover.id }
    });
    if (!current) {
      throw stage2ArchiveBadRequest(
        STAGE2_HANDOVER_ARCHIVE_INCONSISTENT,
        "The incomplete Stage 2 archive no longer exists."
      );
    }
    return current;
  }

  async getAdminSignedContractPreview(taskId: string, user: RequestUser): Promise<FadadaSignedContractPreview> {
    const task = await this.findTaskByIdOrThrow(taskId);
    ensureCanAccessTask(task, user);
    return this.buildPreview(task);
  }

  async getPortalSignedContractPreview(
    contractId: string,
    currentCustomer: CurrentCustomer
  ): Promise<FadadaSignedContractPreview> {
    const task = await this.prisma.contractESignTask.findFirst({
      include: signedArtifactTaskInclude,
      where: {
        contractId,
        customerId: currentCustomer.customerId,
        deletedAt: null,
        signedDocumentObjectKey: { not: null },
        taskStatus: ESignTaskStatus.COMPLETED
      }
    });

    if (!task || task.contract.customerId !== currentCustomer.customerId || task.contract.status !== ContractStatus.SIGNED) {
      throw new NotFoundException("Signed contract not found.");
    }

    return this.buildPreview(task);
  }

  protected getApiClient(): FadadaSignedArtifactApi {
    const fadadaConfig = loadFadadaConfig(this.configService);
    return new FadadaApiClient(fadadaConfig, new FadadaHttpClient(fadadaConfig));
  }

  private async findTaskByIdOrThrow(taskId: string) {
    const task = await this.prisma.contractESignTask.findFirst({
      include: signedArtifactTaskInclude,
      where: { deletedAt: null, id: taskId }
    });
    if (!task) {
      throw new NotFoundException("E-sign task not found.");
    }
    return task;
  }

  private assertArchiveableTask(task: SignedArtifactTask, force: boolean) {
    if (task.provider !== ESignProviderType.FADADA) {
      throw new BadRequestException(`${FADADA_ARCHIVE_INVALID_TASK}: only Fadada tasks can be archived here`);
    }
    if (!force && task.taskStatus !== ESignTaskStatus.COMPLETED) {
      throw new BadRequestException(`${FADADA_ARCHIVE_INVALID_TASK}: task must be completed before archive`);
    }
    if (!force && task.signers.some((signer) =>
      isRequiredSignerRow(signer) && signer.signerStatus !== ESignSignerStatus.SIGNED
    )) {
      throw new BadRequestException(`${FADADA_ARCHIVE_INVALID_TASK}: all required signers must be signed before archive`);
    }
  }

  private async buildPreview(task: SignedArtifactTask): Promise<FadadaSignedContractPreview> {
    let signedObjectKey = task.signedDocumentObjectKey;
    if (hasAuthoritativeStage2HandoverRelation(task.deliveryHandover)) {
      const handover = task.deliveryHandover;
      if (
        handover.deletedAt ||
        !hasCompleteStage2HandoverArchive(handover)
      ) {
        throw new NotFoundException(
          `${FADADA_ARCHIVE_SIGNED_PDF_MISSING}: signed PDF artifact not found`
        );
      }
      const fileObject = await this.prisma.fileObject.findUnique({
        where: { id: handover.signedDocumentFileId }
      });
      if (
        !fileObject?.bucket.trim() ||
        fileObject.objectKey !== handover.signedObjectKey ||
        fileObject.mimeType?.trim().toLowerCase() !== "application/pdf" ||
        fileObject.sizeBytes <= 0n
      ) {
        throw new NotFoundException(
          `${FADADA_ARCHIVE_SIGNED_PDF_MISSING}: signed PDF artifact not found`
        );
      }
      signedObjectKey = handover.signedObjectKey;
    }
    if (!signedObjectKey) {
      throw new NotFoundException(`${FADADA_ARCHIVE_SIGNED_PDF_MISSING}: signed PDF artifact not found`);
    }

    const object = await this.storageService.getContractSignedArtifactStream(signedObjectKey);
    if (object.contentType && !object.contentType.toLowerCase().includes("application/pdf")) {
      throw new BadRequestException(`${FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF}: signed artifact must be a PDF`);
    }

    return {
      contentType: "application/pdf",
      filename: `${sanitizeFileName(task.contract.contractNo)}-signed.pdf`,
      sizeBytes: object.contentLength ?? 0,
      stream: object.stream
    };
  }
}

function ensureCanAccessTask(task: SignedArtifactTask, user: RequestUser) {
  if (user.roles.includes("admin") || user.permissions.includes("order:view:all")) {
    return;
  }
  if (task.contract.order.application.salesUserId !== user.id) {
    throw new NotFoundException("E-sign task not found.");
  }
}

function assertSignedPdf(buffer: Buffer) {
  if (buffer.length > MAX_SIGNED_PDF_BYTES) {
    throw new Error(`${FADADA_ARCHIVE_SIGNED_PDF_TOO_LARGE}: signed PDF must be <= 20MB`);
  }
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-", "utf8"))) {
    throw new Error(`${FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF}: signed PDF must start with %PDF-`);
  }
}

function assertStage2ArchiveableTask(task: SignedArtifactTask) {
  if (
    task.provider !== ESignProviderType.FADADA ||
    task.signingStage !== ESignSigningStage.STAGE2_DELIVERY_HANDOVER ||
    task.documentType !== ESignDocumentType.DELIVERY_HANDOVER ||
    task.taskStatus !== ESignTaskStatus.COMPLETED ||
    !task.completedAt
  ) {
    throw stage2ArchiveBadRequest(
      STAGE2_HANDOVER_ARCHIVE_INVALID_TASK,
      "A completed typed Stage 2 Fadada task is required."
    );
  }
  const customerSigners = task.signers.filter(
    (signer) =>
      signer.required &&
      signer.slotId === ESignSlotId.STAGE2_HANDOVER_CUSTOMER &&
      signer.documentType === ESignDocumentType.DELIVERY_HANDOVER &&
      signer.providerActionType === ESignProviderActionType.CUSTOMER_MANUAL_SIGN &&
      signer.signerType === ESignSignerType.CUSTOMER &&
      signer.signerStatus === ESignSignerStatus.SIGNED &&
      Boolean(signer.providerTransactionId)
  );
  const platformSigners = task.signers.filter(
    (signer) =>
      signer.required &&
      signer.slotId === ESignSlotId.STAGE2_HANDOVER_PLATFORM &&
      signer.documentType === ESignDocumentType.DELIVERY_HANDOVER &&
      signer.providerActionType === ESignProviderActionType.PLATFORM_AUTO_SEAL &&
      signer.signerType === ESignSignerType.PLATFORM &&
      signer.signerStatus === ESignSignerStatus.SIGNED &&
      Boolean(signer.providerTransactionId)
  );
  const requiredStage2Signers = task.signers.filter(
    (signer) =>
      signer.required &&
      signer.documentType === ESignDocumentType.DELIVERY_HANDOVER
  );
  if (
    requiredStage2Signers.length !== 2 ||
    customerSigners.length !== 1 ||
    platformSigners.length !== 1
  ) {
    throw stage2ArchiveBadRequest(
      STAGE2_HANDOVER_ARCHIVE_INVALID_TASK,
      "Both required typed Stage 2 signers must be signed."
    );
  }
  const handover = task.deliveryHandover;
  if (
    !handover ||
    handover.deletedAt ||
    handover.handoverContractId !== task.contractId ||
    handover.handoverESignTaskId !== task.id ||
    (
      handover.status !== DeliveryHandoverStatus.SIGNED &&
      handover.status !== DeliveryHandoverStatus.ARCHIVED
    )
  ) {
    throw stage2ArchiveBadRequest(
      STAGE2_HANDOVER_ARCHIVE_INVALID_TASK,
      "The Stage 2 handover signing state is invalid."
    );
  }
  return handover;
}

function assertStage2ArchiveSourceBinding(
  task: SignedArtifactTask,
  handover: NonNullable<SignedArtifactTask["deliveryHandover"]>
) {
  const snapshot = asPlainRecord(task.requestSnapshot);
  if (
    snapshot.artifactVersion !== handover.artifactVersion ||
    snapshot.contractId !== task.contractId ||
    snapshot.contractId !== handover.handoverContractId ||
    snapshot.handoverId !== handover.id ||
    snapshot.manifestHash !== handover.manifestHash ||
    snapshot.sourceDocumentFileId !== handover.sourceDocumentFileId ||
    snapshot.sourcePdfHash !== handover.sourcePdfHash ||
    !handover.sourceDocumentFileId ||
    !isSha256Digest(handover.manifestHash) ||
    !isSha256Digest(handover.sourcePdfHash) ||
    !Number.isInteger(handover.artifactVersion) ||
    handover.artifactVersion < 1
  ) {
    throw stage2ArchiveBadRequest(
      STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH,
      "The Stage 2 source PDF identity does not match the signing task."
    );
  }
}

function assertStage2SignedPdf(buffer: Buffer, contentType: string) {
  const normalizedContentType = contentType
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (normalizedContentType !== "application/pdf") {
    throw new Error(FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF);
  }
  assertSignedPdf(buffer);
}

function stage2ArchiveFailureCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes(FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF)) {
    return FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF;
  }
  if (message.includes(FADADA_ARCHIVE_SIGNED_PDF_TOO_LARGE)) {
    return FADADA_ARCHIVE_SIGNED_PDF_TOO_LARGE;
  }
  if (message.includes(STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH)) {
    return STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH;
  }
  return STAGE2_HANDOVER_ARCHIVE_PROVIDER_FAILED;
}

function stage2ArchiveBadRequest(code: string, message: string) {
  return new BadRequestException({ code, message });
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function readStage2ArchiveClaimTimeoutMs(configService: ConfigService) {
  const configured = Number(
    configService.get<string>(STAGE2_ARCHIVE_CLAIM_TIMEOUT_ENV)
  );
  return Number.isSafeInteger(configured) &&
    configured >= MIN_STAGE2_ARCHIVE_CLAIM_TIMEOUT_MS &&
    configured <= MAX_STAGE2_ARCHIVE_CLAIM_TIMEOUT_MS
    ? configured
    : DEFAULT_STAGE2_ARCHIVE_CLAIM_TIMEOUT_MS;
}

function isFreshStage2ArchiveClaim(
  lastAttemptAt: Date | null,
  now: Date,
  timeoutMs: number
) {
  return Boolean(
    lastAttemptAt &&
    Number.isFinite(lastAttemptAt.getTime()) &&
    now.getTime() - lastAttemptAt.getTime() < timeoutMs
  );
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mergeResponseSnapshot(existing: unknown, patch: Record<string, unknown>) {
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  return {
    ...base,
    ...patch
  };
}

function findProviderCustomerId(task: SignedArtifactTask) {
  const customerSigner = task.signers.find((signer) => signer.signerType === ESignSignerType.CUSTOMER);
  const snapshot = customerSigner?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return undefined;
  }
  const providerCustomerId = (snapshot as Record<string, unknown>).providerCustomerId;
  return typeof providerCustomerId === "string" && providerCustomerId.trim() ? providerCustomerId : undefined;
}

function isRequiredSignerRow(signer: { snapshot?: unknown }) {
  const snapshot = signer.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return true;
  }
  return (snapshot as Record<string, unknown>).required !== false;
}

function sanitizeProviderPayload(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeProviderPayload);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveUrlField(key, item) ? "[redacted-url]" : sanitizeProviderPayload(item)
      ])
    );
  }
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    return "[redacted-url]";
  }
  return value;
}

function isSensitiveUrlField(key: string, value: unknown) {
  return typeof value === "string" && /(^|_)(download|view|sign)?url$/i.test(key);
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return toPlain(value) as Prisma.InputJsonValue;
}

function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Prisma.Decimal) {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPlain(item)]));
  }
  return value;
}

function sanitizeFileName(value: string) {
  return (value.replace(/[^\w.-]+/g, "_").slice(0, 120) || "contract").replace(/^\.+$/, "contract");
}
