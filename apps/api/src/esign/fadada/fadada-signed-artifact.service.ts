import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ContractStatus, ESignProviderType, ESignSignerStatus, ESignSignerType, ESignTaskStatus, Prisma } from "@prisma/client";
import type { Readable } from "node:stream";

import { RequestUser } from "../../auth/auth.types";
import { PrismaService } from "../../prisma/prisma.service";
import { CurrentCustomer } from "../../portal/portal-auth.types";
import { StorageService } from "../../storage/storage.service";
import { FadadaApiClient } from "./fadada-api.client";
import { loadFadadaConfig } from "./fadada.config";
import { FadadaHttpClient } from "./fadada-http-client";

export const FADADA_ARCHIVE_INVALID_TASK = "FADADA_ARCHIVE_INVALID_TASK";
export const FADADA_ARCHIVE_PROVIDER_CONTRACT_MISSING = "FADADA_ARCHIVE_PROVIDER_CONTRACT_MISSING";
export const FADADA_ARCHIVE_SIGNED_PDF_MISSING = "FADADA_ARCHIVE_SIGNED_PDF_MISSING";
export const FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF = "FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF";
export const FADADA_ARCHIVE_SIGNED_PDF_TOO_LARGE = "FADADA_ARCHIVE_SIGNED_PDF_TOO_LARGE";

const MAX_SIGNED_PDF_BYTES = 20 * 1024 * 1024;

const signedArtifactTaskInclude = {
  contract: {
    include: {
      order: {
        include: {
          application: { select: { salesUserId: true } }
        }
      }
    }
  },
  signers: {
    where: { deletedAt: null }
  }
} satisfies Prisma.ContractESignTaskInclude;

type SignedArtifactTask = Prisma.ContractESignTaskGetPayload<{ include: typeof signedArtifactTaskInclude }>;

export interface FadadaSignedArtifactApi {
  createContractFiling(input: { contractId: string }): Promise<{
    contractId: string;
    filingNo?: string;
    raw: unknown;
  }>;
  downloadSignedContract(input: { contractId: string; downloadUrl?: string }): Promise<{
    buffer: Buffer;
    contentType: "application/pdf";
    fileName: string;
    raw?: unknown;
  }>;
  queryContractStatus(input: { contractId: string }): Promise<{
    contractId: string;
    raw: unknown;
    status?: string;
  }>;
  querySignResult(input: { contractId: string; customerId?: string; transactionId?: string }): Promise<{
    contractId: string;
    downloadUrl?: string;
    raw: unknown;
    resultCode?: string;
    resultDesc?: string;
    status?: "SIGNED" | "SIGNING" | "FAILED" | "UNKNOWN";
    transactionId?: string;
    viewPdfUrl?: string;
  }>;
}

export interface FadadaSignedContractPreview {
  contentType: "application/pdf";
  filename: string;
  sizeBytes: number;
  stream: Readable;
}

