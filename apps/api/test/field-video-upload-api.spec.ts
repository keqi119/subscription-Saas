import { UnauthorizedException } from "@nestjs/common";
import { DeliveryEvidenceType, FieldEvidenceVideoUploadStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { FieldVideoUploadService } from "../src/field-operator/field-video-upload.service";
import { MAX_FIELD_VIDEO_SIZE_BYTES } from "../src/field-operator/field-video-upload.constants";

describe("FieldVideoUploadService", () => {
  it("creates a safe resumable session without exposing OSS fields", async () => {
    const harness = serviceHarness();

    const result = await harness.service.createOrResume(
      harness.workOrderId,
      harness.evidenceItemId,
      "13800138000",
      randomUUID(),
      createDto()
    );

    expect(result).toMatchObject({
      chunkSizeBytes: 8 * 1024 * 1024,
      completedPartNumbers: [],
      sessionId: harness.session.id,
      status: FieldEvidenceVideoUploadStatus.UPLOADING
    });
    expect(JSON.stringify(result)).not.toMatch(/oss|bucket|objectKey|etag|lease/i);
    expect(harness.storage.beginFieldVideoMultipart).toHaveBeenCalledOnce();
  });

  it("rejects 300 MiB plus one byte before starting OSS multipart", async () => {
    const harness = serviceHarness();

    await expect(
      harness.service.createOrResume(
        harness.workOrderId,
        harness.evidenceItemId,
        "13800138000",
        randomUUID(),
        createDto({ sizeBytes: MAX_FIELD_VIDEO_SIZE_BYTES + 1 })
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "VIDEO_TOO_LARGE" }),
      status: 413
    });
    expect(harness.storage.beginFieldVideoMultipart).not.toHaveBeenCalled();
  });

  it("resumes an existing same-file session without creating another OSS upload", async () => {
    const harness = serviceHarness({ live: true });

    const result = await harness.service.createOrResume(
      harness.workOrderId,
      harness.evidenceItemId,
      "13800138000",
      randomUUID(),
      createDto()
    );

    expect(result.sessionId).toBe(harness.session.id);
    expect(harness.storage.beginFieldVideoMultipart).not.toHaveBeenCalled();
    expect(harness.handover.recordFieldVideoUploadEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "FIELD_VIDEO_UPLOAD_RESUMED" })
    );
  });

  it("rejects a session read from another work order", async () => {
    const harness = serviceHarness();

    await expect(
      harness.service.getStatus(
        randomUUID(),
        harness.evidenceItemId,
        harness.session.id,
        "13800138000"
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "VIDEO_UPLOAD_SESSION_SCOPE_MISMATCH" })
    });
  });

  it("returns only active sessions still authorized for the current operator", async () => {
    const harness = serviceHarness();
    const inaccessible = sessionSnapshot({
      evidenceItemId: randomUUID(),
      id: randomUUID(),
      workOrderId: randomUUID()
    });
    harness.repository.listActive.mockResolvedValue([harness.session, inaccessible]);
    harness.handover.authorizeFieldVideoUploadMutation.mockImplementation(
      async (input: { workOrderId: string }) => {
        if (input.workOrderId === inaccessible.workOrderId) {
          throw new UnauthorizedException("not assigned");
        }
        return authorization(harness);
      }
    );

    await expect(harness.service.listActive("13800138000")).resolves.toEqual([
      expect.objectContaining({ sessionId: harness.session.id })
    ]);
  });

  it("queues completion only for a scoped upload session", async () => {
    const harness = serviceHarness();

    await expect(
      harness.service.complete(
        harness.workOrderId,
        harness.evidenceItemId,
        harness.session.id,
        "13800138000"
      )
    ).resolves.toMatchObject({ sessionId: harness.session.id });
    expect(harness.repository.queueFinalization).toHaveBeenCalledWith(harness.session.id);
  });

  it("requeues only a retryable failed session", async () => {
    const retryable = sessionSnapshot({
      status: FieldEvidenceVideoUploadStatus.RETRYABLE_FAILED
    });
    const harness = serviceHarness({ session: retryable });

    await expect(
      harness.service.retry(
        harness.workOrderId,
        harness.evidenceItemId,
        retryable.id,
        "13800138000"
      )
    ).resolves.toMatchObject({ sessionId: retryable.id });
    expect(harness.repository.retryFailed).toHaveBeenCalledWith(retryable.id);
  });

  it("aborts storage before marking a cancelled session terminal", async () => {
    const harness = serviceHarness();

    await expect(
      harness.service.cancel(
        harness.workOrderId,
        harness.evidenceItemId,
        harness.session.id,
        "13800138000",
        randomUUID()
      )
    ).resolves.toMatchObject({ status: FieldEvidenceVideoUploadStatus.CANCELLED });
    expect(harness.storage.abortFieldVideoMultipart).toHaveBeenCalledWith({
      key: harness.session.internal.objectKey,
      uploadId: harness.session.internal.ossUploadId
    });
    expect(harness.repository.markTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseOwner: "cancel:lease-1",
        sessionId: harness.session.id,
        status: FieldEvidenceVideoUploadStatus.CANCELLED
      })
    );
    expect(harness.handover.recordFieldVideoUploadEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "FIELD_VIDEO_UPLOAD_CANCELLED" })
    );
  });

  it.each(["ossUploadId", "objectKey", "objectEtag", "bucket", "etag", "leaseOwner"])(
    "never exposes internal field %s in public service responses",
    async (forbiddenField) => {
      const harness = serviceHarness();
      const publicResponses = [
        await harness.service.createOrResume(
          harness.workOrderId,
          harness.evidenceItemId,
          "13800138000",
          randomUUID(),
          createDto()
        ),
        await harness.service.getStatus(
          harness.workOrderId,
          harness.evidenceItemId,
          harness.session.id,
          "13800138000"
        ),
        await harness.service.listActive("13800138000"),
        await harness.service.complete(
          harness.workOrderId,
          harness.evidenceItemId,
          harness.session.id,
          "13800138000"
        )
      ];

      expect(JSON.stringify(publicResponses)).not.toContain(`"${forbiddenField}"`);
    }
  );
});

