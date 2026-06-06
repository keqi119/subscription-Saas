import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AuditAction,
  BillStatus,
  BillType,
  DepositLedger,
  DepositTransactionStatus,
  DepositTransactionType,
  OrderStatus,
  PaymentRecord,
  PaymentStatus,
  PaymentWriteOff,
  Prisma,
  ReceivableBill
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { CreatePaymentDto, GenerateMonthlyRentBillsDto, WriteOffPaymentDto } from "./dto/finance.dto";

const INITIAL_BILL_TYPES = [BillType.DEPOSIT, BillType.FIRST_MONTHLY_FEE] as const;
const FINAL_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.TERMINATED,
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED
]);

const ORDER_NOT_FOUND_MESSAGE = "订单不存在";
const PAYMENT_NOT_FOUND_MESSAGE = "收款记录不存在";
const BILL_NOT_FOUND_MESSAGE = "账单不存在或已删除";
const ORDER_FINANCE_FORBIDDEN_MESSAGE = "无权访问该订单财务信息";
const MISSING_DEPOSIT_AMOUNT_MESSAGE = "订单缺少押金金额，无法生成应收账单";
const MISSING_FIRST_MONTHLY_FEE_AMOUNT_MESSAGE = "订单缺少首期月费金额，无法生成应收账单";
const PAYMENT_CUSTOMER_MISMATCH_MESSAGE = "收款客户与订单客户不一致";
const PAYMENT_NOT_CONFIRMED_MESSAGE = "收款记录未确认，不能核销";
const PAYMENT_WRITE_OFF_OVER_AMOUNT_MESSAGE = "核销金额不能超过收款剩余金额";
const BILL_WRITE_OFF_OVER_AMOUNT_MESSAGE = "核销金额不能超过账单剩余金额";
const BILL_PAYMENT_SCOPE_MISMATCH_MESSAGE = "账单与收款不属于同一订单";
const CANCELLED_BILL_WRITE_OFF_MESSAGE = "已取消账单不能核销";
const DUPLICATE_WRITE_OFF_BILL_MESSAGE = "核销账单不能重复";
const MONTHLY_RENT_ORDER_STATUS_MESSAGE = "当前订单状态不允许生成月租账单";
const MONTHLY_RENT_NOT_STARTED_MESSAGE = "订单尚未起租，无法生成月租账单";
const MISSING_MONTHLY_RENT_AMOUNT_MESSAGE = "订单缺少月租金额，无法生成月租账单";
const CHINA_TIME_OFFSET_MINUTES = 8 * 60;

const financeOrderInclude = {
  application: { select: { applicationNo: true, id: true, salesUserId: true } },
  customer: { select: { grade: true, id: true, mobile: true, name: true } },
  quote: { select: { id: true, monthlyFeeAmount: true, quoteNo: true, status: true } },
  vehicle: { select: { id: true, plateNo: true, vehicleNo: true, vin: true } }
} satisfies Prisma.SubscriptionOrderInclude;

const paymentWriteOffInclude = {
  writeOffs: { where: { deletedAt: null } }
} satisfies Prisma.PaymentRecordInclude;

const paymentWriteOffOrderInclude = {
  order: { include: financeOrderInclude },
  writeOffs: { where: { deletedAt: null } }
} satisfies Prisma.PaymentRecordInclude;

type FinanceOrder = Prisma.SubscriptionOrderGetPayload<{ include: typeof financeOrderInclude }>;
type PaymentWithWriteOffs = Prisma.PaymentRecordGetPayload<{ include: typeof paymentWriteOffInclude }>;
type PaymentWithOrderAndWriteOffs = Prisma.PaymentRecordGetPayload<{ include: typeof paymentWriteOffOrderInclude }>;
type ReceivableBillRecord = ReceivableBill;
type PaymentRecordRecord = PaymentRecord;
type PaymentWriteOffRecord = PaymentWriteOff;
type DepositLedgerRecord = DepositLedger;
type MonthlyRentBillSource = "SINGLE" | "BATCH";
export type MonthlyRentBatchAction =
  | "GENERATED"
  | "SKIPPED_NOT_DUE"
  | "SKIPPED_EXISTING"
  | "FAILED"
  | "DRY_RUN_GENERATE"
  | "DRY_RUN_SKIP"
  | "DRY_RUN_FAILED";

interface MonthlyRentPeriod {
  end: Date;
  index: number;
  start: Date;
}

