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
          availableAt: new Date("2026-07-27T08:02:00.000Z"),
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
    createdAt: new Date("2026-07-27T08:00:00.000Z"),
    customerConfirmedAt: new Date("2026-07-27T07:00:00.000Z"),
    fieldOperatorPhone: FIELD_PHONE,
    handoverId: "handover-1",
    id: "work-order-1",
    orderId: "order-1",
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
  const prisma = {
    fileObject: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === fileObject.id ? fileObject : null
      )
    },
    subscriptionOrder: {
      findFirst: vi.fn(async () => order),
      findUnique: vi.fn(async () => order)
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
    service: new HandoverWorkOrderService(
      prisma as never,
      evidence as never,
      undefined,
      storage as never
    ),
    storage,
    workOrder
  };
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
