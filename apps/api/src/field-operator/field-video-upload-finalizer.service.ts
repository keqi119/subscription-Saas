import { Injectable } from "@nestjs/common";
import { FieldEvidenceVideoUploadStatus } from "@prisma/client";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  DeliveryHandoverEvidenceArtifactService,
  getDeliveryEvidenceVideoQualityPublicMessage,
  isDeliveryEvidenceArtifactProcessingError,
  PreparedDeliveryEvidenceArtifacts
} from "../delivery-handover/delivery-handover-evidence-artifact.service";
import { HandoverWorkOrderService } from "../handover-work-order/handover-work-order.service";
import { StorageService } from "../storage/storage.service";
import { FieldVideoUploadRepository } from "./field-video-upload.repository";
import { FieldVideoUploadSessionSnapshot } from "./field-video-upload.types";

const RETRY_DELAYS_MS = [60_000, 300_000, 900_000] as const;
const PROCESSING_ROOT = path.join(tmpdir(), "subscription-saas-field-video-processing");

@Injectable()
export class FieldVideoUploadFinalizerService {
  constructor(
    private readonly repository: FieldVideoUploadRepository,
    private readonly storage: StorageService,
    private readonly artifact: DeliveryHandoverEvidenceArtifactService,
    private readonly handover: HandoverWorkOrderService
  ) {}

  async finalize(claimed: FieldVideoUploadSessionSnapshot) {
    if (!claimed.leaseOwner) {
      return;
    }

    let stage = claimed.status;
    if (stage === FieldEvidenceVideoUploadStatus.FINALIZE_QUEUED) {
      const advanced = await this.repository.advanceClaimed({
        leaseOwner: claimed.leaseOwner,
        sessionId: claimed.id,
        status: FieldEvidenceVideoUploadStatus.OSS_COMPLETING
      });
      if (!advanced) {
        return;
      }
      stage = FieldEvidenceVideoUploadStatus.OSS_COMPLETING;
    }

    if (stage === FieldEvidenceVideoUploadStatus.OSS_COMPLETING) {
      try {
        const completed = await this.storage.completeFieldVideoMultipart({
          key: requireInternal(claimed.internal.objectKey),
          parts: [...claimed.parts]
            .sort((left, right) => left.partNumber - right.partNumber)
            .map((part) => ({
              etag: part.internal.ossEtag,
              partNumber: part.partNumber,
              sizeBytes: part.sizeBytes
            })),
          sizeBytes: claimed.sizeBytes,
          uploadId: requireInternal(claimed.internal.ossUploadId)
        });
        const advanced = await this.repository.advanceClaimed({
          leaseOwner: claimed.leaseOwner,
          objectCompletedAt: new Date(),
          objectEtag: completed.etag,
          sessionId: claimed.id,
          status: FieldEvidenceVideoUploadStatus.OBJECT_READY
        });
        if (!advanced) {
          return;
        }
        stage = FieldEvidenceVideoUploadStatus.OBJECT_READY;
      } catch {
        await this.markRetryable(
          claimed,
          FieldEvidenceVideoUploadStatus.OSS_COMPLETING,
          "VIDEO_UPLOAD_OSS_COMPLETE_FAILED",
          "视频分片合并暂时失败，请稍后重试。"
        );
        return;
      }
    }

    if (
      stage !== FieldEvidenceVideoUploadStatus.OBJECT_READY &&
      stage !== FieldEvidenceVideoUploadStatus.PROCESSING
    ) {
      return;
    }

    if (stage === FieldEvidenceVideoUploadStatus.OBJECT_READY) {
      const advanced = await this.repository.advanceClaimed({
        leaseOwner: claimed.leaseOwner,
        sessionId: claimed.id,
        status: FieldEvidenceVideoUploadStatus.PROCESSING
      });
      if (!advanced) {
        return;
      }
    }
    await this.processObject(claimed);
  }

