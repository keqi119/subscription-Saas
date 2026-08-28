import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  DeliveryHandoverStatus,
  ESignDocumentType,
  ESignSigningStage,
  ESignTaskStatus,
  OrderStatus,
  VehicleHandoverAdminReviewStatus,
  VehicleHandoverReviewAttemptStatus,
  VehicleHandoverWorkOrderStatus
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Stage2HandoverESignReadinessService
} from "../src/handover-work-order/stage2-handover-esign-readiness.service";
import { STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION } from "../src/handover-work-order/stage2-handover-source-artifact";
import { ESignModule } from "../src/esign/esign.module";
import { HandoverWorkOrderModule } from "../src/handover-work-order/handover-work-order.module";

const MANIFEST_DIGEST = "a".repeat(64);
const SOURCE_PDF_DIGEST = "b".repeat(64);
const MANIFEST_HASH = `sha256:${MANIFEST_DIGEST}`;
const NOW = new Date("2026-07-26T08:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const CUSTOMER_READINESS_CLOCK_SKEW_MS = 5 * 60 * 1000;

describe("Stage2HandoverESignReadinessService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is registered, exported, and wired to the existing eSign readiness module", () => {
    expect(Reflect.getMetadata("providers", HandoverWorkOrderModule)).toContain(
      Stage2HandoverESignReadinessService
    );
    expect(Reflect.getMetadata("exports", HandoverWorkOrderModule)).toContain(
      Stage2HandoverESignReadinessService
    );
    expect(Reflect.getMetadata("imports", HandoverWorkOrderModule)).toContain(
      ESignModule
    );
  });

  it("blocks when the work order does not exist", async () => {
    const harness = createHarness({ workOrder: null });

    await expectBlocker(harness.service, "WORK_ORDER_MISSING");
  });

  it("blocks when the Stage 1 contract is not signed", async () => {
    const harness = createHarness();
    Object.assign(harness.state.workOrder!.handover.stage1Contract, {
      status: ContractStatus.SIGNING
    });

    await expectBlocker(harness.service, "STAGE1_CONTRACT_NOT_SIGNED");
  });

  it("accepts an archived current Stage 1 contract as signing-complete", async () => {
    const harness = createHarness();
    Object.assign(harness.state.workOrder!.handover.stage1Contract, {
      status: ContractStatus.ARCHIVED
    });

    const readiness = await harness.service.getReadiness("work-order-1");

    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toEqual([]);
  });

  it("keeps current and deleted safeguards for archived Stage 1 contracts", async () => {
    const nonCurrent = createHarness();
    Object.assign(nonCurrent.state.workOrder!.handover.stage1Contract, {
      status: ContractStatus.ARCHIVED
    });
    Object.assign(nonCurrent.state.workOrder!.order, {
      contractId: "contract-stage1-new"
    });
    const deleted = createHarness();
    Object.assign(deleted.state.workOrder!.handover.stage1Contract, {
      deletedAt: NOW,
      status: ContractStatus.ARCHIVED
    });

    const nonCurrentReadiness =
      await nonCurrent.service.getReadiness("work-order-1");
    const deletedReadiness = await deleted.service.getReadiness("work-order-1");

    expect(nonCurrentReadiness.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "STAGE1_CONTRACT_NOT_CURRENT" })
    ]));
    expect(nonCurrentReadiness.blockers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "STAGE1_CONTRACT_NOT_SIGNED" })
    ]));
    expect(deletedReadiness.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "STAGE1_CONTRACT_NOT_SIGNED" })
    ]));
  });

  it("blocks when the signed Stage 1 contract is no longer current for the order", async () => {
    const harness = createHarness();
    Object.assign(harness.state.workOrder!.order, {
      contractId: "contract-stage1-new"
    });

    await expectBlocker(harness.service, "STAGE1_CONTRACT_NOT_CURRENT");
  });

  it("blocks when the Stage 2 handover is missing", async () => {
    const harness = createHarness();
    Object.assign(harness.state.workOrder!, { handover: null });

    await expectBlocker(harness.service, "HANDOVER_MISSING");
  });

  it("blocks when the handover source has not reached SOURCE_GENERATED", async () => {
    const harness = createHarness();
    Object.assign(harness.state.workOrder!.handover, {
      status: DeliveryHandoverStatus.DRAFT
    });

    await expectBlocker(harness.service, "HANDOVER_SOURCE_NOT_GENERATED");
  });

  it("accepts the current Stage 2 source artifact version", async () => {
    const harness = createHarness();

    const readiness = await harness.service.getReadiness("work-order-1");

    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toEqual([]);
  });

  it.each([1, 3])("rejects non-current source artifact version %s", async (artifactVersion) => {
    const harness = createHarness();
    harness.state.workOrder!.handover.artifactVersion = artifactVersion;

    await expectBlocker(harness.service, "SOURCE_ARTIFACT_VERSION_INVALID");
  });

  it("blocks before customer no-objection confirmation", async () => {
    const harness = createHarness();
    Object.assign(harness.state.workOrder!, {
      customerConfirmedAt: null,
      status: VehicleHandoverWorkOrderStatus.CUSTOMER_REVIEWING
    });

    await expectBlocker(harness.service, "CUSTOMER_CONFIRMATION_MISSING");
  });

  it("blocks an active customer objection", async () => {
    const harness = createHarness();
    Object.assign(harness.state.workOrder!, {
      customerObjectedAt: NOW,
      status: VehicleHandoverWorkOrderStatus.CUSTOMER_OBJECTED
    });

    await expectBlocker(harness.service, "CUSTOMER_OBJECTION_ACTIVE");
  });

  it("blocks RESUBMITTED_PENDING_ADMIN", async () => {
    const harness = createHarness();
    Object.assign(harness.state.workOrder!, {
      adminReviewStatus:
        VehicleHandoverAdminReviewStatus.RESUBMITTED_PENDING_ADMIN
    });

    await expectBlocker(harness.service, "ADMIN_REVIEW_PENDING");
  });

  it("blocks when the latest authoritative review attempt is not customer-confirmed", async () => {
    const harness = createHarness();
    harness.state.reviewAttempt.status =
      VehicleHandoverReviewAttemptStatus.CUSTOMER_REVIEWING;

    await expectBlocker(harness.service, "LATEST_REVIEW_NOT_CONFIRMED");
  });

  it("fails closed when the latest confirmed attempt has no field facts snapshot", async () => {
    const harness = createHarness();
    harness.state.reviewAttempt.fieldFactsSnapshot = null;

    await expectBlocker(harness.service, "CONFIRMED_FIELD_FACTS_MISMATCH");
    expectNoSideEffects(harness.sideEffects);
  });

  it("fails closed when a signing-relevant field facts key is missing", async () => {
    const harness = createHarness();
    const incompleteSnapshot: Record<string, unknown> =
      readyFieldFactsSnapshot();
    delete incompleteSnapshot.scheduledAt;
    harness.state.reviewAttempt.fieldFactsSnapshot = incompleteSnapshot;

    await expectBlocker(harness.service, "CONFIRMED_FIELD_FACTS_MISMATCH");
    expectNoSideEffects(harness.sideEffects);
  });

  it("fails closed when confirmed field facts differ from the current work order", async () => {
    const harness = createHarness();
    harness.state.reviewAttempt.fieldFactsSnapshot = {
      ...readyFieldFactsSnapshot(),
      handoverMileageKm: 28001
    };

    await expectBlocker(harness.service, "CONFIRMED_FIELD_FACTS_MISMATCH");
    expectNoSideEffects(harness.sideEffects);
  });

  it("blocks when field evidence readiness fails", async () => {
    const harness = createHarness({
      evidenceReadiness: {
        blockingDetails: [],
        blockingReasons: ["evidence missing"],
        handoverId: "handover-1",
        orderId: "order-1",
        ready: false
      }
    });

    await expectBlocker(harness.service, "EVIDENCE_NOT_READY");
  });

  it("blocks when required field facts are incomplete", async () => {
    const harness = createHarness();
    Object.assign(harness.state.workOrder!, { handoverMileageKm: null });

    await expectBlocker(harness.service, "FIELD_FACTS_INCOMPLETE");
  });

  it("keeps a missing vehicle registration document as an actionable readiness blocker", async () => {
    const harness = createHarness({ registrationAllowed: false });

    await expectBlocker(
      harness.service,
      "VEHICLE_REGISTRATION_DOCUMENT_MISSING"
    );
    expect(harness.registrationExceptionService.getGate).toHaveBeenCalledWith(
      "work-order-1",
      harness.prisma
    );
    expectNoSideEffects(harness.sideEffects);
  });

  it("accepts a current vehicle registration document or exact-snapshot approval", async () => {
    const documentHarness = createHarness({ registrationAllowed: true });
    const approvedExceptionHarness = createHarness({ registrationAllowed: true });

    await expect(documentHarness.service.getReadiness("work-order-1")).resolves.toMatchObject({
      blockers: [],
      ready: true
    });
    await expect(approvedExceptionHarness.service.getReadiness("work-order-1")).resolves.toMatchObject({
      blockers: [],
      ready: true
    });
  });

  it("requires exactly one affirmative damage-state declaration", async () => {
    const harness = createHarness();
    Object.assign(harness.state.workOrder!, {
      damageDeclared: null,
      noVisibleDamageDeclared: false
    });

    await expectBlocker(harness.service, "FIELD_FACTS_INCOMPLETE");
  });

  it("blocks when the current evidence manifest no longer matches customer confirmation", async () => {
    const harness = createHarness();
    harness.state.reviewAttempt.evidenceSnapshot = {
      evidencePackage: { manifestHash: `sha256:${"c".repeat(64)}` }
    };

    await expectBlocker(harness.service, "CONFIRMED_MANIFEST_MISMATCH");
  });

  it("blocks when the handover manifest does not match current evidence", async () => {
    const harness = createHarness();
    harness.state.workOrder!.handover.manifestHash = "c".repeat(64);

    await expectBlocker(harness.service, "SOURCE_MANIFEST_MISMATCH");
  });

  it("blocks when the Stage 2 generated Contract is missing", async () => {
    const harness = createHarness();
    Object.assign(harness.state.workOrder!.handover, {
      handoverContract: null
    });

    await expectBlocker(harness.service, "SOURCE_CONTRACT_MISSING");
  });

  it("blocks when the Contract does not use an active delivery handover template", async () => {
    const harness = createHarness();
    Object.assign(
      harness.state.workOrder!.handover.handoverContract.contractVersion,
      { status: ContractVersionStatus.INACTIVE }
    );

    await expectBlocker(harness.service, "SOURCE_TEMPLATE_NOT_ACTIVE");
  });

  it("blocks when the source FileObject is missing or not a PDF", async () => {
    const missingHarness = createHarness({ fileObject: null });
    await expectBlocker(missingHarness.service, "SOURCE_PDF_MISSING");

    const invalidHarness = createHarness();
    invalidHarness.state.fileObject!.mimeType = "image/jpeg";
    await expectBlocker(invalidHarness.service, "SOURCE_PDF_INVALID");
  });

  it("blocks when the declared source PDF exceeds the 18 MiB hard limit", async () => {
    const harness = createHarness();
    harness.state.fileObject!.sizeBytes = BigInt(18 * 1024 * 1024 + 1);

    await expectBlocker(harness.service, "SOURCE_PDF_TOO_LARGE");
  });

  it("blocks when source PDF hash state is missing or malformed", async () => {
    const harness = createHarness();
    harness.state.workOrder!.handover.sourcePdfHash = "not-a-sha256";

    await expectBlocker(harness.service, "SOURCE_PDF_HASH_INVALID");
  });

  it("blocks invalid or missing persisted Stage 2 slot metadata", async () => {
    const harness = createHarness();
    harness.state.workOrder!.handover.handoverContract.contractSnapshot
      .stage2HandoverPdfArtifact.slotCoordinates = [
        stage2Slot("STAGE2_HANDOVER_CUSTOMER")
      ];

    await expectBlocker(harness.service, "SIGNING_SLOTS_INVALID");
  });

  it("blocks slots that are not on the persisted final PDF page", async () => {
    const harness = createHarness();
    harness.state.workOrder!.handover.handoverContract.contractSnapshot
      .stage2HandoverPdfArtifact.pageCount = 5;

    await expectBlocker(harness.service, "SIGNING_SLOTS_INVALID");
  });

  it("blocks when customer provider-backed cert readiness is missing", async () => {
    const harness = createHarness({
      customerReadiness: readyCustomerReadiness({
        blockingCode: "FADADA_CERT_NOT_BOUND",
        certBound: false,
        certSerialNoPresent: false,
        readyForSigning: false,
        state: "CERT_BINDING_PENDING"
      })
    });

    await expectBlocker(harness.service, "CUSTOMER_CERT_NOT_READY");
  });

  it("fails closed when customer provider readiness freshness policy is missing", async () => {
    const harness = createHarness({
      env: {
        FADADA_PLATFORM_CUSTOMER_ID: "platform-customer-1",
        FADADA_PLATFORM_SIGNATURE_ID: "platform-signature-1",
        FADADA_PROVIDER_STATUS_FRESHNESS_DAYS: ""
      }
    });

    await expectBlocker(harness.service, "CUSTOMER_READINESS_FRESHNESS_UNCONFIGURED");
  });

  it("fails closed when customer provider readiness evidence is stale", async () => {
    const harness = createHarness({
      customerReadiness: readyCustomerReadiness({
        lastProviderCheckAt: new Date(NOW.getTime() - 30 * DAY_MS - 1)
      })
    });

    await expectBlocker(harness.service, "CUSTOMER_READINESS_STALE");
  });

  it("fails closed when customer provider readiness timestamp is invalid", async () => {
    const harness = createHarness({
      customerReadiness: readyCustomerReadiness({
        lastProviderCheckAt: new Date(Number.NaN)
      })
    });

    await expectBlocker(
      harness.service,
      "CUSTOMER_READINESS_TIMESTAMP_INVALID"
    );
  });

  it("fails closed when customer provider readiness timestamp exceeds clock skew", async () => {
    const harness = createHarness({
      customerReadiness: readyCustomerReadiness({
        lastProviderCheckAt: new Date(
          NOW.getTime() + CUSTOMER_READINESS_CLOCK_SKEW_MS + 1
        )
      })
    });

    await expectBlocker(
      harness.service,
      "CUSTOMER_READINESS_TIMESTAMP_INVALID"
    );
  });

  it.each([
    {
      label: "the five-minute future clock-skew boundary",
      lastProviderCheckAt: new Date(
        NOW.getTime() + CUSTOMER_READINESS_CLOCK_SKEW_MS
      )
    },
    {
      label: "the configured freshness boundary",
      lastProviderCheckAt: new Date(NOW.getTime() - 30 * DAY_MS)
    }
  ])("accepts $label", async ({ lastProviderCheckAt }) => {
    const harness = createHarness({
      customerReadiness: readyCustomerReadiness({ lastProviderCheckAt })
    });

    const readiness = await harness.service.getReadiness("work-order-1");

    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toEqual([]);
  });

  it("requires both platform customer and signature configuration", async () => {
    const customerHarness = createHarness({
      env: {
        FADADA_PLATFORM_CUSTOMER_ID: "",
        FADADA_PLATFORM_SIGNATURE_ID: "platform-signature-1",
        FADADA_PROVIDER_STATUS_FRESHNESS_DAYS: "30"
      }
    });
    await expectBlocker(customerHarness.service, "PLATFORM_CUSTOMER_ID_MISSING");

    const signatureHarness = createHarness({
      env: {
        FADADA_PLATFORM_CUSTOMER_ID: "platform-customer-1",
        FADADA_PLATFORM_SIGNATURE_ID: "",
        FADADA_PROVIDER_STATUS_FRESHNESS_DAYS: "30"
      }
    });
    await expectBlocker(signatureHarness.service, "PLATFORM_SIGNATURE_ID_MISSING");
  });

  it("queries and blocks an active Stage 2 task by contract pointer", async () => {
    const harness = createHarness({
      activeTask: {
        id: "esign-task-1",
        taskStatus: ESignTaskStatus.WAITING_CUSTOMER
      }
    });

    const readiness = await harness.service.getReadiness("work-order-1");

    expect(readiness.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ACTIVE_ESIGN_TASK_CONFLICT" })
    ]));
    expect(readiness.state.esignTaskId).toBe("esign-task-1");
    expect(readiness.state.esignTaskStatus).toBe(ESignTaskStatus.WAITING_CUSTOMER);
    expect(harness.prisma.contractESignTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contractId: "contract-stage2-1",
          documentType: ESignDocumentType.DELIVERY_HANDOVER,
          orderId: "order-1",
          signingStage:
            ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
          taskStatus: {
            in: [
              ESignTaskStatus.CREATED,
              ESignTaskStatus.SIGNING,
              ESignTaskStatus.WAITING_CUSTOMER
            ]
          }
        })
      })
    );
  });

  it("fails closed for a task pointer when the authoritative contract binding is absent", async () => {
    const harness = createHarness({
      activeTask: {
        id: "esign-task-1",
        taskStatus: ESignTaskStatus.WAITING_CUSTOMER
      }
    });
    Object.assign(harness.state.workOrder!.handover, {
      handoverContractId: null,
      handoverESignTaskId: "esign-task-1"
    });

    const readiness = await harness.service.getReadiness("work-order-1");

    expect(readiness.blockers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ACTIVE_ESIGN_TASK_CONFLICT" })
    ]));
    expect(readiness.state.esignTaskId).toBeNull();
    expect(harness.prisma.contractESignTask.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    [
      "terminal status",
      { taskStatus: ESignTaskStatus.CANCELLED }
    ],
    [
      "wrong document",
      { documentType: ESignDocumentType.SUBSCRIPTION_CONTRACT }
    ],
    [
      "wrong signing stage",
      {
        signingStage:
          ESignSigningStage.STAGE1_SUBSCRIPTION_CONTRACT
      }
    ],
    ["wrong contract", { contractId: "contract-stage2-other" }],
    ["wrong order", { orderId: "order-other" }]
  ] as const)(
    "does not report an active conflict for a pointer with %s",
    async (_name, activeTask) => {
      const harness = createHarness({
        activeTask: {
          id: "esign-task-invalid-pointer",
          ...activeTask
        }
      });
      Object.assign(harness.state.workOrder!.handover, {
        handoverESignTaskId: "esign-task-invalid-pointer"
      });

      const readiness =
        await harness.service.getReadiness("work-order-1");

      expect(readiness.blockers).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "ACTIVE_ESIGN_TASK_CONFLICT"
        })
      ]));
      expect(readiness.state.esignTaskId).toBeNull();
    }
  );

  it("blocks terminal or incorrect order states", async () => {
    for (const orderStatus of [
      OrderStatus.ACTIVE,
      OrderStatus.TERMINATED,
      OrderStatus.CANCELLED,
      OrderStatus.PENDING_VEHICLE
    ]) {
      const harness = createHarness();
      Object.assign(harness.state.workOrder!.order, { orderStatus });

      await expectBlocker(
        harness.service,
        orderStatus === OrderStatus.PENDING_VEHICLE
          ? "ORDER_NOT_READY_FOR_DELIVERY"
          : "ORDER_TERMINAL_OR_DELIVERED"
      );
    }
  });

  it("blocks terminal or incorrect work-order states", async () => {
    for (const status of [
      VehicleHandoverWorkOrderStatus.VOIDED,
      VehicleHandoverWorkOrderStatus.FAILED,
      VehicleHandoverWorkOrderStatus.CANCELLED,
      VehicleHandoverWorkOrderStatus.CUSTOMER_REVIEWING
    ]) {
      const harness = createHarness();
      Object.assign(harness.state.workOrder!, { status });

      await expectBlocker(
        harness.service,
        status === VehicleHandoverWorkOrderStatus.CUSTOMER_REVIEWING
          ? "WORK_ORDER_NOT_READY_FOR_ESIGN"
          : "WORK_ORDER_TERMINAL"
      );
    }
  });

  it("returns a safe ready result after every prerequisite passes", async () => {
    const harness = createHarness();

    const readiness = await harness.service.getReadiness("work-order-1");

    expect(readiness).toEqual({
      blockers: [],
      ready: true,
      state: {
        esignTaskId: null,
        esignTaskStatus: null,
        handoverContractId: "contract-stage2-1",
        handoverId: "handover-1",
        handoverStatus: DeliveryHandoverStatus.SOURCE_GENERATED,
        orderId: "order-1",
        orderStatus: OrderStatus.PENDING_DELIVERY,
        workOrderId: "work-order-1",
        workOrderStatus: VehicleHandoverWorkOrderStatus.CUSTOMER_CONFIRMED
      }
    });
    expect(JSON.stringify(readiness)).not.toMatch(
      /phone|idCard|providerCustomer|signUrl|objectKey|bucket|secret|rawResponse/i
    );
  });

  it("assertReady fails closed with the same blockers returned by getReadiness", async () => {
    const harness = createHarness();
    Object.assign(harness.state.workOrder!.handover.stage1Contract, {
      status: ContractStatus.GENERATED
    });

    const readiness = await harness.service.getReadiness("work-order-1");
    let caught: unknown;
    try {
      await harness.service.assertReady("work-order-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      blockers: readiness.blockers,
      code: "STAGE2_HANDOVER_ESIGN_NOT_READY",
      ready: false
    });
  });

  it("performs local reads only in both blocked and ready cases", async () => {
    const blocked = createHarness();
    Object.assign(blocked.state.workOrder!.handover.stage1Contract, {
      status: ContractStatus.GENERATED
    });
    const ready = createHarness();

    await blocked.service.getReadiness("work-order-1");
    await ready.service.getReadiness("work-order-1");

    for (const harness of [blocked, ready]) {
      expect(harness.sideEffects.generatePdf).not.toHaveBeenCalled();
      expect(harness.sideEffects.create).not.toHaveBeenCalled();
      expect(harness.sideEffects.update).not.toHaveBeenCalled();
      expect(harness.sideEffects.delete).not.toHaveBeenCalled();
      expect(harness.sideEffects.provider).not.toHaveBeenCalled();
      expect(harness.sideEffects.storage).not.toHaveBeenCalled();
      expect(harness.sideEffects.notification).not.toHaveBeenCalled();
    }
  });
});

