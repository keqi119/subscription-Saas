import { BadRequestException, NotFoundException } from "@nestjs/common";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalStorageProvider } from "../src/storage/local-storage.provider";
import { OssClientFactory, OssStorageProvider } from "../src/storage/oss-storage.provider";
import { StorageService } from "../src/storage/storage.service";
import { UploadObjectInput } from "../src/storage/storage.types";

describe("Storage providers", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs = [];
  });

  it("stores and downloads local objects", async () => {
    const dir = await createTempDir();
    const provider = new LocalStorageProvider(config({ UPLOAD_LOCAL_DIR: dir }) as never);

    const stored = await provider.putObject({
      buffer: Buffer.from("hello"),
      contentType: "text/plain",
      key: "materials/app-1/file.txt",
      originalName: "file.txt"
    });
    const downloaded = await provider.getObject(stored.key);

    expect(stored.driver).toBe("local");
    expect(stored.size).toBe(5);
    expect(downloaded.contentLength).toBe(5);
    await expect(readStream(downloaded.stream)).resolves.toBe("hello");
  });

  it("copies disk-backed uploads without materializing the file as a Buffer", async () => {
    const dir = await createTempDir();
    const sourcePath = path.join(dir, "multer-upload.tmp");
    await writeFile(sourcePath, "streamed video");
    const provider = new LocalStorageProvider(config({ UPLOAD_LOCAL_DIR: dir }) as never);

    const stored = await provider.putFile({
      contentType: "video/mp4",
      filePath: sourcePath,
      key: "delivery-evidence/work-order-1/video.mp4",
      originalName: "video.mp4",
      sizeBytes: 14
    });
    const downloaded = await provider.getObject(stored.key);

    expect(stored).toMatchObject({ driver: "local", size: 14 });
    await expect(readStream(downloaded.stream)).resolves.toBe("streamed video");
  });

  it("rejects local path traversal", async () => {
    const dir = await createTempDir();
    const provider = new LocalStorageProvider(config({ UPLOAD_LOCAL_DIR: dir }) as never);

    await expect(
      provider.putObject({ buffer: Buffer.from("x"), key: "../escape.txt" })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("returns not found for missing local objects", async () => {
    const dir = await createTempDir();
    const provider = new LocalStorageProvider(config({ UPLOAD_LOCAL_DIR: dir }) as never);

    await expect(provider.getObject("missing.txt")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("requires OSS configuration only when the OSS provider is used", async () => {
    const provider = new OssStorageProvider(config({}) as never, vi.fn() as never);

    await expect(
      provider.putObject({ buffer: Buffer.from("x"), key: "materials/app-1/file.txt" })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("uploads and downloads OSS objects through a mocked client", async () => {
    const put = vi.fn(async () => ({ res: { headers: { etag: "etag-1" } }, url: "private-url" }));
    const getStream = vi.fn(async () => ({
      res: { headers: { "content-length": "5", "content-type": "text/plain" } },
      stream: Readable.from(["hello"])
    }));
    const remove = vi.fn(async () => undefined);
    const factory: OssClientFactory = vi.fn(() => ({
      delete: remove,
      getStream,
      put
    }));
    const provider = new OssStorageProvider(
      config({
        OSS_ACCESS_KEY_ID: "test-key",
        OSS_ACCESS_KEY_SECRET: "test-secret",
        OSS_BUCKET: "private-bucket",
        OSS_ENDPOINT: "https://oss-cn-shanghai.aliyuncs.com",
        OSS_REGION: "oss-cn-shanghai"
      }) as never,
      factory
    );

    const stored = await provider.putObject({
      buffer: Buffer.from("hello"),
      contentType: "text/plain",
      key: "materials/app-1/file.txt",
      metadata: { originalName: "file.txt" },
      originalName: "file.txt"
    });
    const downloaded = await provider.getObject(stored.key);

    expect(factory).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith("materials/app-1/file.txt", expect.any(Buffer), {
      headers: { "Content-Type": "text/plain" },
      meta: { originalName: "file.txt" }
    });
    expect(stored).toMatchObject({
      bucket: "private-bucket",
      driver: "oss",
      etag: "etag-1",
      key: "materials/app-1/file.txt"
    });
    expect(downloaded.contentLength).toBe(5);
    expect(downloaded.contentType).toBe("text/plain");
    await expect(readStream(downloaded.stream)).resolves.toBe("hello");
  });

  it("owns the OSS multipart lifecycle without buffering a disk part", async () => {
    const initMultipartUpload = vi.fn(async () => ({
      name: "field-video/upload-sessions/session-1/source",
      uploadId: "oss-upload-1"
    }));
    const uploadPart = vi.fn(async () => ({ etag: "etag-1" }));
    const completeMultipartUpload = vi.fn(async () => ({
      etag: "source-etag",
      name: "field-video/upload-sessions/session-1/source",
      res: { headers: { etag: "source-etag" } }
    }));
    const abortMultipartUpload = vi.fn(async () => ({}));
    const factory: OssClientFactory = vi.fn(() => ({
      abortMultipartUpload,
      completeMultipartUpload,
      delete: vi.fn(),
      getStream: vi.fn(),
      initMultipartUpload,
      put: vi.fn(),
      uploadPart
    }));
    const provider = new OssStorageProvider(
      config({
        OSS_ACCESS_KEY_ID: "test-key",
        OSS_ACCESS_KEY_SECRET: "test-secret",
        OSS_BUCKET: "private-bucket",
        OSS_REGION: "oss-cn-shanghai"
      }) as never,
      factory
    );

    const started = await provider.initMultipartUpload({
      contentType: "video/quicktime",
      key: "field-video/upload-sessions/session-1/source"
    });
    const part = await provider.uploadPart({
      filePath: "C:/tmp/part-1",
      key: started.key,
      partNumber: 1,
      sizeBytes: 8 * 1024 * 1024,
      uploadId: started.uploadId
    });
    const completed = await provider.completeMultipartUpload({
      key: started.key,
      parts: [part],
      sizeBytes: 8 * 1024 * 1024,
      uploadId: started.uploadId
    });
    await provider.abortMultipartUpload(started);

    expect(started).toEqual({
      key: "field-video/upload-sessions/session-1/source",
      uploadId: "oss-upload-1"
    });
    expect(part).toEqual({
      etag: "etag-1",
      partNumber: 1,
      sizeBytes: 8 * 1024 * 1024
    });
    expect(completed).toEqual({
      etag: "source-etag",
      key: "field-video/upload-sessions/session-1/source",
      sizeBytes: 8 * 1024 * 1024
    });
    expect(uploadPart).toHaveBeenCalledWith(
      "field-video/upload-sessions/session-1/source",
      "oss-upload-1",
      1,
      "C:/tmp/part-1",
      0,
      8 * 1024 * 1024
    );
    expect(completeMultipartUpload).toHaveBeenCalledWith(
      "field-video/upload-sessions/session-1/source",
      "oss-upload-1",
      [{ etag: "etag-1", number: 1 }]
    );
    expect(abortMultipartUpload).toHaveBeenCalledWith(
      "field-video/upload-sessions/session-1/source",
      "oss-upload-1"
    );
  });

  it("treats an already-absent OSS multipart upload as aborted", async () => {
    const abortMultipartUpload = vi.fn(async () => {
      throw Object.assign(new Error("gone"), { code: "NoSuchUpload", status: 404 });
    });
    const factory: OssClientFactory = vi.fn(() => ({
      abortMultipartUpload,
      delete: vi.fn(),
      getStream: vi.fn(),
      put: vi.fn()
    }));
    const provider = new OssStorageProvider(
      config({
        OSS_ACCESS_KEY_ID: "test-key",
        OSS_ACCESS_KEY_SECRET: "test-secret",
        OSS_BUCKET: "private-bucket",
        OSS_REGION: "oss-cn-shanghai"
      }) as never,
      factory
    );

    await expect(
      provider.abortMultipartUpload({
        key: "field-video/upload-sessions/session-1/source",
        uploadId: "oss-upload-1"
      })
    ).resolves.toBeUndefined();
  });

  it("recovers when OSS completed the object before the database stage was persisted", async () => {
    const completeMultipartUpload = vi.fn(async () => {
      throw Object.assign(new Error("already completed"), { code: "NoSuchUpload", status: 404 });
    });
    const source = Readable.from([Buffer.from("completed")]);
    const getStream = vi.fn(async () => ({
      res: { headers: { "content-length": "9", etag: "source-etag" } },
      stream: source
    }));
    const factory: OssClientFactory = vi.fn(() => ({
      completeMultipartUpload,
      delete: vi.fn(),
      getStream,
      put: vi.fn()
    }));
    const provider = new OssStorageProvider(
      config({
        OSS_ACCESS_KEY_ID: "test-key",
        OSS_ACCESS_KEY_SECRET: "test-secret",
        OSS_BUCKET: "private-bucket",
        OSS_REGION: "oss-cn-shanghai"
      }) as never,
      factory
    );

    await expect(
      provider.completeMultipartUpload({
        key: "field-video/upload-sessions/session-1/source",
        parts: [{ etag: "part-etag", partNumber: 1, sizeBytes: 9 }],
        sizeBytes: 9,
        uploadId: "oss-upload-1"
      })
    ).resolves.toEqual({
      etag: "source-etag",
      key: "field-video/upload-sessions/session-1/source",
      sizeBytes: 9
    });
    expect(getStream).toHaveBeenCalledWith("field-video/upload-sessions/session-1/source");
  });

  it("requires OSS and namespaces resumable field-video objects", async () => {
    const oss = {
      initMultipartUpload: vi.fn(async (input: { key: string }) => ({
        key: input.key,
        uploadId: "oss-upload-1"
      }))
    };
    const localService = new StorageService(
      config({ UPLOAD_STORAGE_DRIVER: "local" }) as never,
      {} as never,
      oss as never
    );
    const ossService = new StorageService(
      config({
        OSS_PREFIX: "subscription-saas/staging",
        UPLOAD_STORAGE_DRIVER: "oss"
      }) as never,
      {} as never,
      oss as never
    );

    await expect(
      localService.beginFieldVideoMultipart({
        contentType: "video/quicktime",
        originalName: "IMG_0284.MOV",
        sessionId: "session-1"
      })
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "FIELD_VIDEO_MULTIPART_REQUIRES_OSS" })
    });
    await expect(
      ossService.beginFieldVideoMultipart({
        contentType: "video/quicktime",
        originalName: "IMG_0284.MOV",
        sessionId: "session-1"
      })
    ).resolves.toEqual({
      key: "subscription-saas/staging/field-video/upload-sessions/session-1/source",
      uploadId: "oss-upload-1"
    });
  });

  it("encodes Unicode OSS metadata values for object and file uploads while preserving ASCII and undefined metadata", async () => {
    const put = vi.fn(async () => ({ res: { headers: { etag: "etag-1" } }, url: "private-url" }));
    const factory: OssClientFactory = vi.fn(() => ({
      delete: vi.fn(),
      getStream: vi.fn(),
      put
    }));
    const provider = new OssStorageProvider(
      config({
        OSS_ACCESS_KEY_ID: "test-key",
        OSS_ACCESS_KEY_SECRET: "test-secret",
        OSS_BUCKET: "private-bucket",
        OSS_ENDPOINT: "https://oss-cn-shanghai.aliyuncs.com",
        OSS_REGION: "oss-cn-shanghai"
      }) as never,
      factory
    );
    const templateName = "车辆交接确认单";
    const metadata = { templateName, templateVersion: "V1.0" };

    await provider.putObject({
      buffer: Buffer.from("hello"),
      key: "materials/app-1/object.pdf",
      metadata
    });
    await provider.putFile({
      filePath: "temporary-source.pdf",
      key: "materials/app-1/file.pdf",
      metadata,
      sizeBytes: 5
    });
    await provider.putObject({
      buffer: Buffer.from("hello"),
      key: "materials/app-1/no-metadata.pdf"
    });

    expect(put).toHaveBeenNthCalledWith(1, "materials/app-1/object.pdf", expect.any(Buffer), {
      headers: undefined,
      meta: { templateName: encodeURIComponent(templateName), templateVersion: "V1.0" }
    });
    expect(put).toHaveBeenNthCalledWith(2, "materials/app-1/file.pdf", "temporary-source.pdf", {
      headers: undefined,
      meta: { templateName: encodeURIComponent(templateName), templateVersion: "V1.0" }
    });
    expect(put).toHaveBeenNthCalledWith(3, "materials/app-1/no-metadata.pdf", expect.any(Buffer), {
      headers: undefined,
      meta: undefined
    });
  });

  it("maps material uploads to local or OSS database fields", async () => {
    const local = {
      deleteObject: vi.fn(),
      getObject: vi.fn(),
      putObject: vi.fn(async (input: UploadObjectInput) => ({
        driver: "local" as const,
        key: input.key,
        size: input.buffer.length
      }))
    };
    const oss = {
      deleteObject: vi.fn(),
      getObject: vi.fn(),
      putObject: vi.fn(async (input: UploadObjectInput) => ({
        bucket: "private-bucket",
        driver: "oss" as const,
        key: input.key,
        size: input.buffer.length
      }))
    };
    const localService = new StorageService(
      config({ UPLOAD_STORAGE_DRIVER: "local" }) as never,
      local as never,
      oss as never
    );
    const ossService = new StorageService(
      config({ OSS_PREFIX: "subscription-saas/staging", UPLOAD_STORAGE_DRIVER: "oss" }) as never,
      local as never,
      oss as never
    );

    const localStored = await localService.putApplicationMaterial({
      applicationId: "app-1",
      buffer: Buffer.from("hello"),
      originalName: "my doc.txt"
    });
    const ossStored = await ossService.putApplicationMaterial({
      applicationId: "app-1",
      buffer: Buffer.from("hello"),
      originalName: "my doc.txt"
    });

    expect(localStored.bucket).toBe("application-materials");
    expect(localStored.objectKey).toMatch(/^materials\/app-1\/\d{4}\/\d{2}\//);
    expect(ossStored.bucket).toBe("oss:private-bucket");
    expect(ossStored.objectKey).toMatch(
      /^oss:subscription-saas\/staging\/materials\/app-1\/\d{4}\/\d{2}\//
    );
  });

  it("deletes a contract signed artifact through its encoded storage driver", async () => {
    const local = {
      deleteObject: vi.fn(async () => undefined)
    };
    const oss = {
      deleteObject: vi.fn(async () => undefined)
    };
    const localService = new StorageService(
      config({ UPLOAD_STORAGE_DRIVER: "local" }) as never,
      local as never,
      oss as never
    );
    const ossService = new StorageService(
      config({ UPLOAD_STORAGE_DRIVER: "oss" }) as never,
      local as never,
      oss as never
    );

    await localService.deleteContractSignedArtifactObject(
      "contracts/contract-1/esign/fadada/signed/hash.pdf"
    );
    await ossService.deleteContractSignedArtifactObject(
      "oss:subscription/contracts/contract-1/esign/fadada/signed/hash.pdf"
    );

    expect(local.deleteObject).toHaveBeenCalledWith(
      "application-materials/contracts/contract-1/esign/fadada/signed/hash.pdf"
    );
    expect(oss.deleteObject).toHaveBeenCalledWith(
      "subscription/contracts/contract-1/esign/fadada/signed/hash.pdf"
    );
  });

  it("maps vehicle listing media uploads to private local or OSS database fields", async () => {
    const local = {
      deleteObject: vi.fn(),
      getObject: vi.fn(),
      putObject: vi.fn(async (input: UploadObjectInput) => ({
        driver: "local" as const,
        key: input.key,
        size: input.buffer.length
      }))
    };
    const oss = {
      deleteObject: vi.fn(),
      getObject: vi.fn(),
      putObject: vi.fn(async (input: UploadObjectInput) => ({
        bucket: "private-bucket",
        driver: "oss" as const,
        key: input.key,
        size: input.buffer.length
      }))
    };
    const localService = new StorageService(
      config({ UPLOAD_STORAGE_DRIVER: "local" }) as never,
      local as never,
      oss as never
    );
    const ossService = new StorageService(
      config({ OSS_PREFIX: "subscription-saas/staging", UPLOAD_STORAGE_DRIVER: "oss" }) as never,
      local as never,
      oss as never
    );

    const localStored = await localService.putVehicleListingMedia({
      buffer: Buffer.from("hello"),
      originalName: "front cover.jpg",
      vehicleId: "vehicle-1"
    });
    const ossStored = await ossService.putVehicleListingMedia({
      buffer: Buffer.from("hello"),
      originalName: "front cover.jpg",
      vehicleId: "vehicle-1"
    });

    expect(localStored.bucket).toBe("application-materials");
    expect(localStored.objectKey).toMatch(/^vehicle-listings\/vehicle-1\/\d{4}\//);
    expect(ossStored.bucket).toBe("oss:private-bucket");
    expect(ossStored.objectKey).toMatch(
      /^oss:subscription-saas\/staging\/vehicle-listings\/vehicle-1\/\d{4}\//
    );
  });

  it("maps field delivery evidence uploads to private local or OSS database fields", async () => {
    const local = {
      deleteObject: vi.fn(),
      getObject: vi.fn(),
      putObject: vi.fn(async (input: UploadObjectInput) => ({
        driver: "local" as const,
        key: input.key,
        size: input.buffer.length
      }))
    };
    const oss = {
      deleteObject: vi.fn(),
      getObject: vi.fn(),
      putObject: vi.fn(async (input: UploadObjectInput) => ({
        bucket: "private-bucket",
        driver: "oss" as const,
        key: input.key,
        size: input.buffer.length
      }))
    };
    const localService = new StorageService(
      config({ UPLOAD_STORAGE_DRIVER: "local" }) as never,
      local as never,
      oss as never
    );
    const ossService = new StorageService(
      config({ OSS_PREFIX: "subscription-saas/staging", UPLOAD_STORAGE_DRIVER: "oss" }) as never,
      local as never,
      oss as never
    );

    const localStored = await localService.putDeliveryEvidenceFile({
      buffer: Buffer.from("hello"),
      originalName: "front photo.jpg",
      orderId: "order-1",
      workOrderId: "work-order-1"
    });
    const ossStored = await ossService.putDeliveryEvidenceFile({
      buffer: Buffer.from("hello"),
      originalName: "front photo.jpg",
      orderId: "order-1",
      workOrderId: "work-order-1"
    });

    expect(localStored.bucket).toBe("application-materials");
    expect(localStored.objectKey).toMatch(/^delivery-evidence\/work-order-1\/\d{4}\//);
    expect(ossStored.bucket).toBe("oss:private-bucket");
    expect(ossStored.objectKey).toMatch(
      /^oss:subscription-saas\/staging\/delivery-evidence\/work-order-1\/\d{4}\//
    );
  });

  it("plans the same deterministic signed-artifact locator returned by each storage driver", async () => {
    const local = {
      deleteObject: vi.fn(),
      getObject: vi.fn(),
      putObject: vi.fn(async (input: UploadObjectInput) => ({
        driver: "local" as const,
        key: input.key,
        size: input.buffer.length
      }))
    };
    const oss = {
      deleteObject: vi.fn(),
      getObject: vi.fn(),
      putObject: vi.fn(async (input: UploadObjectInput) => ({
        bucket: "private-bucket",
        driver: "oss" as const,
        key: input.key,
        size: input.buffer.length
      }))
    };
    const localService = new StorageService(
      config({ UPLOAD_STORAGE_DRIVER: "local" }) as never,
      local as never,
      oss as never
    );
    const ossService = new StorageService(
      config({
        OSS_PREFIX: "subscription-saas/staging",
        UPLOAD_STORAGE_DRIVER: "oss"
      }) as never,
      local as never,
      oss as never
    );
    const originalName = "contract-signed.pdf";
    const objectIdentity = "task-1-v3";
    const input = {
      buffer: Buffer.from("%PDF-1.7"),
      contractId: "contract-1",
      objectIdentity,
      originalName,
      provider: "fadada"
    };

    const localPlanned = localService.buildContractSignedArtifactObjectKey(
      input.contractId,
      input.provider,
      originalName,
      objectIdentity
    );
    const ossPlanned = ossService.buildContractSignedArtifactObjectKey(
      input.contractId,
      input.provider,
      originalName,
      objectIdentity
    );
    const localStored = await localService.putContractSignedArtifact(input);
    const ossStored = await ossService.putContractSignedArtifact(input);

    expect(localPlanned).toBe(localStored.objectKey);
    expect(ossPlanned).toBe(ossStored.objectKey);
  });

  it("resolves only signed-artifact locators owned by the requested contract", () => {
    const providers = {
      deleteObject: vi.fn(),
      getObject: vi.fn(),
      putObject: vi.fn()
    };
    const localService = new StorageService(
      config({ UPLOAD_STORAGE_DRIVER: "local" }) as never,
      providers as never,
      providers as never
    );
    const ossService = new StorageService(
      config({
        OSS_BUCKET: "private-bucket",
        OSS_PREFIX: "subscription-saas/staging",
        UPLOAD_STORAGE_DRIVER: "oss"
      }) as never,
      providers as never,
      providers as never
    );
    const localObjectKey = "contracts/contract-1/esign/fadada/signed/2026/signed.pdf";
    const ossObjectKey =
      "oss:subscription-saas/staging/contracts/contract-1/esign/fadada/signed/2026/signed.pdf";

    expect(
      localService.resolveContractSignedArtifactIdentity("contract-1", "fadada", localObjectKey)
    ).toEqual({
      bucket: "application-materials",
      objectKey: localObjectKey
    });
    expect(
      ossService.resolveContractSignedArtifactIdentity("contract-1", "fadada", ossObjectKey)
    ).toEqual({
      bucket: "oss:private-bucket",
      objectKey: ossObjectKey
    });
    expect(
      localService.resolveContractSignedArtifactIdentity("contract-other", "fadada", localObjectKey)
    ).toBeNull();
    expect(
      ossService.resolveContractSignedArtifactIdentity("contract-1", "other-provider", ossObjectKey)
    ).toBeNull();
  });

  it("maps disk-backed field evidence to local or OSS providers", async () => {
    const local = {
      deleteObject: vi.fn(),
      getObject: vi.fn(),
      putFile: vi.fn(async (input: { key: string; sizeBytes: number }) => ({
        driver: "local" as const,
        key: input.key,
        size: input.sizeBytes
      })),
      putObject: vi.fn()
    };
    const oss = {
      deleteObject: vi.fn(),
      getObject: vi.fn(),
      putFile: vi.fn(async (input: { key: string; sizeBytes: number }) => ({
        bucket: "private-bucket",
        driver: "oss" as const,
        key: input.key,
        size: input.sizeBytes
      })),
      putObject: vi.fn()
    };
    const localService = new StorageService(
      config({ UPLOAD_STORAGE_DRIVER: "local" }) as never,
      local as never,
      oss as never
    );
    const ossService = new StorageService(
      config({ OSS_PREFIX: "subscription-saas/staging", UPLOAD_STORAGE_DRIVER: "oss" }) as never,
      local as never,
      oss as never
    );

    const input = {
      filePath: "C:/tmp/multer-upload.tmp",
      originalName: "walkaround.mp4",
      orderId: "order-1",
      sizeBytes: 200 * 1024 * 1024,
      workOrderId: "work-order-1"
    };
    const localStored = await localService.putDeliveryEvidenceFileFromPath(input);
    const ossStored = await ossService.putDeliveryEvidenceFileFromPath(input);

    expect(local.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: input.filePath,
        sizeBytes: input.sizeBytes
      })
    );
    expect(oss.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: input.filePath,
        sizeBytes: input.sizeBytes
      })
    );
    expect(localStored.bucket).toBe("application-materials");
    expect(ossStored.bucket).toBe("oss:private-bucket");
  });

  async function createTempDir() {
    const dir = await mkdtemp(path.join(tmpdir(), "subscription-storage-"));
    tempDirs.push(dir);
    return dir;
  }
});

function config(values: Record<string, string>) {
  return {
    get: (key: string) => values[key]
  };
}

async function readStream(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf8");
}
