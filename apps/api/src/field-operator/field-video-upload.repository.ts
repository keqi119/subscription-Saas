import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { FieldEvidenceVideoUploadStatus, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { PrismaService } from "../prisma/prisma.service";
import {
  FIELD_VIDEO_LIVE_STATUSES,
  FIELD_VIDEO_TERMINAL_STATUSES,
  FIELD_VIDEO_UPLOAD_TTL_MS
} from "./field-video-upload.constants";
import {
  FieldVideoUploadPartSnapshot,
  FieldVideoUploadSessionSnapshot
} from "./field-video-upload.types";

const sessionInclude = {
  evidenceItem: { select: { title: true } },
  parts: { orderBy: { partNumber: "asc" as const } }
} as const;

type SessionRow = Prisma.FieldEvidenceVideoUploadSessionGetPayload<{
  include: typeof sessionInclude;
}>;

export interface CreateFieldVideoUploadSessionInput {
  chunkSizeBytes: number;
  createdBySessionId: string | null;
  evidenceItemId: string;
  expiresAt?: Date;
  fingerprintHash: string;
  lastModifiedMs: number;
  mimeType: string;
  objectKey: string;
  originalName: string;
  ossUploadId: string;
  replaceEvidenceFileId: string | null;
  sessionId: string;
  sizeBytes: number;
  totalParts: number;
  workOrderId: string;
}

export interface RecordFieldVideoUploadPartInput {
  ossEtag: string;
  partNumber: number;
  sessionId: string;
  sha256: string;
  sizeBytes: number;
}

@Injectable()
export class FieldVideoUploadRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findLiveForEvidenceItem(
    evidenceItemId: string
  ): Promise<FieldVideoUploadSessionSnapshot | null> {
    const row = await this.prisma.fieldEvidenceVideoUploadSession.findFirst({
      include: sessionInclude,
      orderBy: { createdAt: "desc" },
      where: {
        evidenceItemId,
        status: { in: [...FIELD_VIDEO_LIVE_STATUSES] }
      }
    });
    return row ? toSessionSnapshot(row) : null;
  }

  async findById(sessionId: string): Promise<FieldVideoUploadSessionSnapshot | null> {
    const row = await this.prisma.fieldEvidenceVideoUploadSession.findUnique({
      include: sessionInclude,
      where: { id: sessionId }
    });
    return row ? toSessionSnapshot(row) : null;
  }

  async createOrResume(input: CreateFieldVideoUploadSessionInput): Promise<{
    disposition: "CREATED" | "RESUMED";
    session: FieldVideoUploadSessionSnapshot;
  }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.fieldEvidenceVideoUploadSession.findFirst({
          include: sessionInclude,
          orderBy: { createdAt: "desc" },
          where: {
            evidenceItemId: input.evidenceItemId,
            status: { in: [...FIELD_VIDEO_LIVE_STATUSES] }
          }
        });

        if (existing) {
          if (existing.fingerprintHash !== input.fingerprintHash) {
            throw activeFileConflict();
          }
          const resumed = await tx.fieldEvidenceVideoUploadSession.update({
            data: {
              expiresAt: input.expiresAt ?? expiresFromNow(),
              version: { increment: 1 }
            },
            include: sessionInclude,
            where: { id: existing.id }
          });
          return { disposition: "RESUMED" as const, session: toSessionSnapshot(resumed) };
        }

        const created = await tx.fieldEvidenceVideoUploadSession.create({
          data: {
            chunkSizeBytes: input.chunkSizeBytes,
            createdBySessionId: input.createdBySessionId,
            evidenceItemId: input.evidenceItemId,
            expiresAt: input.expiresAt ?? expiresFromNow(),
            fingerprintHash: input.fingerprintHash,
            lastModifiedMs: BigInt(input.lastModifiedMs),
            mimeType: input.mimeType,
            objectKey: input.objectKey,
            originalName: input.originalName,
            ossUploadId: input.ossUploadId,
            replaceEvidenceFileId: input.replaceEvidenceFileId,
            id: input.sessionId,
            sizeBytes: BigInt(input.sizeBytes),
            totalParts: input.totalParts,
            workOrderId: input.workOrderId
          },
          include: sessionInclude
        });
        return { disposition: "CREATED" as const, session: toSessionSnapshot(created) };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw activeFileConflict();
      }
      throw error;
    }
  }

  async recordPart(input: RecordFieldVideoUploadPartInput): Promise<FieldVideoUploadPartSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.fieldEvidenceVideoUploadSession.findUnique({
        where: { id: input.sessionId }
      });
      if (!session) {
        throw new NotFoundException({
          code: "VIDEO_UPLOAD_SESSION_NOT_FOUND",
          message: "视频上传记录不存在。"
        });
      }
      if (session.status !== FieldEvidenceVideoUploadStatus.UPLOADING) {
        throw new ConflictException({
          code: "VIDEO_UPLOAD_NOT_ACCEPTING_PARTS",
          message: "当前视频上传记录不再接收分片。"
        });
      }
      const now = new Date();
      if (session.expiresAt <= now) {
        throw new ConflictException({
          code: "VIDEO_UPLOAD_SESSION_EXPIRED",
          message: "视频上传记录已过期，请重新开始。"
        });
      }
      if (session.leaseOwner && session.leaseExpiresAt && session.leaseExpiresAt > now) {
        throw new ConflictException({
          code: "VIDEO_UPLOAD_SESSION_BUSY",
          message: "视频上传记录正在处理中，请稍后重试。"
        });
      }

      const where = {
        sessionId_partNumber: {
          partNumber: input.partNumber,
          sessionId: input.sessionId
        }
      };
      const existing = await tx.fieldEvidenceVideoUploadPart.findUnique({ where });
      if (existing) {
        if (existing.sizeBytes === input.sizeBytes && existing.sha256 === input.sha256) {
          return toPartSnapshot(existing);
        }
        throw new ConflictException({
          code: "CHUNK_CONTENT_CONFLICT",
          message: "分片内容与已上传记录不一致。"
        });
      }

      const created = await tx.fieldEvidenceVideoUploadPart.create({
        data: {
          completedAt: now,
          ossEtag: input.ossEtag,
          partNumber: input.partNumber,
          sessionId: input.sessionId,
          sha256: input.sha256,
          sizeBytes: input.sizeBytes
        }
      });
      await tx.fieldEvidenceVideoUploadSession.update({
        data: {
          expiresAt: new Date(now.getTime() + FIELD_VIDEO_UPLOAD_TTL_MS),
          version: { increment: 1 }
        },
        where: { id: input.sessionId }
      });
      return toPartSnapshot(created);
    });
  }

  async queueFinalization(sessionId: string): Promise<FieldVideoUploadSessionSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.fieldEvidenceVideoUploadSession.findUnique({
        include: sessionInclude,
        where: { id: sessionId }
      });
      if (!session) {
        throw new NotFoundException({
          code: "VIDEO_UPLOAD_SESSION_NOT_FOUND",
          message: "视频上传记录不存在。"
        });
      }
      if (session.status !== FieldEvidenceVideoUploadStatus.UPLOADING) {
        if (!FIELD_VIDEO_TERMINAL_STATUSES.includes(session.status)) {
          return toSessionSnapshot(session);
        }
        throw new ConflictException({
          code: "VIDEO_UPLOAD_ALREADY_TERMINAL",
          message: "视频上传记录已结束。"
        });
      }
      const uploadedBytes = session.parts.reduce((sum, part) => sum + part.sizeBytes, 0);
      if (
        session.parts.length !== session.totalParts ||
        BigInt(uploadedBytes) !== session.sizeBytes
      ) {
        throw new BadRequestException({
          code: "VIDEO_UPLOAD_PARTS_INCOMPLETE",
          message: "视频分片尚未全部上传。"
        });
      }
      const updated = await tx.fieldEvidenceVideoUploadSession.update({
        data: {
          status: FieldEvidenceVideoUploadStatus.FINALIZE_QUEUED,
          version: { increment: 1 }
        },
        include: sessionInclude,
        where: { id: sessionId, status: FieldEvidenceVideoUploadStatus.UPLOADING }
      });
      return toSessionSnapshot(updated);
    });
  }

  async claimDue(limit: number, leaseMs: number): Promise<FieldVideoUploadSessionSnapshot[]> {
    if (limit <= 0 || leaseMs <= 0) {
      return [];
    }
    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "field_evidence_video_upload_session"
        WHERE (
          (
            "status" IN ('FINALIZE_QUEUED', 'OSS_COMPLETING', 'OBJECT_READY', 'PROCESSING')
            AND ("lease_owner" IS NULL OR "lease_expires_at" <= clock_timestamp())
          ) OR (
            "status" = 'RETRYABLE_FAILED'
            AND "lease_owner" IS NULL
            AND "lease_expires_at" <= clock_timestamp()
          )
        )
        ORDER BY "updated_at" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      if (candidates.length === 0) {
        return [];
      }
      const ids = candidates.map(({ id }) => id);
      const leaseOwner = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        UPDATE "field_evidence_video_upload_session"
        SET
          "status" = CASE
            WHEN "status" = 'RETRYABLE_FAILED'
              THEN COALESCE("resume_stage", 'FINALIZE_QUEUED'::"field_evidence_video_upload_status")
            ELSE "status"
          END,
          "lease_owner" = ${leaseOwner},
          "lease_expires_at" = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
          "updated_at" = clock_timestamp(),
          "version" = "version" + 1
        WHERE "id" = ANY(ARRAY[${Prisma.join(ids)}]::uuid[])
      `);
      const rows = await tx.fieldEvidenceVideoUploadSession.findMany({
        include: sessionInclude,
        where: { id: { in: ids }, leaseOwner }
      });
      return rows.filter(hasLease).map(toSessionSnapshot);
    });
  }

  async expireDue(limit: number, leaseMs: number): Promise<FieldVideoUploadSessionSnapshot[]> {
    if (limit <= 0 || leaseMs <= 0) {
      return [];
    }
    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "field_evidence_video_upload_session"
        WHERE "status" = 'UPLOADING'
          AND "expires_at" <= clock_timestamp()
          AND ("lease_owner" IS NULL OR "lease_expires_at" <= clock_timestamp())
        ORDER BY "expires_at" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      if (candidates.length === 0) {
        return [];
      }
      const ids = candidates.map(({ id }) => id);
      const leaseOwner = `expire:${randomUUID()}`;
      await tx.$executeRaw(Prisma.sql`
        UPDATE "field_evidence_video_upload_session"
        SET
          "lease_owner" = ${leaseOwner},
          "lease_expires_at" = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
          "updated_at" = clock_timestamp(),
          "version" = "version" + 1
        WHERE "id" = ANY(ARRAY[${Prisma.join(ids)}]::uuid[])
      `);
      const rows = await tx.fieldEvidenceVideoUploadSession.findMany({
        include: sessionInclude,
        where: { id: { in: ids }, leaseOwner }
      });
      return rows.filter(hasLease).map(toSessionSnapshot);
    });
  }

  async advanceClaimed(input: {
    leaseOwner: string;
    objectCompletedAt?: Date;
    objectEtag?: string;
    processingCompletedAt?: Date;
    sessionId: string;
    status: FieldEvidenceVideoUploadStatus;
  }): Promise<boolean> {
    const updated = await this.prisma.fieldEvidenceVideoUploadSession.updateMany({
      data: {
        objectCompletedAt: input.objectCompletedAt,
        objectEtag: input.objectEtag,
        processingCompletedAt: input.processingCompletedAt,
        status: input.status,
        version: { increment: 1 }
      },
      where: { id: input.sessionId, leaseOwner: input.leaseOwner }
    });
    return updated.count === 1;
  }

  async markRetryableFailure(input: {
    code: string;
    delayMs: number;
    leaseOwner: string;
    message: string;
    resumeStage: FieldEvidenceVideoUploadStatus;
    sessionId: string;
  }): Promise<boolean> {
    const updated = await this.prisma.fieldEvidenceVideoUploadSession.updateMany({
      data: {
        failureCode: input.code,
        failureMessage: input.message,
        leaseExpiresAt: new Date(Date.now() + input.delayMs),
        leaseOwner: null,
        resumeStage: input.resumeStage,
        retryCount: { increment: 1 },
        status: FieldEvidenceVideoUploadStatus.RETRYABLE_FAILED,
        version: { increment: 1 }
      },
      where: { id: input.sessionId, leaseOwner: input.leaseOwner }
    });
    return updated.count === 1;
  }

  async retryFailed(sessionId: string): Promise<boolean> {
    const updated = await this.prisma.fieldEvidenceVideoUploadSession.updateMany({
      data: {
        failureCode: null,
        failureMessage: null,
        leaseExpiresAt: new Date(),
        version: { increment: 1 }
      },
      where: {
        id: sessionId,
        leaseOwner: null,
        status: FieldEvidenceVideoUploadStatus.RETRYABLE_FAILED
      }
    });
    return updated.count === 1;
  }

  async claimCancellation(
    sessionId: string,
    leaseMs: number
  ): Promise<FieldVideoUploadSessionSnapshot | null> {
    if (leaseMs <= 0) {
      return null;
    }
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const leaseOwner = `cancel:${randomUUID()}`;
      const updated = await tx.fieldEvidenceVideoUploadSession.updateMany({
        data: {
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          leaseOwner,
          version: { increment: 1 }
        },
        where: {
          id: sessionId,
          status: { in: [...FIELD_VIDEO_LIVE_STATUSES] },
          OR: [{ leaseOwner: null }, { leaseExpiresAt: { lte: now } }]
        }
      });
      if (updated.count !== 1) {
        return null;
      }
      const row = await tx.fieldEvidenceVideoUploadSession.findUnique({
        include: sessionInclude,
        where: { id: sessionId }
      });
      return row?.leaseOwner === leaseOwner ? toSessionSnapshot(row) : null;
    });
  }

  async releaseLease(sessionId: string, leaseOwner: string): Promise<boolean> {
    const updated = await this.prisma.fieldEvidenceVideoUploadSession.updateMany({
      data: {
        leaseExpiresAt: null,
        leaseOwner: null,
        version: { increment: 1 }
      },
      where: { id: sessionId, leaseOwner }
    });
    return updated.count === 1;
  }

  async markTerminal(input: {
    code?: string;
    leaseOwner: string;
    message?: string;
    sessionId: string;
    status:
      | typeof FieldEvidenceVideoUploadStatus.VALIDATION_FAILED
      | typeof FieldEvidenceVideoUploadStatus.COMPLETED
      | typeof FieldEvidenceVideoUploadStatus.CANCELLED
      | typeof FieldEvidenceVideoUploadStatus.EXPIRED;
  }): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.fieldEvidenceVideoUploadSession.updateMany({
      data: {
        cancelledAt: input.status === FieldEvidenceVideoUploadStatus.CANCELLED ? now : undefined,
        completedAt: input.status === FieldEvidenceVideoUploadStatus.COMPLETED ? now : undefined,
        failureCode: input.code ?? null,
        failureMessage: input.message ?? null,
        leaseExpiresAt: null,
        leaseOwner: null,
        objectEtag: null,
        objectKey: null,
        ossUploadId: null,
        resumeStage: null,
        status: input.status,
        version: { increment: 1 }
      },
      where: { id: input.sessionId, leaseOwner: input.leaseOwner }
    });
    return updated.count === 1;
  }

  async listActive(): Promise<FieldVideoUploadSessionSnapshot[]> {
    const rows = await this.prisma.fieldEvidenceVideoUploadSession.findMany({
      include: sessionInclude,
      orderBy: { updatedAt: "desc" },
      where: { status: { in: [...FIELD_VIDEO_LIVE_STATUSES] } }
    });
    return rows.map(toSessionSnapshot);
  }
}

function toSessionSnapshot(row: SessionRow): FieldVideoUploadSessionSnapshot {
  return {
    cancelledAt: row.cancelledAt,
    chunkSizeBytes: row.chunkSizeBytes,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    createdBySessionId: row.createdBySessionId,
    evidenceItemId: row.evidenceItemId,
    evidenceTitle: row.evidenceItem.title,
    expiresAt: row.expiresAt,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    fingerprintHash: row.fingerprintHash,
    id: row.id,
    internal: {
      objectEtag: row.objectEtag,
      objectKey: row.objectKey,
      ossUploadId: row.ossUploadId
    },
    lastModifiedMs: Number(row.lastModifiedMs),
    leaseExpiresAt: row.leaseExpiresAt,
    leaseOwner: row.leaseOwner,
    mimeType: row.mimeType,
    objectCompletedAt: row.objectCompletedAt,
    originalName: row.originalName,
    parts: row.parts.map(toPartSnapshot),
    processingCompletedAt: row.processingCompletedAt,
    replaceEvidenceFileId: row.replaceEvidenceFileId,
    resumeStage: row.resumeStage,
    retryCount: row.retryCount,
    sizeBytes: Number(row.sizeBytes),
    status: row.status,
    totalParts: row.totalParts,
    updatedAt: row.updatedAt,
    version: row.version,
    workOrderId: row.workOrderId
  };
}

function toPartSnapshot(row: {
  completedAt: Date;
  ossEtag: string;
  partNumber: number;
  sha256: string;
  sizeBytes: number;
}): FieldVideoUploadPartSnapshot {
  return {
    completedAt: row.completedAt,
    internal: { ossEtag: row.ossEtag },
    partNumber: row.partNumber,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes
  };
}

function hasLease(row: SessionRow) {
  return typeof row.leaseOwner === "string" && row.leaseExpiresAt instanceof Date;
}

function expiresFromNow() {
  return new Date(Date.now() + FIELD_VIDEO_UPLOAD_TTL_MS);
}

function activeFileConflict() {
  return new ConflictException({
    code: "VIDEO_UPLOAD_ACTIVE_FILE_CONFLICT",
    message: "该资料已有其他视频正在上传，请继续原文件或先取消旧上传。"
  });
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
