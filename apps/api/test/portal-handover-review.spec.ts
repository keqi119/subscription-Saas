import { BadRequestException, ExecutionContext, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import {
  ContractStatus,
  DeliveryHandoverStatus,
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { DeliveryEvidenceService } from "../src/delivery-evidence/delivery-evidence.service";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
import { Stage2HandoverWorkflowRepository } from "../src/handover-work-order/stage2-handover-workflow.repository";
import { Stage2HandoverWorkflowService } from "../src/handover-work-order/stage2-handover-workflow.service";
import { CustomerAuthGuard } from "../src/portal/portal-auth.guard";
import { CurrentCustomer } from "../src/portal/portal-auth.types";
import { PortalHandoverReviewController } from "../src/portal/portal-handover-review.controller";
import { PortalHandoverReviewService } from "../src/portal/portal-handover-review.service";

describe("Portal handover review API", () => {
  it("requires Portal customer auth on review routes", async () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, PortalHandoverReviewController) ?? [];
    expect(guards).toContain(CustomerAuthGuard);

    const guard = new CustomerAuthGuard({
      getCookieName: () => "customer_access_token",
      validateToken: vi.fn()
    } as never);

    await expect(guard.canActivate(contextFor({ cookies: {}, headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it("lists only customer-owned reviewable handover work orders", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(
      completeReviewWorkOrder(harness),
      completeReviewWorkOrder(harness, { id: "work-order-other", orderId: "order-other" }),
      completeReviewWorkOrder(harness, { id: "work-order-draft", status: "FIELD_IN_PROGRESS" }),
      completeReviewWorkOrder(harness, { id: "work-order-cancelled", status: "CANCELLED" })
    );

    const reviews = await harness.service.listReviews(currentCustomer("customer-1"));

    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      id: "work-order-1",
      orderNo: "ORD-PORTAL-REVIEW-001",
      status: "CUSTOMER_REVIEWING"
    });
    expect(harness.prisma.vehicleHandoverWorkOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          order: expect.objectContaining({ customerId: "customer-1" })
        })
      })
    );
  });

  it("returns safe list DTOs without storage, identity, signing, or finance internals", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness));

    const reviews = await harness.service.listReviews(currentCustomer("customer-1"));
    const serialized = stringifyForSafety(reviews);

    expect(reviews[0]).toMatchObject({
      customer: {
        displayName: "测试客户A",
        mobileMasked: "FUL****LEAK"
      },
      evidenceProgress: {
        total: 14,
        uploaded: 14
      },
      vehicle: {
        brand: "NIO",
        model: "Stage2 Sandbox",
        vinSuffix: "765432"
      }
    });
    expect(serialized).not.toContain("FULL_PHONE_SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("SYNTHETIC_ID_SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("oss/private");
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain("signingUrl");
    expect(serialized).not.toContain("monthlyFeeAmount");
    expect(serialized).not.toContain("depositAmount");
  });

  it("returns detail field facts, evidence summary, and readiness without exposing object keys", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness));

    const detail = await harness.service.getReview("work-order-1", currentCustomer("customer-1"));
    const serialized = stringifyForSafety(detail);

    expect(detail).toMatchObject({
      evidencePackage: {
        confirmationText: expect.stringContaining("全部照片和视频"),
        fileCount: 14,
        manifestHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        photoCount: 14,
        videoCount: 0
      },
      evidenceChecklist: {
        ready: true
      },
      fieldFacts: {
        accessoryChecklist: { chargingCable: true, keys: 2 },
        handoverMileageKm: 28600,
        noVisibleDamageDeclared: true
      },
      readiness: {
        readyForStage2ESign: false,
        readyForStage2Pdf: false
      }
    });
    expect(detail.evidenceChecklist.items).toHaveLength(14);
    expect(detail.evidenceChecklist.items[0]).toMatchObject({
      fileCount: 1,
      files: [
        expect.objectContaining({
          mediaType: "PHOTO"
        })
      ]
    });
    expect(serialized).not.toContain("oss/private");
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain("SYNTHETIC_ID_SHOULD_NOT_LEAK");
  });

  it("returns Portal evidence file links as safe proxy URLs only", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness));

    const detail = await harness.service.getReview("work-order-1", currentCustomer("customer-1"));
    const firstFile = detail.evidenceChecklist?.items?.[0]?.files?.[0];
    const serialized = stringifyForSafety(detail);

    expect(firstFile).toMatchObject({
      displayName: "evidence-1.jpg",
      downloadUrl: "/api/portal/handover-reviews/work-order-1/evidence-files/evidence-file-1/download",
      evidenceFileId: "evidence-file-1",
      mimeType: "image/jpeg",
      previewAvailable: true,
      previewUrl: "/api/portal/handover-reviews/work-order-1/evidence-files/evidence-file-1/preview",
      sizeBytes: 1024
    });
    expect(serialized).not.toContain("oss/private");
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain("bucket");
    expect(firstFile).not.toHaveProperty("fileId");
    expect(firstFile?.file).not.toHaveProperty("id");
  });

  it("keeps historical unprocessed evidence visible but disables manifest-bound confirmation", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness));
    harness.state.evidenceChecklist.items[0]!.files[0]!.metadata.processingStatus = "PENDING";

    const detail = await harness.service.getReview("work-order-1", currentCustomer("customer-1"));

    expect(detail.evidenceChecklist.items[0]?.files).toHaveLength(1);
    expect(detail.evidencePackage).toMatchObject({
      fileCount: 14,
      manifestHash: null,
      ready: false
    });
    expect(detail.readiness).toMatchObject({
      readyForStage2ESign: false,
      readyForStage2Pdf: false
    });
  });

  it("does not disguise unexpected evidence package failures as normal processing state", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness));
    vi.spyOn(harness.handoverWorkOrderService, "getCurrentEvidencePackage")
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      harness.service.getReview("work-order-1", currentCustomer("customer-1"))
    ).rejects.toThrow("database unavailable");
  });

  it("streams only customer-owned evidence files through the Portal proxy", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness));

    const preview = await (
      harness.service as PortalHandoverReviewService & {
        previewEvidenceFile: (
          id: string,
          evidenceFileId: string,
          currentCustomer: CurrentCustomer
        ) => Promise<{ filename: string; mimeType: string | null; sizeBytes: number | null; stream: unknown }>;
      }
    ).previewEvidenceFile("work-order-1", "evidence-file-1", currentCustomer("customer-1"));

    expect(preview).toMatchObject({
      filename: "evidence-1.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1024
    });
    expect(harness.storageService.getObject).toHaveBeenCalledWith("application-materials", expect.any(String));
    const storageCalls = harness.storageService.getObject.mock.calls as unknown as Array<[string, string]>;
    expect(storageCalls[0]?.[1]).not.toContain("other-order");
    await expect(
      (
        harness.service as PortalHandoverReviewService & {
          previewEvidenceFile: (
            id: string,
            evidenceFileId: string,
            currentCustomer: CurrentCustomer
          ) => Promise<unknown>;
        }
      ).previewEvidenceFile("work-order-1", "evidence-file-other", currentCustomer("customer-1"))
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      (
        harness.service as PortalHandoverReviewService & {
          previewEvidenceFile: (
            id: string,
            evidenceFileId: string,
            currentCustomer: CurrentCustomer
          ) => Promise<unknown>;
        }
      ).previewEvidenceFile("work-order-1", "evidence-file-1", currentCustomer("customer-other"))
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("does not allow a customer to read another customer's review", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness));

    await expect(
      harness.service.getReview("work-order-1", currentCustomer("customer-other"))
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("confirms no objection from customer-review state and only unlocks readiness", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness));

    await expect(harness.handoverWorkOrderService.assertReadyForStage2Pdf(harness.orderId)).rejects.toThrow(
      "客户尚未确认"
    );
    const review = await harness.service.getReview("work-order-1", currentCustomer("customer-1"));

    const detail = await harness.service.confirmNoObjection(
      "work-order-1",
      {
        acknowledgement: true,
        manifestHash: review.evidencePackage.manifestHash!
      },
      currentCustomer("customer-1")
    );

    expect(detail).toMatchObject({
      customerConfirmedAt: expect.any(Date),
      readiness: {
        readyForDeliveryConfirmation: true,
        readyForStage2ESign: true,
        readyForStage2Pdf: true
      },
      status: "CUSTOMER_CONFIRMED"
    });
    await expect(harness.handoverWorkOrderService.assertReadyForStage2ESign(harness.orderId)).resolves.toBeUndefined();
    expect(harness.state.reviewAttempts[0]).toMatchObject({
      evidenceSnapshot: {
        evidencePackage: {
          manifestHash: review.evidencePackage.manifestHash
        }
      },
      status: "CUSTOMER_CONFIRMED"
    });
    const firstMetadata = harness.state.evidenceChecklist.items[0]!.files[0]!.metadata;
    firstMetadata.sourceSha256 = `sha256:${"e".repeat(64)}`;
    await expect(harness.handoverWorkOrderService.assertReadyForStage2Pdf(harness.orderId)).rejects.toThrow(
      "客户确认未绑定当前交接证据"
    );
    expectNoStage2SideEffects(harness);
  });

  it("returns PDF_PENDING and the same durable job for repeated workflow confirmation", async () => {
    const harness = createPortalReviewHarness({ workflowEnabled: true });
    harness.state.workOrders.push(completeReviewWorkOrder(harness));
    const review = await harness.service.getReview(
      "work-order-1",
      currentCustomer("customer-1")
    );
    const input = {
      acknowledgement: true,
      manifestHash: review.evidencePackage.manifestHash!
    };

    const first = await harness.service.confirmNoObjection(
      "work-order-1",
      input,
      currentCustomer("customer-1")
    );
    const repeated = await harness.service.confirmNoObjection(
      "work-order-1",
      input,
      currentCustomer("customer-1")
    );

    expect(first.stage2Workflow).toMatchObject({
      jobId: harness.state.workflowJobs[0]!.id,
      state: "PDF_PENDING"
    });
    expect(repeated.stage2Workflow).toEqual(first.stage2Workflow);
    expect(harness.state.workflowJobs).toHaveLength(1);
    expect(harness.state.workflowJobs[0]).toMatchObject({
      jobType: VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF,
      jobStatus: VehicleHandoverWorkflowJobStatus.PENDING
    });
    expectNoStage2SideEffects(harness);
  });

  it.each([
    ["PDF_PENDING", null],
    ["PDF_READY", 1],
    ["WORKFLOW_EXCEPTION", null]
  ] as const)(
    "exposes the local %s workflow projection without advancing provider state",
    async (state, artifactVersion) => {
      const harness = createPortalReviewHarness({
        workflowEnabled: true,
        workflowProjection: {
          artifactVersion,
          errorCode: state === "WORKFLOW_EXCEPTION" ? "WORKFLOW_ERROR" : null,
          jobId: "workflow-job-1",
          state
        }
      });
      harness.state.workOrders.push(completeReviewWorkOrder(harness));

      const detail = await harness.service.getReview(
        "work-order-1",
        currentCustomer("customer-1")
      );

      expect(detail.stage2Workflow).toEqual({
        artifactVersion,
        errorCode: state === "WORKFLOW_EXCEPTION" ? "WORKFLOW_ERROR" : null,
        jobId: "workflow-job-1",
        state
      });
      expect(harness.stage2HandoverWorkflowService.getProjection)
        .toHaveBeenCalledWith("work-order-1");
      expectNoStage2SideEffects(harness);
    }
  );

  it("rejects a stale evidence manifest hash and leaves the review unconfirmed", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness));

    await expect(harness.service.confirmNoObjection(
      "work-order-1",
      {
        acknowledgement: true,
        manifestHash: `sha256:${"f".repeat(64)}`
      },
      currentCustomer("customer-1")
    )).rejects.toThrow("交接证据已变化");

    expect(harness.state.workOrders[0]).toMatchObject({
      customerConfirmedAt: null,
      status: "CUSTOMER_REVIEWING"
    });
  });

  it("blocks confirmation before field evidence is submitted", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness, { status: "FIELD_IN_PROGRESS" }));

    await expect(
      harness.service.confirmNoObjection(
        "work-order-1",
        { acknowledgement: true, manifestHash: `sha256:${"0".repeat(64)}` },
        currentCustomer("customer-1")
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expectNoStage2SideEffects(harness);
  });

  it("returns a clear already-confirmed error instead of silently confirming twice", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(
      completeReviewWorkOrder(harness, {
        customerConfirmedAt: harness.now,
        status: "CUSTOMER_CONFIRMED"
      })
    );

    await expect(
      harness.service.confirmNoObjection(
        "work-order-1",
        { acknowledgement: true, manifestHash: `sha256:${"0".repeat(64)}` },
        currentCustomer("customer-1")
      )
    ).rejects.toThrow("客户已确认");
  });

  it("blocks confirmation for objected or unrelated reviews", async () => {
    const objectedHarness = createPortalReviewHarness();
    objectedHarness.state.workOrders.push(
      completeReviewWorkOrder(objectedHarness, {
        customerObjectedAt: objectedHarness.now,
        customerObjectionReason: "车辆外观有异议",
        status: "CUSTOMER_OBJECTED"
      })
    );
    await expect(
      objectedHarness.service.confirmNoObjection(
        "work-order-1",
        { acknowledgement: true, manifestHash: `sha256:${"0".repeat(64)}` },
        currentCustomer("customer-1")
      )
    ).rejects.toThrow("客户已提交异议");

    const unrelatedHarness = createPortalReviewHarness();
    unrelatedHarness.state.workOrders.push(completeReviewWorkOrder(unrelatedHarness));
    await expect(
      unrelatedHarness.service.confirmNoObjection(
        "work-order-1",
        { acknowledgement: true, manifestHash: `sha256:${"0".repeat(64)}` },
        currentCustomer("customer-other")
      )
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("submits an objection from customer-review state and blocks Stage 2 readiness", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness));

    const detail = await harness.service.objectReview(
      "work-order-1",
      { details: "右前轮毂需要复核", reason: "车辆外观有异议" },
      currentCustomer("customer-1")
    );

    expect(detail).toMatchObject({
      objection: {
        details: "右前轮毂需要复核",
        reason: "车辆外观有异议"
      },
      readiness: {
        readyForStage2ESign: false,
        readyForStage2Pdf: false
      },
      status: "CUSTOMER_OBJECTED"
    });
    await expect(harness.handoverWorkOrderService.assertReadyForStage2Pdf(harness.orderId)).rejects.toThrow(
      "客户存在异议"
    );
    expectNoStage2SideEffects(harness);
  });

  it("requires a non-empty objection reason", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness));

    await expect(
      harness.service.objectReview("work-order-1", { reason: "   " }, currentCustomer("customer-1"))
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("blocks objection for unrelated, already objected, confirmed, or terminal reviews", async () => {
    const unrelatedHarness = createPortalReviewHarness();
    unrelatedHarness.state.workOrders.push(completeReviewWorkOrder(unrelatedHarness));
    await expect(
      unrelatedHarness.service.objectReview(
        "work-order-1",
        { reason: "车辆外观有异议" },
        currentCustomer("customer-other")
      )
    ).rejects.toBeInstanceOf(NotFoundException);

    for (const status of ["CUSTOMER_OBJECTED", "CUSTOMER_CONFIRMED", "VOIDED", "FAILED", "CANCELLED"]) {
      const harness = createPortalReviewHarness();
      harness.state.workOrders.push(completeReviewWorkOrder(harness, { status }));
      await expect(
        harness.service.objectReview("work-order-1", { reason: "车辆外观有异议" }, currentCustomer("customer-1"))
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("hides voided, cancelled, and failed reviews from Portal detail", async () => {
    for (const status of ["VOIDED", "FAILED", "CANCELLED"]) {
      const harness = createPortalReviewHarness();
      harness.state.workOrders.push(completeReviewWorkOrder(harness, { status }));

      await expect(
        harness.service.getReview("work-order-1", currentCustomer("customer-1"))
      ).rejects.toBeInstanceOf(NotFoundException);
    }
  });
});

describe("Stage2HandoverWorkflowService local projection", () => {
  it.each([
    {
      label: "handover status",
      mutate(source: Record<string, unknown>) {
        source.status = DeliveryHandoverStatus.DRAFT;
      }
    },
    {
      label: "Contract artifact snapshot",
      mutate(source: Record<string, unknown>) {
        const contract = source.handoverContract as Record<string, unknown>;
        const snapshot = contract.contractSnapshot as Record<string, unknown>;
        snapshot.stage2HandoverPdfArtifact = {
          artifactVersion: 2,
          fileId: "different-file",
          sourcePdfHash: "f".repeat(64)
        };
      }
    }
  ])(
    "returns WORKFLOW_EXCEPTION when the local $label is invalid",
    async ({ mutate }) => {
      const manifestHash = "a".repeat(64);
      const sourcePdfHash = "b".repeat(64);
      const source: Record<string, unknown> = {
        artifactVersion: 1,
        handoverContract: {
          contractSnapshot: {
            evidencePackage: {
              manifestHash: `sha256:${manifestHash}`
            },
            fileId: "file-pdf-1",
            handoverId: "handover-1",
            orderId: "order-1",
            stage2HandoverPdfArtifact: {
              artifactVersion: 1,
              fileId: "file-pdf-1",
              sourcePdfHash
            },
            workOrderId: "work-order-1"
          },
          customerId: "customer-1",
          deletedAt: null,
          fileId: "file-pdf-1",
          id: "contract-stage2-1",
          orderId: "order-1",
          status: ContractStatus.GENERATED
        },
        handoverContractId: "contract-stage2-1",
        id: "handover-1",
        manifestHash,
        orderId: "order-1",
        sourceDocumentFileId: "file-pdf-1",
        sourceObjectKey: "contracts/contract-stage2-1/generated/source.pdf",
        sourcePdfHash,
        status: DeliveryHandoverStatus.SOURCE_GENERATED
      };
      mutate(source);
      const prisma = {
        fileObject: {
          findUnique: vi.fn(async () => ({
            bucket: "application-materials",
            id: "file-pdf-1",
            mimeType: "application/pdf",
            objectKey: source.sourceObjectKey,
            sizeBytes: 1024n
          }))
        },
        vehicleHandoverWorkflowJob: {
          findFirst: vi.fn(async () => ({
            id: "workflow-job-1",
            jobStatus: VehicleHandoverWorkflowJobStatus.COMPLETED,
            payload: { manifestHash: `sha256:${manifestHash}` }
          }))
        },
        vehicleHandoverWorkOrder: {
          findUnique: vi.fn(async () => ({
            handover: source,
            handoverId: "handover-1",
            id: "work-order-1",
            order: { customerId: "customer-1" },
            orderId: "order-1"
          }))
        }
      };
      const service = new Stage2HandoverWorkflowService(
        prisma as never,
        new ConfigService({ STAGE2_HANDOVER_WORKFLOW_ENABLED: "true" }),
        {} as never,
        {} as never
      );

      await expect(service.getProjection("work-order-1")).resolves.toEqual({
        artifactVersion: null,
        errorCode: "SOURCE_ARTIFACT_INVALID",
        jobId: "workflow-job-1",
        state: "WORKFLOW_EXCEPTION"
      });
      expect(prisma.fileObject.findUnique).toHaveBeenCalledOnce();
    }
  );
});

function createPortalReviewHarness(options: {
  workflowEnabled?: boolean;
  workflowProjection?: {
    artifactVersion: number | null;
    errorCode: null | string;
    jobId: null | string;
    state: "PDF_PENDING" | "PDF_READY" | "WORKFLOW_EXCEPTION";
  };
} = {}) {
  const now = new Date("2026-07-22T08:00:00.000Z");
  const orderId = "order-1";
  const state = {
    evidenceChecklist: completeEvidenceChecklist(now),
    evidenceComplete: true,
    evidenceFiles: [
      {
        evidenceItem: {
          handoverId: "handover-1",
          id: "evidence-item-1",
          orderId
        },
        evidenceItemId: "evidence-item-1",
        file: {
          bucket: "application-materials",
          id: "file-1",
          mimeType: "image/jpeg",
          objectKey: "delivery-evidence/work-order-1/front.jpg",
          originalName: "evidence-1.jpg",
          sizeBytes: 1024n
        },
        fileId: "file-1",
        id: "evidence-file-1",
        mediaType: "PHOTO",
        objectKey: "oss/private/evidence-link/1.jpg",
        uploadedAt: now
      },
      {
        evidenceItem: {
          handoverId: "handover-other",
          id: "evidence-item-other",
          orderId: "order-other"
        },
        evidenceItemId: "evidence-item-other",
        file: {
          bucket: "application-materials",
          id: "file-other",
          mimeType: "image/jpeg",
          objectKey: "delivery-evidence/other-order/front.jpg",
          originalName: "other.jpg",
          sizeBytes: 1024n
        },
        fileId: "file-other",
        id: "evidence-file-other",
        mediaType: "PHOTO",
        objectKey: "oss/private/evidence-link/other.jpg",
        uploadedAt: now
      }
    ],
    orders: [
      {
        customer: {
          customerNo: "CUS-001",
          id: "customer-1",
          idCardNo: "SYNTHETIC_ID_SHOULD_NOT_LEAK",
          mobile: "FULL_PHONE_SHOULD_NOT_LEAK",
          name: "测试客户A"
        },
        customerId: "customer-1",
        deletedAt: null,
        depositAmount: 1000000n,
        id: orderId,
        monthlyFeeAmount: 399900n,
        orderNo: "ORD-PORTAL-REVIEW-001",
        vehicle: {
          brand: "NIO",
          id: "vehicle-1",
          model: "Stage2 Sandbox",
          plateNo: "沪A12345",
          series: "ES6",
          vin: "LJ1Synthetic98765432"
        },
        vehicleId: "vehicle-1"
      },
      {
        customer: {
          customerNo: "CUS-002",
          id: "customer-other",
          mobile: "OTHER_PHONE_SHOULD_NOT_LEAK",
          name: "测试客户B"
        },
        customerId: "customer-other",
        deletedAt: null,
        id: "order-other",
        orderNo: "ORD-PORTAL-REVIEW-OTHER",
        vehicle: {
          brand: "NIO",
          id: "vehicle-other",
          model: "Other Sandbox",
          plateNo: "沪B98765",
          vin: "LJ1Synthetic12345678"
        },
        vehicleId: "vehicle-other"
      }
    ],
    reviewAttempts: [] as Array<Record<string, unknown>>,
    workflowJobs: [] as Array<Record<string, unknown>>,
    workOrders: [] as Array<Record<string, unknown>>
  };

  const prisma = {
    $queryRaw: vi.fn(async () => [{ availableAt: now }]),
    contract: { create: vi.fn() },
    contractESignTask: { create: vi.fn() },
    lease: { create: vi.fn() },
    paymentRecord: { create: vi.fn() },
    receivableBill: { create: vi.fn() },
    subscriptionOrder: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        state.orders.find((order) => order.id === where.id) ?? null
      )
    },
    vehicleDelivery: {
      update: vi.fn()
    },
    vehicleDeliveryEvidenceFile: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.evidenceFiles.find((file) => matchesEvidenceFileWhere(file, where)) ?? null
      )
    },
    vehicleHandoverReviewAttempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const attempt = {
          ...data,
          createdAt: now,
          id: `review-attempt-${state.reviewAttempts.length + 1}`,
          updatedAt: now
        };
        state.reviewAttempts.push(attempt);
        return attempt;
      }),
      findFirst: vi.fn(async ({ where }: { where: { workOrderId?: string } }) =>
        [...state.reviewAttempts]
          .filter((attempt) => attempt.workOrderId === where.workOrderId)
          .sort((left, right) => Number(right.attemptNo) - Number(left.attemptNo))[0] ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: { workOrderId?: string } }) =>
        state.reviewAttempts.filter((attempt) => attempt.workOrderId === where.workOrderId)
      ),
      update: vi.fn(async ({ data, where }: {
        data: Record<string, unknown>;
        where: { id?: string };
      }) => {
        const attempt = state.reviewAttempts.find((item) => item.id === where.id);
        if (!attempt) {
          throw new Error("review attempt not found");
        }
        Object.assign(attempt, data, { updatedAt: now });
        return attempt;
      })
    },
    vehicleHandoverWorkflowJob: {
      upsert: vi.fn(async ({ create, where }: {
        create: Record<string, unknown>;
        where: { idempotencyKey: string };
      }) => {
        const existing = state.workflowJobs.find(
          (job) => job.idempotencyKey === where.idempotencyKey
        );
        if (existing) {
          return existing;
        }
        const job = {
          ...create,
          id: `workflow-job-${state.workflowJobs.length + 1}`,
          jobStatus: VehicleHandoverWorkflowJobStatus.PENDING
        };
        state.workflowJobs.push(job);
        return job;
      })
    },
    vehicleHandoverWorkOrder: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        withRelations(
          state.workOrders.find((workOrder) => matchesWorkOrderWhere(workOrder, where)) ?? null,
          state
        )
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.workOrders
          .filter((workOrder) => matchesWorkOrderWhere(workOrder, where))
          .map((workOrder) => withRelations(workOrder, state))
      ),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        state.workOrders.find((workOrder) => workOrder.id === where.id) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id?: string } }) => {
        const workOrder = state.workOrders.find((item) => item.id === where.id);
        if (!workOrder) {
          throw new Error("work order not found");
        }
        Object.assign(workOrder, data, { updatedAt: now });
        return workOrder;
      }),
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        const workOrder = state.workOrders.find((item) =>
          item.id === where.id && item.reviewVersion === where.reviewVersion
        );
        if (!workOrder) {
          return { count: 0 };
        }
        const reviewVersion = data.reviewVersion;
        Object.assign(workOrder, data, {
          reviewVersion: reviewVersion && typeof reviewVersion === "object" && "increment" in reviewVersion
            ? Number(workOrder.reviewVersion ?? 0) + Number(reviewVersion.increment)
            : workOrder.reviewVersion,
          updatedAt: now
        });
        return { count: 1 };
      })
    },
    $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(prisma))
  };

  const evidenceService = {
    assertFieldEvidenceComplete: vi.fn(async () => {
      if (!state.evidenceComplete) {
        throw new BadRequestException("证据尚未完整");
      }
    }),
    getChecklist: vi.fn(async () => state.evidenceChecklist)
  } as unknown as DeliveryEvidenceService;
  const storageService = {
    getObject: vi.fn(async () => ({
      contentLength: 1024,
      contentType: "image/jpeg",
      stream: Buffer.from("synthetic-image")
    }))
  };
  const workflowRepository = new Stage2HandoverWorkflowRepository(
    prisma as never
  );
  const handoverWorkOrderService = new HandoverWorkOrderService(
    prisma as never,
    evidenceService,
    undefined,
    storageService as never,
    undefined,
    new ConfigService({
      STAGE2_HANDOVER_WORKFLOW_ENABLED:
        options.workflowEnabled ? "true" : "false"
    }),
    undefined,
    workflowRepository
  );
  const stage2HandoverESignService = {
    getPortalStatus: vi.fn(),
    startPortalSigning: vi.fn()
  };
  const stage2HandoverWorkflowService = {
    getProjection: vi.fn(async () => options.workflowProjection ?? (
      options.workflowEnabled && state.workflowJobs[0]
        ? {
            artifactVersion: null,
            errorCode: null,
            jobId: String(state.workflowJobs[0].id),
            state: "PDF_PENDING" as const
          }
        : null
    )),
    isEnabled: vi.fn(() => options.workflowEnabled === true)
  };
  const service = new PortalHandoverReviewService(
    prisma as never,
    evidenceService,
    handoverWorkOrderService,
    stage2HandoverESignService as never,
    stage2HandoverWorkflowService as never
  );

  return {
    handoverWorkOrderService,
    now,
    orderId,
    prisma,
    service,
    stage2HandoverESignService,
    stage2HandoverWorkflowService,
    state,
    storageService
  };
}

