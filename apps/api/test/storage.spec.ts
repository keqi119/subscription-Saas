import { BadRequestException, NotFoundException } from "@nestjs/common";
import { mkdtemp, rm } from "node:fs/promises";
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
    expect(ossStored.objectKey).toMatch(/^oss:subscription-saas\/staging\/materials\/app-1\/\d{4}\/\d{2}\//);
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
    expect(ossStored.objectKey).toMatch(/^oss:subscription-saas\/staging\/vehicle-listings\/vehicle-1\/\d{4}\//);
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
    expect(ossStored.objectKey).toMatch(/^oss:subscription-saas\/staging\/delivery-evidence\/work-order-1\/\d{4}\//);
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
