import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  ESignDocumentType,
  ESignProviderActionType,
  ESignProviderType,
  ESignSignerStatus,
  ESignSignerType,
  ESignSigningStage,
  ESignSlotId,
  ESignTaskStatus,
  OrderStatus
} from "@prisma/client";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  FadadaSignedArtifactApi,
  FadadaSignedArtifactService
} from "../src/esign/fadada/fadada-signed-artifact.service";
import { RequestUser } from "../src/auth/auth.types";
import { CurrentCustomer } from "../src/portal/portal-auth.types";

describe("FadadaSignedArtifactService", () => {
  it("requires a completed Fadada task before archiving signed artifacts", async () => {
    const { service, state } = createFixture();
    state.task.taskStatus = ESignTaskStatus.WAITING_CUSTOMER;

    await expect(service.archiveSignedContract({ taskId: "task-1" })).rejects.toBeInstanceOf(BadRequestException);

    state.task.taskStatus = ESignTaskStatus.COMPLETED;
    state.task.provider = ESignProviderType.MOCK;

    await expect(service.archiveSignedContract({ taskId: "task-1" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("requires all task signers to be signed before archiving signed artifacts", async () => {
    const { service, state } = createFixture();
    state.signers.push({
      deletedAt: null,
      id: "signer-platform-1",
      signerStatus: ESignSignerStatus.PENDING,
      signerType: ESignSignerType.PLATFORM,
      taskId: "task-1"
    });

    await expect(service.archiveSignedContract({ taskId: "task-1" })).rejects.toThrow(
      /FADADA_ARCHIVE_INVALID_TASK/
    );
  });

  it("blocks archive until all required Stage 1 slot rows are signed", async () => {
    const { service, state } = createFixture();
    (state.signers as Array<Record<string, unknown>>).splice(
      0,
      state.signers.length,
      {
        deletedAt: null,
        id: "slot-body-customer",
        signerStatus: ESignSignerStatus.SIGNED,
        signerType: ESignSignerType.CUSTOMER,
        snapshot: { required: true, slotId: "STAGE1_BODY_CUSTOMER" },
        taskId: "task-1"
      },
      {
        deletedAt: null,
        id: "slot-attachment1-customer",
        signerStatus: ESignSignerStatus.SIGNED,
        signerType: ESignSignerType.CUSTOMER,
        snapshot: { required: true, slotId: "STAGE1_ATTACHMENT1_CUSTOMER" },
        taskId: "task-1"
      },
      {
        deletedAt: null,
        id: "slot-body-platform",
        signerStatus: ESignSignerStatus.SIGNED,
        signerType: ESignSignerType.PLATFORM,
        snapshot: { required: true, slotId: "STAGE1_BODY_PLATFORM" },
        taskId: "task-1"
      },
      {
        deletedAt: null,
        id: "slot-attachment1-platform",
        signerStatus: ESignSignerStatus.PENDING,
        signerType: ESignSignerType.PLATFORM,
        snapshot: { required: true, slotId: "STAGE1_ATTACHMENT1_PLATFORM" },
        taskId: "task-1"
      }
    );

    await expect(service.archiveSignedContract({ taskId: "task-1" })).rejects.toThrow(
      /FADADA_ARCHIVE_INVALID_TASK/
    );

    state.signers[3]!.signerStatus = ESignSignerStatus.SIGNED;
    await expect(service.archiveSignedContract({ taskId: "task-1" })).resolves.toMatchObject({
      archived: true
    });
  });

  it("downloads, validates, stores and records a signed PDF without changing contract or order state", async () => {
    const { apiClient, service, state, storageService } = createFixture();
    const signedAt = state.contract.signedAt;
    const orderStatus = state.contract.order.orderStatus;
    const finance = financeSnapshot(state);

    const result = await service.archiveSignedContract({ taskId: "task-1" });

    expect(apiClient.querySignResult).toHaveBeenCalledWith({
      contractId: "FADADA-CON-1",
      transactionId: "TX-1"
    });
    expect(apiClient.downloadSignedContract).toHaveBeenCalledWith({
      contractId: "FADADA-CON-1",
      downloadUrl: "https://download.example.test/file.pdf?token=secret"
    });
    expect(apiClient.createContractFiling).toHaveBeenCalledWith({ contractId: "FADADA-CON-1" });
    expect(storageService.putContractSignedArtifact).toHaveBeenCalledWith(expect.objectContaining({
      buffer: expect.any(Buffer),
      contentType: "application/pdf",
      contractId: "contract-1",
      originalName: "CON-1-signed.pdf",
      provider: "fadada"
    }));
    expect(result).toMatchObject({
      archived: true,
      evidenceObjectKey: null,
      signedPdfObjectKey: "contracts/contract-1/esign/fadada/signed/2026/signed-1.pdf"
    });
    expect(state.task.signedDocumentObjectKey).toBe("contracts/contract-1/esign/fadada/signed/2026/signed-1.pdf");
    expect(state.task.evidenceObjectKey).toBeNull();
    expect(state.contract.signedAt).toBe(signedAt);
    expect(state.contract.order.orderStatus).toBe(orderStatus);
    expect(financeSnapshot(state)).toEqual(finance);
    expect(JSON.stringify(state.task.responseSnapshot)).not.toContain("token=secret");
    expect(JSON.stringify(state.task.responseSnapshot)).toContain("[redacted-url]");
  });

  it("skips archive idempotently when a signed PDF already exists", async () => {
    const { apiClient, service, state, storageService } = createFixture();
    state.task.signedDocumentObjectKey = "contracts/contract-1/esign/fadada/signed/2026/existing.pdf";

    const result = await service.archiveSignedContract({ taskId: "task-1" });

    expect(result).toEqual({
      archived: false,
      evidenceObjectKey: null,
      signedPdfObjectKey: "contracts/contract-1/esign/fadada/signed/2026/existing.pdf",
      skippedReason: "SIGNED_PDF_ALREADY_ARCHIVED"
    });
    expect(apiClient.downloadSignedContract).not.toHaveBeenCalled();
    expect(storageService.putContractSignedArtifact).not.toHaveBeenCalled();
  });

  it("force archives a new signed PDF object key without changing finance state", async () => {
    const { service, state, storageService } = createFixture();
    const signedAt = state.contract.signedAt;
    const orderStatus = state.contract.order.orderStatus;
    const finance = financeSnapshot(state);

    const first = await service.archiveSignedContract({ taskId: "task-1" });
    const firstObjectKey = state.task.signedDocumentObjectKey;
    const forced = await service.archiveSignedContract({ force: true, taskId: "task-1" });

    expect(first).toMatchObject({
      archived: true,
      signedPdfObjectKey: "contracts/contract-1/esign/fadada/signed/2026/signed-1.pdf"
    });
    expect(forced).toMatchObject({
      archived: true,
      evidenceObjectKey: null,
      signedPdfObjectKey: "contracts/contract-1/esign/fadada/signed/2026/signed-2.pdf"
    });
    expect(forced.signedPdfObjectKey).not.toBe(firstObjectKey);
    expect(state.task.signedDocumentObjectKey).toBe(forced.signedPdfObjectKey);
    expect(state.task.evidenceObjectKey).toBeNull();
    expect(state.contract.signedAt).toBe(signedAt);
    expect(state.contract.order.orderStatus).toBe(orderStatus);
    expect(financeSnapshot(state)).toEqual(finance);
    expect(storageService.putContractSignedArtifact).toHaveBeenCalledTimes(2);
  });

  it("archives a typed Stage 2 PDF with a FileObject and signed hash while preserving signed business state", async () => {
    const { apiClient, service, state, storageService } = createStage2Fixture();
    const completedAt = state.task.completedAt;
    const contractSignedAt = state.contract.signedAt;
    const orderStatus = state.contract.order.orderStatus;
    const finance = financeSnapshot(state);

    const result = await service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    });

    expect(result).toMatchObject({
      archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
      archived: true,
      signedPdfHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(result).not.toHaveProperty("objectKey");
    expect(result).not.toHaveProperty("bucket");
    expect(apiClient.querySignResult).toHaveBeenCalledWith({
      contractId: "FADADA-HANDOVER-1",
      transactionId: "STAGE2PLATFORMH2"
    });
    expect(storageService.putContractSignedArtifact).toHaveBeenCalledOnce();
    expect(state.fileObjects).toHaveLength(1);
    expect(state.fileObjects[0]).toMatchObject({
      mimeType: "application/pdf",
      originalName: "HDV-1-signed.pdf",
      sizeBytes: BigInt(minimalPdf().length),
      uploadedBy: "user-admin"
    });
    expect(state.handover).toMatchObject({
      archiveLastAttemptAt: expect.any(Date),
      archiveLastError: null,
      archiveRetryCount: 1,
      archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
      archivedAt: expect.any(Date),
      signedDocumentFileId: state.fileObjects[0]!.id,
      signedPdfHash: result.signedPdfHash,
      status: DeliveryHandoverStatus.ARCHIVED
    });
    expect(state.task).toMatchObject({
      completedAt,
      signedDocumentObjectKey: expect.any(String),
      taskStatus: ESignTaskStatus.COMPLETED
    });
    expect(state.contract).toMatchObject({
      signedAt: contractSignedAt,
      status: ContractStatus.SIGNED
    });
    expect(state.contract.order.orderStatus).toBe(orderStatus);
    expect(financeSnapshot(state)).toEqual(finance);
  });

  it("uses a deterministic object identity and removes a known-uncommitted signed PDF after DB finalization fails", async () => {
    const { prisma, service, state, storageService } = createStage2Fixture();
    prisma.$transaction.mockRejectedValueOnce(
      new Error("simulated archive finalization failure")
    );

    await expect(service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ARCHIVE_PROVIDER_FAILED"
      })
    });

    expect(storageService.putContractSignedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        objectIdentity: expect.stringMatching(
          /^task-1-v1-[a-f0-9]{64}$/
        )
      })
    );
    expect(storageService.deleteObject).toHaveBeenCalledWith(
      "application-materials",
      expect.stringContaining("task-1-v1")
    );
    expect(state.fileObjects).toHaveLength(0);
    expect(state.handover).toMatchObject({
      archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
      signedDocumentFileId: null,
      signedObjectKey: null,
      status: DeliveryHandoverStatus.SIGNED
    });
  });

  it.each([
    {
      buffer: Buffer.from('{"code":"provider-error"}', "utf8"),
      contentType: "application/json",
      title: "JSON MIME"
    },
    {
      buffer: Buffer.from('{"code":"not-a-pdf"}', "utf8"),
      contentType: "application/pdf",
      title: "invalid PDF magic"
    }
  ])("rejects a Stage 2 $title response without storing it", async ({ buffer, contentType }) => {
    const { apiClient, service, state, storageService } = createStage2Fixture();
    vi.mocked(apiClient.downloadSignedContract).mockResolvedValueOnce({
      buffer,
      contentType,
      fileName: "provider-response.pdf"
    });

    await expect(service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF"
      })
    });

    expect(storageService.putContractSignedArtifact).not.toHaveBeenCalled();
    expect(state.fileObjects).toHaveLength(0);
    expect(state.handover).toMatchObject({
      archiveLastAttemptAt: expect.any(Date),
      archiveLastError: "FADADA_ARCHIVE_SIGNED_PDF_NOT_PDF",
      archiveRetryCount: 1,
      archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
      signedDocumentFileId: null,
      signedPdfHash: null,
      status: DeliveryHandoverStatus.SIGNED
    });
    expect(state.task.taskStatus).toBe(ESignTaskStatus.COMPLETED);
    expect(state.contract.status).toBe(ContractStatus.SIGNED);
  });

  it("keeps Stage 2 signed on archive failure, then retries once and skips later duplicates", async () => {
    const { apiClient, service, state, storageService } = createStage2Fixture();
    vi.mocked(apiClient.querySignResult)
      .mockRejectedValueOnce(new Error("provider response contained a secret token"));

    await expect(service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ARCHIVE_PROVIDER_FAILED"
      })
    });

    expect(state.handover).toMatchObject({
      archiveLastError: "STAGE2_HANDOVER_ARCHIVE_PROVIDER_FAILED",
      archiveRetryCount: 1,
      archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
      status: DeliveryHandoverStatus.SIGNED
    });
    expect(JSON.stringify(state.handover)).not.toContain("secret token");

    const retried = await service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    });
    const duplicate = await service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    });

    expect(retried).toMatchObject({
      archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
      archived: true
    });
    expect(duplicate).toEqual({
      archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
      archived: false,
      skippedReason: "SIGNED_PDF_ALREADY_ARCHIVED"
    });
    expect(state.handover!.archiveRetryCount).toBe(2);
    expect(apiClient.querySignResult).toHaveBeenCalledTimes(2);
    expect(storageService.putContractSignedArtifact).toHaveBeenCalledTimes(1);
    expect(state.fileObjects).toHaveLength(1);
  });

  it("does not steal a fresh Stage 2 archive claim within the default five-minute lease", async () => {
    const { apiClient, service, state, storageService } = createStage2Fixture();
    state.handover!.archiveStatus = DeliveryHandoverArchiveStatus.PENDING;
    state.handover!.archiveLastAttemptAt = new Date(Date.now() - 4 * 60 * 1000);
    state.handover!.archiveRetryCount = 1;

    const result = await service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    });

    expect(result).toEqual({
      archiveStatus: DeliveryHandoverArchiveStatus.PENDING,
      archived: false,
      skippedReason: "ARCHIVE_IN_PROGRESS"
    });
    expect(state.handover).toMatchObject({
      archiveRetryCount: 1,
      archiveStatus: DeliveryHandoverArchiveStatus.PENDING
    });
    expect(apiClient.querySignResult).not.toHaveBeenCalled();
    expect(storageService.putContractSignedArtifact).not.toHaveBeenCalled();
  });

  it("atomically reclaims a stale Stage 2 archive claim after the default five-minute lease", async () => {
    const { apiClient, prisma, service, state, storageService } = createStage2Fixture();
    const staleAttemptAt = new Date(Date.now() - 6 * 60 * 1000);
    state.handover!.archiveStatus = DeliveryHandoverArchiveStatus.PENDING;
    state.handover!.archiveLastAttemptAt = staleAttemptAt;
    state.handover!.archiveRetryCount = 1;
    state.handover!.signedObjectKey = "application-materials/stale-signed.pdf";

    const result = await service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    });

    expect(result).toMatchObject({
      archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
      archived: true
    });
    expect(state.handover).toMatchObject({
      archiveLastAttemptAt: expect.any(Date),
      archiveRetryCount: 2,
      archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED
    });
    expect(state.handover!.archiveLastAttemptAt).not.toEqual(staleAttemptAt);
    expect(apiClient.querySignResult).toHaveBeenCalledOnce();
    expect(storageService.putContractSignedArtifact).toHaveBeenCalledOnce();
    const clearPointerCall = vi.mocked(
      prisma.vehicleDeliveryHandover.updateMany
    ).mock.calls.find((call) =>
      (call[0] as { data: Record<string, unknown> }).data.signedObjectKey === null
    );
    expect(clearPointerCall).toBeDefined();
    expect(
      vi.mocked(prisma.vehicleDeliveryHandover.updateMany).mock.invocationCallOrder[
        vi.mocked(prisma.vehicleDeliveryHandover.updateMany).mock.calls.indexOf(
          clearPointerCall!
        )
      ]
    ).toBeLessThan(
      vi.mocked(storageService.deleteContractSignedArtifactObject)
        .mock.invocationCallOrder[0]!
    );
  });

  it("binds the Stage 2 archive object identity to the downloaded signed PDF hash", async () => {
    const { service, state, storageService } = createStage2Fixture();

    const result = await service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    });

    expect(storageService.putContractSignedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        objectIdentity: `${state.task.id}-v1-${result.signedPdfHash}`
      })
    );
  });

  it("fences a reclaimed Stage 2 archive worker after download and before storage write", async () => {
    const { apiClient, service, state, storageService } = createStage2Fixture();
    const newerAttemptAt = new Date(Date.now() + 60_000);
    vi.mocked(apiClient.downloadSignedContract).mockImplementationOnce(async () => {
      state.handover!.archiveLastAttemptAt = newerAttemptAt;
      state.handover!.archiveRetryCount = 2;
      return {
        buffer: Buffer.from("%PDF-1.4\nnewer worker owns the claim\n%%EOF\n"),
        contentType: "application/pdf",
        fileName: "signed.pdf"
      };
    });

    await expect(service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH"
      })
    });

    expect(state.handover!.archiveLastAttemptAt).toEqual(newerAttemptAt);
    expect(storageService.putContractSignedArtifact).not.toHaveBeenCalled();
  });

  it("uses a valid configured Stage 2 archive claim timeout", async () => {
    const { apiClient, service, state } = createStage2Fixture({
      STAGE2_HANDOVER_ARCHIVE_CLAIM_TIMEOUT_MS: "60000"
    });
    state.handover!.archiveStatus = DeliveryHandoverArchiveStatus.PENDING;
    state.handover!.archiveLastAttemptAt = new Date(Date.now() - 2 * 60 * 1000);
    state.handover!.archiveRetryCount = 1;

    const result = await service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    });

    expect(result).toMatchObject({
      archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
      archived: true
    });
    expect(apiClient.querySignResult).toHaveBeenCalledOnce();
  });

  it("falls back to the five-minute archive lease for an unsafe configured timeout", async () => {
    const { apiClient, service, state } = createStage2Fixture({
      STAGE2_HANDOVER_ARCHIVE_CLAIM_TIMEOUT_MS: "0"
    });
    state.handover!.archiveStatus = DeliveryHandoverArchiveStatus.PENDING;
    state.handover!.archiveLastAttemptAt = new Date(Date.now() - 4 * 60 * 1000);
    state.handover!.archiveRetryCount = 1;

    const result = await service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    });

    expect(result).toMatchObject({
      archiveStatus: DeliveryHandoverArchiveStatus.PENDING,
      archived: false,
      skippedReason: "ARCHIVE_IN_PROGRESS"
    });
    expect(apiClient.querySignResult).not.toHaveBeenCalled();
  });

  it("does not let an expired archive worker overwrite a newer reclaimed lease", async () => {
    const { apiClient, service, state, storageService } = createStage2Fixture();
    const staleAttemptAt = new Date(Date.now() - 6 * 60 * 1000);
    const newerAttemptAt = new Date(Date.now() + 60 * 1000);
    state.handover!.archiveStatus = DeliveryHandoverArchiveStatus.PENDING;
    state.handover!.archiveLastAttemptAt = staleAttemptAt;
    state.handover!.archiveRetryCount = 1;
    vi.mocked(apiClient.querySignResult).mockImplementationOnce(async () => {
      state.handover!.archiveLastAttemptAt = newerAttemptAt;
      state.handover!.archiveRetryCount = 3;
      throw new Error("expired worker resumed after lease takeover");
    });

    await expect(service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ARCHIVE_PROVIDER_FAILED"
      })
    });

    expect(state.handover).toMatchObject({
      archiveLastAttemptAt: newerAttemptAt,
      archiveLastError: null,
      archiveRetryCount: 3,
      archiveStatus: DeliveryHandoverArchiveStatus.PENDING,
      status: DeliveryHandoverStatus.SIGNED
    });
    expect(storageService.putContractSignedArtifact).not.toHaveBeenCalled();
  });

  it("rejects a Stage 2 source identity mismatch before provider or storage calls", async () => {
    const { apiClient, service, state, storageService } = createStage2Fixture();
    state.task.requestSnapshot = {
      ...(state.task.requestSnapshot as Record<string, unknown>),
      manifestHash: "c".repeat(64)
    };

    await expect(service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH"
      })
    });

    expect(apiClient.querySignResult).not.toHaveBeenCalled();
    expect(storageService.putContractSignedArtifact).not.toHaveBeenCalled();
    expect(state.handover).toMatchObject({
      archiveRetryCount: 0,
      archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED,
      status: DeliveryHandoverStatus.SIGNED
    });
  });

  it("rejects a stale Stage 2 source file identity before provider or storage calls", async () => {
    const { apiClient, service, state, storageService } = createStage2Fixture();
    state.task.requestSnapshot = {
      ...(state.task.requestSnapshot as Record<string, unknown>),
      sourceDocumentFileId: "superseded-source-file"
    };

    await expect(service.archiveSignedStage2Handover({
      actorId: "user-admin",
      taskId: state.task.id
    })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH"
      })
    });

    expect(apiClient.querySignResult).not.toHaveBeenCalled();
    expect(storageService.putContractSignedArtifact).not.toHaveBeenCalled();
    expect(state.handover).toMatchObject({
      archiveRetryCount: 0,
      archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED,
      status: DeliveryHandoverStatus.SIGNED
    });
  });

  it("streams archived signed PDFs for admins and owning portal customers only", async () => {
    const { service, state, storageService } = createFixture();
    state.task.signedDocumentObjectKey = "contracts/contract-1/esign/fadada/signed/2026/signed.pdf";

    const adminPreview = await service.getAdminSignedContractPreview("task-1", adminUser());
    const portalPreview = await service.getPortalSignedContractPreview("contract-1", currentCustomer("customer-1"));

    expect(adminPreview).toMatchObject({
      contentType: "application/pdf",
      filename: "CON-1-signed.pdf",
      sizeBytes: minimalPdf().length
    });
    expect(portalPreview).toMatchObject({
      contentType: "application/pdf",
      filename: "CON-1-signed.pdf",
      sizeBytes: minimalPdf().length
    });
    expect(storageService.getContractSignedArtifactStream).toHaveBeenCalledWith(
      "contracts/contract-1/esign/fadada/signed/2026/signed.pdf"
    );
    expect(adminPreview).not.toHaveProperty("objectKey");
    expect(portalPreview).not.toHaveProperty("objectKey");
    await expect(
      service.getPortalSignedContractPreview("contract-1", currentCustomer("customer-other"))
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

class TestFadadaSignedArtifactService extends FadadaSignedArtifactService {
  constructor(
    prisma: never,
    storageService: never,
    configService: ConfigService,
    private readonly testApiClient: FadadaSignedArtifactApi
  ) {
    super(prisma, storageService, configService);
  }

  protected override getApiClient(): FadadaSignedArtifactApi {
    return this.testApiClient;
  }
}

function createFixture(env: Record<string, string> = {}) {
  const state = {
    contract: {
      contractNo: "CON-1",
      customerId: "customer-1",
      deletedAt: null,
      id: "contract-1",
      order: {
        application: { salesUserId: "user-sales" },
        deletedAt: null,
        id: "order-1",
        orderStatus: OrderStatus.PENDING_PAYMENT as OrderStatus
      },
      signedAt: new Date("2026-01-03T04:05:06.000Z"),
      status: ContractStatus.SIGNED
    },
    finance: {
      paymentOrders: [
        {
          amount: "120000.00",
          id: "payment-order-1",
          paymentStatus: "PENDING"
        }
      ],
      paymentRecords: [
        {
          amount: "0.00",
          id: "payment-record-1",
          paymentStatus: "DRAFT"
        }
      ],
      paymentWriteOffs: [
        {
          amount: "0.00",
          id: "writeoff-1"
        }
      ],
      receivableBills: [
        {
          amount: "120000.00",
          billStatus: "PENDING",
          id: "bill-1"
        }
      ]
    },
    fileObjects: [] as FakeFileObject[],
    handover: null as FakeStage2Handover | null,
    signers: [
      {
        deletedAt: null as Date | null,
        id: "signer-customer-1",
        signerStatus: ESignSignerStatus.SIGNED as ESignSignerStatus,
        signerType: ESignSignerType.CUSTOMER as ESignSignerType,
        taskId: "task-1"
      }
    ],
    task: {
      callbackSnapshot: null as unknown,
      completedAt: new Date("2026-01-03T04:05:06.000Z"),
      contractId: "contract-1",
      customerId: "customer-1",
      deletedAt: null as Date | null,
      documentType: ESignDocumentType.SUBSCRIPTION_CONTRACT,
      documentName: "Subscription Contract",
      errorSnapshot: null as unknown,
      evidenceObjectKey: null as string | null,
      id: "task-1",
      orderId: "order-1",
      provider: ESignProviderType.FADADA as ESignProviderType,
      providerEnvelopeId: "FADADA-CON-1",
      providerTaskId: "TX-1",
      requestSnapshot: null as unknown,
      responseSnapshot: null as unknown,
      signedDocumentObjectKey: null as string | null,
      signingStage: ESignSigningStage.STAGE1_SUBSCRIPTION_CONTRACT,
      taskNo: "ESG-1",
      taskStatus: ESignTaskStatus.COMPLETED as ESignTaskStatus
    }
  };
  const pdf = minimalPdf();
  const apiClient: FadadaSignedArtifactApi = {
    createContractFiling: vi.fn(async () => ({
      contractId: "FADADA-CON-1",
      filingNo: "FILING-1",
      raw: { filing_no: "FILING-1" }
    })),
    downloadSignedContract: vi.fn(async () => ({
      buffer: pdf,
      contentType: "application/pdf" as const,
      fileName: "provider-signed.pdf"
    })),
    queryContractStatus: vi.fn(async () => ({
      contractId: "FADADA-CON-1",
      raw: { contractStatus: "2" },
      status: "2"
    })),
    querySignResult: vi.fn(async () => ({
      contractId: "FADADA-CON-1",
      downloadUrl: "https://download.example.test/file.pdf?token=secret",
      raw: {
        download_url: "https://download.example.test/file.pdf?token=secret",
        result: "3000",
        viewpdf_url: "https://view.example.test/file.pdf?token=secret"
      },
      resultCode: "3000",
      transactionId: "TX-1",
      viewPdfUrl: "https://view.example.test/file.pdf?token=secret"
    }))
  };
  const prisma = {
    $transaction: vi.fn(async (input: unknown) => {
      if (typeof input === "function") {
        return (input as (tx: typeof prisma) => unknown)(prisma);
      }
      return Promise.all(input as Array<Promise<unknown>>);
    }),
    contractESignTask: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id && where.id !== state.task.id) return null;
        if (where.contractId && where.contractId !== state.task.contractId) return null;
        if (where.customerId && where.customerId !== state.task.customerId) return null;
        if (where.provider && where.provider !== state.task.provider) return null;
        if (where.taskStatus && where.taskStatus !== state.task.taskStatus) return null;
        if (where.deletedAt === null && state.task.deletedAt !== null) return null;
        const signedWhere = where.signedDocumentObjectKey as { not?: null } | undefined;
        if (signedWhere?.not === null && !state.task.signedDocumentObjectKey) return null;
        return hydrateTask(state);
      }),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        if (where.id !== state.task.id) {
          throw new Error("task not found");
        }
        Object.assign(state.task, data);
        return hydrateTask(state);
      })
    },
    fileObject: {
      create: vi.fn(async ({ data }: { data: Omit<FakeFileObject, "id"> }) => {
        const fileObject: FakeFileObject = {
          ...data,
          id: `signed-file-${state.fileObjects.length + 1}`
        };
        state.fileObjects.push(fileObject);
        return fileObject;
      })
    },
    vehicleDeliveryHandover: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.handover?.id === where.id ? state.handover : null
      ),
      updateMany: vi.fn(async ({
        data,
        where
      }: {
        data: Record<string, unknown>;
        where: Record<string, unknown>;
      }) => {
        if (!state.handover || !matchesHandoverWhere(state.handover, where)) {
          return { count: 0 };
        }
        for (const [key, value] of Object.entries(data)) {
          if (
            value &&
            typeof value === "object" &&
            "increment" in value
          ) {
            state.handover[key] =
              Number(state.handover[key] ?? 0) +
              Number((value as { increment: number }).increment);
          } else {
            state.handover[key] = value;
          }
        }
        return { count: 1 };
      })
    }
  };
  let signedArtifactWriteCount = 0;
  const storageService = {
    buildContractSignedArtifactObjectKey: vi.fn(
      (
        contractId: string,
        provider: string,
        originalName: string,
        objectIdentity: string
      ) =>
        `contracts/${contractId}/esign/${provider}/signed/${objectIdentity}-${originalName}`
    ),
    deleteContractSignedArtifactObject: vi.fn(async () => undefined),
    deleteObject: vi.fn(async () => undefined),
    getContractSignedArtifactStream: vi.fn(async () => ({
      contentLength: pdf.length,
      contentType: "application/pdf",
      originalName: "signed.pdf",
      stream: Readable.from([pdf])
    })),
    putContractSignedArtifact: vi.fn(async (input: {
      objectIdentity?: string;
      originalName?: string;
    }) => {
      signedArtifactWriteCount += 1;
      const objectKey = input.objectIdentity
        ? `contracts/contract-1/esign/fadada/signed/${input.objectIdentity}-${input.originalName}`
        : `contracts/contract-1/esign/fadada/signed/2026/signed-${signedArtifactWriteCount}.pdf`;
      return {
        bucket: "application-materials",
        objectKey,
        stored: {
          contentType: "application/pdf",
          driver: "local",
          key: `application-materials/${objectKey}`,
          size: pdf.length
        }
      };
    })
  };
  const service = new TestFadadaSignedArtifactService(
    prisma as never,
    storageService as never,
    new ConfigService({
      ESIGN_PROVIDER: "fadada",
      FADADA_API_VERSION: "2.0",
      FADADA_APP_ID: "app-123",
      FADADA_APP_SECRET: "secret-xyz",
      FADADA_BASE_URL: "https://testapi.fadada.com:8443/api/",
      FADADA_ENABLED: "false",
      FADADA_ENV: "sandbox",
      ...env
    }),
    apiClient
  );

  return { apiClient, prisma, service, state, storageService };
}

