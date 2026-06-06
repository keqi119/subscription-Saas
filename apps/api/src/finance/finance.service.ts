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
import { CreatePaymentDto, WriteOffPaymentDto } from "./dto/finance.dto";

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

const financeOrderInclude = {
  application: { select: { applicationNo: true, id: true, salesUserId: true } },
  customer: { select: { grade: true, id: true, mobile: true, name: true } },
  quote: { select: { id: true, quoteNo: true, status: true } }
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

function ensureOrderCanGenerateInitialBills(order: FinanceOrder) {
  if (FINAL_ORDER_STATUSES.has(order.orderStatus)) {
    throw new BadRequestException("订单已取消、终止或完成，不能生成应收账单");
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
