/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, RequestMethod } from "@nestjs/common";
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
  OrderStatus,
  VehicleHandoverWorkOrderStatus
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
import type {
  ESignProviderSignerStatusResult
} from "../src/esign/esign.provider";
import {
  HandoverWorkOrderAdminController,
  HandoverWorkOrderFieldController
} from "../src/handover-work-order/handover-work-order.controller";
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

  it("keeps Admin create compatibility behind the disabled workflow flag", async () => {
    const compatibility = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "false"
    });
    await expect(
      compatibility.service.create("work-order-1", adminInitiator())
    ).resolves.toMatchObject({ taskId: "stage2-task-1" });

    const workflow = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    await expect(
      workflow.service.create("work-order-1", adminInitiator())
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(workflow.provider.createSignTask).not.toHaveBeenCalled();
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
    expect(harness.customerJobs.size).toBe(0);

    const retried = await harness.service.create(
      "work-order-1",
      fieldInitiator(),
      fieldReview()
    );

    expect(retried.taskId).toBe("stage2-task-1");
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
    expectCustomerWorkflowJobs(harness);
  });

  it("recovers an accepted provider action from its durable claim after interruption before marker persistence", async () => {
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
    expect(harness.customerJobs.size).toBe(0);
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);

    customerSigner.claimExpiresAt = new Date(Date.now() - 60_000);
    harness.provider.querySignerStatus.mockResolvedValueOnce({
      resultCode: "1000",
      resultDescription: "active",
      status: "SIGNING"
    });
    harness.provider.getSignerUrl.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 30 * 60_000),
      signUrl: "https://unsafe.example/recovered-sign?token=secret"
    });
    const recovered = await harness.service.create(
      "work-order-1",
      fieldInitiator(),
      fieldReview()
    );

    expect(recovered.taskId).toBe(task.id);
    expect(harness.provider.querySignerStatus).toHaveBeenCalledWith({
      contractId: task.taskNo,
      providerCustomerId: "fadada-customer-1",
      providerTaskId: "ESG20260726080000ABCDH1",
      providerTransactionId: "ESG20260726080000ABCDH1",
      signerId: customerSigner.id,
      slotId: "STAGE2_HANDOVER_CUSTOMER",
      taskId: task.id
    });
    expect(harness.provider.getSignerUrl).toHaveBeenCalledWith({
      contractId: task.taskNo,
      providerTaskId: "ESG20260726080000ABCDH1",
      redirectUrl:
        "http://localhost:3000/portal/handover-reviews/work-order-1",
      signerId: customerSigner.id,
      taskId: task.id
    });
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
    expectCustomerWorkflowJobs(harness);
    expect(JSON.stringify(task.errorSnapshot)).not.toContain(
      "acceptedCustomerProviderResult"
    );
    expect(JSON.stringify(task.responseSnapshot)).not.toMatch(
      /recovered-sign|token=secret/
    );

    const repeated = await harness.service.create(
      "work-order-1",
      fieldInitiator(),
      fieldReview()
    );

    expect(repeated.taskId).toBe(task.id);
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
    expect(harness.provider.querySignerStatus).toHaveBeenCalledTimes(1);
    expect(harness.provider.getSignerUrl).toHaveBeenCalledTimes(1);
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

    expect(overlapping.taskId).toBe(task.id);
    expect(customerSigner.claimExpiresAt).toEqual(expect.any(Date));
    expect(customerSigner.signerStatus).toBe(ESignSignerStatus.PENDING);
    expect(harness.provider.querySignerStatus).not.toHaveBeenCalled();
    expect(harness.provider.getSignerUrl).not.toHaveBeenCalled();
    expect(harness.workflow.enqueueCustomerESignJobs).not.toHaveBeenCalled();
    expect(harness.customerJobs.size).toBe(0);

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

  it("rejects an unsafe customer signing URL before persisting the provider result", async () => {
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
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_HANDOVER_ESIGN_PROVIDER_FAILED"
      })
    });

    expect(
      harness.state.workOrder.handover.handoverESignTask?.signers[0]?.signUrl
    ).toBeFalsy();
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

  it("returns the winner when two initiations overlap at the handover claim", async () => {
    const harness = createHarness({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    });
    const createdTasks = new Map<string, ReturnType<typeof makeTask>>();
    let createAttempt = 0;
    let releaseCreates!: () => void;
    const bothCreatesReached = new Promise<void>((resolve) => {
      releaseCreates = resolve;
    });
    harness.prisma.contractESignTask.create.mockImplementation(
      async ({ data }: any) => {
        createAttempt += 1;
        const attempt = createAttempt;
        if (attempt === 2) {
          releaseCreates();
        }
        await bothCreatesReached;
        const task = makeTaskFromCreateData(
          data,
          `stage2-task-overlap-${attempt}`
        );
        createdTasks.set(task.id, task);
        return task;
      }
    );
    const updateHandover =
      harness.prisma.vehicleDeliveryHandover.updateMany.getMockImplementation();
    harness.prisma.vehicleDeliveryHandover.updateMany.mockImplementation(
      async (input: any) => {
        if (
          input.where?.handoverESignTaskId === null &&
          input.data?.handoverESignTaskId
        ) {
          const handover = harness.state.workOrder.handover;
          if (
            handover.handoverESignTaskId !== null ||
            handover.status !== DeliveryHandoverStatus.SOURCE_GENERATED
          ) {
            return { count: 0 };
          }
          const task = createdTasks.get(input.data.handoverESignTaskId)!;
          Object.assign(handover, input.data);
          handover.handoverESignTask = task;
          harness.state.activeTask = task;
          return { count: 1 };
        }
        return updateHandover!(input);
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
        fieldInitiator(),
        fieldReview()
      )
    ]);

    expect(settled.every((result) => result.status === "fulfilled")).toBe(
      true
    );
    const taskIds = settled.map((result) =>
      result.status === "fulfilled" ? result.value.taskId : null
    );
    expect(new Set(taskIds)).toEqual(
      new Set([harness.state.workOrder.handover.handoverESignTaskId])
    );
    expect(harness.provider.createSignTask).toHaveBeenCalledTimes(1);
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
        canStartSigning: false
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

  it("returns only a short-lived URL and expiry from the explicit Portal start action", async () => {
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
      signerId: "stage2-customer-signer-1",
      taskId: "stage2-task-1"
    });
    expect(task.signers[0]).toMatchObject({
      providerTransactionId: "ESG20260726080000ABCDH1",
      signUrl: "https://sentinel.example/refreshed-stage2-sign",
      signUrlExpiresAt: expiresAt,
      signerStatus: ESignSignerStatus.SIGNING
    });
    expect(harness.provider.createSignTask).not.toHaveBeenCalled();
    expect(harness.prisma.subscriptionOrder.update).not.toHaveBeenCalled();
    expect(harness.prisma.vehicleDelivery.update).not.toHaveBeenCalled();
    expect(harness.prisma.leaseContract.create).not.toHaveBeenCalled();
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
    expect(harness.prisma.contractESignSigner.updateMany).not.toHaveBeenCalled();
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

function createHarness(env: Record<string, string> = {}) {
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

  let transactionDepth = 0;
  const prisma: any = {
    $transaction: vi.fn(async (operation: (tx: any) => Promise<unknown>) => {
      transactionDepth += 1;
      try {
        return await operation(prisma);
      } finally {
        transactionDepth -= 1;
      }
    }),
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
    customerJobs,
    failCustomerJobEnqueues(count: number) {
      customerJobEnqueueFailuresRemaining = count;
    },
    generatePdf,
    notification,
    prisma,
    provider,
    readiness,
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
      sourceDocumentFileId: "file-stage2-1" as null | string,
      sourceObjectKey: "private/stage2/source-1.pdf",
      sourcePdfHash: "b".repeat(64),
      status: DeliveryHandoverStatus.SOURCE_GENERATED as DeliveryHandoverStatus,
      updatedAt: NOW
    },
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
  expect([...harness.customerJobs.entries()]).toEqual([
    [
      "customer-notify:stage2-task-1:ESG20260726080000ABCDH1",
      "NOTIFY_CUSTOMER_ESIGN_READY"
    ],
    [
      "customer-reconcile:stage2-task-1:ESG20260726080000ABCDH1",
      "RECONCILE_CUSTOMER_SIGNATURE"
    ]
  ]);
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
