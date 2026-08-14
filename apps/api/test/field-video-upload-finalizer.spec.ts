import { FieldEvidenceVideoUploadStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { DeliveryEvidenceVideoQualityError } from "../src/delivery-handover/delivery-handover-evidence-artifact.service";
import { FieldVideoUploadFinalizerService } from "../src/field-operator/field-video-upload-finalizer.service";

describe("FieldVideoUploadFinalizerService", () => {
  it("resumes from OBJECT_READY without completing OSS twice", async () => {
    const harness = finalizerHarness({ status: FieldEvidenceVideoUploadStatus.OBJECT_READY });

    await harness.finalizer.finalize(harness.session);

    expect(harness.storage.completeFieldVideoMultipart).not.toHaveBeenCalled();
    expect(harness.handover.attachPreparedFieldVideoFromStoredSource).toHaveBeenCalledOnce();
    expect(harness.repository.markTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: harness.session.id,
        status: FieldEvidenceVideoUploadStatus.COMPLETED
      })
    );
  });

  it("advances every durable stage and completes with ordered OSS parts", async () => {
    const harness = finalizerHarness({ status: FieldEvidenceVideoUploadStatus.FINALIZE_QUEUED });

    await harness.finalizer.finalize(harness.session);

    expect(harness.storage.completeFieldVideoMultipart).toHaveBeenCalledWith({
      key: harness.session.internal.objectKey,
      parts: [
        { etag: "etag-1", partNumber: 1, sizeBytes: 8 },
        { etag: "etag-2", partNumber: 2, sizeBytes: 3 }
      ],
      sizeBytes: harness.session.sizeBytes,
      uploadId: harness.session.internal.ossUploadId
    });
    expect(harness.repository.advanceClaimed.mock.calls.map(([input]) => input.status)).toEqual([
      FieldEvidenceVideoUploadStatus.OSS_COMPLETING,
      FieldEvidenceVideoUploadStatus.OBJECT_READY,
      FieldEvidenceVideoUploadStatus.PROCESSING
    ]);
    expect(harness.prepared.cleanup).toHaveBeenCalledOnce();
    expect(harness.handover.recordFieldVideoUploadEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "FIELD_VIDEO_UPLOAD_COMPLETED",
        sessionId: harness.session.id
      })
    );
  });

  it("keeps the old evidence active when 720p validation fails", async () => {
    const oldFileId = randomUUID();
    const harness = finalizerHarness({
      replaceEvidenceFileId: oldFileId,
      status: FieldEvidenceVideoUploadStatus.OBJECT_READY
    });
    harness.artifact.prepareUpload.mockRejectedValueOnce(
      new DeliveryEvidenceVideoQualityError(640, 360)
    );

    await harness.finalizer.finalize(harness.session);

    expect(harness.handover.attachPreparedFieldVideoFromStoredSource).not.toHaveBeenCalled();
    expect(harness.storage.deleteFieldVideoUploadSource).toHaveBeenCalledOnce();
    expect(harness.repository.markTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "VIDEO_RESOLUTION_TOO_LOW",
        status: FieldEvidenceVideoUploadStatus.VALIDATION_FAILED
      })
    );
    expect(harness.handover.recordFieldVideoUploadEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "VIDEO_RESOLUTION_TOO_LOW",
        eventType: "FIELD_VIDEO_UPLOAD_FAILED"
      })
    );
  });

  it("persists a retryable stage after OSS completion fails", async () => {
    const harness = finalizerHarness({ status: FieldEvidenceVideoUploadStatus.FINALIZE_QUEUED });
    harness.storage.completeFieldVideoMultipart.mockRejectedValueOnce(new Error("private detail"));

    await harness.finalizer.finalize(harness.session);

    expect(harness.repository.markRetryableFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "VIDEO_UPLOAD_OSS_COMPLETE_FAILED",
        resumeStage: FieldEvidenceVideoUploadStatus.OSS_COMPLETING,
        sessionId: harness.session.id
      })
    );
    expect(harness.handover.recordFieldVideoUploadEvent).not.toHaveBeenCalled();
  });

  it("cleans derivatives and retries PROCESSING after the evidence transaction fails", async () => {
    const harness = finalizerHarness({ status: FieldEvidenceVideoUploadStatus.OBJECT_READY });
    harness.handover.attachPreparedFieldVideoFromStoredSource.mockRejectedValueOnce(
      new Error("serialization conflict")
    );

    await harness.finalizer.finalize(harness.session);

    expect(harness.prepared.cleanup).toHaveBeenCalledOnce();
    expect(harness.storage.deleteFieldVideoUploadSource).not.toHaveBeenCalled();
    expect(harness.repository.markRetryableFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "VIDEO_UPLOAD_PROCESSING_FAILED",
        resumeStage: FieldEvidenceVideoUploadStatus.PROCESSING
      })
    );
  });
});