function hydrateTask(state: ReturnType<typeof createFixture>["state"]) {
  return {
    ...state.task,
    contract: state.contract,
    deliveryHandover: state.handover,
    signers: state.signers.filter((signer) => signer.taskId === state.task.id && !signer.deletedAt)
  };
}

function createStage2Fixture(env: Record<string, string> = {}) {
  const harness = createFixture(env);
  harness.state.contract.contractNo = "HDV-1";
  harness.state.contract.order.orderStatus = OrderStatus.PENDING_DELIVERY;
  Object.assign(harness.state.task, {
    documentName: "Delivery handover confirmation",
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    providerEnvelopeId: "FADADA-HANDOVER-1",
    providerTaskId: "STAGE2CUSTOMERH1",
    requestSnapshot: {
      artifactVersion: 1,
      contractId: harness.state.contract.id,
      handoverId: "handover-1",
      manifestHash: "b".repeat(64),
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      sourceDocumentFileId: "source-file-1",
      sourcePdfHash: "a".repeat(64)
    },
    signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER
  });
  (harness.state.signers as Array<Record<string, unknown>>).splice(
    0,
    harness.state.signers.length,
    {
      deletedAt: null,
      documentType: ESignDocumentType.DELIVERY_HANDOVER,
      id: "stage2-customer",
      providerActionType: ESignProviderActionType.CUSTOMER_MANUAL_SIGN,
      providerTransactionId: "STAGE2CUSTOMERH1",
      required: true,
      signerStatus: ESignSignerStatus.SIGNED,
      signerType: ESignSignerType.CUSTOMER,
      slotId: ESignSlotId.STAGE2_HANDOVER_CUSTOMER,
      taskId: harness.state.task.id
    },
    {
      deletedAt: null,
      documentType: ESignDocumentType.DELIVERY_HANDOVER,
      id: "stage2-platform",
      providerActionType: ESignProviderActionType.PLATFORM_AUTO_SEAL,
      providerTransactionId: "STAGE2PLATFORMH2",
      required: true,
      signerStatus: ESignSignerStatus.SIGNED,
      signerType: ESignSignerType.PLATFORM,
      slotId: ESignSlotId.STAGE2_HANDOVER_PLATFORM,
      taskId: harness.state.task.id
    }
  );
  harness.state.handover = {
    archiveLastAttemptAt: null,
    archiveLastError: null,
    archiveRetryCount: 0,
    archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED,
    archivedAt: null,
    artifactVersion: 1,
    completedAt: harness.state.task.completedAt,
    deletedAt: null,
    handoverContractId: harness.state.contract.id,
    handoverESignTaskId: harness.state.task.id,
    id: "handover-1",
    manifestHash: "b".repeat(64),
    signedDocumentFileId: null,
    signedObjectKey: null,
    signedPdfHash: null,
    sourceDocumentFileId: "source-file-1",
    sourcePdfHash: "a".repeat(64),
    status: DeliveryHandoverStatus.SIGNED
  };
  return harness;
}

