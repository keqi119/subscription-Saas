/* eslint-disable @typescript-eslint/no-explicit-any */
import { RequestMethod } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import {
  AuditAction,
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
  OrderStatus,
  Prisma,
  UserStatus,
  VehicleHandoverOperatorType,
  VehicleHandoverWorkOrderStatus
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { beforeEach, describe, expect, it, vi } from "vitest";

const businessNumberMocks = vi.hoisted(() => ({
  createBusinessNo: vi.fn()
}));

vi.mock("../src/common/business-number", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/common/business-number")>();
  return {
    ...actual,
    createBusinessNo: businessNumberMocks.createBusinessNo
  };
});

import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { AuthGuard } from "../src/auth/auth.guard";
import { PermissionsGuard } from "../src/auth/permissions.guard";
import type {
  ESignProviderSignerStatusResult
} from "../src/esign/esign.provider";
import {
  HandoverWorkOrderAdminController,
  HandoverWorkOrderFieldController
} from "../src/handover-work-order/handover-work-order.controller";
import { StartAdminStage2ESignDto } from "../src/handover-work-order/handover-work-order.dto";
import {
  STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED,
  STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED,
  STAGE2_PLATFORM_SEAL_PROVIDER_FAILED,
  Stage2HandoverESignService
} from "../src/handover-work-order/stage2-handover-esign.service";
import type { Stage2HandoverESignReadiness } from "../src/handover-work-order/stage2-handover-esign-readiness.service";
import { PortalHandoverReviewController } from "../src/portal/portal-handover-review.controller";

const NOW = new Date("2026-07-26T08:00:00.000Z");
const CUSTOMER_SLOT = ESignSlotId.STAGE2_HANDOVER_CUSTOMER;
const PLATFORM_SLOT = ESignSlotId.STAGE2_HANDOVER_PLATFORM;

