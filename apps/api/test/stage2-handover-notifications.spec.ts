import { ConfigService } from "@nestjs/config";
import {
  NotificationChannel,
  NotificationEventStatus,
  NotificationEventType,
  NotificationStatus,
  NotificationType,
  SmsSendStatus,
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { Stage2HandoverWorkflowService } from "../src/handover-work-order/stage2-handover-workflow.service";
import { ClaimedStage2WorkflowJob } from "../src/handover-work-order/stage2-handover-workflow.types";
import { NotificationProvider } from "../src/notification/notification.provider";
import { NotificationService } from "../src/notification/notification.service";
import { SmsProvider } from "../src/sms/sms-provider";
import { SmsService } from "../src/sms/sms.service";

describe("Stage 2 handover notifications", () => {
  it("creates one customer SMS and one IN_APP notification", async () => {
    const harness = createHarness();

    await expect(harness.workflow.handle(customerJob())).resolves.toMatchObject({
      kind: "COMPLETED",
      result: {
        inApp: {
          status: NotificationStatus.SENT
        },
        sms: {
          status: SmsSendStatus.SENT
        }
      }
    });

    expect(harness.smsLogs).toHaveLength(1);
    expect(harness.notificationRecords).toHaveLength(1);
    expect(harness.notificationRecords[0]).toMatchObject({
      channel: NotificationChannel.IN_APP,
      customerId: "customer-1",
      notificationStatus: NotificationStatus.SENT,
      notificationType: NotificationType.HANDOVER_ESIGN_READY
    });
    expect(harness.notificationProvider.send).not.toHaveBeenCalled();
  });

  it("uses /portal/handover-reviews/:workOrderId as the in-app URL", async () => {
    const harness = createHarness();
    const job = customerJob();

    await harness.workflow.handle(job);

    expect(harness.notificationRecords[0]?.url).toBe(
      `https://portal.example/portal/handover-reviews/${job.workOrderId}`
    );
    expect(harness.notificationEvents).toEqual([
      expect.objectContaining({
        customerId: "customer-1",
        eventStatus: NotificationEventStatus.PROCESSED,
        eventType: NotificationEventType.HANDOVER_ESIGN_READY
      })
    ]);
  });

  it("retries the missing channel without duplicating the successful channel", async () => {
    const harness = createHarness({
      smsResults: [
        {
          errorCode: "TEMPORARY_FAILURE",
          errorMessage: "Temporary provider failure.",
          provider: "mock",
          success: false
        },
        {
          provider: "mock",
          providerMessageId: "mock-retry-success",
          providerResponse: { mock: true },
          success: true
        }
      ]
    });
    const job = customerJob();

    await expect(harness.workflow.handle(job)).rejects.toThrow("CUSTOMER_NOTIFICATION_INCOMPLETE");
    await expect(harness.workflow.handle(job)).resolves.toMatchObject({
      kind: "COMPLETED"
    });

    expect(harness.smsProvider.sendTemplate).toHaveBeenCalledTimes(2);
    expect(harness.smsLogs).toHaveLength(1);
    expect(harness.smsLogs[0]).toMatchObject({
      sendStatus: SmsSendStatus.SENT
    });
    expect(harness.notificationRecords).toHaveLength(1);
    expect(harness.notificationEvents).toHaveLength(1);
  });

  it("retries only IN_APP after SMS succeeds and IN_APP fails first", async () => {
    const harness = createHarness({
      failFirstInApp: true
    });
    const job = customerJob();

    await expect(harness.workflow.handle(job)).rejects.toThrow(
      "CUSTOMER_NOTIFICATION_INCOMPLETE"
    );
    await expect(harness.workflow.handle(job)).resolves.toMatchObject({
      kind: "COMPLETED"
    });

    expect(harness.smsProvider.sendTemplate).toHaveBeenCalledTimes(1);
    expect(harness.smsLogs).toHaveLength(1);
    expect(harness.smsLogs[0]).toMatchObject({
      sendStatus: SmsSendStatus.SENT
    });
    expect(harness.notificationRecords).toHaveLength(1);
    expect(harness.notificationEvents).toHaveLength(1);
  });

  it("marks NOTIFY_CUSTOMER_ESIGN_READY complete only after both channels succeed", async () => {
    const harness = createHarness({
      smsResults: [{
        errorCode: "TEMPORARY_FAILURE",
        errorMessage: "Temporary provider failure.",
        provider: "mock",
        success: false
      }]
    });

    await expect(harness.workflow.handle(customerJob())).rejects.toThrow(
      "CUSTOMER_NOTIFICATION_INCOMPLETE"
    );

    expect(harness.notificationRecords[0]).toMatchObject({
      notificationStatus: NotificationStatus.SENT
    });
    expect(harness.smsLogs[0]).toMatchObject({
      sendStatus: SmsSendStatus.FAILED
    });
  });

  it("completes the Field job only after its idempotent SMS succeeds", async () => {
    const harness = createHarness({ notificationStage: "FIELD_READY" });
    const job = fieldJob();

    const result = await harness.workflow.handle(job);

    expect(result).toMatchObject({
      kind: "COMPLETED",
      result: {
        sms: {
          status: SmsSendStatus.SENT
        }
      }
    });
    expect(harness.smsProvider.sendTemplate).toHaveBeenCalledWith({
      idempotencyKey: job.idempotencyKey,
      phone: "13800000000",
      purpose: "FIELD_HANDOVER_ESIGN_READY",
      templateCode: "SMS_FIELD_READY",
      templateParams: {}
    });
    expect(harness.notificationRecords).toHaveLength(0);
  });

  it("uses the canonical Field SMS key when a recovery job is processed", async () => {
    const harness = createHarness({ notificationStage: "FIELD_READY" });
    const job = fieldJob();
    job.idempotencyKey = "recovery:dead-letter-field-notification";
    job.payload = null;

    await harness.workflow.handle(job);

    expect(harness.smsProvider.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey:
          "field-notify:00000000-0000-4000-8000-000000000003:2"
      })
    );
  });

  it("notifies the currently assigned external operator with the vehicle plate", async () => {
    const harness = createHarness({ notificationStage: "ASSIGNED" });
    const job = assignmentJob();

    await expect(harness.workflow.handle(job)).resolves.toMatchObject({
      kind: "COMPLETED",
      result: {
        sms: {
          status: SmsSendStatus.SENT
        }
      }
    });

    expect(harness.smsProvider.sendTemplate).toHaveBeenCalledWith({
      idempotencyKey:
        "field-assigned:00000000-0000-4000-8000-000000000003:assignment-event-1",
      phone: "13800000000",
      purpose: "FIELD_HANDOVER_ASSIGNED",
      templateCode: "SMS_FIELD_ASSIGNED",
      templateParams: {
        name: "沪DGU580"
      }
    });
  });

  it("recomputes the assignment SMS business key for a recovery job", async () => {
    const harness = createHarness({ notificationStage: "ASSIGNED" });
    const job = assignmentJob();
    job.idempotencyKey = "recovery:dead-letter-assignment";

    await harness.workflow.handle(job);

    expect(harness.smsProvider.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey:
          "field-assigned:00000000-0000-4000-8000-000000000003:assignment-event-1"
      })
    );
  });

  it("completes a superseded assignment notification without sending SMS", async () => {
    const harness = createHarness({ notificationStage: "ASSIGNED" });
    harness.workOrder.events = [{
      createdAt: new Date("2026-07-27T09:00:00.000Z"),
      eventType: "EXTERNAL_OPERATOR_ASSIGNED",
      id: "assignment-event-2"
    }];

    await expect(harness.workflow.handle(assignmentJob())).resolves.toEqual({
      kind: "COMPLETED",
      result: {
        skipped: "ASSIGNMENT_SUPERSEDED"
      }
    });
    expect(harness.smsProvider.sendTemplate).not.toHaveBeenCalled();
  });

  it("rejects a current assignment without a recipient phone", async () => {
    const harness = createHarness({ notificationStage: "ASSIGNED" });
    harness.workOrder.externalOperatorPhone = null;
    harness.workOrder.fieldOperatorPhone = null;

    await expect(harness.workflow.handle(assignmentJob())).rejects.toThrow(
      "FIELD_HANDOVER_RECIPIENT_MISSING"
    );
    expect(harness.smsProvider.sendTemplate).not.toHaveBeenCalled();
  });

  it("rejects a current assignment without a vehicle plate", async () => {
    const harness = createHarness({ notificationStage: "ASSIGNED" });
    harness.workOrder.order.vehicle.plateNo = null;

    await expect(harness.workflow.handle(assignmentJob())).rejects.toThrow(
      "FIELD_HANDOVER_PLATE_NO_MISSING"
    );
    expect(harness.smsProvider.sendTemplate).not.toHaveBeenCalled();
  });

  it.each([
    ["Field", "FIELD_READY", fieldJob],
    ["Customer", "CUSTOMER_READY", customerJob]
  ] as const)(
    "does not send a stale %s notification after the work order becomes terminal",
    async (_label, notificationStage, jobFactory) => {
      const harness = createHarness({ notificationStage });
      harness.workOrder.status = "CANCELLED";

      await expect(harness.workflow.handle(jobFactory())).rejects.toThrow(
        "STAGE2_HANDOVER_NOTIFICATION_JOB_STALE"
      );

      expect(harness.smsProvider.sendTemplate).not.toHaveBeenCalled();
      expect(harness.smsLogs).toEqual([]);
      expect(harness.notificationRecords).toEqual([]);
    }
  );

  it("does not send a Field notification after the handover is archived", async () => {
    const harness = createHarness({ notificationStage: "FIELD_READY" });
    harness.workOrder.handover.archivedAt =
      new Date("2026-07-27T08:00:00.000Z");

    await expect(harness.workflow.handle(fieldJob())).rejects.toThrow(
      "STAGE2_HANDOVER_NOTIFICATION_JOB_STALE"
    );

    expect(harness.smsProvider.sendTemplate).not.toHaveBeenCalled();
    expect(harness.smsLogs).toEqual([]);
  });

  it("persists only bounded notification outcomes in workflow results", async () => {
    const harness = createHarness();
    const result = await harness.workflow.handle(customerJob());
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("13800000000");
    expect(serialized).not.toContain("13912345678");
    expect(serialized).not.toContain("Customer Sensitive Name");
    expect(serialized).not.toContain("VIN-SENSITIVE-001");
    expect(serialized).not.toContain("沪A12345");
    expect(serialized).not.toContain("https://provider.example/sign");
    expect(serialized).not.toContain("https://evidence.example/file");
    expect(serialized).not.toContain("task-token-secret");
  });

  it("claims every workflow job type with an implemented handler", () => {
    const harness = createHarness();

    expect(harness.workflow.supportedJobTypes).toEqual([
      VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF,
      VehicleHandoverWorkflowJobType.NOTIFY_FIELD_HANDOVER_ASSIGNED,
      VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY,
      VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY,
      VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
      VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM,
      VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL,
      VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF
    ]);
  });
});

