import { BadRequestException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { DeliveryEvidenceMediaType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { DeliveryEvidenceService } from "../src/delivery-evidence/delivery-evidence.service";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
import { CurrentCustomer } from "../src/portal/portal-auth.types";
import { PortalHandoverReviewService } from "../src/portal/portal-handover-review.service";

describe("Stage 2 local handover E2E harness", () => {
  it("runs field evidence submit to Portal customer confirmation without PDF/eSign/provider side effects", async () => {
    const harness = createStage2HandoverE2EHarness();
    const before = harness.snapshotSideEffects();

    const initialFieldReadiness = await harness.workOrderService.getFieldAccessibleReadiness(
      harness.workOrderId,
      harness.operatorPhone
    );
    expect(initialFieldReadiness.ready).toBe(false);
    expect(initialFieldReadiness.blockingReasons).toEqual(expect.arrayContaining(["请填写交付里程。"]));

    await harness.submitFieldEvidenceThroughFieldSession();

    expect(harness.currentWorkOrder()).toMatchObject({
      fieldSubmittedAt: expect.any(Date),
      status: "CUSTOMER_REVIEWING"
    });
    const afterFieldSubmit = await harness.workOrderService.getReadiness(harness.workOrderId);
    expect(afterFieldSubmit).toMatchObject({
      readyForStage2ESign: false,
      readyForStage2Pdf: false
    });
    expect(afterFieldSubmit.blockingReasons).toEqual(expect.arrayContaining(["客户尚未确认交付无异议。"]));

    const list = await harness.portalReviewService.listReviews(harness.currentCustomer());
    expect(list.map((item) => item.id)).toEqual([harness.workOrderId]);

    const detail = await harness.portalReviewService.getReview(harness.workOrderId, harness.currentCustomer());
    expect(detail).toMatchObject({
      evidenceChecklist: {
        ready: true
      },
      fieldFacts: {
        handoverMileageKm: 28600,
        noVisibleDamageDeclared: true
      },
      readiness: {
        readyForStage2ESign: false,
        readyForStage2Pdf: false
      },
      status: "CUSTOMER_REVIEWING"
    });
    expect(detail.evidenceChecklist.items).toHaveLength(14);
    expect(detail.evidenceChecklist.items[0]).toMatchObject({
      fileCount: 1,
      files: [
        expect.objectContaining({
          file: expect.objectContaining({ id: "file-1" })
        })
      ]
    });
    expectPortalDtoIsSafe(detail);

    const confirmed = await harness.portalReviewService.confirmNoObjection(
      harness.workOrderId,
      { acknowledgement: true },
      harness.currentCustomer()
    );
    expect(confirmed).toMatchObject({
      customerConfirmedAt: expect.any(Date),
      readiness: {
        readyForDeliveryConfirmation: true,
        readyForStage2ESign: true,
        readyForStage2Pdf: true
      },
      status: "CUSTOMER_CONFIRMED"
    });
    await expect(harness.workOrderService.assertReadyForStage2Pdf(harness.orderId)).resolves.toBeUndefined();
    await expect(harness.workOrderService.assertReadyForStage2ESign(harness.orderId)).resolves.toBeUndefined();
    expectNoStage2SideEffects(harness, before);
  });

  it("keeps Stage 2 readiness blocked when the Portal customer submits an objection", async () => {
    const harness = createStage2HandoverE2EHarness();
    const before = harness.snapshotSideEffects();

    await harness.submitFieldEvidenceThroughFieldSession();
    const objected = await harness.portalReviewService.objectReview(
      harness.workOrderId,
      { details: "右前轮毂需要复核", reason: "车辆外观有异议" },
      harness.currentCustomer()
    );

    expect(objected).toMatchObject({
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
    expect(objected.readiness.blockingReasons).toEqual(expect.arrayContaining(["客户存在异议，需后台介入。"]));
    await expect(harness.workOrderService.assertReadyForStage2Pdf(harness.orderId)).rejects.toThrow("客户存在异议");
    expectNoStage2SideEffects(harness, before);
  });

  it("covers customer, field-session, and terminal-state authorization boundaries", async () => {
    const harness = createStage2HandoverE2EHarness();
    const before = harness.snapshotSideEffects();

    await expect(
      harness.portalReviewService.confirmNoObjection(
        harness.workOrderId,
        { acknowledgement: true },
        harness.currentCustomer()
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      harness.workOrderService.startFieldAccessibleWorkOrder(
        harness.workOrderId,
        harness.customerPortalPhone,
        "portal-customer-session"
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await harness.submitFieldEvidenceThroughFieldSession();

    await expect(
      harness.portalReviewService.getReview(harness.workOrderId, harness.otherCustomer())
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      harness.portalReviewService.confirmNoObjection(
        harness.workOrderId,
        { acknowledgement: true },
        harness.otherCustomer()
      )
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      harness.portalReviewService.objectReview(
        harness.workOrderId,
        { reason: "车辆外观有异议" },
        harness.otherCustomer()
      )
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      harness.workOrderService.updateFieldAccessibleFacts(
        harness.workOrderId,
        harness.operatorPhone,
        { handoverMileageKm: 1 },
        "field-session-after-submit"
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    await harness.portalReviewService.confirmNoObjection(
      harness.workOrderId,
      { acknowledgement: true },
      harness.currentCustomer()
    );
    await expect(
      harness.portalReviewService.objectReview(
        harness.workOrderId,
        { reason: "车辆外观有异议" },
        harness.currentCustomer()
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    const objectedHarness = createStage2HandoverE2EHarness();
    await objectedHarness.submitFieldEvidenceThroughFieldSession();
    await objectedHarness.portalReviewService.objectReview(
      objectedHarness.workOrderId,
      { reason: "车辆外观有异议" },
      objectedHarness.currentCustomer()
    );
    await expect(
      objectedHarness.portalReviewService.confirmNoObjection(
        objectedHarness.workOrderId,
        { acknowledgement: true },
        objectedHarness.currentCustomer()
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    const terminalHarness = createStage2HandoverE2EHarness();
    terminalHarness.setWorkOrderStatus("CANCELLED");
    await expect(
      terminalHarness.portalReviewService.getReview(
        terminalHarness.workOrderId,
        terminalHarness.currentCustomer()
      )
    ).rejects.toBeInstanceOf(NotFoundException);

    expectNoStage2SideEffects(harness, before);
  });
});

type TestRecord = Record<string, unknown>;
type TestMock = ReturnType<typeof vi.fn>;

interface Stage2HarnessState {
  contracts: TestRecord[];
  eSignTasks: TestRecord[];
  evidenceFiles: TestRecord[];
  evidenceItems: TestRecord[];
  fadadaProviderCalls: {
    createSignTask: TestMock;
    getSignerUrl: TestMock;
    uploadDocument: TestMock;
  };
  fileObjects: TestRecord[];
  generatedContractArtifacts: TestRecord[];
  generatedSigningUrls: string[];
  handover: TestRecord;
  leases: TestRecord[];
  orders: TestRecord[];
  paymentRecords: TestRecord[];
  receivableBills: TestRecord[];
  vehicleDelivery: TestRecord;
  workOrders: TestRecord[];
}

const FIELD_OPERATOR_PHONE = ["199", "0000", "0000"].join("");
const CUSTOMER_PORTAL_PHONE = ["188", "0000", "0000"].join("");
const OTHER_CUSTOMER_PHONE = ["177", "0000", "0000"].join("");
const SYNTHETIC_OBJECT_KEY_SHOULD_NOT_RENDER = "SYNTHETIC_OBJECT_KEY_SHOULD_NOT_RENDER";
const SYNTHETIC_SIGNING_URL_SHOULD_NOT_RENDER = "SYNTHETIC_SIGNING_URL_SHOULD_NOT_RENDER";
const SYNTHETIC_ID_SHOULD_NOT_RENDER = "SYNTHETIC_ID_SHOULD_NOT_RENDER";
const SYNTHETIC_PROVIDER_INTERNAL_SHOULD_NOT_RENDER = "SYNTHETIC_PROVIDER_INTERNAL_SHOULD_NOT_RENDER";
const SYNTHETIC_FINANCE_VALUE_SHOULD_NOT_RENDER = "SYNTHETIC_FINANCE_VALUE_SHOULD_NOT_RENDER";

function createStage2HandoverE2EHarness() {
  const now = new Date("2026-07-22T08:00:00.000Z");
  const orderId = "order-stage2-local";
  const workOrderId = "work-order-stage2-local";
  const handoverId = "handover-stage2-local";
  const state: Stage2HarnessState = {
    contracts: [
      {
        id: "contract-stage1-baseline",
        orderId,
        status: "SIGNED"
      }
    ],
    eSignTasks: [] as TestRecord[],
    evidenceFiles: [] as TestRecord[],
    evidenceItems: createEvidenceItems(now, orderId, handoverId),
    fadadaProviderCalls: {
      createSignTask: vi.fn(),
      getSignerUrl: vi.fn(),
      uploadDocument: vi.fn()
    },
    fileObjects: [] as TestRecord[],
    generatedContractArtifacts: [] as TestRecord[],
    generatedSigningUrls: [] as string[],
    handover: {
      archiveStatus: "NOT_STARTED",
      archivedAt: null,
      completedAt: null,
      deletedAt: null,
      id: handoverId,
      orderId,
      signedDocumentObjectKey: null,
      sourceDocumentObjectKey: null,
      status: "DRAFT",
      vehicleDeliveryId: "delivery-stage2-local"
    },
    leases: [] as TestRecord[],
    orders: [
      {
        actualDeliveryAt: null,
        contractId: "contract-stage1-baseline",
        customer: {
          customerNo: "CUS-STAGE2-LOCAL",
          id: "customer-stage2-owner",
          idCardNo: SYNTHETIC_ID_SHOULD_NOT_RENDER,
          mobile: CUSTOMER_PORTAL_PHONE,
          name: "本地测试客户"
        },
        customerId: "customer-stage2-owner",
        deletedAt: null,
        depositAmount: SYNTHETIC_FINANCE_VALUE_SHOULD_NOT_RENDER,
        id: orderId,
        metadata: {
          providerInternal: SYNTHETIC_PROVIDER_INTERNAL_SHOULD_NOT_RENDER,
          signingUrl: SYNTHETIC_SIGNING_URL_SHOULD_NOT_RENDER
        },
        monthlyFeeAmount: SYNTHETIC_FINANCE_VALUE_SHOULD_NOT_RENDER,
        orderNo: "ORD-STAGE2-LOCAL-001",
        vehicle: {
          brand: "NIO",
          id: "vehicle-stage2-local",
          model: "Stage2 Local Harness",
          plateNo: "测A00001",
          series: "Stage2",
          vin: "LOCALSTAGE2VIN765432"
        },
        vehicleId: "vehicle-stage2-local"
      },
      {
        actualDeliveryAt: null,
        customer: {
          customerNo: "CUS-STAGE2-OTHER",
          id: "customer-stage2-other",
          mobile: OTHER_CUSTOMER_PHONE,
          name: "其他本地测试客户"
        },
        customerId: "customer-stage2-other",
        deletedAt: null,
        id: "order-stage2-other",
        orderNo: "ORD-STAGE2-LOCAL-OTHER",
        vehicle: {
          brand: "NIO",
          id: "vehicle-stage2-other",
          model: "Other Local Harness",
          plateNo: "测B00002",
          vin: "LOCALSTAGE2VIN999999"
        }
      }
    ],
    paymentRecords: [] as TestRecord[],
    receivableBills: [] as TestRecord[],
    vehicleDelivery: {
      actualDeliveredAt: null,
      deletedAt: null,
      deliveryLocation: "本地交付测试点",
      id: "delivery-stage2-local",
      orderId,
      scheduledAt: new Date("2026-07-23T02:00:00.000Z")
    },
    workOrders: [
      {
        accessTokenExpiresAt: new Date("2026-08-01T08:00:00.000Z"),
        accessTokenHash: null,
        accessTokenRevokedAt: null,
        accessoryChecklist: null,
        assignedInternalUserId: null,
        adminReviewStatus: "NONE",
        createdAt: now,
        customerConfirmedAt: null,
        customerObjectedAt: null,
        customerObjectionReason: null,
        customerReviewStartedAt: null,
        damageDeclared: null,
        deliveryLocation: "本地交付测试点",
        energyLevelText: null,
        externalOperatorName: "本地测试交付员",
        externalOperatorPhone: FIELD_OPERATOR_PHONE,
        fieldCompletedAt: null,
        fieldNotes: null,
        fieldStartedAt: null,
        fieldSubmittedAt: null,
        firstAccessedAt: null,
        fuelLevelText: null,
        handoverId,
        handoverMileageKm: null,
        handoverType: "DELIVERY_OUTBOUND",
        id: workOrderId,
        lastAccessedAt: null,
        metadata: null,
        noVisibleDamageDeclared: null,
        operatorType: "EXTERNAL",
        opsReviewStatus: "NOT_REQUIRED",
        orderId,
        reviewVersion: 0,
        scheduledAt: new Date("2026-07-23T02:00:00.000Z"),
        status: "ASSIGNED",
        updatedAt: now,
        vehicleDeliveryId: "delivery-stage2-local"
      }
    ] as TestRecord[]
  };

  const prisma = createPrismaMock(state, now);
  const evidenceService = createEvidenceServiceMock(state, now);
  const deliveryHandoverService = {
    assertDeliveryCanBeConfirmed: vi.fn(),
    getOrCreateDraftHandover: vi.fn(async () => state.handover),
    isDeliveryReady: vi.fn()
  };
  const storageService = {
    putDeliveryEvidenceFile: vi.fn(async (input: TestRecord) => ({
      bucket: "synthetic-local-bucket",
      objectKey: `${SYNTHETIC_OBJECT_KEY_SHOULD_NOT_RENDER}:${String(input.originalName)}`,
      stored: { driver: "local-test", key: "synthetic-local-key", size: input.size }
    }))
  };
  const workOrderService = new HandoverWorkOrderService(
    prisma as never,
    evidenceService as never,
    deliveryHandoverService as never,
    storageService as never
  );
  const portalReviewService = new PortalHandoverReviewService(
    prisma as never,
    evidenceService as unknown as DeliveryEvidenceService,
    workOrderService
  );

  return {
    customerPortalPhone: CUSTOMER_PORTAL_PHONE,
    currentCustomer: () => currentCustomer("customer-stage2-owner", CUSTOMER_PORTAL_PHONE),
    currentWorkOrder: () => state.workOrders.find((item) => item.id === workOrderId),
    deliveryHandoverService,
    evidenceService,
    operatorPhone: FIELD_OPERATOR_PHONE,
    orderId,
    otherCustomer: () => currentCustomer("customer-stage2-other", OTHER_CUSTOMER_PHONE),
    portalReviewService,
    prisma,
    requiredUploadItems: () => state.evidenceItems.filter((item) => item.isRequired === true),
    setWorkOrderStatus(status: string) {
      Object.assign(state.workOrders[0]!, { status });
    },
    snapshotSideEffects: () => snapshotSideEffects(state),
    state,
    storageService,
    submitFieldEvidenceThroughFieldSession: async () => {
      await workOrderService.startFieldAccessibleWorkOrder(workOrderId, FIELD_OPERATOR_PHONE, "field-session-local");
      await workOrderService.updateFieldAccessibleFacts(
        workOrderId,
        FIELD_OPERATOR_PHONE,
        {
          accessoryChecklist: { chargingCable: true, keys: 2, reflectiveVest: true },
          damageDeclared: false,
          deliveryLocation: "本地交付测试点",
          energyLevelText: "80%",
          fieldNotes: "本地合成现场资料已提交",
          handoverMileageKm: 28600,
          noVisibleDamageDeclared: true
        },
        "field-session-local"
      );
      for (const item of state.evidenceItems.filter((entry) => entry.isRequired === true)) {
        const mediaType = firstAllowedMediaType(item);
        await workOrderService.uploadAndAttachFieldAccessibleEvidenceFile(
          workOrderId,
          FIELD_OPERATOR_PHONE,
          String(item.id),
          [uploadFile(`${String(item.evidenceType).toLowerCase()}.${mediaType === "VIDEO" ? "mp4" : "jpg"}`, mediaType)],
          {},
          "field-session-local"
        );
      }
      await workOrderService.declareFieldAccessibleNoVisibleDamage(
        workOrderId,
        FIELD_OPERATOR_PHONE,
        "本地测试无可见损伤"
      );
      const readiness = await workOrderService.getFieldAccessibleReadiness(workOrderId, FIELD_OPERATOR_PHONE);
      expect(readiness).toMatchObject({ blockingReasons: [], ready: true });
      return workOrderService.submitFieldAccessibleEvidence(
        workOrderId,
        FIELD_OPERATOR_PHONE,
        "field-session-local"
      );
    },
    workOrderId,
    workOrderService
  };
}

function createPrismaMock(state: Stage2HarnessState, now: Date) {
  const prisma = {
    contract: {
      create: vi.fn(async ({ data }: { data: TestRecord }) => {
        const contract = { ...data, id: `contract-generated-${state.contracts.length + 1}` };
        state.contracts.push(contract);
        return contract;
      })
    },
    contractESignTask: {
      create: vi.fn(async ({ data }: { data: TestRecord }) => {
        const task = { ...data, id: `esign-task-${state.eSignTasks.length + 1}` };
        state.eSignTasks.push(task);
        return task;
      })
    },
    fileObject: {
      create: vi.fn(async ({ data }: { data: TestRecord }) => {
        const fileObject = {
          ...data,
          createdAt: now,
          id: `file-${state.fileObjects.length + 1}`,
          updatedAt: now
        };
        state.fileObjects.push(fileObject);
        return fileObject;
      })
    },
    lease: {
      create: vi.fn(async ({ data }: { data: TestRecord }) => {
        state.leases.push(data);
        return data;
      })
    },
    paymentRecord: {
      create: vi.fn(async ({ data }: { data: TestRecord }) => {
        state.paymentRecords.push(data);
        return data;
      })
    },
    receivableBill: {
      create: vi.fn(async ({ data }: { data: TestRecord }) => {
        state.receivableBills.push(data);
        return data;
      })
    },
    subscriptionOrder: {
      findFirst: vi.fn(async ({ where }: { where?: TestRecord } = {}) =>
        state.orders.find((order) => matchesOrderWhere(order, where ?? {})) ?? null
      ),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        state.orders.find((order) => order.id === where.id) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: TestRecord; where: { id?: string } }) => {
        const order = state.orders.find((item) => item.id === where.id);
        if (!order) {
          throw new Error("order not found");
        }
        Object.assign(order, data);
        return order;
      })
    },
    vehicleDelivery: {
      findUnique: vi.fn(async () => state.vehicleDelivery),
      update: vi.fn(async ({ data }: { data: TestRecord }) => {
        Object.assign(state.vehicleDelivery, data);
        return state.vehicleDelivery;
      })
    },
    vehicleDeliveryEvidenceItem: {
      findFirst: vi.fn(async ({ where }: { where: TestRecord }) =>
        state.evidenceItems.find((item) => matchesEvidenceItemWhere(item, where)) ?? null
      )
    },
    vehicleDeliveryHandover: {
      findFirst: vi.fn(async () => state.handover)
    },
    vehicleHandoverWorkOrder: {
      findFirst: vi.fn(async ({ where }: { where: TestRecord }) =>
        withWorkOrderRelations(
          state.workOrders.find((workOrder) => matchesWorkOrderWhere(workOrder, where)) ?? null,
          state
        )
      ),
      findMany: vi.fn(async ({ where }: { where: TestRecord }) =>
        state.workOrders
          .filter((workOrder) => matchesWorkOrderWhere(workOrder, where))
          .map((workOrder) => withWorkOrderRelations(workOrder, state))
      ),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        state.workOrders.find((workOrder) => workOrder.id === where.id) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: TestRecord; where: { id?: string } }) => {
        const workOrder = state.workOrders.find((item) => item.id === where.id);
        if (!workOrder) {
          throw new Error("work order not found");
        }
        Object.assign(workOrder, data, { updatedAt: now });
        return workOrder;
      }),
      updateMany: vi.fn(async ({ data, where }: { data: TestRecord; where: TestRecord }) => {
        const workOrder = state.workOrders.find((item) =>
          item.id === where.id && Number(item.reviewVersion ?? 0) === Number(where.reviewVersion ?? 0)
        );
        if (!workOrder) {
          return { count: 0 };
        }
        const reviewVersion = data.reviewVersion;
        Object.assign(workOrder, data, {
          reviewVersion: isRecord(reviewVersion) && typeof reviewVersion.increment === "number"
            ? Number(workOrder.reviewVersion ?? 0) + reviewVersion.increment
            : workOrder.reviewVersion,
          updatedAt: now
        });
        return { count: 1 };
      })
    }
  };
  return Object.assign(prisma, {
    $transaction: vi.fn(async (callback: (client: typeof prisma) => Promise<unknown>) => callback(prisma))
  });
}

function createEvidenceServiceMock(state: Stage2HarnessState, now: Date) {
  return {
    assertFieldEvidenceComplete: vi.fn(async (orderId: string, handoverId: string | null, fieldState: TestRecord) => {
      const readiness = buildFieldEvidenceReadiness(state, orderId, handoverId, fieldState);
      if (!readiness.ready) {
        throw new BadRequestException(readiness.blockingReasons[0] ?? "交付证据尚未全部上传。");
      }
    }),
    validateEvidenceFileMutation: vi.fn(async () => undefined),
    attachEvidenceFile: vi.fn(async (itemId: string, fileId: string, mediaType: DeliveryEvidenceMediaType) => {
      const item = state.evidenceItems.find((entry) => entry.id === itemId);
      if (!item) {
        throw new BadRequestException("交付证据项不存在。");
      }
      const evidenceFile = {
        createdAt: now,
        fileId,
        evidenceItemId: itemId,
        id: `evidence-file-${state.evidenceFiles.length + 1}`,
        mediaType,
        objectKey: `${SYNTHETIC_OBJECT_KEY_SHOULD_NOT_RENDER}:evidence-link-${state.evidenceFiles.length + 1}`,
        uploadedAt: now,
        updatedAt: now
      };
      state.evidenceFiles.push(evidenceFile);
      Object.assign(item, {
        reviewStatus: "APPROVED",
        reviewedAt: now,
        status: "APPROVED"
      });
      return withEvidenceItemRelations(item, state);
    }),
    declareNoVisibleDamage: vi.fn(async () => {
      const item = state.evidenceItems.find((entry) => entry.evidenceType === "NO_VISIBLE_DAMAGE_DECLARATION");
      if (!item) {
        throw new BadRequestException("无可见损伤声明证据项不存在。");
      }
      Object.assign(item, {
        declaredNoDamage: true,
        reviewStatus: "APPROVED",
        reviewedAt: now,
        status: "APPROVED"
      });
      return withEvidenceItemRelations(item, state);
    }),
    getChecklist: vi.fn(async ({ handoverId, orderId }: { handoverId?: null | string; orderId: string }) => {
      const fieldState = state.workOrders.find((workOrder) =>
        workOrder.orderId === orderId && (!handoverId || workOrder.handoverId === handoverId)
      ) ?? {};
      const readiness = buildFieldEvidenceReadiness(state, orderId, handoverId ?? null, fieldState);
      return {
        blockingReasons: readiness.blockingReasons,
        items: state.evidenceItems
          .filter((item) => item.orderId === orderId && (!handoverId || item.handoverId === handoverId))
          .map((item) => withEvidenceItemRelations(item, state)),
        ready: readiness.ready
      };
    }),
    initializeChecklist: vi.fn(async () => ({
      items: state.evidenceItems.map((item) => withEvidenceItemRelations(item, state))
    })),
    validateFieldEvidenceComplete: vi.fn(async (orderId: string, handoverId: string | null, fieldState: TestRecord) =>
      buildFieldEvidenceReadiness(state, orderId, handoverId, fieldState)
    )
  };
}

function buildFieldEvidenceReadiness(
  state: Stage2HarnessState,
  orderId: string,
  handoverId: null | string,
  fieldState: TestRecord
) {
  const blockingReasons: string[] = [];
  for (const item of state.evidenceItems.filter((entry) =>
    entry.orderId === orderId && (!handoverId || entry.handoverId === handoverId) && entry.isRequired === true
  )) {
    if (getEvidenceFilesForItem(state, String(item.id)).length === 0) {
      blockingReasons.push(`${String(item.title)} 尚未上传。`);
    }
  }
  if (fieldState.damageDeclared === true) {
    const damage = state.evidenceItems.find((item) => item.evidenceType === "DAMAGE_STATIC_CLOSEUP");
    if (!damage || getEvidenceFilesForItem(state, String(damage.id)).length === 0) {
      blockingReasons.push("请上传损伤/瑕疵近拍");
    }
  } else if (fieldState.noVisibleDamageDeclared === true) {
    const noDamage = state.evidenceItems.find((item) => item.evidenceType === "NO_VISIBLE_DAMAGE_DECLARATION");
    if (!noDamage || noDamage.declaredNoDamage !== true) {
      blockingReasons.push("请完成无可见损伤声明。");
    }
  } else {
    blockingReasons.push("请处理车辆损伤状态。");
  }

  return {
    blockingDetails: blockingReasons.map((message) => ({ code: "LOCAL_STAGE2_BLOCKER", message })),
    blockingReasons,
    handoverId,
    orderId,
    ready: blockingReasons.length === 0
  };
}

function createEvidenceItems(now: Date, orderId: string, handoverId: string) {
  return EVIDENCE_DEFINITIONS.map((definition, index) => ({
    allowedMediaTypes: definition.allowedMediaTypes,
    conditionKey: definition.conditionKey ?? null,
    conditionValue: definition.conditionValue ?? null,
    createdAt: now,
    declaredNoDamage: null,
    description: null,
    evidenceType: definition.evidenceType,
    fileRequired: definition.fileRequired,
    handoverId,
    id: `evidence-item-${index + 1}`,
    isConditional: definition.isConditional,
    isRequired: definition.isRequired,
    orderId,
    rejectionReason: null,
    requirementLevel: definition.isRequired ? "REQUIRED" : "CONDITIONAL",
    reviewStatus: "NOT_STARTED",
    status: "NOT_STARTED",
    title: definition.title,
    updatedAt: now,
    vehicleDeliveryId: "delivery-stage2-local"
  }));
}

const EVIDENCE_DEFINITIONS = [
  { allowedMediaTypes: ["PHOTO"], evidenceType: "CUSTOMER_WITH_VEHICLE_FRONT", fileRequired: true, isConditional: false, isRequired: true, title: "客户与车辆正面合影" },
  { allowedMediaTypes: ["PHOTO"], evidenceType: "VEHICLE_FRONT", fileRequired: true, isConditional: false, isRequired: true, title: "车辆车头正面" },
  { allowedMediaTypes: ["PHOTO"], evidenceType: "VEHICLE_REAR", fileRequired: true, isConditional: false, isRequired: true, title: "车辆车尾正面" },
  { allowedMediaTypes: ["PHOTO"], evidenceType: "VIN_OR_FRAME_NUMBER", fileRequired: true, isConditional: false, isRequired: true, title: "车架号 / VIN" },
  { allowedMediaTypes: ["PHOTO"], evidenceType: "ODOMETER_DASHBOARD", fileRequired: true, isConditional: false, isRequired: true, title: "仪表台公里数" },
  { allowedMediaTypes: ["PHOTO"], evidenceType: "INTERIOR_REAR", fileRequired: true, isConditional: false, isRequired: true, title: "后排内饰" },
  { allowedMediaTypes: ["PHOTO"], evidenceType: "INTERIOR_FRONT", fileRequired: true, isConditional: false, isRequired: true, title: "前排内饰" },
  { allowedMediaTypes: ["VIDEO"], evidenceType: "WALKAROUND_VIDEO", fileRequired: true, isConditional: false, isRequired: true, title: "车辆环绕视频" },
  { allowedMediaTypes: ["PHOTO", "VIDEO"], evidenceType: "WHEEL_CLOSEUP_FRONT_LEFT", fileRequired: true, isConditional: false, isRequired: true, title: "左前轮毂近拍" },
  { allowedMediaTypes: ["PHOTO", "VIDEO"], evidenceType: "WHEEL_CLOSEUP_FRONT_RIGHT", fileRequired: true, isConditional: false, isRequired: true, title: "右前轮毂近拍" },
  { allowedMediaTypes: ["PHOTO", "VIDEO"], evidenceType: "WHEEL_CLOSEUP_REAR_LEFT", fileRequired: true, isConditional: false, isRequired: true, title: "左后轮毂近拍" },
  { allowedMediaTypes: ["PHOTO", "VIDEO"], evidenceType: "WHEEL_CLOSEUP_REAR_RIGHT", fileRequired: true, isConditional: false, isRequired: true, title: "右后轮毂近拍" },
  { allowedMediaTypes: ["PHOTO", "VIDEO"], conditionKey: "damageDeclared", conditionValue: "true", evidenceType: "DAMAGE_STATIC_CLOSEUP", fileRequired: true, isConditional: true, isRequired: false, title: "损伤/瑕疵静态近拍" },
  { allowedMediaTypes: [], conditionKey: "noVisibleDamageDeclared", conditionValue: "true", evidenceType: "NO_VISIBLE_DAMAGE_DECLARATION", fileRequired: false, isConditional: true, isRequired: false, title: "无可见损伤声明" }
];

function withWorkOrderRelations(workOrder: TestRecord | null, state: Stage2HarnessState) {
  if (!workOrder) {
    return null;
  }
  return {
    ...workOrder,
    handover: state.handover,
    order: state.orders.find((order) => order.id === workOrder.orderId) ?? null
  };
}

function withEvidenceItemRelations(item: TestRecord, state: Stage2HarnessState) {
  return {
    ...item,
    files: getEvidenceFilesForItem(state, String(item.id)).map((file) => ({
      ...file,
      file: state.fileObjects.find((entry) => entry.id === file.fileId) ?? null,
      uploader: null
    })),
    reviewer: null
  };
}

function getEvidenceFilesForItem(state: Stage2HarnessState, itemId: string) {
  return state.evidenceFiles.filter((file) => file.evidenceItemId === itemId);
}

function matchesWorkOrderWhere(workOrder: TestRecord, where: TestRecord): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR" && Array.isArray(expected)) {
      return expected.some((branch) => matchesWorkOrderWhere(workOrder, branch as TestRecord));
    }
    if (key === "id") {
      return workOrder.id === expected;
    }
    if (key === "orderId") {
      return workOrder.orderId === expected;
    }
    if (key === "handoverId") {
      return workOrder.handoverId === expected;
    }
    if (key === "operatorType") {
      return workOrder.operatorType === expected;
    }
    if (key === "externalOperatorPhone") {
      return workOrder.externalOperatorPhone === expected;
    }
    if (key === "accessTokenRevokedAt") {
      return workOrder.accessTokenRevokedAt === expected;
    }
    if (key === "accessTokenExpiresAt" && expected === null) {
      return workOrder.accessTokenExpiresAt === null;
    }
    if (key === "accessTokenExpiresAt" && isRecord(expected) && expected.gt instanceof Date) {
      const expiresAt = workOrder.accessTokenExpiresAt;
      return expiresAt instanceof Date && expiresAt.getTime() > expected.gt.getTime();
    }
    if (key === "status" && isRecord(expected) && Array.isArray(expected.in)) {
      return expected.in.includes(workOrder.status);
    }
    if (key === "status" && isRecord(expected) && Array.isArray(expected.notIn)) {
      return !expected.notIn.includes(workOrder.status);
    }
    if (key === "status") {
      return workOrder.status === expected;
    }
    if (key === "order" && isRecord(expected)) {
      const order = findOrderForWorkOrder(workOrder);
      if (!order) {
        return false;
      }
      if (expected.customerId && order.customerId !== expected.customerId) {
        return false;
      }
      if ("deletedAt" in expected && expected.deletedAt === null && order.deletedAt !== null) {
        return false;
      }
      return true;
    }
    return true;
  });
}

function matchesEvidenceItemWhere(item: TestRecord, where: TestRecord): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR" && Array.isArray(expected)) {
      return expected.some((branch) => matchesEvidenceItemWhere(item, branch as TestRecord));
    }
    return item[key] === expected;
  });
}

