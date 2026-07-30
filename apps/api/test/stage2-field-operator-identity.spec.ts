import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";

const MATCHING_PHONE = "13800000000";

describe("Stage 2 canonical Field operator identity", () => {
  it("snapshots internal User.name and User.mobile during internal assignment", async () => {
    const harness = createIdentityHarness();

    const assigned = await harness.service.assignInternalOperator(
      harness.workOrder.id,
      harness.user.id,
      "admin-1"
    );

    expect(assigned).toMatchObject({
      assignedInternalUserId: harness.user.id,
      externalOperatorName: null,
      externalOperatorPhone: null,
      fieldOperatorName: "Internal Operator",
      fieldOperatorPhone: MATCHING_PHONE,
      operatorType: "INTERNAL",
      reviewVersion: 1
    });
  });

  it.each([
    ["missing", null],
    ["invalid", "021-12345678"]
  ])("rejects internal assignment when the User has a %s mainland mobile", async (_case, mobile) => {
    const harness = createIdentityHarness({ user: { mobile } });

    await expect(
      harness.service.assignInternalOperator(harness.workOrder.id, harness.user.id, "admin-1")
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.prisma.vehicleHandoverWorkOrder.updateMany).not.toHaveBeenCalled();
  });

  it("rejects disabled internal users through the safe assignment error", async () => {
    const harness = createIdentityHarness({ user: { status: "DISABLED" } });

    await expect(
      harness.service.assignInternalOperator(harness.workOrder.id, harness.user.id, "admin-1")
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.prisma.vehicleHandoverWorkOrder.updateMany).not.toHaveBeenCalled();
  });

  it("snapshots registered external name and phone during external assignment", async () => {
    const harness = createIdentityHarness();

    const result = await harness.service.assignExternalOperator(
      harness.workOrder.id,
      {
        name: " Registered Operator ",
        organization: "Partner",
        phone: "+86 139-0000-1111"
      },
      "admin-1"
    );

    expect(result.workOrder).toMatchObject({
      assignedInternalUserId: null,
      externalOperatorName: "Registered Operator",
      externalOperatorPhone: "13900001111",
      fieldOperatorName: "Registered Operator",
      fieldOperatorPhone: "13900001111",
      operatorType: "EXTERNAL",
      reviewVersion: 1
    });
  });

  it("lists both internal and external tasks for the matching canonical phone", async () => {
    const harness = createIdentityHarness({
      workOrders: [
        workOrder({
          fieldOperatorName: "Internal Operator",
          fieldOperatorPhone: MATCHING_PHONE,
          id: "work-order-internal",
          operatorType: "INTERNAL"
        }),
        workOrder({
          accessTokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
          assignedInternalUserId: null,
          externalOperatorName: "External Operator",
          externalOperatorPhone: MATCHING_PHONE,
          fieldOperatorName: "External Operator",
          fieldOperatorPhone: MATCHING_PHONE,
          id: "work-order-external",
          operatorType: "EXTERNAL"
        })
      ]
    });

    const tasks = await harness.service.listFieldAccessibleWorkOrders("+86 138-0000-0000");

    expect(tasks.map((task) => task.id).sort()).toEqual([
      "work-order-external",
      "work-order-internal"
    ]);
    expect(harness.prisma.vehicleHandoverWorkOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fieldOperatorPhone: MATCHING_PHONE
        })
      })
    );
  });

  it("does not authorize a legacy phone when the canonical phone differs", async () => {
    const harness = createIdentityHarness({
      workOrders: [
        workOrder({
          assignedInternalUserId: null,
          externalOperatorPhone: MATCHING_PHONE,
          fieldOperatorPhone: "13900001111",
          operatorType: "EXTERNAL"
        })
      ]
    });

    await expect(
      harness.service.getFieldAccessibleWorkOrder(harness.workOrder.id, MATCHING_PHONE)
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("authorizes INTERNAL task detail and mutation by matching canonical phone", async () => {
    const harness = createIdentityHarness({
      workOrders: [
        workOrder({
          fieldOperatorName: "Internal Operator",
          fieldOperatorPhone: MATCHING_PHONE,
          operatorType: "INTERNAL"
        })
      ]
    });

    await expect(
      harness.service.getFieldAccessibleWorkOrder(
        harness.workOrder.id,
        "+86 138-0000-0000"
      )
    ).resolves.toMatchObject({ id: harness.workOrder.id });
    await expect(
      harness.service.startFieldAccessibleWorkOrder(
        harness.workOrder.id,
        "+86 138-0000-0000",
        "session-1"
      )
    ).resolves.toMatchObject({
      fieldOperatorPhone: MATCHING_PHONE,
      operatorType: "INTERNAL",
      status: "FIELD_IN_PROGRESS"
    });
  });

  it("denies INTERNAL task detail and mutation for a nonmatching canonical phone", async () => {
    const harness = createIdentityHarness({
      workOrders: [
        workOrder({
          fieldOperatorName: "Internal Operator",
          fieldOperatorPhone: MATCHING_PHONE,
          operatorType: "INTERNAL"
        })
      ]
    });

    await expect(
      harness.service.getFieldAccessibleWorkOrder(harness.workOrder.id, "13900001111")
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      harness.service.startFieldAccessibleWorkOrder(
        harness.workOrder.id,
        "13900001111",
        "session-1"
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(harness.prisma.vehicleHandoverWorkOrder.updateMany).not.toHaveBeenCalled();
  });

  it("rejects reassignment after customerReviewStartedAt is set", async () => {
    const harness = createIdentityHarness({
      workOrders: [
        workOrder({
          customerReviewStartedAt: new Date("2026-07-27T08:00:00.000Z"),
          status: "CUSTOMER_REVIEWING"
        })
      ]
    });

    await expect(
      harness.service.assignInternalOperator(harness.workOrder.id, harness.user.id, "admin-1")
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      harness.service.assignExternalOperator(
        harness.workOrder.id,
        { name: "Replacement", phone: "13900001111" },
        "admin-1"
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.prisma.vehicleHandoverWorkOrder.updateMany).not.toHaveBeenCalled();
  });

  it("rejects reassignment when the current review attempt has started customer review", async () => {
    const harness = createIdentityHarness({
      reviewAttempts: [
        {
          attemptNo: 1,
          customerReviewStartedAt: new Date("2026-07-27T08:00:00.000Z"),
          id: "review-attempt-1",
          workOrderId: "work-order-1"
        }
      ]
    });

    await expect(
      harness.service.assignInternalOperator(harness.workOrder.id, harness.user.id, "admin-1")
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.prisma.vehicleHandoverWorkOrder.updateMany).not.toHaveBeenCalled();
  });
});

function createIdentityHarness(
  options: {
    reviewAttempts?: Array<Record<string, unknown>>;
    user?: { mobile?: string | null; name?: string; status?: string };
    workOrders?: TestWorkOrder[];
  } = {}
) {
  const user = {
    deletedAt: null,
    id: "user-1",
    mobile: MATCHING_PHONE,
    name: "Internal Operator",
    status: "ACTIVE",
    ...options.user
  };
  const workOrders = options.workOrders ?? [workOrder()];
  const reviewAttempts = options.reviewAttempts ?? [];
  const events: Array<Record<string, unknown>> = [];
  const order = {
    customer: { mobile: "18600000212", name: "Customer" },
    customerId: "customer-1",
    deletedAt: null,
    id: "order-1",
    orderNo: "SO-1",
    vehicle: {
      brand: "Brand",
      model: "Model",
      plateNo: "沪A12345",
      vin: "LSVTEST0000000001"
    }
  };

  const prisma = {
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(prisma),
    subscriptionOrder: {
      findUnique: vi.fn(async () => order)
    },
    user: {
      findFirst: vi.fn(async ({
        where
      }: {
        where: { deletedAt: null; id: string; status?: string };
      }) => (
        where.id === user.id &&
        user.deletedAt === where.deletedAt &&
        (where.status === undefined || user.status === where.status)
          ? user
          : null
      ))
    },
    vehicleHandoverEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const event = { id: `event-${events.length + 1}`, ...data };
        events.push(event);
        return event;
      })
    },
    vehicleHandoverReviewAttempt: {
      findFirst: vi.fn(async ({ where }: { where: { workOrderId: string } }) =>
        reviewAttempts
          .filter((attempt) => attempt.workOrderId === where.workOrderId)
          .sort((left, right) => Number(right.attemptNo) - Number(left.attemptNo))[0] ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: { workOrderId: string } }) =>
        reviewAttempts.filter((attempt) => attempt.workOrderId === where.workOrderId)
      )
    },
    vehicleHandoverWorkOrder: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        workOrders.find((candidate) => matchesWorkOrderWhere(candidate, where)) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        workOrders.filter((candidate) => matchesWorkOrderWhere(candidate, where))
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        workOrders.find((candidate) => candidate.id === where.id) ?? null
      ),
      updateMany: vi.fn(async ({
        data,
        where
      }: {
        data: Record<string, unknown>;
        where: { id: string; reviewVersion: number };
      }) => {
        const candidate = workOrders.find(
          (item) => item.id === where.id && item.reviewVersion === where.reviewVersion
        );
        if (!candidate) {
          return { count: 0 };
        }
        applyUpdate(candidate, data);
        return { count: 1 };
      })
    }
  };
  const evidenceService = {
    getChecklist: vi.fn(async () => ({ items: [] }))
  };
  const service = new HandoverWorkOrderService(prisma as never, evidenceService as never);

  return {
    events,
    prisma,
    reviewAttempts,
    service,
    user,
    workOrder: workOrders[0]!,
    workOrders
  };
}

