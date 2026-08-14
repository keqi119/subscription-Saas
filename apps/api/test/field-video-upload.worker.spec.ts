import { ConfigService } from "@nestjs/config";
import { FieldEvidenceVideoUploadStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { FieldVideoUploadWorker } from "../src/field-operator/field-video-upload.worker";

describe("FieldVideoUploadWorker", () => {
  it("claims and finalizes each session only once", async () => {
    const session = uploadSession();
    const repository = {
      claimDue: vi.fn().mockResolvedValueOnce([session]).mockResolvedValueOnce([]),
      expireDue: vi.fn(async () => [])
    };
    const finalizer = { finalize: vi.fn(async () => undefined) };
    const worker = createWorker(repository, finalizer);

    await worker.runOnce();
    await worker.runOnce();

    expect(finalizer.finalize).toHaveBeenCalledTimes(1);
    expect(finalizer.finalize).toHaveBeenCalledWith(session);
  });

  it("aborts, deletes, and marks an expired session in order", async () => {
    const session = uploadSession({
      objectCompletedAt: new Date(),
      status: FieldEvidenceVideoUploadStatus.UPLOADING
    });
    const order: string[] = [];
    const repository = {
      claimDue: vi.fn(async () => []),
      expireDue: vi.fn(async () => [session]),
      markTerminal: vi.fn(async () => {
        order.push("terminal");
        return true;
      }),
      releaseLease: vi.fn(async () => true)
    };
    const storage = {
      abortFieldVideoMultipart: vi.fn(async () => {
        order.push("abort");
      }),
      deleteFieldVideoUploadSource: vi.fn(async () => {
        order.push("delete");
      })
    };
    const handover = {
      recordFieldVideoUploadEvent: vi.fn(async () => {
        order.push("event");
      })
    };
    const worker = createWorker(repository, { finalize: vi.fn() }, storage, handover);

    await worker.runOnce();

    expect(order).toEqual(["abort", "delete", "terminal", "event"]);
    expect(repository.markTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "VIDEO_UPLOAD_EXPIRED",
        status: FieldEvidenceVideoUploadStatus.EXPIRED
      })
    );
  });

  it("releases an expiry lease when cleanup fails", async () => {
    const session = uploadSession({ status: FieldEvidenceVideoUploadStatus.UPLOADING });
    const repository = {
      claimDue: vi.fn(async () => []),
      expireDue: vi.fn(async () => [session]),
      markTerminal: vi.fn(async () => true),
      releaseLease: vi.fn(async () => true)
    };
    const storage = {
      abortFieldVideoMultipart: vi.fn(async () => {
        throw new Error("OSS unavailable");
      }),
      deleteFieldVideoUploadSource: vi.fn()
    };
    const worker = createWorker(repository, { finalize: vi.fn() }, storage);

    await worker.runOnce();

    expect(repository.markTerminal).not.toHaveBeenCalled();
    expect(repository.releaseLease).toHaveBeenCalledWith(session.id, session.leaseOwner);
  });
});

function createWorker(
  repository: Record<string, unknown>,
  finalizer: Record<string, unknown>,
  storage: Record<string, unknown> = {},
  handover: Record<string, unknown> = {}
) {
  const values: Record<string, string> = {
    FIELD_VIDEO_UPLOAD_WORKER_CONCURRENCY: "1",
    FIELD_VIDEO_UPLOAD_WORKER_LEASE_MS: "300000",
    FIELD_VIDEO_UPLOAD_WORKER_POLL_INTERVAL_MS: "5000"
  };
  const config = { get: vi.fn((key: string) => values[key]) } as unknown as ConfigService;
  return new FieldVideoUploadWorker(
    repository as never,
    finalizer as never,
    storage as never,
    handover as never,
    config
  );
}

function uploadSession(overrides: Record<string, unknown> = {}) {
  return {
    cancelledAt: null,
    chunkSizeBytes: 8,
    completedAt: null,
    createdAt: new Date(),
    createdBySessionId: randomUUID(),
    evidenceItemId: randomUUID(),
    evidenceTitle: "车辆环绕视频",
    expiresAt: new Date(),
    failureCode: null,
    failureMessage: null,
    fingerprintHash: "a".repeat(64),
    id: randomUUID(),
    internal: {
      objectEtag: null,
      objectKey: "field-video/upload-sessions/session/source",
      ossUploadId: "oss-upload-1"
    },
    lastModifiedMs: 1,
    leaseExpiresAt: new Date(),
    leaseOwner: `expire:${randomUUID()}`,
    mimeType: "video/quicktime",
    objectCompletedAt: null,
    originalName: "IMG_0284.MOV",
    parts: [],
    processingCompletedAt: null,
    replaceEvidenceFileId: null,
    resumeStage: null,
    retryCount: 0,
    sizeBytes: 11,
    status: FieldEvidenceVideoUploadStatus.FINALIZE_QUEUED,
    totalParts: 2,
    updatedAt: new Date(),
    version: 0,
    workOrderId: randomUUID(),
    ...overrides
  };
}
