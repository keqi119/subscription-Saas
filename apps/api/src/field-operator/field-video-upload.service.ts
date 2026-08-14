import {
  ConflictException,
  Injectable,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnsupportedMediaTypeException
} from "@nestjs/common";
import { FieldEvidenceVideoUploadStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { HandoverWorkOrderService } from "../handover-work-order/handover-work-order.service";
import { StorageService } from "../storage/storage.service";
import {
  FIELD_VIDEO_CHUNK_SIZE_BYTES,
  FIELD_VIDEO_FINALIZE_LEASE_MS,
  MAX_FIELD_VIDEO_SIZE_BYTES
} from "./field-video-upload.constants";
import { CreateFieldVideoUploadSessionDto } from "./field-video-upload.dto";
import { FieldVideoUploadRepository } from "./field-video-upload.repository";
import {
  FieldVideoUploadSessionPublicSnapshot,
  FieldVideoUploadSessionSnapshot,
  toPublicFieldVideoUploadSnapshot
} from "./field-video-upload.types";

const SAFE_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v"
]);
const SAFE_VIDEO_EXTENSION = /\.(m4v|mov|mp4|webm)$/i;

@Injectable()
export class FieldVideoUploadService {
  constructor(
    private readonly repository: FieldVideoUploadRepository,
    private readonly storage: StorageService,
    private readonly handover: HandoverWorkOrderService
  ) {}

  async createOrResume(
    workOrderId: string,
    evidenceItemId: string,
    phone: string,
    actorSessionId: string,
    dto: CreateFieldVideoUploadSessionDto
  ): Promise<FieldVideoUploadSessionPublicSnapshot> {
    const authorized = await this.handover.authorizeFieldVideoUploadMutation({
      evidenceItemId,
      phone,
      replaceEvidenceFileId: dto.replaceEvidenceFileId,
      workOrderId
    });
    assertSupportedVideoMetadata(dto);

    const existing = await this.repository.findLiveForEvidenceItem(authorized.itemId);
    if (existing) {
      assertSameUploadFile(existing, dto);
      const resumed = await this.repository.createOrResume({
        chunkSizeBytes: existing.chunkSizeBytes,
        createdBySessionId: existing.createdBySessionId,
        evidenceItemId: existing.evidenceItemId,
        fingerprintHash: existing.fingerprintHash,
        lastModifiedMs: existing.lastModifiedMs,
        mimeType: existing.mimeType,
        objectKey: requireInternal(existing.internal.objectKey),
        originalName: existing.originalName,
        ossUploadId: requireInternal(existing.internal.ossUploadId),
        replaceEvidenceFileId: existing.replaceEvidenceFileId,
        sessionId: existing.id,
        sizeBytes: existing.sizeBytes,
        totalParts: existing.totalParts,
        workOrderId: existing.workOrderId
      });
      await this.handover.recordFieldVideoUploadEvent({
        actorId: actorSessionId,
        eventType: "FIELD_VIDEO_UPLOAD_RESUMED",
        evidenceItemId: authorized.itemId,
        sessionId: resumed.session.id,
        status: resumed.session.status,
        workOrderId
      });
      return toPublicFieldVideoUploadSnapshot(resumed.session);
    }

    const sessionId = randomUUID();
    const handle = await this.storage.beginFieldVideoMultipart({
      contentType: dto.mimeType,
      originalName: dto.fileName,
      sessionId
    });
    let keepHandle = false;
    try {
      const result = await this.repository.createOrResume({
        chunkSizeBytes: FIELD_VIDEO_CHUNK_SIZE_BYTES,
        createdBySessionId: actorSessionId,
        evidenceItemId: authorized.itemId,
        fingerprintHash: dto.fingerprintSha256,
        lastModifiedMs: dto.lastModifiedMs,
        mimeType: dto.mimeType,
        objectKey: handle.key,
        originalName: dto.fileName,
        ossUploadId: handle.uploadId,
        replaceEvidenceFileId: authorized.replaceEvidenceFileId,
        sessionId,
        sizeBytes: dto.sizeBytes,
        totalParts: Math.ceil(dto.sizeBytes / FIELD_VIDEO_CHUNK_SIZE_BYTES),
        workOrderId
      });
      keepHandle = result.disposition === "CREATED";
      if (!keepHandle) {
        await this.storage.abortFieldVideoMultipart(handle);
      }
      await this.handover.recordFieldVideoUploadEvent({
        actorId: actorSessionId,
        eventType:
          result.disposition === "CREATED"
            ? "FIELD_VIDEO_UPLOAD_CREATED"
            : "FIELD_VIDEO_UPLOAD_RESUMED",
        evidenceItemId: authorized.itemId,
        sessionId: result.session.id,
        status: result.session.status,
        workOrderId
      });
      return toPublicFieldVideoUploadSnapshot(result.session);
    } catch (error) {
      if (!keepHandle) {
        await this.storage.abortFieldVideoMultipart(handle).catch(() => undefined);
      }
      throw error;
    }
  }

