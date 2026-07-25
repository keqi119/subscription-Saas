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
  ESignTaskStatus
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
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
import {
  HandoverWorkOrderAdminController,
  HandoverWorkOrderFieldController
} from "../src/handover-work-order/handover-work-order.controller";
import {
  STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED,
  STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED,
  Stage2HandoverESignService
} from "../src/handover-work-order/stage2-handover-esign.service";
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
      harness.service.create("work-order-1", "admin-1")
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
      harness.service.create("work-order-1", "admin-1")
    ).rejects.toThrow("HANDOVER_SOURCE_NOT_GENERATED");

    expect(harness.generatePdf).not.toHaveBeenCalled();
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
  });

  it("creates one typed Stage 2 task and exactly two one-slot signer rows", async () => {
    const harness = createHarness();

    const result = await harness.service.create("work-order-1", "admin-1");

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

  it("generates a new task number when a P2002 create collision is retried", async () => {
    const harness = createHarness();
    businessNumberMocks.createBusinessNo
      .mockReturnValueOnce("ESG20260726080000AAAA")
      .mockReturnValueOnce("ESG20260726080000BBBB");
    harness.prisma.contractESignTask.create.mockRejectedValueOnce(
      Object.assign(new Error("task number collision"), { code: "P2002" })
    );

    await harness.service.create("work-order-1", "admin-1");

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

    await harness.service.create("work-order-1", "admin-1");

    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
    const providerInput =
      (harness.provider.createSignTask.mock.calls as any[][])[0]?.[0];
    expect(providerInput).toMatchObject({
      contractId: "contract-stage2-1",
      documentType: "DELIVERY_HANDOVER_CONFIRMATION",
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      taskId: "stage2-task-1"
    });
    expect(providerInput.signingSlots).toEqual([
      expect.objectContaining({
        documentType: "DELIVERY_HANDOVER_CONFIRMATION",
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

  it("persists the customer provider transaction only on the typed Stage 2 signer", async () => {
    const harness = createHarness();

    await harness.service.create("work-order-1", "admin-1");

    expect(harness.prisma.contractESignSigner.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerTransactionId: "ESG20260726080000ABCDH1",
          signerStatus: ESignSignerStatus.SIGNING
        }),
        where: { id: "stage2-customer-signer-1" }
      })
    );
    expect(harness.prisma.contractESignSigner.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "stage1-signer-1" }
      })
    );
    expect(harness.prisma.contractESignSigner.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "stage2-platform-signer-1" }
      })
    );
  });

  it("does not revive a task voided while customer provider creation is in flight", async () => {
    const harness = createHarness();
    harness.provider.createSignTask.mockImplementationOnce(async (): Promise<any> => {
      const task = harness.state.workOrder.handover.handoverESignTask!;
      task.taskStatus = ESignTaskStatus.CANCELLED;
      harness.state.workOrder.handover.handoverESignTaskId = null;
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
      harness.service.create("work-order-1", "admin-1")
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
      harness.service.create("work-order-1", "admin-1")
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

  it("returns the existing active task without readiness, persistence, or provider calls", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });
    harness.state.activeTask = task;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;

    const result = await harness.service.create("work-order-1", "admin-1");

    expect(result.taskId).toBe("stage2-task-1");
    expect(harness.readiness.assertReady).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
  });

  it("rejects an active contract task whose handover pointer is missing", async () => {
    const harness = createHarness();
    harness.state.activeTask = makeTask({
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });

    await expect(
      harness.service.create("work-order-1", "admin-1")
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
      harness.service.create("work-order-1", "admin-1")
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
      harness.service.create("work-order-1", "admin-1")
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
    harness.state.workOrder.handover.handoverESignTask = makeTask({
      taskStatus: ESignTaskStatus.FAILED
    });
    harness.state.workOrder.handover.handoverESignTaskId = "stage2-task-1";

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
      rebuildRequired: false,
      taskId: null
    });
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
  });

  it("restores only the Stage 2 source contract to GENERATED during void", async () => {
    const harness = createHarness();
    const task = makeTask({
      taskStatus: ESignTaskStatus.EXPIRED
    });
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
      taskStatus: ESignTaskStatus.SIGNING,
      customerStatus: ESignSignerStatus.SIGNED
    });
    harness.state.workOrder.handover.handoverContract.status =
      ContractStatus.SIGNING;
    harness.state.workOrder.handover.handoverESignTask = task;
    harness.state.workOrder.handover.handoverESignTaskId = task.id;
    harness.state.workOrder.handover.status =
      DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;
    harness.prisma.$transaction.mockImplementationOnce(
      async (operation: (tx: any) => Promise<unknown>) => {
        task.taskStatus = ESignTaskStatus.COMPLETED;
        task.completedAt = NOW;
        task.signers[1]!.signerStatus = ESignSignerStatus.SIGNED;
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
        code: "STAGE2_HANDOVER_ESIGN_VOID_NOT_ALLOWED"
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
      signedArtifactAvailable: true,
      taskId: "stage2-task-1"
    });
    expect(signedDocument).toEqual(
      expect.objectContaining({
        archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED,
        available: true,
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

  it("returns only a short-lived URL and expiry from the explicit Portal start action", async () => {
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
      contractId: "contract-stage2-1",
      providerTaskId: "ESG20260726080000ABCDH1",
      redirectUrl:
        "http://localhost:3000/portal/handover-reviews/work-order-1",
      signerId: "stage2-customer-signer-1",
      taskId: "stage2-task-1"
    });
    expect(harness.prisma.contractESignTask.update).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignTask.updateMany).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignSigner.update).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignSigner.updateMany).not.toHaveBeenCalled();
    expect(harness.prisma.subscriptionOrder.update).not.toHaveBeenCalled();
    expect(harness.prisma.vehicleDelivery.update).not.toHaveBeenCalled();
    expect(harness.prisma.leaseContract.create).not.toHaveBeenCalled();
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

