import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";

import type {
  AbortMultipartUploadInput,
  BeginMultipartUploadInput,
  CompletedMultipartObject,
  CompleteMultipartUploadInput,
  DownloadObjectResult,
  MultipartUploadHandle,
  MultipartUploadPart,
  StorageProvider,
  StoredObject,
  UploadFileObjectInput,
  UploadMultipartPartInput,
  UploadObjectInput
} from "./storage.types";

export const OSS_CLIENT_FACTORY = Symbol("OSS_CLIENT_FACTORY");

export interface OssClientLike {
  abortMultipartUpload?(name: string, uploadId: string): Promise<unknown>;
  completeMultipartUpload?(
    name: string,
    uploadId: string,
    parts: Array<{ etag: string; number: number }>
  ): Promise<{
    etag?: string;
    name?: string;
    res?: { headers?: Record<string, string | string[] | undefined> };
  }>;
  delete(name: string): Promise<unknown>;
  getStream(name: string): Promise<{
    res?: { headers?: Record<string, string | string[] | undefined> };
    stream: Readable;
  }>;
  initMultipartUpload?(
    name: string,
    options?: { meta?: Record<string, string>; mime?: string }
  ): Promise<{ name?: string; uploadId: string }>;
  put(
    name: string,
    file: Buffer | Readable | string,
    options?: { headers?: Record<string, string>; meta?: Record<string, string> }
  ): Promise<{
    name?: string;
    res?: { headers?: Record<string, string | string[] | undefined> };
    url?: string;
  }>;
  uploadPart?(
    name: string,
    uploadId: string,
    partNumber: number,
    filePath: string,
    start: number,
    end: number
  ): Promise<{ etag?: string; res?: { headers?: Record<string, string | string[] | undefined> } }>;
}

export type OssClientFactory = (options: {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint?: string;
  internal?: boolean;
  region: string;
}) => OssClientLike;

@Injectable()
export class OssStorageProvider implements StorageProvider {
  private client: OssClientLike | null = null;

  constructor(
    private readonly configService: ConfigService,
    @Inject(OSS_CLIENT_FACTORY) private readonly clientFactory: OssClientFactory
  ) {}

  async initMultipartUpload(input: BeginMultipartUploadInput): Promise<MultipartUploadHandle> {
    const key = sanitizeObjectKey(input.key);
    const method = this.getClient().initMultipartUpload;
    if (!method) {
      throw new BadRequestException("OSS 客户端不支持分片上传。");
    }
    const result = await method.call(this.getClient(), key, {
      meta: normalizeMetadata(input.metadata),
      mime: input.contentType
    });
    return { key, uploadId: result.uploadId };
  }

  async uploadPart(input: UploadMultipartPartInput): Promise<MultipartUploadPart> {
    const key = sanitizeObjectKey(input.key);
    const method = this.getClient().uploadPart;
    if (!method) {
      throw new BadRequestException("OSS 客户端不支持分片上传。");
    }
    const result = await method.call(
      this.getClient(),
      key,
      input.uploadId,
      input.partNumber,
      input.filePath,
      0,
      input.sizeBytes
    );
    const etag = result.etag ?? getHeader(result.res?.headers, "etag");
    if (!etag) {
      throw new BadRequestException("OSS 分片响应缺少 ETag。");
    }
    return {
      etag,
      partNumber: input.partNumber,
      sizeBytes: input.sizeBytes
    };
  }

  async completeMultipartUpload(
    input: CompleteMultipartUploadInput
  ): Promise<CompletedMultipartObject> {
    const key = sanitizeObjectKey(input.key);
    const method = this.getClient().completeMultipartUpload;
    if (!method) {
      throw new BadRequestException("OSS 客户端不支持分片上传。");
    }
    try {
      const result = await method.call(
        this.getClient(),
        key,
        input.uploadId,
        input.parts.map((part) => ({ etag: part.etag, number: part.partNumber }))
      );
      return {
        etag: result.etag ?? getHeader(result.res?.headers, "etag"),
        key,
        sizeBytes: input.sizeBytes
      };
    } catch (error) {
      if (!isNoSuchUploadError(error)) {
        throw error;
      }
      let completed: Awaited<ReturnType<OssClientLike["getStream"]>>;
      try {
        completed = await this.getClient().getStream(key);
      } catch {
        throw error;
      }
      const completedSize = numberHeader(completed.res?.headers, "content-length");
      completed.stream.destroy();
      if (completedSize !== input.sizeBytes) {
        throw error;
      }
      return {
        etag: getHeader(completed.res?.headers, "etag"),
        key,
        sizeBytes: input.sizeBytes
      };
    }
  }