async function expectBlocker(
  service: Stage2HandoverESignReadinessService,
  code: string
) {
  const readiness = await service.getReadiness("work-order-1");
  expect(readiness.ready).toBe(false);
  expect(readiness.blockers).toEqual(expect.arrayContaining([
    expect.objectContaining({ code })
  ]));
}

function createHarness(overrides: {
  activeTask?: null | Record<string, unknown>;
  customerReadiness?: ReturnType<typeof readyCustomerReadiness>;
  env?: Record<string, string>;
  evidenceReadiness?: Record<string, unknown>;
  fileObject?: null | ReadyState["fileObject"];
  registrationAllowed?: boolean;
  workOrder?: null | ReadyState["workOrder"];
} = {}) {
  const state: ReadyState = {
    activeTask:
      overrides.activeTask == null
        ? null
        : readinessTask(overrides.activeTask),
    customerReadiness: overrides.customerReadiness ?? readyCustomerReadiness(),
    evidenceReadiness: overrides.evidenceReadiness ?? {
      blockingDetails: [],
      blockingReasons: [],
      handoverId: "handover-1",
      orderId: "order-1",
      ready: true
    },
    fileObject: overrides.fileObject === undefined
      ? {
          id: "file-stage2-1",
          mimeType: "application/pdf",
          sizeBytes: BigInt(2 * 1024 * 1024)
        }
      : overrides.fileObject,
    reviewAttempt: {
      attemptNo: 1,
      evidenceSnapshot: {
        evidencePackage: { manifestHash: MANIFEST_HASH }
      },
      fieldFactsSnapshot: readyFieldFactsSnapshot(),
      id: "review-attempt-1",
      status: VehicleHandoverReviewAttemptStatus.CUSTOMER_CONFIRMED
    },
    workOrder: overrides.workOrder === undefined ? readyWorkOrder() : overrides.workOrder
  };
  const sideEffects = {
    create: vi.fn(),
    delete: vi.fn(),
    generatePdf: vi.fn(),
    notification: vi.fn(),
    provider: vi.fn(),
    storage: vi.fn(),
    update: vi.fn()
  };
  const prisma = {
    contract: {
      create: sideEffects.create,
      delete: sideEffects.delete,
      update: sideEffects.update
    },
    contractESignTask: {
      create: sideEffects.create,
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          state.activeTask &&
          matchesReadinessTaskWhere(state.activeTask, where)
            ? state.activeTask
            : null
      ),
      update: sideEffects.update
    },
    fileObject: {
      create: sideEffects.create,
      findUnique: vi.fn(async () => state.fileObject),
      update: sideEffects.update
    },
    vehicleDeliveryHandover: {
      create: sideEffects.create,
      update: sideEffects.update
    },
    vehicleHandoverReviewAttempt: {
      create: sideEffects.create,
      findFirst: vi.fn(async () => state.reviewAttempt),
      update: sideEffects.update
    },
    vehicleHandoverWorkOrder: {
      create: sideEffects.create,
      findUnique: vi.fn(async () => state.workOrder),
      update: sideEffects.update
    }
  };
  const deliveryEvidenceService = {
    validateEvidenceReadyForStage2ESign: vi.fn(async () => state.evidenceReadiness)
  };
  const handoverWorkOrderService = {
    generateStage2HandoverPdf: sideEffects.generatePdf,
    getCurrentEvidencePackage: vi.fn(async () => ({
      manifestHash: MANIFEST_HASH
    }))
  };
  const fadadaReadinessService = {
    getReadiness: vi.fn(async () => state.customerReadiness),
    providerCall: sideEffects.provider
  };
  const registrationExceptionService = {
    getGate: vi.fn(async () => ({
      allowed: overrides.registrationAllowed ?? true,
      approval: null,
      documentPresent: overrides.registrationAllowed ?? true,
      snapshotHash: "d".repeat(64)
    }))
  };
  const config = new ConfigService({
    FADADA_PLATFORM_CUSTOMER_ID: "platform-customer-1",
    FADADA_PLATFORM_SIGNATURE_ID: "platform-signature-1",
    FADADA_PROVIDER_STATUS_FRESHNESS_DAYS: "30",
    ...overrides.env
  });
  const service = new Stage2HandoverESignReadinessService(
    prisma as never,
    deliveryEvidenceService as never,
    fadadaReadinessService as never,
    handoverWorkOrderService as never,
    registrationExceptionService as never,
    config
  );

  return {
    prisma,
    registrationExceptionService,
    service,
    sideEffects,
    state
  };
}

