import type { Readable } from "node:stream";

export type StorageDriver = "local" | "oss";

export interface UploadObjectInput {
  buffer: Buffer;
  key: string;
  contentType?: string;
  metadata?: Record<string, string>;
  originalName?: string;
}

export interface StoredObject {
  bucket?: string;
  contentType?: string;
  driver: StorageDriver;
  etag?: string;
  key: string;
  originalName?: string;
  size?: number;
  url?: string;
}

export interface DownloadObjectResult {
  contentLength?: number;
  contentType?: string;
  originalName?: string;
  stream: Readable;
}

export interface StorageProvider {
  deleteObject(key: string): Promise<void>;
  exists?(key: string): Promise<boolean>;
  getObject(key: string): Promise<DownloadObjectResult>;
  putObject(input: UploadObjectInput): Promise<StoredObject>;
}