function matchesOrderWhere(order: TestRecord, where: TestRecord): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "id") {
      return order.id === expected;
    }
    if (key === "deletedAt") {
      return order.deletedAt === expected;
    }
    return true;
  });
}

function findOrderForWorkOrder(workOrder: TestRecord) {
  if (workOrder.orderId === "order-stage2-local") {
    return { customerId: "customer-stage2-owner", deletedAt: null };
  }
  if (workOrder.orderId === "order-stage2-other") {
    return { customerId: "customer-stage2-other", deletedAt: null };
  }
  return null;
}

function firstAllowedMediaType(item: TestRecord) {
  const allowed = Array.isArray(item.allowedMediaTypes) ? item.allowedMediaTypes : [];
  const first = allowed.find((entry): entry is string => typeof entry === "string") ?? "PHOTO";
  return first === "VIDEO" ? "VIDEO" : "PHOTO";
}

function uploadFile(originalname: string, mediaType: "PHOTO" | "VIDEO") {
  const mimetype = mediaType === "VIDEO" ? "video/mp4" : "image/jpeg";
  return {
    buffer: Buffer.from("synthetic-local-evidence"),
    mimetype,
    originalname,
    size: 24
  };
}

function currentCustomer(customerId: string, phone: string): CurrentCustomer {
  return {
    accountStatus: "ACTIVE" as never,
    customerAccountId: `account-${customerId}`,
    customerId,
    phone
  };
}