  async abortMultipartUpload(input: AbortMultipartUploadInput): Promise<void> {
    const key = sanitizeObjectKey(input.key);
    const method = this.getClient().abortMultipartUpload;
    if (!method) {
      throw new BadRequestException("OSS 客户端不支持分片上传。");
    }
    try {
      await method.call(this.getClient(), key, input.uploadId);
    } catch (error) {
      if (isNoSuchUploadError(error)) {
        return;
      }
      throw error;
    }
  }

  async putObject(input: UploadObjectInput): Promise<StoredObject> {
    const key = sanitizeObjectKey(input.key);
    const result = await this.getClient().put(key, input.buffer, {
      headers: input.contentType ? { "Content-Type": input.contentType } : undefined,
      meta: normalizeMetadata(input.metadata)
    });

    return {
      bucket: this.getRequiredConfig("OSS_BUCKET"),
      contentType: input.contentType,
      driver: "oss",
      etag: getHeader(result.res?.headers, "etag"),
      key,
      originalName: input.originalName,
      size: input.buffer.length,
      url: result.url
    };
  }

  async putFile(input: UploadFileObjectInput): Promise<StoredObject> {
    const key = sanitizeObjectKey(input.key);
    const result = await this.getClient().put(key, input.filePath, {
      headers: input.contentType ? { "Content-Type": input.contentType } : undefined,
      meta: normalizeMetadata(input.metadata)
    });

    return {
      bucket: this.getRequiredConfig("OSS_BUCKET"),
      contentType: input.contentType,
      driver: "oss",
      etag: getHeader(result.res?.headers, "etag"),
      key,
      originalName: input.originalName,
      size: input.sizeBytes,
      url: result.url
    };
  }

  async getObject(key: string): Promise<DownloadObjectResult> {
    try {
      const result = await this.getClient().getStream(sanitizeObjectKey(key));
      return {
        contentLength: numberHeader(result.res?.headers, "content-length"),
        contentType: getHeader(result.res?.headers, "content-type"),
        stream: result.stream
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new NotFoundException("文件不存在或已不可访问。");
      }
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.getClient().delete(sanitizeObjectKey(key));
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }

  private getClient() {
    if (!this.client) {
      this.client = this.clientFactory({
        accessKeyId: this.getRequiredConfig("OSS_ACCESS_KEY_ID"),
        accessKeySecret: this.getRequiredConfig("OSS_ACCESS_KEY_SECRET"),
        bucket: this.getRequiredConfig("OSS_BUCKET"),
        endpoint:
          this.configService.get<string>("OSS_INTERNAL_ENDPOINT") ||
          this.configService.get<string>("OSS_ENDPOINT"),
        internal: Boolean(this.configService.get<string>("OSS_INTERNAL_ENDPOINT")),
        region: this.getRequiredConfig("OSS_REGION")
      });
    }

    return this.client;
  }

  private getRequiredConfig(name: string) {
    const value = this.configService.get<string>(name);
    if (!value) {
      throw new BadRequestException(`OSS 配置缺失：${name}`);
    }
    return value;
  }
}

export const defaultOssClientFactory: OssClientFactory = (options) => {
  const require = createRequire(__filename);
  const AliOss = require("ali-oss") as new (config: typeof options) => OssClientLike;
  return new AliOss(options);
};

function sanitizeObjectKey(key: string) {
  const normalized = key.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || normalized.includes("\0")) {
    throw new BadRequestException("文件路径无效。");
  }
  return normalized;
}

function normalizeMetadata(metadata: Record<string, string> | undefined) {
  if (!metadata) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, encodeURIComponent(value)])
  );
}

function getHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function numberHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
) {
  const value = getHeader(headers, name);
  return value ? Number(value) : undefined;
}

function isNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const status = "status" in error ? Number(error.status) : undefined;
  const code = "code" in error ? String(error.code) : "";
  return status === 404 || code === "NoSuchKey" || code === "NoSuchBucket";
}

function isNoSuchUploadError(error: unknown) {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "NoSuchUpload"
  );
}
