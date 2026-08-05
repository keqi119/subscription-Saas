import {
  ContractSegmentStatus,
  OrderStatus,
  RenewalConsiderationStatus,
  RenewalReminderStatus,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { RenewalConsiderationService } from "../src/subscription-change/renewal-consideration.service";

describe("RenewalConsiderationService enrollment", () => {
  it("creates only one consideration and three durable reminder jobs for a segment", async () => {
    const harness = enrollmentHarness();

    const first = await harness.service.enrollSegment(
      "segment-1",
      new Date("2026-08-03T01:00:00.000Z")
    );
    const second = await harness.service.enrollSegment(
      "segment-1",
      new Date("2026-08-03T01:00:00.000Z")
    );

    expect(second?.id).toBe(first?.id);
    expect(harness.prisma.renewalConsideration.upsert).toHaveBeenCalledTimes(2);
    expect(harness.repository.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "renewal-reminder:consideration-1:D30" })
    );
    expect(
      new Set(harness.repository.enqueue.mock.calls.map(([, input]) => input.idempotencyKey))
    ).toEqual(
      new Set([
        "renewal-reminder:consideration-1:D30",
        "renewal-reminder:consideration-1:D14",
        "renewal-reminder:consideration-1:D3",
        "renewal-expiry:segment-1:2026-09-02",
        "renewal-return-overdue:order-1:2026-09-02:D1"
      ])
    );
  });

  it("late enrollment skips obsolete slots and keeps only the latest applicable reminder pending", async () => {
    const harness = enrollmentHarness();

    const result = await harness.service.enrollSegment(
      "segment-1",
      new Date("2026-08-31T01:00:00.000Z")
    );

    expect(result?.reminders.map((reminder) => reminder.status)).toEqual([
      RenewalReminderStatus.SKIPPED_LATE_ENROLLMENT,
      RenewalReminderStatus.SKIPPED_LATE_ENROLLMENT,
      RenewalReminderStatus.PENDING
    ]);
  });

  it("does not write when the extension feature is disabled", async () => {
    const harness = enrollmentHarness({ enabled: false });

    await expect(
      harness.service.enrollSegment("segment-1", new Date("2026-08-03T01:00:00.000Z"))
    ).resolves.toBeNull();
    expect(harness.prisma.renewalConsideration.upsert).not.toHaveBeenCalled();
    expect(harness.repository.enqueue).not.toHaveBeenCalled();
  });
});

function enrollmentHarness(options: { enabled?: boolean } = {}) {
  const reminders: Array<Record<string, unknown>> = [];
  const consideration = {
    completionDeadlineAt: new Date("2026-09-02T16:00:00.000Z"),
    considerationNo: "RNC-1",
    considerationStartAt: new Date("2026-08-03T01:00:00.000Z"),
    id: "consideration-1",
    orderId: "order-1",
    reminders,
    segmentId: "segment-1",
    status: RenewalConsiderationStatus.PENDING_DECISION,
    version: 0
  };
  const segment = {
    endDate: new Date("2026-09-02T00:00:00.000Z"),
    id: "segment-1",
    order: {
      customerId: "customer-1",
      id: "order-1",
      orderNo: "ORD-1",
      orderStatus: OrderStatus.ACTIVE,
      vehicle: { plateNo: "沪DGU581", status: VehicleStatus.LEASED }
    },
    orderId: "order-1",
    sequenceNo: 1,
    status: ContractSegmentStatus.ACTIVE
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => operation(prisma)),
    auditLog: { create: vi.fn(async () => ({})) },
    renewalConsideration: {
      upsert: vi.fn(async () => consideration)
    },
    renewalReminder: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        const existing = reminders.find((item) => item.slot === create.slot);
        if (existing) return existing;
        const reminder = { id: `reminder-${String(create.slot)}`, ...create };
        reminders.push(reminder);
        return reminder;
      })
    },
    subscriptionContractSegment: {
      findFirst: vi.fn(async () => segment),
      findUnique: vi.fn(async () => segment)
    }
  };
  const repository = {
    enqueue: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => input)
  };
  const service = new RenewalConsiderationService(
    prisma as never,
    repository as never,
    { notifyRenewalReminderInApp: vi.fn() } as never,
    { sendRenewalReminder: vi.fn() } as never,
    { write: vi.fn() } as never,
    { enabled: options.enabled ?? true, now: () => new Date(), quoteValidityHours: 72 }
  );
  return { prisma, repository, service };
}