  private async processObject(claimed: FieldVideoUploadSessionSnapshot) {
    const objectKey = requireInternal(claimed.internal.objectKey);
    await mkdir(PROCESSING_ROOT, { recursive: true });
    const directory = await mkdtemp(path.join(PROCESSING_ROOT, `${claimed.id}-`));
    const sourcePath = path.join(directory, safeSourceName(claimed.originalName));
    let prepared: PreparedDeliveryEvidenceArtifacts | undefined;
    try {
      const downloaded = await this.storage.downloadFieldVideoUploadSource({ key: objectKey });
      await pipeline(downloaded.stream, createWriteStream(sourcePath, { flags: "wx" }));
      prepared = await this.artifact.prepareUpload({
        evidenceType: "WALKAROUND_VIDEO",
        file: {
          mimetype: claimed.mimeType,
          originalname: claimed.originalName,
          path: sourcePath,
          size: claimed.sizeBytes
        },
        mediaType: "VIDEO"
      });
      await this.handover.attachPreparedFieldVideoFromStoredSource({
        actorId: claimed.createdBySessionId ?? undefined,
        detectedMimeType: prepared.metadata.detectedMimeType,
        evidenceItemId: claimed.evidenceItemId,
        originalName: claimed.originalName,
        prepared,
        replaceEvidenceFileId: claimed.replaceEvidenceFileId ?? undefined,
        sizeBytes: prepared.metadata.sourceSizeBytes,
        storedSource: this.storage.resolveFieldVideoUploadSourceIdentity({ key: objectKey }),
        workOrderId: claimed.workOrderId
      });
      const terminal = await this.repository.markTerminal({
        leaseOwner: requireLease(claimed),
        sessionId: claimed.id,
        status: FieldEvidenceVideoUploadStatus.COMPLETED
      });
      if (terminal) {
        await this.handover.recordFieldVideoUploadEvent({
          actorId: claimed.createdBySessionId ?? undefined,
          eventType: "FIELD_VIDEO_UPLOAD_COMPLETED",
          evidenceItemId: claimed.evidenceItemId,
          partCount: claimed.parts.length,
          sessionId: claimed.id,
          status: FieldEvidenceVideoUploadStatus.COMPLETED,
          workOrderId: claimed.workOrderId
        });
      }
    } catch (error) {
      const validation = validationFailure(error);
      if (validation) {
        try {
          await this.storage.deleteFieldVideoUploadSource({ key: objectKey });
          const terminal = await this.repository.markTerminal({
            code: validation.code,
            leaseOwner: requireLease(claimed),
            message: validation.message,
            sessionId: claimed.id,
            status: FieldEvidenceVideoUploadStatus.VALIDATION_FAILED
          });
          if (terminal) {
            await this.handover.recordFieldVideoUploadEvent({
              actorId: claimed.createdBySessionId ?? undefined,
              errorCode: validation.code,
              eventType: "FIELD_VIDEO_UPLOAD_FAILED",
              evidenceItemId: claimed.evidenceItemId,
              sessionId: claimed.id,
              status: FieldEvidenceVideoUploadStatus.VALIDATION_FAILED,
              workOrderId: claimed.workOrderId
            });
          }
        } catch {
          await this.markRetryable(
            claimed,
            FieldEvidenceVideoUploadStatus.PROCESSING,
            "VIDEO_UPLOAD_VALIDATION_CLEANUP_FAILED",
            "视频校验失败后的清理暂时未完成，请稍后重试。"
          );
        }
        return;
      }
      await this.markRetryable(
        claimed,
        FieldEvidenceVideoUploadStatus.PROCESSING,
        "VIDEO_UPLOAD_PROCESSING_FAILED",
        "视频处理暂时失败，请稍后重试。"
      );
    } finally {
      await prepared?.cleanup().catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  }

  private async markRetryable(
    claimed: FieldVideoUploadSessionSnapshot,
    resumeStage: FieldEvidenceVideoUploadStatus,
    code: string,
    message: string
  ) {
    await this.repository.markRetryableFailure({
      code,
      delayMs: retryDelayMs(claimed.retryCount),
      leaseOwner: requireLease(claimed),
      message,
      resumeStage,
      sessionId: claimed.id
    });
  }
}

function validationFailure(error: unknown) {
  const qualityMessage = getDeliveryEvidenceVideoQualityPublicMessage(error);
  if (qualityMessage) {
    return { code: "VIDEO_RESOLUTION_TOO_LOW", message: qualityMessage };
  }
  if (isDeliveryEvidenceArtifactProcessingError(error)) {
    return {
      code: "VIDEO_VALIDATION_FAILED",
      message: "视频文件损坏或无法识别，请重新选择文件后上传。"
    };
  }
  return null;
}

function requireInternal(value: string | null) {
  if (!value) {
    throw new Error("FIELD_VIDEO_INTERNAL_STATE_MISSING");
  }
  return value;
}

function requireLease(session: FieldVideoUploadSessionSnapshot) {
  if (!session.leaseOwner) {
    throw new Error("FIELD_VIDEO_LEASE_MISSING");
  }
  return session.leaseOwner;
}

function retryDelayMs(retryCount: number) {
  return RETRY_DELAYS_MS[Math.min(Math.max(retryCount, 0), RETRY_DELAYS_MS.length - 1)]!;
}

function safeSourceName(originalName: string) {
  const extension = path
    .extname(originalName)
    .replace(/[^.\w]+/g, "")
    .slice(0, 12);
  return `source${extension && extension !== "." ? extension : ".bin"}`;
}