export interface MonthlyRentBatchItem {
  action: MonthlyRentBatchAction;
  amount?: number;
  billId?: string;
  dryRun: boolean;
  error?: string;
  orderId: string;
  orderNo: string;
  periodEnd?: string;
  periodStart?: string;
  reason?: string;
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService
  ) {}

  async generateInitialBills(orderId: string, user: RequestUser, context: RequestContext) {
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrderFinance(order, user);
    ensureOrderCanGenerateInitialBills(order);

    const depositAmount = resolveDepositAmount(order);
    if (depositAmount === null) {
      throw new BadRequestException(MISSING_DEPOSIT_AMOUNT_MESSAGE);
    }

    const firstMonthlyFeeAmount = resolveFirstMonthlyFeeAmount(order);
    if (firstMonthlyFeeAmount === null) {
      throw new BadRequestException(MISSING_FIRST_MONTHLY_FEE_AMOUNT_MESSAGE);
    }

    const result = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const existingBills = await tx.receivableBill.findMany({
          orderBy: { createdAt: "asc" },
          where: {
            billStatus: { not: BillStatus.CANCELLED },
            billType: { in: [...INITIAL_BILL_TYPES] },
            deletedAt: null,
            orderId
          }
        });
        const existingTypes = new Set(existingBills.map((bill) => bill.billType));
        const createdBills: ReceivableBillRecord[] = [];
        const now = new Date();

        if (!existingTypes.has(BillType.DEPOSIT)) {
          createdBills.push(
            await createInitialBill(tx, order, {
              amount: depositAmount,
              billType: BillType.DEPOSIT,
              createdBy: user.id,
              dueDate: now,
              snapshot: {
                amount: Number(depositAmount),
                billType: BillType.DEPOSIT,
                orderNo: order.orderNo,
                source: "order.deposit"
              }
            })
          );
        }

        if (!existingTypes.has(BillType.FIRST_MONTHLY_FEE)) {
          const period = buildFirstMonthlyFeePeriod(order.startDate);
          createdBills.push(
            await createInitialBill(tx, order, {
              amount: firstMonthlyFeeAmount,
              billPeriodEnd: period?.end ?? null,
              billPeriodStart: period?.start ?? null,
              billType: BillType.FIRST_MONTHLY_FEE,
              createdBy: user.id,
              dueDate: now,
              snapshot: {
                amount: Number(firstMonthlyFeeAmount),
                billType: BillType.FIRST_MONTHLY_FEE,
                orderNo: order.orderNo,
                source: "order.monthlyFee"
              }
            })
          );
        }

        const bills = await tx.receivableBill.findMany({
          orderBy: { createdAt: "asc" },
          where: { deletedAt: null, orderId }
        });

        return { bills, createdBills };
      })
    );

    for (const bill of result.createdBills) {
      await this.auditService.write({
        action: AuditAction.CREATE,
        after: toBillView(bill),
        entityId: bill.id,
        entityType: "receivable_bill",
        ipAddress: context.ipAddress,
        module: "billing",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }

    return {
      bills: result.bills.map(toBillView),
      createdCount: result.createdBills.length
    };
  }

  async generateNextMonthlyRentBill(orderId: string, user: RequestUser, context: RequestContext) {
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrderFinance(order, user);
    ensureOrderCanGenerateMonthlyRentBill(order);

    const monthlyRentAmount = resolveMonthlyRentAmount(order);
    if (monthlyRentAmount === null) {
      throw new BadRequestException(MISSING_MONTHLY_RENT_AMOUNT_MESSAGE);
    }

    const result = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) =>
        generateNextMonthlyRentBillInTransaction(tx, order, monthlyRentAmount, user.id, "SINGLE")
      )
    );

    if (result.created) {
      await writeMonthlyRentBillAudit(this.auditService, result.bill, user, context, "SINGLE");
    }

    return { ...toBillView(result.bill), created: result.created };
  }

  async generateMonthlyRentBills(dto: GenerateMonthlyRentBillsDto, user: RequestUser, context: RequestContext) {
    const billingDate = parseBillingDate(dto.billingDate, "billingDate");
    const dryRun = Boolean(dto.dryRun);
    const orders = await this.prisma.subscriptionOrder.findMany({
      include: financeOrderInclude,
      orderBy: { createdAt: "asc" },
      where: { deletedAt: null, orderStatus: OrderStatus.ACTIVE }
    });
    const items: MonthlyRentBatchItem[] = [];

    for (const order of orders) {
      const item = await this.generateMonthlyRentBillBatchItem(order, billingDate, dryRun, user, context);
      items.push(item);
    }

    return {
      billingDate: toIsoDate(billingDate),
      dryRun,
      failedCount: items.filter((item) => isFailedMonthlyRentAction(item.action)).length,
      generatedCount: items.filter((item) => isGeneratedMonthlyRentAction(item.action)).length,
      items,
      skippedCount: items.filter((item) => isSkippedMonthlyRentAction(item.action)).length
    };
  }

  private async generateMonthlyRentBillBatchItem(
    order: FinanceOrder,
    billingDate: Date,
    dryRun: boolean,
    user: RequestUser,
    context: RequestContext
  ): Promise<MonthlyRentBatchItem> {
    const baseItem = { dryRun, orderId: order.id, orderNo: order.orderNo };

    try {
      ensureCanAccessOrderFinance(order, user);

      if (!order.actualDeliveryAt) {
        return {
          ...baseItem,
          action: dryRun ? "DRY_RUN_SKIP" : "SKIPPED_NOT_DUE",
          reason: MONTHLY_RENT_NOT_STARTED_MESSAGE
        };
      }

      const monthlyRentAmount = resolveMonthlyRentAmount(order);
      if (monthlyRentAmount === null) {
        throw new BadRequestException(MISSING_MONTHLY_RENT_AMOUNT_MESSAGE);
      }

      const monthlyBills = await findValidMonthlyRentBills(this.prisma, order.id);
      const period = buildNextMonthlyRentPeriod(order.actualDeliveryAt, monthlyBills.length);
      const existingSamePeriod = findMonthlyRentBillForPeriod(monthlyBills, period);

      if (existingSamePeriod) {
        return monthlyRentBatchItem(baseItem, dryRun ? "DRY_RUN_SKIP" : "SKIPPED_EXISTING", {
          amount: existingSamePeriod.amount,
          bill: existingSamePeriod,
          period,
          reason: "已存在同账期月租账单"
        });
      }

      if (period.start.getTime() > billingDate.getTime()) {
        const existingCurrentPeriod = findMonthlyRentBillCoveringDate(monthlyBills, billingDate);

        return monthlyRentBatchItem(baseItem, dryRun ? "DRY_RUN_SKIP" : existingCurrentPeriod ? "SKIPPED_EXISTING" : "SKIPPED_NOT_DUE", {
          amount: existingCurrentPeriod?.amount ?? monthlyRentAmount,
          bill: existingCurrentPeriod,
          period: existingCurrentPeriod ? periodFromBill(existingCurrentPeriod) : period,
          reason: existingCurrentPeriod ? "当前账期已存在月租账单" : "下一期月租账单尚未到生成日期"
        });
      }

      if (dryRun) {
        return monthlyRentBatchItem(baseItem, "DRY_RUN_GENERATE", { amount: monthlyRentAmount, period });
      }

      const result = await withUniqueBusinessNoRetry(() =>
        this.prisma.$transaction(async (tx) =>
          createMonthlyRentBillForPeriodIfAbsent(tx, order, monthlyRentAmount, period, user.id, "BATCH")
        )
      );

      if (result.created) {
        await writeMonthlyRentBillAudit(this.auditService, result.bill, user, context, "BATCH");
      }

      return monthlyRentBatchItem(baseItem, result.created ? "GENERATED" : "SKIPPED_EXISTING", {
        amount: result.bill.amount,
        bill: result.bill,
        period,
        reason: result.created ? undefined : "已存在同账期月租账单"
      });
    } catch (error) {
      return {
        ...baseItem,
        action: dryRun ? "DRY_RUN_FAILED" : "FAILED",
        error: getErrorMessage(error)
      };
    }
  }

  async listOrderBills(orderId: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrderFinance(order, user);

    const bills = await this.prisma.receivableBill.findMany({
      orderBy: { createdAt: "asc" },
      where: { deletedAt: null, orderId }
    });

    return bills.map(toBillView);
  }

  async createPayment(dto: CreatePaymentDto, user: RequestUser, context: RequestContext) {
    assertPositiveInteger(dto.paymentAmount, "paymentAmount");
    const receivedAt = parseDateTime(dto.receivedAt, "receivedAt");
    const order = await this.findOrderOrThrow(dto.orderId);
    ensureCanAccessOrderFinance(order, user);

    if (order.customerId !== dto.customerId) {
      throw new BadRequestException(PAYMENT_CUSTOMER_MISMATCH_MESSAGE);
    }

    const payment = await withUniqueBusinessNoRetry(() =>
      this.prisma.paymentRecord.create({
        data: {
          createdBy: user.id,
          customerId: dto.customerId,
          orderId: dto.orderId,
          payerAccount: dto.payerAccount,
          payerName: dto.payerName,
          paymentAmount: BigInt(dto.paymentAmount),
          paymentMethod: dto.paymentMethod,
          paymentNo: createBusinessNo("PAY"),
          paymentProofUrls: toJsonValue(dto.paymentProofUrls ?? []),
          paymentStatus: PaymentStatus.CONFIRMED,
          receivedAt,
          remark: dto.remark,
          updatedBy: user.id
        }
      })
    );

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toPaymentView(payment, 0n),
      entityId: payment.id,
      entityType: "payment_record",
      ipAddress: context.ipAddress,
      module: "payment",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toPaymentView(payment, 0n);
  }

  async writeOffPayment(paymentId: string, dto: WriteOffPaymentDto, user: RequestUser, context: RequestContext) {
    validateWriteOffDto(dto);

    const result = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const payment = await tx.paymentRecord.findUnique({
          include: paymentWriteOffOrderInclude,
          where: { id: paymentId }
        });

        if (!payment || payment.deletedAt) {
          throw new NotFoundException(PAYMENT_NOT_FOUND_MESSAGE);
        }

        ensureCanAccessOrderFinance(payment.order, user);

        if (payment.paymentStatus !== PaymentStatus.CONFIRMED) {
          throw new BadRequestException(PAYMENT_NOT_CONFIRMED_MESSAGE);
        }

        const requestedAmount = dto.items.reduce((sum, item) => sum + BigInt(item.writeOffAmount), 0n);
        const paymentWrittenOffAmount = sumWriteOffAmount(payment.writeOffs);
        const paymentRemainingAmount = payment.paymentAmount - paymentWrittenOffAmount;

        if (requestedAmount > paymentRemainingAmount) {
          throw new BadRequestException(PAYMENT_WRITE_OFF_OVER_AMOUNT_MESSAGE);
        }

        const billIds = dto.items.map((item) => item.billId);
        const bills = await tx.receivableBill.findMany({
          where: { deletedAt: null, id: { in: billIds } }
        });

        if (bills.length !== billIds.length) {
          throw new NotFoundException(BILL_NOT_FOUND_MESSAGE);
        }

        const billById = new Map(bills.map((bill) => [bill.id, bill]));
        const createdWriteOffs: PaymentWriteOffRecord[] = [];
        const updatedBills: ReceivableBillRecord[] = [];
        const createdDepositLedgers: DepositLedgerRecord[] = [];
        const now = new Date();

        for (const item of dto.items) {
          const bill = billById.get(item.billId);

          if (!bill) {
            throw new NotFoundException(BILL_NOT_FOUND_MESSAGE);
          }

          if (bill.orderId !== payment.orderId || bill.customerId !== payment.customerId) {
            throw new BadRequestException(BILL_PAYMENT_SCOPE_MISMATCH_MESSAGE);
          }

          if (bill.billStatus === BillStatus.CANCELLED) {
            throw new BadRequestException(CANCELLED_BILL_WRITE_OFF_MESSAGE);
          }

          const writeOffAmount = BigInt(item.writeOffAmount);

          if (writeOffAmount > bill.remainingAmount) {
            throw new BadRequestException(BILL_WRITE_OFF_OVER_AMOUNT_MESSAGE);
          }

          const nextRemainingAmount = bill.remainingAmount - writeOffAmount;
          const nextPaidAmount = bill.paidAmount + writeOffAmount;
          const nextBillStatus = nextRemainingAmount === 0n ? BillStatus.PAID : BillStatus.PARTIALLY_PAID;
          const updatedBill = await tx.receivableBill.update({
            data: {
              billStatus: nextBillStatus,
              paidAmount: nextPaidAmount,
              paidAt: nextBillStatus === BillStatus.PAID ? now : bill.paidAt,
              remainingAmount: nextRemainingAmount,
              updatedBy: user.id
            },
            where: { id: bill.id }
          });
          const writeOff = await tx.paymentWriteOff.create({
            data: {
              billId: bill.id,
              createdBy: user.id,
              customerId: payment.customerId,
              orderId: payment.orderId,
              paymentId: payment.id,
              remark: dto.remark,
              writeOffAmount,
              writeOffAt: now
            }
          });

          createdWriteOffs.push(writeOff);
          updatedBills.push(updatedBill);
          billById.set(bill.id, updatedBill);

          if (updatedBill.billType === BillType.DEPOSIT && updatedBill.billStatus === BillStatus.PAID) {
            const existingCollectLedger = await tx.depositLedger.findFirst({
              where: {
                billId: updatedBill.id,
                deletedAt: null,
                transactionType: DepositTransactionType.COLLECT
              }
            });

            if (!existingCollectLedger) {
              const previousBalance = await calculateDepositBalance(tx, payment.customerId, payment.orderId);
              const ledgerAmount = updatedBill.paidAmount;
              const ledger = await tx.depositLedger.create({
                data: {
                  amount: ledgerAmount,
                  balanceAfter: previousBalance + ledgerAmount,
                  billId: updatedBill.id,
                  createdBy: user.id,
                  customerId: payment.customerId,
                  ledgerNo: createBusinessNo("DPL"),
                  occurredAt: now,
                  orderId: payment.orderId,
                  paymentId: payment.id,
                  remark: dto.remark,
                  snapshot: toJsonValue({
                    bill: toBillView(updatedBill),
                    paymentNo: payment.paymentNo,
                    writeOffAmount: Number(writeOffAmount)
                  }),
                  transactionStatus: DepositTransactionStatus.CONFIRMED,
                  transactionType: DepositTransactionType.COLLECT
                }
              });
              createdDepositLedgers.push(ledger);
            }
          }
        }

        const paymentAfter = await tx.paymentRecord.findUniqueOrThrow({
          include: paymentWriteOffInclude,
          where: { id: payment.id }
        });

        return {
          bills: updatedBills,
          depositLedgers: createdDepositLedgers,
          payment: paymentAfter,
          writeOffs: createdWriteOffs
        };
      })
    );

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: result.writeOffs.map(toWriteOffView),
      entityId: paymentId,
      entityType: "payment_write_off",
      ipAddress: context.ipAddress,
      module: "payment",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    for (const ledger of result.depositLedgers) {
      await this.auditService.write({
        action: AuditAction.CREATE,
        after: toDepositLedgerView(ledger),
        entityId: ledger.id,
        entityType: "deposit_ledger",
        ipAddress: context.ipAddress,
        module: "deposit_ledger",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }

    const writtenOffAmount = sumWriteOffAmount(result.payment.writeOffs);

    return {
      bills: result.bills.map(toBillView),
      depositLedgers: result.depositLedgers.map(toDepositLedgerView),
      payment: toPaymentView(result.payment, writtenOffAmount),
      writeOffs: result.writeOffs.map(toWriteOffView)
    };
  }

  async getOrderFinanceSummary(orderId: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrderFinance(order, user);

    const bills = await this.prisma.receivableBill.findMany({
      orderBy: { createdAt: "asc" },
      where: { billStatus: { not: BillStatus.CANCELLED }, deletedAt: null, orderId }
    });
    const deposit = summarizeBills(bills, BillType.DEPOSIT);
    const firstMonthlyFee = summarizeBills(bills, BillType.FIRST_MONTHLY_FEE);
    const totalReceivableAmount = bills.reduce((sum, bill) => sum + bill.amount, 0n);
    const totalPaidAmount = bills.reduce((sum, bill) => sum + bill.paidAmount, 0n);

    return {
      depositPaidAmount: Number(deposit.paidAmount),
      depositReceivableAmount: Number(deposit.receivableAmount),
      depositStatus: deposit.status,
      firstMonthlyFeePaidAmount: Number(firstMonthlyFee.paidAmount),
      firstMonthlyFeeReceivableAmount: Number(firstMonthlyFee.receivableAmount),
      firstMonthlyFeeStatus: firstMonthlyFee.status,
      totalPaidAmount: Number(totalPaidAmount),
      totalReceivableAmount: Number(totalReceivableAmount),
      deliveryPaymentSatisfied:
        deposit.status === BillStatus.PAID && firstMonthlyFee.status === BillStatus.PAID
    };
  }

  private async findOrderOrThrow(orderId: string) {
    const order = await this.prisma.subscriptionOrder.findUnique({
      include: financeOrderInclude,
      where: { id: orderId }
    });

    if (!order || order.deletedAt) {
      throw new NotFoundException(ORDER_NOT_FOUND_MESSAGE);
    }

    return order;
  }
}