function createHarness(options: {
  failFirstInApp?: boolean;
  notificationStage?: "ASSIGNED" | "CUSTOMER_READY" | "FIELD_READY";
  smsResults?: Array<{
    errorCode?: string;
    errorMessage?: string;
    provider: "aliyun" | "mock";
    providerMessageId?: string;
    providerRequestId?: string;
    providerResponse?: unknown;
    success: boolean;
  }>;
} = {}) {
  type TestRow = Record<string, unknown> & { id: string };
  const smsLogs: TestRow[] = [];
  const notificationRecords: TestRow[] = [];
  const notificationEvents: TestRow[] = [];
  let failFirstInApp = options.failFirstInApp ?? false;
  const workOrder = notificationWorkOrder(
    options.notificationStage ?? "CUSTOMER_READY"
  );
  const smsResults = [...(options.smsResults ?? [{
    provider: "mock" as const,
    providerMessageId: "mock-business-message",
    providerResponse: { mock: true },
    success: true
  }])];
  const smsProvider: SmsProvider = {
    sendCode: vi.fn(),
    sendTemplate: vi.fn(async () => smsResults.shift() ?? {
      provider: "mock" as const,
      providerMessageId: "mock-business-message",
      providerResponse: { mock: true },
      success: true
    })
  };
  const notificationProvider: NotificationProvider = {
    send: vi.fn(async () => ({
      providerMessageId: "unexpected-wechat-message",
      success: true
    }))
  };
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (operation: unknown) => {
      if (Array.isArray(operation)) {
        return Promise.all(operation);
      }
      return (operation as (tx: unknown) => Promise<unknown>)(prisma);
    }),
    customer: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
        where.id === "customer-1"
          ? {
              id: "customer-1",
              mobile: "13912345678",
              name: "Customer Sensitive Name"
            }
          : null
      )
    },
    customerAccount: {
      findFirst: vi.fn(async ({ where }: { where: { customerId?: string } }) =>
        where.customerId === "customer-1"
          ? {
              id: "account-1",
              phone: "13912345678",
              wechatOpenId: "openid-1"
            }
          : null
      )
    },
    notificationEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const event = {
          ...data,
          createdAt: new Date("2026-07-27T08:00:00.000Z"),
          id: `notification-event-${notificationEvents.length + 1}`,
          updatedAt: new Date("2026-07-27T08:00:00.000Z")
        } as TestRow;
        notificationEvents.push(event);
        return event;
      }),
      findFirst: vi.fn(async ({ where }: { where: { notificationId: string } }) =>
        notificationEvents.find((event) => event.notificationId === where.notificationId) ?? null
      ),
      update: vi.fn(async ({
        data,
        where
      }: {
        data: Record<string, unknown>;
        where: { id: string };
      }) => {
        const event = notificationEvents.find((item) => item.id === where.id);
        if (!event) throw new Error("notification event not found");
        Object.assign(event, data);
        return event;
      })
    },
    notificationRecord: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (failFirstInApp) {
          failFirstInApp = false;
          throw new Error("simulated IN_APP persistence failure");
        }
        if (notificationRecords.some((record) => record.notificationNo === data.notificationNo)) {
          throw Object.assign(new Error("unique conflict"), { code: "P2002" });
        }
        const record = {
          ...data,
          createdAt: new Date("2026-07-27T08:00:00.000Z"),
          deletedAt: null,
          id: `notification-record-${notificationRecords.length + 1}`,
          updatedAt: new Date("2026-07-27T08:00:00.000Z")
        } as TestRow;
        notificationRecords.push(record);
        return record;
      }),
      findUnique: vi.fn(async ({ where }: { where: { notificationNo: string } }) =>
        notificationRecords.find((record) => record.notificationNo === where.notificationNo) ?? null
      ),
      update: vi.fn(async ({
        data,
        where
      }: {
        data: Record<string, unknown>;
        where: { id: string };
      }) => {
        const record = notificationRecords.find((item) => item.id === where.id);
        if (!record) throw new Error("notification record not found");
        Object.assign(record, data);
        return record;
      })
    },
    smsSendLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (smsLogs.some((log) => log.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error("unique conflict"), { code: "P2002" });
        }
        const log = {
          ...data,
          createdAt: new Date("2026-07-27T08:00:00.000Z"),
          id: `sms-log-${smsLogs.length + 1}`
        } as TestRow;
        smsLogs.push(log);
        return log;
      }),
      findUnique: vi.fn(async ({
        where
      }: {
        where: { id?: string; idempotencyKey?: string };
      }) =>
        smsLogs.find((log) =>
          where.id !== undefined
            ? log.id === where.id
            : log.idempotencyKey === where.idempotencyKey
        ) ?? null
      ),
      updateMany: vi.fn(async ({
        data,
        where
      }: {
        data: Record<string, unknown>;
        where: { id: string; sendStatus?: SmsSendStatus };
      }) => {
        const log = smsLogs.find((item) =>
          item.id === where.id &&
          (
            where.sendStatus === undefined ||
            item.sendStatus === where.sendStatus
          )
        );
        if (!log) {
          return { count: 0 };
        }
        Object.assign(log, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({
        data,
        where
      }: {
        data: Record<string, unknown>;
        where: { id: string };
      }) => {
        const log = smsLogs.find((item) => item.id === where.id);
        if (!log) throw new Error("SMS log not found");
        Object.assign(log, data);
        return log;
      })
    },
    fileObject: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "00000000-0000-4000-8000-000000000030"
          ? workOrder.handover.sourceFileObject
          : null
      )
    },
    vehicleHandoverWorkOrder: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "00000000-0000-4000-8000-000000000003"
          ? workOrder
          : null
      )
    }
  };
  const config = new ConfigService({
    ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE: "SMS_CUSTOMER_READY",
    ALIYUN_SMS_FIELD_HANDOVER_ASSIGNED_TEMPLATE_CODE: "SMS_FIELD_ASSIGNED",
    ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE: "SMS_FIELD_READY",
    FIELD_OPERATOR_SMS_ENABLED: "true",
    FIELD_OPERATOR_SMS_PROVIDER: "mock",
    PORTAL_BASE_URL: "https://portal.example",
    PORTAL_SMS_ENABLED: "true",
    PORTAL_SMS_PROVIDER: "mock",
    STAGE2_HANDOVER_WORKER_LEASE_MS: "120000",
    STAGE2_HANDOVER_WORKFLOW_ENABLED: "true"
  });
  const smsService = new SmsService(config, prisma as never, smsProvider);
  const notificationService = new NotificationService(
    config,
    notificationProvider,
    prisma as never
  );
  const repository = {
    renewLease: vi.fn(async () => true)
  };
  const workflow = new Stage2HandoverWorkflowService(
    prisma as never,
    config,
    repository as never,
    {} as never,
    smsService,
    notificationService
  );

  return {
    notificationEvents,
    notificationProvider,
    notificationRecords,
    prisma,
    smsLogs,
    smsProvider,
    workOrder,
    workflow
  };
}