function matchesHandoverWhere(
  handover: FakeStage2Handover,
  where: Record<string, unknown>
) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) {
      return true;
    }
    if (expected && typeof expected === "object" && "in" in expected) {
      return (expected as { in: unknown[] }).in.includes(handover[key]);
    }
    return handover[key] === expected;
  });
}

function financeSnapshot(state: ReturnType<typeof createFixture>["state"]) {
  return JSON.parse(JSON.stringify(state.finance));
}

function minimalPdf() {
  return Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");
}

function adminUser(): RequestUser {
  return {
    id: "user-admin",
    menus: [],
    name: "Admin",
    permissions: ["contract:view", "contract:archive"],
    roles: ["admin"],
    username: "admin"
  };
}

function currentCustomer(customerId: string): CurrentCustomer {
  return {
    accountStatus: "ACTIVE",
    customerAccountId: customerId === "customer-1" ? "account-1" : "account-other",
    customerId,
    phone: "13800000000"
  } as CurrentCustomer;
}

interface FakeFileObject {
  bucket: string;
  id: string;
  mimeType: string;
  objectKey: string;
  originalName: string;
  sizeBytes: bigint;
  uploadedBy: string | null;
}

interface FakeStage2Handover extends Record<string, unknown> {
  archiveLastAttemptAt: Date | null;
  archiveLastError: string | null;
  archiveRetryCount: number;
  archiveStatus: DeliveryHandoverArchiveStatus;
  archivedAt: Date | null;
  artifactVersion: number;
  completedAt: Date | null;
  deletedAt: Date | null;
  handoverContractId: string;
  handoverESignTaskId: string;
  id: string;
  manifestHash: string;
  signedDocumentFileId: string | null;
  signedObjectKey: string | null;
  signedPdfHash: string | null;
  sourceDocumentFileId: string;
  sourcePdfHash: string;
  status: DeliveryHandoverStatus;
}