async function createInitialBill(
  tx: Prisma.TransactionClient,
  order: FinanceOrder,
  input: {
    amount: bigint;
    billPeriodEnd?: Date | null;
    billPeriodStart?: Date | null;
    billType: BillType;
    createdBy: string;
    dueDate: Date;
    snapshot: Record<string, unknown>;
  }
) {
  return tx.receivableBill.create({
    data: {
      amount: input.amount,
      billNo: createBusinessNo("BIL"),
      billPeriodEnd: input.billPeriodEnd ?? null,
      billPeriodStart: input.billPeriodStart ?? null,
      billStatus: BillStatus.PENDING,
      billType: input.billType,
      createdBy: input.createdBy,
      customerId: order.customerId,
      dueDate: input.dueDate,
      orderId: order.id,
      paidAmount: 0n,
      remainingAmount: input.amount,
      snapshot: toJsonValue(input.snapshot),
      updatedBy: input.createdBy
    }
  });
}

async function generateNextMonthlyRentBillInTransaction(
  tx: Prisma.TransactionClient,
  order: FinanceOrder,
  amount: bigint,
  userId: string,
  source: MonthlyRentBillSource
) {
  if (!order.actualDeliveryAt) {
    throw new BadRequestException(MONTHLY_RENT_NOT_STARTED_MESSAGE);
  }

  const monthlyBills = await findValidMonthlyRentBills(tx, order.id);
  const period = buildNextMonthlyRentPeriod(order.actualDeliveryAt, monthlyBills.length);
  return createMonthlyRentBillForPeriodIfAbsent(tx, order, amount, period, userId, source);
}