describe("Stage2HandoverESignService", () => {
  beforeEach(() => {
    vi.useRealTimers();
    businessNumberMocks.createBusinessNo.mockReset();
    businessNumberMocks.createBusinessNo.mockReturnValue(
      "ESG20260726080000ABCD"
    );
  });

  it("stops on readiness blockers without provider or persistence calls", async () => {
    const harness = createHarness();
    harness.readiness.assertReady.mockRejectedValueOnce(
      new Error("STAGE2_HANDOVER_ESIGN_NOT_READY")
    );

    await expect(
      harness.service.create("work-order-1", adminInitiator())
    ).rejects.toThrow("STAGE2_HANDOVER_ESIGN_NOT_READY");

    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
    expect(harness.prisma.vehicleDeliveryHandover.updateMany).not.toHaveBeenCalled();
    expect(harness.generatePdf).not.toHaveBeenCalled();
  });

  it("does not generate a missing PDF before readiness succeeds", async () => {
    const harness = createHarness();
    harness.readiness.assertReady.mockRejectedValueOnce(
      new Error("HANDOVER_SOURCE_NOT_GENERATED")
    );
    harness.state.workOrder.handover.sourceDocumentFileId = null;
    harness.state.workOrder.handover.handoverContract.fileId = null;

    await expect(
      harness.service.create("work-order-1", adminInitiator())
    ).rejects.toThrow("HANDOVER_SOURCE_NOT_GENERATED");

    expect(harness.generatePdf).not.toHaveBeenCalled();
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
  });

  it("creates one typed Stage 2 task and exactly two one-slot signer rows", async () => {
    const harness = createHarness();

    const result = await harness.service.create(
      "work-order-1",
      adminInitiator()
    );

    expect(harness.prisma.contractESignTask.create).toHaveBeenCalledTimes(1);
    const createData =
      (harness.prisma.contractESignTask.create.mock.calls[0]?.[0] as any).data;
    expect(createData).toMatchObject({
      contractId: "contract-stage2-1",
      customerId: "customer-1",
      documentType: ESignDocumentType.DELIVERY_HANDOVER,
      orderId: "order-1",
      signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
      taskStatus: ESignTaskStatus.CREATED
    });
    expect(createData.requestSnapshot).toMatchObject({
      artifactVersion: 3,
      contractId: "contract-stage2-1",
      handoverId: "handover-1",
      sourceDocumentFileId: "file-stage2-1"
    });
    expect(createData.signers.create).toEqual([
      expect.objectContaining({
        customerId: "customer-1",
        documentType: ESignDocumentType.DELIVERY_HANDOVER,
        providerActionType: ESignProviderActionType.CUSTOMER_MANUAL_SIGN,
        required: true,
        signerType: ESignSignerType.CUSTOMER,
        slotId: CUSTOMER_SLOT
      }),
      expect.objectContaining({
        documentType: ESignDocumentType.DELIVERY_HANDOVER,
        providerActionType: ESignProviderActionType.PLATFORM_AUTO_SEAL,
        required: true,
        signerType: ESignSignerType.PLATFORM,
        slotId: PLATFORM_SLOT
      })
    ]);
    expect(createData.signers.create).toHaveLength(2);
    expect(result).toMatchObject({
      documentType: ESignDocumentType.DELIVERY_HANDOVER,
      signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
      status: ESignTaskStatus.WAITING_CUSTOMER,
      taskId: "stage2-task-1"
    });
  });

  it("records the Field session, canonical identity, artifact version, hash, and timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });

    await harness.service.create(
      "work-order-1",
      fieldInitiator(),
      fieldReview()
    );

    const createData =
      (harness.prisma.contractESignTask.create.mock.calls[0]?.[0] as any).data;
    expect(createData.createdBy).toBeNull();
    expect(createData.updatedBy).toBeNull();
    expect(createData.requestSnapshot).toMatchObject({
      initiator: {
        actorType: "FIELD_OPERATOR",
        fieldOperatorPhone: "13800000000",
        fieldOperatorSessionId: "field-session-1"
      },
      reviewAcknowledgement: {
        acknowledgement: true,
        artifactVersion: 3,
        reviewedAt: NOW.toISOString(),
        sourcePdfHash: "b".repeat(64)
      }
    });
    expect(harness.workflow.enqueueCustomerESignJobs).toHaveBeenCalledWith(
      harness.prisma,
      {
        customerTransactionId: "ESG20260726080000ABCDH1",
        eSignTaskId: "stage2-task-1",
        handoverId: "handover-1",
        initiatedAt: NOW,
        workOrderId: "work-order-1"
      }
    );
    expect(
      (harness.prisma.vehicleDeliveryHandover.updateMany.mock.calls as any[])
        .flatMap(([input]) => [input.data.updatedBy])
        .filter((value) => value !== undefined)
    ).toEqual([null, null]);
  });

  it("rejects an artifact swap between Field acknowledgement and the creation reload", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.readiness.assertReady.mockImplementationOnce(async () => {
      swapStage2SourceArtifact(harness, {
        artifactVersion: 4,
        fileId: "file-stage2-2",
        manifestHash: "d".repeat(64),
        sourceObjectKey: "private/stage2/source-2.pdf",
        sourcePdfHash: "c".repeat(64)
      });
      return {
        blockers: [],
        ready: true,
        state: {
          esignTaskId: null,
          esignTaskStatus: null,
          handoverContractId: "contract-stage2-1",
          handoverId: "handover-1",
          handoverStatus: DeliveryHandoverStatus.SOURCE_GENERATED,
          orderId: "order-1",
          orderStatus: "PENDING_DELIVERY",
          workOrderId: "work-order-1",
          workOrderStatus: "CUSTOMER_CONFIRMED"
        }
      };
    });

    await expect(
      harness.service.create(
        "work-order-1",
        fieldInitiator(),
        fieldReview()
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_FIELD_REVIEW_STALE"
      })
    });
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
  });

  it("revalidates complete readiness after locking and before reserving a task", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.failTransactionalReadiness(
      new Error("CUSTOMER_OBJECTION_ACTIVE")
    );

    await expect(
      harness.service.create(
        "work-order-1",
        fieldInitiator(),
        fieldReview()
      )
    ).rejects.toThrow("CUSTOMER_OBJECTION_ACTIVE");

    expect(harness.readiness.assertReady).toHaveBeenCalledTimes(2);
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.state.activeTask).toBeNull();
  });

  it("rejects a source-binding swap at the transactional handover claim", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    const createTask =
      harness.prisma.contractESignTask.create.getMockImplementation();
    harness.prisma.contractESignTask.create.mockImplementationOnce(
      async (input: unknown) => {
        const task = await createTask!(input);
        harness.state.workOrder.handover.sourcePdfHash = "c".repeat(64);
        return task;
      }
    );

    await expect(
      harness.service.create(
        "work-order-1",
        fieldInitiator(),
        fieldReview()
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_FIELD_REVIEW_STALE"
      })
    });
    expect(
      harness.prisma.vehicleDeliveryHandover.updateMany
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          artifactVersion: 3,
          handoverContractId: "contract-stage2-1",
          manifestHash: "a".repeat(64),
          sourceDocumentFileId: "file-stage2-1",
          sourceObjectKey: "private/stage2/source-1.pdf",
          sourcePdfHash: "b".repeat(64)
        })
      })
    );
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
  });

  it("rejects a source contract that stops being generated before the transactional reservation", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.readiness.assertReady.mockImplementationOnce(async () => {
      harness.state.workOrder.handover.handoverContract.status =
        ContractStatus.SIGNING;
      return {
        blockers: [],
        ready: true,
        state: {
          esignTaskId: null,
          esignTaskStatus: null,
          handoverContractId: "contract-stage2-1",
          handoverId: "handover-1",
          handoverStatus:
            DeliveryHandoverStatus.SOURCE_GENERATED,
          orderId: "order-1",
          orderStatus: "PENDING_DELIVERY",
          workOrderId: "work-order-1",
          workOrderStatus: "CUSTOMER_CONFIRMED"
        }
      };
    });

    await expect(
      harness.service.create(
        "work-order-1",
        fieldInitiator(),
        fieldReview()
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_SOURCE_INVALID"
      })
    });
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
  });

  it("does not enqueue customer work when provider-backed initiation fails", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.provider.createSignTask.mockRejectedValueOnce(
      new Error("provider unavailable")
    );

    await expect(
      harness.service.create(
        "work-order-1",
        fieldInitiator(),
        fieldReview()
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_PROVIDER_FAILED"
      })
    });
    expect(harness.workflow.enqueueCustomerESignJobs).not.toHaveBeenCalled();
  });

  it("keeps legacy Admin initiation compatible when the workflow is disabled", async () => {
    const compatibility = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "false"
    });
    await expect(
      compatibility.service.create("work-order-1", adminInitiator())
    ).resolves.toMatchObject({ taskId: "stage2-task-1" });
  });

  it("denies Admin fallback before 15 minutes when the assigned Field identity is available", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.setDatabaseTime(
      new Date(NOW.getTime() + 15 * 60 * 1000 - 1)
    );

    await expect(
      harness.service.getStatus("work-order-1")
    ).resolves.toMatchObject({
      canAdminInitiate: false,
      sourceArtifact: {
        artifactVersion: 3,
        sourcePdfHash: "b".repeat(64)
      }
    });
    await expect(
      harness.service.create(
        "work-order-1",
        adminFallbackInitiator(),
        adminFallbackReview()
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ADMIN_FALLBACK_NOT_ELIGIBLE"
      })
    });
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.auditLogs).toEqual([]);
  });

  it("allows Admin fallback at exactly 15 minutes using database time, independent of the process clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.setDatabaseTime(
      new Date(NOW.getTime() + 15 * 60 * 1000)
    );

    await expect(
      harness.service.getStatus("work-order-1")
    ).resolves.toMatchObject({
      canAdminInitiate: true,
      canReconcileCustomer: false,
      sourceArtifact: {
        artifactVersion: 3,
        sourcePdfHash: "b".repeat(64)
      }
    });
    const result = await harness.service.create(
      "work-order-1",
      adminFallbackInitiator(),
      adminFallbackReview()
    );

    expect(result).toMatchObject({
      canAdminInitiate: false,
      taskId: "stage2-task-1"
    });
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
    expect(
      harness.prisma.$transaction.mock.calls.some(
        ([, options]: [unknown, { isolationLevel?: string }?]) =>
          options?.isolationLevel === "Serializable"
      )
    ).toBe(true);
    expect(harness.prisma.$queryRaw).toHaveBeenCalled();
    expect(harness.auditLogs).toEqual([
      expect.objectContaining({
        action: AuditAction.CREATE,
        afterSnapshot: expect.objectContaining({
          actorType: "ADMIN_FALLBACK",
          artifactVersion: 3,
          eligibilityReason: "FIELD_STALLED_15_MINUTES",
          reason: "Field 经办人超过十五分钟未推进",
          sourceDocumentFileId: "file-stage2-1",
          taskId: "stage2-task-1"
        }),
        entityId: "work-order-1",
        entityType: "VehicleHandoverWorkOrder",
        module: "stage2-handover-esign",
        operatorId: "admin-1"
      })
    ]);
  });

  it("starts the 15-minute Admin fallback window when the bound source PDF file is finalized", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.state.workOrder.handover.handoverContract.createdAt = new Date(
      NOW.getTime() - 60 * 60 * 1000
    );
    harness.setSourceFileCreatedAt(NOW);
    harness.setDatabaseTime(
      new Date(NOW.getTime() + 15 * 60 * 1000 - 1)
    );

    await expect(
      harness.service.getStatus("work-order-1")
    ).resolves.toMatchObject({
      canAdminInitiate: false,
      sourceArtifact: {
        createdAt: NOW
      }
    });
    await expect(
      harness.service.create(
        "work-order-1",
        adminFallbackInitiator(),
        adminFallbackReview()
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ADMIN_FALLBACK_NOT_ELIGIBLE"
      })
    });
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
  });

  it("allows immediate Admin fallback when the assigned Field identity is technically unavailable", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.prisma.user.findFirst.mockResolvedValue(null);
    harness.setDatabaseTime(NOW);

    await expect(
      harness.service.getStatus("work-order-1")
    ).resolves.toMatchObject({
      canAdminInitiate: true
    });
    await expect(
      harness.service.create(
        "work-order-1",
        adminFallbackInitiator(),
        adminFallbackReview({
          reason: "Field 经办人账号已停用，后台接续处理"
        })
      )
    ).resolves.toMatchObject({
      taskId: "stage2-task-1"
    });
    expect(harness.auditLogs[0]).toMatchObject({
      afterSnapshot: expect.objectContaining({
        eligibilityReason: "FIELD_IDENTITY_UNAVAILABLE"
      })
    });
  });

  it("retries a real PostgreSQL serializable conflict without duplicating the Admin fallback audit", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.prisma.user.findFirst.mockResolvedValue(null);
    const runTransaction =
      harness.prisma.$transaction.getMockImplementation()!;
    harness.prisma.$transaction
      .mockRejectedValueOnce({ code: "P2034" })
      .mockImplementation(runTransaction);

    await expect(
      harness.service.create(
        "work-order-1",
        adminFallbackInitiator(),
        adminFallbackReview()
      )
    ).resolves.toMatchObject({
      taskId: "stage2-task-1"
    });

    expect(harness.auditLogs).toHaveLength(1);
    expect(harness.prisma.contractESignTask.create).toHaveBeenCalledTimes(
      1
    );
  });

  it("maps exhausted serializable conflicts to a stable claimed response", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.prisma.user.findFirst.mockResolvedValue(null);
    harness.prisma.$transaction.mockRejectedValue({
      code: "P2034"
    });

    await expect(
      harness.service.create(
        "work-order-1",
        adminFallbackInitiator(),
        adminFallbackReview()
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED
      })
    });
    expect(harness.auditLogs).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["too short", "ab"],
    ["too long", "a".repeat(501)],
    ["whitespace only", "   "]
  ])("rejects an Admin fallback reason that is %s", async (
    _label,
    reason
  ) => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      harness.service.create(
        "work-order-1",
        adminFallbackInitiator(),
        adminFallbackReview({ reason })
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ADMIN_FALLBACK_REASON_INVALID"
      })
    });
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
  });

  it("validates the Admin fallback reason after whitespace normalization", async () => {
    const valid = plainToInstance(StartAdminStage2ESignDto, {
      acknowledgement: true,
      artifactVersion: 3,
      reason: `  ${"a".repeat(500)}  `,
      sourcePdfHash: "b".repeat(64)
    });
    const invalid = plainToInstance(StartAdminStage2ESignDto, {
      acknowledgement: true,
      artifactVersion: 3,
      reason: "  a  ",
      sourcePdfHash: "b".repeat(64)
    });

    expect(valid.reason).toHaveLength(500);
    await expect(validate(valid)).resolves.toEqual([]);
    expect((await validate(invalid)).map((error) => error.property)).toContain(
      "reason"
    );
  });

  it.each([
    ["artifact version", { artifactVersion: 4 }],
    ["source PDF hash", { sourcePdfHash: "c".repeat(64) }],
    ["acknowledgement", { acknowledgement: false }]
  ])("rejects stale Admin fallback %s acknowledgement", async (
    _label,
    override
  ) => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      harness.service.create(
        "work-order-1",
        adminFallbackInitiator(),
        adminFallbackReview(override as never)
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ADMIN_REVIEW_STALE"
      })
    });
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
  });

  it("denies Admin fallback when an orphan terminal task retains provider evidence", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.prisma.user.findFirst.mockResolvedValue(null);
    harness.state.activeTask = makeTask({
      taskStatus: ESignTaskStatus.FAILED
    });

    await expect(
      harness.service.getStatus("work-order-1")
    ).resolves.toMatchObject({
      canAdminInitiate: false
    });
    await expect(
      harness.service.create(
        "work-order-1",
        adminFallbackInitiator(),
        adminFallbackReview()
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED
      })
    });
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
  });

  it.each([
    ["rejected", ESignSignerStatus.REJECTED],
    ["failed", ESignSignerStatus.EXPIRED]
  ])("does not expose void or reconcile for a terminal H1 %s state with provider evidence", async (
    _label,
    customerStatus
  ) => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    const task = makeTask({
      customerStatus,
      taskStatus: ESignTaskStatus.FAILED
    });
    harness.state.activeTask = task;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status = DeliveryHandoverStatus.FAILED;

    await expect(
      harness.service.getStatus("work-order-1")
    ).resolves.toMatchObject({
      canAdminInitiate: false,
      canReconcileCustomer: false,
      canVoid: false,
      rebuildRequired: true
    });
  });

  it("exposes reconcile only for the canonical active H1 state", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    const task = makeTask({
      customerStatus: ESignSignerStatus.SIGNING,
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });
    attachPortalTask(harness, task);
    harness.state.workOrder.status =
      VehicleHandoverWorkOrderStatus.SIGNING;

    await expect(
      harness.service.getStatus("work-order-1")
    ).resolves.toMatchObject({
      canAdminInitiate: false,
      canReconcileCustomer: true
    });
  });

  it("exposes no void, reconcile, or Admin initiation after provider completion", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    const task = makeTask({
      customerStatus: ESignSignerStatus.SIGNED,
      platformStatus: ESignSignerStatus.SIGNED,
      taskStatus: ESignTaskStatus.COMPLETED
    });
    task.completedAt = NOW;
    harness.state.activeTask = task;
    harness.state.workOrder.handover.handoverContract.status =
      ContractStatus.SIGNED;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status = DeliveryHandoverStatus.SIGNED;

    await expect(
      harness.service.getStatus("work-order-1")
    ).resolves.toMatchObject({
      canAdminInitiate: false,
      canReconcileCustomer: false,
      canVoid: false
    });
  });

  it("generates a new task number when a P2002 create collision is retried", async () => {
    const harness = createHarness();
    businessNumberMocks.createBusinessNo
      .mockReturnValueOnce("ESG20260726080000AAAA")
      .mockReturnValueOnce("ESG20260726080000BBBB");
    harness.prisma.contractESignTask.create.mockRejectedValueOnce(
      Object.assign(new Error("task number collision"), { code: "P2002" })
    );

    await harness.service.create("work-order-1", adminInitiator());

    expect(
      harness.prisma.contractESignTask.create.mock.calls.map(
        ([input]: any[]) => input.data.taskNo
      )
    ).toEqual([
      "ESG20260726080000AAAA",
      "ESG20260726080000BBBB"
    ]);
    expect(businessNumberMocks.createBusinessNo).toHaveBeenCalledTimes(2);
  });

  it("passes exactly the persisted customer slot and coordinate to provider create", async () => {
    const harness = createHarness();

    await harness.service.create("work-order-1", adminInitiator());

    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
    const providerInput =
      (harness.provider.createSignTask.mock.calls as any[][])[0]?.[0];
    expect(providerInput).toMatchObject({
      contractId: "contract-stage2-1",
      documentType: "DELIVERY_HANDOVER",
      sourcePdfHash: "b".repeat(64),
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: "stage2-task-1",
      transactionId: "ESG20260726080000ABCDH1"
    });
    expect(providerInput.signingSlots).toEqual([
      expect.objectContaining({
        documentType: "DELIVERY_HANDOVER",
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        signerRole: "CUSTOMER",
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        slotId: "STAGE2_HANDOVER_CUSTOMER"
      })
    ]);
    expect(providerInput.signingSlotCoordinates).toEqual([
      {
        pageNumber: 3,
        slotId: "STAGE2_HANDOVER_CUSTOMER",
        x: 220,
        y: 980
      }
    ]);
  });

  it("persists the deterministic customer transaction and fresh claim before calling the provider", async () => {
    const harness = createHarness();
    let observed: Record<string, unknown> | undefined;
    harness.provider.createSignTask.mockImplementationOnce(async (input: any) => {
      const task = harness.state.workOrder.handover.handoverESignTask!;
      const customerSigner = task.signers[0]!;
      observed = {
        attemptCount: customerSigner.attemptCount,
        claimExpiresAt: customerSigner.claimExpiresAt,
        providerTaskId: task.providerTaskId,
        providerTransactionId: customerSigner.providerTransactionId,
        taskStatus: task.taskStatus,
        transactionId: input.transactionId
      };
      return {
        actions: [{
          coveredSlotIds: ["STAGE2_HANDOVER_CUSTOMER"],
          providerActionType: "CUSTOMER_MANUAL_SIGN",
          providerSignerId: input.transactionId,
          providerTransactionId: input.transactionId,
          signUrl: "https://unsafe.example/sign",
          signerType: "CUSTOMER",
          signingStage: "STAGE2_DELIVERY_HANDOVER"
        }],
        providerEnvelopeId: task.taskNo,
        providerTaskId: input.transactionId
      };
    });

    await harness.service.create("work-order-1", adminInitiator());

    expect(observed).toMatchObject({
      attemptCount: 1,
      providerTaskId: "ESG20260726080000ABCDH1",
      providerTransactionId: "ESG20260726080000ABCDH1",
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER,
      transactionId: "ESG20260726080000ABCDH1"
    });
    expect(observed?.claimExpiresAt).toBeInstanceOf(Date);
  });

  it("accepts an early customer callback reconciled against the preclaimed transaction", async () => {
    const harness = createHarness();
    harness.provider.createSignTask.mockImplementationOnce(async (input: any) => {
      const handover = harness.state.workOrder.handover;
      const task = handover.handoverESignTask!;
      const customerSigner = task.signers[0]!;
      customerSigner.claimExpiresAt = null;
      customerSigner.providerSignerId = input.transactionId;
      customerSigner.providerTransactionId = input.transactionId;
      customerSigner.signedAt = NOW;
      customerSigner.signerStatus = ESignSignerStatus.SIGNED;
      task.taskStatus = ESignTaskStatus.SIGNING;
      handover.status = DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;
      return {
        actions: [{
          coveredSlotIds: ["STAGE2_HANDOVER_CUSTOMER"],
          providerActionType: "CUSTOMER_MANUAL_SIGN",
          providerSignerId: input.transactionId,
          providerTransactionId: input.transactionId,
          signerType: "CUSTOMER",
          signingStage: "STAGE2_DELIVERY_HANDOVER"
        }],
        providerEnvelopeId: task.taskNo,
        providerTaskId: input.transactionId
      };
    });

    const result = await harness.service.create(
      "work-order-1",
      adminInitiator()
    );

    expect(result.customerSigner.status).toBe(ESignSignerStatus.SIGNED);
    expect(result.status).toBe(ESignTaskStatus.SIGNING);
    expect(harness.state.workOrder.handover.status).toBe(
      DeliveryHandoverStatus.PENDING_PLATFORM_SEAL
    );
  });

  it("finalizes a callback-reconciled customer action with both customer jobs", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.provider.createSignTask.mockImplementationOnce(async (input: any) => {
      const handover = harness.state.workOrder.handover;
      const task = handover.handoverESignTask!;
      const customerSigner = task.signers[0]!;
      customerSigner.claimExpiresAt = null;
      customerSigner.providerSignerId = input.transactionId;
      customerSigner.providerTransactionId = input.transactionId;
      customerSigner.signedAt = NOW;
      customerSigner.signerStatus = ESignSignerStatus.SIGNED;
      task.taskStatus = ESignTaskStatus.SIGNING;
      handover.status = DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;
      return {
        actions: [{
          coveredSlotIds: ["STAGE2_HANDOVER_CUSTOMER"],
          providerActionType: "CUSTOMER_MANUAL_SIGN",
          providerSignerId: input.transactionId,
          providerTransactionId: input.transactionId,
          signerType: "CUSTOMER",
          signingStage: "STAGE2_DELIVERY_HANDOVER"
        }],
        providerEnvelopeId: task.taskNo,
        providerTaskId: input.transactionId
      };
    });

    const result = await harness.service.create(
      "work-order-1",
      fieldInitiator(),
      fieldReview()
    );

    expect(result.customerSigner.status).toBe(ESignSignerStatus.SIGNED);
    expectCustomerWorkflowJobs(harness);
    expect(harness.workflow.enqueueCustomerESignJobs).toHaveBeenCalledTimes(1);
  });

  it("recovers an accepted provider result after local finalization failures", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.failCustomerJobEnqueues(2);

    await expect(
      harness.service.create(
        "work-order-1",
        fieldInitiator(),
        fieldReview()
      )
    ).rejects.toBeDefined();

    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
    expect(harness.customerJobs).toEqual(new Map([
      [
        "customer-reconcile:stage2-task-1:ESG20260726080000ABCDH1",
        "RECONCILE_CUSTOMER_SIGNATURE"
      ]
    ]));

    const retried = await harness.service.create(
      "work-order-1",
      fieldInitiator(),
      fieldReview()
    );

    expect(retried.taskId).toBe("stage2-task-1");
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
    expectCustomerWorkflowJobs(harness);
  });

  it("recovers an accepted provider action from its durable claim job after a hard interruption", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    const updateSigner =
      harness.prisma.contractESignSigner.updateMany.getMockImplementation()!;
    let finalizationInterruptions = 2;
    harness.prisma.contractESignSigner.updateMany.mockImplementation(
      async (input: any) => {
        if (
          input.data?.claimExpiresAt === null &&
          input.data?.providerSignerId &&
          finalizationInterruptions > 0
        ) {
          finalizationInterruptions -= 1;
          throw new Error(
            "simulated accepted-result finalization interruption"
          );
        }
        return updateSigner(input);
      }
    );
    const updateTask =
      harness.prisma.contractESignTask.updateMany.getMockImplementation()!;
    harness.prisma.contractESignTask.updateMany.mockImplementation(
      async (input: any) => {
        if (
          input.data?.errorSnapshot?.code ===
          "STAGE2_CUSTOMER_ACCEPTED_RESULT_PENDING"
        ) {
          throw new Error(
            "simulated abrupt process interruption before marker persistence"
          );
        }
        return updateTask(input);
      }
    );

    await expect(
      harness.service.create(
        "work-order-1",
        fieldInitiator(),
        fieldReview()
      )
    ).rejects.toThrow(
      "simulated abrupt process interruption before marker persistence"
    );

    const task = harness.state.workOrder.handover.handoverESignTask!;
    const customerSigner = task.signers[0]!;
    expect(task).toMatchObject({
      errorSnapshot: null,
      providerEnvelopeId: task.taskNo,
      providerTaskId: "ESG20260726080000ABCDH1",
      responseSnapshot: null,
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });
    expect(customerSigner).toMatchObject({
      claimExpiresAt: expect.any(Date),
      lastErrorCode: null,
      providerTransactionId: "ESG20260726080000ABCDH1",
      signerStatus: ESignSignerStatus.PENDING
    });
    expect(customerSigner.providerSignerId ?? null).toBeNull();
    expect(harness.customerJobs).toEqual(new Map([
      [
        "customer-reconcile:stage2-task-1:ESG20260726080000ABCDH1",
        "RECONCILE_CUSTOMER_SIGNATURE"
      ]
    ]));
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
    expect(
      harness.workflow.enqueueCustomerAcceptanceRecovery
    ).toHaveBeenCalledTimes(1);

    harness.provider.querySignerStatus.mockResolvedValueOnce({
      resultCode: "1000",
      resultDescription: "active",
      status: "SIGNING"
    });
    const recovered = await harness.service.reconcileCustomerSignature({
      eSignTaskId: task.id,
      providerTransactionId: "ESG20260726080000ABCDH1",
      workOrderId: "work-order-1"
    });

    expect(recovered.status).toBe("SIGNING");
    expect(harness.provider.querySignerStatus).toHaveBeenCalledWith({
      contractId: task.taskNo,
      providerCustomerId: "fadada-customer-1",
      providerTaskId: "ESG20260726080000ABCDH1",
      providerTransactionId: "ESG20260726080000ABCDH1",
      signerId: customerSigner.id,
      slotId: "STAGE2_HANDOVER_CUSTOMER",
      taskId: task.id
    });
    expect(harness.provider.getSignerUrl).not.toHaveBeenCalled();
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
    expectCustomerWorkflowJobs(harness);
    expect(customerSigner).toMatchObject({
      claimExpiresAt: null,
      providerSignerId: "ESG20260726080000ABCDH1",
      signUrl: null,
      signerStatus: ESignSignerStatus.SIGNING
    });
    expect(JSON.stringify(task.errorSnapshot)).not.toContain(
      "acceptedCustomerProviderResult"
    );
    expect(JSON.stringify(task.responseSnapshot)).not.toMatch(/signUrl/i);
    expectCustomerWorkflowJobs(harness);
  });

  it("fails closed without customer jobs when an abandoned durable claim cannot establish provider acceptance", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    const task = makeTask({
      customerStatus: ESignSignerStatus.PENDING,
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });
    const customerSigner = task.signers[0]!;
    task.errorSnapshot = null;
    task.providerEnvelopeId = task.taskNo;
    task.responseSnapshot = null;
    customerSigner.claimExpiresAt = new Date(Date.now() - 60_000);
    customerSigner.providerSignerId = null;
    customerSigner.signUrl = null;
    customerSigner.signUrlExpiresAt = null;
    attachPortalTask(harness, task);
    harness.provider.querySignerStatus.mockResolvedValueOnce({
      status: "UNKNOWN"
    });

    await expect(
      harness.service.create(
        "work-order-1",
        fieldInitiator(),
        fieldReview()
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code:
          "STAGE2_HANDOVER_ESIGN_PROVIDER_ACCEPTANCE_UNCONFIRMED"
      })
    });

    expect(harness.provider.querySignerStatus).toHaveBeenCalledTimes(1);
    expect(harness.provider.getSignerUrl).not.toHaveBeenCalled();
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.workflow.enqueueCustomerESignJobs).not.toHaveBeenCalled();
    expect(harness.customerJobs.size).toBe(0);
    expect(customerSigner.claimExpiresAt).not.toBeNull();
    expect(task.errorSnapshot).toBeNull();
  });

  it("does not finalize a fresh in-flight claim from a synthesized signer URL", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    const providerCreate =
      harness.provider.createSignTask.getMockImplementation()!;
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerStarted!: () => void;
    const providerStart = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    harness.provider.createSignTask.mockImplementationOnce(
      async (input: unknown) => {
        providerStarted();
        await providerRelease;
        return providerCreate(input);
      }
    );
    harness.provider.getSignerUrl.mockResolvedValue({
      expiresAt: new Date(Date.now() + 30 * 60_000),
      signUrl: "https://unsafe.example/synthesized-sign?token=secret"
    });
    harness.provider.querySignerStatus.mockResolvedValue({
      status: "UNKNOWN"
    });

    const winnerPromise = harness.service.create(
      "work-order-1",
      fieldInitiator(),
      fieldReview()
    );
    await providerStart;
    const task = harness.state.workOrder.handover.handoverESignTask!;
    const customerSigner = task.signers[0]!;

    const overlapping = await harness.service.create(
      "work-order-1",
      fieldInitiator(),
      fieldReview()
    );

    expect(overlapping).toMatchObject({
      finalizationPending: true,
      taskId: task.id
    });
    expect(customerSigner.claimExpiresAt).toEqual(expect.any(Date));
    expect(customerSigner.signerStatus).toBe(ESignSignerStatus.PENDING);
    expect(harness.provider.querySignerStatus).not.toHaveBeenCalled();
    expect(harness.provider.getSignerUrl).not.toHaveBeenCalled();
    expect(harness.workflow.enqueueCustomerESignJobs).not.toHaveBeenCalled();
    expect(harness.customerJobs).toEqual(new Map([
      [
        "customer-reconcile:stage2-task-1:ESG20260726080000ABCDH1",
        "RECONCILE_CUSTOMER_SIGNATURE"
      ]
    ]));

    releaseProvider();
    const winner = await winnerPromise;
    expect(winner.taskId).toBe(task.id);
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
    expectCustomerWorkflowJobs(harness);
  });

  it("keeps an ambiguous customer provider result recoverable under its fresh claim", async () => {
    const harness = createHarness();
    harness.provider.createSignTask.mockRejectedValueOnce(
      new Error("provider response timed out")
    );

    await expect(
      harness.service.create("work-order-1", adminInitiator())
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_PROVIDER_FAILED"
      })
    });

    const task = harness.state.workOrder.handover.handoverESignTask!;
    expect(task.taskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(task.failedAt).toBeNull();
    expect(task.signers[0]).toMatchObject({
      claimExpiresAt: expect.any(Date),
      lastErrorCode: "STAGE2_HANDOVER_ESIGN_PROVIDER_RESULT_AMBIGUOUS",
      nextRetryAt: expect.any(Date),
      providerTransactionId: "ESG20260726080000ABCDH1",
      signerStatus: ESignSignerStatus.PENDING
    });
    expect(harness.state.workOrder.handover.status).toBe(
      DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE
    );
  });

  it("rejects void while a required provider action has a fresh claim", async () => {
    const harness = createHarness();
    const task = makeTask({ taskStatus: ESignTaskStatus.WAITING_CUSTOMER });
    task.signers[0]!.claimExpiresAt = new Date(Date.now() + 60_000);
    harness.state.workOrder.handover.handoverContract.status =
      ContractStatus.SIGNING;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE;

    await expect(
      harness.service.voidTask(
        "work-order-1",
        "admin-1",
        "Do not race an in-flight provider action"
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED
      })
    });
    expect(task.taskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(harness.state.workOrder.handover.handoverESignTaskId).toBe(task.id);
  });

  it("rejects void after the customer provider action is accepted", async () => {
    const harness = createHarness();

    await harness.service.create("work-order-1", adminInitiator());
    const task = harness.state.workOrder.handover.handoverESignTask!;

    expect(task.signers[0]).toMatchObject({
      claimExpiresAt: null,
      providerTransactionId: "ESG20260726080000ABCDH1",
      signerStatus: ESignSignerStatus.SIGNING
    });
    await expect(
      harness.service.voidTask(
        "work-order-1",
        "admin-1",
        "Accepted provider action must remain correlated"
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED
      })
    });
    expect(task.taskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(harness.state.workOrder.handover.handoverESignTaskId).toBe(task.id);
  });

  it("ignores a Stage 2 URL in the provider create response instead of persisting it", async () => {
    const harness = createHarness();
    harness.provider.createSignTask.mockImplementationOnce(async (input: any) => ({
      actions: [{
        coveredSlotIds: ["STAGE2_HANDOVER_CUSTOMER"],
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerTransactionId: input.transactionId,
        signUrl: "javascript:alert(1)",
        signerType: "CUSTOMER",
        signingStage: "STAGE2_DELIVERY_HANDOVER"
      }],
      providerEnvelopeId: "provider-envelope-1",
      providerTaskId: input.transactionId
    }));

    await expect(
      harness.service.create("work-order-1", adminInitiator())
    ).resolves.toMatchObject({
      finalizationPending: false,
      taskId: "stage2-task-1"
    });

    expect(
      harness.state.workOrder.handover.handoverESignTask?.signers[0]?.signUrl
    ).toBeNull();
    expect(
      JSON.stringify(
        harness.state.workOrder.handover.handoverESignTask?.responseSnapshot
      )
    ).not.toMatch(/javascript|signUrl/i);
  });

  it("persists the customer provider transaction only on the typed Stage 2 signer", async () => {
    const harness = createHarness();

    await harness.service.create("work-order-1", adminInitiator());

    expect(harness.prisma.contractESignSigner.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerTransactionId: "ESG20260726080000ABCDH1",
          claimExpiresAt: expect.any(Date)
        }),
        where: expect.objectContaining({ id: "stage2-customer-signer-1" })
      })
    );
    expect(harness.prisma.contractESignSigner.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "stage1-signer-1" })
      })
    );
    expect(harness.prisma.contractESignSigner.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "stage2-platform-signer-1" })
      })
    );
  });

  it("does not revive a task voided while customer provider creation is in flight", async () => {
    const harness = createHarness();
    harness.provider.createSignTask.mockImplementationOnce(async (): Promise<any> => {
      const task = harness.state.workOrder.handover.handoverESignTask!;
      task.taskStatus = ESignTaskStatus.CANCELLED;
      harness.state.workOrder.handover.handoverESignTaskId = null;
      harness.state.workOrder.handover.handoverContract.status =
        ContractStatus.GENERATED;
      harness.state.workOrder.handover.status =
        DeliveryHandoverStatus.SOURCE_GENERATED;
      return {
        actions: [{
          coveredSlotIds: ["STAGE2_HANDOVER_CUSTOMER"],
          providerActionType: "CUSTOMER_MANUAL_SIGN",
          providerSignerId: "ESG20260726080000ABCDH1",
          providerTransactionId: "ESG20260726080000ABCDH1",
          signerType: "CUSTOMER",
          signingStage: "STAGE2_DELIVERY_HANDOVER"
        }],
        providerTaskId: "ESG20260726080000ABCDH1"
      };
    });

    await expect(
      harness.service.create("work-order-1", adminInitiator())
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_RESULT_STALE"
      })
    });
    expect(
      harness.state.workOrder.handover.handoverESignTask?.taskStatus
    ).toBe(ESignTaskStatus.CANCELLED);
    expect(harness.state.workOrder.handover.handoverContract.status).toBe(
      ContractStatus.GENERATED
    );
  });

  it("does not overwrite void state when customer provider creation throws late", async () => {
    const harness = createHarness();
    harness.provider.createSignTask.mockImplementationOnce(async (): Promise<any> => {
      const task = harness.state.workOrder.handover.handoverESignTask!;
      task.taskStatus = ESignTaskStatus.CANCELLED;
      harness.state.workOrder.handover.handoverESignTaskId = null;
      harness.state.workOrder.handover.status =
        DeliveryHandoverStatus.SOURCE_GENERATED;
      throw new Error("late provider failure");
    });

    await expect(
      harness.service.create("work-order-1", adminInitiator())
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_RESULT_STALE"
      })
    });
    expect(
      harness.state.workOrder.handover.handoverESignTask?.taskStatus
    ).toBe(ESignTaskStatus.CANCELLED);
    expect(harness.state.workOrder.handover.status).toBe(
      DeliveryHandoverStatus.SOURCE_GENERATED
    );
  });

  it("returns the same active task for repeated initiation", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    const task = makeTask({
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });
    harness.state.activeTask = task;
    harness.state.workOrder.handover.handoverContract.status =
      ContractStatus.SIGNING;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE;

    const result = await harness.service.create(
      "work-order-1",
      fieldInitiator(),
      fieldReview()
    );

    expect(result.taskId).toBe("stage2-task-1");
    expect(harness.readiness.assertReady).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
  });

  it("creates one task when Field and Admin fallback overlap at the handover claim", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    harness.setDatabaseTime(
      new Date(NOW.getTime() + 15 * 60 * 1000)
    );
    const runTransaction =
      harness.prisma.$transaction.getMockImplementation()!;
    let transactionTail = Promise.resolve();
    harness.prisma.$transaction.mockImplementation(
      (operation: any, options?: { isolationLevel?: string }) => {
        let release!: () => void;
        const precedingTransaction = transactionTail;
        transactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        return precedingTransaction
          .then(() => runTransaction(operation, options))
          .finally(release);
      }
    );

    const settled = await Promise.allSettled([
      harness.service.create(
        "work-order-1",
        fieldInitiator(),
        fieldReview()
      ),
      harness.service.create(
        "work-order-1",
        adminFallbackInitiator(),
        adminFallbackReview()
      )
    ]);

    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof harness.service.create>>
      > => result.status === "fulfilled"
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const taskIds = fulfilled.map((result) => result.value.taskId);
    expect(new Set(taskIds)).toEqual(
      new Set([harness.state.workOrder.handover.handoverESignTaskId])
    );
    expect(harness.prisma.contractESignTask.create).toHaveBeenCalledTimes(1);
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
    const winningInitiator = (
      harness.state.workOrder.handover.handoverESignTask
        ?.requestSnapshot as Record<string, any>
    )?.initiator?.actorType;
    expect(harness.auditLogs).toHaveLength(
      winningInitiator === "ADMIN_FALLBACK" ? 1 : 0
    );
  });

  it("reloads the winner when an overlapping initiation reads a stale pointer", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    const providerCreate =
      harness.provider.createSignTask.getMockImplementation();
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerStarted!: () => void;
    const providerStart = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    harness.provider.createSignTask.mockImplementationOnce(
      async (input: unknown) => {
        providerStarted();
        await providerRelease;
        return providerCreate!(input);
      }
    );

    const winnerPromise = harness.service.create(
      "work-order-1",
      fieldInitiator(),
      fieldReview()
    );
    await providerStart;
    const winnerTask =
      harness.state.workOrder.handover.handoverESignTask!;
    harness.state.activeTask = winnerTask;
    const staleWorkOrder = structuredClone(harness.state.workOrder);
    staleWorkOrder.handover.handoverESignTask = null;
    staleWorkOrder.handover.handoverESignTaskId = null;
    harness.prisma.vehicleHandoverWorkOrder.findUnique.mockResolvedValueOnce(
      staleWorkOrder
    );

    const overlappingPromise = harness.service.create(
      "work-order-1",
      fieldInitiator(),
      fieldReview()
    );
    releaseProvider();
    const settled = await Promise.allSettled([
      winnerPromise,
      overlappingPromise
    ]);

    expect(settled.every((result) => result.status === "fulfilled")).toBe(
      true
    );
    expect(
      settled.map((result) =>
        result.status === "fulfilled" ? result.value.taskId : null
      )
    ).toEqual([winnerTask.id, winnerTask.id]);
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
  });

  it("rejects an active contract task whose handover pointer is missing", async () => {
    const harness = createHarness();
    harness.state.activeTask = makeTask({
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });

    await expect(
      harness.service.create("work-order-1", adminInitiator())
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_ORPHAN_CONFLICT"
      })
    });
    expect(harness.readiness.assertReady).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
  });

  it("rejects an active idempotent task with a wrong platform action tuple", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });
    task.signers[1]!.providerActionType =
      ESignProviderActionType.CUSTOMER_MANUAL_SIGN;
    harness.state.activeTask = task;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;

    await expect(
      harness.service.create("work-order-1", adminInitiator())
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_SIGNERS_INVALID"
      })
    });
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
  });

  it("requires explicit void before rebuilding a terminal pointer task", async () => {
    const harness = createHarness();
    harness.state.workOrder.handover.handoverESignTask = makeTask({
      taskStatus: ESignTaskStatus.FAILED
    });
    harness.state.workOrder.handover.handoverESignTaskId = "stage2-task-1";

    await expect(
      harness.service.create("work-order-1", adminInitiator())
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED
      })
    });
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
  });

  it("voids only the Stage 2 task and clears its handover pointer for an explicit rebuild", async () => {
    const harness = createHarness();
    const persistedTask = makeTask({
      taskStatus: ESignTaskStatus.FAILED
    });
    clearVoidBlockingEvidence(persistedTask);
    harness.state.activeTask = persistedTask;
    harness.state.workOrder.handover.handoverESignTask = persistedTask;
    harness.state.workOrder.handover.handoverESignTaskId = persistedTask.id;

    const result = await harness.service.voidTask(
      "work-order-1",
      "admin-1",
      "Source artifact was superseded"
    );

    expect(harness.prisma.contractESignTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cancelledAt: expect.any(Date),
          taskStatus: ESignTaskStatus.CANCELLED,
          updatedBy: "admin-1"
        }),
        where: expect.objectContaining({
          completedAt: null,
          id: "stage2-task-1",
          signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
          taskStatus: expect.objectContaining({
            in: expect.not.arrayContaining([ESignTaskStatus.COMPLETED])
          })
        })
      })
    );
    expect(harness.prisma.vehicleDeliveryHandover.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          handoverESignTaskId: null,
          status: DeliveryHandoverStatus.SOURCE_GENERATED
        }),
        where: expect.objectContaining({
          handoverESignTaskId: "stage2-task-1",
          id: "handover-1"
        })
      })
    );
    expect(result).toMatchObject({
      canVoid: false,
      rebuildRequired: false,
      taskId: null
    });
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.auditLogs).toEqual([
      expect.objectContaining({
        action: AuditAction.UPDATE,
        afterSnapshot: {
          handoverId: "handover-1",
          handoverStatus: DeliveryHandoverStatus.SOURCE_GENERATED,
          reason: "Source artifact was superseded",
          recoveryAction: "VOID_STAGE2_ESIGN",
          taskId: "stage2-task-1",
          taskStatus: ESignTaskStatus.CANCELLED
        },
        beforeSnapshot: {
          handoverStatus: DeliveryHandoverStatus.SOURCE_GENERATED,
          taskStatus: ESignTaskStatus.FAILED
        },
        entityId: "work-order-1",
        entityType: "VehicleHandoverWorkOrder",
        module: "stage2-handover-esign",
        operatorId: "admin-1"
      })
    ]);
    expect(JSON.stringify(harness.auditLogs)).not.toMatch(
      /ESG20260726080000ABCD|private\/stage2|1380|sourcePdfHash/
    );

    const rebuilt = await harness.service.create(
      "work-order-1",
      adminInitiator()
    );

    expect(rebuilt).toMatchObject({
      rebuildRequired: false,
      taskId: "stage2-task-1"
    });
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "task provider transaction",
      setEvidence(task: ReturnType<typeof makeTask>) {
        clearVoidBlockingEvidence(task);
        task.providerTaskId = "ESG20260726080000ABCDH1";
      }
    },
    {
      label: "signer provider transaction",
      setEvidence(task: ReturnType<typeof makeTask>) {
        clearVoidBlockingEvidence(task);
        task.signers[0]!.providerTransactionId =
          "ESG20260726080000ABCDH1";
      }
    },
    {
      label: "expired provider claim",
      setEvidence(task: ReturnType<typeof makeTask>) {
        clearVoidBlockingEvidence(task);
        task.signers[0]!.claimExpiresAt =
          new Date("2026-07-26T07:59:00.000Z");
      }
    },
    {
      label: "signed timestamp",
      setEvidence(task: ReturnType<typeof makeTask>) {
        clearVoidBlockingEvidence(task);
        task.signers[0]!.signedAt =
          new Date("2026-07-26T07:58:00.000Z");
      }
    },
    {
      label: "signed signer status",
      setEvidence(task: ReturnType<typeof makeTask>) {
        clearVoidBlockingEvidence(task);
        task.signers[0]!.signerStatus =
          ESignSignerStatus.SIGNED;
      }
    }
  ])(
    "rejects void and subsequent reissue for a terminal task retaining $label evidence",
    async ({ setEvidence }) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const harness = createHarness();
      const task = makeTask({
        customerStatus: ESignSignerStatus.REJECTED,
        taskStatus: ESignTaskStatus.FAILED
      });
      setEvidence(task);
      harness.state.activeTask = task;
      harness.state.workOrder.handover.handoverESignTask = task;
      harness.state.workOrder.handover.handoverESignTaskId = task.id;
      harness.state.workOrder.handover.status =
        DeliveryHandoverStatus.FAILED;

      await expect(
        harness.service.voidTask(
          "work-order-1",
          "admin-1",
          "Terminal provider evidence must remain bound"
        )
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED
        })
      });

      expect(task.taskStatus).toBe(ESignTaskStatus.FAILED);
      expect(
        harness.state.workOrder.handover.handoverESignTaskId
      ).toBe(task.id);
      expect(harness.auditLogs).toHaveLength(0);
      await expect(
        harness.service.create("work-order-1", adminInitiator())
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED
        })
      });
      expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    }
  );

  it("restores only the Stage 2 source contract to GENERATED during void", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.EXPIRED
    });
    clearVoidBlockingEvidence(task);
    harness.state.workOrder.handover.handoverContract.status =
      ContractStatus.SIGNING;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;

    await harness.service.voidTask(
      "work-order-1",
      "admin-1",
      "Expired provider signing task"
    );

    expect(harness.prisma.contract.updateMany).toHaveBeenCalledWith({
      data: {
        signedAt: null,
        status: ContractStatus.GENERATED,
        updatedBy: "admin-1"
      },
      where: {
        id: "contract-stage2-1",
        status: ContractStatus.SIGNING
      }
    });
    expect(harness.state.workOrder.handover.handoverContract.status).toBe(
      ContractStatus.GENERATED
    );
  });

  it("does not void a completed Stage 2 signing task", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.COMPLETED,
      customerStatus: ESignSignerStatus.SIGNED,
      platformStatus: ESignSignerStatus.SIGNED
    });
    harness.state.workOrder.handover.handoverContract.status =
      ContractStatus.SIGNED;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status = DeliveryHandoverStatus.SIGNED;

    await expect(
      harness.service.voidTask(
        "work-order-1",
        "admin-1",
        "Do not downgrade completed signing"
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_VOID_NOT_ALLOWED"
      })
    });
    expect(harness.prisma.contractESignTask.update).not.toHaveBeenCalled();
    expect(harness.prisma.vehicleDeliveryHandover.updateMany).not.toHaveBeenCalled();
    expect(harness.state.workOrder.handover.status).toBe(
      DeliveryHandoverStatus.SIGNED
    );
  });

  it("does not downgrade a task completed after the initial void read", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING
    });
    clearVoidBlockingEvidence(task);
    harness.state.workOrder.handover.handoverContract.status =
      ContractStatus.SIGNING;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE;
    harness.prisma.$transaction.mockImplementationOnce(
      async (operation: (tx: any) => Promise<unknown>) => {
        task.taskStatus = ESignTaskStatus.COMPLETED;
        task.completedAt = NOW;
        task.signers[0]!.signerStatus = ESignSignerStatus.SIGNED;
        task.signers[0]!.signedAt = NOW;
        task.signers[1]!.signerStatus = ESignSignerStatus.SIGNED;
        task.signers[1]!.signedAt = NOW;
        harness.state.workOrder.handover.handoverContract.status =
          ContractStatus.SIGNED;
        harness.state.workOrder.handover.completedAt = NOW;
        harness.state.workOrder.handover.platformSignedAt = NOW;
        harness.state.workOrder.handover.status = DeliveryHandoverStatus.SIGNED;
        return operation(harness.prisma);
      }
    );

    await expect(
      harness.service.voidTask(
        "work-order-1",
        "admin-1",
        "Concurrent completion must win"
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED
      })
    });
    expect(task.taskStatus).toBe(ESignTaskStatus.COMPLETED);
    expect(task.completedAt).toEqual(NOW);
    expect(harness.state.workOrder.handover.handoverContract.status).toBe(
      ContractStatus.SIGNED
    );
    expect(harness.state.workOrder.handover.handoverESignTaskId).toBe(task.id);
    expect(harness.state.workOrder.handover.status).toBe(
      DeliveryHandoverStatus.SIGNED
    );
    expect(harness.prisma.contractESignSigner.updateMany).not.toHaveBeenCalled();
    expect(harness.prisma.contract.updateMany).not.toHaveBeenCalled();
    expect(harness.prisma.vehicleDeliveryHandover.updateMany).not.toHaveBeenCalled();
  });

  it("rejects void when a required typed signer is soft-deleted", async () => {
    const harness = createHarness();
    const task = makeTask({ taskStatus: ESignTaskStatus.FAILED });
    task.signers[0]!.deletedAt = NOW;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;

    await expect(
      harness.service.voidTask("work-order-1", "admin-1", "Invalid signer set")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_SIGNERS_INVALID"
      })
    });
    expect(harness.prisma.contractESignTask.updateMany).not.toHaveBeenCalled();
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
  });

  it("claims platform retry once and passes exactly the persisted platform slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;

    const result = await harness.service.retryPlatformSeal(
      "work-order-1",
      "admin-1"
    );

    expect(harness.prisma.contractESignSigner.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attemptCount: { increment: 1 },
          claimExpiresAt: expect.any(Date),
          lastAttemptAt: NOW
        }),
        where: expect.objectContaining({
          id: "stage2-platform-signer-1",
          slotId: PLATFORM_SLOT,
          taskId: "stage2-task-1"
        })
      })
    );
    expect(harness.provider.autoSealTask).toHaveBeenCalledTimes(1);
    const providerInput =
      (harness.provider.autoSealTask.mock.calls as any[][])[0]?.[0];
    expect(providerInput.signingSlots).toEqual([
      expect.objectContaining({
        providerActionType: "PLATFORM_AUTO_SEAL",
        signerRole: "PLATFORM",
        slotId: "STAGE2_HANDOVER_PLATFORM"
      })
    ]);
    expect(providerInput.signingSlotCoordinates).toEqual([
      {
        pageNumber: 3,
        slotId: "STAGE2_HANDOVER_PLATFORM",
        x: 580,
        y: 980
      }
    ]);
    expect(harness.prisma.contractESignSigner.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          claimExpiresAt: null,
          providerTransactionId: "ESG20260726080000ABCDH2",
          signerStatus: ESignSignerStatus.SIGNING
        }),
        where: expect.objectContaining({
          id: "stage2-platform-signer-1",
          slotId: PLATFORM_SLOT,
          taskId: "stage2-task-1"
        })
      })
    );
    expect(result.platformSigner).toMatchObject({
      retryAvailable: false,
      status: ESignSignerStatus.SIGNING
    });
  });

  it("queries H2 before retrying an ambiguous platform operation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    Object.assign(task.signers[1]!, {
      attemptCount: 1,
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerStatus: ESignSignerStatus.PENDING
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;
    harness.provider.querySignerStatus.mockResolvedValueOnce({
      resultCode: "1000",
      resultDescription: "active",
      status: "SIGNING"
    });

    await harness.service.retryPlatformSeal(
      "work-order-1",
      "admin-1"
    );

    expect(harness.provider.querySignerStatus).toHaveBeenCalledWith({
      contractId: "provider-envelope-1",
      providerCustomerId: "platform-customer-1",
      providerTaskId: "ESG20260726080000ABCDH1",
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerId: "stage2-platform-signer-1",
      slotId: "STAGE2_HANDOVER_PLATFORM",
      taskId: "stage2-task-1"
    });
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
  });

  it("reissues the same deterministic H2 only after an exact FAILED query", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    Object.assign(task.signers[1]!, {
      attemptCount: 1,
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerStatus: ESignSignerStatus.SIGNING
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;
    harness.provider.querySignerStatus
      .mockResolvedValueOnce({
        resultCode: "4000",
        resultDescription: "failed",
        status: "FAILED"
      })
      .mockResolvedValueOnce({
        resultCode: "1000",
        resultDescription: "active",
        status: "SIGNING"
      });

    const result = await harness.service.retryPlatformSeal(
      "work-order-1",
      "admin-1"
    );

    expect(harness.provider.querySignerStatus).toHaveBeenCalledTimes(2);
    expect(harness.provider.autoSealTask).toHaveBeenCalledTimes(1);
    expect(
      harness.provider.querySignerStatus.mock.invocationCallOrder[0]
    ).toBeLessThan(
      harness.provider.autoSealTask.mock.invocationCallOrder[0]!
    );
    expect(harness.provider.autoSealTask).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "ESG20260726080000ABCDH2"
      })
    );
    expect(task.signers[1]).toMatchObject({
      attemptCount: 2,
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerStatus: ESignSignerStatus.SIGNING
    });
    expect(result.platformSigner.status).toBe(
      ESignSignerStatus.SIGNING
    );
  });

  it("does not release an exact FAILED H2 claim that is still active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    const activeClaimExpiresAt =
      new Date(NOW.getTime() + 60_000);
    Object.assign(task.signers[1]!, {
      attemptCount: 2,
      claimExpiresAt: activeClaimExpiresAt,
      lastAttemptAt: NOW,
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerStatus: ESignSignerStatus.PENDING
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;
    harness.provider.querySignerStatus.mockResolvedValueOnce({
      resultCode: "4000",
      resultDescription: "failed",
      status: "FAILED"
    });

    const result = await harness.service.retryPlatformSeal(
      "work-order-1",
      "admin-1"
    );

    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
    expect(harness.provider.querySignerStatus).toHaveBeenCalledTimes(1);
    expect(task.signers[1]).toMatchObject({
      attemptCount: 2,
      claimExpiresAt: activeClaimExpiresAt,
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerStatus: ESignSignerStatus.PENDING
    });
    expect(result.platformSigner).toMatchObject({
      retryAvailable: false,
      status: ESignSignerStatus.PENDING
    });
  });

  it("allows only one FAILED H2 retry to replace the same abandoned claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    const abandonedClaimExpiresAt =
      new Date(NOW.getTime() - 60_000);
    Object.assign(task.signers[1]!, {
      attemptCount: 1,
      claimExpiresAt: abandonedClaimExpiresAt,
      lastAttemptAt: new Date(NOW.getTime() - 10 * 60_000),
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerStatus: ESignSignerStatus.SIGNING
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;
    harness.prisma.vehicleHandoverWorkOrder.findUnique.mockImplementation(
      async () => structuredClone(harness.state.workOrder)
    );

    let queryCount = 0;
    let releaseFailedQueries!: () => void;
    const failedQueriesReady = new Promise<void>((resolve) => {
      releaseFailedQueries = resolve;
    });
    harness.provider.querySignerStatus.mockImplementation(async () => {
      queryCount += 1;
      if (queryCount <= 2) {
        if (queryCount === 2) {
          releaseFailedQueries();
        }
        await failedQueriesReady;
        return {
          resultCode: "4000",
          resultDescription: "failed",
          status: "FAILED"
        };
      }
      return {
        resultCode: "1000",
        resultDescription: "active",
        status: "SIGNING"
      };
    });

    const applySignerUpdate =
      harness.prisma.contractESignSigner.updateMany
        .getMockImplementation()!;
    let recoveryCasCount = 0;
    let freshClaimSignalled = false;
    let signalFreshClaim!: () => void;
    const freshClaimInstalled = new Promise<void>((resolve) => {
      signalFreshClaim = resolve;
    });
    const markFreshClaimInstalled = () => {
      if (!freshClaimSignalled) {
        freshClaimSignalled = true;
        signalFreshClaim();
      }
    };
    harness.prisma.contractESignSigner.updateMany.mockImplementation(
      async (args: any) => {
        const recoveryCas =
          args.where?.id === "stage2-platform-signer-1" &&
          args.where?.providerTransactionId ===
            "ESG20260726080000ABCDH2" &&
          args.where?.AND === undefined &&
          args.data?.signerStatus === ESignSignerStatus.PENDING;
        if (recoveryCas) {
          const ordinal = ++recoveryCasCount;
          if (ordinal === 2) {
            await freshClaimInstalled;
          }
          const result = await applySignerUpdate(args);
          if (
            ordinal === 1 &&
            result.count === 1 &&
            args.data?.attemptCount?.increment === 1 &&
            args.data?.claimExpiresAt instanceof Date
          ) {
            markFreshClaimInstalled();
          }
          return result;
        }

        const result = await applySignerUpdate(args);
        if (
          args.where?.AND &&
          args.data?.attemptCount?.increment === 1 &&
          result.count === 1
        ) {
          markFreshClaimInstalled();
        }
        return result;
      }
    );

    const settled = await Promise.allSettled([
      harness.service.retryPlatformSeal(
        "work-order-1",
        "admin-1"
      ),
      harness.service.retryPlatformSeal(
        "work-order-1",
        "admin-2"
      )
    ]);

    expect(harness.provider.autoSealTask).toHaveBeenCalledTimes(1);
    expect(
      settled.every((result) => result.status === "fulfilled")
    ).toBe(true);
    expect(
      settled.map((result) =>
        result.status === "fulfilled"
          ? result.value.taskId
          : null
      )
    ).toEqual([task.id, task.id]);
    expect(recoveryCasCount).toBe(2);
    expect(harness.provider.autoSealTask).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "ESG20260726080000ABCDH2"
      })
    );
    expect(
      harness.provider.querySignerStatus.mock.invocationCallOrder[0]
    ).toBeLessThan(
      harness.provider.autoSealTask.mock.invocationCallOrder[0]!
    );
    expect(
      harness.provider.querySignerStatus.mock.invocationCallOrder[1]
    ).toBeLessThan(
      harness.provider.autoSealTask.mock.invocationCallOrder[0]!
    );
    expect(task.signers[1]).toMatchObject({
      attemptCount: 2,
      claimExpiresAt: null,
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerStatus: ESignSignerStatus.SIGNING
    });
  });

  it("fails closed without a platform write when exact H2 is UNKNOWN", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    Object.assign(task.signers[1]!, {
      attemptCount: 1,
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerStatus: ESignSignerStatus.PENDING
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;
    harness.provider.querySignerStatus.mockResolvedValueOnce({
      resultCode: "9999",
      resultDescription: "unknown",
      status: "UNKNOWN"
    });

    await expect(
      harness.service.retryPlatformSeal(
        "work-order-1",
        "admin-1"
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_PLATFORM_SEAL_PROVIDER_FAILED
      })
    });

    expect(harness.provider.querySignerStatus).toHaveBeenCalledTimes(1);
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
    expect(task.signers[1]).toMatchObject({
      attemptCount: 1,
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerStatus: ESignSignerStatus.PENDING
    });
  });

  it("does not issue another seal when exact H2 is already signed", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    Object.assign(task.signers[1]!, {
      attemptCount: 1,
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerStatus: ESignSignerStatus.PENDING
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;
    harness.provider.querySignerStatus.mockResolvedValueOnce({
      resultCode: "3000",
      resultDescription: "completed",
      status: "SIGNED"
    });

    await harness.service.retryPlatformSeal(
      "work-order-1",
      "admin-1"
    );

    expect(
      harness.transitions.reconcilePlatformSigned
    ).toHaveBeenCalledWith({
      completedAt: expect.any(Date),
      eSignTaskId: task.id,
      providerTransactionId:
        "ESG20260726080000ABCDH2",
      queryResult: {
        resultCode: "3000",
        status: "SIGNED"
      },
      source: "QUERY"
    });
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
  });

  it("does not mark H2 signed from the platform write response alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;
    harness.provider.autoSealTask.mockResolvedValueOnce({
      coveredSlotIds: ["STAGE2_HANDOVER_PLATFORM"],
      providerActionType: "PLATFORM_AUTO_SEAL",
      providerSignerId: "ESG20260726080000ABCDH2",
      providerTransactionId: "ESG20260726080000ABCDH2",
      resultCode: "3000",
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      status: "COMPLETED"
    });
    harness.provider.querySignerStatus.mockResolvedValueOnce({
      resultCode: "1000",
      resultDescription: "active",
      status: "SIGNING"
    });

    const result = await harness.service.retryPlatformSeal(
      "work-order-1",
      "admin-1"
    );

    expect(harness.provider.autoSealTask).toHaveBeenCalledTimes(1);
    expect(harness.provider.querySignerStatus).toHaveBeenCalledTimes(1);
    expect(
      harness.transitions.reconcilePlatformSigned
    ).not.toHaveBeenCalled();
    expect(result.platformSigner.status).toBe(
      ESignSignerStatus.SIGNING
    );
    expect(result.status).toBe(ESignTaskStatus.SIGNING);
  });

  it("queries H2 without repeating the provider write after an ambiguous status response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;
    harness.provider.querySignerStatus.mockRejectedValueOnce(
      new Error("provider status timeout")
    );

    await expect(
      harness.service.retryPlatformSeal(
        "work-order-1",
        "admin-1"
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_PLATFORM_SEAL_PROVIDER_FAILED
      })
    });
    expect(task.signers[1]).toMatchObject({
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerStatus: ESignSignerStatus.SIGNING
    });

    harness.provider.querySignerStatus.mockResolvedValueOnce({
      resultCode: "1000",
      resultDescription: "active",
      status: "SIGNING"
    });
    await harness.service.retryPlatformSeal(
      "work-order-1",
      "admin-1"
    );

    expect(harness.provider.autoSealTask).toHaveBeenCalledTimes(1);
    expect(harness.provider.querySignerStatus).toHaveBeenCalledTimes(2);
  });

  it("rejects void after an asynchronous platform action is accepted", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;

    await harness.service.retryPlatformSeal("work-order-1", "admin-1");

    expect(task.signers[1]).toMatchObject({
      claimExpiresAt: null,
      providerTransactionId: "ESG20260726080000ABCDH2",
      signerStatus: ESignSignerStatus.SIGNING
    });
    await expect(
      harness.service.voidTask(
        "work-order-1",
        "admin-1",
        "Accepted platform action must remain correlated"
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED
      })
    });
    expect(task.taskStatus).toBe(ESignTaskStatus.SIGNING);
    expect(harness.state.workOrder.handover.handoverESignTaskId).toBe(task.id);
  });

  it("accepts an early platform callback reconciled against the preclaimed transaction", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    harness.state.workOrder.handover.handoverContract.status =
      ContractStatus.SIGNING;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;
    harness.provider.autoSealTask.mockImplementationOnce(async (input: any) => {
      const platformSigner = task.signers[1]!;
      platformSigner.claimExpiresAt = null;
      platformSigner.providerSignerId = input.transactionId;
      platformSigner.providerTransactionId = input.transactionId;
      platformSigner.signedAt = NOW;
      platformSigner.signerStatus = ESignSignerStatus.SIGNED;
      task.completedAt = NOW;
      task.taskStatus = ESignTaskStatus.COMPLETED;
      harness.state.workOrder.handover.handoverContract.status =
        ContractStatus.SIGNED;
      harness.state.workOrder.handover.status = DeliveryHandoverStatus.SIGNED;
      return {
        coveredSlotIds: ["STAGE2_HANDOVER_PLATFORM"],
        providerActionType: "PLATFORM_AUTO_SEAL",
        providerSignerId: input.transactionId,
        providerTransactionId: input.transactionId,
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        status: "COMPLETED"
      };
    });

    const result = await harness.service.retryPlatformSeal(
      "work-order-1",
      "admin-1"
    );

    expect(result.platformSigner.status).toBe(ESignSignerStatus.SIGNED);
    expect(result.status).toBe(ESignTaskStatus.COMPLETED);
    expect(harness.state.workOrder.handover.status).toBe(
      DeliveryHandoverStatus.SIGNED
    );
  });

  it("rejects a concurrent platform retry when the typed claim is not acquired", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.prisma.contractESignSigner.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      harness.service.retryPlatformSeal("work-order-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED
      })
    });
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
  });

  it("rejects a workflow auto-seal job that is not bound to deterministic H2", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;

    await expect(
      harness.service.retryPlatformSeal(
        "work-order-1",
        undefined,
        "OTHERTRANSACTION"
      )
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_PLATFORM_SEAL_TRANSACTION_INVALID"
      })
    });
    expect(harness.provider.querySignerStatus).not.toHaveBeenCalled();
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
  });

  it("requires explicit void when the task source binding no longer matches", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    task.requestSnapshot = {
      artifactVersion: 3,
      contractId: "contract-stage2-1",
      handoverId: "handover-1",
      manifestHash: "a".repeat(64),
      sourceDocumentFileId: "file-stage2-1",
      sourcePdfHash: "c".repeat(64)
    };
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;

    await expect(
      harness.service.retryPlatformSeal("work-order-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED
      })
    });
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignSigner.updateMany).not.toHaveBeenCalled();
  });

  it("rejects equal-hash retry when the task contract identity is stale", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    task.contractId = "contract-stage2-old";
    (task.requestSnapshot as Record<string, unknown>).contractId =
      "contract-stage2-old";
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;

    await expect(
      harness.service.retryPlatformSeal("work-order-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED
      })
    });
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignSigner.updateMany).not.toHaveBeenCalled();
  });

  it("rejects equal-hash retry when the source file identity is stale", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    harness.state.workOrder.handover.handoverContract.fileId =
      "file-stage2-replacement";
    harness.state.workOrder.handover.handoverContract.contractSnapshot
      .stage2HandoverPdfArtifact.fileId = "file-stage2-replacement";
    harness.state.workOrder.handover.sourceDocumentFileId =
      "file-stage2-replacement";
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;

    await expect(
      harness.service.retryPlatformSeal("work-order-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED
      })
    });
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignSigner.updateMany).not.toHaveBeenCalled();
  });

  it("rejects platform retry when the platform signer is not required", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    task.signers[1]!.required = false;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;

    await expect(
      harness.service.retryPlatformSeal("work-order-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_SIGNERS_INVALID"
      })
    });
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignSigner.updateMany).not.toHaveBeenCalled();
  });

  it("does not apply a platform result after its claim is released by void", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.provider.autoSealTask.mockImplementationOnce(async (): Promise<any> => {
      const platformSigner = task.signers[1]!;
      platformSigner.claimExpiresAt = null;
      task.taskStatus = ESignTaskStatus.CANCELLED;
      harness.state.workOrder.handover.handoverESignTaskId = null;
      harness.state.workOrder.handover.status =
        DeliveryHandoverStatus.SOURCE_GENERATED;
      return {
        coveredSlotIds: ["STAGE2_HANDOVER_PLATFORM"],
        providerActionType: "PLATFORM_AUTO_SEAL",
        providerSignerId: "ESG20260726080000ABCDH2",
        providerTransactionId: "ESG20260726080000ABCDH2",
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        status: "PENDING"
      };
    });

    await expect(
      harness.service.retryPlatformSeal("work-order-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_PLATFORM_SEAL_CLAIM_LOST"
      })
    });
    expect(task.taskStatus).toBe(ESignTaskStatus.CANCELLED);
    expect(task.signers[1]?.signerStatus).toBe(ESignSignerStatus.PENDING);
    expect(harness.state.workOrder.handover.status).toBe(
      DeliveryHandoverStatus.SOURCE_GENERATED
    );
  });

  it("records provider failure as retryable typed state without unrelated side effects", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.provider.autoSealTask.mockRejectedValueOnce(
      new Error("provider timeout https://unsafe.example/sign?token=secret")
    );

    await expect(
      harness.service.retryPlatformSeal("work-order-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_PLATFORM_SEAL_PROVIDER_FAILED"
      })
    });

    expect(harness.prisma.contractESignSigner.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          claimExpiresAt: null,
          lastErrorCode: "STAGE2_PLATFORM_SEAL_PROVIDER_FAILED",
          nextRetryAt: expect.any(Date),
          signerStatus: ESignSignerStatus.PENDING
        }),
        where: expect.objectContaining({
          id: "stage2-platform-signer-1",
          slotId: PLATFORM_SLOT
        })
      })
    );
    const failureUpdate =
      harness.prisma.contractESignSigner.updateMany.mock.calls.at(-1)?.[0].data;
    expect(JSON.stringify(failureUpdate)).not.toContain("unsafe.example");
    expect(JSON.stringify(failureUpdate)).not.toContain("secret");
    expect(harness.prisma.subscriptionOrder.update).not.toHaveBeenCalled();
    expect(harness.prisma.vehicleDelivery.update).not.toHaveBeenCalled();
    expect(harness.prisma.leaseContract.create).not.toHaveBeenCalled();
    expect(harness.notification.notifyCustomer).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignSigner.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "stage1-signer-1" } })
    );
  });

  it("returns safe status and signed-document views without capability or storage fields", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    Object.assign(task, {
      documentObjectKey: "private/source.pdf",
      providerTaskId: "provider-task-secret",
      signUrl: "https://unsafe.example/sign?token=secret"
    });
    Object.assign(task.signers[0]!, {
      providerCustomerId: "provider-customer-secret",
      signUrl: "https://unsafe.example/sign?token=secret",
      signerPhone: "13800138000"
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.signedDocumentFileId = "signed-file-1";
    harness.state.workOrder.handover.signedObjectKey = "private/signed.pdf";

    const status = await harness.service.getStatus("work-order-1");
    const signedDocument =
      await harness.service.getSignedDocumentState("work-order-1");
    const serialized = JSON.stringify({ signedDocument, status });

    expect(status).toMatchObject({
      archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED,
      signedArtifactAvailable: false,
      taskId: "stage2-task-1"
    });
    expect(signedDocument).toEqual(
      expect.objectContaining({
        archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED,
        available: false,
        handoverId: "handover-1",
        taskId: "stage2-task-1",
        workOrderId: "work-order-1"
      })
    );
    for (const forbidden of [
      "signUrl",
      "objectKey",
      "bucket",
      "providerCustomer",
      "providerTask",
      "13800138000",
      "unsafe.example",
      "secret"
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("requires every typed archive field in Admin, Portal, and signed-document status projections", async () => {
    const completeArchive = {
      archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
      signedDocumentFileId: "signed-file-1",
      signedObjectKey: "private/stage2/signed.pdf",
      signedPdfHash: "c".repeat(64),
      status: DeliveryHandoverStatus.ARCHIVED
    };
    const incompleteArchives = [
      {
        description: "archive status",
        override: {
          archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED
        }
      },
      {
        description: "handover status",
        override: { status: DeliveryHandoverStatus.SIGNED }
      },
      {
        description: "signed document file",
        override: { signedDocumentFileId: null }
      },
      {
        description: "signed object key",
        override: { signedObjectKey: null }
      },
      {
        description: "signed PDF hash",
        override: { signedPdfHash: null }
      }
    ];

    for (const incompleteArchive of incompleteArchives) {
      const harness = createHarness();
      const task = makeTask({
        customerStatus: ESignSignerStatus.SIGNED,
        platformStatus: ESignSignerStatus.SIGNED,
        taskStatus: ESignTaskStatus.COMPLETED
      });
      task.completedAt = NOW;
      attachPortalTask(harness, task);
      Object.assign(
        harness.state.workOrder.handover,
        completeArchive,
        incompleteArchive.override
      );

      const admin = await harness.service.getStatus("work-order-1");
      const portal = await harness.service.getPortalStatus(
        "work-order-1",
        "customer-1"
      );
      const signedDocument =
        await harness.service.getSignedDocumentState("work-order-1");

      expect(
        admin.signedArtifactAvailable,
        incompleteArchive.description
      ).toBe(false);
      expect(
        portal.signedArtifactAvailable,
        incompleteArchive.description
      ).toBe(false);
      expect(signedDocument.available, incompleteArchive.description).toBe(
        false
      );
      expect(
        signedDocument.retryAvailable,
        incompleteArchive.description
      ).toBe(true);
      expect(JSON.stringify({ admin, portal, signedDocument })).not.toContain(
        completeArchive.signedObjectKey
      );
    }

    const harness = createHarness();
    const task = makeTask({
      customerStatus: ESignSignerStatus.SIGNED,
      platformStatus: ESignSignerStatus.SIGNED,
      taskStatus: ESignTaskStatus.COMPLETED
    });
    task.completedAt = NOW;
    attachPortalTask(harness, task);
    Object.assign(harness.state.workOrder.handover, completeArchive);

    await expect(harness.service.getStatus("work-order-1")).resolves.toMatchObject({
      signedArtifactAvailable: true
    });
    await expect(
      harness.service.getPortalStatus("work-order-1", "customer-1")
    ).resolves.toMatchObject({
      signedArtifactAvailable: true
    });
    await expect(
      harness.service.getSignedDocumentState("work-order-1")
    ).resolves.toMatchObject({
      available: true,
      retryAvailable: false
    });
  });

  it("clears signing blockers and exposes the signed preview after authoritative archive", async () => {
    const harness = createHarness();
    const task = makeTask({
      customerStatus: ESignSignerStatus.SIGNED,
      platformStatus: ESignSignerStatus.SIGNED,
      taskStatus: ESignTaskStatus.COMPLETED
    });
    task.completedAt = NOW;
    attachPortalTask(harness, task);
    Object.assign(harness.state.workOrder.handover, {
      archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
      signedDocumentFileId: "signed-file-1",
      signedObjectKey: "private/stage2/signed.pdf",
      signedPdfHash: "c".repeat(64),
      status: DeliveryHandoverStatus.ARCHIVED
    });
    harness.readiness.getReadiness.mockResolvedValueOnce({
      blockers: [
        {
          code: "ACTIVE_ESIGN_TASK_CONFLICT",
          message: "the completed signing task remains current"
        }
      ],
      ready: false,
      state: {
        esignTaskId: task.id,
        esignTaskStatus: task.taskStatus,
        handoverContractId: "contract-stage2-1",
        handoverId: "handover-1",
        handoverStatus: DeliveryHandoverStatus.ARCHIVED,
        orderId: "order-1",
        orderStatus: "PENDING_DELIVERY",
        workOrderId: "work-order-1",
        workOrderStatus: "PLATFORM_SEALED"
      }
    });

    const status = await harness.service.getPortalStatus(
      "work-order-1",
      "customer-1"
    );

    expect(status).toMatchObject({
      blockers: [],
      capability: { canStartSigning: false },
      signedArtifactAvailable: true,
      signedDocumentPreviewUrl:
        "/api/portal/handover-reviews/work-order-1/esign/signed-document/preview"
    });
  });

  it("rejects status when the customer signer has the wrong role", async () => {
    const harness = createHarness();
    const task = makeTask();
    task.signers[0]!.signerType = ESignSignerType.PLATFORM;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;

    await expect(
      harness.service.getStatus("work-order-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_SIGNERS_INVALID"
      })
    });
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
  });

  it("rejects status when an extra signer row is present", async () => {
    const harness = createHarness();
    const task = makeTask();
    task.signers.push({
      ...makeSigner("PLATFORM"),
      id: "stage2-extra-signer-1"
    });
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;

    await expect(
      harness.service.getStatus("work-order-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_SIGNERS_INVALID"
      })
    });
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.provider.autoSealTask).not.toHaveBeenCalled();
  });

  it("returns a Portal-safe status without refreshing or exposing a signing URL", async () => {
    const harness = createHarness();
    const task = makeTask();
    Object.assign(task, {
      documentObjectKey: "private/source.pdf",
      signUrl: "https://unsafe.example/task-sign?token=secret"
    });
    Object.assign(task.signers[0]!, {
      signUrl: "https://unsafe.example/signer-sign?token=secret"
    });
    attachPortalTask(harness, task);

    const status = await harness.service.getPortalStatus(
      "work-order-1",
      "customer-1"
    );
    const serialized = JSON.stringify(status);

    expect(status).toMatchObject({
      capability: {
        canStartSigning: true
      },
      customerSigner: {
        slotId: ESignSlotId.STAGE2_HANDOVER_CUSTOMER,
        status: ESignSignerStatus.SIGNING
      },
      signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
      taskId: "stage2-task-1"
    });
    for (const forbidden of [
      "signUrl",
      "signingUrl",
      "objectKey",
      "bucket",
      "provider",
      "rawResponse",
      "unsafe.example",
      "secret"
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(harness.provider.getSignerUrl).not.toHaveBeenCalled();
  });

  it("maps an error-state Portal status through an explicit safe DTO", async () => {
    const harness = createHarness();
    const task = makeTask();
    Object.assign(task.signers[0]!, {
      lastAttemptAt: new Date("2026-07-26T08:01:00.000Z"),
      lastErrorCode: "FADADA_PROVIDER_SECRET",
      lastErrorMessage:
        "provider rawResponse https://unsafe.example/sign?token=secret"
    });
    Object.assign(task.signers[1]!, {
      lastErrorCode: "PROVIDER_PLATFORM_FAILURE"
    });
    attachPortalTask(harness, task);
    harness.readiness.getReadiness.mockResolvedValueOnce({
      blockers: [
        {
          code: "CUSTOMER_OBJECTION_ACTIVE",
          message: "The customer has an active handover objection."
        },
        {
          code: "CUSTOMER_ESIGN_NOT_READY",
          message: "The customer Fadada account is not ready for signing."
        },
        {
          code: "PLATFORM_CUSTOMER_ID_MISSING",
          message: "The platform Fadada customer ID is not configured."
        },
        {
          code: "PLATFORM_SIGNATURE_ID_MISSING",
          message: "The platform Fadada signature ID is not configured."
        },
        {
          code: "CUSTOMER_READINESS_FRESHNESS_UNCONFIGURED",
          message:
            "Customer provider-readiness freshness is not configured."
        }
      ],
      ready: false,
      state: {
        esignTaskId: task.id,
        esignTaskStatus: task.taskStatus,
        handoverContractId: "contract-stage2-1",
        handoverId: "handover-1",
        handoverStatus: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
        orderId: "order-1",
        orderStatus: "PENDING_DELIVERY",
        workOrderId: "work-order-1",
        workOrderStatus: "CUSTOMER_OBJECTED"
      }
    });

    const status = await harness.service.getPortalStatus(
      "work-order-1",
      "customer-1"
    );
    const serialized = JSON.stringify(status).toLowerCase();

    expect(status).toEqual({
      archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED,
      blockers: [
        {
          code: "CUSTOMER_OBJECTION_ACTIVE",
          message: "The customer has an active handover objection."
        },
        {
          code: "STAGE2_SIGNING_NOT_AVAILABLE",
          message: "Stage 2 signing is not currently available."
        }
      ],
      capability: {
        canStartSigning: false,
        reentryAvailableAt: null,
        reentryRemainingSeconds: 0
      },
      createdAt: NOW,
      customerSigner: {
        signedAt: null,
        slotId: ESignSlotId.STAGE2_HANDOVER_CUSTOMER,
        status: ESignSignerStatus.SIGNING
      },
      documentType: ESignDocumentType.DELIVERY_HANDOVER,
      handoverId: "handover-1",
      platformSigner: {
        signedAt: null,
        slotId: ESignSlotId.STAGE2_HANDOVER_PLATFORM,
        status: ESignSignerStatus.PENDING
      },
      ready: false,
      signedArtifactAvailable: false,
      signedDocumentPreviewUrl: null,
      signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
      status: ESignTaskStatus.WAITING_CUSTOMER,
      taskId: "stage2-task-1",
      updatedAt: NOW,
      workOrderId: "work-order-1"
    });
    for (const forbidden of [
      "lasterrorcode",
      "fada",
      "provider",
      "platform_customer",
      "platform_signature",
      "customer_id",
      "rawresponse",
      "unsafe.example",
      "secret",
      "signurl",
      "objectkey",
      "bucket"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("omits expected readiness blockers when Portal signing can start", async () => {
    const harness = createHarness();
    const task = makeTask();
    attachPortalTask(harness, task);
    harness.readiness.getReadiness.mockResolvedValueOnce({
      blockers: [
        {
          code: "HANDOVER_SOURCE_NOT_GENERATED",
          message: "expected after the current task starts"
        },
        {
          code: "ACTIVE_ESIGN_TASK_CONFLICT",
          message: "the current task is active"
        }
      ],
      ready: false,
      state: {
        esignTaskId: task.id,
        esignTaskStatus: task.taskStatus,
        handoverContractId: "contract-stage2-1",
        handoverId: "handover-1",
        handoverStatus: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
        orderId: "order-1",
        orderStatus: "PENDING_DELIVERY",
        workOrderId: "work-order-1",
        workOrderStatus: "CUSTOMER_CONFIRMED"
      }
    });

    const status = await harness.service.getPortalStatus(
      "work-order-1",
      "customer-1"
    );

    expect(status).toMatchObject({
      blockers: [],
      capability: {
        canStartSigning: true
      }
    });
  });

  it.each([
    {
      currentOrderStatus: OrderStatus.CANCELLED,
      currentWorkOrderStatus: VehicleHandoverWorkOrderStatus.CUSTOMER_CONFIRMED,
      stateName: "order"
    },
    {
      currentOrderStatus: OrderStatus.PENDING_DELIVERY,
      currentWorkOrderStatus: VehicleHandoverWorkOrderStatus.CUSTOMER_OBJECTED,
      stateName: "work order"
    }
  ])(
    "keeps Portal signing blocked when the current $stateName state differs from readiness",
    async ({ currentOrderStatus, currentWorkOrderStatus }) => {
      const harness = createHarness();
      const task = makeTask();
      attachPortalTask(harness, task);
      harness.state.workOrder.order.orderStatus = currentOrderStatus;
      harness.state.workOrder.status = currentWorkOrderStatus;
      harness.readiness.getReadiness.mockResolvedValueOnce({
        blockers: [
          {
            code: "ACTIVE_ESIGN_TASK_CONFLICT",
            message: "the current task is active"
          }
        ],
        ready: false,
        state: {
          esignTaskId: task.id,
          esignTaskStatus: task.taskStatus,
          handoverContractId: "contract-stage2-1",
          handoverId: "handover-1",
          handoverStatus: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
          orderId: "order-1",
          orderStatus: OrderStatus.PENDING_DELIVERY,
          workOrderId: "work-order-1",
          workOrderStatus: VehicleHandoverWorkOrderStatus.CUSTOMER_CONFIRMED
        }
      });

      const status = await harness.service.getPortalStatus(
        "work-order-1",
        "customer-1"
      );

      expect(status).toMatchObject({
        blockers: [
          {
            code: "STAGE2_SIGNING_NOT_AVAILABLE",
            message: "Stage 2 signing is not currently available."
          }
        ],
        capability: {
          canStartSigning: false
        }
      });
    }
  );

  it("queries the provider and returns a short-lived URL without persisting it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness();
    const task = makeTask();
    Object.assign(task.signers[0]!, {
      signUrl: "https://sentinel.example/stage2-sign",
      signUrlExpiresAt: new Date("2026-07-26T08:10:00.000Z")
    });
    attachPortalTask(harness, task);
    harness.readiness.getReadiness.mockResolvedValueOnce({
      blockers: [
        {
          code: "HANDOVER_SOURCE_NOT_GENERATED",
          message: "expected after the current task starts"
        },
        {
          code: "ACTIVE_ESIGN_TASK_CONFLICT",
          message: "the current task is active"
        }
      ],
      ready: false,
      state: {
        esignTaskId: task.id,
        esignTaskStatus: task.taskStatus,
        handoverContractId: "contract-stage2-1",
        handoverId: "handover-1",
        handoverStatus: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
        orderId: "order-1",
        orderStatus: "PENDING_DELIVERY",
        workOrderId: "work-order-1",
        workOrderStatus: "CUSTOMER_CONFIRMED"
      }
    });
    const expiresAt = new Date("2026-07-26T08:15:00.000Z");
    harness.provider.getSignerUrl.mockResolvedValueOnce({
      expiresAt,
      rawResponse: {
        objectKey: "private/source.pdf",
        signUrl: "https://unsafe.example/should-not-escape"
      },
      signUrl: "https://sentinel.example/stage2-sign"
    });

    const result = await harness.service.startPortalSigning(
      "work-order-1",
      "customer-1"
    );

    expect(result).toEqual({
      expiresAt,
      signUrl: "https://sentinel.example/stage2-sign"
    });
    expect(harness.provider.getSignerUrl).toHaveBeenCalledWith({
      contractId: "provider-envelope-1",
      providerTaskId: "ESG20260726080000ABCDH1",
      redirectUrl:
        "http://localhost:3000/portal/handover-reviews/work-order-1",
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      signerId: "stage2-customer-signer-1",
      taskId: "stage2-task-1"
    });
    expect(harness.provider.querySignerStatus).toHaveBeenCalledTimes(1);
    expect(harness.prisma.contractESignTask.update).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignTask.updateMany).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignSigner.update).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignSigner.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          signUrl: null,
          signUrlExpiresAt: expiresAt
        })
      })
    );
    expect(harness.prisma.subscriptionOrder.update).not.toHaveBeenCalled();
    expect(harness.prisma.vehicleDelivery.update).not.toHaveBeenCalled();
    expect(harness.prisma.leaseContract.create).not.toHaveBeenCalled();
  });

  it("allows the first Portal entry but enforces the database-clock 60 second reentry boundary", async () => {
    const harness = createHarness();
    const task = makeTask();
    task.signers[0]!.lastAttemptAt = NOW;
    attachPortalTask(harness, task);
    harness.provider.getSignerUrl.mockResolvedValue({
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      signUrl: "https://sentinel.example/stage2-sign"
    });

    await expect(
      harness.service.startPortalSigning("work-order-1", "customer-1")
    ).resolves.toMatchObject({
      signUrl: "https://sentinel.example/stage2-sign"
    });

    harness.setDatabaseTime(new Date(NOW.getTime() + 59_000));
    await expect(
      harness.service.startPortalSigning("work-order-1", "customer-1")
    ).rejects.toMatchObject({
      response: {
        code: "STAGE2_PORTAL_SIGNING_REENTRY_COOLDOWN",
        reentryAvailableAt: "2026-07-26T08:01:00.000Z",
        reentryRemainingSeconds: 1
      },
      status: 409
    });
    expect(harness.provider.getSignerUrl).toHaveBeenCalledTimes(1);

    harness.setDatabaseTime(new Date(NOW.getTime() + 60_000));
    await expect(
      harness.service.startPortalSigning("work-order-1", "customer-1")
    ).resolves.toMatchObject({
      signUrl: "https://sentinel.example/stage2-sign"
    });
    expect(harness.provider.getSignerUrl).toHaveBeenCalledTimes(2);
    expect(task.signers[0]!.lastAttemptAt).toEqual(NOW);
  });

  it("exposes the persisted reentry window without removing the signing capability", async () => {
    const harness = createHarness();
    const task = makeTask();
    attachPortalTask(harness, task);
    harness.provider.getSignerUrl.mockResolvedValueOnce({
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      signUrl: "https://sentinel.example/stage2-sign"
    });

    await harness.service.startPortalSigning("work-order-1", "customer-1");
    harness.setDatabaseTime(new Date(NOW.getTime() + 18_250));

    await expect(
      harness.service.getPortalStatus("work-order-1", "customer-1")
    ).resolves.toMatchObject({
      capability: {
        canStartSigning: true,
        reentryAvailableAt: new Date("2026-07-26T08:01:00.000Z"),
        reentryRemainingSeconds: 42
      }
    });
  });

  it("admits only one provider URL generation when Portal entry requests overlap", async () => {
    const harness = createHarness();
    const task = makeTask();
    attachPortalTask(harness, task);
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let calls = 0;
    harness.provider.getSignerUrl.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        await firstMayFinish;
      }
      return {
        expiresAt: new Date(NOW.getTime() + 30 * 60_000),
        signUrl: "https://sentinel.example/stage2-sign"
      };
    });

    const winner = harness.service.startPortalSigning(
      "work-order-1",
      "customer-1"
    );
    await firstDidStart;
    const overlapping = harness.service.startPortalSigning(
      "work-order-1",
      "customer-1"
    );
    releaseFirst();

    await expect(winner).resolves.toMatchObject({
      signUrl: "https://sentinel.example/stage2-sign"
    });
    await expect(overlapping).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_PORTAL_SIGNING_REENTRY_COOLDOWN"
      }),
      status: 409
    });
    expect(harness.provider.getSignerUrl).toHaveBeenCalledTimes(1);
  });

  it("releases the entry claim when provider URL generation fails before acceptance", async () => {
    const harness = createHarness();
    const task = makeTask();
    attachPortalTask(harness, task);
    harness.provider.getSignerUrl
      .mockRejectedValueOnce(new Error("provider temporarily unavailable"))
      .mockResolvedValueOnce({
        expiresAt: new Date(NOW.getTime() + 30 * 60_000),
        signUrl: "https://sentinel.example/stage2-sign"
      });

    await expect(
      harness.service.startPortalSigning("work-order-1", "customer-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_PORTAL_SIGNING_URL_UNAVAILABLE"
      })
    });
    await expect(
      harness.service.startPortalSigning("work-order-1", "customer-1")
    ).resolves.toMatchObject({
      signUrl: "https://sentinel.example/stage2-sign"
    });
    expect(task.signers[0]!.snapshot).toMatchObject({
      portalSigningEntry: {
        claimToken: null,
        claimUntil: null,
        lastIssuedAt: "2026-07-26T08:00:00.000Z"
      }
    });
  });

  it("refreshes an expired URL without re-uploading or creating a new transaction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness();
    const task = makeTask();
    Object.assign(task.signers[0]!, {
      signUrl: "https://sentinel.example/expired-stage2-sign",
      signUrlExpiresAt: new Date(NOW.getTime() - 1)
    });
    attachPortalTask(harness, task);
    harness.provider.querySignerStatus.mockResolvedValueOnce({
      resultCode: "1000",
      resultDescription: "active",
      status: "SIGNING"
    });
    const expiresAt = new Date(NOW.getTime() + 30 * 60 * 1000);
    harness.provider.getSignerUrl.mockResolvedValueOnce({
      expiresAt,
      signUrl: "https://sentinel.example/refreshed-stage2-sign"
    });

    const result = await harness.service.startPortalSigning(
      "work-order-1",
      "customer-1"
    );

    expect(result).toEqual({
      expiresAt,
      signUrl: "https://sentinel.example/refreshed-stage2-sign"
    });
    expect(harness.provider.querySignerStatus).toHaveBeenCalledWith({
      contractId: "provider-envelope-1",
      providerCustomerId: "fadada-customer-1",
      providerTaskId: "ESG20260726080000ABCDH1",
      providerTransactionId: "ESG20260726080000ABCDH1",
      signerId: "stage2-customer-signer-1",
      slotId: "STAGE2_HANDOVER_CUSTOMER",
      taskId: "stage2-task-1"
    });
    expect(harness.provider.getSignerUrl).toHaveBeenCalledWith({
      contractId: "provider-envelope-1",
      providerTaskId: "ESG20260726080000ABCDH1",
      redirectUrl:
        "http://localhost:3000/portal/handover-reviews/work-order-1",
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      signerId: "stage2-customer-signer-1",
      taskId: "stage2-task-1"
    });
    expect(task.signers[0]).toMatchObject({
      providerTransactionId: "ESG20260726080000ABCDH1",
      signUrl: null,
      signUrlExpiresAt: expiresAt,
      signerStatus: ESignSignerStatus.SIGNING
    });
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.prisma.subscriptionOrder.update).not.toHaveBeenCalled();
    expect(harness.prisma.vehicleDelivery.update).not.toHaveBeenCalled();
    expect(harness.prisma.leaseContract.create).not.toHaveBeenCalled();
  });

  it("returns the first customer signing URL when Fadada confirms no signing record exists yet", async () => {
    const harness = createHarness();
    const task = makeTask();
    attachPortalTask(harness, task);
    harness.provider.querySignerStatus.mockResolvedValueOnce({
      providerRecordAbsent: true,
      resultDescription: "签署记录为空",
      status: "UNKNOWN"
    });
    const expiresAt = new Date(NOW.getTime() + 30 * 60 * 1000);
    harness.provider.getSignerUrl.mockResolvedValueOnce({
      expiresAt,
      signUrl: "https://sentinel.example/stage2-first-sign"
    });

    await expect(
      harness.service.startPortalSigning(
        "work-order-1",
        "customer-1"
      )
    ).resolves.toEqual({
      expiresAt,
      signUrl: "https://sentinel.example/stage2-first-sign"
    });
    expect(task.signers[0]).toMatchObject({
      providerTransactionId: "ESG20260726080000ABCDH1",
      signUrl: null,
      signUrlExpiresAt: expiresAt,
      signerStatus: ESignSignerStatus.SIGNING
    });
  });

  it("still fails closed on an unverified UNKNOWN provider state", async () => {
    const harness = createHarness();
    const task = makeTask();
    attachPortalTask(harness, task);
    harness.provider.querySignerStatus.mockResolvedValueOnce({
      resultDescription: "unverified provider response",
      status: "UNKNOWN"
    });

    await expect(
      harness.service.startPortalSigning(
        "work-order-1",
        "customer-1"
      )
    ).rejects.toMatchObject({
      response: {
        code: "STAGE2_PORTAL_SIGNING_URL_UNAVAILABLE",
        message: "The customer signing link is temporarily unavailable."
      },
      status: 502
    });
    expect(harness.prisma.contractESignSigner.updateMany).not.toHaveBeenCalled();
  });

  it("returns an already-signed projection instead of a URL when provider reports 3000", async () => {
    const harness = createHarness();
    const task = makeTask();
    Object.assign(task.signers[0]!, {
      signUrl: "https://sentinel.example/expired-stage2-sign",
      signUrlExpiresAt: new Date(NOW.getTime() - 1)
    });
    attachPortalTask(harness, task);
    harness.provider.querySignerStatus.mockResolvedValueOnce({
      resultCode: "3000",
      resultDescription: "completed",
      status: "SIGNED"
    });
    harness.transitions.reconcileCustomerSigned.mockImplementationOnce(
      async ({ completedAt }: { completedAt: Date }) => {
        Object.assign(task.signers[0]!, {
          signedAt: completedAt,
          signerStatus: ESignSignerStatus.SIGNED
        });
        task.taskStatus = ESignTaskStatus.SIGNING;
        Object.assign(harness.state.workOrder.handover, {
          customerSignedAt: completedAt,
          status: DeliveryHandoverStatus.PENDING_PLATFORM_SEAL
        });
      }
    );

    const result = await harness.service.startPortalSigning(
      "work-order-1",
      "customer-1"
    );

    expect(result).toEqual({
      alreadySigned: true,
      eSign: expect.objectContaining({
        customerSigner: expect.objectContaining({
          status: ESignSignerStatus.SIGNED
        }),
        status: ESignTaskStatus.SIGNING,
        taskId: "stage2-task-1"
      })
    });
    expect(harness.transitions.reconcileCustomerSigned).toHaveBeenCalledWith({
      completedAt: expect.any(Date),
      eSignTaskId: "stage2-task-1",
      providerTransactionId: "ESG20260726080000ABCDH1",
      queryResult: {
        resultCode: "3000",
        status: "SIGNED"
      },
      source: "QUERY"
    });
    expect(harness.provider.getSignerUrl).not.toHaveBeenCalled();
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
  });

  it.each([
    {
      customerStatus: ESignSignerStatus.SIGNED,
      name: "signed customer"
    },
    {
      customerStatus: ESignSignerStatus.REJECTED,
      name: "rejected customer"
    },
    {
      customerStatus: ESignSignerStatus.EXPIRED,
      name: "expired customer"
    },
    {
      name: "platform signed before customer",
      platformStatus: ESignSignerStatus.SIGNED
    }
  ])("does not call the provider for $name state", async ({
    customerStatus,
    platformStatus
  }) => {
    const harness = createHarness();
    const task = makeTask({ customerStatus, platformStatus });
    attachPortalTask(harness, task);

    await expect(
      harness.service.startPortalSigning("work-order-1", "customer-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_PORTAL_SIGNING_NOT_READY"
      })
    });

    expect(harness.provider.getSignerUrl).not.toHaveBeenCalled();
  });

  it("maps provider signing URL failures to a stable Portal-safe error", async () => {
    const harness = createHarness();
    const task = makeTask();
    attachPortalTask(harness, task);
    harness.provider.getSignerUrl.mockRejectedValueOnce(
      new Error(
        "FADADA_PROVIDER_SECRET rawResponse=https://unsafe.example/sign?token=secret"
      )
    );

    let caught: unknown;
    try {
      await harness.service.startPortalSigning(
        "work-order-1",
        "customer-1"
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      response: {
        code: "STAGE2_PORTAL_SIGNING_URL_UNAVAILABLE",
        message: "The customer signing link is temporarily unavailable."
      },
      status: 502
    });
    const serialized = JSON.stringify(caught).toLowerCase();
    for (const forbidden of [
      "fada",
      "provider_secret",
      "rawresponse",
      "unsafe.example",
      "token=secret"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(harness.prisma.contractESignTask.update).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignTask.updateMany).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignSigner.update).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignSigner.updateMany).toHaveBeenCalledTimes(2);
    expect(task.signers[0]).toMatchObject({
      signUrl: null,
      signUrlExpiresAt: null,
      snapshot: {
        portalSigningEntry: {
          claimToken: null,
          claimUntil: null,
          lastIssuedAt: null
        }
      }
    });
    expect(harness.prisma.subscriptionOrder.update).not.toHaveBeenCalled();
    expect(harness.prisma.vehicleDelivery.update).not.toHaveBeenCalled();
    expect(harness.prisma.leaseContract.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      env: {},
      name: "credential-bearing URL",
      signUrl: "https://user:secret@sentinel.example/stage2-sign"
    },
    {
      env: {},
      name: "unapproved host",
      signUrl: "https://wrong.example/stage2-sign"
    },
    {
      env: { NODE_ENV: "production" },
      name: "plain HTTP in production",
      signUrl: "http://sentinel.example/stage2-sign"
    }
  ])("rejects $name at the Portal signing response boundary", async ({
    env,
    signUrl
  }) => {
    const harness = createHarness(env as Record<string, string>);
    const task = makeTask();
    attachPortalTask(harness, task);
    harness.provider.getSignerUrl.mockResolvedValueOnce({ signUrl });

    await expect(
      harness.service.startPortalSigning("work-order-1", "customer-1")
    ).rejects.toMatchObject({
      response: {
        code: "STAGE2_PORTAL_SIGNING_URL_UNAVAILABLE",
        message: "The customer signing link is temporarily unavailable."
      },
      status: 502
    });
  });

  it.each([
    {
      mutate: (harness: ReturnType<typeof createHarness>, task: ReturnType<typeof makeTask>) => {
        harness.state.workOrder.order.customerId = "customer-other";
        harness.state.workOrder.order.customer.id = "customer-other";
        void task;
      },
      name: "unrelated customer ownership"
    },
    {
      mutate: (_harness: ReturnType<typeof createHarness>, task: ReturnType<typeof makeTask>) => {
        task.signers[0]!.customerId = "customer-other";
      },
      name: "customer signer ownership"
    },
    {
      mutate: (_harness: ReturnType<typeof createHarness>, task: ReturnType<typeof makeTask>) => {
        task.signers[0]!.providerTransactionId = null;
      },
      name: "customer provider transaction"
    },
    {
      mutate: (harness: ReturnType<typeof createHarness>, task: ReturnType<typeof makeTask>) => {
        harness.state.workOrder.handover.sourcePdfHash = "c".repeat(64);
        void task;
      },
      name: "current source binding"
    }
  ])("blocks Portal signing start when $name is invalid", async ({ mutate }) => {
    const harness = createHarness();
    const task = makeTask();
    attachPortalTask(harness, task);
    mutate(harness, task);

    await expect(
      harness.service.startPortalSigning("work-order-1", "customer-1")
    ).rejects.toBeInstanceOf(Error);

    expect(harness.provider.getSignerUrl).not.toHaveBeenCalled();
  });

  it("blocks Portal signing start when readiness has a new blocker", async () => {
    const harness = createHarness();
    const task = makeTask();
    attachPortalTask(harness, task);
    harness.readiness.getReadiness.mockResolvedValueOnce({
      blockers: [{
        code: "CUSTOMER_OBJECTION_ACTIVE",
        message: "The customer has an active handover objection."
      }],
      ready: false,
      state: {
        esignTaskId: task.id,
        esignTaskStatus: task.taskStatus,
        handoverContractId: "contract-stage2-1",
        handoverId: "handover-1",
        handoverStatus: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
        orderId: "order-1",
        orderStatus: "PENDING_DELIVERY",
        workOrderId: "work-order-1",
        workOrderStatus: "CUSTOMER_OBJECTED"
      }
    });

    await expect(
      harness.service.startPortalSigning("work-order-1", "customer-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_NOT_READY"
      })
    });
    expect(harness.provider.getSignerUrl).not.toHaveBeenCalled();
  });
});

