/* eslint-disable @typescript-eslint/no-explicit-any */
import { RequestMethod } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import {
  AuditAction,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  ESignDocumentType,
  ESignProviderActionType,
  ESignSignerStatus,
  ESignSignerType,
  ESignSigningStage,
  ESignSlotId,
  ESignTaskStatus,
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType,
  VehicleHandoverWorkOrderStatus
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { AuthGuard } from "../src/auth/auth.guard";
import { PermissionsGuard } from "../src/auth/permissions.guard";
import { HandoverWorkOrderAdminController } from "../src/handover-work-order/handover-work-order.controller";
import { Stage2HandoverWorkflowService } from "../src/handover-work-order/stage2-handover-workflow.service";

const CUSTOMER_TRANSACTION_ID = "ESG20260726080000ABCDH1";
const PLATFORM_TRANSACTION_ID = "ESG20260726080000ABCDH2";

describe("Stage 2 workflow recovery Admin API", () => {
  it("rejects recovery without the delivery-confirm permission", () => {
    const prototype = HandoverWorkOrderAdminController.prototype as any;
    const expected = [
      [prototype.retryStage2WorkflowJob, "handover-work-orders/:id/workflow-jobs/:jobId/retry"],
      [
        prototype.reconcileStage2CustomerSignature,
        "handover-work-orders/:id/workflow/reconcile-customer"
      ]
    ] as const;

    expect(Reflect.getMetadata(GUARDS_METADATA, HandoverWorkOrderAdminController)).toEqual([
      AuthGuard,
      PermissionsGuard
    ]);
    for (const [handler, path] of expected) {
      expect(handler).toBeTypeOf("function");
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        PermissionCode.DELIVERY_CONFIRM
      ]);
    }
  });

  it("rejects recovery for a non-dead-letter job", async () => {
    const harness = createRecoveryHarness({
      sourceStatus: VehicleHandoverWorkflowJobStatus.PENDING
    });

    await expect(
      harness.service.retryDeadLetterJob("work-order-1", "dead-letter-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_WORKFLOW_JOB_NOT_DEAD_LETTER"
      })
    });

    expect(harness.jobs).toHaveLength(1);
    expect(harness.audits).toEqual([]);
  });

  it("does not recover a dead-letter job through another work order", async () => {
    const harness = createRecoveryHarness();

    await expect(
      harness.service.retryDeadLetterJob("work-order-2", "dead-letter-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_WORKFLOW_JOB_NOT_FOUND"
      })
    });

    expect(harness.jobs).toHaveLength(1);
    expect(harness.audits).toEqual([]);
  });

  it.each([
    [VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF, { manifestHash: "a".repeat(64) }],
    [VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY, undefined],
    [
      VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY,
      { customerTransactionId: CUSTOMER_TRANSACTION_ID }
    ],
    [
      VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
      { customerTransactionId: CUSTOMER_TRANSACTION_ID }
    ],
    [
      VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM,
      { platformTransactionId: PLATFORM_TRANSACTION_ID }
    ],
    [
      VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL,
      { platformTransactionId: PLATFORM_TRANSACTION_ID }
    ],
    [VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF, { artifactVersion: 3 }]
  ] as const)(
    "maps dead-letter %s to only its bounded retry payload",
    async (jobType, expectedPayload) => {
      const harness = createRecoveryHarness({ jobType });

      await harness.service.retryDeadLetterJob("work-order-1", "dead-letter-1", "admin-1");

      const replacement = harness.jobs[1]!;
      expect(replacement).toMatchObject({
        attemptCount: 0,
        eSignTaskId: "stage2-task-1",
        handoverId: "handover-1",
        idempotencyKey: "recovery:dead-letter-1",
        jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
        jobType,
        maxAttempts: 5,
        workOrderId: "work-order-1"
      });
      expect(replacement.payload).toEqual(expectedPayload);
      expect(replacement).not.toHaveProperty("lastErrorCode");
      expect(replacement).not.toHaveProperty("lastErrorMessage");
      expect(replacement).not.toHaveProperty("resultSnapshot");
      expect(JSON.stringify(replacement)).not.toContain("unsafe.example");
      expect(JSON.stringify(replacement)).not.toContain("old-private-value");
    }
  );

  it("writes one bounded audit event and creates one replacement pending job idempotently", async () => {
    const harness = createRecoveryHarness();

    const first = await harness.service.retryDeadLetterJob(
      "work-order-1",
      "dead-letter-1",
      "admin-1"
    );
    const repeated = await harness.service.retryDeadLetterJob(
      "work-order-1",
      "dead-letter-1",
      "admin-1"
    );

    expect(first).toEqual({
      created: true,
      job: {
        id: "replacement-1",
        jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
        jobType: VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF
      }
    });
    expect(repeated).toEqual({
      created: false,
      job: first.job
    });
    expect(harness.jobs).toHaveLength(2);
    expect(harness.audits).toEqual([
      {
        action: AuditAction.UPDATE,
        afterSnapshot: {
          jobType: VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF,
          recoveryAction: "RETRY_DEAD_LETTER",
          replacementJobId: "replacement-1",
          sourceJobId: "dead-letter-1"
        },
        entityId: "work-order-1",
        entityType: "VehicleHandoverWorkOrder",
        module: "stage2-handover-workflow",
        operatorId: "admin-1"
      }
    ]);
  });

  it("converges simultaneous retries to one replacement and one audit event", async () => {
    const harness = createRecoveryHarness();

    const results = await Promise.all([
      harness.service.retryDeadLetterJob("work-order-1", "dead-letter-1", "admin-1"),
      harness.service.retryDeadLetterJob("work-order-1", "dead-letter-1", "admin-2")
    ]);

    expect(results.map(({ created }) => created).sort()).toEqual([false, true]);
    expect(results[0]!.job).toEqual(results[1]!.job);
    expect(harness.jobs).toHaveLength(2);
    expect(harness.audits).toHaveLength(1);
  });

  it("rejects a deterministic recovery-key collision bound to another job type", async () => {
    const harness = createRecoveryHarness();
    harness.jobs.push({
      id: "conflicting-job",
      idempotencyKey: "recovery:dead-letter-1",
      jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
      jobType: VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM,
      workOrderId: "work-order-1"
    });

    await expect(
      harness.service.retryDeadLetterJob("work-order-1", "dead-letter-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_WORKFLOW_RECOVERY_CONFLICT"
      })
    });

    expect(harness.jobs).toHaveLength(2);
    expect(harness.audits).toEqual([]);
  });

  it("manual reconciliation enqueues only the exact active typed customer transaction", async () => {
    const harness = createRecoveryHarness();

    const result = await harness.service.reconcileCustomerSignature("work-order-1", "admin-1");
    const repeated = await harness.service.reconcileCustomerSignature(
      "work-order-1",
      "admin-1"
    );

    expect(result.created).toBe(true);
    expect(repeated).toEqual({
      created: false,
      job: result.job
    });
    expect(harness.jobs[1]).toMatchObject({
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
      jobType: VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
      payload: {
        customerTransactionId: CUSTOMER_TRANSACTION_ID
      },
      workOrderId: "work-order-1"
    });
    expect(harness.audits[0]).toMatchObject({
      afterSnapshot: {
        eSignTaskId: "stage2-task-1",
        recoveryAction: "RECONCILE_CUSTOMER_SIGNATURE",
        replacementJobId: "replacement-1"
      }
    });
    expect(JSON.stringify(harness.audits)).not.toContain(CUSTOMER_TRANSACTION_ID);
    expect(harness.jobs).toHaveLength(2);
    expect(harness.audits).toHaveLength(1);
  });

  it("does not select a Stage 1 task for manual customer reconciliation", async () => {
    const harness = createRecoveryHarness();
    harness.workOrder.handover.handoverESignTask.signingStage =
      ESignSigningStage.STAGE1_SUBSCRIPTION_CONTRACT;
    harness.workOrder.handover.handoverESignTask.documentType =
      ESignDocumentType.SUBSCRIPTION_CONTRACT;

    await expect(
      harness.service.reconcileCustomerSignature("work-order-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_CUSTOMER_RECONCILIATION_NOT_AVAILABLE"
      })
    });

    expect(harness.jobs).toHaveLength(1);
    expect(harness.audits).toEqual([]);
  });

  it("does not allow void or reissue recovery after provider completion", async () => {
    const harness = createRecoveryHarness();
    harness.workOrder.handover.handoverESignTask.taskStatus = ESignTaskStatus.COMPLETED;
    harness.workOrder.handover.handoverESignTask.signers[0]!.signerStatus =
      ESignSignerStatus.SIGNED;
    harness.workOrder.handover.status = DeliveryHandoverStatus.SIGNED;

    await expect(
      harness.service.reconcileCustomerSignature("work-order-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_CUSTOMER_RECONCILIATION_NOT_AVAILABLE"
      })
    });

    expect(harness.jobs).toHaveLength(1);
    expect(harness.audits).toEqual([]);
  });
});