function completeReviewWorkOrder(
  harness: ReturnType<typeof createPortalReviewHarness>,
  overrides: Record<string, unknown> = {}
) {
  return {
    adminReviewStatus: "NONE",
    accessoryChecklist: { chargingCable: true, keys: 2 },
    createdAt: harness.now,
    customerConfirmedAt: null,
    customerObjectedAt: null,
    customerObjectionReason: null,
    customerReviewStartedAt: harness.now,
    damageDeclared: false,
    deliveryLocation: "上海市测试交付点",
    energyLevelText: "80%",
    fieldNotes: "现场资料已由外部交付员提交",
    fieldStartedAt: harness.now,
    fieldSubmittedAt: harness.now,
    fuelLevelText: null,
    handover: {
      archiveStatus: "NOT_STARTED",
      archivedAt: null,
      completedAt: null,
      id: "handover-1",
      status: "DRAFT"
    },
    handoverId: "handover-1",
    handoverMileageKm: 28600,
    handoverType: "DELIVERY_OUTBOUND",
    id: "work-order-1",
    metadata: null,
    noVisibleDamageDeclared: true,
    operatorType: "EXTERNAL",
    orderId: harness.orderId,
    reviewVersion: 0,
    scheduledAt: new Date("2026-07-23T02:00:00.000Z"),
    status: "CUSTOMER_REVIEWING",
    updatedAt: harness.now,
    vehicleDeliveryId: "delivery-1",
    ...overrides
  };
}