async function createMonthlyRentBillForPeriodIfAbsent(
  tx: Prisma.TransactionClient,
  order: FinanceOrder,
  amount: bigint,
  period: MonthlyRentPeriod,
  userId: string,
  source: MonthlyRentBillSource
) {
  const existingBill = await tx.receivableBill.findFirst({
    where: monthlyRentPeriodWhere(order.id, period)
  });

  if (existingBill) {
    return { bill: existingBill, created: false, period };
  }

  const bill = await tx.receivableBill.create({
    data: {
      amount,
      billNo: createBusinessNo("BIL"),
      billPeriodEnd: period.end,
      billPeriodStart: period.start,
      billStatus: BillStatus.PENDING,
      billType: BillType.MONTHLY_RENT,
      createdBy: userId,
      customerId: order.customerId,
      dueDate: period.start,
      orderId: order.id,
      paidAmount: 0n,
      remainingAmount: amount,
      snapshot: toJsonValue(buildMonthlyRentBillSnapshot(order, period, amount, source)),
      updatedBy: userId
    }
  });

  return { bill, created: true, period };
}

async function findValidMonthlyRentBills(
  client: Pick<Prisma.TransactionClient, "receivableBill">,
  orderId: string
) {
  return client.receivableBill.findMany({
    orderBy: [{ billPeriodStart: "asc" }, { createdAt: "asc" }],
    where: {
      billStatus: { not: BillStatus.CANCELLED },
      billType: BillType.MONTHLY_RENT,
      deletedAt: null,
      orderId
    }
  });
}

