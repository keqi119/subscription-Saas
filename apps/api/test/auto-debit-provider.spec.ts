import { describe, expect, it } from "vitest";

import { MockAutoDebitProvider } from "../src/auto-debit/mock-auto-debit.provider";

describe("MockAutoDebitProvider", () => {
  it("returns a stable active mandate that survives provider recreation", async () => {
    const provider = new MockAutoDebitProvider();
    const first = await provider.createMandate({
      customerId: "customer-1",
      mandateNo: "MDT-1",
      orderId: "order-1",
      providerTemplateId: "mock-template"
    });
    const duplicate = await provider.createMandate({
      customerId: "customer-1",
      mandateNo: "MDT-1",
      orderId: "order-1",
      providerTemplateId: "mock-template"
    });

    expect(first.status).toBe("ACTIVE");
    expect(duplicate.providerMandateId).toBe(first.providerMandateId);

    const restartedProvider = new MockAutoDebitProvider();
    await expect(
      restartedProvider.queryMandate({
        providerMandateId: first.providerMandateId,
        providerSnapshot: first.providerSnapshot
      })
    ).resolves.toMatchObject({
      providerMandateId: first.providerMandateId,
      status: "ACTIVE"
    });
  });

  it("accepts a debit asynchronously and idempotently", async () => {
    const provider = new MockAutoDebitProvider();
    const input = {
      amount: 1n,
      currency: "CNY",
      providerMandateId: "mock-mandate-1",
      providerOutTradeNo: "DEBIT-1",
      subject: "月租账单"
    } as const;

    const first = await provider.submitDebit(input);
    const duplicate = await provider.submitDebit(input);

    expect(first).toMatchObject({
      providerOutTradeNo: "DEBIT-1",
      status: "PROCESSING"
    });
    expect(duplicate.providerTransactionId).toBe(first.providerTransactionId);
    expect(duplicate.providerSnapshot).toEqual(first.providerSnapshot);
  });

  it.each([
    "SUCCEEDED",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
    "UNKNOWN"
  ] as const)("resolves a persisted next result as %s", async (nextResult) => {
    const provider = new MockAutoDebitProvider();
    const submitted = await provider.submitDebit({
      amount: 100n,
      currency: "CNY",
      providerMandateId: "mock-mandate-2",
      providerOutTradeNo: `DEBIT-${nextResult}`,
      subject: "月租账单"
    });
    const persistedSnapshot = provider.withNextDebitResult(
      submitted.providerSnapshot,
      nextResult
    );

    const restartedProvider = new MockAutoDebitProvider();
    await expect(
      restartedProvider.queryDebit({
        providerOutTradeNo: submitted.providerOutTradeNo,
        providerSnapshot: persistedSnapshot,
        providerTransactionId: submitted.providerTransactionId
      })
    ).resolves.toMatchObject({
      confirmedAmount: nextResult === "SUCCEEDED" ? 100n : 0n,
      status: nextResult
    });
  });

  it("revokes a mandate without erasing its provider identity", async () => {
    const provider = new MockAutoDebitProvider();
    const created = await provider.createMandate({
      customerId: "customer-2",
      mandateNo: "MDT-2",
      orderId: "order-2",
      providerTemplateId: "mock-template"
    });

    await expect(
      provider.revokeMandate({
        providerMandateId: created.providerMandateId,
        providerSnapshot: created.providerSnapshot
      })
    ).resolves.toMatchObject({
      providerMandateId: created.providerMandateId,
      status: "REVOKED"
    });
  });
});