function snapshotSideEffects(state: Stage2HarnessState) {
  const order = state.orders.find((item) => item.id === "order-stage2-local");
  return {
    actualDeliveryAt: order?.actualDeliveryAt ?? null,
    contractArtifacts: state.generatedContractArtifacts.length,
    contracts: state.contracts.length,
    eSignTasks: state.eSignTasks.length,
    handoverSignedDocumentObjectKey: state.handover.signedDocumentObjectKey ?? null,
    handoverSourceDocumentObjectKey: state.handover.sourceDocumentObjectKey ?? null,
    handoverStatus: state.handover.status,
    leases: state.leases.length,
    paymentRecords: state.paymentRecords.length,
    receivableBills: state.receivableBills.length,
    signingUrls: state.generatedSigningUrls.length,
    vehicleDeliveryActualDeliveredAt: state.vehicleDelivery.actualDeliveredAt ?? null
  };
}

function expectNoStage2SideEffects(
  harness: ReturnType<typeof createStage2HandoverE2EHarness>,
  before: ReturnType<typeof snapshotSideEffects>
) {
  expect(harness.snapshotSideEffects()).toEqual(before);
  expect(harness.prisma.contract.create).not.toHaveBeenCalled();
  expect(harness.prisma.contractESignTask.create).not.toHaveBeenCalled();
  expect(harness.prisma.lease.create).not.toHaveBeenCalled();
  expect(harness.prisma.paymentRecord.create).not.toHaveBeenCalled();
  expect(harness.prisma.receivableBill.create).not.toHaveBeenCalled();
  expect(harness.prisma.vehicleDelivery.update).not.toHaveBeenCalled();
  expect(harness.deliveryHandoverService.assertDeliveryCanBeConfirmed).not.toHaveBeenCalled();
  expect(harness.deliveryHandoverService.isDeliveryReady).not.toHaveBeenCalled();
  expect(harness.state.fadadaProviderCalls.createSignTask).not.toHaveBeenCalled();
  expect(harness.state.fadadaProviderCalls.getSignerUrl).not.toHaveBeenCalled();
  expect(harness.state.fadadaProviderCalls.uploadDocument).not.toHaveBeenCalled();
}

function expectPortalDtoIsSafe(value: unknown) {
  const serialized = JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
  expect(serialized).not.toContain(SYNTHETIC_OBJECT_KEY_SHOULD_NOT_RENDER);
  expect(serialized).not.toContain(SYNTHETIC_SIGNING_URL_SHOULD_NOT_RENDER);
  expect(serialized).not.toContain(SYNTHETIC_ID_SHOULD_NOT_RENDER);
  expect(serialized).not.toContain(SYNTHETIC_PROVIDER_INTERNAL_SHOULD_NOT_RENDER);
  expect(serialized).not.toContain(SYNTHETIC_FINANCE_VALUE_SHOULD_NOT_RENDER);
  expect(serialized).not.toMatch(/objectKey|bucket|signingUrl|providerInternal|deposit|payment|lease|billing/i);
}

function isRecord(value: unknown): value is TestRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