function createRecoveryHarness(
  options: {
    jobType?: VehicleHandoverWorkflowJobType;
    sourceStatus?: VehicleHandoverWorkflowJobStatus;
  } = {}
) {
  const jobType = options.jobType ?? VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF;
  const jobs: any[] = [
    {
      attemptCount: 5,
      completedAt: new Date("2026-07-28T00:00:00.000Z"),
      createdAt: new Date("2026-07-27T00:00:00.000Z"),
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      id: "dead-letter-1",
      idempotencyKey: "old-job-key",
      jobStatus: options.sourceStatus ?? VehicleHandoverWorkflowJobStatus.DEAD_LETTER,
      jobType,
      lastErrorCode: "OLD_ERROR",
      lastErrorMessage: "old-private-value",
      maxAttempts: 5,
      payload: {
        artifactVersion: 3,
        customerTransactionId: CUSTOMER_TRANSACTION_ID,
        manifestHash: "a".repeat(64),
        platformTransactionId: PLATFORM_TRANSACTION_ID,
        providerUrl: "https://unsafe.example/sign",
        reviewAttemptId: "review-attempt-1",
        sourcePdfHash: "b".repeat(64)
      },
      resultSnapshot: {
        privateValue: "old-private-value"
      },
      updatedAt: new Date("2026-07-28T00:00:00.000Z"),
      workOrderId: "work-order-1"
    }
  ];
  const audits: any[] = [];
  const workOrder: any = {
    handover: {
      archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED,
      handoverESignTask: {
        deletedAt: null,
        documentType: ESignDocumentType.DELIVERY_HANDOVER,
        id: "stage2-task-1",
        signers: [
          {
            deletedAt: null,
            documentType: ESignDocumentType.DELIVERY_HANDOVER,
            providerActionType: ESignProviderActionType.CUSTOMER_MANUAL_SIGN,
            providerTransactionId: CUSTOMER_TRANSACTION_ID,
            required: true,
            signerStatus: ESignSignerStatus.SIGNING,
            signerType: ESignSignerType.CUSTOMER,
            slotId: ESignSlotId.STAGE2_HANDOVER_CUSTOMER
          },
          {
            deletedAt: null,
            documentType: ESignDocumentType.DELIVERY_HANDOVER,
            providerActionType: ESignProviderActionType.PLATFORM_AUTO_SEAL,
            providerTransactionId: null,
            required: true,
            signerStatus: ESignSignerStatus.PENDING,
            signerType: ESignSignerType.PLATFORM,
            slotId: ESignSlotId.STAGE2_HANDOVER_PLATFORM
          }
        ],
        signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
        taskNo: "ESG20260726080000ABCD",
        taskStatus: ESignTaskStatus.WAITING_CUSTOMER
      },
      handoverESignTaskId: "stage2-task-1",
      id: "handover-1",
      status: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE
    },
    handoverId: "handover-1",
    id: "work-order-1",
    status: VehicleHandoverWorkOrderStatus.SIGNING
  };
  const transaction = {
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audits.push(structuredClone(data));
        return data;
      })
    },
    vehicleHandoverWorkflowJob: {
      create: vi.fn(async ({ data }: any) => {
        if (jobs.some((job) => job.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error("unique constraint"), {
            code: "P2002"
          });
        }
        const job = {
          attemptCount: 0,
          createdAt: new Date("2026-07-28T01:00:00.000Z"),
          id: `replacement-${jobs.length}`,
          jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
          updatedAt: new Date("2026-07-28T01:00:00.000Z"),
          ...structuredClone(data)
        };
        jobs.push(job);
        return job;
      }),
      findFirst: vi.fn(
        async ({ where }: any) =>
          [...jobs]
            .reverse()
            .find(
              (job) =>
                job.workOrderId === where.workOrderId &&
                job.eSignTaskId === where.eSignTaskId &&
                job.jobType === where.jobType &&
                job.jobStatus === where.jobStatus
            ) ?? null
      ),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) {
          return jobs.find((job) => job.id === where.id) ?? null;
        }
        if (where.idempotencyKey) {
          return jobs.find((job) => job.idempotencyKey === where.idempotencyKey) ?? null;
        }
        return null;
      })
    },
    vehicleHandoverWorkOrder: {
      findUnique: vi.fn(async ({ where }: any) => (where.id === workOrder.id ? workOrder : null))
    }
  };
  const prisma = {
    ...transaction,
    $transaction: vi.fn(async (callback: any) => callback(transaction))
  };
  const service = new Stage2HandoverWorkflowService(
    prisma as never,
    new ConfigService({
      STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
    }),
    {} as never,
    {} as never
  );

  return {
    audits,
    jobs,
    prisma,
    service,
    workOrder
  };
}
