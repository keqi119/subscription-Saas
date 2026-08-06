import {
  BillingScheduleStatus,
  ContractSegmentStatus,
  EntitlementAccountStatus,
  LeaseStatus,
  OrderStatus,
  RenewalConsiderationStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType,
  SubscriptionChangeStatus,
  VehicleReturnStatus,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionExpiryService } from "../src/subscription-change/subscription-expiry.service";

describe("SubscriptionExpiryService", () => {
  it("moves an unsigned expiring subscription to return due without touching existing money or mandate facts", async () => {
    const harness = createExpiryHarness();

    await expect(
      harness.service.expireSegment("segment-active", new Date("2026-09-02T16:00:00.000Z"))
    ).resolves.toEqual({ outcome: "EXPIRED", returnId: "return-1" });

    expect(harness.state.segment.status).toBe(ContractSegmentStatus.COMPLETED);
    expect(harness.state.consideration.status).toBe(RenewalConsiderationStatus.EXPIRED);
    expect(harness.state.change.status).toBe(SubscriptionChangeStatus.FAILED);
    expect(harness.state.change.failureCode).toBe("EXTENSION_DEADLINE_MISSED");
    expect(harness.state.order.orderStatus).toBe(OrderStatus.PENDING_RETURN);
    expect(harness.state.lease.status).toBe(LeaseStatus.RETURN_DUE);
    expect(harness.state.vehicle.status).toBe(VehicleStatus.LEASED);
    expect(harness.state.schedule.status).toBe(BillingScheduleStatus.COMPLETED);
    expect(harness.state.account.accountStatus).toBe(EntitlementAccountStatus.CLOSED);
    expect(harness.state.vehicleReturn).toMatchObject({
      orderId: "order-1",
      returnStatus: VehicleReturnStatus.PENDING,
      vehicleId: "vehicle-1"
    });
    expect(harness.state.mandate).toEqual({ id: "mandate-1", status: "ACTIVE" });
    expect(harness.state.bill).toEqual({ id: "bill-1", remainingAmount: 100n });
    expect(harness.state.collectionCase).toEqual({ id: "collection-1", status: "ACTIVE" });
    expect(harness.cancelledJobsWhere[0]).toMatchObject({
      billId: null,
      jobStatus: {
        in: expect.arrayContaining([
          SubscriptionAutomationJobStatus.PENDING,
          SubscriptionAutomationJobStatus.PROCESSING
        ])
      },
      jobType: {
        in: expect.arrayContaining([
          SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE,
          SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW
        ])
      },
      orderId: "order-1"
    });
    expect(harness.cancelledJobsWhere[1]).toMatchObject({
      billId: null,
      jobType: SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
      orderId: "order-1",
      payload: { path: ["periodStart"], gt: "2026-09-02" }
    });
    expect(harness.notifications.notifyRenewalExpiryInApp).toHaveBeenCalledTimes(1);
  });

  it("arbitrates expiry with the locked database clock instead of the process clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T15:50:00.000Z"));
    try {
      const harness = createExpiryHarness({
        databaseNow: new Date("2026-09-02T16:00:00.000Z")
      });

      await expect(harness.service.expireSegment("segment-active")).resolves.toEqual({
        outcome: "EXPIRED",
        returnId: "return-1"
      });
      expect(harness.state.segment.completedAt).toEqual(new Date("2026-09-02T16:00:00.000Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires an unanswered consideration even when there is no active renewal attempt", async () => {
    const harness = createExpiryHarness({
      changeStatus: SubscriptionChangeStatus.CANCELLED,
      considerationStatus: RenewalConsiderationStatus.PENDING_DECISION
    });

    await expect(
      harness.service.expireSegment("segment-active", new Date("2026-09-02T16:00:00.000Z"))
    ).resolves.toEqual({ outcome: "EXPIRED", returnId: "return-1" });

    expect(harness.state.consideration.status).toBe(RenewalConsiderationStatus.EXPIRED);
    expect(harness.state.change.status).toBe(SubscriptionChangeStatus.CANCELLED);
    expect(harness.state.order.orderStatus).toBe(OrderStatus.PENDING_RETURN);
  });

  it("fails a manual-takeover renewal attempt when the original segment expires", async () => {
    const harness = createExpiryHarness({
      changeStatus: SubscriptionChangeStatus.MANUAL_TAKEOVER
    });

    await harness.service.expireSegment("segment-active", new Date("2026-09-02T16:00:00.000Z"));

    expect(harness.state.change).toMatchObject({
      failureCode: "EXTENSION_DEADLINE_MISSED",
      status: SubscriptionChangeStatus.FAILED
    });
  });

  it("keeps an earned final rent cycle active while cancelling only post-expiry cycles", async () => {
    const harness = createExpiryHarness({
      nextPeriodStart: new Date("2026-08-02T00:00:00.000Z")
    });

    await harness.service.expireSegment("segment-active", new Date("2026-09-02T16:00:00.000Z"));

    expect(harness.state.schedule.status).toBe(BillingScheduleStatus.ACTIVE);
    expect(harness.cancelledJobsWhere[1]).toMatchObject({
      jobType: SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
      payload: { path: ["periodStart"], gt: "2026-09-02" }
    });
  });

  it("lets a previously committed scheduled extension win the deadline race", async () => {
    const harness = createExpiryHarness({
      nextSegment: {
        id: "segment-extension",
        startDate: new Date("2026-09-03T00:00:00.000Z"),
        status: ContractSegmentStatus.SCHEDULED
      }
    });

    await expect(
      harness.service.expireSegment("segment-active", new Date("2026-09-02T16:00:00.000Z"))
    ).resolves.toEqual({ outcome: "EXTENDED" });

    expect(harness.state.order.orderStatus).toBe(OrderStatus.ACTIVE);
    expect(harness.state.vehicleReturn).toBeNull();
    expect(harness.notifications.notifyRenewalExpiryInApp).not.toHaveBeenCalled();
  });

  it("is idempotent after the expiry transaction has already created the return", async () => {
    const harness = createExpiryHarness();
    const now = new Date("2026-09-02T16:00:00.000Z");

    await harness.service.expireSegment("segment-active", now);
    await expect(harness.service.expireSegment("segment-active", now)).resolves.toEqual({
      outcome: "DUPLICATE",
      returnId: "return-1"
    });

    expect(harness.vehicleReturnCreate).toHaveBeenCalledTimes(1);
    expect(harness.notifications.notifyRenewalExpiryInApp).toHaveBeenCalledTimes(2);
  });

  it("creates only one D+1 return-overdue notice and never creates a fee", async () => {
    const harness = createExpiryHarness();
    const now = new Date("2026-09-03T16:00:00.000Z");
    harness.state.order.orderStatus = OrderStatus.PENDING_RETURN;
    harness.state.vehicleReturn = {
      id: "return-1",
      returnStatus: VehicleReturnStatus.PENDING,
      returnedAt: null
    };

    await expect(harness.service.flagOverdueReturn("order-1", now)).resolves.toEqual({
      created: true
    });
    await expect(harness.service.flagOverdueReturn("order-1", now)).resolves.toEqual({
      created: false
    });

    expect(harness.notifications.notifyRenewalReturnOverdueInApp).toHaveBeenCalledTimes(2);
    expect(harness.receivableBillCreate).not.toHaveBeenCalled();
  });
});

function createExpiryHarness(
  options: {
    changeStatus?: SubscriptionChangeStatus;
    considerationStatus?: RenewalConsiderationStatus;
    databaseNow?: Date;
    nextSegment?: Record<string, unknown> | null;
    nextPeriodStart?: Date;
  } = {}
) {
  const cancelledJobsWhere: Array<Record<string, unknown>> = [];
  const state = {
    account: { accountStatus: EntitlementAccountStatus.ACTIVE, id: "account-1" },
    bill: { id: "bill-1", remainingAmount: 100n },
    change: {
      failureCode: null as string | null,
      failureMessage: null as string | null,
      id: "change-1",
      status: options.changeStatus ?? SubscriptionChangeStatus.SIGNING_OR_PAYMENT
    },
    collectionCase: { id: "collection-1", status: "ACTIVE" },
    consideration: {
      id: "consideration-1",
      status: options.considerationStatus ?? RenewalConsiderationStatus.EXTENSION_IN_PROGRESS,
      version: 2
    },
    lease: { id: "lease-1", status: LeaseStatus.ACTIVE },
    mandate: { id: "mandate-1", status: "ACTIVE" },
    order: {
      customerId: "customer-1",
      id: "order-1",
      orderNo: "ORD-1",
      orderStatus: OrderStatus.ACTIVE as OrderStatus,
      vehicleId: "vehicle-1"
    },
    schedule: {
      id: "schedule-1",
      nextPeriodStart: options.nextPeriodStart ?? new Date("2026-10-02T00:00:00.000Z"),
      status: BillingScheduleStatus.ACTIVE,
      version: 1
    },
    segment: {
      completedAt: null as Date | null,
      endDate: new Date("2026-09-02T00:00:00.000Z"),
      id: "segment-active",
      orderId: "order-1",
      status: ContractSegmentStatus.ACTIVE
    },
    vehicle: { id: "vehicle-1", status: VehicleStatus.LEASED },
    vehicleReturn: null as Record<string, unknown> | null
  };
  const vehicleReturnCreate = vi.fn(async ({ data }) => {
    state.vehicleReturn = { ...data, id: "return-1" };
    return state.vehicleReturn;
  });
  const receivableBillCreate = vi.fn();
  const tx = {
    $queryRaw: vi.fn(async (query: { strings?: readonly string[] }) =>
      query.strings?.join(" ").includes("clock_timestamp")
        ? [{ now: options.databaseNow ?? new Date("2026-09-02T16:00:00.000Z") }]
        : [{ id: "locked" }]
    ),
    billingSchedule: {
      findUnique: vi.fn(async () => state.schedule),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(state.schedule, data, { version: state.schedule.version + 1 });
        return { count: 1 };
      })
    },
    lease: {
      findUnique: vi.fn(async () => state.lease),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(state.lease, data);
        return { count: 1 };
      })
    },
    orderEntitlementAccount: {
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(state.account, data);
        return { count: 1 };
      })
    },
    receivableBill: { create: receivableBillCreate },
    renewalConsideration: {
      findUnique: vi.fn(async () => state.consideration),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(state.consideration, data, { version: state.consideration.version + 1 });
        return { count: 1 };
      })
    },
    subscriptionAutomationJob: {
      updateMany: vi.fn(async ({ where }) => {
        cancelledJobsWhere.push(where);
        return { count: 3 };
      })
    },
    subscriptionChangeOrder: {
      findFirst: vi.fn(async () => state.change),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(state.change, data);
        return { count: 1 };
      })
    },
    subscriptionContractSegment: {
      findFirst: vi.fn(async () => options.nextSegment ?? null),
      findUnique: vi.fn(async () => state.segment),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(state.segment, data);
        return { count: 1 };
      })
    },
    subscriptionOrder: {
      findUnique: vi.fn(async () => state.order),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(state.order, data);
        return { count: 1 };
      })
    },
    vehicleReturn: {
      create: vehicleReturnCreate,
      findUnique: vi.fn(async () => state.vehicleReturn),
      update: vi.fn(async ({ data }) => {
        Object.assign(state.vehicleReturn!, data);
        return state.vehicleReturn;
      })
    }
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    subscriptionContractSegment: {
      findFirst: vi.fn(async () => state.segment)
    },
    subscriptionOrder: { findUnique: vi.fn(async () => state.order) },
    vehicleReturn: { findUnique: vi.fn(async () => state.vehicleReturn) }
  };
  const notifications = {
    notifyRenewalExpiryInApp: vi.fn(async () => ({ id: "notice-expiry" })),
    notifyRenewalReturnOverdueInApp: vi
      .fn()
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: false })
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const service = new SubscriptionExpiryService(
    prisma as never,
    notifications as never,
    auditService as never
  );
  return {
    auditService,
    cancelledJobsWhere,
    notifications,
    prisma,
    receivableBillCreate,
    service,
    state,
    vehicleReturnCreate
  };
}
