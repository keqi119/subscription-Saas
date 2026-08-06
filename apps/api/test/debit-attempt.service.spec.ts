import {
  BillStatus,
  DebitAttemptStatus,
  DebitRetrySlot,
  PaymentChannel,
  PaymentMandateStatus,
  PaymentOrderStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { DebitAttemptService } from "../src/auto-debit/debit-attempt.service";
import { MandateDebitProvider } from "../src/auto-debit/auto-debit-provider";
import { ClaimedBillingAutomationJob } from "../src/billing-automation/billing-automation.types";

describe("DebitAttemptService", () => {
  it("skips a settled bill without creating an attempt", async () => {
    const harness = createHarness({ remainingAmount: 0n });

    await expect(harness.service.submitBillDebit(submitJob())).resolves.toEqual({
      action: "SKIPPED",
      reason: "BILL_SETTLED_OR_MISSING"
    });

    expect(harness.prisma.debitAttempt.create).not.toHaveBeenCalled();
    expect(harness.provider.submitDebit).not.toHaveBeenCalled();
  });

  it("skips the current slot when no active mandate exists", async () => {
    const harness = createHarness({ mandate: null });

    await expect(harness.service.submitBillDebit(submitJob())).resolves.toEqual({
      action: "SKIPPED",
      reason: "ACTIVE_MANDATE_MISSING"
    });

    expect(harness.prisma.debitAttempt.create).not.toHaveBeenCalled();
    expect(harness.provider.submitDebit).not.toHaveBeenCalled();
  });

  it("enqueues a query instead of creating a second attempt for an unresolved job", async () => {
    const harness = createHarness({ attemptStatus: DebitAttemptStatus.UNKNOWN });

    await expect(harness.service.submitBillDebit(submitJob())).resolves.toMatchObject({
      action: "QUERY_ENQUEUED",
      attemptId: "attempt-1"
    });

    expect(harness.prisma.debitAttempt.create).not.toHaveBeenCalled();
    expect(harness.provider.submitDebit).not.toHaveBeenCalled();
    expect(harness.prisma.subscriptionAutomationJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          jobType: SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT,
          payload: { debitAttemptId: "attempt-1" }
        })
      })
    );
  });

  it("reuses an unresolved DUE attempt when the D+1 slot starts", async () => {
    const harness = createHarness({ attemptStatus: DebitAttemptStatus.UNKNOWN });

    await expect(
      harness.service.submitBillDebit(submitJob(DebitRetrySlot.D1))
    ).resolves.toMatchObject({
      action: "QUERY_ENQUEUED",
      attemptId: "attempt-1"
    });

    expect(harness.prisma.debitAttempt.create).not.toHaveBeenCalled();
    expect(harness.provider.submitDebit).not.toHaveBeenCalled();
  });

  it("does not downgrade a successful attempt or paid order on a stale unknown result", async () => {
    const harness = createHarness({ attemptStatus: DebitAttemptStatus.SUCCEEDED });
    harness.paymentOrder.paymentStatus = PaymentOrderStatus.PAID;
    harness.provider.queryDebit.mockRejectedValueOnce(new Error("late socket reset"));

    await expect(harness.service.queryDebitAttempt(queryJob())).resolves.toMatchObject({
      action: "RESOLVED",
      status: DebitAttemptStatus.SUCCEEDED
    });

    expect(harness.prisma.debitAttempt.update).not.toHaveBeenCalled();
    expect(harness.paymentOrder.paymentStatus).toBe(PaymentOrderStatus.PAID);
  });

  it("persists PROCESSING and creates one durable query job after provider acceptance", async () => {
    const harness = createHarness();

    await expect(harness.service.submitBillDebit(submitJob())).resolves.toMatchObject({
      action: "SUBMITTED",
      status: DebitAttemptStatus.PROCESSING
    });

    expect(harness.prisma.debitAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          retrySlot: DebitRetrySlot.DUE,
          status: DebitAttemptStatus.SUBMITTING
        })
      })
    );
    expect(harness.prisma.paymentOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentChannel: PaymentChannel.WECHAT_AUTO_DEBIT
        })
      })
    );
    expect(harness.prisma.debitAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: DebitAttemptStatus.PROCESSING })
      })
    );
    expect(harness.prisma.subscriptionAutomationJob.upsert).toHaveBeenCalledTimes(1);
  });

  it("does not create a second attempt when the same leased job is recovered", async () => {
    const harness = createHarness();
    const job = submitJob();

    await harness.service.submitBillDebit(job);
    await harness.service.submitBillDebit(job);

    expect(harness.prisma.debitAttempt.create).toHaveBeenCalledTimes(1);
    expect(harness.provider.submitDebit).toHaveBeenCalledTimes(1);
  });

  it("marks network uncertainty UNKNOWN and queries the original merchant order number", async () => {
    const harness = createHarness();
    harness.provider.submitDebit.mockRejectedValueOnce(new Error("socket reset"));

    await expect(harness.service.submitBillDebit(submitJob())).resolves.toMatchObject({
      action: "QUERY_ENQUEUED",
      status: DebitAttemptStatus.UNKNOWN
    });

    expect(harness.prisma.debitAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: DebitAttemptStatus.UNKNOWN })
      })
    );
    expect(harness.prisma.subscriptionAutomationJob.upsert).toHaveBeenCalledTimes(1);
  });

  it("maps a provider retryable failure to final failure on D+3", async () => {
    const harness = createHarness({ providerStatus: "FAILED_RETRYABLE" });

    await expect(
      harness.service.submitBillDebit(submitJob(DebitRetrySlot.D3))
    ).resolves.toMatchObject({
      action: "RESOLVED",
      status: DebitAttemptStatus.FAILED_FINAL
    });

    expect(harness.prisma.paymentOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentStatus: PaymentOrderStatus.FAILED })
      })
    );
    expect(harness.prisma.subscriptionAutomationJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          billId: "bill-1",
          idempotencyKey: "debit-failure:attempt-1",
          jobType: SubscriptionAutomationJobType.SEND_DEBIT_FAILURE_NOTICE,
          orderId: "order-1",
          payload: { debitAttemptId: "attempt-1" }
        })
      })
    );
  });

  it("allows an operator-requested MANUAL attempt after final failure", async () => {
    const harness = createHarness({
      attemptStatus: DebitAttemptStatus.FAILED_FINAL
    });

    await expect(
      harness.service.submitBillDebit(submitJob(DebitRetrySlot.MANUAL))
    ).resolves.toMatchObject({ action: "SUBMITTED" });

    expect(harness.prisma.debitAttempt.create).toHaveBeenCalledTimes(1);
    expect(harness.provider.submitDebit).toHaveBeenCalledTimes(1);
  });

  it("does not let D+3 continue after a final failure", async () => {
    const harness = createHarness({
      attemptStatus: DebitAttemptStatus.FAILED_FINAL
    });

    await expect(
      harness.service.submitBillDebit(submitJob(DebitRetrySlot.D3))
    ).resolves.toEqual({
      action: "SKIPPED",
      reason: "DEBIT_ATTEMPT_ALREADY_RESOLVED"
    });

    expect(harness.prisma.debitAttempt.create).not.toHaveBeenCalled();
  });

  it("rejects a successful provider result with the wrong amount", async () => {
    const harness = createHarness({
      confirmedAmount: 99n,
      providerStatus: "SUCCEEDED"
    });

    await expect(harness.service.submitBillDebit(submitJob())).resolves.toMatchObject({
      action: "RESOLVED",
      status: DebitAttemptStatus.FAILED_FINAL
    });

    expect(harness.finance.settlePaymentOrder).not.toHaveBeenCalled();
  });

  it("queries an unresolved attempt without creating another attempt", async () => {
    const harness = createHarness({ attemptStatus: DebitAttemptStatus.UNKNOWN });

    await expect(harness.service.queryDebitAttempt(queryJob())).resolves.toMatchObject({
      action: "RESOLVED",
      attemptId: "attempt-1",
      status: DebitAttemptStatus.SUCCEEDED
    });

    expect(harness.provider.queryDebit).toHaveBeenCalledWith(
      expect.objectContaining({ providerOutTradeNo: "AUTO-DEBIT-1" })
    );
    expect(harness.finance.settlePaymentOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        debitAttempt: expect.objectContaining({ id: "attempt-1" }),
        paymentOrderId: "payment-order-1"
      })
    );
    expect(harness.prisma.debitAttempt.create).not.toHaveBeenCalled();
  });

  it("reuses the merchant order number only after query confirms it does not exist", async () => {
    const harness = createHarness({ attemptStatus: DebitAttemptStatus.UNKNOWN });
    harness.provider.queryDebit.mockResolvedValueOnce({
      confirmedAmount: 0n,
      errorCode: "PROVIDER_TRANSACTION_NOT_FOUND",
      providerOutTradeNo: "AUTO-DEBIT-1",
      providerSnapshot: { kind: "mock-debit-query", status: "FAILED_RETRYABLE" },
      providerTransactionId: "",
      status: "FAILED_RETRYABLE"
    });

    await harness.service.queryDebitAttempt(queryJob());

    expect(harness.provider.submitDebit).toHaveBeenCalledWith(
      expect.objectContaining({ providerOutTradeNo: "AUTO-DEBIT-1" })
    );
    expect(harness.prisma.debitAttempt.create).not.toHaveBeenCalled();
  });

  it("does not resubmit a merchant order that became successful after a stale not-found query", async () => {
    const harness = createHarness({ attemptStatus: DebitAttemptStatus.UNKNOWN });
    const succeeded = attemptRecord(DebitAttemptStatus.SUCCEEDED);
    harness.paymentOrder.paymentStatus = PaymentOrderStatus.PAID;
    harness.provider.queryDebit.mockResolvedValueOnce({
      confirmedAmount: 0n,
      errorCode: "PROVIDER_TRANSACTION_NOT_FOUND",
      providerOutTradeNo: "AUTO-DEBIT-1",
      providerSnapshot: { kind: "stale-query", status: "FAILED_RETRYABLE" },
      providerTransactionId: "",
      status: "FAILED_RETRYABLE"
    });
    harness.prisma.debitAttempt.findUnique
      .mockResolvedValueOnce(attemptRecord(DebitAttemptStatus.UNKNOWN))
      .mockResolvedValueOnce(attemptRecord(DebitAttemptStatus.UNKNOWN))
      .mockResolvedValueOnce(succeeded);
    harness.prisma.debitAttempt.findUniqueOrThrow.mockResolvedValueOnce(succeeded);

    await expect(
      harness.service.queryDebitAttempt(queryJob())
    ).resolves.toMatchObject({
      action: "RESOLVED",
      status: DebitAttemptStatus.SUCCEEDED
    });

    expect(harness.provider.submitDebit).not.toHaveBeenCalled();
    expect(harness.paymentOrder.paymentStatus).toBe(PaymentOrderStatus.PAID);
  });

  it.each([
    [PaymentMandateStatus.REVOKED, {}],
    [PaymentMandateStatus.SUSPENDED, {}],
    [PaymentMandateStatus.EXPIRED, {}],
    [
      PaymentMandateStatus.ACTIVE,
      { requestSnapshot: { revokeRequestedAt: "2026-08-05T01:00:00.000Z" } }
    ]
  ])(
    "cancels recovery instead of resubmitting when mandate is %s or revocation is pending",
    async (status, mandateOverride) => {
      const harness = createHarness({
        attemptStatus: DebitAttemptStatus.UNKNOWN,
        mandate: { ...mandateOverride, status }
      });
      harness.provider.queryDebit.mockResolvedValueOnce({
        confirmedAmount: 0n,
        errorCode: "PROVIDER_TRANSACTION_NOT_FOUND",
        providerOutTradeNo: "AUTO-DEBIT-1",
        providerSnapshot: { kind: "mock-query", status: "FAILED_RETRYABLE" },
        providerTransactionId: "",
        status: "FAILED_RETRYABLE"
      });

      await expect(
        harness.service.queryDebitAttempt(queryJob())
      ).resolves.toMatchObject({
        action: "RESOLVED",
        status: DebitAttemptStatus.CANCELLED
      });

      expect(harness.provider.submitDebit).not.toHaveBeenCalled();
      expect(harness.paymentOrder.paymentStatus).toBe(
        PaymentOrderStatus.CANCELLED
      );
    }
  );
});