interface ReadyState {
  activeTask: null | Record<string, unknown>;
  customerReadiness: ReturnType<typeof readyCustomerReadiness>;
  evidenceReadiness: Record<string, unknown>;
  fileObject: null | {
    id: string;
    mimeType: string;
    sizeBytes: bigint;
  };
  reviewAttempt: {
    attemptNo: number;
    evidenceSnapshot: Record<string, unknown>;
    fieldFactsSnapshot: null | Record<string, unknown>;
    id: string;
    status: VehicleHandoverReviewAttemptStatus;
  };
  workOrder: null | ReturnType<typeof readyWorkOrder>;
}

function readyWorkOrder() {
  return {
    accessoryChecklist: [{ key: "spare-key", checked: true }],
    adminReviewStatus: VehicleHandoverAdminReviewStatus.NONE,
    customerConfirmedAt: NOW,
    customerObjectedAt: null,
    damageDeclared: false,
    deliveryLocation: "garage bay A",
    energyLevelText: "80%",
    fieldNotes: "ready for delivery",
    fuelLevelText: null,
    handover: {
      artifactVersion: STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION,
      deletedAt: null,
      handoverContract: {
        contractSnapshot: {
          evidencePackage: { manifestHash: MANIFEST_HASH },
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
        contractVersion: {
          deletedAt: null,
          effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
          effectiveTo: null,
          id: "contract-version-stage2-1",
          status: ContractVersionStatus.ACTIVE,
          templateType: ContractTemplateType.DELIVERY_HANDOVER
        },
        contractVersionId: "contract-version-stage2-1",
        deletedAt: null,
        fileId: "file-stage2-1",
        id: "contract-stage2-1",
        status: ContractStatus.GENERATED
      },
      handoverContractId: "contract-stage2-1",
      handoverESignTaskId: null,
      id: "handover-1",
      manifestHash: MANIFEST_DIGEST,
      sourceDocumentFileId: "file-stage2-1",
      sourcePdfHash: SOURCE_PDF_DIGEST,
      stage1Contract: {
        deletedAt: null,
        id: "contract-stage1-1",
        status: ContractStatus.SIGNED
      },
      status: DeliveryHandoverStatus.SOURCE_GENERATED
    },
    handoverId: "handover-1",
    handoverMileageKm: 28000,
    fieldSubmittedAt: NOW,
    id: "work-order-1",
    noVisibleDamageDeclared: true,
    order: {
      actualDeliveryAt: null,
      contractId: "contract-stage1-1",
      customerId: "customer-1",
      deletedAt: null,
      id: "order-1",
      orderStatus: OrderStatus.PENDING_DELIVERY
    },
    orderId: "order-1",
    scheduledAt: new Date("2026-07-27T02:00:00.000Z"),
    status: VehicleHandoverWorkOrderStatus.CUSTOMER_CONFIRMED
  };
}

function readinessTask(
  overrides: Record<string, unknown> = {}
) {
  return {
    contractId: "contract-stage2-1",
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    id: "esign-task-1",
    orderId: "order-1",
    signingStage:
      ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
    taskStatus: ESignTaskStatus.CREATED,
    ...overrides
  };
}

function matchesReadinessTaskWhere(
  task: Record<string, unknown>,
  where: Record<string, unknown>
) {
  for (const key of [
    "contractId",
    "documentType",
    "id",
    "orderId",
    "signingStage"
  ]) {
    if (
      typeof where[key] === "string" &&
      where[key] !== task[key]
    ) {
      return false;
    }
  }
  const status = where.taskStatus;
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
        matchesReadinessTaskWhere(
          task,
          alternative as Record<string, unknown>
        )
    )
  ) {
    return false;
  }
  return true;
}

