import { type Readable } from "node:stream";

export type StorageDriver = "local" | "oss";

export interface UploadObjectInput {
  buffer: Buffer;
  key: string;
  contentType?: string;
  metadata?: Record<string, string>;
  originalName?: string;
}

export interface UploadFileObjectInput {
  contentType?: string;
  filePath: string;
  key: string;
  metadata?: Record<string, string>;
  originalName?: string;
  sizeBytes: number;
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

export interface BeginMultipartUploadInput {
  contentType?: string;
  key: string;
  metadata?: Record<string, string>;
}

export interface MultipartUploadHandle {
  key: string;
  uploadId: string;
}

export interface UploadMultipartPartInput extends MultipartUploadHandle {
  filePath: string;
  partNumber: number;
  sizeBytes: number;
}

export interface MultipartUploadPart {
  etag: string;
  partNumber: number;
  sizeBytes: number;
}

export interface CompleteMultipartUploadInput extends MultipartUploadHandle {
  parts: MultipartUploadPart[];
  sizeBytes: number;
}

export type AbortMultipartUploadInput = MultipartUploadHandle;

export interface CompletedMultipartObject {
  etag?: string;
  key: string;
  sizeBytes: number;
}

export interface StorageProvider {
  abortMultipartUpload?(input: AbortMultipartUploadInput): Promise<void>;
  completeMultipartUpload?(input: CompleteMultipartUploadInput): Promise<CompletedMultipartObject>;
  deleteObject(key: string): Promise<void>;
  exists?(key: string): Promise<boolean>;
  getObject(key: string): Promise<DownloadObjectResult>;
  initMultipartUpload?(input: BeginMultipartUploadInput): Promise<MultipartUploadHandle>;
  putObject(input: UploadObjectInput): Promise<StoredObject>;
  uploadPart?(input: UploadMultipartPartInput): Promise<MultipartUploadPart>;
}