function createHarness(
  options: {
    attemptStatus?: DebitAttemptStatus;
    confirmedAmount?: bigint;
    mandate?: Record<string, unknown> | null;
    providerStatus?: "PROCESSING" | "SUCCEEDED" | "FAILED_RETRYABLE";
    remainingAmount?: bigint;
  } = {}
) {
  const bill = {
    billNo: "BIL-1",
    billStatus: BillStatus.PENDING,
    customerId: "customer-1",
    deletedAt: null,
    id: "bill-1",
    orderId: "order-1",
    remainingAmount: options.remainingAmount ?? 100n
  };
  const mandate =
    options.mandate === null
      ? null
      : {
          customerId: "customer-1",
          id: "mandate-1",
          orderId: "order-1",
          provider: "MOCK",
          providerMandateId: "mock-mandate-1",
          requestSnapshot: {},
          responseSnapshot: { kind: "mock-mandate" },
          status: PaymentMandateStatus.ACTIVE,
          ...options.mandate
        };
  let attempt = options.attemptStatus
    ? attemptRecord(options.attemptStatus)
    : null;
  const paymentOrder = {
    amount: 100n,
    id: "payment-order-1",
    paidAmount: 0n,
    paymentOrderNo: "PAY-1",
    paymentStatus: PaymentOrderStatus.PENDING as PaymentOrderStatus
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (tx: unknown) => unknown) =>
      operation(prisma)
    ),
    $queryRaw: vi.fn().mockResolvedValue([{ id: "locked" }]),
    debitAttempt: {
      create: vi.fn(async ({ data }) => {
        attempt = {
          ...attemptRecord(DebitAttemptStatus.SUBMITTING),
          ...data,
          id: "attempt-1",
          paymentOrderId: paymentOrder.id
        };
        return attempt;
      }),
      findFirst: vi.fn(async ({ where }) => {
        if (!attempt || (where.billId && where.billId !== attempt.billId)) {
          return null;
        }
        if (where.status?.in && !where.status.in.includes(attempt.status)) {
          return null;
        }
        return attempt;
      }),
      findUnique: vi.fn(async ({ where }) => {
        if (!attempt) {
          return null;
        }
        if (where.id && where.id !== attempt.id) {
          return null;
        }
        if (where.idempotencyKey && where.idempotencyKey !== attempt.idempotencyKey) {
          return null;
        }
        return attempt;
      }),
      findUniqueOrThrow: vi.fn(async () => {
        if (!attempt) {
          throw new Error("attempt missing");
        }
        return attempt;
      }),
      update: vi.fn(async ({ data }) => {
        attempt = { ...attempt!, ...data };
        return attempt;
      })
    },
    paymentMandate: {
      findFirst: vi.fn().mockResolvedValue(mandate),
      findUnique: vi.fn().mockResolvedValue(mandate)
    },
    paymentOrder: {
      create: vi.fn().mockResolvedValue(paymentOrder),
      findUnique: vi.fn(async () => paymentOrder),
      update: vi.fn(async ({ data }) => Object.assign(paymentOrder, data)),
      updateMany: vi.fn(async ({ data, where }) => {
        if (
          where.paymentStatus?.not === PaymentOrderStatus.PAID &&
          paymentOrder.paymentStatus === PaymentOrderStatus.PAID
        ) {
          return { count: 0 };
        }
        Object.assign(paymentOrder, data);
        return { count: 1 };
      })
    },
    receivableBill: {
      findUnique: vi.fn().mockResolvedValue(bill)
    },
    subscriptionAutomationJob: {
      upsert: vi.fn(async ({ create }) => ({ id: "query-job-1", ...create }))
    }
  };
  const provider: MandateDebitProvider = {
    createMandate: vi.fn(),
    queryDebit: vi.fn().mockResolvedValue({
      confirmedAmount: 100n,
      providerOutTradeNo: "AUTO-DEBIT-1",
      providerSnapshot: { kind: "mock-debit", status: "SUCCEEDED" },
      providerTransactionId: "provider-transaction-1",
      resolvedAt: new Date("2026-08-05T01:01:00.000Z"),
      status: "SUCCEEDED"
    }),
    queryMandate: vi.fn(),
    revokeMandate: vi.fn(),
    submitDebit: vi.fn().mockImplementation(async (input) => ({
      confirmedAmount:
        options.providerStatus === "SUCCEEDED"
          ? options.confirmedAmount ?? 100n
          : 0n,
      errorCode:
        options.providerStatus === "FAILED_RETRYABLE"
          ? "INSUFFICIENT_FUNDS"
          : undefined,
      providerOutTradeNo: input.providerOutTradeNo,
      providerSnapshot: { kind: "mock-debit" },
      providerTransactionId: "provider-transaction-1",
      status: options.providerStatus ?? "PROCESSING"
    })),
    verifyCallback: vi.fn()
  };
  const finance = {
    settlePaymentOrder: vi.fn(async (input: { paidAmount: bigint }) => {
      attempt = {
        ...attempt!,
        confirmedAmount: input.paidAmount,
        status: DebitAttemptStatus.SUCCEEDED
      };
      Object.assign(paymentOrder, {
        paidAmount: input.paidAmount,
        paymentStatus: PaymentOrderStatus.PAID
      });
      return { paymentOrderId: paymentOrder.id };
    })
  };
  const service = new DebitAttemptService(
    prisma as never,
    provider,
    finance as never
  );

  return {
    finance,
    prisma,
    provider: {
      queryDebit: vi.mocked(provider.queryDebit),
      submitDebit: vi.mocked(provider.submitDebit)
    },
    paymentOrder,
    service
  };
}