function notificationWorkOrder(
  notificationStage: "ASSIGNED" | "CUSTOMER_READY" | "FIELD_READY"
) {
  const manifestDigest = "a".repeat(64);
  const sourcePdfHash = "b".repeat(64);
  const customerReady = notificationStage === "CUSTOMER_READY";
  const handover = {
    archiveStatus: "NOT_STARTED",
    archivedAt: null as Date | null,
    artifactVersion: 2,
    deletedAt: null,
    handoverContract: {
      contractSnapshot: {
        evidencePackage: {
          manifestHash: `sha256:${manifestDigest}`
        },
        fileId: "00000000-0000-4000-8000-000000000030",
        handoverId: "00000000-0000-4000-8000-000000000020",
        orderId: "order-1",
        stage2HandoverPdfArtifact: {
          artifactVersion: 2,
          fileId: "00000000-0000-4000-8000-000000000030",
          sourcePdfHash
        },
        workOrderId: "00000000-0000-4000-8000-000000000003"
      },
      customerId: "customer-1",
      deletedAt: null,
      fileId: "00000000-0000-4000-8000-000000000030",
      id: "contract-stage2-1",
      orderId: "order-1",
      status: customerReady ? "SIGNING" : "GENERATED"
    },
    handoverContractId: "contract-stage2-1",
    handoverESignTask: customerReady
      ? {
          contractId: "contract-stage2-1",
          customerId: "customer-1",
          deletedAt: null,
          documentType: "DELIVERY_HANDOVER",
          id: "00000000-0000-4000-8000-000000000010",
          orderId: "order-1",
          requestSnapshot: {
            artifactVersion: 2,
            contractId: "contract-stage2-1",
            documentType: "DELIVERY_HANDOVER",
            handoverId: "00000000-0000-4000-8000-000000000020",
            manifestHash: manifestDigest,
            signingStage: "STAGE2_DELIVERY_HANDOVER",
            slotIds: [
              "STAGE2_HANDOVER_CUSTOMER",
              "STAGE2_HANDOVER_PLATFORM"
            ],
            sourceDocumentFileId:
              "00000000-0000-4000-8000-000000000030",
            sourcePdfHash
          },
          signers: [
            {
              customerId: "customer-1",
              deletedAt: null,
              documentType: "DELIVERY_HANDOVER",
              providerActionType: "CUSTOMER_MANUAL_SIGN",
              providerTransactionId: "HDVTRANSACTIONH1",
              required: true,
              signerStatus: "SIGNING",
              signerType: "CUSTOMER",
              slotId: "STAGE2_HANDOVER_CUSTOMER"
            },
            {
              customerId: null,
              deletedAt: null,
              documentType: "DELIVERY_HANDOVER",
              providerActionType: "PLATFORM_AUTO_SEAL",
              providerTransactionId: null,
              required: true,
              signerStatus: "PENDING",
              signerType: "PLATFORM",
              slotId: "STAGE2_HANDOVER_PLATFORM"
            }
          ],
          signingStage: "STAGE2_DELIVERY_HANDOVER",
          taskNo: "HDVTRANSACTION",
          taskStatus: "WAITING_CUSTOMER"
        }
      : null,
    handoverESignTaskId: customerReady
      ? "00000000-0000-4000-8000-000000000010"
      : null,
    id: "00000000-0000-4000-8000-000000000020",
    manifestHash: manifestDigest,
    orderId: "order-1",
    sourceDocumentFileId: "00000000-0000-4000-8000-000000000030",
    sourceFileObject: {
      bucket: "application-materials",
      id: "00000000-0000-4000-8000-000000000030",
      mimeType: "application/pdf",
      objectKey: "contracts/contract-stage2-1/generated/handover.pdf",
      sizeBytes: 1024n
    },
    sourceObjectKey: "contracts/contract-stage2-1/generated/handover.pdf",
    sourcePdfHash,
    status: customerReady
      ? "PENDING_CUSTOMER_SIGNATURE"
      : "SOURCE_GENERATED"
  };
  const confirmedAt = new Date("2026-07-27T07:00:00.000Z");
  return {
    customerConfirmedAt: confirmedAt,
    customerObjectedAt: null,
    events: [
      {
        createdAt: new Date("2026-07-27T08:00:00.000Z"),
        eventType: "EXTERNAL_OPERATOR_ASSIGNED",
        id: "assignment-event-1"
      }
    ],
    externalOperatorPhone: "13800000000" as string | null,
    fieldOperatorPhone: "13800000000" as string | null,
    handover,
    handoverId: handover.id,
    handoverType: "DELIVERY_OUTBOUND",
    id: "00000000-0000-4000-8000-000000000003",
    operatorType: "EXTERNAL",
    order: {
      customer: {
        id: "customer-1",
        mobile: "13912345678",
        name: "Customer Sensitive Name"
      },
      customerId: "customer-1",
      id: "order-1",
      vehicle: {
        id: "vehicle-1",
        plateNo: "沪DGU580" as string | null,
        licensePlate: "沪A12345",
        vin: "VIN-SENSITIVE-001"
      },
      vehicleId: "vehicle-1"
    },
    orderId: "order-1",
    reviewAttempts: [
      {
        customerConfirmedAt: confirmedAt,
        evidenceSnapshot: {
          evidencePackage: {
            manifestHash: `sha256:${manifestDigest}`
          }
        },
        handoverId: handover.id,
        id: "review-attempt-1",
        orderId: "order-1",
        status: "CUSTOMER_CONFIRMED",
        workOrderId: "00000000-0000-4000-8000-000000000003"
      }
    ],
    status: notificationStage === "ASSIGNED"
      ? "ASSIGNED"
      : customerReady
        ? "SIGNING"
        : "CUSTOMER_CONFIRMED"
  };
}

