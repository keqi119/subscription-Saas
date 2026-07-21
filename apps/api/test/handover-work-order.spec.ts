import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { ContractStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";

describe("HandoverWorkOrderService", () => {
  it("creates one active delivery-outbound work order, links Stage 2 handover, and initializes evidence checklist", async () => {
    const harness = createHandoverWorkOrderHarness();

    const workOrder = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);

    expect(workOrder).toMatchObject({
      handoverId: "handover-1",
      handoverType: "DELIVERY_OUTBOUND",
      orderId: harness.orderId,
      status: "DRAFT",
      vehicleDeliveryId: "delivery-1"
    });
    expect(harness.evidenceService.initializeChecklist).toHaveBeenCalledWith(harness.orderId, "handover-1");

    await expect(
      harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id)
    ).rejects.toThrow("进行中的交付工单");

    await harness.service.voidOrCancel(workOrder.id, "CANCELLED", harness.admin.id, "重新派单");
    const replacement = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    expect(replacement.id).toBe("work-order-2");
  });

  it("assigns internal and external operators without storing plaintext external tokens", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);

    const internal = await harness.service.assignInternalOperator(draft.id, harness.internalUser.id, harness.admin.id);
    expect(internal).toMatchObject({
      assignedInternalUserId: harness.internalUser.id,
      operatorType: "INTERNAL",
      status: "ASSIGNED"
    });

    const external = await harness.service.assignExternalOperator(
      draft.id,
      {
        expiresAt: new Date("2026-07-28T08:00:00.000Z"),
        name: "临时交付员",
        organization: "外包交付合作方",
        phone: "13900001111"
      },
      harness.admin.id
    );

    expect(external.accessToken).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(harness.state.workOrders[0]!.accessTokenHash).toBeTruthy();
    expect(harness.state.workOrders[0]!.accessTokenHash).not.toBe(external.accessToken);
    expect(JSON.stringify(harness.state.workOrders[0]!)).not.toContain(external.accessToken);
  });

  it("verifies external access, updates access timestamps, and returns only a limited masked task view", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      {
        expiresAt: new Date("2026-07-28T08:00:00.000Z"),
        name: "临时交付员",
        phone: "13900001111"
      },
      harness.admin.id
    );

    const view = await harness.service.verifyExternalAccess(assigned.accessToken);

    expect(view).toMatchObject({
      id: draft.id,
      orderNo: "ORD202607210001",
      status: "ASSIGNED"
    });
    expect(view.customer.mobileMasked).toBe("186****0212");
    expect(view.vehicle.vinSuffix).toBe("888888");
    expect(harness.state.workOrders[0]!.firstAccessedAt).toBeInstanceOf(Date);
    expect(harness.state.workOrders[0]!.lastAccessedAt).toBeInstanceOf(Date);

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("TEST_ID_CARD_SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("18616570212");
    expect(serialized).not.toContain("monthlyFeeAmount");
    expect(serialized).not.toContain("contractId");
    expect(serialized).not.toContain("signUrl");
  });

  it("rejects revoked and expired external tokens", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    const assigned = await harness.service.assignExternalOperator(
      draft.id,
      {
        expiresAt: new Date("2026-07-28T08:00:00.000Z"),
        name: "临时交付员",
        phone: "13900001111"
      },
      harness.admin.id
    );

    await harness.service.revokeExternalAccess(draft.id, harness.admin.id);
    await expect(harness.service.verifyExternalAccess(assigned.accessToken)).rejects.toThrow(UnauthorizedException);

    const expiredHarness = createHandoverWorkOrderHarness();
    const expiredDraft = await expiredHarness.service.createDraft(
      expiredHarness.orderId,
      "DELIVERY_OUTBOUND",
      expiredHarness.admin.id
    );
    const expired = await expiredHarness.service.assignExternalOperator(
      expiredDraft.id,
      {
        expiresAt: new Date("2026-07-20T08:00:00.000Z"),
        name: "临时交付员",
        phone: "13900001111"
      },
      expiredHarness.admin.id
    );
    await expect(expiredHarness.service.verifyExternalAccess(expired.accessToken)).rejects.toThrow(UnauthorizedException);
  });

  it("lists only active external work orders assigned to the field operator phone with safe summaries", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        deliveryLocation: "上海市测试交付点",
        externalOperatorName: "现场交付员",
        externalOperatorPhone: "13800000000",
        id: "work-order-visible-late",
        operatorType: "EXTERNAL",
        scheduledAt: new Date("2026-07-23T02:00:00.000Z"),
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        deliveryLocation: "上海市测试交付点",
        externalOperatorName: "现场交付员",
        externalOperatorPhone: "13800000000",
        id: "work-order-visible-early",
        operatorType: "EXTERNAL",
        scheduledAt: new Date("2026-07-22T02:00:00.000Z"),
        status: "FIELD_IN_PROGRESS"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13900000000",
        id: "work-order-other-phone",
        operatorType: "EXTERNAL",
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-20T08:00:00.000Z"),
        externalOperatorPhone: "13800000000",
        id: "work-order-expired",
        operatorType: "EXTERNAL",
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        accessTokenRevokedAt: harness.now,
        externalOperatorPhone: "13800000000",
        id: "work-order-revoked",
        operatorType: "EXTERNAL",
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13800000000",
        id: "work-order-completed",
        operatorType: "EXTERNAL",
        status: "FIELD_COMPLETED"
      }
    );

    const list = await harness.service.listFieldAccessibleWorkOrders("+86 138-0000-0000");

    expect(list.map((item) => item.id)).toEqual(["work-order-visible-early", "work-order-visible-late"]);
    expect(list[0]).toMatchObject({
      customer: {
        mobileMasked: "186****0212"
      },
      evidenceProgress: {
        uploaded: 1
      },
      orderNo: "ORD202607210001",
      vehicle: {
        vinSuffix: "888888"
      }
    });

    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("TEST_ID_CARD_SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("18616570212");
    expect(serialized).not.toContain("monthlyFeeAmount");
    expect(serialized).not.toContain("contractId");
    expect(serialized).not.toContain("signUrl");
    expect(serialized).not.toContain("oss/internal/evidence.jpg");
  });

  it("returns an empty field work-order list when no active task is assigned to the phone", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.state.workOrders.push(
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13900000000",
        id: "work-order-other-phone",
        operatorType: "EXTERNAL",
        status: "ASSIGNED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13800000000",
        id: "work-order-cancelled",
        operatorType: "EXTERNAL",
        status: "CANCELLED"
      },
      {
        ...baseWorkOrder(harness),
        accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorPhone: "13800000000",
        id: "work-order-ops-reviewed",
        operatorType: "EXTERNAL",
        status: "OPS_REVIEWED"
      }
    );

    await expect(harness.service.listFieldAccessibleWorkOrders("13800000000")).resolves.toEqual([]);
  });

  it("returns safe field task detail only for the assigned phone", async () => {
    const harness = createHandoverWorkOrderHarness();
    harness.evidenceService.setChecklist({
      blockingReasons: [],
      items: [
        {
          allowedMediaTypes: ["PHOTO"],
          evidenceType: "VEHICLE_FRONT",
          fileRequired: true,
          files: [
            {
              file: {
                id: "file-1",
                mimeType: "image/jpeg",
                objectKey: "oss/internal/evidence.jpg",
                originalName: "front.jpg",
                sizeBytes: 1024
              },
              fileId: "file-1",
              id: "evidence-file-1",
              mediaType: "PHOTO",
              objectKey: "oss/internal/evidence.jpg",
              uploadedAt: harness.now,
              uploadedBy: { id: "user-admin" }
            }
          ],
          id: "evidence-item-1",
          isConditional: false,
          isRequired: true,
          orderId: harness.orderId,
          requirementLevel: "REQUIRED",
          reviewStatus: "PENDING",
          status: "UPLOADED",
          title: "车辆车头正面"
        }
      ],
      ready: false
    });
    harness.state.workOrders.push({
      ...baseWorkOrder(harness),
      accessTokenExpiresAt: new Date("2026-07-28T08:00:00.000Z"),
      accessoryChecklist: { chargingCable: true, keys: 2 },
      deliveryLocation: "上海市测试交付点",
      energyLevelText: "80%",
      externalOperatorPhone: "13800000000",
      fieldNotes: "客户现场确认车辆外观",
      fuelLevelText: null,
      handoverMileageKm: 28500,
      id: "work-order-visible",
      noVisibleDamageDeclared: true,
      operatorType: "EXTERNAL",
      status: "FIELD_IN_PROGRESS"
    });

    const detail = await harness.service.getFieldAccessibleWorkOrder("work-order-visible", "13800000000");

    expect(detail).toMatchObject({
      fieldFacts: {
        energyLevelText: "80%",
        handoverMileageKm: 28500,
        noVisibleDamageDeclared: true
      },
      id: "work-order-visible",
      orderNo: "ORD202607210001"
    });
    expect(detail.evidenceChecklist.items[0]).toMatchObject({
      fileCount: 1,
      files: [
        {
          file: {
            id: "file-1",
            mimeType: "image/jpeg",
            originalName: "front.jpg",
            sizeBytes: 1024
          },
          mediaType: "PHOTO"
        }
      ]
    });
    expect(JSON.stringify(detail)).not.toContain("oss/internal/evidence.jpg");

    await expect(
      harness.service.getFieldAccessibleWorkOrder("work-order-visible", "13900000000")
    ).rejects.toThrow(UnauthorizedException);
  });

  it("requires field facts, evidence completeness, and a resolved damage state before customer review", async () => {
    const harness = createHandoverWorkOrderHarness();
    const draft = await harness.service.createDraft(harness.orderId, "DELIVERY_OUTBOUND", harness.admin.id);
    await harness.service.assignInternalOperator(draft.id, harness.internalUser.id, harness.admin.id);
    await harness.service.startFieldWork(draft.id, harness.internalUser.id);

    await expect(harness.service.submitEvidence(draft.id, harness.internalUser.id)).rejects.toThrow(BadRequestException);

    await harness.service.updateFieldFacts(draft.id, {
      accessoryChecklist: { chargingCable: true, keys: 2 },
      deliveryLocation: "上海市测试交付点",
      energyLevelText: "80%",
      handoverMileageKm: 28500,
      noVisibleDamageDeclared: true
    }, harness.internalUser.id);

    harness.evidenceService.setFieldComplete(false);
    await expect(harness.service.submitEvidence(draft.id, harness.internalUser.id)).rejects.toThrow("证据尚未完整");

    harness.evidenceService.setFieldComplete(true);
    const submitted = await harness.service.submitEvidence(draft.id, harness.internalUser.id);
    expect(submitted).toMatchObject({
      fieldSubmittedAt: expect.any(Date),
      status: "CUSTOMER_REVIEWING"
    });
    expect(harness.evidenceService.assertFieldEvidenceComplete).toHaveBeenCalledWith(
      harness.orderId,
      "handover-1",
      expect.objectContaining({ noVisibleDamageDeclared: true })
    );
  });

  it("allows customer no-objection confirmation to unlock Stage 2 PDF/eSign while ops review remains non-blocking", async () => {
    const harness = createReadyForCustomerReviewHarness();

    await expect(harness.service.assertReadyForStage2Pdf(harness.orderId)).rejects.toThrow("客户尚未确认");

    const confirmed = await harness.service.customerConfirmNoObjection("work-order-1", "customer-1");
    expect(confirmed).toMatchObject({
      customerConfirmedAt: expect.any(Date),
      status: "CUSTOMER_CONFIRMED"
    });

    await expect(harness.service.markOpsReviewPending("work-order-1", harness.admin.id)).rejects.toThrow(
      BadRequestException
    );

    await harness.service.markCustomerSigned("work-order-1", new Date("2026-07-21T04:10:00.000Z"), harness.admin.id);
    await harness.service.markOpsReviewPending("work-order-1", harness.admin.id);
    await expect(harness.service.assertReadyForStage2Pdf(harness.orderId)).resolves.toBeUndefined();
    await expect(harness.service.assertReadyForStage2ESign(harness.orderId)).resolves.toBeUndefined();

    await harness.service.markOpsReviewRejected("work-order-1", harness.admin.id, "抽检后补材料");
    await expect(harness.service.assertReadyForStage2ESign(harness.orderId)).resolves.toBeUndefined();
  });

  it("blocks ops review pending before post-signing work-order states", async () => {
    const blockedStatuses = [
      "DRAFT",
      "ASSIGNED",
      "FIELD_IN_PROGRESS",
      "EVIDENCE_SUBMITTED",
      "CUSTOMER_REVIEWING",
      "CUSTOMER_CONFIRMED",
      "CUSTOMER_OBJECTED",
      "VOIDED",
      "FAILED",
      "CANCELLED"
    ];

    for (const status of blockedStatuses) {
      const harness = createConfirmedWorkOrderHarness();
      Object.assign(harness.state.workOrders[0]!, { status });

      await expect(harness.service.markOpsReviewPending("work-order-1", harness.admin.id)).rejects.toThrow(
        BadRequestException
      );
    }
  });

  it("allows ops review pending after customer signing, platform seal, or field completion", async () => {
    const allowedStatuses = ["CUSTOMER_SIGNED", "PLATFORM_SEALED", "FIELD_COMPLETED", "OPS_REVIEW_PENDING", "OPS_REVIEWED"];

    for (const status of allowedStatuses) {
      const harness = createConfirmedWorkOrderHarness();
      Object.assign(harness.state.workOrders[0]!, {
        fieldCompletedAt: harness.now,
        opsReviewStatus: status === "OPS_REVIEW_PENDING" ? "PENDING" : "NOT_REQUIRED",
        status
      });

      const updated = await harness.service.markOpsReviewPending("work-order-1", harness.admin.id);

      expect(updated).toMatchObject({
        opsReviewStatus: "PENDING",
        status: "OPS_REVIEW_PENDING"
      });
    }
  });

  it("blocks Stage 2 signing when the customer objects or the work order is cancelled", async () => {
    const harness = createReadyForCustomerReviewHarness();

    await harness.service.customerObject("work-order-1", "customer-1", "车辆外观有异议");

    await expect(harness.service.assertReadyForStage2ESign(harness.orderId)).rejects.toThrow("客户存在异议");
    expect(harness.state.workOrders[0]!).toMatchObject({
      customerObjectionReason: "车辆外观有异议",
      status: "CUSTOMER_OBJECTED"
    });

    const cancelledHarness = createReadyForCustomerReviewHarness();
    await cancelledHarness.service.voidOrCancel("work-order-1", "CANCELLED", cancelledHarness.admin.id, "取消测试");
    await expect(cancelledHarness.service.assertReadyForStage2Pdf(cancelledHarness.orderId)).rejects.toThrow("交付工单已终止");
  });

  it("keeps field completion tied to customer signing and delivery confirmation tied to completed Stage 2 signing", async () => {
    const harness = createConfirmedWorkOrderHarness();

    await expect(harness.service.assertDeliveryCanBeConfirmed(harness.orderId)).rejects.toThrow(BadRequestException);

    await harness.service.markCustomerSigned("work-order-1", new Date("2026-07-21T04:10:00.000Z"), harness.admin.id);
    expect(harness.state.workOrders[0]!).toMatchObject({
      fieldCompletedAt: expect.any(Date),
      status: "CUSTOMER_SIGNED"
    });
    await expect(harness.service.assertDeliveryCanBeConfirmed(harness.orderId)).rejects.toThrow(BadRequestException);

    harness.state.handover.status = "SIGNED";
    harness.state.handover.archiveStatus = "FAILED";
    await harness.service.markPlatformSealed("work-order-1", new Date("2026-07-21T04:12:00.000Z"), harness.admin.id);
    await expect(harness.service.assertDeliveryCanBeConfirmed(harness.orderId)).resolves.toBeUndefined();
  });
});