describe("Stage 2 handover eSign Admin API contract", () => {
  it("exposes governed vehicle-registration exception routes with split request and approval permissions", () => {
    const prototype = HandoverWorkOrderAdminController.prototype;
    const expected = [
      [
        "getRegistrationException",
        "handover-work-orders/:id/registration-exception",
        RequestMethod.GET,
        [PermissionCode.DELIVERY_VIEW, PermissionCode.BUSINESS_EXCEPTION_VIEW]
      ],
      [
        "requestRegistrationException",
        "handover-work-orders/:id/registration-exception/request",
        RequestMethod.POST,
        [PermissionCode.DELIVERY_PREPARE, PermissionCode.BUSINESS_EXCEPTION_REQUEST]
      ],
      [
        "decideRegistrationException",
        "handover-work-orders/:id/registration-exception/:approvalId/decide",
        RequestMethod.POST,
        [PermissionCode.DELIVERY_CONFIRM, PermissionCode.BUSINESS_EXCEPTION_APPROVE]
      ]
    ] as const;

    for (const [methodName, path, method, permissions] of expected) {
      const handler = prototype[methodName];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual(permissions);
    }
  });

  it("requires one exact idempotency header before requesting a registration exception", async () => {
    const requestException = vi.fn(async () => ({ id: "approval-1" }));
    const handler = HandoverWorkOrderAdminController.prototype
      .requestRegistrationException as unknown as (
        this: object,
        id: string,
        dto: { reason: string },
        request: Record<string, unknown>
      ) => Promise<unknown>;
    const request = {
      headers: { "user-agent": "vitest" },
      ip: "127.0.0.1",
      rawHeaders: ["Idempotency-Key", "registration-request-1"],
      user: {
        id: "admin-1",
        permissions: [
          PermissionCode.DELIVERY_PREPARE,
          PermissionCode.BUSINESS_EXCEPTION_REQUEST
        ]
      }
    };

    await handler.call(
      { registrationExceptionService: { request: requestException } },
      "work-order-1",
      { reason: "registration unavailable" },
      request
    );
    expect(requestException).toHaveBeenCalledWith(
      "work-order-1",
      "registration unavailable",
      expect.objectContaining({ idempotencyKey: "registration-request-1" })
    );

    expect(() =>
      handler.call(
        { registrationExceptionService: { request: requestException } },
        "work-order-1",
        { reason: "registration unavailable" },
        {
          ...request,
          rawHeaders: [
            "Idempotency-Key",
            "registration-request-1",
            "Idempotency-Key",
            "registration-request-2"
          ]
        }
      )
    ).toThrow(expect.objectContaining({
      response: expect.objectContaining({
        code: "STAGE2_REGISTRATION_IDEMPOTENCY_KEY_REQUIRED"
      })
    }));
  });

  it("exposes only the five Admin routes with the required permissions and guards", () => {
    const prototype = HandoverWorkOrderAdminController.prototype;
    const expected = [
      [
        "getStage2ESign",
        "handover-work-orders/:id/esign",
        RequestMethod.GET,
        PermissionCode.DELIVERY_VIEW
      ],
      [
        "createStage2ESign",
        "handover-work-orders/:id/esign",
        RequestMethod.POST,
        PermissionCode.DELIVERY_CONFIRM
      ],
      [
        "retryStage2PlatformSeal",
        "handover-work-orders/:id/esign/platform-seal/retry",
        RequestMethod.POST,
        PermissionCode.DELIVERY_CONFIRM
      ],
      [
        "voidStage2ESign",
        "handover-work-orders/:id/esign/void",
        RequestMethod.POST,
        PermissionCode.DELIVERY_CONFIRM
      ],
      [
        "getStage2SignedDocument",
        "handover-work-orders/:id/esign/signed-document",
        RequestMethod.GET,
        PermissionCode.DELIVERY_VIEW
      ],
      [
        "downloadStage2SignedDocument",
        "handover-work-orders/:id/esign/signed-document/download",
        RequestMethod.GET,
        PermissionCode.DELIVERY_VIEW
      ]
    ] as const;

    expect(
      Reflect.getMetadata(GUARDS_METADATA, HandoverWorkOrderAdminController)
    ).toEqual([AuthGuard, PermissionsGuard]);
    for (const [methodName, path, method, permission] of expected) {
      const handler = prototype[methodName];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([permission]);
    }

    const fieldPrototype =
      HandoverWorkOrderFieldController.prototype as unknown as Record<string, unknown>;
    const portalPrototype =
      PortalHandoverReviewController.prototype as unknown as Record<string, unknown>;
    for (const [methodName] of expected) {
      expect(fieldPrototype[methodName]).toBeUndefined();
      expect(portalPrototype[methodName]).toBeUndefined();
    }
  });

  it("passes the exact Admin fallback acknowledgement to the workflow service", async () => {
    const create = vi.fn().mockResolvedValue({ taskId: "stage2-task-1" });
    const dto = adminFallbackReview();
    const request = {
      user: {
        id: "admin-1"
      }
    };

    await (
      HandoverWorkOrderAdminController.prototype.createStage2ESign as unknown as (
        this: object,
        id: string,
        body: typeof dto,
        request: {
          user: {
            id: string;
          };
        }
      ) => Promise<unknown>
    ).call(
      {
        stage2HandoverESignService: {
          create
        }
      },
      "work-order-1",
      dto,
      request
    );

    expect(create).toHaveBeenCalledWith(
      "work-order-1",
      {
        actorId: "admin-1",
        actorType: "ADMIN_FALLBACK"
      },
      dto
    );
  });
});