function monthlyRentPeriodWhere(orderId: string, period: MonthlyRentPeriod) {
  return {
    billPeriodEnd: period.end,
    billPeriodStart: period.start,
    billStatus: { not: BillStatus.CANCELLED },
    billType: BillType.MONTHLY_RENT,
    deletedAt: null,
    orderId
  } satisfies Prisma.ReceivableBillWhereInput;
}

function findMonthlyRentBillForPeriod(bills: ReceivableBillRecord[], period: MonthlyRentPeriod) {
  return bills.find(
    (bill) =>
      bill.billPeriodStart?.getTime() === period.start.getTime() &&
      bill.billPeriodEnd?.getTime() === period.end.getTime()
  );
}

function findMonthlyRentBillCoveringDate(bills: ReceivableBillRecord[], billingDate: Date) {
  return bills.find(
    (bill) =>
      bill.billPeriodStart !== null &&
      bill.billPeriodEnd !== null &&
      bill.billPeriodStart.getTime() <= billingDate.getTime() &&
      bill.billPeriodEnd.getTime() >= billingDate.getTime()
  );
}

function periodFromBill(bill: ReceivableBillRecord): MonthlyRentPeriod {
  return {
    end: bill.billPeriodEnd ?? new Date(0),
    index: 0,
    start: bill.billPeriodStart ?? new Date(0)
  };
}

