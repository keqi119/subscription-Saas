import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { LocalStorageProvider } from "./local-storage.provider";
import { OssStorageProvider } from "./oss-storage.provider";
import {
  AbortMultipartUploadInput,
  CompleteMultipartUploadInput,
  DownloadObjectResult,
  MultipartUploadHandle,
  MultipartUploadPart,
  StorageDriver,
  StoredObject,
  UploadFileObjectInput,
  UploadMultipartPartInput,
  UploadObjectInput,
  StorageProvider
} from "./storage.types";

const LOCAL_BUCKET = "application-materials";
const OSS_BUCKET_PREFIX = "oss:";
const OSS_KEY_PREFIX = "oss:";

export interface GeneratedContractPdfArtifactStorageInput extends Omit<UploadObjectInput, "key"> {
  contractId: string;
  contentType: "application/pdf";
  objectKey?: string;
  originalName: string;
}

export interface GeneratedContractPdfArtifactFileStorageInput extends Omit<
  UploadFileObjectInput,
  "key"
> {
  contractId: string;
  contentType: "application/pdf";
  objectKey?: string;
  originalName: string;
}

export interface GeneratedContractPdfArtifactStorageResult {
  bucket: string;
  contentType: "application/pdf";
  objectKey: string;
  originalName: string;
  sizeBytes: number;
  stored: StoredObject;
}

@Injectable()
export class StorageService {
  constructor(
    private readonly configService: ConfigService,
    private readonly localStorage: LocalStorageProvider,
    private readonly ossStorage: OssStorageProvider
  ) {}

  getDriver(): StorageDriver {
    const driver = this.configService.get<string>("UPLOAD_STORAGE_DRIVER") ?? "local";
    if (driver === "local" || driver === "oss") {
      return driver;
    }
    throw new BadRequestException("UPLOAD_STORAGE_DRIVER 必须为 local 或 oss。");
  }

  async beginFieldVideoMultipart(input: {
    contentType: string;
    originalName: string;
    sessionId: string;
  }): Promise<MultipartUploadHandle> {
    this.assertFieldVideoMultipartDriver();
    const key = this.withOssPrefix(
      `field-video/upload-sessions/${sanitizeKeyPart(input.sessionId)}/source`
    );
    return this.ossStorage.initMultipartUpload({
      contentType: input.contentType,
      key,
      metadata: { originalName: input.originalName }
    });
  }

  uploadFieldVideoPart(input: UploadMultipartPartInput): Promise<MultipartUploadPart> {
    this.assertFieldVideoMultipartDriver();
    this.assertFieldVideoObjectKey(input.key);
    return this.ossStorage.uploadPart(input);
  }

  completeFieldVideoMultipart(input: CompleteMultipartUploadInput) {
    this.assertFieldVideoMultipartDriver();
    this.assertFieldVideoObjectKey(input.key);
    return this.ossStorage.completeMultipartUpload(input);
  }

  abortFieldVideoMultipart(input: AbortMultipartUploadInput): Promise<void> {
    this.assertFieldVideoMultipartDriver();
    this.assertFieldVideoObjectKey(input.key);
    return this.ossStorage.abortMultipartUpload(input);
  }

  downloadFieldVideoUploadSource(input: { key: string }): Promise<DownloadObjectResult> {
    this.assertFieldVideoMultipartDriver();
    this.assertFieldVideoObjectKey(input.key);
    return this.ossStorage.getObject(input.key);
  }

  async deleteFieldVideoUploadSource(input: { key: string }): Promise<void> {
    this.assertFieldVideoMultipartDriver();
    this.assertFieldVideoObjectKey(input.key);
    await this.ossStorage.deleteObject(input.key);
  }

  async putApplicationMaterial(
    input: Omit<UploadObjectInput, "key"> & { applicationId: string }
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildApplicationMaterialKey(input.applicationId, input.originalName ?? "file");
    return this.putPrivateObject(key, input);
  }