function createHarness() {
  const state: {
    activeTask: null | ReturnType<typeof makeTask>;
    workOrder: ReturnType<typeof makeWorkOrder>;
  } = {
    activeTask: null,
    workOrder: makeWorkOrder()
  };

  const readiness = {
    assertReady: vi.fn(async () => ({
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
    })),
    getReadiness: vi.fn(async () => ({
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
    autoSealTask: vi.fn(async () => ({
      coveredSlotIds: ["STAGE2_HANDOVER_PLATFORM"],
      providerActionType: "PLATFORM_AUTO_SEAL",
      providerSignerId: "ESG20260726080000ABCDH2",
      providerTransactionId: "ESG20260726080000ABCDH2",
      rawResponse: {
        resultCode: "3001",
        unsafeUrl: "https://unsafe.example/provider"
      },
      resultCode: "3001",
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      status: "PENDING"
    })),
    createSignTask: vi.fn(async () => ({
      actions: [{
        coveredSlotIds: ["STAGE2_HANDOVER_CUSTOMER"],
        providerActionType: "CUSTOMER_MANUAL_SIGN",
        providerSignerId: "ESG20260726080000ABCDH1",
        providerTransactionId: "ESG20260726080000ABCDH1",
        signUrl: "https://unsafe.example/sign?token=secret",
        signUrlExpiresAt: new Date("2026-07-26T08:30:00.000Z"),
        signerType: "CUSTOMER",
        signingStage: "STAGE2_DELIVERY_HANDOVER"
      }],
      providerEnvelopeId: "provider-envelope-1",
      providerTaskId: "ESG20260726080000ABCDH1",
      rawResponse: {
        objectKey: "private/source.pdf",
        signUrl: "https://unsafe.example/sign?token=secret"
      }
    })),
    getSignerUrl: vi.fn(),
    verifyCallback: vi.fn()
  };

  const prisma: any = {
    $transaction: vi.fn(async (operation: (tx: any) => Promise<unknown>) => operation(prisma)),
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
    contractESignSigner: {
      update: vi.fn(async ({ data, where }: any) => {
        const task = state.workOrder.handover.handoverESignTask ?? state.activeTask;
        const signer = task?.signers.find((item) => item.id === where.id);
        if (signer) {
          Object.assign(signer, data);
        }
        return signer ?? { id: where.id, ...data };
      }),
      updateMany: vi.fn(async ({ data, where }: any) => {
        const task = state.workOrder.handover.handoverESignTask ?? state.activeTask;
        const signer = task?.signers.find((item) => item.id === where?.id);
        if (
          signer &&
          where?.claimExpiresAt !== undefined &&
          where.claimExpiresAt !== signer.claimExpiresAt
        ) {
          return { count: 0 };
        }
        if (signer) {
          Object.assign(signer, data);
        }
        return { count: 1 };
      })
    },
    contractESignTask: {
      create: vi.fn(async ({ data }: any) => {
        const task = makeTask({
          taskStatus: data.taskStatus
        });
        task.id = data.id ?? task.id;
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
          ...signer,
          id: index === 0
            ? "stage2-customer-signer-1"
            : "stage2-platform-signer-1",
          taskId: task.id
        }));
        state.workOrder.handover.handoverESignTask = task;
        return task;
      }),
      findFirst: vi.fn(async () => state.activeTask),
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
    leaseContract: {
      create: vi.fn()
    },
    subscriptionOrder: {
      update: vi.fn()
    },
    vehicleDelivery: {
      update: vi.fn()
    },
    vehicleDeliveryHandover: {
      updateMany: vi.fn(async ({ data, where }: any) => {
        const handover = state.workOrder.handover;
        if (
          (where?.id !== undefined && where.id !== handover.id) ||
          (where?.handoverContractId !== undefined &&
            where.handoverContractId !== handover.handoverContractId) ||
          (where?.sourceDocumentFileId !== undefined &&
            where.sourceDocumentFileId !== handover.sourceDocumentFileId) ||
          (where?.status !== undefined && where.status !== handover.status) ||
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
    ESIGN_PROVIDER: "fadada",
    FADADA_PLATFORM_CUSTOMER_ID: "platform-customer-1",
    FADADA_PLATFORM_SIGNATURE_ID: "platform-signature-1",
    PORTAL_BASE_URL: "http://localhost:3000"
  });
  const notification = {
    notifyCustomer: vi.fn()
  };
  const generatePdf = vi.fn();
  const service = new Stage2HandoverESignService(
    prisma,
    readiness as never,
    provider as never,
    config
  );

  return {
    generatePdf,
    notification,
    prisma,
    provider,
    readiness,
    service,
    state
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
            documentType: "DELIVERY_HANDOVER_CONFIRMATION",
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
      sourceDocumentFileId: "file-stage2-1" as null | string,
      sourcePdfHash: "b".repeat(64),
      status: DeliveryHandoverStatus.SOURCE_GENERATED as DeliveryHandoverStatus,
      updatedAt: NOW
    },
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
      orderNo: "ORD-1"
    },
    orderId: "order-1"
  };
}

function makeTask(
  options: {
    customerStatus?: ESignSignerStatus;
    platformStatus?: ESignSignerStatus;
    taskStatus?: ESignTaskStatus;
  } = {}
) {
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

function makeSigner(type: "CUSTOMER" | "PLATFORM") {
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
    signerStatus: customer
      ? ESignSignerStatus.SIGNING
      : ESignSignerStatus.PENDING,
    signerType: customer ? ESignSignerType.CUSTOMER : ESignSignerType.PLATFORM,
    slotId: customer ? CUSTOMER_SLOT : PLATFORM_SLOT,
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
    documentType: "DELIVERY_HANDOVER_CONFIRMATION",
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
