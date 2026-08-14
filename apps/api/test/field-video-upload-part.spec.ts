import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { FieldVideoUploadService } from "../src/field-operator/field-video-upload.service";

describe("field video upload parts", () => {
  it("streams, verifies, stores, and records one expected part", async () => {
    const file = await tempFile(Buffer.from("verified-part"));
    const harness = partHarness(file.size);
    const sha256 = createHash("sha256").update("verified-part").digest("hex");

    await expect(
      harness.service.uploadPart(
        harness.workOrderId,
        harness.evidenceItemId,
        harness.session.id,
        1,
        sha256,
        file,
        "13800138000"
      )
    ).resolves.toMatchObject({ partNumber: 1, sizeBytes: file.size });
    expect(harness.storage.uploadFieldVideoPart).toHaveBeenCalledWith({
      filePath: file.path,
      key: harness.session.internal.objectKey,
      partNumber: 1,
      sizeBytes: file.size,
      uploadId: harness.session.internal.ossUploadId
    });
    await expect(stat(file.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a mismatched SHA-256 before OSS and removes the temp file", async () => {
    const file = await tempFile(Buffer.from("verified-part"));
    const harness = partHarness(file.size);

    await expect(
      harness.service.uploadPart(
        harness.workOrderId,
        harness.evidenceItemId,
        harness.session.id,
        1,
        "0".repeat(64),
        file,
        "13800138000"
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "CHUNK_HASH_MISMATCH" })
    });
    expect(harness.storage.uploadFieldVideoPart).not.toHaveBeenCalled();
    await expect(stat(file.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-final part with the wrong size", async () => {
    const file = await tempFile(Buffer.from("short"));
    const harness = partHarness(16 * 1024 * 1024);

    await expect(
      harness.service.uploadPart(
        harness.workOrderId,
        harness.evidenceItemId,
        harness.session.id,
        1,
        createHash("sha256").update("short").digest("hex"),
        file,
        "13800138000"
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "CHUNK_SIZE_MISMATCH" })
    });
    expect(harness.storage.uploadFieldVideoPart).not.toHaveBeenCalled();
  });
});

function partHarness(sizeBytes: number) {
  const workOrderId = randomUUID();
  const evidenceItemId = randomUUID();
  const session = {
    cancelledAt: null,
    chunkSizeBytes: 8 * 1024 * 1024,
    completedAt: null,
    createdAt: new Date(),
    createdBySessionId: randomUUID(),
    evidenceItemId,
    evidenceTitle: "车辆环绕视频",
    expiresAt: new Date(Date.now() + 86_400_000),
    failureCode: null,
    failureMessage: null,
    fingerprintHash: "a".repeat(64),
    id: randomUUID(),
    internal: {
      objectEtag: null,
      objectKey: "subscription/field-video/upload-sessions/session-1/source",
      ossUploadId: "oss-upload-1"
    },
    lastModifiedMs: Date.now(),
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
    sizeBytes,
    status: "UPLOADING" as const,
    totalParts: Math.ceil(sizeBytes / (8 * 1024 * 1024)),
    updatedAt: new Date(),
    version: 0,
    workOrderId
  };
  const repository = {
    findById: vi.fn(async () => session),
    recordPart: vi.fn(async (input: { partNumber: number; sha256: string; sizeBytes: number }) => ({
      completedAt: new Date("2026-08-15T00:01:00.000Z"),
      internal: { ossEtag: "etag-1" },
      partNumber: input.partNumber,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes
    }))
  };
  const storage = {
    uploadFieldVideoPart: vi.fn(async (input: { partNumber: number; sizeBytes: number }) => ({
      etag: "etag-1",
      partNumber: input.partNumber,
      sizeBytes: input.sizeBytes
    }))
  };
  const handover = {
    authorizeFieldVideoUploadMutation: vi.fn(async () => ({
      evidenceType: "WALKAROUND_VIDEO",
      itemId: evidenceItemId,
      orderId: randomUUID(),
      replaceEvidenceFileId: null,
      workOrderId
    }))
  };
  return {
    evidenceItemId,
    repository,
    service: new FieldVideoUploadService(repository as never, storage as never, handover as never),
    session,
    storage,
    workOrderId
  };
}

async function tempFile(buffer: Buffer) {
  const destination = await mkdtemp(path.join(tmpdir(), "field-video-part-"));
  const filePath = path.join(destination, "part.tmp");
  await writeFile(filePath, buffer);
  return {
    destination,
    encoding: "7bit",
    fieldname: "file",
    filename: "part.tmp",
    mimetype: "application/octet-stream",
    originalname: "part.tmp",
    path: filePath,
    size: buffer.length
  };
}
