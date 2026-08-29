import {
  PaymentChannel,
  PaymentOrderStatus,
  PaymentProviderType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  calculateWriteOffAmount,
  FinanceService
} from "../src/finance/finance.service";

describe("payment settlement allocation", () => {
  it("allocates no more than the bill or payment remainder", () => {
    expect(calculateWriteOffAmount(100n, 60n, 80n)).toBe(60n);
    expect(calculateWriteOffAmount(100n, 120n, 80n)).toBe(80n);
  });

  it("preserves a later receipt as unallocated when the bill is settled", () => {
    expect(calculateWriteOffAmount(100n, 0n, 100n)).toBe(0n);
  });

  it("rejects negative ledger amounts", () => {
    expect(() => calculateWriteOffAmount(100n, -1n, 100n)).toThrow(
      "Settlement amounts cannot be negative."
    );
  });

  it("publishes PAYMENT_SETTLED in the authoritative settlement transaction", async () => {
    const paidAt = new Date("2026-08-06T08:00:00.000Z");
    const paymentOrder = {
      amount: 1000n,
      customerId: "customer-1",
      deletedAt: null,
      id: "payment-order-1",
      items: [],
      orderId: "order-1",
      paidAmount: 0n,
      paymentChannel: PaymentChannel.WECHAT_JSAPI,
      paymentOrderNo: "PYO-1",
      paymentRecordId: null,
      paymentStatus: PaymentOrderStatus.PENDING,
      provider: PaymentProviderType.WECHAT_PAY,
      providerTradeNo: "trade-1",
      providerTransactionId: null
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: paymentOrder.id }]),
      paymentOrder: {
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => paymentOrder),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...paymentOrder,
          ...data
        }))
      },
      paymentRecord: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          id: "payment-record-1",
          paymentNo: "PAY-1"
        }))
      },
      receivableBill: {
        findMany: vi.fn(async () => [])
      }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: unknown) => unknown) =>
        operation(tx)
      )
    };
    const journeySignal = { record: vi.fn(async () => undefined) };
    const service = new FinanceService(
      { write: vi.fn(async () => undefined) } as never,
      prisma as never,
      journeySignal as never
    );

    await expect(
      service.settlePaymentOrder({
        operatorId: null,
        paidAmount: 1000n,
        paidAt,
        paymentOrderId: paymentOrder.id,
        providerTransactionId: "wechat-transaction-1"
      })
    ).resolves.toMatchObject({
      allocatedAmount: 0n,
      idempotent: false,
      unallocatedAmount: 1000n
    });
    expect(journeySignal.record).toHaveBeenCalledWith(tx, {
      eventKey: "payment-order:payment-order-1:settled",
      orderId: "order-1",
      payload: {
        allocatedAmount: "0",
        paymentOrderId: "payment-order-1",
        paymentRecordId: "payment-record-1",
        providerTransactionId: "wechat-transaction-1",
        unallocatedAmount: "1000"
      },
      type: "PAYMENT_SETTLED"
    });
  });

  it("records a late provider receipt as unallocated when closure authority blocks the bill", async () => {
    const paymentOrder = {
      amount: 1000n,
      customerId: "customer-1",
      deletedAt: null,
      id: "payment-order-1",
      items: [{ amount: 1000n, billId: "bill-1", createdAt: new Date(), deletedAt: null }],
      orderId: "order-1",
      paidAmount: 0n,
      paymentChannel: PaymentChannel.WECHAT_JSAPI,
      paymentOrderNo: "PYO-1",
      paymentRecordId: null,
      paymentStatus: PaymentOrderStatus.PENDING,
      provider: PaymentProviderType.WECHAT_PAY,
      providerTradeNo: "trade-1",
      providerTransactionId: null
    };
    const bill = {
      billStatus: "PENDING",
      customerId: "customer-1",
      deletedAt: null,
      dueDate: new Date("2026-08-01T00:00:00.000Z"),
      id: "bill-1",
      orderId: "order-1",
      paidAmount: 0n,
      remainingAmount: 1000n
    };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      collectionCase: { findMany: vi.fn(async () => []) },
      paymentCallbackLog: { update: vi.fn() },
      paymentOrder: {
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => paymentOrder),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...paymentOrder,
          ...data
        }))
      },
      paymentRecord: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          id: "payment-record-1",
          paymentNo: "PAY-1"
        }))
      },
      paymentWriteOff: { create: vi.fn() },
      receivableBill: {
        findFirst: vi.fn(async () => bill),
        findMany: vi.fn(async () => [bill])
      },
      subscriptionClosureChargeDispute: {
        findMany: vi.fn(async () => [{ chargeLine: { billId: "bill-1" } }])
      },
      subscriptionClosureLegalCollectionCase: { findMany: vi.fn(async () => []) },
      subscriptionClosureReceivableDisposition: { findMany: vi.fn(async () => []) }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: unknown) => unknown) => operation(tx))
    };
    const service = new FinanceService(
      { write: vi.fn(async () => undefined) } as never,
      prisma as never
    );

    await expect(
      service.settlePaymentOrder({
        operatorId: null,
        paidAmount: 1000n,
        paidAt: new Date("2026-08-06T08:00:00.000Z"),
        paymentOrderId: paymentOrder.id,
        providerTransactionId: "wechat-transaction-late"
      })
    ).resolves.toMatchObject({ allocatedAmount: 0n, unallocatedAmount: 1000n });
    expect(tx.paymentWriteOff.create).not.toHaveBeenCalled();
    expect(tx.paymentOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorSnapshot: expect.objectContaining({
            code: "PAYMENT_ALLOCATION_BLOCKED_BY_CLOSURE",
            blockedBillIds: ["bill-1"]
          })
        })
      })
    );
  });
});