function createReadyForCustomerReviewHarness() {
  const harness = createHandoverWorkOrderHarness();
  harness.state.workOrders.push({
    ...baseWorkOrder(harness),
    accessoryChecklist: { chargingCable: true, keys: 2 },
    energyLevelText: "80%",
    fieldSubmittedAt: harness.now,
    handoverMileageKm: 28500,
    noVisibleDamageDeclared: true,
    status: "CUSTOMER_REVIEWING"
  });
  return harness;
}

function createConfirmedWorkOrderHarness() {
  const harness = createReadyForCustomerReviewHarness();
  Object.assign(harness.state.workOrders[0]!, {
    customerConfirmedAt: harness.now,
    status: "CUSTOMER_CONFIRMED"
  });
  return harness;
}

function baseWorkOrder(harness: ReturnType<typeof createHandoverWorkOrderHarness>) {
  return {
    accessTokenExpiresAt: null,
    accessTokenHash: null,
    accessTokenRevokedAt: null,
    accessoryChecklist: null,
    assignedInternalUserId: null,
    createdAt: harness.now,
    customerConfirmedAt: null,
    customerObjectedAt: null,
    customerObjectionReason: null,
    customerReviewStartedAt: null,
    damageDeclared: null,
    deliveryLocation: null,
    energyLevelText: null,
    externalOperatorName: null,
    externalOperatorOrganization: null,
    externalOperatorPhone: null,
    fieldCompletedAt: null,
    fieldNotes: null,
    fieldStartedAt: null,
    fieldSubmittedAt: null,
    firstAccessedAt: null,
    fuelLevelText: null,
    handoverId: "handover-1",
    handoverMileageKm: null,
    handoverType: "DELIVERY_OUTBOUND",
    id: "work-order-1",
    lastAccessedAt: null,
    metadata: null,
    noVisibleDamageDeclared: null,
    operatorType: "INTERNAL",
    opsReviewNotes: null,
    opsReviewStatus: "NOT_REQUIRED",
    opsReviewedAt: null,
    opsReviewedBy: null,
    orderId: harness.orderId,
    scheduledAt: null,
    status: "DRAFT",
    updatedAt: harness.now,
    vehicleDeliveryId: "delivery-1"
  };
}