function workOrder(overrides: Partial<TestWorkOrder> = {}): TestWorkOrder {
  return {
    accessTokenExpiresAt: null,
    accessTokenRevokedAt: null,
    assignedInternalUserId: "user-1",
    createdAt: new Date("2026-07-27T07:00:00.000Z"),
    customerReviewStartedAt: null,
    externalOperatorName: null,
    externalOperatorPhone: null,
    fieldOperatorName: null,
    fieldOperatorPhone: null,
    handoverId: "handover-1",
    handoverType: "DELIVERY_OUTBOUND",
    id: "work-order-1",
    metadata: null,
    operatorType: "INTERNAL",
    orderId: "order-1",
    reviewVersion: 0,
    scheduledAt: new Date("2026-07-28T02:00:00.000Z"),
    status: "ASSIGNED",
    ...overrides
  };
}

function matchesWorkOrderWhere(candidate: TestWorkOrder, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") {
      return (expected as Array<Record<string, unknown>>).some((branch) =>
        matchesWorkOrderWhere(candidate, branch)
      );
    }
    if (key === "status" && isRecord(expected) && Array.isArray(expected.notIn)) {
      return !expected.notIn.includes(candidate.status);
    }
    if (
      key === "accessTokenExpiresAt" &&
      isRecord(expected) &&
      expected.gt instanceof Date
    ) {
      return candidate.accessTokenExpiresAt instanceof Date &&
        candidate.accessTokenExpiresAt.getTime() > expected.gt.getTime();
    }
    return candidate[key] === expected;
  });
}

function applyUpdate(target: TestWorkOrder, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (isRecord(value) && typeof value.increment === "number") {
      target[key] = Number(target[key] ?? 0) + value.increment;
      continue;
    }
    target[key] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface TestWorkOrder extends Record<string, unknown> {
  accessTokenExpiresAt: Date | null;
  accessTokenRevokedAt: Date | null;
  assignedInternalUserId: string | null;
  createdAt: Date;
  customerReviewStartedAt: Date | null;
  externalOperatorName: string | null;
  externalOperatorPhone: string | null;
  fieldOperatorName: string | null;
  fieldOperatorPhone: string | null;
  handoverId: string;
  handoverType: string;
  id: string;
  metadata: unknown;
  operatorType: string;
  orderId: string;
  reviewVersion: number;
  scheduledAt: Date;
  status: string;
}
