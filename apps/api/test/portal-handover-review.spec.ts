import { BadRequestException, ExecutionContext, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";

import { DeliveryEvidenceService } from "../src/delivery-evidence/delivery-evidence.service";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
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
          file: expect.objectContaining({ id: "file-1" })
        })
      ]
    });
    expect(serialized).not.toContain("oss/private");
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain("SYNTHETIC_ID_SHOULD_NOT_LEAK");
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

    const detail = await harness.service.confirmNoObjection(
      "work-order-1",
      { acknowledgement: true },
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
    expectNoStage2SideEffects(harness);
  });

  it("blocks confirmation before field evidence is submitted", async () => {
    const harness = createPortalReviewHarness();
    harness.state.workOrders.push(completeReviewWorkOrder(harness, { status: "FIELD_IN_PROGRESS" }));

    await expect(
      harness.service.confirmNoObjection("work-order-1", {}, currentCustomer("customer-1"))
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
      harness.service.confirmNoObjection("work-order-1", {}, currentCustomer("customer-1"))
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
      objectedHarness.service.confirmNoObjection("work-order-1", {}, currentCustomer("customer-1"))
    ).rejects.toThrow("客户已提交异议");

    const unrelatedHarness = createPortalReviewHarness();
    unrelatedHarness.state.workOrders.push(completeReviewWorkOrder(unrelatedHarness));
    await expect(
      unrelatedHarness.service.confirmNoObjection("work-order-1", {}, currentCustomer("customer-other"))
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

function createPortalReviewHarness() {
  const now = new Date("2026-07-22T08:00:00.000Z");
  const orderId = "order-1";
  const state = {
    evidenceChecklist: completeEvidenceChecklist(now),
    evidenceComplete: true,
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
    workOrders: [] as Array<Record<string, unknown>>
  };

  const prisma = {
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
      })
    }
  };

  const evidenceService = {
    assertFieldEvidenceComplete: vi.fn(async () => {
      if (!state.evidenceComplete) {
        throw new BadRequestException("证据尚未完整");
      }
    }),
    getChecklist: vi.fn(async () => state.evidenceChecklist)
  } as unknown as DeliveryEvidenceService;
  const handoverWorkOrderService = new HandoverWorkOrderService(prisma as never, evidenceService);
  const service = new PortalHandoverReviewService(prisma as never, evidenceService, handoverWorkOrderService);

  return {
    handoverWorkOrderService,
    now,
    orderId,
    prisma,
    service,
    state
  };
}

function completeReviewWorkOrder(
  harness: ReturnType<typeof createPortalReviewHarness>,
  overrides: Record<string, unknown> = {}
) {
  return {
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
    order
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
