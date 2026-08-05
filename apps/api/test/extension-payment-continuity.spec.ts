import {
  BillStatus,
  ContractSegmentStatus,
  DebitAttemptStatus,
  DebitRetrySlot,
  PaymentMandateStatus,
  PaymentOrderStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType,
  SubscriptionChangeStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { DebitAttemptService } from "../src/auto-debit/debit-attempt.service";
import { ClaimedBillingAutomationJob } from "../src/billing-automation/billing-automation.types";
import { SubscriptionExtensionActivationService } from "../src/subscription-change/subscription-extension-activation.service";

describe("extension payment continuity", () => {
  it("does not revoke the active mandate or mutate existing payable receivables during activation", async () => {
    const mandate = { id: "mandate-1", status: PaymentMandateStatus.ACTIVE };
    const bill = { billStatus: BillStatus.PENDING, id: "bill-1", remainingAmount: 100n };
    const paymentMandate = { update: vi.fn(), updateMany: vi.fn() };
    const receivableBill = { update: vi.fn(), updateMany: vi.fn() };
    const source = { id: "segment-base", status: ContractSegmentStatus.ACTIVE };
    const change = {
      id: "change-1",
      orderId: "order-1",
      sourceSegment: source,
      status: SubscriptionChangeStatus.SCHEDULED,
      version: 1
    };
    const target = {
      endDate: new Date("2027-03-02T00:00:00.000Z"),
      id: "segment-extension",
      orderId: "order-1",
      planSnapshot: { packageSnapshot: {} },
      sourceChangeOrder: change,
      startDate: new Date("2026-09-03T00:00:00.000Z"),
      status: ContractSegmentStatus.SCHEDULED
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "locked" }]),
      $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(prisma)),
      paymentMandate,
      receivableBill,
      subscriptionChangeOrder: {
        updateMany: vi.fn(async ({ data }) => {
          Object.assign(change, data, { version: change.version + 1 });
          return { count: 1 };
        })
      },
      subscriptionContractSegment: {
        findUnique: vi.fn(async () => target),
        updateMany: vi.fn(async ({ data, where }) => {
          Object.assign(where.id === source.id ? source : target, data);
          return { count: 1 };
        })
      }
    };
    const service = new SubscriptionExtensionActivationService(
      prisma as never,
      { enqueue: vi.fn(async () => ({})) } as never,
      { resumeForExtension: vi.fn() } as never,
      { notifyExtensionEffectiveInApp: vi.fn() } as never,
      { write: vi.fn() } as never
    );

    await service.activate("segment-extension", new Date("2026-09-03T00:00:00.000Z"));

    expect(mandate).toEqual({ id: "mandate-1", status: PaymentMandateStatus.ACTIVE });
    expect(bill).toEqual({ billStatus: BillStatus.PENDING, id: "bill-1", remainingAmount: 100n });
    expect(paymentMandate.update).not.toHaveBeenCalled();
    expect(paymentMandate.updateMany).not.toHaveBeenCalled();
    expect(receivableBill.update).not.toHaveBeenCalled();
    expect(receivableBill.updateMany).not.toHaveBeenCalled();
  });

  it("continues submitting an existing payable bill through the existing active mandate", async () => {
    const harness = createDebitContinuityHarness();

    await expect(harness.service.submitBillDebit(harness.job)).resolves.toMatchObject({
      action: "SUBMITTED",
      status: DebitAttemptStatus.PROCESSING
    });

    expect(harness.provider.submitDebit).toHaveBeenCalledTimes(1);
    expect(harness.provider.submitDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 100n,
        providerMandateId: "provider-mandate-1"
      })
    );
  });
});

function createDebitContinuityHarness() {
  const bill = {
    billNo: "BIL-EXTENSION-CONTINUITY",
    billStatus: BillStatus.PENDING,
    customerId: "customer-1",
    deletedAt: null,
    id: "bill-existing",
    orderId: "order-1",
    remainingAmount: 100n
  };
  const mandate = {
    id: "mandate-active",
    orderId: "order-1",
    provider: "MOCK",
    providerMandateId: "provider-mandate-1",
    status: PaymentMandateStatus.ACTIVE
  };
  let attempt: Record<string, unknown> | null = null;
  const paymentOrder = {
    id: "payment-existing",
    paymentStatus: PaymentOrderStatus.PENDING
  };
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "locked" }]),
    $transaction: vi.fn(async (operation: (tx: unknown) => unknown) => operation(prisma)),
    debitAttempt: {
      create: vi.fn(async ({ data }) => {
        attempt = { ...data, id: "attempt-existing", paymentOrderId: paymentOrder.id };
        return attempt;
      }),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async ({ where }) => {
        if (!attempt) return null;
        if (where.id && where.id !== attempt.id) return null;
        if (where.idempotencyKey && where.idempotencyKey !== attempt.idempotencyKey) return null;
        return attempt;
      }),
      findUniqueOrThrow: vi.fn(async () => attempt),
      update: vi.fn(async ({ data }) => {
        attempt = { ...attempt!, ...data };
        return attempt;
      })
    },
    paymentMandate: {
      findFirst: vi.fn(async () => mandate),
      findUnique: vi.fn(async () => mandate)
    },
    paymentOrder: {
      create: vi.fn(async () => paymentOrder),
      findUnique: vi.fn(async () => paymentOrder),
      update: vi.fn(async ({ data }) => Object.assign(paymentOrder, data))
    },
    receivableBill: {
      findUnique: vi.fn(async () => bill)
    },
    subscriptionAutomationJob: {
      upsert: vi.fn(async ({ create }) => ({ ...create, id: "job-query" }))
    }
  };
  const provider = {
    submitDebit: vi.fn(async (input) => ({
      confirmedAmount: 0n,
      providerOutTradeNo: input.providerOutTradeNo,
      providerSnapshot: { status: "PROCESSING" },
      providerTransactionId: "provider-transaction-1",
      status: "PROCESSING" as const
    }))
  };
  const service = new DebitAttemptService(
    prisma as never,
    provider as never,
    { settlePaymentOrder: vi.fn() } as never
  );
  const now = new Date("2026-09-03T00:00:00.000Z");
  const job: ClaimedBillingAutomationJob = {
    attemptCount: 0,
    availableAt: now,
    billId: bill.id,
    billingScheduleId: null,
    cancelledAt: null,
    changeOrderId: "change-1",
    completedAt: null,
    contractSegmentId: "segment-extension",
    createdAt: now,
    id: "job-debit-existing",
    idempotencyKey: "debit:bill-existing:DUE",
    jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
    jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date("2026-09-03T00:02:00.000Z"),
    leaseToken: "lease-debit-existing",
    maxAttempts: 6,
    orderId: "order-1",
    payload: { billId: bill.id, retrySlot: DebitRetrySlot.DUE },
    renewalConsiderationId: null,
    resultSnapshot: null,
    startedAt: now,
    updatedAt: now
  };
  return { job, provider, service };
}
