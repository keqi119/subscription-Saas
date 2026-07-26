import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";

import type {
  DownloadObjectResult,
  StorageProvider,
  StoredObject,
  UploadFileObjectInput,
  UploadObjectInput
} from "./storage.types";

export const OSS_CLIENT_FACTORY = Symbol("OSS_CLIENT_FACTORY");

export interface OssClientLike {
  delete(name: string): Promise<unknown>;
  getStream(name: string): Promise<{ res?: { headers?: Record<string, string | string[] | undefined> }; stream: Readable }>;
  put(
    name: string,
    file: Buffer | Readable | string,
    options?: { headers?: Record<string, string>; meta?: Record<string, string> }
  ): Promise<{ name?: string; res?: { headers?: Record<string, string | string[] | undefined> }; url?: string }>;
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
        endpoint: this.configService.get<string>("OSS_INTERNAL_ENDPOINT") || this.configService.get<string>("OSS_ENDPOINT"),
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

function getHeader(headers: Record<string, string | string[] | undefined> | undefined, name: string) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function numberHeader(headers: Record<string, string | string[] | undefined> | undefined, name: string) {
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
