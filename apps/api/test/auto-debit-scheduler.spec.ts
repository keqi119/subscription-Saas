import {
  DebitRetrySlot,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AutoDebitScheduler } from "../src/auto-debit/auto-debit.scheduler";

describe("AutoDebitScheduler", () => {
  it("upserts exactly three idempotent debit jobs for a bill", async () => {
    const harness = createHarness();
    const scheduler = new AutoDebitScheduler({
      enabled: true,
      environment: "staging",
      mockEnabled: true,
      provider: "mock",
      runTime: "09:00",
      wechatTemplateId: null
    });

    await scheduler.enqueueForBill(harness.tx as never, bill, "schedule-1");
    await scheduler.enqueueForBill(harness.tx as never, bill, "schedule-1");

    expect(harness.jobs).toHaveLength(3);
    expect(harness.jobs).toEqual([
      expect.objectContaining({
        availableAt: new Date("2026-09-02T01:00:00.000Z"),
        idempotencyKey: "debit:bill-1:DUE",
        jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
        payload: { billId: "bill-1", retrySlot: DebitRetrySlot.DUE }
      }),
      expect.objectContaining({ idempotencyKey: "debit:bill-1:D1" }),
      expect.objectContaining({ idempotencyKey: "debit:bill-1:D3" })
    ]);
  });

  it("only backfills debit slots that have not passed", async () => {
    const harness = createHarness();
    const scheduler = new AutoDebitScheduler({
      enabled: true,
      environment: "staging",
      mockEnabled: true,
      provider: "mock",
      runTime: "09:00",
      wechatTemplateId: null
    });

    await scheduler.enqueueFutureForBill(
      harness.tx as never,
      bill,
      new Date("2026-09-02T02:00:00.000Z")
    );

    expect(harness.jobs.map((job) => job.idempotencyKey)).toEqual([
      "debit:bill-1:D1",
      "debit:bill-1:D3"
    ]);
  });

  it("does not enqueue jobs when automatic debit is disabled", async () => {
    const harness = createHarness();
    const scheduler = new AutoDebitScheduler({
      enabled: false,
      environment: "production",
      mockEnabled: false,
      provider: "disabled",
      runTime: "09:00",
      wechatTemplateId: null
    });

    await expect(
      scheduler.enqueueForBill(harness.tx as never, bill)
    ).resolves.toEqual([]);
    expect(harness.tx.subscriptionAutomationJob.upsert).not.toHaveBeenCalled();
  });
});

const bill = {
  dueDate: new Date("2026-09-02T00:00:00.000Z"),
  id: "bill-1",
  orderId: "order-1"
};

function createHarness() {
  const jobs: Array<Record<string, unknown>> = [];
  const tx = {
    subscriptionAutomationJob: {
      upsert: vi.fn(async ({ create, where }) => {
        const existing = jobs.find(
          (job) => job.idempotencyKey === where.idempotencyKey
        );
        if (existing) {
          return existing;
        }
        const job = { id: `job-${jobs.length + 1}`, ...create };
        jobs.push(job);
        return job;
      })
    }
  };
  return { jobs, tx };
}
