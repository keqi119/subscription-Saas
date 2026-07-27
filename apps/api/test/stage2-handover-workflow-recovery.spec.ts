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
  VehicleHandoverType,
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
    [
      VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF,
      { manifestHash: `sha256:${"a".repeat(64)}` }
    ],
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
    [VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF, { artifactVersion: 1 }]
  ] as const)(
    "maps dead-letter %s to only its bounded retry payload",
    async (jobType, expectedPayload) => {
      const harness = createRecoveryHarness({ jobType });

      await harness.service.retryDeadLetterJob("work-order-1", "dead-letter-1", "admin-1");

      const replacement = harness.jobs[1]!;
      const expectedESignTaskId =
        jobType === VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF ||
        jobType === VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY
          ? null
          : "stage2-task-1";
      expect(replacement).toMatchObject({
        attemptCount: 0,
        eSignTaskId: expectedESignTaskId,
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

  it.each([
    VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY,
    VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY
  ])("does not resend %s after the work order becomes terminal", async (jobType) => {
    const harness = createRecoveryHarness({ jobType });
    harness.workOrder.status = VehicleHandoverWorkOrderStatus.CANCELLED;

    await expect(
      harness.service.retryDeadLetterJob("work-order-1", "dead-letter-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_WORKFLOW_JOB_NOT_RECOVERABLE"
      })
    });

    expect(harness.jobs).toHaveLength(1);
    expect(harness.audits).toEqual([]);
  });

  it.each([
    ["deleted", (handover: any) => {
      handover.deletedAt = new Date("2026-07-28T00:00:00.000Z");
    }],
    ["archived", (handover: any) => {
      handover.archivedAt = new Date("2026-07-28T00:00:00.000Z");
      handover.archiveStatus = DeliveryHandoverArchiveStatus.ARCHIVED;
    }]
  ])("rejects recovery from a %s canonical handover", async (_label, mutate) => {
    const harness = createRecoveryHarness({
      jobType: VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY
    });
    mutate(harness.workOrder.handover);

    await expect(
      harness.service.retryDeadLetterJob("work-order-1", "dead-letter-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_WORKFLOW_JOB_NOT_RECOVERABLE"
      })
    });

    expect(harness.jobs).toHaveLength(1);
    expect(harness.audits).toEqual([]);
  });

  it("rejects a dead letter whose handover and task no longer match canonical pointers", async () => {
    const harness = createRecoveryHarness({
      jobType: VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY
    });
    harness.jobs[0]!.handoverId = "foreign-handover";
    harness.jobs[0]!.eSignTaskId = "foreign-task";

    await expect(
      harness.service.retryDeadLetterJob("work-order-1", "dead-letter-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_WORKFLOW_JOB_NOT_RECOVERABLE"
      })
    });

    expect(harness.jobs).toHaveLength(1);
    expect(harness.audits).toEqual([]);
  });

  it("rejects a stale customer notification after provider completion", async () => {
    const harness = createRecoveryHarness({
      jobType: VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY
    });
    harness.workOrder.handover.handoverESignTask.taskStatus = ESignTaskStatus.COMPLETED;
    harness.workOrder.handover.handoverESignTask.signers[0]!.signerStatus =
      ESignSignerStatus.SIGNED;
    harness.workOrder.handover.status = DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;

    await expect(
      harness.service.retryDeadLetterJob("work-order-1", "dead-letter-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_WORKFLOW_JOB_NOT_RECOVERABLE"
      })
    });

    expect(harness.jobs).toHaveLength(1);
    expect(harness.audits).toEqual([]);
  });

  it("uses the canonical transaction and controlled max attempts", async () => {
    const harness = createRecoveryHarness({
      jobType: VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM
    });
    harness.jobs[0]!.maxAttempts = 999_999;

    await harness.service.retryDeadLetterJob(
      "work-order-1",
      "dead-letter-1",
      "admin-1"
    );

    expect(harness.jobs[1]).toMatchObject({
      maxAttempts: 5,
      payload: {
        platformTransactionId: PLATFORM_TRANSACTION_ID
      }
    });
  });

  it("rejects a source transaction that conflicts with canonical H2", async () => {
    const harness = createRecoveryHarness({
      jobType: VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM
    });
    harness.jobs[0]!.payload = {
      platformTransactionId: "ATTACKERCONTROLLEDH2",
      providerUrl: "https://unsafe.example/sign"
    };

    await expect(
      harness.service.retryDeadLetterJob("work-order-1", "dead-letter-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_WORKFLOW_JOB_NOT_RECOVERABLE"
      })
    });

    expect(harness.jobs).toHaveLength(1);
    expect(harness.audits).toEqual([]);
  });

  it("rejects a source artifact version that is no longer canonical", async () => {
    const harness = createRecoveryHarness({
      jobType: VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF
    });
    harness.jobs[0]!.payload = { artifactVersion: 999_999 };

    await expect(
      harness.service.retryDeadLetterJob("work-order-1", "dead-letter-1", "admin-1")
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "STAGE2_WORKFLOW_JOB_NOT_RECOVERABLE"
      })
    });

    expect(harness.jobs).toHaveLength(1);
    expect(harness.audits).toEqual([]);
  });

  it("rejects a same-key replacement with a conflicting minimal payload", async () => {
    const harness = createRecoveryHarness({
      jobType: VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE
    });
    harness.jobs.push({
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      id: "conflicting-job",
      idempotencyKey: "recovery:dead-letter-1",
      jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
      jobType: VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
      maxAttempts: 5,
      payload: {
        customerTransactionId: "ATTACKERCONTROLLEDH1"
      },
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
    const harness = createRecoveryHarness({
      jobType: VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE
    });

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
    const harness = createRecoveryHarness({
      jobType: VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE
    });
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

  it.each([
    ["draft work order", (workOrder: any) => {
      workOrder.status = VehicleHandoverWorkOrderStatus.DRAFT;
    }],
    ["return handover", (workOrder: any) => {
      workOrder.handoverType = VehicleHandoverType.RETURN_INBOUND;
    }],
    ["deleted handover", (workOrder: any) => {
      workOrder.handover.deletedAt = new Date("2026-07-28T00:00:00.000Z");
    }],
    ["archived handover", (workOrder: any) => {
      workOrder.handover.archivedAt = new Date("2026-07-28T00:00:00.000Z");
    }],
    ["foreign order", (workOrder: any) => {
      workOrder.handover.orderId = "order-2";
    }],
    ["foreign contract", (workOrder: any) => {
      workOrder.handover.handoverESignTask.contractId = "contract-2";
    }],
    ["stale source snapshot", (workOrder: any) => {
      workOrder.handover.handoverESignTask.requestSnapshot.sourceDocumentFileId =
        "file-source-2";
    }],
    ["foreign customer", (workOrder: any) => {
      workOrder.handover.handoverESignTask.customerId = "customer-2";
    }],
    ["foreign platform customer", (workOrder: any) => {
      workOrder.handover.handoverESignTask.signers[1].customerId =
        "customer-2";
    }]
  ])("manual reconciliation rejects a %s binding", async (_label, mutate) => {
    const harness = createRecoveryHarness({
      jobType: VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE
    });
    mutate(harness.workOrder);

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
    const harness = createRecoveryHarness({
      jobType: VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE
    });
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
        artifactVersion: 1,
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
    customerConfirmedAt: new Date("2026-07-27T00:00:00.000Z"),
    customerObjectedAt: null,
    handover: {
      archiveStatus: DeliveryHandoverArchiveStatus.NOT_STARTED,
      archivedAt: null,
      artifactVersion: 1,
      deletedAt: null,
      handoverContract: {
        contractSnapshot: {
          evidencePackage: {
            manifestHash: `sha256:${"a".repeat(64)}`
          },
          fileId: "file-source-1",
          handoverId: "handover-1",
          orderId: "order-1",
          stage2HandoverPdfArtifact: {
            artifactVersion: 1,
            fileId: "file-source-1",
            sourcePdfHash: "b".repeat(64)
          },
          workOrderId: "work-order-1"
        },
        customerId: "customer-1",
        deletedAt: null,
        fileId: "file-source-1",
        id: "contract-stage2-1",
        orderId: "order-1",
        status: "SIGNING"
      },
      handoverContractId: "contract-stage2-1",
      handoverESignTask: {
        contractId: "contract-stage2-1",
        customerId: "customer-1",
        deletedAt: null,
        documentType: ESignDocumentType.DELIVERY_HANDOVER,
        id: "stage2-task-1",
        orderId: "order-1",
        requestSnapshot: {
          artifactVersion: 1,
          contractId: "contract-stage2-1",
          documentType: "DELIVERY_HANDOVER",
          handoverId: "handover-1",
          manifestHash: "a".repeat(64),
          signingStage: "STAGE2_DELIVERY_HANDOVER",
          slotIds: [
            "STAGE2_HANDOVER_CUSTOMER",
            "STAGE2_HANDOVER_PLATFORM"
          ],
          sourceDocumentFileId: "file-source-1",
          sourcePdfHash: "b".repeat(64)
        },
        signers: [
          {
            customerId: "customer-1",
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
            customerId: null,
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
      manifestHash: "a".repeat(64),
      orderId: "order-1",
      sourceDocumentFileId: "file-source-1",
      sourceObjectKey: "contracts/contract-stage2-1/generated/handover.pdf",
      sourcePdfHash: "b".repeat(64),
      status: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE
    },
    handoverId: "handover-1",
    handoverType: VehicleHandoverType.DELIVERY_OUTBOUND,
    id: "work-order-1",
    order: {
      customerId: "customer-1",
      id: "order-1"
    },
    orderId: "order-1",
    reviewAttempts: [
      {
        customerConfirmedAt: new Date("2026-07-27T00:00:00.000Z"),
        evidenceSnapshot: {
          evidencePackage: {
            manifestHash: `sha256:${"a".repeat(64)}`
          }
        },
        handoverId: "handover-1",
        id: "review-attempt-1",
        orderId: "order-1",
        status: "CUSTOMER_CONFIRMED",
        workOrderId: "work-order-1"
      }
    ],
    status: VehicleHandoverWorkOrderStatus.SIGNING
  };
  configureCanonicalRecoveryState(workOrder, jobs[0]!, jobType);
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
    },
    fileObject: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === "file-source-1"
          ? {
              bucket: "application-materials",
              id: "file-source-1",
              mimeType: "application/pdf",
              objectKey: workOrder.handover.sourceObjectKey,
              sizeBytes: 1024n
            }
          : null
      )
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

function configureCanonicalRecoveryState(
  workOrder: any,
  sourceJob: any,
  jobType: VehicleHandoverWorkflowJobType
) {
  const task = workOrder.handover.handoverESignTask;
  const customerSigner = task.signers[0];
  const platformSigner = task.signers[1];

  if (jobType === VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF) {
    workOrder.status = VehicleHandoverWorkOrderStatus.CUSTOMER_CONFIRMED;
    workOrder.handover.status = DeliveryHandoverStatus.DRAFT;
    workOrder.handover.handoverContract = null;
    workOrder.handover.handoverContractId = null;
    workOrder.handover.handoverESignTask = null;
    workOrder.handover.handoverESignTaskId = null;
    workOrder.handover.manifestHash = null;
    workOrder.handover.sourceDocumentFileId = null;
    workOrder.handover.sourceObjectKey = null;
    workOrder.handover.sourcePdfHash = null;
    sourceJob.eSignTaskId = null;
    sourceJob.payload = {
      manifestHash: `sha256:${"a".repeat(64)}`,
      reviewAttemptId: "review-attempt-1"
    };
    return;
  }

  if (jobType === VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY) {
    workOrder.status = VehicleHandoverWorkOrderStatus.CUSTOMER_CONFIRMED;
    workOrder.handover.status = DeliveryHandoverStatus.SOURCE_GENERATED;
    workOrder.handover.handoverContract.status = "GENERATED";
    workOrder.handover.handoverESignTask = null;
    workOrder.handover.handoverESignTaskId = null;
    sourceJob.eSignTaskId = null;
    sourceJob.payload = {
      artifactVersion: 1,
      manifestHash: `sha256:${"a".repeat(64)}`,
      sourcePdfHash: "b".repeat(64)
    };
    return;
  }

  if (
    jobType === VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY ||
    jobType === VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE
  ) {
    sourceJob.payload = {
      customerTransactionId: CUSTOMER_TRANSACTION_ID
    };
    return;
  }

  customerSigner.signerStatus = ESignSignerStatus.SIGNED;
  task.taskStatus = ESignTaskStatus.SIGNING;
  workOrder.status = VehicleHandoverWorkOrderStatus.CUSTOMER_SIGNED;
  workOrder.handover.status = DeliveryHandoverStatus.PENDING_PLATFORM_SEAL;

  if (jobType === VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM) {
    sourceJob.payload = {
      platformTransactionId: PLATFORM_TRANSACTION_ID
    };
    return;
  }

  platformSigner.providerTransactionId = PLATFORM_TRANSACTION_ID;
  platformSigner.signerStatus = ESignSignerStatus.SIGNING;
  if (jobType === VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL) {
    sourceJob.payload = {
      platformTransactionId: PLATFORM_TRANSACTION_ID
    };
    return;
  }

  task.taskStatus = ESignTaskStatus.COMPLETED;
  platformSigner.signerStatus = ESignSignerStatus.SIGNED;
  workOrder.status = VehicleHandoverWorkOrderStatus.PLATFORM_SEALED;
  workOrder.handover.handoverContract.status = "SIGNED";
  workOrder.handover.status = DeliveryHandoverStatus.SIGNED;
  sourceJob.payload = { artifactVersion: 1 };
}