describe("Stage 2 handover eSign Portal API contract", () => {
  it("exposes only status GET and intentional signing-start POST under the Portal guard", () => {
    const prototype = PortalHandoverReviewController.prototype;
    const expected = [
      ["getESignStatus", ":id/esign", RequestMethod.GET],
      ["startESignSigning", ":id/esign/signing/start", RequestMethod.POST]
    ] as const;

    for (const [methodName, path, method] of expected) {
      const handler = prototype[methodName];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    }

    const fieldPrototype =
      HandoverWorkOrderFieldController.prototype as unknown as Record<string, unknown>;
    const adminPrototype =
      HandoverWorkOrderAdminController.prototype as unknown as Record<string, unknown>;
    for (const [methodName] of expected) {
      expect(fieldPrototype[methodName]).toBeUndefined();
      expect(adminPrototype[methodName]).toBeUndefined();
    }
  });
});

function createHarness(env: Record<string, string> = {}) {
  const auditLogs: any[] = [];
  let databaseNow = NOW;
  let sourceFileCreatedAt = NOW;
  let transactionDepth = 0;
  let transactionalReadinessError: Error | null = null;
  const state: {
    activeTask: null | ReturnType<typeof makeTask>;
    workOrder: ReturnType<typeof makeWorkOrder>;
  } = {
    activeTask: null,
    workOrder: makeWorkOrder()
  };

  const readiness = {
    assertReady: vi.fn(async (_workOrderId: string, client?: unknown) => {
      if (
        client &&
        transactionDepth > 0 &&
        transactionalReadinessError
      ) {
        throw transactionalReadinessError;
      }
      return {
        blockers: [],
        ready: true,
        state: {
          esignTaskId: null,
          esignTaskStatus: null,
          handoverContractId: "contract-stage2-1",
          handoverId: "handover-1",
          handoverStatus: DeliveryHandoverStatus.SOURCE_GENERATED,
          orderId: "order-1",
          orderStatus: "PENDING_DELIVERY",
          workOrderId: "work-order-1",
          workOrderStatus: "CUSTOMER_CONFIRMED"
        }
      };
    }),
    getReadiness: vi.fn(async (): Promise<Stage2HandoverESignReadiness> => ({
      blockers: [],
      ready: true,
      state: {
        esignTaskId: state.activeTask?.id ?? null,
        esignTaskStatus: state.activeTask?.taskStatus ?? null,
        handoverContractId: "contract-stage2-1",
        handoverId: "handover-1",
        handoverStatus: state.workOrder.handover.status,
        orderId: "order-1",
        orderStatus: "PENDING_DELIVERY",
        workOrderId: "work-order-1",
        workOrderStatus: "CUSTOMER_CONFIRMED"
      }
    }))
  };

  const provider = {
    autoSealTask: vi.fn(async (input: any): Promise<any> => ({
      coveredSlotIds: ["STAGE2_HANDOVER_PLATFORM"],
      providerActionType: "PLATFORM_AUTO_SEAL",
      providerSignerId: input.transactionId,
      providerTransactionId: input.transactionId,
      rawResponse: {
        resultCode: "3001",
        unsafeUrl: "https://unsafe.example/provider"
      },
      resultCode: "3001",
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      status: "PENDING"
    })),
    createSignTask: vi.fn(async (input: any): Promise<any> => ({
      actions: [{
        coveredSlotIds: ["STAGE2_HANDOVER_CUSTOMER"],
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerSignerId: input.transactionId,
        providerTransactionId: input.transactionId,
        signUrl: "https://unsafe.example/sign?token=secret",
        signUrlExpiresAt: new Date("2026-07-26T08:30:00.000Z"),
        signerType: "CUSTOMER",
        signingStage: "STAGE2_DELIVERY_HANDOVER"
      }],
      providerEnvelopeId: "provider-envelope-1",
      providerTaskId: input.transactionId,
      rawResponse: {
        objectKey: "private/source.pdf",
        signUrl: "https://unsafe.example/sign?token=secret"
      }
    })),
    getSignerUrl: vi.fn(),
    querySignerStatus: vi.fn(
      async (): Promise<ESignProviderSignerStatusResult> => ({
        resultCode: "1000",
        resultDescription: "active",
        status: "SIGNING"
      })
    ),
    verifyCallback: vi.fn()
  };

  const prisma: any = {
    $queryRaw: vi.fn(async () => [{ now: databaseNow }]),
    $transaction: vi.fn(async (
      operation: (tx: any) => Promise<unknown>,
      options?: { isolationLevel?: string }
    ) => {
      void options;
      transactionDepth += 1;
      try {
        return await operation(prisma);
      } finally {
        transactionDepth -= 1;
      }
    }),
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        if (transactionDepth === 0) {
          throw new Error("Stage 2 void audit must be transactional");
        }
        auditLogs.push(data);
        return data;
      })
    },
    contract: {
      updateMany: vi.fn(async ({ data, where }: any) => {
        const contract = state.workOrder.handover.handoverContract;
        if (contract.id !== where.id || contract.status !== where.status) {
          return { count: 0 };
        }
        Object.assign(contract, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(state.workOrder.handover.handoverContract, data);
        return state.workOrder.handover.handoverContract;
      })
    },
    fileObject: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id !== state.workOrder.handover.sourceDocumentFileId) {
          return null;
        }
        return {
          createdAt: sourceFileCreatedAt,
          id: where.id
        };
      })
    },
    contractESignSigner: {
      findFirst: vi.fn(async ({ where }: any) => {
        const task = state.workOrder.handover.handoverESignTask ?? state.activeTask;
        return task?.signers.find((item: any) => matchesSignerWhere(item, where)) ?? null;
      }),
      update: vi.fn(async ({ data, where }: any) => {
        const task = state.workOrder.handover.handoverESignTask ?? state.activeTask;
        const signer = task?.signers.find((item: any) => item.id === where.id);
        if (signer) {
          Object.assign(signer, data);
        }
        return signer ?? { id: where.id, ...data };
      }),
      updateMany: vi.fn(async ({ data, where }: any) => {
        const task = state.workOrder.handover.handoverESignTask ?? state.activeTask;
        const signer = task?.signers.find((item: any) =>
          matchesSignerWhere(item, where)
        );
        if (signer) {
          applyUpdateData(signer, data);
        }
        return { count: signer ? 1 : 0 };
      })
    },
    contractESignTask: {
      create: vi.fn(async ({ data }: any) => {
        const task = makeTaskFromCreateData(data);
        state.workOrder.handover.handoverESignTask = task;
        return task;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const task = state.activeTask;
        if (
          !task ||
          (where?.contractId !== undefined &&
            where.contractId !== task.contractId) ||
          (where?.signingStage !== undefined &&
            where.signingStage !== task.signingStage) ||
          (where?.deletedAt !== undefined &&
            where.deletedAt !== (task.deletedAt ?? null)) ||
          (
            where?.taskStatus !== undefined &&
            where.taskStatus !== task.taskStatus &&
            !where.taskStatus.in?.includes(task.taskStatus)
          )
        ) {
          return null;
        }
        return task;
      }),
      updateMany: vi.fn(async ({ data, where }: any) => {
        const task = state.workOrder.handover.handoverESignTask ?? state.activeTask;
        if (
          !task ||
          (where?.id !== undefined && where.id !== task.id) ||
          (where?.signingStage !== undefined &&
            where.signingStage !== task.signingStage) ||
          (where?.documentType !== undefined &&
            where.documentType !== task.documentType) ||
          (where?.completedAt !== undefined &&
            where.completedAt !== task.completedAt) ||
          (where?.providerTaskId !== undefined &&
            where.providerTaskId !== task.providerTaskId) ||
          (where?.signers?.none &&
            task.signers.some((signer: any) =>
              matchesSignerWhere(signer, where.signers.none)
            )) ||
          (where?.taskStatus &&
            where.taskStatus !== task.taskStatus &&
            !where.taskStatus.in?.includes(task.taskStatus))
        ) {
          return { count: 0 };
        }
        Object.assign(task, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: any) => {
        const task = state.workOrder.handover.handoverESignTask ?? state.activeTask;
        if (task) {
          Object.assign(task, data);
        }
        return task;
      })
    },
    customerESignProviderAccount: {
      findFirst: vi.fn(async () => ({
        providerCustomerId: "fadada-customer-1"
      }))
    },
    leaseContract: {
      create: vi.fn()
    },
    subscriptionOrder: {
      update: vi.fn()
    },
    user: {
      findFirst: vi.fn(async () => ({
        deletedAt: null,
        id: "field-user-1",
        mobile: "13800000000",
        status: UserStatus.ACTIVE
      }))
    },
    vehicleDelivery: {
      update: vi.fn()
    },
    vehicleDeliveryHandover: {
      updateMany: vi.fn(async ({ data, where }: any) => {
        const handover = state.workOrder.handover;
        if (
          (where?.id !== undefined && where.id !== handover.id) ||
          (where?.artifactVersion !== undefined &&
            where.artifactVersion !== handover.artifactVersion) ||
          (where?.handoverContractId !== undefined &&
            where.handoverContractId !== handover.handoverContractId) ||
          (where?.manifestHash !== undefined &&
            where.manifestHash !== handover.manifestHash) ||
          (where?.sourceDocumentFileId !== undefined &&
            where.sourceDocumentFileId !== handover.sourceDocumentFileId) ||
          (where?.sourceObjectKey !== undefined &&
            where.sourceObjectKey !== handover.sourceObjectKey) ||
          (where?.sourcePdfHash !== undefined &&
            where.sourcePdfHash !== handover.sourcePdfHash) ||
          (where?.status !== undefined &&
            (
              typeof where.status === "object"
                ? !where.status.in?.includes(handover.status)
                : where.status !== handover.status
            )) ||
          where?.handoverESignTaskId !== undefined &&
          where.handoverESignTaskId !==
            handover.handoverESignTaskId
        ) {
          return { count: 0 };
        }
        Object.assign(handover, data);
        return { count: 1 };
      })
    },
    vehicleHandoverWorkOrder: {
      findUnique: vi.fn(async () => state.workOrder)
    }
  };

  const config = new ConfigService({
    API_BASE_URL: "http://localhost:3001/api",
    ESIGN_SIGN_URL_ALLOWED_HOSTS: "unsafe.example,sentinel.example",
    ESIGN_PROVIDER: "fadada",
    FADADA_BASE_URL: "https://unsafe.example/api/",
    FADADA_PLATFORM_CUSTOMER_ID: "platform-customer-1",
    FADADA_PLATFORM_SIGNATURE_ID: "platform-signature-1",
    PORTAL_BASE_URL: "http://localhost:3000",
    ...env
  });
  const notification = {
    notifyCustomer: vi.fn()
  };
  const customerJobs = new Map<string, string>();
  let customerJobEnqueueFailuresRemaining = 0;
  const workflow = {
    enqueueCustomerAcceptanceRecovery: vi.fn(async (
      tx: unknown,
      input: {
        customerTransactionId: string;
        eSignTaskId: string;
      }
    ) => {
      if (tx !== prisma || transactionDepth === 0) {
        throw new Error(
          "customer acceptance recovery was not enqueued transactionally"
        );
      }
      customerJobs.set(
        `customer-reconcile:${input.eSignTaskId}:${input.customerTransactionId}`,
        "RECONCILE_CUSTOMER_SIGNATURE"
      );
    }),
    enqueueCustomerESignJobs: vi.fn(async (
      tx: unknown,
      input: {
        customerTransactionId: string;
        eSignTaskId: string;
      }
    ) => {
      if (tx !== prisma || transactionDepth === 0) {
        throw new Error("customer eSign jobs were not enqueued transactionally");
      }
      if (customerJobEnqueueFailuresRemaining > 0) {
        customerJobEnqueueFailuresRemaining -= 1;
        throw new Error(
          "customer reconciliation job insert failed transactionally"
        );
      }
      customerJobs.set(
        `customer-notify:${input.eSignTaskId}:${input.customerTransactionId}`,
        "NOTIFY_CUSTOMER_ESIGN_READY"
      );
      customerJobs.set(
        `customer-reconcile:${input.eSignTaskId}:${input.customerTransactionId}`,
        "RECONCILE_CUSTOMER_SIGNATURE"
      );
    })
  };
  const transitions = {
    reconcileCustomerSigned: vi.fn(),
    reconcilePlatformSigned: vi.fn()
  };
  const generatePdf = vi.fn();
  const service = new Stage2HandoverESignService(
    prisma,
    readiness as never,
    provider as never,
    config,
    undefined,
    workflow as never
  );
  Object.assign(service as object, {
    eSignService: transitions
  });

  return {
    auditLogs,
    customerJobs,
    failCustomerJobEnqueues(count: number) {
      customerJobEnqueueFailuresRemaining = count;
    },
    failTransactionalReadiness(error: Error) {
      transactionalReadinessError = error;
    },
    generatePdf,
    notification,
    prisma,
    provider,
    readiness,
    setDatabaseTime(value: Date) {
      databaseNow = value;
    },
    setSourceFileCreatedAt(value: Date) {
      sourceFileCreatedAt = value;
    },
    service,
    state,
    transitions,
    workflow
  };
}

