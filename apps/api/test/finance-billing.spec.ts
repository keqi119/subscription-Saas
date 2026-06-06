import {
  ApplicationStatus,
  BillStatus,
  BillType,
  BusinessType,
  DepositStatus,
  DepositTransactionStatus,
  DepositTransactionType,
  OrderSource,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  QuoteStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { FinanceService } from "../src/finance/finance.service";

describe("billing finance minimum backend loop", () => {
  it("generates DEPOSIT and FIRST_MONTHLY_FEE receivable bills for an order", async () => {
    const harness = createFinanceHarness();

    const result = (await harness.service.generateInitialBills(
      harness.orderId,
      harness.user,
      harness.context
    )) as { bills: Array<{ amount: number; billStatus: BillStatus; billType: BillType }>; createdCount: number };

    expect(result.createdCount).toBe(2);
    expect(result.bills.map((bill) => bill.billType)).toEqual([
      BillType.DEPOSIT,
      BillType.FIRST_MONTHLY_FEE
    ]);
    expect(result.bills.map((bill) => bill.amount)).toEqual([500000, 300000]);
    expect(result.bills.every((bill) => bill.billStatus === BillStatus.PENDING)).toBe(true);
  });

  it("does not create duplicate active initial bills", async () => {
    const harness = createFinanceHarness();

    await harness.service.generateInitialBills(harness.orderId, harness.user, harness.context);
    const second = (await harness.service.generateInitialBills(
      harness.orderId,
      harness.user,
      harness.context
    )) as { bills: unknown[]; createdCount: number };

    expect(second.createdCount).toBe(0);
    expect(second.bills).toHaveLength(2);
    expect(harness.state.bills).toHaveLength(2);
  });

  it("throws a Chinese error when deposit amount is missing", async () => {
    const harness = createFinanceHarness({
      depositAmount: 0n,
      finalDepositAmount: null,
      quoteSnapshot: {}
    });

    await expect(
      harness.service.generateInitialBills(harness.orderId, harness.user, harness.context)
    ).rejects.toThrow("订单缺少押金金额，无法生成应收账单");
  });

  it("throws a Chinese error when first monthly fee amount is missing", async () => {
    const harness = createFinanceHarness({
      monthlyFeeAmount: 0n,
      quoteSnapshot: { depositAmount: 500000 }
    });

    await expect(
      harness.service.generateInitialBills(harness.orderId, harness.user, harness.context)
    ).rejects.toThrow("订单缺少首期月费金额，无法生成应收账单");
  });

  it("creates a confirmed payment record", async () => {
    const harness = createFinanceHarness();

    const payment = (await harness.service.createPayment(
      validPaymentDto(harness),
      harness.user,
      harness.context
    )) as { paymentAmount: number; paymentMethod: PaymentMethod; paymentStatus: PaymentStatus; remainingAmount: number };

    expect(payment.paymentAmount).toBe(800000);
    expect(payment.remainingAmount).toBe(800000);
    expect(payment.paymentMethod).toBe(PaymentMethod.BANK_TRANSFER);
    expect(payment.paymentStatus).toBe(PaymentStatus.CONFIRMED);
    expect(harness.state.payments).toHaveLength(1);
  });

  it("writes off one payment to one bill", async () => {
    const harness = createFinanceHarness();
    await harness.service.generateInitialBills(harness.orderId, harness.user, harness.context);
    const payment = await harness.createPayment(500000);
    const depositBill = harness.findBill(BillType.DEPOSIT);

    const result = (await harness.service.writeOffPayment(
      payment.id,
      { items: [{ billId: depositBill.id, writeOffAmount: 500000 }], remark: "核销押金" },
      harness.user,
      harness.context
    )) as { bills: Array<{ billStatus: BillStatus; paidAmount: number; remainingAmount: number }>; writeOffs: unknown[] };

    expect(result.writeOffs).toHaveLength(1);
    expect(result.bills[0]).toMatchObject({
      billStatus: BillStatus.PAID,
      paidAmount: 500000,
      remainingAmount: 0
    });
  });

  it("writes off one payment to multiple bills", async () => {
    const harness = createFinanceHarness();
    await harness.service.generateInitialBills(harness.orderId, harness.user, harness.context);
    const payment = await harness.createPayment(800000);
    const depositBill = harness.findBill(BillType.DEPOSIT);
    const firstMonthlyFeeBill = harness.findBill(BillType.FIRST_MONTHLY_FEE);

    const result = (await harness.service.writeOffPayment(
      payment.id,
      {
        items: [
          { billId: depositBill.id, writeOffAmount: 500000 },
          { billId: firstMonthlyFeeBill.id, writeOffAmount: 300000 }
        ],
        remark: "核销押金和首期月费"
      },
      harness.user,
      harness.context
    )) as { bills: Array<{ billStatus: BillStatus }>; payment: { remainingAmount: number }; writeOffs: unknown[] };

    expect(result.writeOffs).toHaveLength(2);
    expect(result.bills.map((bill) => bill.billStatus)).toEqual([BillStatus.PAID, BillStatus.PAID]);
    expect(result.payment.remainingAmount).toBe(0);
  });

  it("rejects write-off amounts greater than the payment remaining amount", async () => {
    const harness = createFinanceHarness();
    await harness.service.generateInitialBills(harness.orderId, harness.user, harness.context);
    const payment = await harness.createPayment(300000);
    const depositBill = harness.findBill(BillType.DEPOSIT);

    await expect(
      harness.service.writeOffPayment(
        payment.id,
        { items: [{ billId: depositBill.id, writeOffAmount: 500000 }] },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("核销金额不能超过收款剩余金额");
  });

  it("rejects write-off amounts greater than the bill remaining amount", async () => {
    const harness = createFinanceHarness();
    await harness.service.generateInitialBills(harness.orderId, harness.user, harness.context);
    const payment = await harness.createPayment(900000);
    const firstMonthlyFeeBill = harness.findBill(BillType.FIRST_MONTHLY_FEE);

    await expect(
      harness.service.writeOffPayment(
        payment.id,
        { items: [{ billId: firstMonthlyFeeBill.id, writeOffAmount: 400000 }] },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("核销金额不能超过账单剩余金额");
  });

  it("marks partially written-off bills as PARTIALLY_PAID", async () => {
    const harness = createFinanceHarness();
    await harness.service.generateInitialBills(harness.orderId, harness.user, harness.context);
    const payment = await harness.createPayment(200000);
    const depositBill = harness.findBill(BillType.DEPOSIT);

    await harness.service.writeOffPayment(
      payment.id,
      { items: [{ billId: depositBill.id, writeOffAmount: 200000 }] },
      harness.user,
      harness.context
    );

    expect(harness.findBill(BillType.DEPOSIT)).toMatchObject({
      billStatus: BillStatus.PARTIALLY_PAID,
      paidAmount: 200000n,
      remainingAmount: 300000n
    });
  });

  it("marks fully written-off bills as PAID", async () => {
    const harness = createFinanceHarness();
    await harness.service.generateInitialBills(harness.orderId, harness.user, harness.context);
    const payment = await harness.createPayment(300000);
    const firstMonthlyFeeBill = harness.findBill(BillType.FIRST_MONTHLY_FEE);

    await harness.service.writeOffPayment(
      payment.id,
      { items: [{ billId: firstMonthlyFeeBill.id, writeOffAmount: 300000 }] },
      harness.user,
      harness.context
    );

    expect(harness.findBill(BillType.FIRST_MONTHLY_FEE)).toMatchObject({
      billStatus: BillStatus.PAID,
      paidAmount: 300000n,
      remainingAmount: 0n
    });
  });

  it("creates a confirmed deposit COLLECT ledger when the deposit bill is fully written off", async () => {
    const harness = createFinanceHarness();
    await harness.service.generateInitialBills(harness.orderId, harness.user, harness.context);
    const payment = await harness.createPayment(500000);
    const depositBill = harness.findBill(BillType.DEPOSIT);

    const result = (await harness.service.writeOffPayment(
      payment.id,
      { items: [{ billId: depositBill.id, writeOffAmount: 500000 }] },
      harness.user,
      harness.context
    )) as { depositLedgers: Array<{ amount: number; balanceAfter: number; transactionType: DepositTransactionType }> };

    expect(result.depositLedgers).toEqual([
      expect.objectContaining({
        amount: 500000,
        balanceAfter: 500000,
        transactionType: DepositTransactionType.COLLECT
      })
    ]);
    expect(harness.state.depositLedgers[0]).toMatchObject({
      amount: 500000n,
      balanceAfter: 500000n,
      transactionStatus: DepositTransactionStatus.CONFIRMED,
      transactionType: DepositTransactionType.COLLECT
    });
  });

  it("returns the order finance summary for deposit and first monthly fee status", async () => {
    const harness = createFinanceHarness();
    await harness.service.generateInitialBills(harness.orderId, harness.user, harness.context);
    const payment = await harness.createPayment(800000);
    const depositBill = harness.findBill(BillType.DEPOSIT);
    const firstMonthlyFeeBill = harness.findBill(BillType.FIRST_MONTHLY_FEE);

    await harness.service.writeOffPayment(
      payment.id,
      {
        items: [
          { billId: depositBill.id, writeOffAmount: 500000 },
          { billId: firstMonthlyFeeBill.id, writeOffAmount: 300000 }
        ]
      },
      harness.user,
      harness.context
    );

    const summary = (await harness.service.getOrderFinanceSummary(harness.orderId, harness.user)) as {
      deliveryPaymentSatisfied: boolean;
      depositPaidAmount: number;
      depositStatus: BillStatus;
      firstMonthlyFeePaidAmount: number;
      firstMonthlyFeeStatus: BillStatus;
      totalPaidAmount: number;
      totalReceivableAmount: number;
    };

    expect(summary).toMatchObject({
      deliveryPaymentSatisfied: true,
      depositPaidAmount: 500000,
      depositStatus: BillStatus.PAID,
      firstMonthlyFeePaidAmount: 300000,
      firstMonthlyFeeStatus: BillStatus.PAID,
      totalPaidAmount: 800000,
      totalReceivableAmount: 800000
    });
  });

  it("writes audit logs for bill generation, payment creation, write-off, and deposit ledger", async () => {
    const harness = createFinanceHarness();
    await harness.service.generateInitialBills(harness.orderId, harness.user, harness.context);
    const payment = await harness.createPayment(500000);
    const depositBill = harness.findBill(BillType.DEPOSIT);

    await harness.service.writeOffPayment(
      payment.id,
      { items: [{ billId: depositBill.id, writeOffAmount: 500000 }] },
      harness.user,
      harness.context
    );

    const entityTypes = harness.auditService.write.mock.calls.map(([entry]) => entry.entityType);
    expect(entityTypes).toEqual(
      expect.arrayContaining(["receivable_bill", "payment_record", "payment_write_off", "deposit_ledger"])
    );
  });
});

function validPaymentDto(harness: ReturnType<typeof createFinanceHarness>, paymentAmount = 800000) {
  return {
    customerId: harness.customerId,
    orderId: harness.orderId,
    payerAccount: "招商银行 6222****",
    payerName: "张三",
    paymentAmount,
    paymentMethod: PaymentMethod.BANK_TRANSFER,
    paymentProofUrls: [],
    receivedAt: "2026-06-10T10:00:00+08:00",
    remark: "客户转账"
  };
}

function createFinanceHarness(orderOverrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-06T08:00:00.000Z");
  const orderId = "order-1";
  const customerId = "customer-1";
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: ["ADMIN"],
    username: "admin"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const state = {
    bills: [] as Array<Record<string, unknown>>,
    depositLedgers: [] as Array<Record<string, unknown>>,
    order: {
      actualDeliveryAt: null,
      actualReturnAt: null,
      application: {
        applicationNo: "APP202606060001",
        id: "application-1",
        salesUserId: user.id,
        status: ApplicationStatus.APPROVED
      },
      applicationId: "application-1",
      businessType: BusinessType.SUBSCRIPTION,
      contractId: null,
      createdAt: now,
      createdBy: user.id,
      customer: { grade: "A", id: customerId, mobile: "13800000000", name: "测试客户" },
      customerId,
      customerConfirmedAt: null,
      customerSelectedSnapshot: null,
      deletedAt: null,
      depositAmount: 500000n,
      depositStatus: DepositStatus.CONFIRMED,
      endDate: null,
      energyLimitCount: null,
      energyLimitKwh: null,
      finalDepositAmount: 500000n,
      finalPlanConfirmedAt: null,
      finalPlanSnapshot: null,
      id: orderId,
      mileageLimitKm: 1500,
      monthlyFeeAmount: 300000n,
      orderNo: "ORD2026060600001",
      orderSource: OrderSource.SALES_ASSISTED,
      orderStatus: OrderStatus.PENDING_PAYMENT,
      overMileageFeeAmount: 100n,
      periodMonths: 12,
      productId: "product-1",
      productVersionId: "product-version-1",
      quote: { id: "quote-1", quoteNo: "QUO2026060600001", status: QuoteStatus.CONFIRMED },
      quoteId: "quote-1",
      quoteSnapshot: {
        depositAmount: 500000,
        monthlyFeeAmount: 300000,
        pricing: { depositAmount: 500000, monthlyFeeAmount: 300000 }
      },
      reviewComment: null,
      riskResultId: null,
      startDate: null,
      updatedAt: now,
      updatedBy: user.id,
      vehicleId: "vehicle-1",
      vehicleModel: "ET5",
      vehiclePurchasePriceAmount: 10000000n,
      ...orderOverrides
    },
    payments: [] as Array<Record<string, unknown>>,
    writeOffs: [] as Array<Record<string, unknown>>
  };

  const client = {
    depositLedger: {
      create: vi.fn(async ({ data }) => {
        const ledger = {
          ...data,
          createdAt: now,
          deletedAt: null,
          id: `ledger-${state.depositLedgers.length + 1}`
        };
        state.depositLedgers.push(ledger);
        return ledger;
      }),
      findFirst: vi.fn(async ({ where }) =>
        state.depositLedgers.find(
          (ledger) =>
            ledger.billId === where.billId &&
            ledger.deletedAt === where.deletedAt &&
            ledger.transactionType === where.transactionType
        ) ?? null
      ),
      findMany: vi.fn(async ({ where }) =>
        state.depositLedgers.filter(
          (ledger) =>
            ledger.customerId === where.customerId &&
            ledger.orderId === where.orderId &&
            ledger.deletedAt === where.deletedAt &&
            ledger.transactionStatus === where.transactionStatus
        )
      )
    },
    paymentRecord: {
      create: vi.fn(async ({ data }) => {
        const payment = {
          ...data,
          createdAt: now,
          deletedAt: null,
          id: `payment-${state.payments.length + 1}`,
          updatedAt: now
        };
        state.payments.push(payment);
        return payment;
      }),
      findUnique: vi.fn(async ({ include, where }) => {
        const payment = state.payments.find((item) => item.id === where.id);
        return payment ? decoratePayment(payment, include) : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ include, where }) => {
        const payment = state.payments.find((item) => item.id === where.id);
        if (!payment) {
          throw new Error("Payment not found");
        }
        return decoratePayment(payment, include);
      })
    },
    paymentWriteOff: {
      create: vi.fn(async ({ data }) => {
        const writeOff = {
          ...data,
          createdAt: now,
          deletedAt: null,
          id: `writeoff-${state.writeOffs.length + 1}`
        };
        state.writeOffs.push(writeOff);
        return writeOff;
      })
    },
    receivableBill: {
      create: vi.fn(async ({ data }) => {
        const bill = {
          ...data,
          cancelledAt: null,
          createdAt: now,
          deletedAt: null,
          id: `bill-${state.bills.length + 1}`,
          paidAt: null,
          remark: null,
          updatedAt: now
        };
        state.bills.push(bill);
        return bill;
      }),
      findMany: vi.fn(async ({ where }) => filterBills(state.bills, where)),
      update: vi.fn(async ({ data, where }) => {
        const bill = state.bills.find((item) => item.id === where.id);
        if (!bill) {
          throw new Error("Bill not found");
        }
        Object.assign(bill, data, { updatedAt: now });
        return bill;
      })
    },
    subscriptionOrder: {
      findUnique: vi.fn(async ({ where }) => (where.id === orderId ? state.order : null))
    }
  };

  const prisma = {
    ...client,
    $transaction: vi.fn(async (callback) => callback(client))
  };
  const auditService = {
    write: vi.fn(async (entry: Record<string, unknown>) => {
      void entry;
    })
  };
  const service = new FinanceService(auditService as never, prisma as never);

  function findBill(billType: BillType) {
    const bill = state.bills.find((item) => item.billType === billType);
    if (!bill) {
      throw new Error(`Bill ${billType} not found`);
    }
    return bill as { id: string; billStatus: BillStatus; paidAmount: bigint; remainingAmount: bigint };
  }

  async function createPayment(paymentAmount: number) {
    await service.createPayment(validPaymentDto(harness, paymentAmount), user, context);
    return state.payments.at(-1)! as { id: string };
  }

  const harness = {
    auditService,
    context,
    createPayment,
    customerId,
    findBill,
    orderId,
    prisma,
    service,
    state,
    user
  };

  return harness;

  function decoratePayment(payment: Record<string, unknown>, include: Record<string, unknown> | undefined) {
    return {
      ...payment,
      ...(include?.writeOffs ? { writeOffs: state.writeOffs.filter((item) => item.paymentId === payment.id) } : {}),
      ...(include?.order ? { order: state.order } : {})
    };
  }
}

function filterBills(bills: Array<Record<string, unknown>>, where: Record<string, unknown> = {}) {
  return bills.filter((bill) => {
    if (where.orderId && bill.orderId !== where.orderId) {
      return false;
    }
    if ("deletedAt" in where && bill.deletedAt !== where.deletedAt) {
      return false;
    }
    if (where.billType && !matchesScalarFilter(bill.billType, where.billType)) {
      return false;
    }
    if (where.billStatus && !matchesScalarFilter(bill.billStatus, where.billStatus)) {
      return false;
    }
    if (where.id && !matchesScalarFilter(bill.id, where.id)) {
      return false;
    }
    return true;
  });
}

function matchesScalarFilter(value: unknown, filter: unknown) {
  if (typeof filter !== "object" || filter === null) {
    return value === filter;
  }

  const record = filter as { in?: unknown[]; not?: unknown };
  if (record.in) {
    return record.in.includes(value);
  }
  if (record.not) {
    return value !== record.not;
  }
  return true;
}