function completeEvidenceChecklist(now: Date) {
  return {
    blockingReasons: [],
    items: Array.from({ length: 14 }, (_, index) => ({
      allowedMediaTypes: ["PHOTO"],
      evidenceType: `SYNTHETIC_EVIDENCE_${index + 1}`,
      files: [
        {
          file: {
            id: `file-${index + 1}`,
            mimeType: "image/jpeg",
            objectKey: `oss/private/delivery-evidence/${index + 1}.jpg`,
            originalName: `evidence-${index + 1}.jpg`,
            sizeBytes: 1024n
          },
          fileId: `file-${index + 1}`,
          id: `evidence-file-${index + 1}`,
          metadata: {
            artifactVersion: 1,
            detectedMimeType: "image/jpeg",
            photoPreviewFileId: `preview-file-${index + 1}`,
            processedAt: now.toISOString(),
            processingStatus: "READY",
            sourceSha256: `sha256:${String(index + 1).padStart(64, "0")}`,
            sourceSizeBytes: 1024,
            videoDurationMs: null,
            videoFrameFileIds: []
          },
          mediaType: "PHOTO",
          objectKey: `oss/private/evidence-link/${index + 1}.jpg`,
          uploadedAt: now,
          uploadedBy: { id: "user-field-1", name: "现场交付员" }
        }
      ],
      id: `evidence-item-${index + 1}`,
      isRequired: true,
      requirementLevel: "REQUIRED",
      reviewStatus: "APPROVED",
      status: "APPROVED",
      title: index === 0 ? "车辆车头正面" : `证据项 ${index + 1}`
    })),
    ready: true
  };
}