  async getStatus(workOrderId: string, evidenceItemId: string, sessionId: string, phone: string) {
    const session = await this.getScopedSession(workOrderId, evidenceItemId, sessionId, phone);
    return toPublicFieldVideoUploadSnapshot(session);
  }

  async listActive(phone: string) {
    const sessions = await this.repository.listActive();
    const visible: FieldVideoUploadSessionPublicSnapshot[] = [];
    for (const session of sessions) {
      try {
        await this.handover.authorizeFieldVideoUploadMutation({
          evidenceItemId: session.evidenceItemId,
          phone,
          replaceEvidenceFileId: session.replaceEvidenceFileId ?? undefined,
          workOrderId: session.workOrderId
        });
        visible.push(toPublicFieldVideoUploadSnapshot(session));
      } catch (error) {
        if (!(error instanceof UnauthorizedException)) {
          throw error;
        }
      }
    }
    return visible;
  }

  async complete(workOrderId: string, evidenceItemId: string, sessionId: string, phone: string) {
    await this.getScopedSession(workOrderId, evidenceItemId, sessionId, phone);
    return toPublicFieldVideoUploadSnapshot(await this.repository.queueFinalization(sessionId));
  }

  async retry(workOrderId: string, evidenceItemId: string, sessionId: string, phone: string) {
    const session = await this.getScopedSession(workOrderId, evidenceItemId, sessionId, phone);
    if (session.status !== FieldEvidenceVideoUploadStatus.RETRYABLE_FAILED) {
      throw new ConflictException({
        code: "VIDEO_UPLOAD_NOT_RETRYABLE",
        message: "当前视频上传状态无需重试。"
      });
    }
    if (!(await this.repository.retryFailed(sessionId))) {
      throw new ConflictException({
        code: "VIDEO_UPLOAD_RETRY_CONFLICT",
        message: "视频上传状态已变化，请刷新后重试。"
      });
    }
    return toPublicFieldVideoUploadSnapshot({
      ...session,
      failureCode: null,
      failureMessage: null
    });
  }