  async putCustomerProfileMaterial(
    input: Omit<UploadObjectInput, "key"> & { customerId: string }
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildCustomerProfileMaterialKey(
      input.customerId,
      input.originalName ?? "file"
    );
    return this.putPrivateObject(key, input);
  }

  async putMileageReviewEvidence(
    input: Omit<UploadObjectInput, "key"> & {
      customerId: string;
      reviewId: string;
    }
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildMileageReviewEvidenceKey(
      input.customerId,
      input.reviewId,
      input.originalName ?? "evidence.jpg"
    );
    return this.putPrivateObject(key, input);
  }

  async putAdminMileageReviewEvidence(
    input: Omit<UploadObjectInput, "key"> & {
      reviewId: string;
      userId: string;
    }
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildMileageReviewEvidenceKey(
      `admin-${input.userId}`,
      input.reviewId,
      input.originalName ?? "evidence.jpg"
    );
    return this.putPrivateObject(key, input);
  }

  getCustomerProfileMaterialStream(
    bucket: string,
    objectKey: string
  ): Promise<DownloadObjectResult> {
    return this.getObject(bucket, objectKey);
  }

  async putServiceCaseAttachment(
    input: Omit<UploadObjectInput, "key"> & { serviceCaseId: string }
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildServiceCaseAttachmentKey(
      input.serviceCaseId,
      input.originalName ?? "file"
    );
    return this.putPrivateObject(key, input);
  }

  async putVehicleListingMedia(
    input: Omit<UploadObjectInput, "key"> & { vehicleId: string }
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildVehicleListingMediaKey(input.vehicleId, input.originalName ?? "file");
    return this.putPrivateObject(key, input);
  }

  getVehicleListingMediaStream(bucket: string, objectKey: string): Promise<DownloadObjectResult> {
    return this.getObject(bucket, objectKey);
  }