function createHandoverWorkOrderHarness() {
  const now = new Date("2026-07-21T08:00:00.000Z");
  const orderId = "order-1";
  const admin = { id: "admin-1" };
  const internalUser = { id: "user-field-1" };
  const state = {
    handover: {
      archiveStatus: "NOT_STARTED",
      deletedAt: null,
      id: "handover-1",
      orderId,
      signedObjectKey: null,
      status: "DRAFT",
      vehicleDeliveryId: "delivery-1"
    },
    order: {
      contract: {
        deletedAt: null,
        id: "contract-stage1",
        status: ContractStatus.SIGNED
      },
      contractId: "contract-stage1",
      customer: {
        id: "customer-1",
        idCardNo: "TEST_ID_CARD_SHOULD_NOT_LEAK",
        mobile: "18616570212",
        name: "李柯"
      },
      customerId: "customer-1",
      deletedAt: null,
      id: orderId,
      monthlyFeeAmount: 399900n,
      orderNo: "ORD202607210001",
      vehicle: {
        brand: "Tesla",
        deletedAt: null,
        id: "vehicle-1",
        model: "Model 3",
        plateNo: "沪A12345",
        vin: "LFPH3AC12N123888888"
      },
      vehicleId: "vehicle-1"
    },
    users: [
      { deletedAt: null, id: admin.id, name: "管理员" },
      { deletedAt: null, id: internalUser.id, name: "内部交付员" }
    ],
    vehicleDelivery: {
      deletedAt: null,
      deliveryLocation: "上海市测试交付点",
      id: "delivery-1",
      orderId,
      scheduledAt: new Date("2026-07-22T02:00:00.000Z")
    },
    workOrders: [] as Array<Record<string, unknown>>
  };
  const evidenceService = createEvidenceService();
  const handoverService = {
    getOrCreateDraftHandover: vi.fn(async () => state.handover),
    isDeliveryReady: vi.fn(),
    assertDeliveryCanBeConfirmed: vi.fn(async () => {
      if (state.handover.status !== "SIGNED" && state.handover.status !== "ARCHIVED") {
        throw new BadRequestException("交付交接确认书尚未完成签署。");
      }
    })
  };
  const prisma = {
    subscriptionOrder: {
      findFirst: vi.fn(async () => state.order),
      findUnique: vi.fn(async () => state.order)
    },
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
        state.users.find((user) => user.id === where.id && user.deletedAt === null) ?? null
      )
    },
    vehicleDelivery: {
      findUnique: vi.fn(async () => state.vehicleDelivery)
    },
    vehicleHandoverWorkOrder: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const workOrder = {
          ...baseWorkOrder({ now, orderId } as ReturnType<typeof createHandoverWorkOrderHarness>),
          ...data,
          id: `work-order-${state.workOrders.length + 1}`
        };
        state.workOrders.push(workOrder);
        return workOrder;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.workOrders.find((workOrder) => matchesWorkOrderWhere(workOrder, where)) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.workOrders.filter((workOrder) => matchesWorkOrderWhere(workOrder, where))
      ),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        state.workOrders.find((workOrder) => workOrder.id === where.id) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id?: string } }) => {
        const workOrder = state.workOrders.find((row) => row.id === where.id);
        if (!workOrder) {
          throw new Error("work order not found");
        }
        Object.assign(workOrder, data, { updatedAt: now });
        return workOrder;
      })
    }
  };
  const service = new HandoverWorkOrderService(prisma as never, evidenceService as never, handoverService as never);

  return {
    admin,
    evidenceService,
    handoverService,
    internalUser,
    now,
    orderId,
    prisma,
    service,
    state
  };
}

