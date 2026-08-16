import { ConflictException } from "@nestjs/common";
import { FieldEvidenceVideoUploadStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FieldVideoUploadRepository } from "../src/field-operator/field-video-upload.repository";

describe("FieldVideoUploadRepository", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resumes the same live fingerprint instead of creating another session", async () => {
    const existing = uploadSession();
    const tx = {
      fieldEvidenceVideoUploadSession: {
        findFirst: vi.fn(async () => existing),
        update: vi.fn(async ({ data }: { data: { expiresAt: Date } }) => ({
          ...existing,
          expiresAt: data.expiresAt
        }))
      }
    };
    const repository = repositoryWithTransaction(tx);

    const result = await repository.createOrResume(createInput(existing));

    expect(result.disposition).toBe("RESUMED");
    expect(result.session.id).toBe(existing.id);
    expect(tx.fieldEvidenceVideoUploadSession.update).toHaveBeenCalledOnce();
  });

  it("rejects a different file while the evidence item has a live session", async () => {
    const existing = uploadSession({ fingerprintHash: "b".repeat(64) });
    const repository = repositoryWithTransaction({
      fieldEvidenceVideoUploadSession: {
        findFirst: vi.fn(async () => existing)
      }
    });

    await expect(repository.createOrResume(createInput(existing))).rejects.toMatchObject({
      response: expect.objectContaining({ code: "VIDEO_UPLOAD_ACTIVE_FILE_CONFLICT" })
    });
  });

  it("records the same part idempotently and rejects different content", async () => {
    const session = uploadSession();
    const existingPart = uploadPart({ sessionId: session.id });
    const tx = {
      fieldEvidenceVideoUploadPart: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(existingPart)
          .mockResolvedValueOnce(existingPart),
        create: vi.fn(async () => existingPart)
      },
      fieldEvidenceVideoUploadSession: {
        findUnique: vi.fn(async () => session),
        update: vi.fn(async () => session)
      }
    };
    const repository = repositoryWithTransaction(tx);
    const input = {
      ossEtag: "etag-1",
      partNumber: 1,
      sessionId: session.id,
      sha256: "c".repeat(64),
      sizeBytes: 8 * 1024 * 1024
    };

    await expect(repository.recordPart(input)).resolves.toMatchObject({
      partNumber: 1,
      sha256: "c".repeat(64)
    });
    await expect(repository.recordPart(input)).resolves.toMatchObject({ partNumber: 1 });
    await expect(
      repository.recordPart({ ...input, sha256: "d".repeat(64) })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.fieldEvidenceVideoUploadPart.create).toHaveBeenCalledOnce();
  });

  it("queues finalization only when every expected part exists", async () => {
    const incomplete = uploadSession({
      parts: [uploadPart()],
      sizeBytes: BigInt(16 * 1024 * 1024),
      totalParts: 2
    });
    const complete = uploadSession({
      id: incomplete.id,
      parts: [uploadPart(), uploadPart({ partNumber: 2 })],
      sizeBytes: BigInt(16 * 1024 * 1024),
      totalParts: 2
    });
    const tx = {
      fieldEvidenceVideoUploadSession: {
        findUnique: vi.fn().mockResolvedValueOnce(incomplete).mockResolvedValueOnce(complete),
        update: vi.fn(async () => ({
          ...complete,
          status: FieldEvidenceVideoUploadStatus.FINALIZE_QUEUED
        }))
      }
    };
    const repository = repositoryWithTransaction(tx);

    await expect(repository.queueFinalization(incomplete.id)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "VIDEO_UPLOAD_PARTS_INCOMPLETE" })
    });
    await expect(repository.queueFinalization(incomplete.id)).resolves.toMatchObject({
      status: FieldEvidenceVideoUploadStatus.FINALIZE_QUEUED
    });
  });

  it("claims due finalization with a lease and reclaims an expired lease", async () => {
    const claimed = uploadSession({
      leaseExpiresAt: new Date("2026-08-15T00:05:00.000Z"),
      leaseOwner: "lease-1",
      status: FieldEvidenceVideoUploadStatus.OBJECT_READY
    });
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async (query: unknown) => {
        void query;
        return [{ id: claimed.id }];
      }),
      fieldEvidenceVideoUploadSession: {
        findMany: vi.fn(async () => [claimed])
      }
    };
    const repository = repositoryWithTransaction(tx);

    const result = await repository.claimDue(1, 300_000);

    expect(result).toMatchObject([
      {
        id: claimed.id,
        internal: {
          objectKey: claimed.objectKey,
          ossUploadId: claimed.ossUploadId
        },
        leaseOwner: claimed.leaseOwner,
        status: FieldEvidenceVideoUploadStatus.OBJECT_READY
      }
    ]);
    const query = tx.$queryRaw.mock.calls[0]?.[0] as { strings: string[] };
    expect(query.strings.join(" ")).toContain("FOR UPDATE SKIP LOCKED");
    expect(query.strings.join(" ")).toContain("lease_expires_at");
  });

  it("persists retry count and restart-safe retry scheduling", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const repository = new FieldVideoUploadRepository({
      fieldEvidenceVideoUploadSession: { updateMany }
    } as never);

    await expect(
      repository.markRetryableFailure({
        code: "OSS_TIMEOUT",
        delayMs: 300_000,
        leaseOwner: "lease-1",
        message: "OSS 暂时不可用。",
        resumeStage: FieldEvidenceVideoUploadStatus.OBJECT_READY,
        sessionId: randomUUID()
      })
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          retryCount: { increment: 1 },
          status: FieldEvidenceVideoUploadStatus.RETRYABLE_FAILED
        })
      })
    );
  });

  it("claims inactive uploading sessions for expiry cleanup after 24 hours", async () => {
    const expired = uploadSession({
      expiresAt: new Date("2026-08-14T00:00:00.000Z"),
      leaseExpiresAt: new Date("2026-08-15T00:05:00.000Z"),
      leaseOwner: "expire:lease-1"
    });
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async (query: unknown) => {
        void query;
        return [{ id: expired.id }];
      }),
      fieldEvidenceVideoUploadSession: {
        findMany: vi.fn(async () => [expired])
      }
    };
    const repository = repositoryWithTransaction(tx);

    const result = await repository.expireDue(1, 300_000);

    expect(result).toMatchObject([
      {
        id: expired.id,
        leaseOwner: expired.leaseOwner,
        status: FieldEvidenceVideoUploadStatus.UPLOADING
      }
    ]);
    const query = tx.$queryRaw.mock.calls[0]?.[0] as { strings: string[] };
    expect(query.strings.join(" ")).toContain(`"status" = 'UPLOADING'`);
    expect(query.strings.join(" ")).toContain(`"expires_at" <= clock_timestamp()`);
  });
});