function makeWorkOrder() {
  return {
    handover: {
      archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED,
      archivedAt: null,
      artifactVersion: 3,
      completedAt: null as Date | null,
      customerSignedAt: null,
      handoverContract: {
        contractSnapshot: {
          stage2HandoverPdfArtifact: {
            artifactKind: "stage2-handover-pdf-source",
            documentType: "DELIVERY_HANDOVER",
            fileId: "file-stage2-1",
            pageCount: 4,
            signingStage: "STAGE2_DELIVERY_HANDOVER",
            slotCoordinates: [
              stage2Slot("STAGE2_HANDOVER_CUSTOMER"),
              stage2Slot("STAGE2_HANDOVER_PLATFORM")
            ]
          }
        },
        contractTitle: "车辆交接确认单",
        createdAt: NOW,
        fileId: "file-stage2-1" as null | string,
        id: "contract-stage2-1",
        status: "GENERATED",
        updatedAt: NOW
      },
      handoverContractId: "contract-stage2-1",
      handoverESignTask: null as null | ReturnType<typeof makeTask>,
      handoverESignTaskId: null as null | string,
      id: "handover-1",
      manifestHash: "a".repeat(64),
      platformSignedAt: null as Date | null,
      signedDocumentFileId: null as null | string,
      signedObjectKey: null as null | string,
      signedPdfHash: null as null | string,
      sourceDocumentFileId: "file-stage2-1" as null | string,
      sourceObjectKey: "private/stage2/source-1.pdf",
      sourcePdfHash: "b".repeat(64),
      status: DeliveryHandoverStatus.SOURCE_GENERATED as DeliveryHandoverStatus,
      updatedAt: NOW
    },
    assignedInternalUserId: "field-user-1",
    fieldOperatorPhone: "13800000000",
    handoverId: "handover-1",
    id: "work-order-1",
    order: {
      customer: {
        id: "customer-1",
        mobile: "13800138000",
        name: "Customer Name"
      },
      customerId: "customer-1",
      id: "order-1",
      orderNo: "ORD-1",
      orderStatus: OrderStatus.PENDING_DELIVERY as OrderStatus
    },
    operatorType: VehicleHandoverOperatorType.INTERNAL,
    orderId: "order-1",
    status:
      VehicleHandoverWorkOrderStatus.CUSTOMER_CONFIRMED as VehicleHandoverWorkOrderStatus
  };
}

