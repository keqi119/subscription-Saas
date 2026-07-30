/* eslint-disable @typescript-eslint/no-explicit-any */
import { RequestMethod } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
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
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { AuthGuard } from "../src/auth/auth.guard";
import { PermissionsGuard } from "../src/auth/permissions.guard";
import { HandoverWorkOrderAdminController } from "../src/handover-work-order/handover-work-order.controller";
import { Stage2HandoverESignService } from "../src/handover-work-order/stage2-handover-esign.service";
import { Stage2HandoverWorkflowService } from "../src/handover-work-order/stage2-handover-workflow.service";

const NOW = new Date("2026-07-26T12:00:00.000Z");

describe("Stage 2 handover archive retry wiring", () => {
  it("invokes only the Stage 2 archive core and returns a safe refreshed status", async () => {
    const harness = createHarness();

    const result = await harness.service.retryArchive(
      "work-order-1",
      "admin-1"
    );

    expect(harness.archive.archiveSignedStage2Handover).toHaveBeenCalledWith({
      actorId: "admin-1",
      taskId: "stage2-task-1"
    });
    expect(result).toEqual({
      archiveLastAttemptAt: NOW,
      archiveLastError: null,
      archiveRetryCount: 2,
      archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
      archivedAt: NOW,
      available: true,
      completedAt: NOW,
      handoverId: "handover-1",
      retryAvailable: false,
      taskId: "stage2-task-1",
      workOrderId: "work-order-1"
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "objectKey",
      "bucket",
      "signUrl",
      "providerCustomer",
      "providerTask",
      "13800138000",
      "unsafe.example",
      "secret"
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
    expect(harness.prisma.subscriptionOrder.update).not.toHaveBeenCalled();
    expect(harness.prisma.vehicleDelivery.update).not.toHaveBeenCalled();
    expect(harness.prisma.leaseContract.create).not.toHaveBeenCalled();
  });

  it("rejects archive retry before the archive core when the current pointer is not a completed typed task", async () => {
    const harness = createHarness();
    harness.task.taskStatus = ESignTaskStatus.SIGNING;
    harness.task.completedAt = null;

    await expect(
      harness.service.retryArchive("work-order-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ARCHIVE_NOT_READY"
      })
    });

    expect(harness.archive.archiveSignedStage2Handover).not.toHaveBeenCalled();
  });

  it("exposes POST archive retry with DELIVERY_CONFIRM and existing Admin guards", () => {
    const prototype = HandoverWorkOrderAdminController.prototype as any;
    const handler = prototype.retryStage2Archive;

    expect(
      Reflect.getMetadata(GUARDS_METADATA, HandoverWorkOrderAdminController)
    ).toEqual([AuthGuard, PermissionsGuard]);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      "handover-work-orders/:id/esign/archive/retry"
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST
    );
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
      PermissionCode.DELIVERY_CONFIRM
    ]);
  });
});

describe("Stage 2 signed-PDF archive workflow", () => {
  it("archives idempotently under the deterministic task and artifact version identity", async () => {
    const harness = createArchiveWorkflowHarness();
    const job = archiveWorkflowJob();

    await expect(
      harness.service.handle(job)
    ).resolves.toEqual({
      kind: "COMPLETED",
      result: {
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        archived: true
      }
    });
    harness.archive.archiveSignedStage2Handover
      .mockResolvedValueOnce({
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        archived: false,
        skippedReason: "SIGNED_PDF_ALREADY_ARCHIVED"
      });
    await expect(
      harness.service.handle(job)
    ).resolves.toMatchObject({
      kind: "COMPLETED",
      result: {
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        archived: false
      }
    });

    expect(
      harness.archive.archiveSignedStage2Handover
    ).toHaveBeenNthCalledWith(1, {
      taskId: "stage2-task-1"
    });
    expect(
      harness.archive.archiveSignedStage2Handover
    ).toHaveBeenNthCalledWith(2, {
      taskId: "stage2-task-1"
    });
    expect(harness.downstream.vehicleDeliveryUpdate).not.toHaveBeenCalled();
    expect(harness.downstream.leaseCreate).not.toHaveBeenCalled();
    expect(harness.downstream.billingWrite).not.toHaveBeenCalled();
    expect(harness.downstream.paymentWrite).not.toHaveBeenCalled();
    expect(harness.downstream.accountingWrite).not.toHaveBeenCalled();
    expect(harness.downstream.depreciationWrite).not.toHaveBeenCalled();
  });

  it("rejects a stale archive job before downloading a signed PDF", async () => {
    const harness = createArchiveWorkflowHarness();

    await expect(
      harness.service.handle(
        archiveWorkflowJob({
          payload: {
            artifactVersion: 2
          }
        })
      )
    ).rejects.toThrow(
      "STAGE2_ARCHIVE_ARTIFACT_VERSION_INVALID"
    );
    expect(
      harness.archive.archiveSignedStage2Handover
    ).not.toHaveBeenCalled();
  });
});

