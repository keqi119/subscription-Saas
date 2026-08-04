import {
  DebitAttemptStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AutoDebitHandlers } from "../src/auto-debit/auto-debit.handlers";
import { DebitAttemptService } from "../src/auto-debit/debit-attempt.service";
import { BillingAutomationError } from "../src/billing-automation/billing-automation.types";

describe("AutoDebitHandlers", () => {
  it("dispatches submit and query jobs to the shared debit service", async () => {
    const service = {
      queryDebitAttempt: vi.fn().mockResolvedValue({
        action: "RESOLVED",
        status: DebitAttemptStatus.SUCCEEDED
      }),
      submitBillDebit: vi.fn().mockResolvedValue({
        action: "SUBMITTED",
        status: DebitAttemptStatus.PROCESSING
      })
    };
    const handlers = new AutoDebitHandlers(
      service as unknown as DebitAttemptService,
      { notifyAutoDebitFailure: vi.fn() } as never
    );
    const submit = job(SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT);
    const query = job(SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT);

    await expect(handlers.handle(submit)).resolves.toMatchObject({
      action: "SUBMITTED"
    });
    await expect(handlers.handle(query)).resolves.toMatchObject({
      action: "RESOLVED"
    });
    expect(service.submitBillDebit).toHaveBeenCalledWith(submit);
    expect(service.queryDebitAttempt).toHaveBeenCalledWith(query);
  });

  it("keeps an unresolved query job pending through the existing worker retry path", async () => {
    const service = {
      queryDebitAttempt: vi.fn().mockResolvedValue({
        action: "PENDING_QUERY",
        status: DebitAttemptStatus.UNKNOWN
      }),
      submitBillDebit: vi.fn()
    };
    const handlers = new AutoDebitHandlers(
      service as unknown as DebitAttemptService,
      { notifyAutoDebitFailure: vi.fn() } as never
    );

    await expect(
      handlers.handle(job(SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT))
    ).rejects.toMatchObject({
      code: "AUTO_DEBIT_QUERY_PENDING",
      retryable: true
    } satisfies Partial<BillingAutomationError>);
  });
});

function job(jobType: SubscriptionAutomationJobType) {
  const now = new Date("2026-08-05T01:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    billId: "bill-1",
    billingScheduleId: null,
    cancelledAt: null,
    completedAt: null,
    createdAt: now,
    id: "job-1",
    idempotencyKey: "job-1",
    jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
    jobType,
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date(now.getTime() + 120_000),
    leaseToken: "lease-token-1",
    maxAttempts: 6,
    orderId: "order-1",
    payload: null,
    resultSnapshot: null,
    startedAt: now,
    updatedAt: now
  };
}