function adminInitiator() {
  return {
    actorId: "admin-1",
    actorType: "ADMIN" as const
  };
}

function adminFallbackInitiator() {
  return {
    actorId: "admin-1",
    actorType: "ADMIN_FALLBACK" as const
  };
}

function adminFallbackReview(
  overrides: {
    acknowledgement?: boolean;
    artifactVersion?: number;
    reason?: string;
    sourcePdfHash?: string;
  } = {}
): any {
  return {
    acknowledgement: true as const,
    artifactVersion: 3,
    reason: "Field 经办人超过十五分钟未推进",
    sourcePdfHash: "b".repeat(64),
    ...overrides
  };
}

function fieldInitiator() {
  return {
    actorType: "FIELD_OPERATOR" as const,
    fieldOperatorPhone: "13800000000",
    fieldOperatorSessionId: "field-session-1"
  };
}

function fieldReview() {
  return {
    acknowledgement: true as const,
    artifactVersion: 3,
    sourcePdfHash: "b".repeat(64)
  };
}

function expectCustomerWorkflowJobs(
  harness: ReturnType<typeof createHarness>
) {
  expect(harness.customerJobs.size).toBe(2);
  expect(
    harness.customerJobs.get(
      "customer-notify:stage2-task-1:ESG20260726080000ABCDH1"
    )
  ).toBe("NOTIFY_CUSTOMER_ESIGN_READY");
  expect(
    harness.customerJobs.get(
      "customer-reconcile:stage2-task-1:ESG20260726080000ABCDH1"
    )
  ).toBe("RECONCILE_CUSTOMER_SIGNATURE");
}