function customerJob(): ClaimedStage2WorkflowJob {
  return claimedJob({
    eSignTaskId: "00000000-0000-4000-8000-000000000010",
    handoverId: "00000000-0000-4000-8000-000000000020",
    idempotencyKey:
      "customer-notify:00000000-0000-4000-8000-000000000010:HDVTRANSACTIONH1",
    jobType: VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY,
    payload: {
      customerTransactionId: "HDVTRANSACTIONH1"
    }
  });
}

function fieldJob(): ClaimedStage2WorkflowJob {
  return claimedJob({
    handoverId: "00000000-0000-4000-8000-000000000020",
    idempotencyKey: "field-notify:00000000-0000-4000-8000-000000000003:2",
    jobType: VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY,
    payload: {
      artifactVersion: 2,
      manifestHash: `sha256:${"a".repeat(64)}`,
      sourcePdfHash: "b".repeat(64)
    }
  });
}

function assignmentJob(): ClaimedStage2WorkflowJob {
  return claimedJob({
    handoverId: "00000000-0000-4000-8000-000000000020",
    idempotencyKey:
      "field-assigned:00000000-0000-4000-8000-000000000003:assignment-event-1",
    jobType: VehicleHandoverWorkflowJobType.NOTIFY_FIELD_HANDOVER_ASSIGNED,
    payload: {
      assignmentEventId: "assignment-event-1"
    }
  });
}

function claimedJob(
  overrides: Partial<ClaimedStage2WorkflowJob>
): ClaimedStage2WorkflowJob {
  const now = new Date("2026-07-27T08:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    completedAt: null,
    createdAt: now,
    eSignTaskId: null,
    handoverId: null,
    id: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: "stage2-notification-test",
    jobStatus: VehicleHandoverWorkflowJobStatus.PROCESSING,
    jobType: VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY,
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date(now.getTime() + 120_000),
    leaseToken: "00000000-0000-4000-8000-000000000002",
    maxAttempts: 5,
    payload: null,
    resultSnapshot: null,
    startedAt: now,
    updatedAt: now,
    workOrderId: "00000000-0000-4000-8000-000000000003",
    ...overrides
  };
}
