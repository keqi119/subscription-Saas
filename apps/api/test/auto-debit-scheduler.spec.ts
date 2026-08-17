import { describe, expect, it, vi } from "vitest";

import { AutoDebitScheduler } from "../src/auto-debit/auto-debit.scheduler";

describe("AutoDebitScheduler", () => {
  it("never enqueues automatic debit jobs for a generated bill", async () => {
    const harness = createHarness();
    const scheduler = new AutoDebitScheduler();

    await expect(
      scheduler.enqueueForBill(harness.tx as never, bill, "schedule-1")
    ).resolves.toEqual([]);

    expect(harness.tx.subscriptionAutomationJob.upsert).not.toHaveBeenCalled();
  });

  it("never backfills automatic debit jobs for an existing bill", async () => {
    const harness = createHarness();
    const scheduler = new AutoDebitScheduler();

    await expect(
      scheduler.enqueueFutureForBill(
        harness.tx as never,
        bill,
        new Date("2026-09-02T02:00:00.000Z")
      )
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
  return {
    tx: {
      subscriptionAutomationJob: {
        upsert: vi.fn()
      }
    }
  };
}