function withRelations(workOrder: Record<string, unknown> | null, state: ReturnType<typeof createPortalReviewHarness>["state"]) {
  if (!workOrder) {
    return null;
  }
  const order = state.orders.find((item) => item.id === workOrder.orderId);
  return {
    ...workOrder,
    handover: workOrder.handover ?? {
      archiveStatus: "NOT_STARTED",
      archivedAt: null,
      completedAt: null,
      id: workOrder.handoverId,
      status: "DRAFT"
    },
    order,
    reviewAttempts: state.reviewAttempts.filter((attempt) => attempt.workOrderId === workOrder.id)
  };
}

function matchesWorkOrderWhere(workOrder: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "id") {
      return workOrder.id === expected;
    }
    if (key === "orderId") {
      return workOrder.orderId === expected;
    }
    if (key === "status" && expected && typeof expected === "object" && "in" in expected) {
      return (expected.in as unknown[]).includes(workOrder.status);
    }
    if (key === "status" && expected && typeof expected === "object" && "notIn" in expected) {
      return !(expected.notIn as unknown[]).includes(workOrder.status);
    }
    if (key === "order" && expected && typeof expected === "object") {
      const order = findOrderForWorkOrder(workOrder);
      if (!order) {
        return false;
      }
      const orderWhere = expected as Record<string, unknown>;
      if (orderWhere.customerId && order.customerId !== orderWhere.customerId) {
        return false;
      }
      if (orderWhere.deletedAt === null && order.deletedAt !== null) {
        return false;
      }
      return true;
    }
    return true;
  });
}

