import {
  ApplicationStatus,
  BillStatus,
  BillType,
  BusinessType,
  CollectionActionResult,
  CollectionActionType,
  CollectionCaseStatus,
  CollectionLevel,
  ContactMethod,
  ContractStatus,
  DepositStatus,
  DepositTransactionStatus,
  DepositTransactionType,
  OrderSource,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  QuoteStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType,
  VehicleDamageLevel,
  VehicleDamageResponsibleParty,
  VehicleDamageType,
  VehicleReturnDamageStatus,
  VehicleReturnStatus,
  VehicleReturnType
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

  it("requires an archived contract before generating initial bills", async () => {
    const harness = createFinanceHarness({
      contract: {
        fileId: null,
        id: "contract-1",
        status: ContractStatus.SIGNED
      }
    });

    await expect(
      harness.service.generateInitialBillsInTransaction(
        harness.transactionClient as never,
        harness.orderId,
        harness.user.id,
        "journey:journey-1:step:INITIAL_BILLING:revision:1"
      )
    ).rejects.toThrow("Initial bills require an archived contract.");
    expect(harness.state.bills).toHaveLength(0);
  });

  it("creates exact source-keyed initial bills once from the final plan snapshot", async () => {
    const harness = createFinanceHarness({
      depositAmount: 1n,
      finalDepositAmount: 1n,
      finalPlanSnapshot: {
        depositAmount: 620000,
        pricing: { monthlyFeeAmount: 315000 }
      },
      monthlyFeeAmount: 1n,
      quoteSnapshot: {
        depositAmount: 2,
        monthlyFeeAmount: 2
      }
    });
    const sourceKey = "journey:journey-1:step:INITIAL_BILLING:revision:1";

    const first = await harness.service.generateInitialBillsInTransaction(
      harness.transactionClient as never,
      harness.orderId,
      harness.user.id,
      sourceKey
    );
    const second = await harness.service.generateInitialBillsInTransaction(
      harness.transactionClient as never,
      harness.orderId,
      harness.user.id,
      sourceKey
    );

    expect(first.map((bill) => bill.amount)).toEqual([620000n, 315000n]);
    expect(first.map((bill) => bill.sourceKey)).toEqual([
      `${sourceKey}:${BillType.DEPOSIT}`,
      `${sourceKey}:${BillType.FIRST_MONTHLY_FEE}`
    ]);
    expect(second.map((bill) => bill.id)).toEqual(first.map((bill) => bill.id));
    expect(harness.state.bills).toHaveLength(2);
  });

  it("rejects an active initial bill that conflicts with the final plan snapshot", async () => {
    const harness = createFinanceHarness();
    const sourceKey = "journey:journey-1:step:INITIAL_BILLING:revision:1";
    await harness.service.generateInitialBillsInTransaction(
      harness.transactionClient as never,
      harness.orderId,
      harness.user.id,
      sourceKey
    );
    harness.state.bills[0]!.amount = 499999n;

    await expect(
      harness.service.generateInitialBillsInTransaction(
        harness.transactionClient as never,
        harness.orderId,
        harness.user.id,
        sourceKey
      )
    ).rejects.toThrow("does not match the final plan snapshot");
  });

  it("derives partial, full, and missing initial-bill settlement from bill authority", async () => {
    const harness = createFinanceHarness();

    await expect(
      harness.service.evaluateInitialBillSettlement(
        harness.transactionClient as never,
        harness.orderId
      )
    ).resolves.toEqual({ paid: false, remainingAmount: 800000n });

    await harness.service.generateInitialBillsInTransaction(
      harness.transactionClient as never,
      harness.orderId,
      harness.user.id,
      "journey:journey-1:step:INITIAL_BILLING:revision:1"
    );
    Object.assign(harness.findBill(BillType.DEPOSIT), {
      billStatus: BillStatus.PARTIALLY_PAID,
      paidAmount: 200000n,
      remainingAmount: 300000n
    });
    await expect(
      harness.service.evaluateInitialBillSettlement(
        harness.transactionClient as never,
        harness.orderId
      )
    ).resolves.toEqual({ paid: false, remainingAmount: 600000n });

    for (const bill of harness.state.bills) {
      Object.assign(bill, {
        billStatus: BillStatus.PAID,
        paidAmount: bill.amount,
        remainingAmount: 0n
      });
    }
    await expect(
      harness.service.evaluateInitialBillSettlement(
        harness.transactionClient as never,
        harness.orderId
      )
    ).resolves.toEqual({ paid: true, remainingAmount: 0n });
  });

  it("throws a Chinese error when deposit amount is missing", async () => {
    const harness = createFinanceHarness({
      depositAmount: null,
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

  it("cancels pending billing jobs when a bill is fully settled", async () => {
    const harness = createFinanceHarness();
    await harness.service.generateInitialBills(
      harness.orderId,
      harness.user,
      harness.context
    );
    const payment = await harness.createPayment(300000);
    const bill = harness.findBill(BillType.FIRST_MONTHLY_FEE);
    const cancellableTypes = [
      SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE,
      SubscriptionAutomationJobType.MARK_BILL_OVERDUE,
      SubscriptionAutomationJobType.SEND_BILL_OVERDUE_NOTICE
    ];
    for (const [index, jobType] of cancellableTypes.entries()) {
      harness.state.automationJobs.push({
        billId: bill.id,
        id: `automation-job-${index + 1}`,
        jobStatus: SubscriptionAutomationJobStatus.PENDING,
        jobType
      });
    }
    harness.state.automationJobs.push({
      billId: bill.id,
      id: "automation-job-completed",
      jobStatus: SubscriptionAutomationJobStatus.COMPLETED,
      jobType: SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE
    });

    await harness.service.writeOffPayment(
      payment.id,
      {
        items: [
          { billId: bill.id, writeOffAmount: 300000 }
        ]
      },
      harness.user,
      harness.context
    );

    expect(
      harness.state.automationJobs
        .filter((job) => job.id !== "automation-job-completed")
        .map((job) => job.jobStatus)
    ).toEqual([
      SubscriptionAutomationJobStatus.CANCELLED,
      SubscriptionAutomationJobStatus.CANCELLED,
      SubscriptionAutomationJobStatus.CANCELLED
    ]);
    expect(
      harness.state.automationJobs.find(
        (job) => job.id === "automation-job-completed"
      )?.jobStatus
    ).toBe(SubscriptionAutomationJobStatus.COMPLETED);
  });

  it("cancels the pending recovery assessment after every overdue bill settles despite a future bill", async () => {
    const harness = createFinanceHarness();
    const firstBill = addReceivableBill(harness, { dueDate: dateOnly("2026-06-01") });
    const secondBill = addReceivableBill(harness, { dueDate: dateOnly("2026-06-02") });
    addReceivableBill(harness, { dueDate: dateOnly("2099-06-30") });
    await harness.service.refreshOverdueBills(
      { asOfDate: "2026-06-06" },
      harness.user,
      harness.context
    );
    harness.state.automationJobs.push({
      billId: firstBill.id,
      id: "recovery-assessment-job",
      jobStatus: SubscriptionAutomationJobStatus.PENDING,
      jobType: SubscriptionAutomationJobType.CLOSURE_RECOVERY_ASSESSMENT_D7,
      orderId: harness.orderId
    });

    const firstPayment = await harness.createPayment(300000);
    await harness.service.writeOffPayment(
      firstPayment.id,
      { items: [{ billId: firstBill.id, writeOffAmount: 300000 }] },
      harness.user,
      harness.context
    );
    expect(harness.state.automationJobs[0]?.jobStatus).toBe(
      SubscriptionAutomationJobStatus.PENDING
    );

    const secondPayment = await harness.createPayment(300000);
    await harness.service.writeOffPayment(
      secondPayment.id,
      { items: [{ billId: secondBill.id, writeOffAmount: 300000 }] },
      harness.user,
      harness.context
    );
    expect(harness.state.automationJobs[0]?.jobStatus).toBe(
      SubscriptionAutomationJobStatus.CANCELLED
    );
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

  it("generates only the first monthly fee initial bill when required deposit is zero", async () => {
    const harness = createFinanceHarness({
      depositAmount: 0n,
      finalDepositAmount: 0n,
      quoteSnapshot: {
        depositAmount: 0,
        finalDepositAmount: 0,
        monthlyFeeAmount: 300000,
        pricing: { depositAmount: 0, monthlyFeeAmount: 300000 }
      }
    });

    const result = (await harness.service.generateInitialBills(
      harness.orderId,
      harness.user,
      harness.context
    )) as { createdCount: number };
    const summary = (await harness.service.getOrderFinanceSummary(harness.orderId, harness.user)) as {
      depositReceivableAmount: number;
      depositStatus: BillStatus;
      firstMonthlyFeeReceivableAmount: number;
    };

    expect(result.createdCount).toBe(1);
    expect(harness.state.bills.map((bill) => bill.billType)).toEqual([BillType.FIRST_MONTHLY_FEE]);
    expect(summary.depositReceivableAmount).toBe(0);
    expect(summary.depositStatus).toBe(BillStatus.PAID);
    expect(summary.firstMonthlyFeeReceivableAmount).toBe(300000);
  });

  it("distinguishes registered receipts from bill write-off in the finance summary", async () => {
    const harness = createFinanceHarness();
    await harness.service.generateInitialBills(harness.orderId, harness.user, harness.context);
    await harness.createPayment(300000);

    const summary = (await harness.service.getOrderFinanceSummary(harness.orderId, harness.user)) as {
      allocatedPaidAmount: number;
      deliveryPaymentSatisfied: boolean;
      deliveryPaymentStatus: string;
      registeredReceiptAmount: number;
      unallocatedReceiptAmount: number;
    };

    expect(summary).toMatchObject({
      allocatedPaidAmount: 0,
      deliveryPaymentSatisfied: false,
      deliveryPaymentStatus: "REGISTERED_UNALLOCATED",
      registeredReceiptAmount: 300000,
      unallocatedReceiptAmount: 300000
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

  it("generates the next MONTHLY_RENT bill for an ACTIVE started order", async () => {
    const harness = createFinanceHarness();
    activateMonthlyOrder(harness);

    const bill = (await harness.service.generateNextMonthlyRentBill(
      harness.orderId,
      harness.user,
      harness.context
    )) as {
      amount: number;
      billPeriodEnd: string;
      billPeriodStart: string;
      billStatus: BillStatus;
      billType: BillType;
      created: boolean;
      dueDate: string;
      sourceKey: string;
    };

    expect(bill).toMatchObject({
      amount: 300000,
      billPeriodEnd: "2026-08-09",
      billPeriodStart: "2026-07-10",
      billStatus: BillStatus.PENDING,
      billType: BillType.MONTHLY_RENT,
      created: true,
      dueDate: "2026-07-10T00:00:00.000Z",
      sourceKey: "monthly-rent:order-1:2026-07-10"
    });
  });

  it("creates one source-keyed monthly rent bill for an automation cycle", async () => {
    const harness = createFinanceHarness();
    activateMonthlyOrder(harness);
    const input = {
      actorId: null,
      contractSegmentId: "segment-extension-1",
      cycleNo: 1,
      monthlyRentAmount: 880000n,
      orderId: harness.orderId,
      periodEnd: dateOnly("2026-08-09"),
      periodStart: dateOnly("2026-07-10"),
      sourceKey: "monthly-rent:order-1:2026-07-10"
    };

    const first = await harness.service.generateMonthlyRentBillForCycle(
      harness.prisma as never,
      input
    );
    const second = await harness.service.generateMonthlyRentBillForCycle(
      harness.prisma as never,
      input
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.bill.id).toBe(first.bill.id);
    expect(harness.state.bills).toHaveLength(1);
    expect(harness.state.bills[0]).toMatchObject({
      amount: 880000n,
      billPeriodEnd: dateOnly("2026-08-09"),
      billPeriodStart: dateOnly("2026-07-10"),
      dueDate: dateOnly("2026-07-10"),
      snapshot: expect.objectContaining({
        contractSegmentId: "segment-extension-1"
      }),
      sourceKey: "monthly-rent:order-1:2026-07-10"
    });
  });

  it("marks a D+5 monthly bill overdue and creates one collection link", async () => {
    const harness = createFinanceHarness();
    activateMonthlyOrder(harness);
    const input = {
      actorId: null,
      cycleNo: 1,
      orderId: harness.orderId,
      periodEnd: dateOnly("2026-08-09"),
      periodStart: dateOnly("2026-07-10"),
      sourceKey: "monthly-rent:order-1:2026-07-10"
    };
    const generated =
      await harness.service.generateMonthlyRentBillForCycle(
        harness.prisma as never,
        input
      );

    const first = await harness.service.markBillOverdueForAutomation(
      harness.prisma as never,
      generated.bill.id,
      dateOnly("2026-07-15")
    );
    const second = await harness.service.markBillOverdueForAutomation(
      harness.prisma as never,
      generated.bill.id,
      dateOnly("2026-07-15")
    );

    expect(first.action).toBe("MARKED_OVERDUE");
    expect(second.action).toBe("ALREADY_OVERDUE");
    expect(harness.state.bills[0]?.billStatus).toBe(BillStatus.OVERDUE);
    expect(harness.state.collectionCases).toHaveLength(1);
    expect(harness.state.collectionCaseBills).toHaveLength(1);
  });

  it("re-reads a bill after locking so concurrent settlement wins over overdue marking", async () => {
    const harness = createFinanceHarness();
    activateMonthlyOrder(harness);
    const generated =
      await harness.service.generateMonthlyRentBillForCycle(
        harness.prisma as never,
        {
          actorId: null,
          cycleNo: 1,
          orderId: harness.orderId,
          periodEnd: dateOnly("2026-08-09"),
          periodStart: dateOnly("2026-07-10"),
          sourceKey: "monthly-rent:order-1:2026-07-10"
        }
      );
    harness.prisma.$queryRaw.mockImplementationOnce(async () => {
      Object.assign(harness.state.bills[0]!, {
        billStatus: BillStatus.PAID,
        paidAmount: 300000n,
        remainingAmount: 0n
      });
      return [{ id: generated.bill.id }];
    });

    const result = await harness.service.markBillOverdueForAutomation(
      harness.prisma as never,
      generated.bill.id,
      dateOnly("2026-07-15")
    );

    expect(result.action).toBe("SKIPPED_SETTLED");
    expect(harness.state.bills[0]).toMatchObject({
      billStatus: BillStatus.PAID,
      remainingAmount: 0n
    });
    expect(harness.state.collectionCases).toHaveLength(0);
  });

  it("rejects monthly rent generation when order is not ACTIVE", async () => {
    const harness = createFinanceHarness();

    await expect(
      harness.service.generateNextMonthlyRentBill(harness.orderId, harness.user, harness.context)
    ).rejects.toThrow("当前订单状态不允许生成月租账单");
  });

  it("rejects monthly rent generation when the order has not started", async () => {
    const harness = createFinanceHarness({ orderStatus: OrderStatus.ACTIVE });

    await expect(
      harness.service.generateNextMonthlyRentBill(harness.orderId, harness.user, harness.context)
    ).rejects.toThrow("订单尚未起租，无法生成月租账单");
  });

  it("rejects monthly rent generation when monthly rent amount is missing", async () => {
    const harness = createFinanceHarness({
      actualDeliveryAt: new Date("2026-06-10T02:00:00.000Z"),
      monthlyFeeAmount: 0n,
      orderStatus: OrderStatus.ACTIVE,
      quote: { id: "quote-1", monthlyFeeAmount: 0n, quoteNo: "QUO2026060600001", status: QuoteStatus.CONFIRMED },
      quoteSnapshot: {}
    });

    await expect(
      harness.service.generateNextMonthlyRentBill(harness.orderId, harness.user, harness.context)
    ).rejects.toThrow("订单缺少月租金额，无法生成月租账单");
  });

  it("uses quoteSnapshot pricing monthly fee when order monthly fee is missing", async () => {
    const harness = createFinanceHarness({
      actualDeliveryAt: new Date("2026-06-10T02:00:00.000Z"),
      monthlyFeeAmount: 0n,
      orderStatus: OrderStatus.ACTIVE,
      quoteSnapshot: { pricing: { monthlyFeeAmount: 420000 } }
    });

    const bill = (await harness.service.generateNextMonthlyRentBill(
      harness.orderId,
      harness.user,
      harness.context
    )) as { amount: number };

    expect(bill.amount).toBe(420000);
  });

  it("generates the second monthly rent bill on the second call", async () => {
    const harness = createFinanceHarness();
    activateMonthlyOrder(harness);

    await harness.service.generateNextMonthlyRentBill(harness.orderId, harness.user, harness.context);
    const second = (await harness.service.generateNextMonthlyRentBill(
      harness.orderId,
      harness.user,
      harness.context
    )) as { billPeriodEnd: string; billPeriodStart: string; created: boolean };

    expect(second).toMatchObject({
      billPeriodEnd: "2026-09-09",
      billPeriodStart: "2026-08-10",
      created: true
    });
    expect(harness.state.bills.filter((bill) => bill.billType === BillType.MONTHLY_RENT)).toHaveLength(2);
  });

  it("uses the delivery anchor for month-end periods in manual generation", async () => {
    const harness = createFinanceHarness({
      actualDeliveryAt: new Date("2026-01-31T02:00:00.000Z"),
      orderStatus: OrderStatus.ACTIVE
    });

    const bill = (await harness.service.generateNextMonthlyRentBill(
      harness.orderId,
      harness.user,
      harness.context
    )) as { billPeriodEnd: string; billPeriodStart: string };

    expect(bill).toMatchObject({
      billPeriodEnd: "2026-03-30",
      billPeriodStart: "2026-02-28"
    });
  });

  it("returns an existing monthly rent bill when the same period already exists", async () => {
    const harness = createFinanceHarness();
    activateMonthlyOrder(harness);
    const existingBill = addMonthlyRentBill(harness, "2026-08-10", "2026-09-09");

    const result = (await harness.service.generateNextMonthlyRentBill(
      harness.orderId,
      harness.user,
      harness.context
    )) as { created: boolean; id: string };

    expect(result).toMatchObject({ created: false, id: existingBill.id });
    expect(harness.state.bills.filter((bill) => bill.billType === BillType.MONTHLY_RENT)).toHaveLength(1);
  });

  it("batch generation only processes ACTIVE orders", async () => {
    const harness = createFinanceHarness();
    activateMonthlyOrder(harness);
    harness.state.orders.push(
      cloneOrder(harness, {
        actualDeliveryAt: new Date("2026-06-10T02:00:00.000Z"),
        id: "order-pending",
        orderNo: "ORD2026060600999",
        orderStatus: OrderStatus.PENDING_PAYMENT
      })
    );

    const result = await harness.service.generateMonthlyRentBills(
      { billingDate: "2026-07-10", dryRun: false },
      harness.user,
      harness.context
    );

    expect(result).toMatchObject({ failedCount: 0, generatedCount: 1, skippedCount: 0 });
    expect(result.items.map((item) => item.orderId)).toEqual([harness.orderId]);
  });

  it("batch generation skips orders whose next period is not due", async () => {
    const harness = createFinanceHarness();
    activateMonthlyOrder(harness);

    const result = await harness.service.generateMonthlyRentBills(
      { billingDate: "2026-07-06" },
      harness.user,
      harness.context
    );

    expect(result).toMatchObject({ generatedCount: 0, skippedCount: 1 });
    expect(result.items[0]).toMatchObject({ action: "SKIPPED_NOT_DUE" });
  });

  it("batch generation opens on D-3 like the recurring billing schedule", async () => {
    const harness = createFinanceHarness({
      actualDeliveryAt: new Date("2026-08-02T03:03:59.594Z"),
      orderStatus: OrderStatus.ACTIVE
    });

    const result = await harness.service.generateMonthlyRentBills(
      { billingDate: "2026-08-30", dryRun: true },
      harness.user,
      harness.context
    );

    expect(result).toMatchObject({ generatedCount: 1, skippedCount: 0 });
    expect(result.items[0]).toMatchObject({
      action: "DRY_RUN_GENERATE",
      periodEnd: "2026-10-01",
      periodStart: "2026-09-02"
    });
  });

  it("batch generation skips an existing monthly rent bill for the billing date", async () => {
    const harness = createFinanceHarness();
    activateMonthlyOrder(harness);
    addMonthlyRentBill(harness, "2026-07-10", "2026-08-09");

    const result = await harness.service.generateMonthlyRentBills(
      { billingDate: "2026-07-10" },
      harness.user,
      harness.context
    );

    expect(result).toMatchObject({ generatedCount: 0, skippedCount: 1 });
    expect(result.items[0]).toMatchObject({ action: "SKIPPED_EXISTING" });
    expect(harness.state.bills.filter((bill) => bill.billType === BillType.MONTHLY_RENT)).toHaveLength(1);
  });

  it("batch generation keeps going when one order fails", async () => {
    const harness = createFinanceHarness();
    activateMonthlyOrder(harness);
    harness.state.orders.push(
      cloneOrder(harness, {
        actualDeliveryAt: new Date("2026-06-10T02:00:00.000Z"),
        id: "order-missing-monthly-fee",
        monthlyFeeAmount: 0n,
        orderNo: "ORD2026060600888",
        orderStatus: OrderStatus.ACTIVE,
        quote: { id: "quote-2", monthlyFeeAmount: 0n, quoteNo: "QUO2026060600888", status: QuoteStatus.CONFIRMED },
        quoteId: "quote-2",
        quoteSnapshot: {}
      })
    );

    const result = await harness.service.generateMonthlyRentBills(
      { billingDate: "2026-07-10" },
      harness.user,
      harness.context
    );

    expect(result).toMatchObject({ failedCount: 1, generatedCount: 1, skippedCount: 0 });
    expect(result.items.map((item) => item.action)).toEqual(["GENERATED", "FAILED"]);
    expect(harness.state.bills.filter((bill) => bill.billType === BillType.MONTHLY_RENT)).toHaveLength(1);
  });

  it("dryRun returns generation details without writing bills or audit logs", async () => {
    const harness = createFinanceHarness();
    activateMonthlyOrder(harness);

    const result = await harness.service.generateMonthlyRentBills(
      { billingDate: "2026-07-10", dryRun: true },
      harness.user,
      harness.context
    );

    expect(result).toMatchObject({ dryRun: true, generatedCount: 1, skippedCount: 0 });
    expect(result.items[0]).toMatchObject({
      action: "DRY_RUN_GENERATE",
      amount: 300000,
      periodEnd: "2026-08-09",
      periodStart: "2026-07-10"
    });
    expect(harness.state.bills).toHaveLength(0);
    expect(harness.auditService.write).not.toHaveBeenCalled();
  });

  it("writes audit logs for single and batch monthly rent bill generation", async () => {
    const singleHarness = createFinanceHarness();
    activateMonthlyOrder(singleHarness);
    await singleHarness.service.generateNextMonthlyRentBill(
      singleHarness.orderId,
      singleHarness.user,
      singleHarness.context
    );

    const batchHarness = createFinanceHarness();
    activateMonthlyOrder(batchHarness);
    await batchHarness.service.generateMonthlyRentBills(
      { billingDate: "2026-07-10" },
      batchHarness.user,
      batchHarness.context
    );

    expect(singleHarness.auditService.write.mock.calls[0]?.[0]).toMatchObject({
      after: expect.objectContaining({ billType: BillType.MONTHLY_RENT, source: "SINGLE" }),
      entityType: "receivable_bill",
      module: "billing"
    });
    expect(batchHarness.auditService.write.mock.calls[0]?.[0]).toMatchObject({
      after: expect.objectContaining({ billType: BillType.MONTHLY_RENT, source: "BATCH" }),
      entityType: "receivable_bill",
      module: "billing"
    });
  });
});

describe("deposit settlement backend loop", () => {
  it("rejects DAMAGE_FEE bill generation when no billable customer damage exists", async () => {
    const harness = createFinanceHarness();
    addVehicleReturn(harness);
    addReturnDamage(harness, {
      estimatedRepairAmount: 80000n,
      responsibleParty: VehicleDamageResponsibleParty.PLATFORM
    });

    await expect(
      harness.service.generateDamageFeeBill(harness.orderId, harness.user, harness.context)
    ).rejects.toThrow("当前订单无可生成账单的客户责任损伤费用");
  });

  it("generates a DAMAGE_FEE bill only for billable customer return damages", async () => {
    const harness = createFinanceHarness();
    addVehicleReturn(harness);
    addReturnDamage(harness, { estimatedRepairAmount: 80000n, responsibleParty: VehicleDamageResponsibleParty.CUSTOMER });
    addReturnDamage(harness, {
      estimatedRepairAmount: 60000n,
      responsibleParty: VehicleDamageResponsibleParty.CUSTOMER,
      status: VehicleReturnDamageStatus.WAIVED
    });
    addReturnDamage(harness, { estimatedRepairAmount: 50000n, responsibleParty: VehicleDamageResponsibleParty.PLATFORM });
    addReturnDamage(harness, { estimatedRepairAmount: 40000n, responsibleParty: VehicleDamageResponsibleParty.THIRD_PARTY });
    addReturnDamage(harness, { estimatedRepairAmount: 30000n, responsibleParty: VehicleDamageResponsibleParty.UNKNOWN });

    const bill = await harness.service.generateDamageFeeBill(harness.orderId, harness.user, harness.context);

    expect(bill).toMatchObject({
      amount: 80000,
      billStatus: BillStatus.PENDING,
      billType: BillType.DAMAGE_FEE,
      remainingAmount: 80000
    });
    expect(harness.state.bills).toHaveLength(1);
    expect(harness.state.bills[0]?.snapshot).toMatchObject({
      amount: 80000,
      billType: BillType.DAMAGE_FEE
    });
  });

  it("returns the existing active DAMAGE_FEE bill instead of creating duplicates", async () => {
    const harness = createFinanceHarness();
    addVehicleReturn(harness);
    addReturnDamage(harness, { estimatedRepairAmount: 80000n, responsibleParty: VehicleDamageResponsibleParty.CUSTOMER });

    const first = await harness.service.generateDamageFeeBill(harness.orderId, harness.user, harness.context);
    const second = await harness.service.generateDamageFeeBill(harness.orderId, harness.user, harness.context);

    expect(first).toMatchObject({ amount: 80000, created: true });
    expect(second).toMatchObject({ amount: 80000, created: false, id: first.id });
    expect(harness.state.bills.filter((bill) => bill.billType === BillType.DAMAGE_FEE)).toHaveLength(1);
  });

  it("returns deposit settlement amounts, damage fee amounts, and suggested actions", async () => {
    const harness = createFinanceHarness();
    addVehicleReturn(harness);
    addReturnDamage(harness, { estimatedRepairAmount: 200000n, responsibleParty: VehicleDamageResponsibleParty.CUSTOMER });
    const damageBill = addReceivableBill(harness, {
      amount: 200000n,
      billType: BillType.DAMAGE_FEE,
      paidAmount: 80000n,
      remainingAmount: 120000n
    });
    addDepositLedger(harness, { amount: 500000n, balanceAfter: 500000n, transactionType: DepositTransactionType.COLLECT });
    addDepositLedger(harness, {
      amount: 80000n,
      balanceAfter: 420000n,
      billId: damageBill.id,
      transactionType: DepositTransactionType.DEDUCT
    });
    addDepositLedger(harness, { amount: 100000n, balanceAfter: 320000n, transactionType: DepositTransactionType.REFUND });

    const settlement = await harness.service.getDepositSettlement(harness.orderId, harness.user);

    expect(settlement).toMatchObject({
      availableDepositBalance: 320000,
      collectedAmount: 500000,
      damageFeeAmount: 200000,
      damageFeeDeductedAmount: 80000,
      damageFeeRemainingAmount: 120000,
      deductibleAmount: 120000,
      deductedAmount: 80000,
      refundableAmount: 200000,
      refundedAmount: 100000
    });
    expect(settlement.damages).toEqual([expect.objectContaining({ billable: true, estimatedRepairAmount: 200000 })]);
    expect(settlement.depositLedgers).toHaveLength(3);
  });

  it("rejects deposit deduction when balance is insufficient or amount exceeds bill remaining", async () => {
    const insufficientHarness = createFinanceHarness();
    const insufficientBill = addReceivableBill(insufficientHarness, {
      amount: 100000n,
      billType: BillType.DAMAGE_FEE,
      remainingAmount: 100000n
    });
    addDepositLedger(insufficientHarness, {
      amount: 50000n,
      balanceAfter: 50000n,
      transactionType: DepositTransactionType.COLLECT
    });

    await expect(
      insufficientHarness.service.deductDeposit(
        insufficientHarness.orderId,
        { amount: 80000, billId: String(insufficientBill.id) },
        insufficientHarness.user,
        insufficientHarness.context
      )
    ).rejects.toThrow("保证金余额不足，不能扣减");

    const overBillHarness = createFinanceHarness();
    const overBill = addReceivableBill(overBillHarness, {
      amount: 80000n,
      billType: BillType.DAMAGE_FEE,
      remainingAmount: 80000n
    });
    addDepositLedger(overBillHarness, { amount: 500000n, balanceAfter: 500000n, transactionType: DepositTransactionType.COLLECT });

    await expect(
      overBillHarness.service.deductDeposit(
        overBillHarness.orderId,
        { amount: 100000, billId: String(overBill.id) },
        overBillHarness.user,
        overBillHarness.context
      )
    ).rejects.toThrow("扣减金额不能超过损伤费用账单剩余金额");
  });

  it("writes DEDUCT ledger and updates DAMAGE_FEE bill for partial and full deductions", async () => {
    const partialHarness = createFinanceHarness();
    const partialBill = addReceivableBill(partialHarness, {
      amount: 100000n,
      billType: BillType.DAMAGE_FEE,
      remainingAmount: 100000n
    });
    addDepositLedger(partialHarness, { amount: 500000n, balanceAfter: 500000n, transactionType: DepositTransactionType.COLLECT });

    const partial = await partialHarness.service.deductDeposit(
      partialHarness.orderId,
      { amount: 40000, billId: String(partialBill.id), remark: "退车损伤费用抵扣" },
      partialHarness.user,
      partialHarness.context
    );

    expect(partial.bill).toMatchObject({
      billStatus: BillStatus.PARTIALLY_PAID,
      paidAmount: 40000,
      remainingAmount: 60000
    });
    expect(partial.ledger).toMatchObject({
      amount: 40000,
      balanceAfter: 460000,
      transactionType: DepositTransactionType.DEDUCT
    });

    const fullHarness = createFinanceHarness();
    const fullBill = addReceivableBill(fullHarness, {
      amount: 80000n,
      billType: BillType.DAMAGE_FEE,
      remainingAmount: 80000n
    });
    addDepositLedger(fullHarness, { amount: 500000n, balanceAfter: 500000n, transactionType: DepositTransactionType.COLLECT });

    const full = await fullHarness.service.deductDeposit(
      fullHarness.orderId,
      { amount: 80000, billId: String(fullBill.id) },
      fullHarness.user,
      fullHarness.context
    );

    expect(full.bill).toMatchObject({
      billStatus: BillStatus.PAID,
      paidAmount: 80000,
      remainingAmount: 0
    });
    expect(fullHarness.state.depositLedgers.at(-1)).toMatchObject({
      amount: 80000n,
      balanceAfter: 420000n,
      transactionStatus: DepositTransactionStatus.CONFIRMED,
      transactionType: DepositTransactionType.DEDUCT
    });
  });

  it("rejects over-refund and repeated refunds that would make deposit balance negative", async () => {
    const harness = createFinanceHarness({ actualReturnAt: new Date("2026-06-20T03:00:00.000Z") });
    addDepositLedger(harness, { amount: 500000n, balanceAfter: 500000n, transactionType: DepositTransactionType.COLLECT });

    await expect(
      harness.service.refundDeposit(harness.orderId, { amount: 600000 }, harness.user, harness.context)
    ).rejects.toThrow("退款金额不能超过可用保证金余额");

    await harness.service.refundDeposit(harness.orderId, { amount: 300000 }, harness.user, harness.context);

    await expect(
      harness.service.refundDeposit(harness.orderId, { amount: 250000 }, harness.user, harness.context)
    ).rejects.toThrow("退款金额不能超过可用保证金余额");
    expect(harness.state.depositLedgers.at(-1)).toMatchObject({
      amount: 300000n,
      balanceAfter: 200000n,
      transactionType: DepositTransactionType.REFUND
    });
  });

  it("writes audit logs for damage fee generation, deposit deduction, and deposit refund", async () => {
    const harness = createFinanceHarness({ actualReturnAt: new Date("2026-06-20T03:00:00.000Z") });
    addVehicleReturn(harness);
    addReturnDamage(harness, { estimatedRepairAmount: 80000n, responsibleParty: VehicleDamageResponsibleParty.CUSTOMER });
    addDepositLedger(harness, { amount: 500000n, balanceAfter: 500000n, transactionType: DepositTransactionType.COLLECT });

    const bill = await harness.service.generateDamageFeeBill(harness.orderId, harness.user, harness.context);
    await harness.service.deductDeposit(
      harness.orderId,
      { amount: 80000, billId: bill.id, remark: "退车损伤费用抵扣" },
      harness.user,
      harness.context
    );
    await harness.service.refundDeposit(
      harness.orderId,
      { amount: 420000, remark: "退车结算后人工确认退款" },
      harness.user,
      harness.context
    );

    const auditEntries = harness.auditService.write.mock.calls.map(([entry]) => entry);
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: "receivable_bill", module: "billing" }),
        expect.objectContaining({
          after: expect.objectContaining({ amount: 80000, transactionType: DepositTransactionType.DEDUCT }),
          entityType: "deposit_ledger",
          module: "deposit_ledger"
        }),
        expect.objectContaining({
          after: expect.objectContaining({ amount: 420000, transactionType: DepositTransactionType.REFUND }),
          entityType: "deposit_ledger",
          module: "deposit_ledger"
        })
      ])
    );
  });
});

describe("overdue collection backend loop", () => {
  it("dryRun returns overdue bills without writing bills, cases, links, or audit logs", async () => {
    const harness = createFinanceHarness();
    addReceivableBill(harness, { dueDate: dateOnly("2026-06-01") });

    const result = await harness.service.refreshOverdueBills(
      { asOfDate: "2026-06-06", dryRun: true },
      harness.user,
      harness.context
    );

    expect(result).toMatchObject({
      createdCaseCount: 1,
      dryRun: true,
      overdueBillCount: 1,
      updatedCaseCount: 0
    });
    expect(result.items[0]).toMatchObject({
      collectionLevel: CollectionLevel.D2,
      overdueDays: 5
    });
    expect(harness.state.bills[0]?.billStatus).toBe(BillStatus.PENDING);
    expect(harness.state.collectionCases).toHaveLength(0);
    expect(harness.state.collectionCaseBills).toHaveLength(0);
    expect(harness.auditService.write).not.toHaveBeenCalled();
  });

  it("marks only overdue unsettled bills and creates a collection case with case bill links", async () => {
    const harness = createFinanceHarness();
    const overdueBill = addReceivableBill(harness, { dueDate: dateOnly("2026-06-01") });
    const paidBill = addReceivableBill(harness, {
      billStatus: BillStatus.PAID,
      dueDate: dateOnly("2026-05-20"),
      paidAmount: 300000n,
      remainingAmount: 0n
    });
    const cancelledBill = addReceivableBill(harness, {
      billStatus: BillStatus.CANCELLED,
      dueDate: dateOnly("2026-05-20")
    });
    const dueTodayBill = addReceivableBill(harness, { dueDate: dateOnly("2026-06-06") });

    const result = await harness.service.refreshOverdueBills(
      { asOfDate: "2026-06-06" },
      harness.user,
      harness.context
    );

    expect(result).toMatchObject({
      createdCaseCount: 1,
      dryRun: false,
      overdueBillCount: 1,
      updatedCaseCount: 0
    });
    expect(overdueBill.billStatus).toBe(BillStatus.OVERDUE);
    expect(paidBill.billStatus).toBe(BillStatus.PAID);
    expect(cancelledBill.billStatus).toBe(BillStatus.CANCELLED);
    expect(dueTodayBill.billStatus).toBe(BillStatus.PENDING);
    expect(harness.state.collectionCases).toEqual([
      expect.objectContaining({
        caseStatus: CollectionCaseStatus.ACTIVE,
        collectionLevel: CollectionLevel.D2,
        maxOverdueDays: 5,
        totalOverdueAmount: 300000n
      })
    ]);
    expect(harness.state.collectionCaseBills).toEqual([
      expect.objectContaining({
        billId: overdueBill.id,
        overdueAmount: 300000n,
        overdueDays: 5
      })
    ]);
  });

  it("uses a UUID refresh audit id and writes refresh audits through the transaction client", async () => {
    const harness = createFinanceHarness();
    addReceivableBill(harness, { dueDate: dateOnly("2026-06-01") });

    await harness.service.refreshOverdueBills({ asOfDate: "2026-06-06" }, harness.user, harness.context);

    const refreshAuditCall = harness.auditService.write.mock.calls.find(
      ([entry]) => entry.entityType === "overdue_refresh"
    );
    const collectionCaseAuditCalls = harness.auditService.write.mock.calls.filter(
      ([entry]) => entry.entityType === "collection_case"
    );

    expect(refreshAuditCall?.[0]).toEqual(
      expect.objectContaining({
        entityId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        )
      })
    );
    expect(refreshAuditCall?.[1]).toBe(harness.transactionClient);
    expect(collectionCaseAuditCalls).not.toHaveLength(0);
    for (const auditCall of collectionCaseAuditCalls) {
      expect(auditCall[1]).toBe(harness.transactionClient);
    }
  });

  it("rolls back overdue mutations when an in-transaction audit write fails", async () => {
    const harness = createFinanceHarness();
    addReceivableBill(harness, { dueDate: dateOnly("2026-06-01") });
    harness.auditService.write.mockRejectedValueOnce(new Error("audit failed"));

    await expect(
      harness.service.refreshOverdueBills({ asOfDate: "2026-06-06" }, harness.user, harness.context)
    ).rejects.toThrow("audit failed");

    expect(harness.state.bills[0]?.billStatus).toBe(BillStatus.PENDING);
    expect(harness.state.collectionCases).toHaveLength(0);
    expect(harness.state.collectionCaseBills).toHaveLength(0);
  });

  it("calculates D1-D5 collection levels by natural overdue days", async () => {
    const harness = createFinanceHarness();
    addReceivableBill(harness, { dueDate: dateOnly("2026-06-05") });
    addReceivableBill(harness, { dueDate: dateOnly("2026-06-02") });
    addReceivableBill(harness, { dueDate: dateOnly("2026-05-25") });
    addReceivableBill(harness, { dueDate: dateOnly("2026-05-15") });
    addReceivableBill(harness, { dueDate: dateOnly("2026-05-01") });

    const result = await harness.service.refreshOverdueBills(
      { asOfDate: "2026-06-06", dryRun: true },
      harness.user,
      harness.context
    );
    const levelsByDays = result.items
      .map((item) => ({ days: item.overdueDays, level: item.collectionLevel }))
      .sort((left, right) => left.days - right.days);

    expect(levelsByDays).toEqual([
      { days: 1, level: CollectionLevel.D1 },
      { days: 4, level: CollectionLevel.D2 },
      { days: 12, level: CollectionLevel.D3 },
      { days: 22, level: CollectionLevel.D4 },
      { days: 36, level: CollectionLevel.D5 }
    ]);
  });

  it("updates an existing ACTIVE collection case instead of creating duplicates", async () => {
    const harness = createFinanceHarness();
    addReceivableBill(harness, { dueDate: dateOnly("2026-06-01") });
    await harness.service.refreshOverdueBills({ asOfDate: "2026-06-06" }, harness.user, harness.context);
    const existingCaseId = harness.state.collectionCases[0]?.id;
    addReceivableBill(harness, { dueDate: dateOnly("2026-06-02") });

    const result = await harness.service.refreshOverdueBills(
      { asOfDate: "2026-06-06" },
      harness.user,
      harness.context
    );

    expect(result).toMatchObject({ createdCaseCount: 0, overdueBillCount: 2, updatedCaseCount: 1 });
    expect(harness.state.collectionCases).toHaveLength(1);
    expect(harness.state.collectionCases[0]).toMatchObject({
      id: existingCaseId,
      maxOverdueDays: 5,
      totalOverdueAmount: 600000n
    });
    expect(harness.state.collectionCaseBills).toHaveLength(2);
  });

  it("lists overdue bills, collection cases, and collection case details", async () => {
    const harness = createFinanceHarness();
    const bill = addReceivableBill(harness, { dueDate: dateOnly("2026-06-01") });
    await harness.service.refreshOverdueBills({ asOfDate: "2026-06-06" }, harness.user, harness.context);
    const collectionCase = harness.state.collectionCases[0]!;

    const overdueBills = await harness.service.listOverdueBills({}, harness.user);
    const cases = await harness.service.listCollectionCases({ caseStatus: CollectionCaseStatus.ACTIVE }, harness.user);
    const detail = await harness.service.getCollectionCase(String(collectionCase.id), harness.user);

    expect(overdueBills).toEqual([
      expect.objectContaining({
        billId: bill.id,
        collectionCaseStatus: CollectionCaseStatus.ACTIVE,
        collectionLevel: expect.any(String),
        remainingAmount: 300000
      })
    ]);
    expect(cases).toEqual([
      expect.objectContaining({
        caseStatus: CollectionCaseStatus.ACTIVE,
        customer: expect.objectContaining({ id: harness.customerId }),
        order: expect.objectContaining({ id: harness.orderId })
      })
    ]);
    expect(detail).toMatchObject({
      id: collectionCase.id,
      actions: [],
      bills: [expect.objectContaining({ billId: bill.id })]
    });
  });

  it("creates collection actions and updates next follow-up time", async () => {
    const harness = createFinanceHarness();
    addReceivableBill(harness, { dueDate: dateOnly("2026-06-01") });
    await harness.service.refreshOverdueBills({ asOfDate: "2026-06-06" }, harness.user, harness.context);
    const collectionCase = harness.state.collectionCases[0]!;

    const action = await harness.service.createCollectionAction(
      String(collectionCase.id),
      {
        actionResult: CollectionActionResult.CUSTOMER_PROMISED,
        actionType: CollectionActionType.PROMISE_TO_PAY,
        contactMethod: ContactMethod.PHONE,
        content: "客户承诺三日内付款",
        nextFollowUpAt: "2026-06-09T10:00:00+08:00",
        promisedAmount: 300000,
        promisedPayAt: "2026-06-09"
      },
      harness.user,
      harness.context
    );

    expect(action).toMatchObject({
      actionResult: CollectionActionResult.CUSTOMER_PROMISED,
      actionType: CollectionActionType.PROMISE_TO_PAY,
      promisedAmount: 300000,
      promisedPayAt: "2026-06-09"
    });
    expect(harness.state.collectionCases[0]?.nextFollowUpAt).toEqual(new Date("2026-06-09T02:00:00.000Z"));
    expect(harness.state.collectionActions).toHaveLength(1);
  });

  it("prevents closing unsettled cases and closes cases after all linked bills are settled", async () => {
    const harness = createFinanceHarness();
    const bill = addReceivableBill(harness, { dueDate: dateOnly("2026-06-01") });
    await harness.service.refreshOverdueBills({ asOfDate: "2026-06-06" }, harness.user, harness.context);
    const collectionCase = harness.state.collectionCases[0]!;

    await expect(
      harness.service.closeCollectionCase(
        String(collectionCase.id),
        { closeReason: "账单已结清" },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("不能关闭");

    Object.assign(bill, { billStatus: BillStatus.PAID, paidAmount: 300000n, remainingAmount: 0n });
    const result = await harness.service.closeCollectionCase(
      String(collectionCase.id),
      { closeReason: "账单已结清" },
      harness.user,
      harness.context
    );

    expect(result.case).toMatchObject({
      caseStatus: CollectionCaseStatus.CLOSED,
      closeReason: "账单已结清"
    });
    expect(harness.state.collectionActions).toEqual([
      expect.objectContaining({
        actionType: CollectionActionType.CLOSE,
        contactMethod: ContactMethod.SYSTEM
      })
    ]);
  });

  it("writes audit logs for overdue refresh, case changes, actions, and close", async () => {
    const harness = createFinanceHarness();
    const bill = addReceivableBill(harness, { dueDate: dateOnly("2026-06-01") });
    await harness.service.refreshOverdueBills({ asOfDate: "2026-06-06" }, harness.user, harness.context);
    const collectionCase = harness.state.collectionCases[0]!;
    await harness.service.createCollectionAction(
      String(collectionCase.id),
      {
        actionResult: CollectionActionResult.SUCCESS,
        actionType: CollectionActionType.FOLLOW_UP,
        contactMethod: ContactMethod.PHONE,
        content: "已提醒客户付款"
      },
      harness.user,
      harness.context
    );
    Object.assign(bill, { billStatus: BillStatus.PAID, paidAmount: 300000n, remainingAmount: 0n });
    await harness.service.closeCollectionCase(
      String(collectionCase.id),
      { closeReason: "账单已结清" },
      harness.user,
      harness.context
    );

    const entityTypes = harness.auditService.write.mock.calls.map(([entry]) => entry.entityType);
    expect(entityTypes).toEqual(
      expect.arrayContaining(["overdue_refresh", "collection_case", "collection_action"])
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

function activateMonthlyOrder(harness: ReturnType<typeof createFinanceHarness>) {
  Object.assign(harness.state.order, {
    actualDeliveryAt: new Date("2026-06-10T02:00:00.000Z"),
    orderStatus: OrderStatus.ACTIVE
  });
}

function addMonthlyRentBill(
  harness: ReturnType<typeof createFinanceHarness>,
  periodStart: string,
  periodEnd: string,
  overrides: Record<string, unknown> = {}
) {
  const bill = {
    amount: 300000n,
    billNo: `BIL-MONTHLY-${harness.state.bills.length + 1}`,
    billPeriodEnd: dateOnly(periodEnd),
    billPeriodStart: dateOnly(periodStart),
    billStatus: BillStatus.PENDING,
    billType: BillType.MONTHLY_RENT,
    cancelledAt: null,
    createdAt: new Date("2026-06-06T08:00:00.000Z"),
    createdBy: harness.user.id,
    customerId: harness.customerId,
    deletedAt: null,
    dueDate: dateOnly(periodStart),
    id: `bill-existing-${harness.state.bills.length + 1}`,
    orderId: harness.orderId,
    paidAmount: 0n,
    paidAt: null,
    remainingAmount: 300000n,
    remark: null,
    snapshot: {},
    updatedAt: new Date("2026-06-06T08:00:00.000Z"),
    updatedBy: harness.user.id,
    ...overrides
  };
  harness.state.bills.push(bill);
  return bill as { id: string };
}

function addReceivableBill(harness: ReturnType<typeof createFinanceHarness>, overrides: Record<string, unknown> = {}) {
  const bill = {
    amount: 300000n,
    billNo: `BIL-OVERDUE-${harness.state.bills.length + 1}`,
    billPeriodEnd: null,
    billPeriodStart: null,
    billStatus: BillStatus.PENDING,
    billType: BillType.MONTHLY_RENT,
    cancelledAt: null,
    createdAt: new Date("2026-06-01T08:00:00.000Z"),
    createdBy: harness.user.id,
    customerId: harness.customerId,
    deletedAt: null,
    dueDate: dateOnly("2026-06-01"),
    id: `bill-overdue-${harness.state.bills.length + 1}`,
    orderId: harness.orderId,
    paidAmount: 0n,
    paidAt: null,
    remainingAmount: 300000n,
    remark: null,
    snapshot: {},
    updatedAt: new Date("2026-06-01T08:00:00.000Z"),
    updatedBy: harness.user.id,
    ...overrides
  };
  harness.state.bills.push(bill);
  return bill;
}

function addVehicleReturn(harness: ReturnType<typeof createFinanceHarness>, overrides: Record<string, unknown> = {}) {
  const returnedAt = new Date("2026-06-20T03:00:00.000Z");
  Object.assign(harness.state.order, {
    actualReturnAt: returnedAt,
    orderStatus: OrderStatus.COMPLETED
  });
  const vehicleReturn = {
    checklistSnapshot: {},
    cleaningRequired: false,
    createdAt: new Date("2026-06-20T03:00:00.000Z"),
    customerId: harness.customerId,
    damageFound: false,
    deletedAt: null,
    id: "return-1",
    maintenanceRequired: false,
    orderId: harness.orderId,
    remark: null,
    returnMileageKm: 32000,
    returnNo: "RET2026062000001",
    returnedAt,
    returnLocation: "静安旺旺大厦",
    returnStatus: VehicleReturnStatus.CONFIRMED,
    returnType: VehicleReturnType.NORMAL_RETURN,
    scheduledAt: new Date("2026-06-20T02:00:00.000Z"),
    updatedAt: new Date("2026-06-20T03:00:00.000Z"),
    vehicleId: "vehicle-1",
    ...overrides
  };
  harness.state.vehicleReturn = vehicleReturn;
  return vehicleReturn;
}

function addReturnDamage(harness: ReturnType<typeof createFinanceHarness>, overrides: Record<string, unknown> = {}) {
  if (!harness.state.vehicleReturn) {
    addVehicleReturn(harness);
  }
  const damage = {
    createdAt: new Date("2026-06-20T03:00:00.000Z"),
    createdBy: harness.user.id,
    damageLevel: VehicleDamageLevel.MEDIUM,
    damageType: VehicleDamageType.EXTERIOR,
    deletedAt: null,
    description: "右后门划痕",
    estimatedRepairAmount: 80000n,
    id: `damage-${harness.state.returnDamages.length + 1}`,
    orderId: harness.orderId,
    photoUrls: [],
    responsibleParty: VehicleDamageResponsibleParty.CUSTOMER,
    returnId: harness.state.vehicleReturn!.id,
    status: VehicleReturnDamageStatus.RECORDED,
    updatedAt: new Date("2026-06-20T03:00:00.000Z"),
    updatedBy: harness.user.id,
    vehicleId: "vehicle-1",
    ...overrides
  };
  harness.state.returnDamages.push(damage);
  return damage;
}

function addDepositLedger(harness: ReturnType<typeof createFinanceHarness>, overrides: Record<string, unknown> = {}) {
  const ledger = {
    amount: 500000n,
    balanceAfter: 500000n,
    billId: null,
    createdAt: new Date("2026-06-06T08:00:00.000Z"),
    createdBy: harness.user.id,
    customerId: harness.customerId,
    deletedAt: null,
    id: `ledger-existing-${harness.state.depositLedgers.length + 1}`,
    ledgerNo: `DPL-EXISTING-${harness.state.depositLedgers.length + 1}`,
    occurredAt: new Date("2026-06-06T08:00:00.000Z"),
    orderId: harness.orderId,
    paymentId: null,
    remark: null,
    snapshot: {},
    transactionStatus: DepositTransactionStatus.CONFIRMED,
    transactionType: DepositTransactionType.COLLECT,
    ...overrides
  };
  harness.state.depositLedgers.push(ledger);
  return ledger;
}

function cloneOrder(harness: ReturnType<typeof createFinanceHarness>, overrides: Record<string, unknown>) {
  return {
    ...harness.state.order,
    application: { ...(harness.state.order.application as Record<string, unknown>) },
    contract: { ...(harness.state.order.contract as Record<string, unknown>) },
    customer: { ...(harness.state.order.customer as Record<string, unknown>) },
    quote: { ...(harness.state.order.quote as Record<string, unknown>) },
    vehicle: { ...(harness.state.order.vehicle as Record<string, unknown>) },
    ...overrides
  };
}

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
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
    automationJobs: [] as Array<Record<string, unknown>>,
    bills: [] as Array<Record<string, unknown>>,
    collectionActions: [] as Array<Record<string, unknown>>,
    collectionCaseBills: [] as Array<Record<string, unknown>>,
    collectionCases: [] as Array<Record<string, unknown>>,
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
      contract: {
        fileId: "file-contract-1",
        id: "contract-1",
        status: ContractStatus.ARCHIVED
      },
      contractId: "contract-1",
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
      quote: { id: "quote-1", monthlyFeeAmount: 300000n, quoteNo: "QUO2026060600001", status: QuoteStatus.CONFIRMED },
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
      vehicle: { id: "vehicle-1", plateNo: "沪A12345", vehicleNo: "VEH2026060600001", vin: "VIN0001" },
      vehicleId: "vehicle-1",
      vehicleModel: "ET5",
      vehiclePurchasePriceAmount: 10000000n,
      ...orderOverrides
    },
    orders: [] as Array<Record<string, unknown>>,
    payments: [] as Array<Record<string, unknown>>,
    returnDamages: [] as Array<Record<string, unknown>>,
    vehicleReturn: null as Record<string, unknown> | null,
    writeOffs: [] as Array<Record<string, unknown>>
  };
  state.orders.push(state.order);

  const client = {
    $queryRaw: vi.fn(async () => [] as Array<{ id: string }>),
    collectionAction: {
      create: vi.fn(async ({ data }) => {
        const action = {
          ...data,
          createdAt: now,
          deletedAt: null,
          id: `collection-action-${state.collectionActions.length + 1}`
        };
        state.collectionActions.push(action);
        return action;
      })
    },
    collectionCase: {
      create: vi.fn(async ({ data }) => {
        const collectionCase = {
          assignedTo: null,
          closedAt: null,
          closeReason: null,
          createdAt: now,
          deletedAt: null,
          id: `collection-case-${state.collectionCases.length + 1}`,
          nextFollowUpAt: null,
          remark: null,
          updatedAt: now,
          ...data
        };
        state.collectionCases.push(collectionCase);
        return collectionCase;
      }),
      findFirst: vi.fn(async ({ where }) => filterCollectionCases(state.collectionCases, where).at(0) ?? null),
      findMany: vi.fn(async ({ include, where }) =>
        filterCollectionCases(state.collectionCases, where).map((collectionCase) =>
          decorateCollectionCase(collectionCase, include)
        )
      ),
      findUnique: vi.fn(async ({ include, where }) => {
        const collectionCase = state.collectionCases.find((item) => item.id === where.id);
        return collectionCase ? decorateCollectionCase(collectionCase, include) : null;
      }),
      update: vi.fn(async ({ data, where }) => {
        const collectionCase = state.collectionCases.find((item) => item.id === where.id);
        if (!collectionCase) {
          throw new Error("Collection case not found");
        }
        Object.assign(collectionCase, data, { updatedAt: now });
        return collectionCase;
      })
    },
    collectionCaseBill: {
      create: vi.fn(async ({ data }) => {
        const caseBill = {
          ...data,
          createdAt: now,
          deletedAt: null,
          id: `collection-case-bill-${state.collectionCaseBills.length + 1}`
        };
        state.collectionCaseBills.push(caseBill);
        return caseBill;
      }),
      findFirst: vi.fn(async ({ where }) => filterCollectionCaseBills(state.collectionCaseBills, where).at(0) ?? null),
      update: vi.fn(async ({ data, where }) => {
        const caseBill = state.collectionCaseBills.find((item) => item.id === where.id);
        if (!caseBill) {
          throw new Error("Collection case bill not found");
        }
        Object.assign(caseBill, data);
        return caseBill;
      })
    },
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
        state.depositLedgers.filter((ledger) => {
          if (where.customerId && ledger.customerId !== where.customerId) {
            return false;
          }
          if (where.orderId && ledger.orderId !== where.orderId) {
            return false;
          }
          if ("deletedAt" in where && ledger.deletedAt !== where.deletedAt) {
            return false;
          }
          if (where.transactionStatus && ledger.transactionStatus !== where.transactionStatus) {
            return false;
          }
          return true;
        })
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
      }),
      findMany: vi.fn(async ({ include, where }) =>
        state.payments
          .filter((payment) => {
            if (where.orderId && payment.orderId !== where.orderId) {
              return false;
            }
            if ("deletedAt" in where && payment.deletedAt !== where.deletedAt) {
              return false;
            }
            if (where.paymentStatus && payment.paymentStatus !== where.paymentStatus) {
              return false;
            }
            return true;
          })
          .map((payment) => decoratePayment(payment, include))
      )
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
      findFirst: vi.fn(async ({ where }) => filterBills(state.bills, where).at(0) ?? null),
      findMany: vi.fn(async ({ include, where }) => filterBills(state.bills, where).map((bill) => decorateBill(bill, include))),
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
      findMany: vi.fn(async ({ where }) => filterOrders(state.orders, where)),
      findUnique: vi.fn(async ({ where }) => state.orders.find((order) => order.id === where.id) ?? null)
    },
    subscriptionAutomationJob: {
      updateMany: vi.fn(async ({ data, where }) => {
        const matches = state.automationJobs.filter(
          (job) =>
            (!where.billId?.in || where.billId.in.includes(job.billId)) &&
            (!where.orderId || job.orderId === where.orderId) &&
            (!where.jobStatus || matchesScalarFilter(job.jobStatus, where.jobStatus)) &&
            (!where.jobType?.in || where.jobType.in.includes(job.jobType)) &&
            (!where.jobType || matchesScalarFilter(job.jobType, where.jobType))
        );
        for (const job of matches) {
          Object.assign(job, data);
        }
        return { count: matches.length };
      })
    },
    vehicleReturn: {
      findUnique: vi.fn(async ({ where }) => {
        if (!state.vehicleReturn) {
          return null;
        }
        if (where.orderId && state.vehicleReturn.orderId !== where.orderId) {
          return null;
        }
        if (where.id && state.vehicleReturn.id !== where.id) {
          return null;
        }
        return state.vehicleReturn;
      })
    },
    vehicleReturnDamage: {
      findMany: vi.fn(async ({ where }) => filterReturnDamages(state.returnDamages, where))
    }
  };

  const prisma = {
    ...client,
    $transaction: vi.fn(async (callback) => {
      const snapshot = structuredClone(state);
      try {
        return await callback(client);
      } catch (error) {
        state.automationJobs.splice(0, state.automationJobs.length, ...snapshot.automationJobs);
        state.bills.splice(0, state.bills.length, ...snapshot.bills);
        state.collectionActions.splice(0, state.collectionActions.length, ...snapshot.collectionActions);
        state.collectionCaseBills.splice(0, state.collectionCaseBills.length, ...snapshot.collectionCaseBills);
        state.collectionCases.splice(0, state.collectionCases.length, ...snapshot.collectionCases);
        state.depositLedgers.splice(0, state.depositLedgers.length, ...snapshot.depositLedgers);
        Object.assign(state.order, snapshot.order);
        state.orders.splice(
          0,
          state.orders.length,
          ...snapshot.orders.map((order) => (order.id === state.order.id ? state.order : order))
        );
        state.payments.splice(0, state.payments.length, ...snapshot.payments);
        state.returnDamages.splice(0, state.returnDamages.length, ...snapshot.returnDamages);
        state.vehicleReturn = snapshot.vehicleReturn;
        state.writeOffs.splice(0, state.writeOffs.length, ...snapshot.writeOffs);
        throw error;
      }
    })
  };
  const auditService = {
    write: vi.fn(async (entry: Record<string, unknown>, transactionClient?: unknown) => {
      void entry;
      void transactionClient;
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
    transactionClient: client,
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

  function decorateBill(bill: Record<string, unknown>, include: Record<string, unknown> | undefined) {
    const order = state.orders.find((item) => item.id === bill.orderId) ?? state.order;
    return {
      ...bill,
      ...(include?.customer ? { customer: order.customer } : {}),
      ...(include?.order ? { order } : {}),
      ...(include?.collectionCaseBills
        ? {
            collectionCaseBills: state.collectionCaseBills
              .filter((caseBill) => caseBill.billId === bill.id && caseBill.deletedAt === null)
              .map((caseBill) => ({
                ...caseBill,
                case: state.collectionCases.find((collectionCase) => collectionCase.id === caseBill.caseId)
              }))
          }
        : {})
    };
  }

  function decorateCollectionCase(
    collectionCase: Record<string, unknown>,
    include: Record<string, unknown> | undefined
  ) {
    const order = state.orders.find((item) => item.id === collectionCase.orderId) ?? state.order;
    return {
      ...collectionCase,
      ...(include?.actions
        ? {
            actions: state.collectionActions.filter(
              (action) => action.caseId === collectionCase.id && action.deletedAt === null
            )
          }
        : {}),
      ...(include?.bills
        ? {
            bills: state.collectionCaseBills
              .filter((caseBill) => caseBill.caseId === collectionCase.id && caseBill.deletedAt === null)
              .map((caseBill) => ({
                ...caseBill,
                bill: state.bills.find((bill) => bill.id === caseBill.billId)
              }))
          }
        : {}),
      ...(include?.customer ? { customer: order.customer } : {}),
      ...(include?.order ? { order } : {})
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
    if (where.remainingAmount && !matchesScalarFilter(bill.remainingAmount, where.remainingAmount)) {
      return false;
    }
    if (where.dueDate && !matchesScalarFilter(bill.dueDate, where.dueDate)) {
      return false;
    }
    if (where.id && !matchesScalarFilter(bill.id, where.id)) {
      return false;
    }
    if (where.billPeriodStart && !matchesScalarFilter(bill.billPeriodStart, where.billPeriodStart)) {
      return false;
    }
    if (where.billPeriodEnd && !matchesScalarFilter(bill.billPeriodEnd, where.billPeriodEnd)) {
      return false;
    }
    return true;
  });
}

function filterCollectionCases(cases: Array<Record<string, unknown>>, where: Record<string, unknown> = {}) {
  return cases.filter((collectionCase) => {
    if ("deletedAt" in where && collectionCase.deletedAt !== where.deletedAt) {
      return false;
    }
    if (where.id && collectionCase.id !== where.id) {
      return false;
    }
    if (where.orderId && collectionCase.orderId !== where.orderId) {
      return false;
    }
    if (where.caseStatus && !matchesScalarFilter(collectionCase.caseStatus, where.caseStatus)) {
      return false;
    }
    if (where.collectionLevel && !matchesScalarFilter(collectionCase.collectionLevel, where.collectionLevel)) {
      return false;
    }
    if (where.assignedTo && collectionCase.assignedTo !== where.assignedTo) {
      return false;
    }
    return true;
  });
}

function filterCollectionCaseBills(caseBills: Array<Record<string, unknown>>, where: Record<string, unknown> = {}) {
  return caseBills.filter((caseBill) => {
    if ("deletedAt" in where && caseBill.deletedAt !== where.deletedAt) {
      return false;
    }
    if (where.caseId && caseBill.caseId !== where.caseId) {
      return false;
    }
    if (where.billId && caseBill.billId !== where.billId) {
      return false;
    }
    return true;
  });
}

function filterReturnDamages(damages: Array<Record<string, unknown>>, where: Record<string, unknown> = {}) {
  return damages.filter((damage) => {
    if (where.orderId && damage.orderId !== where.orderId) {
      return false;
    }
    if (where.returnId && damage.returnId !== where.returnId) {
      return false;
    }
    if ("deletedAt" in where && damage.deletedAt !== where.deletedAt) {
      return false;
    }
    if (where.responsibleParty && damage.responsibleParty !== where.responsibleParty) {
      return false;
    }
    if (where.status && !matchesScalarFilter(damage.status, where.status)) {
      return false;
    }
    if (where.estimatedRepairAmount && !matchesScalarFilter(damage.estimatedRepairAmount, where.estimatedRepairAmount)) {
      return false;
    }
    return true;
  });
}

function filterOrders(orders: Array<Record<string, unknown>>, where: Record<string, unknown> = {}) {
  return orders.filter((order) => {
    if ("deletedAt" in where && order.deletedAt !== where.deletedAt) {
      return false;
    }
    if (where.orderStatus && !matchesScalarFilter(order.orderStatus, where.orderStatus)) {
      return false;
    }
    return true;
  });
}

function matchesScalarFilter(value: unknown, filter: unknown) {
  if (value instanceof Date && filter instanceof Date) {
    return value.getTime() === filter.getTime();
  }

  if (typeof filter !== "object" || filter === null) {
    return value === filter;
  }

  const record = filter as { in?: unknown[]; not?: unknown };
  if ("contains" in record && typeof value === "string") {
    return value.includes(String(record.contains));
  }
  if ("gt" in record && record.gt !== undefined && compareScalar(value, record.gt) <= 0) {
    return false;
  }
  if ("lt" in record && record.lt !== undefined && compareScalar(value, record.lt) >= 0) {
    return false;
  }
  if (record.in) {
    return record.in.includes(value);
  }
  if (record.not) {
    return value !== record.not;
  }
  return true;
}

function compareScalar(left: unknown, right: unknown) {
  const normalizedLeft = normalizeComparable(left);
  const normalizedRight = normalizeComparable(right);

  if (normalizedLeft === null || normalizedRight === null) {
    return 0;
  }

  if (normalizedLeft > normalizedRight) {
    return 1;
  }
  if (normalizedLeft < normalizedRight) {
    return -1;
  }
  return 0;
}

function normalizeComparable(value: unknown) {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  if (value instanceof Date) {
    return BigInt(value.getTime());
  }
  return null;
}