function createHarness() {
  const customerSigner = makeSigner("CUSTOMER");
  const platformSigner = makeSigner("PLATFORM");
  const task = {
    cancelledAt: null,
    completedAt: NOW as Date | null,
    contractId: "contract-stage2-1",
    createdAt: NOW,
    customerId: "customer-1",
    deletedAt: null,
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    id: "stage2-task-1",
    orderId: "order-1",
    provider: ESignProviderType.FADADA,
    providerEnvelopeId: "provider-envelope-1",
    providerTaskId: "STAGE2CUSTOMERH1",
    requestSnapshot: {
      artifactVersion: 3,
      contractId: "contract-stage2-1",
      handoverId: "handover-1",
      manifestHash: "a".repeat(64),
      sourceDocumentFileId: "source-file-1",
      sourcePdfHash: "b".repeat(64)
    },
    signers: [customerSigner, platformSigner],
    signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
    taskNo: "ESGSTAGE2",
    taskStatus: ESignTaskStatus.COMPLETED as ESignTaskStatus,
    updatedAt: NOW
  };
  const handover = {
    archiveLastAttemptAt: null as Date | null,
    archiveLastError: null as string | null,
    archiveRetryCount: 1,
    archiveStatus: DeliveryHandoverArchiveStatus.FAILED,
    archivedAt: null as Date | null,
    artifactVersion: 3,
    completedAt: NOW,
    handoverContract: {
      contractSnapshot: {},
      contractTitle: "Delivery handover confirmation",
      createdAt: NOW,
      fileId: "source-file-1",
      id: "contract-stage2-1",
      status: ContractStatus.SIGNED,
      updatedAt: NOW
    },
    handoverContractId: "contract-stage2-1",
    handoverESignTask: task,
    handoverESignTaskId: task.id,
    id: "handover-1",
    manifestHash: "a".repeat(64),
    signedDocumentFileId: null as string | null,
    signedObjectKey: "private/signed.pdf",
    signedPdfHash: null as string | null,
    sourceDocumentFileId: "source-file-1",
    sourcePdfHash: "b".repeat(64),
    status: DeliveryHandoverStatus.SIGNED,
    updatedAt: NOW
  };
  const workOrder = {
    handover,
    handoverId: handover.id,
    id: "work-order-1",
    order: {
      customer: {
        id: "customer-1",
        mobile: "13800138000",
        name: "Customer"
      },
      customerId: "customer-1",
      id: "order-1",
      orderNo: "ORD-1"
    },
    orderId: "order-1"
  };
  const archive = {
    archiveSignedStage2Handover: vi.fn(async () => {
      Object.assign(handover, {
        archiveLastAttemptAt: NOW,
        archiveLastError: null,
        archiveRetryCount: 2,
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        archivedAt: NOW,
        signedDocumentFileId: "signed-file-1",
        signedObjectKey: "private/signed.pdf",
        signedPdfHash: "c".repeat(64),
        status: DeliveryHandoverStatus.ARCHIVED
      });
      return {
        archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
        archived: true,
        signedPdfHash: "c".repeat(64)
      };
    })
  };
  const prisma = {
    contractESignTask: {
      findFirst: vi.fn(async () => task)
    },
    leaseContract: {
      create: vi.fn()
    },
    subscriptionOrder: {
      update: vi.fn()
    },
    vehicleDelivery: {
      update: vi.fn()
    },
    vehicleHandoverWorkOrder: {
      findUnique: vi.fn(async () => workOrder)
    }
  };
  const provider = {
    autoSealTask: vi.fn(),
    createSignTask: vi.fn(),
    getSignerUrl: vi.fn(),
    verifyCallback: vi.fn()
  };
  const readiness = {
    assertReady: vi.fn(),
    getReadiness: vi.fn()
  };
  const service = new Stage2HandoverESignService(
    prisma as never,
    readiness as never,
    provider as never,
    new ConfigService(),
    archive as never
  );

  return {
    archive,
    handover,
    prisma,
    provider,
    service,
    task
  };
}