function buildNextMonthlyRentPeriod(actualDeliveryAt: Date, existingMonthlyRentBillCount: number): MonthlyRentPeriod {
  const startDate = toBillingDateOnly(actualDeliveryAt);
  const index = existingMonthlyRentBillCount + 1;
  const start = addMonthsClamped(startDate, index);
  const end = addDays(addMonthsClamped(start, 1), -1);
  return { end, index, start };
}

function toBillingDateOnly(value: Date) {
  const shifted = new Date(value.getTime() + CHINA_TIME_OFFSET_MINUTES * 60 * 1000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

function addMonthsClamped(value: Date, months: number) {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth() + months;
  const day = value.getUTCDate();
  const targetFirstDay = new Date(Date.UTC(year, month, 1));
  const targetYear = targetFirstDay.getUTCFullYear();
  const targetMonth = targetFirstDay.getUTCMonth();
  const targetLastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, targetLastDay)));
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function buildMonthlyRentBillSnapshot(
  order: FinanceOrder,
  period: MonthlyRentPeriod,
  amount: bigint,
  source: MonthlyRentBillSource
) {
  return {
    amount: Number(amount),
    billType: BillType.MONTHLY_RENT,
    customer: {
      id: order.customerId,
      mobile: order.customer.mobile,
      name: order.customer.name
    },
    orderId: order.id,
    orderNo: order.orderNo,
    periodEnd: toIsoDate(period.end),
    periodIndex: period.index,
    periodStart: toIsoDate(period.start),
    productId: order.productId,
    productVersionId: order.productVersionId,
    quote: {
      id: order.quoteId,
      quoteNo: order.quote.quoteNo
    },
    source,
    vehicle: order.vehicle
      ? {
          id: order.vehicle.id,
          plateNo: order.vehicle.plateNo,
          vehicleNo: order.vehicle.vehicleNo,
          vin: order.vehicle.vin
        }
      : null,
    vehicleId: order.vehicleId,
    vehicleModel: order.vehicleModel
  };
}

async function writeMonthlyRentBillAudit(
  auditService: AuditService,
  bill: ReceivableBillRecord,
  user: RequestUser,
  context: RequestContext,
  source: MonthlyRentBillSource
) {
  await auditService.write({
    action: AuditAction.CREATE,
    after: {
      amount: Number(bill.amount),
      bill: toBillView(bill),
      billId: bill.id,
      billType: bill.billType,
      orderId: bill.orderId,
      periodEnd: toIsoDate(bill.billPeriodEnd),
      periodStart: toIsoDate(bill.billPeriodStart),
      source
    },
    entityId: bill.id,
    entityType: "receivable_bill",
    ipAddress: context.ipAddress,
    module: "billing",
    operatorId: user.id,
    userAgent: context.userAgent
  });
}

function monthlyRentBatchItem(
  baseItem: Pick<MonthlyRentBatchItem, "dryRun" | "orderId" | "orderNo">,
  action: MonthlyRentBatchAction,
  options: {
    amount?: bigint;
    bill?: ReceivableBillRecord;
    period?: MonthlyRentPeriod;
    reason?: string;
  } = {}
): MonthlyRentBatchItem {
  return {
    ...baseItem,
    action,
    amount: options.amount === undefined ? undefined : Number(options.amount),
    billId: options.bill?.id,
    periodEnd: options.period ? toIsoDate(options.period.end) ?? undefined : undefined,
    periodStart: options.period ? toIsoDate(options.period.start) ?? undefined : undefined,
    reason: options.reason
  };
}

function isGeneratedMonthlyRentAction(action: MonthlyRentBatchAction) {
  return action === "GENERATED" || action === "DRY_RUN_GENERATE";
}

function isSkippedMonthlyRentAction(action: MonthlyRentBatchAction) {
  return action === "SKIPPED_NOT_DUE" || action === "SKIPPED_EXISTING" || action === "DRY_RUN_SKIP";
}