function finalizerHarness(overrides: Record<string, unknown> = {}) {
  const session = uploadSession(overrides);
  const repository = {
    advanceClaimed: vi.fn(async (input: { status: FieldEvidenceVideoUploadStatus }) => {
      void input;
      return true;
    }),
    markRetryableFailure: vi.fn(async () => true),
    markTerminal: vi.fn(async () => true)
  };
  const storage = {
    completeFieldVideoMultipart: vi.fn(async () => ({
      etag: "object-etag",
      key: session.internal.objectKey,
      sizeBytes: session.sizeBytes
    })),
    deleteFieldVideoUploadSource: vi.fn(async () => undefined),
    downloadFieldVideoUploadSource: vi.fn(async () => ({
      contentLength: session.sizeBytes,
      contentType: session.mimeType,
      stream: Readable.from([Buffer.from("video-source")])
    })),
    resolveFieldVideoUploadSourceIdentity: vi.fn(() => ({
      bucket: "oss:video-bucket",
      objectKey: `oss:${session.internal.objectKey}`
    }))
  };
  const prepared = {
    cleanup: vi.fn(async () => undefined),
    derivatives: [
      {
        contentType: "image/jpeg" as const,
        filePath: "frame.jpg",
        kind: "VIDEO_FRAME" as const,
        originalName: "frame.jpg",
        sizeBytes: 10
      }
    ],
    metadata: {
      artifactVersion: 1 as const,
      detectedCodec: "h264",
      detectedMimeType: "video/quicktime",
      processedAt: "2026-08-15T00:00:00.000Z",
      processingStatus: "READY" as const,
      sourceSha256: "sha256:test",
      sourceSizeBytes: session.sizeBytes,
      videoBitRateBps: 1,
      videoDurationMs: 1,
      videoFrameRate: 30,
      videoHeightPx: 1080,
      videoQualityStatus: "PASSED" as const,
      videoWidthPx: 1920
    }
  };
  const artifact = { prepareUpload: vi.fn(async () => prepared) };
  const handover = {
    attachPreparedFieldVideoFromStoredSource: vi.fn(async () => ({ id: session.evidenceItemId })),
    recordFieldVideoUploadEvent: vi.fn(async () => undefined)
  };
  return {
    artifact,
    finalizer: new FieldVideoUploadFinalizerService(
      repository as never,
      storage as never,
      artifact as never,
      handover as never
    ),
    handover,
    prepared,
    repository,
    session,
    storage
  };
}

function uploadSession(overrides: Record<string, unknown> = {}) {
  const leaseOwner = randomUUID();
  return {
    cancelledAt: null,
    chunkSizeBytes: 8,
    completedAt: null,
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
    createdBySessionId: randomUUID(),
    evidenceItemId: randomUUID(),
    evidenceTitle: "车辆环绕视频",
    expiresAt: new Date("2026-08-16T00:00:00.000Z"),
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
    leaseExpiresAt: new Date("2026-08-15T00:05:00.000Z"),
    leaseOwner,
    mimeType: "video/quicktime",
    objectCompletedAt: null,
    originalName: "IMG_0284.MOV",
    parts: [
      {
        completedAt: new Date(),
        internal: { ossEtag: "etag-2" },
        partNumber: 2,
        sha256: "b".repeat(64),
        sizeBytes: 3
      },
      {
        completedAt: new Date(),
        internal: { ossEtag: "etag-1" },
        partNumber: 1,
        sha256: "a".repeat(64),
        sizeBytes: 8
      }
    ],
    processingCompletedAt: null,
    replaceEvidenceFileId: null,
    resumeStage: null,
    retryCount: 0,
    sizeBytes: 11,
    status: FieldEvidenceVideoUploadStatus.FINALIZE_QUEUED,
    totalParts: 2,
    updatedAt: new Date("2026-08-15T00:00:00.000Z"),
    version: 0,
    workOrderId: randomUUID(),
    ...overrides
  };
}