function createEvidenceService() {
  let fieldComplete = true;
  let checklist: Record<string, unknown> = {
    blockingReasons: [],
    items: [
      {
        evidenceType: "VEHICLE_FRONT",
        files: [{ id: "evidence-file-default", objectKey: "oss/internal/evidence.jpg" }],
        id: "evidence-item-default",
        isRequired: true,
        reviewStatus: "PENDING",
        status: "UPLOADED",
        title: "车辆车头正面"
      },
      {
        evidenceType: "VEHICLE_REAR",
        files: [],
        id: "evidence-item-missing",
        isRequired: true,
        reviewStatus: "NOT_STARTED",
        status: "NOT_STARTED",
        title: "车辆车尾正面"
      }
    ],
    ready: false
  };
  return {
    assertFieldEvidenceComplete: vi.fn(async () => {
      if (!fieldComplete) {
        throw new BadRequestException("证据尚未完整");
      }
    }),
    getChecklist: vi.fn(async () => checklist),
    initializeChecklist: vi.fn(async () => ({ items: [] })),
    setChecklist(value: Record<string, unknown>) {
      checklist = value;
    },
    setFieldComplete(value: boolean) {
      fieldComplete = value;
    }
  };
}

function matchesWorkOrderWhere(workOrder: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") {
      return (expected as Array<Record<string, unknown>>).some((branch) => matchesWorkOrderWhere(workOrder, branch));
    }
    if (key === "id") {
      return workOrder.id === expected;
    }
    if (key === "orderId") {
      return workOrder.orderId === expected;
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
    if (key === "accessTokenExpiresAt" && expected && typeof expected === "object" && "gt" in expected) {
      const expiresAt = workOrder.accessTokenExpiresAt as Date | null | undefined;
      return Boolean(expiresAt && expiresAt.getTime() > (expected.gt as Date).getTime());
    }
    if (key === "accessTokenHash") {
      return workOrder.accessTokenHash === expected;
    }
    if (key === "status" && expected && typeof expected === "object" && "notIn" in expected) {
      return !(expected.notIn as unknown[]).includes(workOrder.status);
    }
    if (key === "handoverType") {
      return workOrder.handoverType === expected;
    }
    return true;
  });
}