function isFailedMonthlyRentAction(action: MonthlyRentBatchAction) {
  return action === "FAILED" || action === "DRY_RUN_FAILED";
}

function ensureOrderCanGenerateInitialBills(order: FinanceOrder) {
  if (FINAL_ORDER_STATUSES.has(order.orderStatus)) {
    throw new BadRequestException("订单已取消、终止或完成，不能生成应收账单");
  }
}

function ensureOrderCanGenerateMonthlyRentBill(order: FinanceOrder) {
  if (order.orderStatus !== OrderStatus.ACTIVE) {
    throw new BadRequestException(MONTHLY_RENT_ORDER_STATUS_MESSAGE);
  }
  if (!order.actualDeliveryAt) {
    throw new BadRequestException(MONTHLY_RENT_NOT_STARTED_MESSAGE);
  }
}

function ensureCanAccessOrderFinance(order: FinanceOrder, user: RequestUser) {
  if (!canViewAllFinanceOrders(user) && order.application.salesUserId !== user.id) {
    throw new ForbiddenException(ORDER_FINANCE_FORBIDDEN_MESSAGE);
  }
}

function canViewAllFinanceOrders(user: RequestUser) {
  return user.roles.some((role) => ["ADMIN", "FI", "GM", "OP"].includes(role));
}

function resolveDepositAmount(order: FinanceOrder) {
  return pickPositiveAmount(
    order.finalDepositAmount,
    order.depositAmount,
    readSnapshotAmount(order.quoteSnapshot, ["finalDepositAmount"]),
    readSnapshotAmount(order.quoteSnapshot, ["depositAmount"]),
    readSnapshotAmount(order.quoteSnapshot, ["pricing", "depositAmount"])
  );
}

function resolveFirstMonthlyFeeAmount(order: FinanceOrder) {
  return pickPositiveAmount(
    order.monthlyFeeAmount,
    readSnapshotAmount(order.quoteSnapshot, ["monthlyFeeAmount"]),
    readSnapshotAmount(order.quoteSnapshot, ["pricing", "monthlyFeeAmount"])
  );
}

function resolveMonthlyRentAmount(order: FinanceOrder) {
  return pickPositiveAmount(
    order.monthlyFeeAmount,
    readSnapshotAmount(order.quoteSnapshot, ["pricing", "monthlyFeeAmount"]),
    readSnapshotAmount(order.quoteSnapshot, ["monthlyFeeAmount"]),
    order.quote.monthlyFeeAmount
  );
}

function pickPositiveAmount(...values: unknown[]) {
  for (const value of values) {
    const amount = toPositiveBigInt(value);
    if (amount !== null) {
      return amount;
    }
  }
  return null;
}

function readSnapshotAmount(snapshot: unknown, path: string[]) {
  let current: unknown = snapshot;

  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }

  return current;
}

function toPositiveBigInt(value: unknown) {
  if (typeof value === "bigint") {
    return value > 0n ? value : null;
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : null;
  }

  return null;
}

function buildFirstMonthlyFeePeriod(startDate: Date | null) {
  if (!startDate) {
    return null;
  }

  const start = new Date(startDate);
  const end = new Date(startDate);
  end.setMonth(end.getMonth() + 1);
  end.setDate(end.getDate() - 1);
  return { end, start };
}

async function calculateDepositBalance(tx: Prisma.TransactionClient, customerId: string, orderId: string) {
  const ledgers = await tx.depositLedger.findMany({
    where: {
      customerId,
      deletedAt: null,
      orderId,
      transactionStatus: DepositTransactionStatus.CONFIRMED
    }
  });

  return ledgers.reduce((balance, ledger) => balance + signedDepositLedgerAmount(ledger), 0n);
}

function signedDepositLedgerAmount(ledger: Pick<DepositLedgerRecord, "amount" | "transactionType">) {
  if (
    ledger.transactionType === DepositTransactionType.DEDUCT ||
    ledger.transactionType === DepositTransactionType.REFUND
  ) {
    return -ledger.amount;
  }

  if (ledger.transactionType === DepositTransactionType.COLLECT) {
    return ledger.amount;
  }

  return 0n;
}

function validateWriteOffDto(dto: WriteOffPaymentDto) {
  if (!Array.isArray(dto.items) || dto.items.length === 0) {
    throw new BadRequestException("核销明细不能为空");
  }

  const billIds = new Set<string>();
  for (const item of dto.items) {
    assertPositiveInteger(item.writeOffAmount, "writeOffAmount");
    if (billIds.has(item.billId)) {
      throw new BadRequestException(DUPLICATE_WRITE_OFF_BILL_MESSAGE);
    }
    billIds.add(item.billId);
  }
}

function assertPositiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequestException(`${field} 必须为大于 0 的整数`);
  }
}

