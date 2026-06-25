import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { LocalStorageProvider } from "./local-storage.provider";
import { OssStorageProvider } from "./oss-storage.provider";
import { DownloadObjectResult, StorageDriver, StoredObject, UploadObjectInput, StorageProvider } from "./storage.types";

const LOCAL_BUCKET = "application-materials";
const OSS_BUCKET_PREFIX = "oss:";
const OSS_KEY_PREFIX = "oss:";

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

  async putApplicationMaterial(input: Omit<UploadObjectInput, "key"> & { applicationId: string }): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildApplicationMaterialKey(input.applicationId, input.originalName ?? "file");
    return this.putPrivateObject(key, input);
  }

  async putCustomerProfileMaterial(input: Omit<UploadObjectInput, "key"> & { customerId: string }): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildCustomerProfileMaterialKey(input.customerId, input.originalName ?? "file");
    return this.putPrivateObject(key, input);
  }

  getCustomerProfileMaterialStream(bucket: string, objectKey: string): Promise<DownloadObjectResult> {
    return this.getObject(bucket, objectKey);
  }

  async putServiceCaseAttachment(input: Omit<UploadObjectInput, "key"> & { serviceCaseId: string }): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildServiceCaseAttachmentKey(input.serviceCaseId, input.originalName ?? "file");
    return this.putPrivateObject(key, input);
  }

  async putVehicleListingMedia(input: Omit<UploadObjectInput, "key"> & { vehicleId: string }): Promise<{
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

  async putVehicleBaasContractAttachment(input: Omit<UploadObjectInput, "key"> & { contractId: string }): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildVehicleBaasContractAttachmentKey(input.contractId, input.originalName ?? "file");
    return this.putPrivateObject(key, input);
  }

  getVehicleBaasContractAttachmentStream(bucket: string, objectKey: string): Promise<DownloadObjectResult> {
    return this.getObject(bucket, objectKey);
  }

  async putContractSignedArtifact(input: Omit<UploadObjectInput, "key"> & {
    contractId: string;
    provider: string;
  }): Promise<{
    bucket: string;
    objectKey: string;
    stored: StoredObject;
  }> {
    const key = this.buildContractSignedArtifactKey(input.contractId, input.provider, input.originalName ?? "signed.pdf");
    return this.putPrivateObject(key, {
      buffer: input.buffer,
      contentType: input.contentType,
      metadata: input.metadata,
      originalName: input.originalName
    });
  }

  getContractSignedArtifactStream(objectKey: string): Promise<DownloadObjectResult> {
    return this.getObject(LOCAL_BUCKET, objectKey);
  }

  private async putPrivateObject(key: string, input: Omit<UploadObjectInput, "key">): Promise<{
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

  async getObject(bucket: string, objectKey: string): Promise<DownloadObjectResult> {
    const resolved = this.resolveStoredObject(bucket, objectKey);
    return resolved.provider.getObject(resolved.key);
  }

  async deleteObject(bucket: string, objectKey: string): Promise<void> {
    const resolved = this.resolveStoredObject(bucket, objectKey);
    await resolved.provider.deleteObject(resolved.key);
  }

  private resolveStoredObject(bucket: string, objectKey: string): { key: string; provider: StorageProvider } {
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

  private buildContractSignedArtifactKey(contractId: string, provider: string, originalName: string) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    return `contracts/${sanitizeKeyPart(contractId)}/esign/${sanitizeKeyPart(provider)}/signed/${year}/${randomUUID()}-${sanitizeFilename(originalName)}`;
  }

  private withOssPrefix(key: string) {
    const prefix = this.configService.get<string>("OSS_PREFIX")?.replace(/^\/+|\/+$/g, "");
    return prefix ? `${prefix}/${key}` : key;
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

function sanitizeKeyPart(value: string) {
  const safe = value.replace(/[^\w-]+/g, "_");
  if (!safe || safe.includes("..")) {
    throw new BadRequestException("文件路径无效。");
  }
  return safe;
}
