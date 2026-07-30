import { Readable } from "node:stream";

import {
  BadRequestException,
  ConflictException,
  RequestMethod,
  UnauthorizedException
} from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import {
  ContractStatus,
  DeliveryHandoverStatus,
  ESignDocumentType,
  ESignSigningStage,
  ESignTaskStatus,
  VehicleHandoverWorkflowJobType,
  VehicleHandoverWorkOrderStatus
} from "@prisma/client";
import { validate } from "class-validator";
import { describe, expect, it, vi } from "vitest";

import { buildDeliveryHandoverEvidencePackage } from "../src/delivery-handover/delivery-handover-evidence-manifest";
import { FieldOperatorAuthController } from "../src/field-operator/field-operator-auth.controller";
import { FieldOperatorAuthGuard } from "../src/field-operator/field-operator-auth.guard";
import { StartFieldStage2ESignDto } from "../src/handover-work-order/handover-work-order.dto";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
import { Stage2HandoverWorkflowService } from "../src/handover-work-order/stage2-handover-workflow.service";

const FIELD_PHONE = "13800000000";
const OTHER_PHONE = "13900000000";
const SOURCE_PDF_HASH = "b".repeat(64);

describe("Stage 2 Field PDF review and eSign initiation", () => {
  it("exposes only authenticated Field PDF preview, download, and eSign routes", () => {
    const prototype = FieldOperatorAuthController.prototype;
    const expected = [
      [
        "previewStage2HandoverPdf",
        "work-orders/:id/pdf/preview",
        RequestMethod.GET
      ],
      [
        "downloadStage2HandoverPdf",
        "work-orders/:id/pdf/download",
        RequestMethod.GET
      ],
      [
        "createStage2ESign",
        "work-orders/:id/esign",
        RequestMethod.POST
      ]
    ] as const;

    for (const [methodName, path, method] of expected) {
      const handler = prototype[methodName];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
        FieldOperatorAuthGuard
      ]);
    }
  });

  it("keeps a customer-confirmed task visible but makes facts and evidence read-only", async () => {
    const harness = createHarness();

    await expect(
      harness.service.listFieldAccessibleWorkOrders(FIELD_PHONE)
    ).resolves.toEqual([
      expect.objectContaining({
        id: "work-order-1",
        status: VehicleHandoverWorkOrderStatus.CUSTOMER_CONFIRMED
      })
    ]);
    await expect(
      harness.service.getFieldAccessibleWorkOrder(
        "work-order-1",
        FIELD_PHONE
      )
    ).resolves.toMatchObject({
      stage2Pdf: {
        artifactVersion: 1,
        downloadUrl:
          "/api/field/handover/work-orders/work-order-1/pdf/download",
        previewUrl:
          "/api/field/handover/work-orders/work-order-1/pdf/preview",
        sourcePdfHash: SOURCE_PDF_HASH,
        status: "GENERATED"
      }
    });
    await expect(
      harness.service.updateFieldAccessibleFacts(
        "work-order-1",
        FIELD_PHONE,
        { handoverMileageKm: 30001 },
        "field-session-1"
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      harness.service.removeFieldAccessibleEvidenceFile(
        "work-order-1",
        FIELD_PHONE,
        "evidence-item-1",
        "evidence-file-1",
        "field-session-1"
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("returns authoritative Field capabilities, current task, and generic notification status", async () => {
    const harness = createHarness();
    const readiness = {
      getReadiness: vi.fn(async () => ({
        blockers: [],
        ready: true,
        state: {
          esignTaskId: null,
          esignTaskStatus: null,
          workOrderId: "work-order-1"
        }
      }))
    };
    const auth = {
      recordTaskViewed: vi.fn(async () => undefined)
    };
    const controller = Reflect.construct(FieldOperatorAuthController, [
      auth,
      harness.service,
      {},
      readiness
    ]) as FieldOperatorAuthController;

    const result = await controller.getWorkOrder(
      "work-order-1",
      { phone: FIELD_PHONE } as never,
      { headers: {}, ip: "127.0.0.1" } as never
    );

    expect(result).toMatchObject({
      stage2Capabilities: {
        canDownload: true,
        canPreview: true,
        canStartESign: true,
        shouldPollESign: false
      },
      stage2ESign: {
        finalizationPending: false,
        status: null,
        taskId: null
      },
      stage2Notification: {
        status: "COMPLETED"
      }
    });
    expect(JSON.stringify(result.stage2Notification)).not.toContain(FIELD_PHONE);
  });

  it("projects an existing Stage 2 task and explicitly disables another Field initiation", async () => {
    const harness = createHarness();
    harness.handover.handoverESignTaskId = "stage2-task-existing";
    harness.state.activeTask = stage2Task({
      id: "stage2-task-existing",
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });
    const readiness = {
      getReadiness: vi.fn(async () => ({
        blockers: [{ code: "ACTIVE_ESIGN_TASK_CONFLICT" }],
        ready: false,
        state: {
          esignTaskId: "stage2-task-existing",
          esignTaskStatus: "WAITING_CUSTOMER",
          workOrderId: "work-order-1"
        }
      }))
    };
    const controller = Reflect.construct(FieldOperatorAuthController, [
      { recordTaskViewed: vi.fn(async () => undefined) },
      harness.service,
      {},
      readiness
    ]) as FieldOperatorAuthController;

    const result = await controller.getWorkOrder(
      "work-order-1",
      { phone: FIELD_PHONE } as never,
      { headers: {}, ip: "127.0.0.1" } as never
    );

    expect(result.stage2Capabilities.canStartESign).toBe(false);
    expect(result.stage2ESign).toEqual({
      finalizationPending: false,
      status: "WAITING_CUSTOMER",
      taskId: "stage2-task-existing"
    });
  });

  it("keeps Field polling until customer notification and reconciliation jobs are durable", async () => {
    const harness = createHarness();
    const task = stage2Task({
      id: "stage2-task-finalization-pending",
      signers: [{
        claimExpiresAt: new Date("2026-07-27T08:05:00.000Z"),
        providerTransactionId: "ESG20260727080000ABCDH1",
        slotId: "STAGE2_HANDOVER_CUSTOMER"
      }],
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });
    harness.handover.handoverESignTaskId = task.id;
    harness.state.activeTask = task;
    harness.state.customerJobTypes = [
      VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE
    ];
    const controller = fieldDetailController(harness, {
      blockers: [{ code: "ACTIVE_ESIGN_TASK_CONFLICT" }],
      ready: false
    });

    const pending = await controller.getWorkOrder(
      "work-order-1",
      { phone: FIELD_PHONE } as never,
      { headers: {}, ip: "127.0.0.1" } as never
    );

    expect(pending.stage2ESign.finalizationPending).toBe(true);
    expect(pending.stage2Capabilities.shouldPollESign).toBe(true);

    task.signers![0]!.claimExpiresAt = null;
    harness.state.customerJobTypes.push(
      VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY
    );
    const finalized = await controller.getWorkOrder(
      "work-order-1",
      { phone: FIELD_PHONE } as never,
      { headers: {}, ip: "127.0.0.1" } as never
    );

    expect(finalized.stage2ESign.finalizationPending).toBe(false);
    expect(finalized.stage2Capabilities.shouldPollESign).toBe(false);
  });

  it.each([
    ESignTaskStatus.CANCELLED,
    ESignTaskStatus.FAILED,
    ESignTaskStatus.EXPIRED
  ])(
    "does not project a terminal %s task retained by the authoritative pointer",
    async (taskStatus) => {
      const harness = createHarness();
      const pointerTask = stage2Task({
        id: `stage2-task-pointer-${taskStatus.toLowerCase()}`,
        taskStatus
      });
      harness.handover.handoverESignTaskId = pointerTask.id;
      harness.state.activeTask = pointerTask;
      harness.state.otherTasks = [
        stage2Task({ id: "stage2-task-unrelated-fallback" })
      ];
      const controller = fieldDetailController(harness, {
        blockers: [],
        ready: true
      });

      const result = await controller.getWorkOrder(
        "work-order-1",
        { phone: FIELD_PHONE } as never,
        { headers: {}, ip: "127.0.0.1" } as never
      );

      expect(result.stage2ESign).toEqual({
        finalizationPending: false,
        status: null,
        taskId: null
      });
      expect(result.stage2Capabilities.canStartESign).toBe(true);
    }
  );

  it.each([
    [
      "wrong document",
      {
        documentType: ESignDocumentType.SUBSCRIPTION_CONTRACT
      }
    ],
    [
      "wrong signing stage",
      {
        signingStage:
          ESignSigningStage.STAGE1_SUBSCRIPTION_CONTRACT
      }
    ],
    [
      "wrong contract",
      {
        contractId: "contract-stage2-other"
      }
    ],
    [
      "wrong order",
      {
        orderId: "order-other"
      }
    ]
  ] as const)(
    "fails closed for a pointer with %s and does not replace it with fallback",
    async (_name, taskOverrides) => {
      const harness = createHarness();
      const pointerTask = stage2Task({
        id: "stage2-task-invalid-pointer",
        ...taskOverrides
      });
      harness.handover.handoverESignTaskId = pointerTask.id;
      harness.state.activeTask = pointerTask;
      harness.state.otherTasks = [
        stage2Task({ id: "stage2-task-valid-fallback" })
      ];
      const controller = fieldDetailController(harness, {
        blockers: [],
        ready: true
      });

      const result = await controller.getWorkOrder(
        "work-order-1",
        { phone: FIELD_PHONE } as never,
        { headers: {}, ip: "127.0.0.1" } as never
      );

      expect(result.stage2ESign).toEqual({
        finalizationPending: false,
        status: null,
        taskId: null
      });
      expect(result.stage2Capabilities.canStartESign).toBe(true);
    }
  );

  it.each([
    ESignTaskStatus.CANCELLED,
    ESignTaskStatus.FAILED,
    ESignTaskStatus.EXPIRED
  ])(
    "does not rediscover a terminal historical %s task after its authoritative pointer is cleared",
    async (taskStatus) => {
      const harness = createHarness();
      harness.handover.handoverESignTaskId = null;
      harness.state.activeTask = stage2Task({
        id: `stage2-task-historical-${taskStatus.toLowerCase()}`,
        taskStatus
      });
      const readiness = {
        getReadiness: vi.fn(async () => ({
          blockers: [],
          ready: true,
          state: {
            esignTaskId: null,
            esignTaskStatus: null,
            workOrderId: "work-order-1"
          }
        }))
      };
      const controller = Reflect.construct(FieldOperatorAuthController, [
        { recordTaskViewed: vi.fn(async () => undefined) },
        harness.service,
        {},
        readiness
      ]) as FieldOperatorAuthController;

      const result = await controller.getWorkOrder(
        "work-order-1",
        { phone: FIELD_PHONE } as never,
        { headers: {}, ip: "127.0.0.1" } as never
      );

      expect(result.stage2ESign).toEqual({
        finalizationPending: false,
        status: null,
        taskId: null
      });
      expect(result.stage2Capabilities.canStartESign).toBe(true);
    }
  );

  it("authorizes the canonical Field phone before any readiness or workflow-status read", async () => {
    const harness = createHarness();
    const readiness = {
      getReadiness: vi.fn(async () => ({
        blockers: [],
        ready: true,
        state: {
          esignTaskId: null,
          esignTaskStatus: null,
          workOrderId: "work-order-1"
        }
      }))
    };
    const controller = Reflect.construct(FieldOperatorAuthController, [
      { recordTaskViewed: vi.fn(async () => undefined) },
      harness.service,
      {},
      readiness
    ]) as FieldOperatorAuthController;

    await expect(
      controller.getWorkOrder(
        "work-order-1",
        { phone: OTHER_PHONE } as never,
        { headers: {}, ip: "127.0.0.1" } as never
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(readiness.getReadiness).not.toHaveBeenCalled();
    expect(harness.prisma.contractESignTask.findFirst).not.toHaveBeenCalled();
    expect(
      harness.prisma.vehicleHandoverWorkflowJob.findFirst
    ).not.toHaveBeenCalled();
  });

  it("allows only the canonical assigned phone to preview and download the PDF", async () => {
    const harness = createHarness();

    const preview = await harness.service.previewFieldAccessibleStage2HandoverPdf(
      "work-order-1",
      FIELD_PHONE
    );
    const download = await harness.service.downloadFieldAccessibleStage2HandoverPdf(
      "work-order-1",
      FIELD_PHONE
    );

    expect(preview).toMatchObject({
      filename: "handover.pdf",
      mimeType: "application/pdf",
      sizeBytes: 9
    });
    expect(download).toMatchObject({
      filename: "handover.pdf",
      mimeType: "application/pdf",
      sizeBytes: 9
    });
    expect(harness.storage.getObject).toHaveBeenCalledTimes(2);

    await expect(
      harness.service.previewFieldAccessibleStage2HandoverPdf(
        "work-order-1",
        OTHER_PHONE
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      harness.service.downloadFieldAccessibleStage2HandoverPdf(
        "work-order-1",
        OTHER_PHONE
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects eSign initiation without acknowledgement", async () => {
    const dto = Object.assign(new StartFieldStage2ESignDto(), {
      artifactVersion: 1,
      sourcePdfHash: SOURCE_PDF_HASH
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain("acknowledgement");

    const harness = createHarness();
    await expect(
      harness.service.assertFieldStage2ESignReview(
        "work-order-1",
        FIELD_PHONE,
        {
          acknowledgement: false as true,
          artifactVersion: 1,
          sourcePdfHash: SOURCE_PDF_HASH
        }
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a stale artifact version or source hash", async () => {
    const staleVersion = createHarness();
    await expect(
      staleVersion.service.assertFieldStage2ESignReview(
        "work-order-1",
        FIELD_PHONE,
        {
          acknowledgement: true,
          artifactVersion: 2,
          sourcePdfHash: SOURCE_PDF_HASH
        }
      )
    ).rejects.toBeInstanceOf(ConflictException);

    const staleHash = createHarness();
    await expect(
      staleHash.service.assertFieldStage2ESignReview(
        "work-order-1",
        FIELD_PHONE,
        {
          acknowledgement: true,
          artifactVersion: 1,
          sourcePdfHash: "c".repeat(64)
        }
      )
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects a PDF that no longer matches the current manifest", async () => {
    const harness = createHarness();
    harness.evidence.getChecklist.mockResolvedValueOnce(changedChecklist());

    await expect(
      harness.service.assertFieldStage2ESignReview(
        "work-order-1",
        FIELD_PHONE,
        {
          acknowledgement: true,
          artifactVersion: 1,
          sourcePdfHash: SOURCE_PDF_HASH
        }
      )
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("enqueues exact customer notification and delayed reconciliation jobs", async () => {
    const repository = {
      enqueue: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => input)
    };
    const service = new Stage2HandoverWorkflowService(
      {} as never,
      { get: vi.fn(() => "true") } as never,
      repository as never,
      {} as never
    );
    const tx = { transaction: "stage2-finalization" };
    const initiatedAt = new Date("2026-07-27T08:00:00.000Z");

    await service.enqueueCustomerESignJobs(tx as never, {
      customerTransactionId: "ESG20260727080000ABCDH1",
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      initiatedAt,
      workOrderId: "work-order-1"
    });

    expect(repository.enqueue.mock.calls).toEqual([
      [
        tx,
        {
          eSignTaskId: "stage2-task-1",
          handoverId: "handover-1",
          idempotencyKey:
            "customer-notify:stage2-task-1:ESG20260727080000ABCDH1",
          jobType:
            VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY,
          payload: {
            customerTransactionId: "ESG20260727080000ABCDH1"
          },
          workOrderId: "work-order-1"
        }
      ],
      [
        tx,
        {
          delayMs: 120_000,
          eSignTaskId: "stage2-task-1",
          handoverId: "handover-1",
          idempotencyKey:
            "customer-reconcile:stage2-task-1:ESG20260727080000ABCDH1",
          jobType:
            VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
          payload: {
            customerTransactionId: "ESG20260727080000ABCDH1"
          },
          workOrderId: "work-order-1"
        }
      ]
    ]);
    expect(service.supportedJobTypes).toEqual(
      expect.arrayContaining([
        VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
        VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM,
        VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL,
        VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF
      ])
    );
  });

  it("writes the deterministic customer acceptance recovery marker before the provider call", async () => {
    const repository = {
      enqueue: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => input)
    };
    const service = new Stage2HandoverWorkflowService(
      {} as never,
      { get: vi.fn(() => "true") } as never,
      repository as never,
      {} as never
    );
    const tx = { transaction: "stage2-provider-claim" };
    const initiatedAt = new Date("2026-07-27T08:00:00.000Z");

    await service.enqueueCustomerAcceptanceRecovery(tx as never, {
      customerTransactionId: "ESG20260727080000ABCDH1",
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      initiatedAt,
      workOrderId: "work-order-1"
    });

    expect(repository.enqueue).toHaveBeenCalledWith(tx, {
      delayMs: 120_000,
      eSignTaskId: "stage2-task-1",
      handoverId: "handover-1",
      idempotencyKey:
        "customer-reconcile:stage2-task-1:ESG20260727080000ABCDH1",
      jobType:
        VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
      payload: {
        customerTransactionId: "ESG20260727080000ABCDH1"
      },
      workOrderId: "work-order-1"
    });
  });
});

function createHarness() {
  const checklist = emptyChecklist();
  const manifestHash = buildDeliveryHandoverEvidencePackage({
    evidenceChecklist: checklist,
    handoverId: "handover-1",
    orderId: "order-1",
    workOrderId: "work-order-1"
  }).manifestHash;
  const workOrder = {
    assignedInternalUserId: "internal-user-1",
    createdAt: new Date("2026-07-27T08:00:00.000Z"),
    customerConfirmedAt: new Date("2026-07-27T07:00:00.000Z"),
    fieldOperatorPhone: FIELD_PHONE,
    handoverId: "handover-1",
    id: "work-order-1",
    orderId: "order-1",
    operatorType: "INTERNAL",
    scheduledAt: new Date("2026-07-27T09:00:00.000Z"),
    status: VehicleHandoverWorkOrderStatus.CUSTOMER_CONFIRMED
  };
  const fileObject = {
    bucket: "private-contracts",
    createdAt: new Date("2026-07-27T07:30:00.000Z"),
    id: "file-stage2-1",
    mimeType: "application/pdf",
    objectKey: "contracts/stage2/handover.pdf",
    originalName: "handover.pdf",
    sizeBytes: 9n
  };
  const handover = {
    artifactVersion: 1,
    handoverContract: {
      contractSnapshot: {
        evidencePackage: { manifestHash },
        fileId: fileObject.id,
        handoverId: "handover-1",
        orderId: "order-1",
        stage2HandoverPdfArtifact: {
          artifactKind: "stage2-handover-pdf-source",
          artifactVersion: 1,
          fileId: fileObject.id,
          sourcePdfHash: SOURCE_PDF_HASH
        },
        workOrderId: "work-order-1"
      },
      customerId: "customer-1",
      deletedAt: null,
      fileId: fileObject.id,
      id: "contract-stage2-1",
      orderId: "order-1",
      status: ContractStatus.GENERATED
    },
    handoverContractId: "contract-stage2-1",
    handoverESignTaskId: null as string | null,
    id: "handover-1",
    manifestHash,
    orderId: "order-1",
    sourceDocumentFileId: fileObject.id,
    sourceObjectKey: fileObject.objectKey,
    sourcePdfHash: SOURCE_PDF_HASH,
    status: DeliveryHandoverStatus.SOURCE_GENERATED
  };
  const order = {
    customer: {
      id: "customer-1",
      mobile: "13800138000",
      name: "Customer"
    },
    customerId: "customer-1",
    id: "order-1",
    orderNo: "ORD-1",
    vehicle: {
      brand: "Tesla",
      model: "Model 3",
      plateNo: "SH-A12345",
      vin: "VIN123456789"
    }
  };
  const state: {
    activeTask: null | TestESignTask;
    customerJobTypes: VehicleHandoverWorkflowJobType[];
    notificationJob: {
      jobStatus: string;
    };
    otherTasks: TestESignTask[];
  } = {
    activeTask: null,
    customerJobTypes: [],
    notificationJob: {
      jobStatus: "COMPLETED"
    },
    otherTasks: []
  };
  const prisma = {
    contractESignTask: {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          [state.activeTask, ...state.otherTasks]
            .filter((task): task is TestESignTask => task !== null)
            .find((task) => matchesTaskWhere(task, where)) ?? null
      )
    },
    fileObject: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === fileObject.id ? fileObject : null
      )
    },
    subscriptionOrder: {
      findFirst: vi.fn(async () => order),
      findUnique: vi.fn(async () => order)
    },
    user: {
      findFirst: vi.fn(async () => ({
        mobile: FIELD_PHONE,
        status: "ACTIVE"
      }))
    },
    vehicleDeliveryHandover: {
      findFirst: vi.fn(async () => handover)
    },
    vehicleHandoverReviewAttempt: {
      findFirst: vi.fn(async () => null)
    },
    vehicleHandoverWorkOrder: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.id === workOrder.id &&
        where.fieldOperatorPhone === workOrder.fieldOperatorPhone
          ? workOrder
          : null
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.fieldOperatorPhone === workOrder.fieldOperatorPhone
          ? [workOrder]
          : []
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === workOrder.id ? workOrder : null
      )
    },
    vehicleHandoverWorkflowJob: {
      findFirst: vi.fn(async () => state.notificationJob),
      findMany: vi.fn(async () =>
        state.customerJobTypes.map((jobType) => ({ jobType }))
      )
    }
  };
  const evidence = {
    getChecklist: vi.fn(async (): Promise<unknown> => checklist)
  };
  const storage = {
    getObject: vi.fn(async () => ({
      contentLength: 9,
      contentType: "application/pdf",
      stream: Readable.from([Buffer.from("pdf-bytes")])
    }))
  };

  return {
    evidence,
    handover,
    prisma,
    service: new HandoverWorkOrderService(
      prisma as never,
      evidence as never,
      undefined,
      storage as never
    ),
    state,
    storage,
    workOrder
  };
}

function matchesTaskWhere(
  task: TestESignTask,
  where: Record<string, unknown>
): boolean {
  for (const key of [
    "contractId",
    "documentType",
    "id",
    "orderId",
    "signingStage"
  ] as const) {
    if (typeof where[key] === "string" && where[key] !== task[key]) {
      return false;
    }
  }
  const status = where.taskStatus;
  if (typeof status === "string" && status !== task.taskStatus) {
    return false;
  }
  if (
    status &&
    typeof status === "object" &&
    "in" in status &&
    Array.isArray(status.in) &&
    !status.in.includes(task.taskStatus)
  ) {
    return false;
  }
  const alternatives = where.OR;
  if (
    Array.isArray(alternatives) &&
    !alternatives.some(
      (alternative) =>
        alternative &&
        typeof alternative === "object" &&
        matchesTaskWhere(
          task,
          alternative as Record<string, unknown>
        )
    )
  ) {
    return false;
  }
  return true;
}

type TestESignTask = {
  contractId: string;
  documentType: ESignDocumentType;
  id: string;
  orderId: string;
  signers?: Array<{
    claimExpiresAt: Date | null;
    providerTransactionId: string | null;
    slotId: string;
  }>;
  signingStage: ESignSigningStage;
  taskStatus: ESignTaskStatus;
};

function stage2Task(
  overrides: Partial<TestESignTask> = {}
): TestESignTask {
  return {
    contractId: "contract-stage2-1",
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    id: "stage2-task-current",
    orderId: "order-1",
    signingStage:
      ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
    taskStatus: ESignTaskStatus.CREATED,
    ...overrides
  };
}

function fieldDetailController(
  harness: ReturnType<typeof createHarness>,
  readinessResult: {
    blockers: Array<{ code: string }>;
    ready: boolean;
  }
) {
  return Reflect.construct(FieldOperatorAuthController, [
    { recordTaskViewed: vi.fn(async () => undefined) },
    harness.service,
    {},
    {
      getReadiness: vi.fn(async () => ({
        ...readinessResult,
        state: {
          esignTaskId: null,
          esignTaskStatus: null,
          workOrderId: "work-order-1"
        }
      }))
    }
  ]) as FieldOperatorAuthController;
}

function emptyChecklist() {
  return {
    blockingReasons: [],
    items: [],
    ready: true
  };
}

function changedChecklist() {
  return {
    blockingReasons: [],
    items: [
      {
        evidenceType: "VEHICLE_FRONT",
        files: [
          {
            file: {
              id: "file-new",
              mimeType: "image/jpeg",
              originalName: "front.jpg",
              sizeBytes: 1024
            },
            fileId: "file-new",
            id: "evidence-file-new",
            mediaType: "PHOTO",
            metadata: {
              artifactVersion: 1,
              detectedMimeType: "image/jpeg",
              photoPreviewFileId: "preview-file-new",
              processedAt: "2026-07-27T08:00:00.000Z",
              processingStatus: "READY",
              sourceSha256: `sha256:${"d".repeat(64)}`,
              sourceSizeBytes: 1024,
              videoDurationMs: null,
              videoFrameFileIds: []
            },
            objectKey: "private/evidence/front.jpg",
            uploadedAt: new Date("2026-07-27T08:00:00.000Z")
          }
        ],
        id: "evidence-item-new",
        isRequired: true,
        status: "UPLOADED",
        title: "Vehicle front"
      }
    ],
    ready: true
  };
}