function createArchiveWorkflowHarness() {
  const downstream = {
    accountingWrite: vi.fn(),
    billingWrite: vi.fn(),
    depreciationWrite: vi.fn(),
    leaseCreate: vi.fn(),
    paymentWrite: vi.fn(),
    vehicleDeliveryUpdate: vi.fn()
  };
  const prisma = {
    accountingEntry: {
      create: downstream.accountingWrite
    },
    depreciationEntry: {
      create: downstream.depreciationWrite
    },
    leaseContract: {
      create: downstream.leaseCreate
    },
    paymentRecord: {
      create: downstream.paymentWrite
    },
    receivableBill: {
      create: downstream.billingWrite
    },
    vehicleDelivery: {
      update: downstream.vehicleDeliveryUpdate
    },
    vehicleHandoverWorkOrder: {
      findUnique: vi.fn(async () => ({
        handover: {
          artifactVersion: 3,
          handoverESignTaskId: "stage2-task-1",
          id: "handover-1"
        },
        handoverId: "handover-1",
        id: "work-order-1"
      }))
    }
  };
  const archive = {
    archiveSignedStage2Handover: vi.fn(async (): Promise<any> => ({
      archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
      archived: true
    }))
  };
  const repository = {
    renewLease: vi.fn(async () => true)
  };
  const service = new Stage2HandoverWorkflowService(
    prisma as never,
    new ConfigService({
      STAGE2_HANDOVER_WORKER_LEASE_MS: "120000",
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    }),
    repository as never,
    {} as never
  );
  Object.assign(service as object, {
    signedArtifactService: archive
  });
  return {
    archive,
    downstream,
    service
  };
}

function archiveWorkflowJob(
  overrides: Record<string, unknown> = {}
) {
  return {
    attemptCount: 0,
    availableAt: NOW,
    completedAt: null,
    createdAt: NOW,
    eSignTaskId: "stage2-task-1",
    handoverId: "handover-1",
    id: "archive-job-1",
    idempotencyKey: "archive:stage2-task-1:3",
    jobStatus: VehicleHandoverWorkflowJobStatus.PROCESSING,
    jobType: VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF,
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date(
      NOW.getTime() + 2 * 60 * 1000
    ),
    leaseToken: "00000000-0000-4000-8000-000000000001",
    maxAttempts: 5,
    payload: {
      artifactVersion: 3
    },
    resultSnapshot: null,
    startedAt: NOW,
    updatedAt: NOW,
    workOrderId: "work-order-1",
    ...overrides
  } as never;
}

function makeSigner(type: "CUSTOMER" | "PLATFORM") {
  const customer = type === "CUSTOMER";
  return {
    attemptCount: 1,
    claimExpiresAt: null,
    customerId: customer ? "customer-1" : null,
    deletedAt: null,
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    id: customer ? "stage2-customer-signer" : "stage2-platform-signer",
    lastAttemptAt: NOW,
    lastErrorCode: null,
    lastErrorMessage: null,
    nextRetryAt: null,
    providerActionType: customer
      ? ESignProviderActionType.CUSTOMER_MANUAL_SIGN
      : ESignProviderActionType.PLATFORM_AUTO_SEAL,
    providerTransactionId: customer
      ? "STAGE2CUSTOMERH1"
      : "STAGE2PLATFORMH2",
    required: true,
    signedAt: NOW,
    signerStatus: ESignSignerStatus.SIGNED,
    signerType: customer
      ? ESignSignerType.CUSTOMER
      : ESignSignerType.PLATFORM,
    slotId: customer
      ? ESignSlotId.STAGE2_HANDOVER_CUSTOMER
      : ESignSlotId.STAGE2_HANDOVER_PLATFORM,
    taskId: "stage2-task-1",
    updatedAt: NOW
  };
}