  async putVehicleDocument(input: Omit<UploadObjectInput, "key"> & { vehicleId: string }): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildVehicleDocumentKey(input.vehicleId, input.originalName ?? "file");
    return this.putPrivateObject(key, input);
  }

  getVehicleDocumentStream(bucket: string, objectKey: string): Promise<DownloadObjectResult> {
    return this.getObject(bucket, objectKey);
  }

  async putVehicleBaasContractAttachment(
    input: Omit<UploadObjectInput, "key"> & { contractId: string }
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildVehicleBaasContractAttachmentKey(
      input.contractId,
      input.originalName ?? "file"
    );
    return this.putPrivateObject(key, input);
  }

  async putDeliveryEvidenceFile(
    input: Omit<UploadObjectInput, "key"> & {
      orderId: string;
      workOrderId: string;
    }
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildDeliveryEvidenceFileKey(input.workOrderId, input.originalName ?? "file");
    return this.putPrivateObject(key, input);
  }

  async putDeliveryEvidenceFileFromPath(
    input: Omit<UploadFileObjectInput, "key"> & {
      orderId: string;
      workOrderId: string;
    }
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildDeliveryEvidenceFileKey(input.workOrderId, input.originalName ?? "file");
    return this.putPrivateFile(key, input);
  }

  async putDeliveryEvidenceDerivativeFromPath(
    input: Omit<UploadFileObjectInput, "key"> & {
      kind: "PHOTO_PREVIEW" | "VIDEO_FRAME";
      orderId: string;
      workOrderId: string;
    }
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildDeliveryEvidenceDerivativeKey(
      input.workOrderId,
      input.kind,
      input.originalName ?? "derivative.jpg"
    );
    return this.putPrivateFile(key, input);
  }

  getVehicleBaasContractAttachmentStream(
    bucket: string,
    objectKey: string
  ): Promise<DownloadObjectResult> {
    return this.getObject(bucket, objectKey);
  }

  async putContractSignedArtifact(
    input: Omit<UploadObjectInput, "key"> & {
      contractId: string;
      objectIdentity?: string;
      provider: string;
    }
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildContractSignedArtifactKey(
      input.contractId,
      input.provider,
      input.originalName ?? "signed.pdf",
      input.objectIdentity
    );
    return this.putPrivateObject(key, {
      buffer: input.buffer,
      contentType: input.contentType,
      metadata: input.metadata,
      originalName: input.originalName
    });
  }

  async putGeneratedContractPdfArtifact(
    input: GeneratedContractPdfArtifactStorageInput
  ): Promise<GeneratedContractPdfArtifactStorageResult> {
    const objectKey = normalizeGeneratedContractPdfObjectKey(
      input.contractId,
      input.objectKey ??
        this.buildGeneratedContractPdfArtifactKey(input.contractId, input.originalName)
    );
    const stored = await this.putPrivateObject(objectKey, {
      buffer: input.buffer,
      contentType: input.contentType,
      metadata: input.metadata,
      originalName: input.originalName
    });

    return {
      bucket: stored.bucket,
      contentType: input.contentType,
      objectKey: stored.objectKey,
      originalName: input.originalName,
      sizeBytes: input.buffer.length,
      stored: stored.stored
    };
  }

  async putGeneratedContractPdfArtifactFromPath(
    input: GeneratedContractPdfArtifactFileStorageInput
  ): Promise<GeneratedContractPdfArtifactStorageResult> {
    const objectKey = normalizeGeneratedContractPdfObjectKey(
      input.contractId,
      input.objectKey ??
        this.buildGeneratedContractPdfArtifactKey(input.contractId, input.originalName)
    );
    const stored = await this.putPrivateFile(objectKey, {
      contentType: input.contentType,
      filePath: input.filePath,
      metadata: input.metadata,
      originalName: input.originalName,
      sizeBytes: input.sizeBytes
    });

    return {
      bucket: stored.bucket,
      contentType: input.contentType,
      objectKey: stored.objectKey,
      originalName: input.originalName,
      sizeBytes: input.sizeBytes,
      stored: stored.stored
    };
  }

  getContractSignedArtifactStream(objectKey: string): Promise<DownloadObjectResult> {
    return this.getObject(LOCAL_BUCKET, objectKey);
  }

  resolveContractSignedArtifactIdentity(
    contractId: string,
    provider: string,
    objectKey: string
  ): { bucket: string; objectKey: string } | null {
    const namespace =
      `contracts/${sanitizeKeyPart(contractId)}/esign/` + `${sanitizeKeyPart(provider)}/signed/`;
    if (objectKey.startsWith(OSS_KEY_PREFIX)) {
      const storedKey = stripPrefix(objectKey, OSS_KEY_PREFIX);
      if (!storedKey.startsWith(this.withOssPrefix(namespace))) {
        return null;
      }
      const bucket = this.configService.get<string>("OSS_BUCKET")?.trim();
      return bucket
        ? {
            bucket: `${OSS_BUCKET_PREFIX}${bucket}`,
            objectKey
          }
        : null;
    }
    return objectKey.startsWith(namespace)
      ? {
          bucket: LOCAL_BUCKET,
          objectKey
        }
      : null;
  }

  buildContractSignedArtifactObjectKey(
    contractId: string,
    provider: string,
    originalName: string,
    objectIdentity: string
  ) {
    const key = this.buildContractSignedArtifactKey(
      contractId,
      provider,
      originalName,
      objectIdentity
    );
    return this.getDriver() === "oss" ? `${OSS_KEY_PREFIX}${this.withOssPrefix(key)}` : key;
  }

  async deleteContractSignedArtifactObject(objectKey: string): Promise<void> {
    const bucket = objectKey.startsWith(OSS_KEY_PREFIX) ? OSS_BUCKET_PREFIX : LOCAL_BUCKET;
    await this.deleteObject(bucket, objectKey);
  }

  private async putPrivateObject(
    key: string,
    input: Omit<UploadObjectInput, "key">
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const driver = this.getDriver();

    if (driver === "oss") {
      const stored = await this.ossStorage.putObject({
        ...input,
        key: this.withOssPrefix(key)
      });
      const bucket = stored.bucket ?? this.configService.get<string>("OSS_BUCKET") ?? "";
      return {
        bucket: `${OSS_BUCKET_PREFIX}${bucket}`,
        objectKey: `${OSS_KEY_PREFIX}${stored.key}`,
        stored
      };
    }

    const stored = await this.localStorage.putObject({
      ...input,
      key: `${LOCAL_BUCKET}/${key}`
    });
    return {
      bucket: LOCAL_BUCKET,
      objectKey: key,
      stored
    };
  }

  private async putPrivateFile(
    key: string,
    input: Omit<UploadFileObjectInput, "key">
  ): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const driver = this.getDriver();

    if (driver === "oss") {
      const stored = await this.ossStorage.putFile({
        ...input,
        key: this.withOssPrefix(key)
      });
      const bucket = stored.bucket ?? this.configService.get<string>("OSS_BUCKET") ?? "";
      return {
        bucket: `${OSS_BUCKET_PREFIX}${bucket}`,
        objectKey: `${OSS_KEY_PREFIX}${stored.key}`,
        stored
      };
    }

    const stored = await this.localStorage.putFile({
      ...input,
      key: `${LOCAL_BUCKET}/${key}`
    });
    return {
      bucket: LOCAL_BUCKET,
      objectKey: key,
      stored
    };
  }

  async getObject(bucket: string, objectKey: string): Promise<DownloadObjectResult> {
    const resolved = this.resolveStoredObject(bucket, objectKey);
    return resolved.provider.getObject(resolved.key);
  }

  async deleteObject(bucket: string, objectKey: string): Promise<void> {
    const resolved = this.resolveStoredObject(bucket, objectKey);
    await resolved.provider.deleteObject(resolved.key);
  }

  private resolveStoredObject(
    bucket: string,
    objectKey: string
  ): { key: string; provider: StorageProvider } {
    if (bucket.startsWith(OSS_BUCKET_PREFIX) || objectKey.startsWith(OSS_KEY_PREFIX)) {
      return {
        key: stripPrefix(objectKey, OSS_KEY_PREFIX),
        provider: this.ossStorage
      };
    }

    return {
      key: `${bucket}/${objectKey}`,
      provider: this.localStorage
    };
  }

  private buildApplicationMaterialKey(applicationId: string, originalName: string) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `materials/${sanitizeKeyPart(applicationId)}/${year}/${month}/${randomUUID()}-${sanitizeFilename(originalName)}`;
  }

  private buildCustomerProfileMaterialKey(customerId: string, originalName: string) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    return `customer-profile-materials/${sanitizeKeyPart(customerId)}/${year}/${randomUUID()}-${sanitizeFilename(originalName)}`;
  }

  private buildMileageReviewEvidenceKey(
    customerId: string,
    reviewId: string,
    originalName: string
  ) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    return `mileage-reviews/${sanitizeKeyPart(customerId)}/${sanitizeKeyPart(
      reviewId
    )}/${year}/${randomUUID()}-${sanitizeFilename(originalName)}`;
  }

  private buildServiceCaseAttachmentKey(serviceCaseId: string, originalName: string) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `service-cases/${sanitizeKeyPart(serviceCaseId)}/${year}/${month}/${randomUUID()}-${sanitizeFilename(originalName)}`;
  }

  private buildVehicleListingMediaKey(vehicleId: string, originalName: string) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    return `vehicle-listings/${sanitizeKeyPart(vehicleId)}/${year}/${randomUUID()}-${sanitizeFilename(originalName)}`;
  }

  private buildVehicleDocumentKey(vehicleId: string, originalName: string) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    return `vehicle-documents/${sanitizeKeyPart(vehicleId)}/${year}/${randomUUID()}-${sanitizeFilename(originalName)}`;
  }

  private buildVehicleBaasContractAttachmentKey(contractId: string, originalName: string) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    return `vehicle-baas-contracts/${sanitizeKeyPart(contractId)}/${year}/${randomUUID()}-${sanitizeFilename(originalName)}`;
  }

  private buildDeliveryEvidenceFileKey(workOrderId: string, originalName: string) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    return `delivery-evidence/${sanitizeKeyPart(workOrderId)}/${year}/${randomUUID()}-${sanitizeFilename(originalName)}`;
  }

  private buildDeliveryEvidenceDerivativeKey(
    workOrderId: string,
    kind: "PHOTO_PREVIEW" | "VIDEO_FRAME",
    originalName: string
  ) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    return `delivery-evidence/${sanitizeKeyPart(workOrderId)}/${year}/derivatives/${kind.toLowerCase()}/${randomUUID()}-${sanitizeFilename(originalName)}`;
  }

  private buildContractSignedArtifactKey(
    contractId: string,
    provider: string,
    originalName: string,
    objectIdentity?: string
  ) {
    if (objectIdentity) {
      return `contracts/${sanitizeKeyPart(contractId)}/esign/${sanitizeKeyPart(provider)}/signed/${sanitizeKeyPart(objectIdentity)}-${sanitizeFilename(originalName)}`;
    }
    const now = new Date();
    const year = String(now.getUTCFullYear());
    return `contracts/${sanitizeKeyPart(contractId)}/esign/${sanitizeKeyPart(provider)}/signed/${year}/${randomUUID()}-${sanitizeFilename(originalName)}`;
  }

  private buildGeneratedContractPdfArtifactKey(contractId: string, originalName: string) {
    return `contracts/${sanitizeKeyPart(contractId)}/generated/${sanitizeGeneratedPdfFilename(originalName)}`;
  }

  private withOssPrefix(key: string) {
    const prefix = this.configService.get<string>("OSS_PREFIX")?.replace(/^\/+|\/+$/g, "");
    return prefix ? `${prefix}/${key}` : key;
  }

  private assertFieldVideoMultipartDriver() {
    if (this.getDriver() !== "oss") {
      throw new BadRequestException({
        code: "FIELD_VIDEO_MULTIPART_REQUIRES_OSS",
        message: "视频断点续传仅支持受控 OSS 存储。"
      });
    }
  }

  private assertFieldVideoObjectKey(key: string) {
    const prefix = this.withOssPrefix("field-video/upload-sessions/");
    if (!key.startsWith(prefix) || key.includes("..") || key.includes("\0")) {
      throw new BadRequestException({
        code: "FIELD_VIDEO_OBJECT_KEY_INVALID",
        message: "视频上传存储路径无效。"
      });
    }
  }
}