function matchesEvidenceFileWhere(file: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "id") {
      return file.id === expected;
    }
    if (key === "evidenceItem" && expected && typeof expected === "object") {
      const item = file.evidenceItem as Record<string, unknown> | undefined;
      if (!item) {
        return false;
      }
      return matchesEvidenceItemWhere(item, expected as Record<string, unknown>);
    }
    return true;
  });
}

function matchesEvidenceItemWhere(item: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR" && Array.isArray(expected)) {
      return expected.some((branch) => matchesEvidenceItemWhere(item, branch as Record<string, unknown>));
    }
    return item[key] === expected;
  });
}

function findOrderForWorkOrder(workOrder: Record<string, unknown>) {
  if (workOrder.orderId === "order-other") {
    return { customerId: "customer-other", deletedAt: null };
  }
  return { customerId: "customer-1", deletedAt: null };
}

function currentCustomer(customerId: string): CurrentCustomer {
  return {
    accountStatus: "ACTIVE" as never,
    customerAccountId: `account-${customerId}`,
    customerId,
    phone: "FULL_PHONE_SHOULD_NOT_LEAK"
  };
}

function contextFor(request: { cookies: Record<string, string>; headers: Record<string, string> }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request
    })
  } as ExecutionContext;
}

function stringifyForSafety(value: unknown) {
  return JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
}

function expectNoStage2SideEffects(harness: ReturnType<typeof createPortalReviewHarness>) {
  expect(harness.prisma.contract.create).not.toHaveBeenCalled();
  expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
  expect(harness.prisma.vehicleDelivery.update).not.toHaveBeenCalled();
  expect(harness.prisma.lease.create).not.toHaveBeenCalled();
  expect(harness.prisma.receivableBill.create).not.toHaveBeenCalled();
  expect(harness.prisma.paymentRecord.create).not.toHaveBeenCalled();
}