  async cancel(
    workOrderId: string,
    evidenceItemId: string,
    sessionId: string,
    phone: string,
    actorSessionId: string
  ) {
    const session = await this.getScopedSession(workOrderId, evidenceItemId, sessionId, phone);
    if (session.status === FieldEvidenceVideoUploadStatus.CANCELLED) {
      return toPublicFieldVideoUploadSnapshot(session);
    }
    const claimed = await this.repository.claimCancellation(
      sessionId,
      FIELD_VIDEO_FINALIZE_LEASE_MS
    );
    if (!claimed?.leaseOwner) {
      throw new ConflictException({
        code: "VIDEO_UPLOAD_CANCEL_CONFLICT",
        message: "视频上传正在处理中，请刷新后重试。"
      });
    }
    try {
      if (claimed.internal.ossUploadId && claimed.internal.objectKey) {
        await this.storage.abortFieldVideoMultipart({
          key: claimed.internal.objectKey,
          uploadId: claimed.internal.ossUploadId
        });
      }
      if (claimed.objectCompletedAt && claimed.internal.objectKey) {
        await this.storage.deleteFieldVideoUploadSource({ key: claimed.internal.objectKey });
      }
      const marked = await this.repository.markTerminal({
        leaseOwner: claimed.leaseOwner,
        sessionId,
        status: FieldEvidenceVideoUploadStatus.CANCELLED
      });
      if (!marked) {
        throw new ConflictException({
          code: "VIDEO_UPLOAD_CANCEL_CONFLICT",
          message: "视频上传状态已变化，请刷新后重试。"
        });
      }
      await this.handover.recordFieldVideoUploadEvent({
        actorId: actorSessionId,
        eventType: "FIELD_VIDEO_UPLOAD_CANCELLED",
        evidenceItemId,
        sessionId,
        status: FieldEvidenceVideoUploadStatus.CANCELLED,
        workOrderId
      });
      return toPublicFieldVideoUploadSnapshot({
        ...claimed,
        cancelledAt: new Date(),
        internal: { objectEtag: null, objectKey: null, ossUploadId: null },
        leaseExpiresAt: null,
        leaseOwner: null,
        status: FieldEvidenceVideoUploadStatus.CANCELLED
      });
    } catch (error) {
      await this.repository.releaseLease(sessionId, claimed.leaseOwner).catch(() => false);
      if (error instanceof ConflictException) {
        throw error;
      }
      throw new ServiceUnavailableException({
        code: "VIDEO_UPLOAD_CANCEL_RETRYABLE",
        message: "取消视频上传暂时失败，请稍后重试。"
      });
    }
  }

  private async getScopedSession(
    workOrderId: string,
    evidenceItemId: string,
    sessionId: string,
    phone: string
  ) {
    const session = await this.repository.findById(sessionId);
    if (
      !session ||
      session.workOrderId !== workOrderId ||
      session.evidenceItemId !== evidenceItemId
    ) {
      throw new UnauthorizedException({
        code: "VIDEO_UPLOAD_SESSION_SCOPE_MISMATCH",
        message: "无权访问该视频上传记录。"
      });
    }
    await this.handover.authorizeFieldVideoUploadMutation({
      evidenceItemId,
      phone,
      replaceEvidenceFileId: session.replaceEvidenceFileId ?? undefined,
      workOrderId
    });
    return session;
  }
}

function assertSupportedVideoMetadata(dto: CreateFieldVideoUploadSessionDto) {
  if (dto.sizeBytes > MAX_FIELD_VIDEO_SIZE_BYTES) {
    throw new PayloadTooLargeException({
      code: "VIDEO_TOO_LARGE",
      message: "单个视频不能超过 300 MiB。"
    });
  }
  const mimeType = dto.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!SAFE_VIDEO_MIME_TYPES.has(mimeType) || !SAFE_VIDEO_EXTENSION.test(dto.fileName)) {
    throw new UnsupportedMediaTypeException({
      code: "VIDEO_TYPE_UNSUPPORTED",
      message: "车辆环绕视频仅支持 MP4、MOV、M4V 或 WebM。"
    });
  }
}

function assertSameUploadFile(
  existing: FieldVideoUploadSessionSnapshot,
  dto: CreateFieldVideoUploadSessionDto
) {
  if (
    existing.fingerprintHash !== dto.fingerprintSha256 ||
    existing.sizeBytes !== dto.sizeBytes ||
    existing.lastModifiedMs !== dto.lastModifiedMs
  ) {
    throw new ConflictException({
      code: "VIDEO_UPLOAD_ACTIVE_FILE_CONFLICT",
      message: "该资料已有其他视频正在上传，请继续原文件或先取消旧上传。"
    });
  }
  if (existing.expiresAt <= new Date()) {
    throw new ConflictException({
      code: "VIDEO_UPLOAD_SESSION_EXPIRED",
      message: "视频上传记录已过期，请重新开始。"
    });
  }
}

function requireInternal(value: string | null) {
  if (!value) {
    throw new ConflictException({
      code: "VIDEO_UPLOAD_INTERNAL_STATE_MISSING",
      message: "视频上传记录不完整，请重新开始。"
    });
  }
  return value;
}