function serviceHarness(
  options: { live?: boolean; session?: ReturnType<typeof sessionSnapshot> } = {}
) {
  const workOrderId = options.session?.workOrderId ?? randomUUID();
  const evidenceItemId = options.session?.evidenceItemId ?? randomUUID();
  const session = options.session ?? sessionSnapshot({ evidenceItemId, workOrderId });
  const repository = {
    createOrResume: vi.fn(async () => ({
      disposition: options.live ? ("RESUMED" as const) : ("CREATED" as const),
      session
    })),
    findById: vi.fn(async () => session),
    findLiveForEvidenceItem: vi.fn(async () => (options.live ? session : null)),
    listActive: vi.fn(async () => [session]),
    markTerminal: vi.fn(async () => true),
    queueFinalization: vi.fn(async () => ({
      ...session,
      status: FieldEvidenceVideoUploadStatus.FINALIZE_QUEUED
    })),
    retryFailed: vi.fn(async () => true),
    claimCancellation: vi.fn(async () => ({
      ...session,
      leaseExpiresAt: new Date("2026-08-15T00:05:00.000Z"),
      leaseOwner: "cancel:lease-1"
    }))
  };
  const storage = {
    abortFieldVideoMultipart: vi.fn(async () => undefined),
    beginFieldVideoMultipart: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      key: `subscription/field-video/upload-sessions/${sessionId}/source`,
      uploadId: "oss-upload-1"
    })),
    deleteFieldVideoUploadSource: vi.fn(async () => undefined)
  };
  const handover = {
    authorizeFieldVideoUploadMutation: vi.fn(async (input: { workOrderId: string }) => {
      void input;
      return authorization({ evidenceItemId, workOrderId });
    }),
    recordFieldVideoUploadEvent: vi.fn(async () => undefined)
  };
  return {
    evidenceItemId,
    handover,
    repository,
    service: new FieldVideoUploadService(repository as never, storage as never, handover as never),
    session,
    storage,
    workOrderId
  };
}

function authorization(input: { evidenceItemId: string; workOrderId: string }) {
  return {
    evidenceType: DeliveryEvidenceType.WALKAROUND_VIDEO,
    itemId: input.evidenceItemId,
    orderId: randomUUID(),
    replaceEvidenceFileId: null,
    workOrderId: input.workOrderId
  };
}

function createDto(override: Partial<ReturnType<typeof baseCreateDto>> = {}) {
  return { ...baseCreateDto(), ...override };
}

function baseCreateDto() {
  return {
    fileName: "IMG_0284.MOV",
    fingerprintSha256: "a".repeat(64),
    lastModifiedMs: 1_786_700_000_000,
    mimeType: "video/quicktime",
    sizeBytes: 226_900_000
  };
}

function sessionSnapshot(override: Partial<ReturnType<typeof baseSessionSnapshot>> = {}) {
  return { ...baseSessionSnapshot(), ...override };
}

function baseSessionSnapshot() {
  return {
    cancelledAt: null,
    chunkSizeBytes: 8 * 1024 * 1024,
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
      objectKey: "subscription/field-video/upload-sessions/session-1/source",
      ossUploadId: "oss-upload-1"
    },
    lastModifiedMs: 1_786_700_000_000,
    leaseExpiresAt: null,
    leaseOwner: null,
    mimeType: "video/quicktime",
    objectCompletedAt: null,
    originalName: "IMG_0284.MOV",
    parts: [],
    processingCompletedAt: null,
    replaceEvidenceFileId: null,
    resumeStage: null,
    retryCount: 0,
    sizeBytes: 226_900_000,
    status: FieldEvidenceVideoUploadStatus.UPLOADING as FieldEvidenceVideoUploadStatus,
    totalParts: 28,
    updatedAt: new Date("2026-08-15T00:00:00.000Z"),
    version: 0,
    workOrderId: randomUUID()
  };
}