function repositoryWithTransaction(transaction: Record<string, unknown>) {
  return new FieldVideoUploadRepository({
    $transaction: (operation: (tx: typeof transaction) => unknown) => operation(transaction)
  } as never);
}

function createInput(existing: ReturnType<typeof uploadSession>) {
  return {
    chunkSizeBytes: 8 * 1024 * 1024,
    createdBySessionId: randomUUID(),
    evidenceItemId: existing.evidenceItemId,
    expiresAt: new Date("2026-08-16T00:00:00.000Z"),
    fingerprintHash: "a".repeat(64),
    lastModifiedMs: 1_786_700_000_000,
    mimeType: "video/quicktime",
    objectKey: "subscription/field-video/upload-sessions/session-1/source",
    originalName: "IMG_0284.MOV",
    ossUploadId: "oss-upload-1",
    replaceEvidenceFileId: null,
    sessionId: existing.id,
    sizeBytes: 8 * 1024 * 1024,
    totalParts: 1,
    workOrderId: existing.workOrderId
  };
}

function uploadSession(override: Partial<ReturnType<typeof baseUploadSession>> = {}) {
  return { ...baseUploadSession(), ...override };
}

function baseUploadSession() {
  const id = randomUUID();
  return {
    cancelledAt: null,
    chunkSizeBytes: 8 * 1024 * 1024,
    completedAt: null,
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
    createdBySessionId: randomUUID(),
    evidenceItem: { title: "车辆环绕视频" },
    evidenceItemId: randomUUID(),
    expiresAt: new Date("2026-08-16T00:00:00.000Z"),
    failureCode: null,
    failureMessage: null,
    fingerprintHash: "a".repeat(64),
    id,
    lastModifiedMs: BigInt(1_786_700_000_000),
    leaseExpiresAt: null as Date | null,
    leaseOwner: null as string | null,
    mimeType: "video/quicktime",
    objectCompletedAt: null,
    objectEtag: null,
    objectKey: "subscription/field-video/upload-sessions/session-1/source",
    originalName: "IMG_0284.MOV",
    ossUploadId: "oss-upload-1",
    parts: [] as ReturnType<typeof uploadPart>[],
    processingCompletedAt: null,
    replaceEvidenceFileId: null,
    resumeStage: null as FieldEvidenceVideoUploadStatus | null,
    retryCount: 0,
    sizeBytes: BigInt(8 * 1024 * 1024),
    status: FieldEvidenceVideoUploadStatus.UPLOADING as FieldEvidenceVideoUploadStatus,
    totalParts: 1,
    updatedAt: new Date("2026-08-15T00:00:00.000Z"),
    version: 0,
    workOrderId: randomUUID()
  };
}

function uploadPart(override: Partial<ReturnType<typeof baseUploadPart>> = {}) {
  return { ...baseUploadPart(), ...override };
}

function baseUploadPart() {
  return {
    completedAt: new Date("2026-08-15T00:01:00.000Z"),
    createdAt: new Date("2026-08-15T00:01:00.000Z"),
    id: randomUUID(),
    ossEtag: "etag-1",
    partNumber: 1,
    sessionId: randomUUID(),
    sha256: "c".repeat(64),
    sizeBytes: 8 * 1024 * 1024,
    updatedAt: new Date("2026-08-15T00:01:00.000Z")
  };
}
