import {
  BillingScheduleStatus,
  ContractSegmentStatus,
  ContractSegmentType,
  LeaseStatus,
  OrderStatus,
  SubscriptionChangeStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { BillingAutomationService } from "../src/billing-automation/billing-automation.service";
import {
  billingSourceKey,
  buildBillingCycleForDelivery
} from "../src/billing-automation/billing-automation.calendar";
import { ContractSegmentError } from "../src/subscription-change/subscription-change.errors";

describe("BillingAutomationService contract segment billing", () => {
  it("uses BASE segment terms before an extension starts", async () => {
    const harness = createHarness({
      effectiveEndDate: date("2027-03-02"),
      segment: segmentTerms({
        monthlyFeeAmount: 7_700n,
        segmentId: "segment-base"
      })
    });

    await harness.service.generateScheduledMonthlyRent(harness.job);

    expect(harness.finance.generateMonthlyRentBillForCycle).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        contractSegmentId: "segment-base",
        monthlyRentAmount: 7_700n
      })
    );
  });

  it("uses the segment amount and identity without changing the existing source key", async () => {
    const harness = createHarness({
      effectiveEndDate: date("2027-03-02"),
      segment: segmentTerms({
        endDate: date("2027-03-02"),
        monthlyFeeAmount: 8_800n,
        segmentId: "segment-extension",
        startDate: date("2026-07-10")
      })
    });

    const result = await harness.service.generateScheduledMonthlyRent(harness.job);

    expect(result).toMatchObject({
      created: true,
      sourceKey: billingSourceKey("order-1", harness.cycle.periodStart)
    });
    expect(harness.finance.generateMonthlyRentBillForCycle).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        contractSegmentId: "segment-extension",
        monthlyRentAmount: 8_800n,
        sourceKey: "monthly-rent:order-1:2026-07-10"
      })
    );
  });

  it("completes the schedule without a bill after the effective segment end", async () => {
    const harness = createHarness({ effectiveEndDate: date("2026-07-09") });

    await expect(harness.service.generateScheduledMonthlyRent(harness.job)).resolves.toMatchObject({
      completed: true,
      created: false
    });

    expect(harness.finance.generateMonthlyRentBillForCycle).not.toHaveBeenCalled();
    expect(harness.schedule.status).toBe(BillingScheduleStatus.COMPLETED);
  });

  it("pauses billing and moves the extension to manual takeover when a cycle crosses segments", async () => {
    const harness = createHarness({
      effectiveEndDate: date("2027-03-02"),
      segmentError: new ContractSegmentError("BILLING_PERIOD_CROSSES_SEGMENT", "crosses segment", {
        changeOrderId: "change-extension",
        segmentId: "segment-base"
      })
    });

    await expect(harness.service.generateScheduledMonthlyRent(harness.job)).rejects.toMatchObject({
      code: "BILLING_PERIOD_CROSSES_SEGMENT",
      retryable: false
    });

    expect(harness.schedule).toMatchObject({
      pauseReason: "BILLING_PERIOD_CROSSES_SEGMENT",
      status: BillingScheduleStatus.PAUSED
    });
    expect(harness.change).toMatchObject({
      failureCode: "BILLING_PERIOD_CROSSES_SEGMENT",
      failureMessage: "The monthly billing period crosses a contract segment boundary.",
      status: SubscriptionChangeStatus.MANUAL_TAKEOVER
    });
  });

  it("reactivates a completed schedule for an extension without changing its cycle anchor", async () => {
    const harness = createHarness({
      effectiveEndDate: date("2027-03-02"),
      scheduleStatus: BillingScheduleStatus.COMPLETED,
      segment: segmentTerms({
        endDate: date("2027-03-02"),
        monthlyFeeAmount: 8_800n,
        segmentId: "segment-extension",
        startDate: date("2026-09-03")
      })
    });
    const before = {
      nextCycleNo: harness.schedule.nextCycleNo,
      nextGenerateAt: harness.schedule.nextGenerateAt,
      nextPeriodEnd: harness.schedule.nextPeriodEnd,
      nextPeriodStart: harness.schedule.nextPeriodStart
    };

    const resumed = await harness.service.resumeForExtension(
      "order-1",
      "segment-extension",
      date("2026-08-20")
    );

    expect(resumed).toMatchObject({
      ...before,
      completedAt: null,
      status: BillingScheduleStatus.ACTIVE
    });
  });
});