function stripPrefix(value: string, prefix: string) {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function sanitizeFilename(name: string) {
  const parsed = path.parse(name);
  const base = parsed.name.replace(/[^\w.-]+/g, "_").slice(0, 80) || "file";
  const ext = parsed.ext.replace(/[^\w.]+/g, "").slice(0, 16);
  return `${base}${ext}`;
}

function sanitizeGeneratedPdfFilename(name: string) {
  const normalized = name.replace(/[\\/]+/g, "_");
  const parsed = path.parse(normalized);
  const base = parsed.name.replace(/[^\w.-]+/g, "_").slice(0, 160) || "contract";
  const ext = parsed.ext.replace(/[^\w.]+/g, "").slice(0, 16) || ".pdf";
  return `${base}${ext === "." ? ".pdf" : ext}`;
}

function normalizeGeneratedContractPdfObjectKey(contractId: string, objectKey: string) {
  const prefix = `contracts/${sanitizeKeyPart(contractId)}/generated/`;
  const normalized = objectKey.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.startsWith(prefix)) {
    throw new BadRequestException("生成合同 PDF 存储路径无效。");
  }
  const fileName = normalized.slice(prefix.length);
  const safeFileName = sanitizeGeneratedPdfFilename(fileName);
  const safeKey = `${prefix}${safeFileName}`;
  if (safeKey.length > 255) {
    throw new BadRequestException("生成合同 PDF 存储路径过长。");
  }
  return safeKey;
}

function sanitizeKeyPart(value: string) {
  const safe = value.replace(/[^\w-]+/g, "_");
  if (!safe || safe.includes("..")) {
    throw new BadRequestException("文件路径无效。");
  }
  return safe;
}