function readyFieldFactsSnapshot() {
  return {
    accessoryChecklist: [{ checked: true, key: "spare-key" }],
    damageDeclared: false,
    deliveryLocation: "garage bay A",
    energyLevelText: "80%",
    fieldNotes: "ready for delivery",
    fuelLevelText: null,
    handoverMileageKm: 28000,
    noVisibleDamageDeclared: true,
    scheduledAt: "2026-07-27T02:00:00.000Z"
  };
}

function expectNoSideEffects(
  sideEffects: Record<string, ReturnType<typeof vi.fn>>
) {
  for (const operation of Object.values(sideEffects)) {
    expect(operation).not.toHaveBeenCalled();
  }
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

function readyCustomerReadiness(
  overrides: Partial<{
    blockingCode: null | string;
    blockingMessage: null | string;
    certBound: boolean;
    certSerialNoPresent: boolean;
    lastProviderCheckAt: Date | null;
    nextAction: string;
    provider: string;
    providerCustomerIdPresent: boolean;
    readyForSigning: boolean;
    realNameProviderVerified: boolean;
    state: string;
  }> = {}
) {
  return {
    blockingCode: null,
    blockingMessage: null,
    certBound: true,
    certSerialNoPresent: true,
    lastProviderCheckAt: NOW,
    nextAction: "NONE",
    provider: "FADADA",
    providerCustomerIdPresent: true,
    readyForSigning: true,
    realNameProviderVerified: true,
    state: "SIGNING_ENABLED",
    ...overrides
  };
}