function swapStage2SourceArtifact(
  harness: ReturnType<typeof createHarness>,
  input: {
    artifactVersion: number;
    fileId: string;
    manifestHash: string;
    sourceObjectKey: string;
    sourcePdfHash: string;
  }
) {
  const handover = harness.state.workOrder.handover;
  handover.artifactVersion = input.artifactVersion;
  handover.handoverContract.fileId = input.fileId;
  handover.manifestHash = input.manifestHash;
  handover.sourceDocumentFileId = input.fileId;
  handover.sourceObjectKey = input.sourceObjectKey;
  handover.sourcePdfHash = input.sourcePdfHash;
  handover.handoverContract.contractSnapshot.stage2HandoverPdfArtifact.fileId =
    input.fileId;
}

function makeTask(
  options: {
    customerStatus?: ESignSignerStatus;
    platformStatus?: ESignSignerStatus;
    taskStatus?: ESignTaskStatus;
  } = {}
): any {
  return {
    cancelledAt: null,
    completedAt: null as Date | null,
    contractId: "contract-stage2-1",
    createdAt: NOW,
    customerId: "customer-1",
    documentObjectKey: null,
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    errorSnapshot: null,
    failedAt: null,
    id: "stage2-task-1",
    orderId: "order-1",
    provider: ESignProviderType.FADADA,
    providerEnvelopeId: "provider-envelope-1",
    providerTaskId: "ESG20260726080000ABCDH1",
    requestSnapshot: {
      artifactVersion: 3,
      contractId: "contract-stage2-1",
      handoverId: "handover-1",
      manifestHash: "a".repeat(64),
      sourceDocumentFileId: "file-stage2-1",
      sourcePdfHash: "b".repeat(64)
    } as unknown,
    responseSnapshot: null,
    signUrl: null,
    signers: [
      {
        ...makeSigner("CUSTOMER"),
        signerStatus: options.customerStatus ?? ESignSignerStatus.SIGNING
      },
      {
        ...makeSigner("PLATFORM"),
        signerStatus: options.platformStatus ?? ESignSignerStatus.PENDING
      }
    ],
    signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
    startedAt: NOW,
    taskNo: "ESG20260726080000ABCD",
    taskStatus: options.taskStatus ?? ESignTaskStatus.WAITING_CUSTOMER,
    updatedAt: NOW
  };
}