@Injectable()
export class FadadaSignedArtifactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService
  ) {}

  async archiveSignedContract(input: {
    force?: boolean;
    taskId: string;
  }): Promise<{
    archived: boolean;
    evidenceObjectKey?: string | null;
    signedPdfObjectKey?: string;
    skippedReason?: string;
  }> {
    const task = await this.findTaskByIdOrThrow(input.taskId);
    this.assertArchiveableTask(task, Boolean(input.force));

    if (task.signedDocumentObjectKey && !input.force) {
      return {
        archived: false,
        evidenceObjectKey: task.evidenceObjectKey,
        signedPdfObjectKey: task.signedDocumentObjectKey,
        skippedReason: "SIGNED_PDF_ALREADY_ARCHIVED"
      };
    }

    const providerContractId = task.providerEnvelopeId;
    if (!providerContractId) {
      throw new BadRequestException(`${FADADA_ARCHIVE_PROVIDER_CONTRACT_MISSING}: missing Fadada contract_id`);
    }

    const apiClient = this.getApiClient();
    const providerCustomerId = findProviderCustomerId(task);
    const signResult = await apiClient.querySignResult({
      contractId: providerContractId,
      ...(providerCustomerId ? { customerId: providerCustomerId } : {}),
      ...(task.providerTaskId ? { transactionId: task.providerTaskId } : {})
    });
    const contractStatus = signResult.resultCode
      ? null
      : await apiClient.queryContractStatus({ contractId: providerContractId });
    const signedPdf = await apiClient.downloadSignedContract({
      contractId: providerContractId,
      downloadUrl: signResult.downloadUrl
    });
    assertSignedPdf(signedPdf.buffer);

    const stored = await this.storageService.putContractSignedArtifact({
      buffer: signedPdf.buffer,
      contentType: "application/pdf",
      contractId: task.contractId,
      metadata: {
        provider: "fadada",
        providerContractId,
        providerTaskId: task.providerTaskId ?? ""
      },
      originalName: `${sanitizeFileName(task.contract.contractNo)}-signed.pdf`,
      provider: "fadada"
    });

    let filing: Awaited<ReturnType<FadadaSignedArtifactApi["createContractFiling"]>>;
    try {
      filing = await apiClient.createContractFiling({ contractId: providerContractId });
    } catch (error) {
      filing = {
        contractId: providerContractId,
        raw: {
          error: error instanceof Error ? error.message : String(error),
          skippedEvidenceReport: true
        }
      };
    }

    const responseSnapshot = mergeResponseSnapshot(task.responseSnapshot, {
      fadadaSignedArtifactArchive: sanitizeProviderPayload({
        archivedAt: new Date(),
        contractFiling: filing,
        contractStatus,
        querySignResult: signResult.raw,
        signedPdf: {
          fileName: signedPdf.fileName,
          objectKeyPresent: true,
          size: signedPdf.buffer.length
        }
      })
    });

    await this.prisma.contractESignTask.update({
      data: {
        evidenceObjectKey: task.evidenceObjectKey,
        responseSnapshot: toJsonValue(responseSnapshot),
        signedDocumentObjectKey: stored.objectKey
      },
      where: { id: task.id }
    });

    return {
      archived: true,
      evidenceObjectKey: task.evidenceObjectKey,
      signedPdfObjectKey: stored.objectKey
    };
  }

  async getAdminSignedContractPreview(taskId: string, user: RequestUser): Promise<FadadaSignedContractPreview> {
    const task = await this.findTaskByIdOrThrow(taskId);
    ensureCanAccessTask(task, user);
    return this.buildPreview(task);
  }

  async getPortalSignedContractPreview(
    contractId: string,
    currentCustomer: CurrentCustomer
  ): Promise<FadadaSignedContractPreview> {
    const task = await this.prisma.contractESignTask.findFirst({
      include: signedArtifactTaskInclude,
      where: {
        contractId,
        customerId: currentCustomer.customerId,
        deletedAt: null,
        signedDocumentObjectKey: { not: null },
        taskStatus: ESignTaskStatus.COMPLETED
      }
    });

    if (!task || task.contract.customerId !== currentCustomer.customerId || task.contract.status !== ContractStatus.SIGNED) {
      throw new NotFoundException("Signed contract not found.");
    }

    return this.buildPreview(task);
  }

  protected getApiClient(): FadadaSignedArtifactApi {
    const fadadaConfig = loadFadadaConfig(this.configService);
    return new FadadaApiClient(fadadaConfig, new FadadaHttpClient(fadadaConfig));
  }

  private async findTaskByIdOrThrow(taskId: string) {
    const task = await this.prisma.contractESignTask.findFirst({
      include: signedArtifactTaskInclude,
      where: { deletedAt: null, id: taskId }
    });
    if (!task) {
      throw new NotFoundException("E-sign task not found.");
    }
    return task;
  }

  private assertArchiveableTask(task: SignedArtifactTask, force: boolean) {
    if (task.provider !== ESignProviderType.FADADA) {
      throw new BadRequestException(`${FADADA_ARCHIVE_INVALID_TASK}: only Fadada tasks can be archived here`);
    }
    if (!force && task.taskStatus !== ESignTaskStatus.COMPLETED) {
      throw new BadRequestException(`${FADADA_ARCHIVE_INVALID_TASK}: task must be completed before archive`);
    }
    if (!force && task.signers.some((signer) =>
      isRequiredSignerRow(signer) && signer.signerStatus !== ESignSignerStatus.SIGNED
    )) {
      throw new BadRequestException(`${FADADA_ARCHIVE_INVALID_TASK}: all required signers must be signed before archive`);
    }
  }

  private async buildPreview(task: SignedArtifactTask): Promise<FadadaSignedContractPreview> {
    if (!task.signedDocumentObjectKey) {
      throw new NotFoundException(`${FADADA_ARCHIVE_SIGNED_PDF_MISSING}: signed PDF artifact not found`);
    }

    const object = await this.storageService.getContractSignedArtifactStream(task.signedDocumentObjectKey);
    if (object.contentType && !object.contentType.toLowerCase().includes("application/pdf")) {
      throw new BadRequestException(`${FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF}: signed artifact must be a PDF`);
    }

    return {
      contentType: "application/pdf",
      filename: `${sanitizeFileName(task.contract.contractNo)}-signed.pdf`,
      sizeBytes: object.contentLength ?? 0,
      stream: object.stream
    };
  }
}

function ensureCanAccessTask(task: SignedArtifactTask, user: RequestUser) {
  if (user.roles.includes("admin") || user.permissions.includes("order:view:all")) {
    return;
  }
  if (task.contract.order.application.salesUserId !== user.id) {
    throw new NotFoundException("E-sign task not found.");
  }
}

function assertSignedPdf(buffer: Buffer) {
  if (buffer.length > MAX_SIGNED_PDF_BYTES) {
    throw new Error(`${FADADA_ARCHIVE_SIGNED_PDF_TOO_LARGE}: signed PDF must be <= 20MB`);
  }
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-", "utf8"))) {
    throw new Error(`${FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF}: signed PDF must start with %PDF-`);
  }
}

function mergeResponseSnapshot(existing: unknown, patch: Record<string, unknown>) {
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  return {
    ...base,
    ...patch
  };
}

function findProviderCustomerId(task: SignedArtifactTask) {
  const customerSigner = task.signers.find((signer) => signer.signerType === ESignSignerType.CUSTOMER);
  const snapshot = customerSigner?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return undefined;
  }
  const providerCustomerId = (snapshot as Record<string, unknown>).providerCustomerId;
  return typeof providerCustomerId === "string" && providerCustomerId.trim() ? providerCustomerId : undefined;
}

function isRequiredSignerRow(signer: { snapshot?: unknown }) {
  const snapshot = signer.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return true;
  }
  return (snapshot as Record<string, unknown>).required !== false;
}

function sanitizeProviderPayload(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeProviderPayload);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveUrlField(key, item) ? "[redacted-url]" : sanitizeProviderPayload(item)
      ])
    );
  }
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    return "[redacted-url]";
  }
  return value;
}

function isSensitiveUrlField(key: string, value: unknown) {
  return typeof value === "string" && /(^|_)(download|view|sign)?url$/i.test(key);
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return toPlain(value) as Prisma.InputJsonValue;
}

function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Prisma.Decimal) {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPlain(item)]));
  }
  return value;
}

function sanitizeFileName(value: string) {
  return (value.replace(/[^\w.-]+/g, "_").slice(0, 120) || "contract").replace(/^\.+$/, "contract");
}