function attemptRecord(status: DebitAttemptStatus) {
  return {
    billId: "bill-1",
    confirmedAmount: 0n,
    customerId: "customer-1",
    id: "attempt-1",
    idempotencyKey: "debit:bill-1:DUE",
    mandateId: "mandate-1",
    orderId: "order-1",
    paymentOrderId: "payment-order-1",
    providerOutTradeNo: "AUTO-DEBIT-1",
    providerTransactionId: null,
    requestSnapshot: { kind: "auto-debit-request" },
    requestedAmount: 100n,
    responseSnapshot: { kind: "mock-debit" },
    retrySlot: DebitRetrySlot.DUE,
    status,
    bill: { billNo: "BIL-1" },
    mandate: { providerMandateId: "mock-mandate-1" }
  };
}

function submitJob(
  retrySlot: DebitRetrySlot = DebitRetrySlot.DUE
): ClaimedBillingAutomationJob {
  return automationJob({
    idempotencyKey: `debit:bill-1:${retrySlot}`,
    jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
    payload: { billId: "bill-1", retrySlot }
  });
}

function queryJob(): ClaimedBillingAutomationJob {
  return automationJob({
    idempotencyKey: "debit-query:attempt-1",
    jobType: SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT,
    payload: { debitAttemptId: "attempt-1" }
  });
}

function automationJob(
  overrides: Partial<ClaimedBillingAutomationJob>
): ClaimedBillingAutomationJob {
  const now = new Date("2026-08-05T01:00:00.000Z");
  return {
    attemptCount: 0,
    availableAt: now,
    billId: "bill-1",
    billingScheduleId: null,
    changeOrderId: null,
    contractSegmentId: null,
    cancelledAt: null,
    completedAt: null,
    createdAt: now,
    id: "job-1",
    idempotencyKey: "job-1",
    jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
    jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
    lastErrorCode: null,
    lastErrorMessage: null,
    leaseExpiresAt: new Date(now.getTime() + 120_000),
    leaseToken: "lease-token-1",
    maxAttempts: 6,
    orderId: "order-1",
    payload: null,
    renewalConsiderationId: null,
    resultSnapshot: null,
    startedAt: now,
    updatedAt: now,
    ...overrides
  };
}