function createHarness(
  options: {
    effectiveEndDate?: Date;
    scheduleStatus?: BillingScheduleStatus;
    segment?: ReturnType<typeof segmentTerms>;
    segmentError?: ContractSegmentError;
  } = {}
) {
  const now = date("2026-07-07");
  const actualDeliveryAt = new Date("2026-06-10T02:00:00.000Z");
  const cycle = buildBillingCycleForDelivery(actualDeliveryAt, 1);
  const order = {
    actualDeliveryAt,
    deletedAt: null,
    endDate: date("2026-07-09"),
    id: "order-1",
    lease: {
      deletedAt: null,
      status: LeaseStatus.ACTIVE
    },
    orderStatus: OrderStatus.ACTIVE
  };
  const schedule = {
    completedAt: options.scheduleStatus === BillingScheduleStatus.COMPLETED ? now : null,
    id: "schedule-1",
    lastGeneratedAt: null,
    lastGeneratedBillId: null,
    nextCycleNo: cycle.cycleNo,
    nextGenerateAt: cycle.generateAt,
    nextPeriodEnd: cycle.periodEnd,
    nextPeriodStart: cycle.periodStart,
    orderId: order.id,
    pauseReason: null as string | null,
    status: options.scheduleStatus ?? BillingScheduleStatus.ACTIVE,
    version: 0
  };
  const change = {
    failureCode: null as string | null,
    failureMessage: null as string | null,
    id: "change-extension",
    manualTakeoverAt: null as Date | null,
    status: SubscriptionChangeStatus.SCHEDULED
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "locked" }]),
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data)
    },
    billingSchedule: {
      findUnique: vi.fn(async () => ({ ...schedule, order })),
      findUniqueOrThrow: vi.fn(async () => schedule),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(schedule, data, {
          version: schedule.version + 1
        });
        return { count: 1 };
      })
    },
    subscriptionAutomationJob: {
      upsert: vi.fn(async () => ({ id: "debit-job" }))
    },
    subscriptionContractSegment: {
      findUnique: vi.fn(async () => ({
        ...(options.segment ?? segmentTerms()),
        orderId: "order-1",
        segmentType: ContractSegmentType.EXTENSION,
        status: ContractSegmentStatus.SCHEDULED
      }))
    },
    subscriptionChangeOrder: {
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(change, data);
        return { count: 1 };
      })
    }
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
      operation(tx)
    ),
    billingSchedule: {
      findUnique: vi.fn(async () => schedule)
    },
    subscriptionContractSegment: {
      findUnique: vi.fn(async () => ({
        ...(options.segment ?? segmentTerms()),
        orderId: "order-1",
        segmentType: ContractSegmentType.EXTENSION,
        status: ContractSegmentStatus.SCHEDULED
      }))
    }
  };
  const finance = {
    generateMonthlyRentBillForCycle: vi.fn(async (_tx, input) => ({
      bill: {
        dueDate: input.periodStart,
        id: "bill-1",
        orderId: input.orderId
      },
      created: true
    }))
  };
  const segmentService = {
    resolveEffectiveServiceEndDate: vi.fn(
      async () => options.effectiveEndDate ?? date("2027-03-02")
    ),
    resolveSegmentForPeriod: vi.fn(async () => {
      if (options.segmentError) throw options.segmentError;
      return options.segment ?? segmentTerms();
    })
  };
  const repository = { enqueue: vi.fn(async () => ({ id: "job" })) };
  const autoDebitScheduler = { enqueueForBill: vi.fn(async () => []) };
  const service = new BillingAutomationService(
    prisma as never,
    repository as never,
    finance as never,
    autoDebitScheduler as never,
    segmentService as never,
    () => now
  );
  const job = {
    billingScheduleId: schedule.id,
    id: "job-generate-1",
    idempotencyKey: billingSourceKey(order.id, cycle.periodStart),
    orderId: order.id
  } as never;

  return { change, cycle, finance, job, order, prisma, schedule, service, tx };
}

function segmentTerms(
  overrides: Partial<{
    endDate: Date;
    monthlyFeeAmount: bigint;
    segmentId: string;
    startDate: Date;
  }> = {}
) {
  return {
    endDate: date("2026-09-02"),
    mileageLimitKm: 1_500,
    monthlyFeeAmount: 7_700n,
    overMileageFeeAmount: 100n,
    planSnapshot: { planNo: "PLAN-BASE" },
    segmentId: "segment-base",
    startDate: date("2026-03-03"),
    ...overrides
  };
}

function date(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}