function parseDateTime(value: string, field: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} 时间格式不正确`);
  }
  return date;
}

function parseBillingDate(value: string, field: string) {
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      parsed.getUTCFullYear() === Number(year) &&
      parsed.getUTCMonth() === Number(month) - 1 &&
      parsed.getUTCDate() === Number(day)
    ) {
      return parsed;
    }
    throw new BadRequestException(`${field} 日期格式不正确`);
  }

  return toBillingDateOnly(parseDateTime(value, field));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sumWriteOffAmount(writeOffs: Array<{ deletedAt?: Date | null; writeOffAmount: bigint }>) {
  return writeOffs
    .filter((writeOff) => !writeOff.deletedAt)
    .reduce((sum, writeOff) => sum + writeOff.writeOffAmount, 0n);
}

function summarizeBills(bills: ReceivableBillRecord[], billType: BillType) {
  const typedBills = bills.filter((bill) => bill.billType === billType);
  const receivableAmount = typedBills.reduce((sum, bill) => sum + bill.amount, 0n);
  const paidAmount = typedBills.reduce((sum, bill) => sum + bill.paidAmount, 0n);
  const remainingAmount = typedBills.reduce((sum, bill) => sum + bill.remainingAmount, 0n);

  return {
    paidAmount,
    receivableAmount,
    remainingAmount,
    status: resolveAggregateBillStatus(typedBills, paidAmount, remainingAmount)
  };
}

function resolveAggregateBillStatus(
  bills: ReceivableBillRecord[],
  paidAmount: bigint,
  remainingAmount: bigint
) {
  if (bills.length === 0) {
    return null;
  }

  if (remainingAmount === 0n) {
    return BillStatus.PAID;
  }

  if (paidAmount > 0n) {
    return BillStatus.PARTIALLY_PAID;
  }

  if (bills.some((bill) => bill.billStatus === BillStatus.OVERDUE)) {
    return BillStatus.OVERDUE;
  }

  return BillStatus.PENDING;
}

function toBillView(bill: ReceivableBillRecord) {
  return {
    amount: Number(bill.amount),
    billNo: bill.billNo,
    billPeriodEnd: toIsoDate(bill.billPeriodEnd),
    billPeriodStart: toIsoDate(bill.billPeriodStart),
    billStatus: bill.billStatus,
    billType: bill.billType,
    cancelledAt: toIsoDateTime(bill.cancelledAt),
    createdAt: toIsoDateTime(bill.createdAt),
    customerId: bill.customerId,
    dueDate: toIsoDateTime(bill.dueDate),
    id: bill.id,
    orderId: bill.orderId,
    paidAmount: Number(bill.paidAmount),
    paidAt: toIsoDateTime(bill.paidAt),
    remainingAmount: Number(bill.remainingAmount),
    remark: bill.remark,
    snapshot: bill.snapshot,
    updatedAt: toIsoDateTime(bill.updatedAt)
  };
}

function toPaymentView(payment: PaymentRecordRecord | PaymentWithWriteOffs | PaymentWithOrderAndWriteOffs, writtenOffAmount: bigint) {
  const remainingAmount = payment.paymentAmount - writtenOffAmount;
  return {
    createdAt: toIsoDateTime(payment.createdAt),
    customerId: payment.customerId,
    id: payment.id,
    orderId: payment.orderId,
    payerAccount: payment.payerAccount,
    payerName: payment.payerName,
    paymentAmount: Number(payment.paymentAmount),
    paymentMethod: payment.paymentMethod,
    paymentNo: payment.paymentNo,
    paymentProofUrls: payment.paymentProofUrls ?? [],
    paymentStatus: payment.paymentStatus,
    receivedAt: toIsoDateTime(payment.receivedAt),
    remainingAmount: Number(remainingAmount),
    remark: payment.remark,
    updatedAt: toIsoDateTime(payment.updatedAt),
    writtenOffAmount: Number(writtenOffAmount)
  };
}

function toWriteOffView(writeOff: PaymentWriteOffRecord) {
  return {
    billId: writeOff.billId,
    createdAt: toIsoDateTime(writeOff.createdAt),
    customerId: writeOff.customerId,
    id: writeOff.id,
    orderId: writeOff.orderId,
    paymentId: writeOff.paymentId,
    remark: writeOff.remark,
    writeOffAmount: Number(writeOff.writeOffAmount),
    writeOffAt: toIsoDateTime(writeOff.writeOffAt)
  };
}

function toDepositLedgerView(ledger: DepositLedgerRecord) {
  return {
    amount: Number(ledger.amount),
    balanceAfter: Number(ledger.balanceAfter),
    billId: ledger.billId,
    createdAt: toIsoDateTime(ledger.createdAt),
    customerId: ledger.customerId,
    id: ledger.id,
    ledgerNo: ledger.ledgerNo,
    occurredAt: toIsoDateTime(ledger.occurredAt),
    orderId: ledger.orderId,
    paymentId: ledger.paymentId,
    remark: ledger.remark,
    snapshot: ledger.snapshot,
    transactionStatus: ledger.transactionStatus,
    transactionType: ledger.transactionType
  };
}

function toIsoDateTime(value: Date | null) {
  return value ? value.toISOString() : null;
}

function toIsoDate(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return toPlain(value) as Prisma.InputJsonValue;
}

function toPlain(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPlain(item)]));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