function clearVoidBlockingEvidence(task: ReturnType<typeof makeTask>) {
  task.providerTaskId = null;
  for (const signer of task.signers) {
    signer.claimExpiresAt = null;
    signer.providerTransactionId = null;
    signer.signedAt = null;
  }
}

function makeTaskFromCreateData(
  data: any,
  taskId = data.id ?? "stage2-task-1"
) {
  const task = makeTask({
    taskStatus: data.taskStatus
  });
  task.id = taskId;
  task.taskNo = data.taskNo;
  task.contractId = data.contractId;
  task.customerId = data.customerId;
  task.documentType = data.documentType;
  task.orderId = data.orderId;
  task.provider = data.provider;
  task.requestSnapshot = data.requestSnapshot;
  task.signingStage = data.signingStage;
  task.signers = data.signers.create.map((signer: any, index: number) => ({
    ...makeSigner(index === 0 ? "CUSTOMER" : "PLATFORM"),
    providerTransactionId: null,
    ...signer,
    id: index === 0
      ? taskId === "stage2-task-1"
        ? "stage2-customer-signer-1"
        : `${taskId}-customer-signer`
      : taskId === "stage2-task-1"
        ? "stage2-platform-signer-1"
        : `${taskId}-platform-signer`,
    taskId
  }));
  return task;
}

function attachPortalTask(
  harness: ReturnType<typeof createHarness>,
  task: ReturnType<typeof makeTask>
) {
  harness.state.activeTask = task;
  harness.state.workOrder.handover.handoverContract.status =
    ContractStatus.SIGNING;
  harness.state.workOrder.handover.handoverESignTask = task;
  harness.state.workOrder.handover.handoverESignTaskId = task.id;
  harness.state.workOrder.handover.status =
    DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE;
}

function makeSigner(type: "CUSTOMER" | "PLATFORM"): any {
  const customer = type === "CUSTOMER";
  return {
    attemptCount: 0,
    claimExpiresAt: null,
    customerId: customer ? "customer-1" : null,
    deletedAt: null as null | Date,
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    id: customer ? "stage2-customer-signer-1" : "stage2-platform-signer-1",
    lastAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    nextRetryAt: null,
    providerActionType: customer
      ? ESignProviderActionType.CUSTOMER_MANUAL_SIGN
      : ESignProviderActionType.PLATFORM_AUTO_SEAL,
    providerTransactionId: customer
      ? "ESG20260726080000ABCDH1"
      : null,
    required: true,
    signedAt: null,
    signUrl: null as null | string,
    signUrlExpiresAt: null as null | Date,
    signerStatus: customer
      ? ESignSignerStatus.SIGNING
      : ESignSignerStatus.PENDING,
    signerType: customer ? ESignSignerType.CUSTOMER : ESignSignerType.PLATFORM,
    slotId: customer ? CUSTOMER_SLOT : PLATFORM_SLOT,
    snapshot: null,
    taskId: "stage2-task-1",
    updatedAt: NOW
  };
}

function stage2Slot(
  slotId: "STAGE2_HANDOVER_CUSTOMER" | "STAGE2_HANDOVER_PLATFORM"
) {
  return {
    coordinateSource: "PDFKIT_RENDERER",
    coordinateSystem: "FADADA_800_1131_TOP_LEFT",
    documentType: "DELIVERY_HANDOVER",
    height: 90,
    pageNumber: 3,
    pdfPageHeight: 841.89,
    pdfPageWidth: 595.28,
    signingStage: "STAGE2_DELIVERY_HANDOVER",
    slotId,
    width: 180,
    x: slotId === "STAGE2_HANDOVER_CUSTOMER" ? 220 : 580,
    y: 980
  };
}

function matchesSignerWhere(
  signer: ReturnType<typeof makeSigner>,
  where: Record<string, any>
): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "AND") {
      return (expected as Array<Record<string, any>>).every((item) =>
        matchesSignerWhere(signer, item)
      );
    }
    if (key === "OR") {
      return (expected as Array<Record<string, any>>).some((item) =>
        matchesSignerWhere(signer, item)
      );
    }
    const actual = (signer as Record<string, any>)[key];
    if (expected instanceof Date) {
      return actual instanceof Date &&
        actual.getTime() === expected.getTime();
    }
    if (
      expected &&
      typeof expected === "object" &&
      !(expected instanceof Date)
    ) {
      if ("gt" in expected) {
        return actual instanceof Date && actual > expected.gt;
      }
      if ("lt" in expected) {
        return actual instanceof Date && actual < expected.lt;
      }
      if ("in" in expected) {
        return expected.in.includes(actual);
      }
      if ("equals" in expected) {
        const expectedValue = expected.equals;
        if (expectedValue === Prisma.DbNull) {
          return actual === null;
        }
        return JSON.stringify(actual) === JSON.stringify(expectedValue);
      }
      if ("not" in expected) {
        return actual !== expected.not;
      }
    }
    return actual === expected;
  });
}

function applyUpdateData(
  target: Record<string, any>,
  data: Record<string, any>
) {
  for (const [key, value] of Object.entries(data)) {
    if (
      value &&
      typeof value === "object" &&
      "increment" in value
    ) {
      target[key] = Number(target[key] ?? 0) + Number(value.increment);
    } else {
      target[key] = value;
    }
  }
}
