import { ConfigService } from "@nestjs/config";
import {
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { buildDeliveryHandoverEvidencePackage } from "../src/delivery-handover/delivery-handover-evidence-manifest";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
import { Stage2HandoverWorkflowRepository } from "../src/handover-work-order/stage2-handover-workflow.repository";
import { Stage2HandoverWorkflowService } from "../src/handover-work-order/stage2-handover-workflow.service";

describe("Stage 2 workflow customer confirmation", () => {
  it("commits customer confirmation and GENERATE_SOURCE_PDF in one transaction", async () => {
    const harness = createConfirmationHarness();

    const result = await harness.service.customerConfirmNoObjection(
      harness.workOrder.id,
      harness.customerId,
      harness.manifestHash
    );

    expect(harness.workOrder).toMatchObject({
      customerConfirmedAt: expect.any(Date),
      status: "CUSTOMER_CONFIRMED"
    });
    expect(harness.jobs).toHaveLength(1);
    expect(harness.jobs[0]).toMatchObject({
      handoverId: harness.workOrder.handoverId,
      idempotencyKey:
        `pdf:${harness.workOrder.id}:${harness.reviewAttempt.id}:${harness.manifestHash}`,
      jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
      jobType: VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF,
      payload: {
        manifestHash: harness.manifestHash,
        reviewAttemptId: harness.reviewAttempt.id
      },
      workOrderId: harness.workOrder.id
    });
    expect(result).toMatchObject({
      stage2Workflow: {
        jobId: harness.jobs[0]!.id,
        state: "PDF_PENDING"
      }
    });
    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(harness.renderer.renderToFile).not.toHaveBeenCalled();
  });

  it("rolls back confirmation and enqueue when either transaction write fails", async () => {
    const enqueueFailure = createConfirmationHarness({ failEnqueue: true });

    await expect(
      enqueueFailure.service.customerConfirmNoObjection(
        enqueueFailure.workOrder.id,
        enqueueFailure.customerId,
        enqueueFailure.manifestHash
      )
    ).rejects.toThrow("synthetic enqueue failure");
    expect(enqueueFailure.workOrder).toMatchObject({
      customerConfirmedAt: null,
      reviewVersion: 0,
      status: "CUSTOMER_REVIEWING"
    });
    expect(enqueueFailure.reviewAttempt.status).toBe("CUSTOMER_REVIEWING");
    expect(enqueueFailure.jobs).toEqual([]);

    const confirmationFailure = createConfirmationHarness({
      failConfirmationWrite: true
    });
    await expect(
      confirmationFailure.service.customerConfirmNoObjection(
        confirmationFailure.workOrder.id,
        confirmationFailure.customerId,
        confirmationFailure.manifestHash
      )
    ).rejects.toThrow("synthetic confirmation failure");
    expect(confirmationFailure.workOrder.customerConfirmedAt).toBeNull();
    expect(confirmationFailure.jobs).toEqual([]);
  });

  it("returns the same durable PDF job when confirmation is repeated", async () => {
    const harness = createConfirmationHarness();

    await harness.service.customerConfirmNoObjection(
      harness.workOrder.id,
      harness.customerId,
      harness.manifestHash
    );
    const repeated = await harness.service.customerConfirmNoObjection(
      harness.workOrder.id,
      harness.customerId,
      harness.manifestHash
    );

    expect(repeated).toMatchObject({
      stage2Workflow: {
        jobId: harness.jobs[0]!.id,
        state: "PDF_PENDING"
      }
    });
    expect(harness.jobs).toHaveLength(1);
    expect(harness.renderer.renderToFile).not.toHaveBeenCalled();
  });

  it("preserves legacy confirmation behavior when the workflow flag is disabled", async () => {
    const harness = createConfirmationHarness({ workflowEnabled: false });

    const result = await harness.service.customerConfirmNoObjection(
      harness.workOrder.id,
      harness.customerId,
      harness.manifestHash
    );

    expect(result).not.toHaveProperty("stage2Workflow");
    expect(harness.jobs).toEqual([]);
    await expect(
      harness.service.customerConfirmNoObjection(
        harness.workOrder.id,
        harness.customerId,
        harness.manifestHash
      )
    ).rejects.toThrow("客户已确认");
  });

  it.each([
    [
      VehicleHandoverWorkflowJobStatus.PENDING,
      null,
      "PDF_PENDING",
      null
    ],
    [
      VehicleHandoverWorkflowJobStatus.COMPLETED,
      completeLocalSource(),
      "PDF_READY",
      1
    ],
    [
      VehicleHandoverWorkflowJobStatus.DEAD_LETTER,
      null,
      "WORKFLOW_EXCEPTION",
      null
    ]
  ] as const)(
    "derives %s source work as %s from local state",
    async (jobStatus, source, expectedState, artifactVersion) => {
      const prisma = localProjectionPrisma(jobStatus, source);
      const service = new Stage2HandoverWorkflowService(
        prisma as never,
        new ConfigService({ STAGE2_HANDOVER_WORKFLOW_ENABLED: "true" }),
        {} as never,
        {} as never
      );

      await expect(service.getProjection("work-order-1")).resolves.toEqual({
        artifactVersion,
        errorCode:
          expectedState === "WORKFLOW_EXCEPTION" ? "WORKFLOW_ERROR" : null,
        jobId: "workflow-job-1",
        state: expectedState
      });
      expect(prisma.contract.update).not.toHaveBeenCalled();
      expect(prisma.vehicleDeliveryHandover.updateMany).not.toHaveBeenCalled();
      expect(prisma.vehicleHandoverWorkflowJob.updateMany).not.toHaveBeenCalled();
    }
  );
});

function completeLocalSource() {
  return {
    artifactVersion: 1,
    handoverContract: {
      deletedAt: null,
      fileId: "file-pdf-1",
      id: "contract-stage2-1",
      status: "GENERATED"
    },
    handoverContractId: "contract-stage2-1",
    manifestHash: "a".repeat(64),
    sourceDocumentFileId: "file-pdf-1",
    sourceObjectKey: "contracts/contract-stage2-1/generated/handover.pdf",
    sourcePdfHash: "b".repeat(64)
  };
}

function localProjectionPrisma(
  jobStatus: VehicleHandoverWorkflowJobStatus,
  source: null | ReturnType<typeof completeLocalSource>
) {
  return {
    contract: {
      update: vi.fn()
    },
    fileObject: {
      findUnique: vi.fn(async () => source ? {
        bucket: "application-materials",
        id: "file-pdf-1",
        mimeType: "application/pdf",
        objectKey: source.sourceObjectKey,
        sizeBytes: 1024n
      } : null)
    },
    vehicleDeliveryHandover: {
      updateMany: vi.fn()
    },
    vehicleHandoverWorkflowJob: {
      findFirst: vi.fn(async () => ({
        id: "workflow-job-1",
        jobStatus,
        lastErrorCode:
          jobStatus === VehicleHandoverWorkflowJobStatus.DEAD_LETTER
            ? "WORKFLOW_ERROR"
            : null,
        payload: { manifestHash: `sha256:${"a".repeat(64)}` }
      })),
      updateMany: vi.fn()
    },
    vehicleHandoverWorkOrder: {
      findUnique: vi.fn(async () => ({
        handover: source,
        id: "work-order-1"
      }))
    }
  };
}

function createConfirmationHarness(options: {
  failConfirmationWrite?: boolean;
  failEnqueue?: boolean;
  workflowEnabled?: boolean;
} = {}) {
  const now = new Date("2026-07-27T08:00:00.000Z");
  const customerId = "customer-1";
  const workOrder = {
    accessoryChecklist: { chargingCable: true, keys: 2 },
    customerConfirmedAt: null as Date | null,
    customerObjectedAt: null as Date | null,
    customerObjectionReason: null as null | string,
    damageDeclared: false,
    deliveryLocation: "Shanghai delivery center",
    energyLevelText: "80%",
    fieldNotes: "Handover evidence complete.",
    fieldSubmittedAt: now,
    fuelLevelText: null,
    handoverId: "handover-1",
    handoverMileageKm: 1288,
    id: "work-order-1",
    metadata: null as null | Record<string, unknown>,
    noVisibleDamageDeclared: true,
    orderId: "order-1",
    reviewVersion: 0,
    scheduledAt: now,
    status: "CUSTOMER_REVIEWING"
  };
  const reviewAttempt = {
    attemptNo: 1,
    customerConfirmedAt: null as Date | null,
    evidenceSnapshot: null as unknown,
    id: "review-attempt-1",
    status: "CUSTOMER_REVIEWING",
    workOrderId: workOrder.id
  };
  const evidenceChecklist = { blockingReasons: [], items: [], ready: true };
  const manifestHash = buildDeliveryHandoverEvidencePackage({
    evidenceChecklist,
    handoverId: workOrder.handoverId,
    orderId: workOrder.orderId,
    workOrderId: workOrder.id
  }).manifestHash;
  const jobs: Array<Record<string, unknown>> = [];
  let transactionActive = false;

  const transactionClient = {
    vehicleHandoverReviewAttempt: {
      create: vi.fn(),
      findFirst: vi.fn(async () => reviewAttempt),
      findMany: vi.fn(async () => [reviewAttempt]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(reviewAttempt, data);
        return reviewAttempt;
      })
    },
    vehicleHandoverWorkflowJob: {
      upsert: vi.fn(async ({ create, where }: {
        create: Record<string, unknown>;
        where: { idempotencyKey: string };
      }) => {
        expect(transactionActive).toBe(true);
        if (options.failEnqueue) {
          throw new Error("synthetic enqueue failure");
        }
        const existing = jobs.find(
          (job) => job.idempotencyKey === where.idempotencyKey
        );
        if (existing) {
          return existing;
        }
        const job = {
          ...create,
          id: `workflow-job-${jobs.length + 1}`,
          jobStatus: VehicleHandoverWorkflowJobStatus.PENDING
        };
        jobs.push(job);
        return job;
      })
    },
    vehicleHandoverWorkOrder: {
      findUnique: vi.fn(async () => workOrder),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (options.failConfirmationWrite) {
          throw new Error("synthetic confirmation failure");
        }
        const reviewVersion = data.reviewVersion as { increment?: number };
        Object.assign(workOrder, data, {
          reviewVersion: workOrder.reviewVersion + Number(reviewVersion.increment ?? 0)
        });
        return { count: 1 };
      })
    }
  };
  const prisma = {
    ...transactionClient,
    subscriptionOrder: {
      findUnique: vi.fn(async () => ({
        customerId,
        deletedAt: null,
        id: workOrder.orderId,
        orderNo: "ORD-001"
      }))
    },
    $transaction: vi.fn(async (
      callback: (tx: typeof transactionClient) => Promise<unknown>
    ) => {
      const workOrderSnapshot = structuredClone(workOrder);
      const attemptSnapshot = structuredClone(reviewAttempt);
      const jobCount = jobs.length;
      transactionActive = true;
      try {
        return await callback(transactionClient);
      } catch (error) {
        Object.assign(workOrder, workOrderSnapshot);
        Object.assign(reviewAttempt, attemptSnapshot);
        jobs.splice(jobCount);
        throw error;
      } finally {
        transactionActive = false;
      }
    })
  };
  const deliveryEvidenceService = {
    assertFieldEvidenceComplete: vi.fn(async () => undefined),
    getChecklist: vi.fn(async () => evidenceChecklist)
  };
  const renderer = {
    renderToFile: vi.fn()
  };
  const repository = new Stage2HandoverWorkflowRepository(prisma as never);
  const service = new HandoverWorkOrderService(
    prisma as never,
    deliveryEvidenceService as never,
    undefined,
    undefined,
    renderer as never,
    new ConfigService({
      STAGE2_HANDOVER_WORKFLOW_ENABLED:
        options.workflowEnabled === false ? "false" : "true"
    }),
    undefined,
    repository
  );

  return {
    customerId,
    jobs,
    manifestHash,
    prisma,
    renderer,
    reviewAttempt,
    service,
    workOrder
  };
}
