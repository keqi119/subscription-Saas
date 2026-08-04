import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  AuditAction,
  BillStatus,
  BillType,
  CollectionAction,
  CollectionActionResult,
  CollectionActionType,
  CollectionCase,
  CollectionCaseBill,
  CollectionCaseStatus,
  CollectionLevel,
  ContactMethod,
  DepositLedger,
  DepositTransactionStatus,
  DepositTransactionType,
  DebitAttemptStatus,
  OrderStatus,
  PaymentChannel,
  PaymentMethod,
  PaymentOrderStatus,
  PaymentRecord,
  PaymentStatus,
  PaymentWriteOff,
  Prisma,
  ReceivableBill,
  VehicleDamageResponsibleParty,
  VehicleReturn,
  VehicleReturnDamage,
  VehicleReturnDamageStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import {
  billingSourceKey,
  buildBillingCycleForDelivery
} from "../billing-automation/billing-automation.calendar";
import { cancelPendingBillAutomationJobs } from "../billing-automation/billing-automation.repository";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import {
  CloseCollectionCaseDto,
  CollectionCasesQueryDto,
  CreateCollectionActionDto,
  CreatePaymentDto,
  DeductDepositDto,
  GenerateMonthlyRentBillsDto,
  OverdueBillsQueryDto,
  RefundDepositDto,
  RefreshOverdueBillsDto,
  WriteOffPaymentDto
} from "./dto/finance.dto";

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
const COLLECTION_CASE_NOT_FOUND_MESSAGE = "催收案件不存在";
const COLLECTION_CASE_ACTION_CLOSED_MESSAGE = "已关闭催收案件不能新增催收动作";
const COLLECTION_CASE_CLOSE_UNSETTLED_MESSAGE = "催收案件仍有关联账单未结清，不能关闭";
const DAMAGE_FEE_RETURN_NOT_COMPLETED_MESSAGE = "当前订单尚未完成退车，不能生成损伤费用账单";
const DAMAGE_FEE_EMPTY_MESSAGE = "当前订单无可生成账单的客户责任损伤费用";
const DAMAGE_FEE_BILL_REQUIRED_MESSAGE = "请选择损伤费用账单";
const DAMAGE_FEE_BILL_INVALID_MESSAGE = "只能扣减未结清的损伤费用账单";
const DEPOSIT_NOT_COLLECTED_MESSAGE = "订单尚未收取可用保证金";
const DEPOSIT_BALANCE_INSUFFICIENT_MESSAGE = "保证金余额不足，不能扣减";
const DEPOSIT_DEDUCT_OVER_BILL_MESSAGE = "扣减金额不能超过损伤费用账单剩余金额";
const DEPOSIT_REFUND_NOT_ALLOWED_MESSAGE = "当前订单尚未完成退车，不能退还保证金";
const DEPOSIT_REFUND_OVER_BALANCE_MESSAGE = "退款金额不能超过可用保证金余额";
const CHINA_TIME_OFFSET_MINUTES = 8 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const OVERDUE_BILL_STATUSES = [BillStatus.PENDING, BillStatus.PARTIALLY_PAID, BillStatus.OVERDUE] as const;

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

const overdueBillInclude = {
  collectionCaseBills: {
    include: { case: true },
    orderBy: { createdAt: "desc" },
    where: { deletedAt: null }
  },
  customer: { select: { id: true, mobile: true, name: true } },
  order: { include: financeOrderInclude }
} satisfies Prisma.ReceivableBillInclude;

const collectionCaseListInclude = {
  customer: { select: { id: true, mobile: true, name: true } },
  order: { select: { id: true, orderNo: true } }
} satisfies Prisma.CollectionCaseInclude;

const collectionCaseDetailInclude = {
  actions: {
    orderBy: { createdAt: "desc" },
    where: { deletedAt: null }
  },
  bills: {
    include: { bill: true },
    orderBy: { createdAt: "asc" },
    where: { deletedAt: null }
  },
  customer: { select: { id: true, mobile: true, name: true } },
  order: { include: financeOrderInclude }
} satisfies Prisma.CollectionCaseInclude;

type FinanceOrder = Prisma.SubscriptionOrderGetPayload<{ include: typeof financeOrderInclude }>;
type PaymentWithWriteOffs = Prisma.PaymentRecordGetPayload<{ include: typeof paymentWriteOffInclude }>;
type PaymentWithOrderAndWriteOffs = Prisma.PaymentRecordGetPayload<{ include: typeof paymentWriteOffOrderInclude }>;
type OverdueBillWithRelations = Prisma.ReceivableBillGetPayload<{ include: typeof overdueBillInclude }>;
type CollectionCaseListRecord = Prisma.CollectionCaseGetPayload<{ include: typeof collectionCaseListInclude }>;
type CollectionCaseDetailRecord = Prisma.CollectionCaseGetPayload<{ include: typeof collectionCaseDetailInclude }>;
type ReceivableBillRecord = ReceivableBill;
type PaymentRecordRecord = PaymentRecord;
type PaymentWriteOffRecord = PaymentWriteOff;
type DepositLedgerRecord = DepositLedger;
type VehicleReturnRecord = VehicleReturn;
type VehicleReturnDamageRecord = VehicleReturnDamage;
type CollectionCaseRecord = CollectionCase;
type CollectionCaseBillRecord = CollectionCaseBill;
type CollectionActionRecord = CollectionAction;
type MonthlyRentBillSource = "SINGLE" | "BATCH" | "AUTOMATION";
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

export interface MonthlyRentAutomationCycleInput {
  actorId: string | null;
  cycleNo: number;
  orderId: string;
  periodEnd: Date;
  periodStart: Date;
  sourceKey: string;
}

interface DepositBalanceDetails {
  availableBalance: bigint;
  collectedAmount: bigint;
  deductedAmount: bigint;
  latestLedger: DepositLedgerRecord | null;
  refundedAmount: bigint;
  releasedAmount: bigint;
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

interface CollectionCasePlan {
  bills: OverdueBillWithRelations[];
  collectionLevel: CollectionLevel;
  customerId: string;
  existingCase: CollectionCaseRecord | null;
  latestDueDate: Date;
  maxOverdueDays: number;
  orderId: string;
  snapshot: Record<string, unknown>;
  totalOverdueAmount: bigint;
}

export interface SettlePaymentOrderInput {
  callbackLogId?: string;
  callbackPayload?: unknown;
  debitAttempt?: {
    confirmedAmount: bigint;
    id: string;
    providerTransactionId: string;
    resolvedAt: Date;
    responseSnapshot: unknown;
  };
  eventType?: string;
  ipAddress?: string;
  operatorId: string | null;
  paidAmount: bigint;
  paidAt: Date;
  paymentOrderId: string;
  providerTradeNo?: string;
  providerTransactionId?: string;
  userAgent?: string;
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService
  ) {}

  async settlePaymentOrder(input: SettlePaymentOrderInput) {
    if (input.paidAmount <= 0n) {
      throw new BadRequestException("Payment amount must be positive.");
    }
    return withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await lockPaymentOrder(tx, input.paymentOrderId);
        const paymentOrder = await tx.paymentOrder.findUnique({
          include: {
            items: {
              orderBy: { createdAt: "asc" },
              where: { deletedAt: null }
            }
          },
          where: { id: input.paymentOrderId }
        });
        if (!paymentOrder || paymentOrder.deletedAt) {
          throw new NotFoundException("Payment order does not exist.");
        }
        if (paymentOrder.paymentStatus === PaymentOrderStatus.PAID) {
          if (input.callbackLogId) {
            await tx.paymentCallbackLog.update({
              data: {
                handled: true,
                handledAt: input.paidAt,
                paymentOrderId: paymentOrder.id
              },
              where: { id: input.callbackLogId }
            });
          }
          const existingWriteOffs = paymentOrder.paymentRecordId
            ? await tx.paymentWriteOff.findMany({
                select: { writeOffAmount: true },
                where: {
                  deletedAt: null,
                  paymentId: paymentOrder.paymentRecordId
                }
              })
            : [];
          const allocatedAmount = existingWriteOffs.reduce(
            (sum, item) => sum + item.writeOffAmount,
            0n
          );
          return {
            allocatedAmount,
            idempotent: true,
            paymentOrderId: paymentOrder.id,
            paymentRecordId: paymentOrder.paymentRecordId,
            unallocatedAmount: paymentOrder.paidAmount - allocatedAmount
          };
        }
        if (
          paymentOrder.paymentStatus !== PaymentOrderStatus.CREATED &&
          paymentOrder.paymentStatus !== PaymentOrderStatus.PENDING
        ) {
          throw new BadRequestException(
            "Current payment order status cannot be settled."
          );
        }
        if (input.paidAmount !== paymentOrder.amount) {
          throw new BadRequestException(
            "Payment amount does not match the payment order."
          );
        }
        if (!paymentOrder.customerId || !paymentOrder.orderId) {
          throw new BadRequestException(
            "Payment order is missing customer or order scope."
          );
        }

        const billIds = paymentOrder.items.map((item) => item.billId);
        await lockReceivableBills(tx, billIds);
        const bills = await tx.receivableBill.findMany({
          where: { deletedAt: null, id: { in: billIds } }
        });
        const billById = new Map(bills.map((bill) => [bill.id, bill]));
        const payment = await tx.paymentRecord.create({
          data: {
            createdBy: input.operatorId ?? undefined,
            customerId: paymentOrder.customerId,
            orderId: paymentOrder.orderId,
            payerAccount:
              input.providerTransactionId ?? input.providerTradeNo,
            payerName: "Customer online payment",
            paymentAmount: input.paidAmount,
            paymentMethod: paymentMethodForChannel(
              paymentOrder.paymentChannel
            ),
            paymentNo: createBusinessNo("PAY"),
            paymentProofUrls: toJsonValue([]),
            paymentStatus: PaymentStatus.CONFIRMED,
            receivedAt: input.paidAt,
            remark: `Online payment order ${paymentOrder.paymentOrderNo}`,
            updatedBy: input.operatorId ?? undefined
          }
        });

        let availableAmount = input.paidAmount;
        let allocatedAmount = 0n;
        const createdWriteOffs: PaymentWriteOffRecord[] = [];
        const settledBillIds: string[] = [];
        for (const item of paymentOrder.items) {
          const bill = billById.get(item.billId);
          if (!bill || bill.billStatus === BillStatus.CANCELLED) {
            continue;
          }
          if (
            bill.customerId !== paymentOrder.customerId ||
            bill.orderId !== paymentOrder.orderId
          ) {
            throw new BadRequestException(BILL_PAYMENT_SCOPE_MISMATCH_MESSAGE);
          }
          const writeOffAmount = calculateWriteOffAmount(
            item.amount,
            bill.remainingAmount,
            availableAmount
          );
          if (writeOffAmount <= 0n) {
            continue;
          }
          const nextRemainingAmount = bill.remainingAmount - writeOffAmount;
          const nextPaidAmount = bill.paidAmount + writeOffAmount;
          const nextBillStatus =
            nextRemainingAmount === 0n
              ? BillStatus.PAID
              : BillStatus.PARTIALLY_PAID;
          const updatedBill = await tx.receivableBill.update({
            data: {
              billStatus: nextBillStatus,
              paidAmount: nextPaidAmount,
              paidAt:
                nextBillStatus === BillStatus.PAID
                  ? input.paidAt
                  : bill.paidAt,
              remainingAmount: nextRemainingAmount,
              updatedBy: input.operatorId ?? undefined
            },
            where: { id: bill.id }
          });
          const writeOff = await tx.paymentWriteOff.create({
            data: {
              billId: bill.id,
              createdBy: input.operatorId ?? undefined,
              customerId: paymentOrder.customerId,
              orderId: paymentOrder.orderId,
              paymentId: payment.id,
              remark: `Payment order ${paymentOrder.paymentOrderNo} automatic write-off`,
              writeOffAmount,
              writeOffAt: input.paidAt
            }
          });
          createdWriteOffs.push(writeOff);
          availableAmount -= writeOffAmount;
          allocatedAmount += writeOffAmount;
          billById.set(bill.id, updatedBill);
          if (updatedBill.remainingAmount === 0n) {
            settledBillIds.push(updatedBill.id);
          }
          if (
            updatedBill.billType === BillType.DEPOSIT &&
            updatedBill.billStatus === BillStatus.PAID
          ) {
            const existingCollectLedger = await tx.depositLedger.findFirst({
              where: {
                billId: updatedBill.id,
                deletedAt: null,
                transactionType: DepositTransactionType.COLLECT
              }
            });
            if (!existingCollectLedger) {
              const previousBalance = await calculateDepositBalance(
                tx,
                paymentOrder.customerId,
                paymentOrder.orderId
              );
              await tx.depositLedger.create({
                data: {
                  amount: updatedBill.paidAmount,
                  balanceAfter: previousBalance + updatedBill.paidAmount,
                  billId: updatedBill.id,
                  createdBy: input.operatorId ?? undefined,
                  customerId: paymentOrder.customerId,
                  ledgerNo: createBusinessNo("DPL"),
                  occurredAt: input.paidAt,
                  orderId: paymentOrder.orderId,
                  paymentId: payment.id,
                  remark: `Payment order ${paymentOrder.paymentOrderNo} deposit collection`,
                  snapshot: toJsonValue({
                    paymentNo: payment.paymentNo,
                    writeOffAmount: writeOffAmount.toString()
                  }),
                  transactionStatus: DepositTransactionStatus.CONFIRMED,
                  transactionType: DepositTransactionType.COLLECT
                }
              });
            }
          }
        }

        await cancelPendingBillAutomationJobs(tx, settledBillIds);
        await this.reconcileCollectionCasesAfterSettlement(
          tx,
          billIds,
          input.paidAt,
          input.operatorId
        );
        if (input.debitAttempt) {
          const debitAttempt = await tx.debitAttempt.findUnique({
            select: { paymentOrderId: true },
            where: { id: input.debitAttempt.id }
          });
          if (debitAttempt?.paymentOrderId !== paymentOrder.id) {
            throw new BadRequestException(
              "Debit attempt does not belong to the payment order."
            );
          }
          await tx.debitAttempt.update({
            data: {
              confirmedAmount: input.debitAttempt.confirmedAmount,
              errorSnapshot: Prisma.JsonNull,
              lastErrorCode: null,
              lastErrorMessage: null,
              providerTransactionId:
                input.debitAttempt.providerTransactionId,
              resolvedAt: input.debitAttempt.resolvedAt,
              responseSnapshot: toJsonValue(
                input.debitAttempt.responseSnapshot
              ),
              status: DebitAttemptStatus.SUCCEEDED
            },
            where: { id: input.debitAttempt.id }
          });
        }
        const updatedPaymentOrder = await tx.paymentOrder.update({
          data: {
            callbackSnapshot:
              input.callbackPayload === undefined
                ? undefined
                : toJsonValue(input.callbackPayload),
            paidAmount: input.paidAmount,
            paidAt: input.paidAt,
            paymentRecordId: payment.id,
            paymentStatus: PaymentOrderStatus.PAID,
            providerTradeNo:
              input.providerTradeNo ?? paymentOrder.providerTradeNo,
            providerTransactionId:
              input.providerTransactionId ??
              paymentOrder.providerTransactionId,
            updatedBy: input.operatorId ?? undefined
          },
          where: { id: paymentOrder.id }
        });
        if (input.callbackLogId) {
          await tx.paymentCallbackLog.update({
            data: {
              handled: true,
              handledAt: input.paidAt,
              paymentOrderId: paymentOrder.id
            },
            where: { id: input.callbackLogId }
          });
        } else if (
          input.callbackPayload !== undefined ||
          input.eventType !== undefined
        ) {
          await tx.paymentCallbackLog.create({
            data: {
              eventType: input.eventType,
              handled: true,
              handledAt: input.paidAt,
              payload:
                input.callbackPayload === undefined
                  ? undefined
                  : toJsonValue(input.callbackPayload),
              paymentOrderId: paymentOrder.id,
              provider: paymentOrder.provider,
              providerTradeNo:
                input.providerTradeNo ?? paymentOrder.providerTradeNo,
              providerTransactionId: input.providerTransactionId,
              verified: true
            }
          });
        }
        await this.auditService.write(
          {
            action: AuditAction.UPDATE,
            after: {
              allocatedAmount: allocatedAmount.toString(),
              paymentRecordId: payment.id,
              paymentStatus: updatedPaymentOrder.paymentStatus,
              unallocatedAmount: availableAmount.toString()
            },
            before: { paymentStatus: paymentOrder.paymentStatus },
            entityId: updatedPaymentOrder.id,
            entityType: "payment_order",
            ipAddress: input.ipAddress,
            module: "payment",
            operatorId: input.operatorId ?? undefined,
            userAgent: input.userAgent
          },
          tx
        );
        await this.auditService.write(
          {
            action: AuditAction.CREATE,
            after: {
              paymentAmount: payment.paymentAmount.toString(),
              paymentNo: payment.paymentNo
            },
            entityId: payment.id,
            entityType: "payment_record",
            module: "payment",
            operatorId: input.operatorId ?? undefined
          },
          tx
        );
        for (const writeOff of createdWriteOffs) {
          await this.auditService.write(
            {
              action: AuditAction.CREATE,
              after: {
                billId: writeOff.billId,
                writeOffAmount: writeOff.writeOffAmount.toString()
              },
              entityId: writeOff.id,
              entityType: "payment_write_off",
              module: "payment",
              operatorId: input.operatorId ?? undefined
            },
            tx
          );
        }
        return {
          allocatedAmount,
          idempotent: false,
          paymentOrderId: updatedPaymentOrder.id,
          paymentRecordId: payment.id,
          unallocatedAmount: availableAmount
        };
      })
    );
  }

  private async reconcileCollectionCasesAfterSettlement(
    tx: Prisma.TransactionClient,
    billIds: string[],
    settledAt: Date,
    actorId: string | null
  ) {
    if (billIds.length === 0) {
      return;
    }
    const collectionCases = await tx.collectionCase.findMany({
      include: {
        bills: {
          include: {
            bill: {
              select: {
                billStatus: true,
                deletedAt: true,
                id: true,
                remainingAmount: true
              }
            }
          },
          where: { deletedAt: null }
        }
      },
      where: {
        bills: {
          some: {
            billId: { in: billIds },
            deletedAt: null
          }
        },
        caseStatus: CollectionCaseStatus.ACTIVE,
        deletedAt: null
      }
    });

    for (const collectionCase of collectionCases) {
      const activeCaseBills = collectionCase.bills.filter(
        (item) => !item.bill.deletedAt
      );
      for (const caseBill of activeCaseBills) {
        if (caseBill.overdueAmount !== caseBill.bill.remainingAmount) {
          await tx.collectionCaseBill.update({
            data: { overdueAmount: caseBill.bill.remainingAmount },
            where: { id: caseBill.id }
          });
        }
      }
      const totalOverdueAmount = activeCaseBills.reduce(
        (sum, item) => sum + item.bill.remainingAmount,
        0n
      );
      if (totalOverdueAmount > 0n) {
        await tx.collectionCase.update({
          data: {
            totalOverdueAmount,
            updatedBy: actorId ?? undefined
          },
          where: { id: collectionCase.id }
        });
        continue;
      }

      const updatedCase = await tx.collectionCase.update({
        data: {
          caseStatus: CollectionCaseStatus.CLOSED,
          closedAt: settledAt,
          closeReason: "PAYMENT_SETTLED",
          nextFollowUpAt: null,
          totalOverdueAmount: 0n,
          updatedBy: actorId ?? undefined
        },
        where: { id: collectionCase.id }
      });
      const action = await tx.collectionAction.create({
        data: {
          actionResult: CollectionActionResult.SUCCESS,
          actionType: CollectionActionType.CLOSE,
          caseId: collectionCase.id,
          contactMethod: ContactMethod.SYSTEM,
          content: "PAYMENT_SETTLED",
          createdBy: actorId ?? undefined,
          customerId: collectionCase.customerId,
          orderId: collectionCase.orderId
        }
      });
      await this.auditService.write(
        {
          action: AuditAction.UPDATE,
          after: toCollectionCaseView(updatedCase),
          before: toCollectionCaseView(collectionCase),
          entityId: collectionCase.id,
          entityType: "collection_case",
          module: "collection",
          operatorId: actorId ?? undefined
        },
        tx
      );
      await this.auditService.write(
        {
          action: AuditAction.CREATE,
          after: toCollectionActionView(action),
          entityId: action.id,
          entityType: "collection_action",
          module: "collection",
          operatorId: actorId ?? undefined
        },
        tx
      );
    }
  }

  async generateInitialBills(orderId: string, user: RequestUser, context: RequestContext) {
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrderFinance(order, user);
    ensureOrderCanGenerateInitialBills(order);

    const depositAmount = resolveRequiredDepositAmount(order);
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

        if (depositAmount > 0n && !existingTypes.has(BillType.DEPOSIT)) {
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

  async generateMonthlyRentBillForCycle(
    tx: Prisma.TransactionClient,
    input: MonthlyRentAutomationCycleInput
  ) {
    const order = await tx.subscriptionOrder.findUnique({
      include: financeOrderInclude,
      where: { id: input.orderId }
    });
    if (!order || order.deletedAt) {
      throw new NotFoundException(ORDER_NOT_FOUND_MESSAGE);
    }
    ensureOrderCanGenerateMonthlyRentBill(order);

    const monthlyRentAmount = resolveMonthlyRentAmount(order);
    if (monthlyRentAmount === null) {
      throw new BadRequestException(MISSING_MONTHLY_RENT_AMOUNT_MESSAGE);
    }

    return createMonthlyRentBillForPeriodIfAbsent(
      tx,
      order,
      monthlyRentAmount,
      {
        end: input.periodEnd,
        index: input.cycleNo,
        start: input.periodStart
      },
      input.actorId ?? undefined,
      "AUTOMATION",
      input.sourceKey
    );
  }

  async markBillOverdueForAutomation(
    tx: Prisma.TransactionClient,
    billId: string,
    asOfDate: Date,
    actorId: string | null = null
  ) {
    const locator = await tx.receivableBill.findFirst({
      select: { orderId: true },
      where: {
        deletedAt: null,
        id: billId
      }
    });
    if (!locator) {
      throw new NotFoundException(BILL_NOT_FOUND_MESSAGE);
    }
    await lockSubscriptionOrders(tx, [locator.orderId]);
    await lockReceivableBills(tx, [billId]);
    const [bill] = await tx.receivableBill.findMany({
      include: overdueBillInclude,
      where: {
        deletedAt: null,
        id: billId
      }
    });
    if (!bill) {
      throw new NotFoundException(BILL_NOT_FOUND_MESSAGE);
    }
    if (
      bill.billStatus === BillStatus.CANCELLED ||
      bill.billStatus === BillStatus.PAID ||
      bill.remainingAmount === 0n
    ) {
      return { action: "SKIPPED_SETTLED" as const, bill };
    }

    const overdueDays = calculateOverdueDays(bill.dueDate, asOfDate);
    if (overdueDays < 5) {
      return { action: "SKIPPED_NOT_DUE" as const, bill };
    }

    const alreadyOverdue = bill.billStatus === BillStatus.OVERDUE;
    const updatedBill = alreadyOverdue
      ? bill
      : await tx.receivableBill.update({
          data: {
            billStatus: BillStatus.OVERDUE,
            updatedBy: actorId ?? undefined
          },
          where: { id: bill.id }
        });
    const eligibleBills = await tx.receivableBill.findMany({
      include: overdueBillInclude,
      where: {
        billStatus: { in: [...OVERDUE_BILL_STATUSES] },
        deletedAt: null,
        dueDate: { lte: asOfDate },
        orderId: bill.orderId,
        remainingAmount: { gt: 0n }
      }
    });
    const totalOverdueAmount = eligibleBills.reduce(
      (sum, item) => sum + item.remainingAmount,
      0n
    );
    const maxOverdueDays = Math.max(
      overdueDays,
      ...eligibleBills.map((item) =>
        calculateOverdueDays(item.dueDate, asOfDate)
      )
    );
    const latestDueDate = eligibleBills.reduce(
      (latest, item) =>
        item.dueDate.getTime() > latest.getTime() ? item.dueDate : latest,
      bill.dueDate
    );
    const existingCase = await tx.collectionCase.findFirst({
      where: {
        caseStatus: CollectionCaseStatus.ACTIVE,
        deletedAt: null,
        orderId: bill.orderId
      }
    });
    const caseData = {
      collectionLevel: calculateCollectionLevel(maxOverdueDays),
      latestDueDate,
      maxOverdueDays,
      snapshot: toJsonValue(
        buildCollectionCaseSnapshot(
          bill.order,
          eligibleBills,
          asOfDate,
          totalOverdueAmount,
          maxOverdueDays
        )
      ),
      totalOverdueAmount,
      updatedBy: actorId ?? undefined
    };
    const collectionCase = existingCase
      ? await tx.collectionCase.update({
          data: caseData,
          where: { id: existingCase.id }
        })
      : await tx.collectionCase.create({
          data: {
            ...caseData,
            caseNo: createBusinessNo("COL"),
            caseStatus: CollectionCaseStatus.ACTIVE,
            createdBy: actorId ?? undefined,
            customerId: bill.customerId,
            orderId: bill.orderId
          }
        });
    const existingLink = await tx.collectionCaseBill.findFirst({
      where: {
        billId: bill.id,
        caseId: collectionCase.id,
        deletedAt: null
      }
    });
    const caseBill = existingLink
      ? await tx.collectionCaseBill.update({
          data: {
            overdueAmount: bill.remainingAmount,
            overdueDays
          },
          where: { id: existingLink.id }
        })
      : await tx.collectionCaseBill.create({
          data: {
            billId: bill.id,
            caseId: collectionCase.id,
            customerId: bill.customerId,
            orderId: bill.orderId,
            overdueAmount: bill.remainingAmount,
            overdueDays
          }
        });

    return {
      action: alreadyOverdue
        ? ("ALREADY_OVERDUE" as const)
        : ("MARKED_OVERDUE" as const),
      bill: updatedBill,
      caseBill,
      collectionCase
    };
  }

  async generateDamageFeeBill(orderId: string, user: RequestUser, context: RequestContext) {
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrderFinance(order, user);
    ensureOrderCanGenerateDamageFeeBill(order);

    const result = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const existingBill = await tx.receivableBill.findFirst({
          where: activeDamageFeeBillWhere(order.id)
        });

        if (existingBill) {
          return { bill: existingBill, created: false };
        }

        const vehicleReturn = await tx.vehicleReturn.findUnique({
          where: { orderId: order.id }
        });

        if (!vehicleReturn || vehicleReturn.deletedAt || !vehicleReturn.returnedAt) {
          throw new BadRequestException(DAMAGE_FEE_RETURN_NOT_COMPLETED_MESSAGE);
        }

        const damages = await findBillableReturnDamages(tx, order.id, vehicleReturn.id);
        const amount = sumDamageRepairAmount(damages);

        if (amount <= 0n) {
          throw new BadRequestException(DAMAGE_FEE_EMPTY_MESSAGE);
        }

        const bill = await tx.receivableBill.create({
          data: {
            amount,
            billNo: createBusinessNo("BIL"),
            billStatus: BillStatus.PENDING,
            billType: BillType.DAMAGE_FEE,
            createdBy: user.id,
            customerId: order.customerId,
            dueDate: vehicleReturn.returnedAt,
            orderId: order.id,
            paidAmount: 0n,
            remainingAmount: amount,
            snapshot: toJsonValue(buildDamageFeeBillSnapshot(order, vehicleReturn, damages, amount)),
            updatedBy: user.id
          }
        });

        return { bill, created: true };
      })
    );

    if (result.created) {
      await this.auditService.write({
        action: AuditAction.CREATE,
        after: buildBillAuditPayload(result.bill),
        entityId: result.bill.id,
        entityType: "receivable_bill",
        ipAddress: context.ipAddress,
        module: "billing",
        operatorId: user.id,
        userAgent: context.userAgent
      });
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

      const generationOpensAt = new Date(
        period.start.getTime() - 3 * MS_PER_DAY
      );
      if (generationOpensAt.getTime() > billingDate.getTime()) {
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
        await lockReceivableBills(tx, billIds);
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

        await cancelPendingBillAutomationJobs(
          tx,
          updatedBills
            .filter((bill) => bill.remainingAmount === 0n)
            .map((bill) => bill.id)
        );

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

  async refreshOverdueBills(dto: RefreshOverdueBillsDto, user: RequestUser, context: RequestContext) {
    const asOfDate = parseBillingDate(dto.asOfDate, "asOfDate");
    const dryRun = Boolean(dto.dryRun);
    const overdueBills = await this.findRefreshableOverdueBills(asOfDate, user);

    if (dryRun) {
      const casePlans = await this.buildCollectionCasePlans(
        overdueBills,
        asOfDate,
        this.prisma
      );
      return {
        asOfDate: toIsoDate(asOfDate),
        createdCaseCount: casePlans.filter((plan) => !plan.existingCase).length,
        dryRun,
        items: overdueBills.map((bill) => toOverdueRefreshItem(bill, asOfDate)),
        overdueBillCount: overdueBills.length,
        updatedCaseCount: casePlans.filter((plan) => plan.existingCase).length
      };
    }

    const refreshAuditEntityId = randomUUID();

    const result = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await lockSubscriptionOrders(
          tx,
          overdueBills.map((bill) => bill.orderId)
        );
        await lockReceivableBills(
          tx,
          overdueBills.map((bill) => bill.id)
        );
        const lockedBills = await tx.receivableBill.findMany({
          include: overdueBillInclude,
          where: {
            billStatus: { in: [...OVERDUE_BILL_STATUSES] },
            deletedAt: null,
            dueDate: { lt: asOfDate },
            id: { in: overdueBills.map((bill) => bill.id) },
            remainingAmount: { gt: 0n }
          }
        });
        const casePlans = await this.buildCollectionCasePlans(
          lockedBills,
          asOfDate,
          tx
        );
        const updatedBills: ReceivableBillRecord[] = [];
        const createdCases: CollectionCaseRecord[] = [];
        const updatedCases: CollectionCaseRecord[] = [];
        const linkedCaseBills: CollectionCaseBillRecord[] = [];

        for (const bill of lockedBills) {
          if (bill.billStatus === BillStatus.OVERDUE) {
            updatedBills.push(bill);
            continue;
          }

          updatedBills.push(
            await tx.receivableBill.update({
              data: { billStatus: BillStatus.OVERDUE, updatedBy: user.id },
              where: { id: bill.id }
            })
          );
        }

        for (const plan of casePlans) {
          const caseData = {
            collectionLevel: plan.collectionLevel,
            latestDueDate: plan.latestDueDate,
            maxOverdueDays: plan.maxOverdueDays,
            snapshot: toJsonValue(plan.snapshot),
            totalOverdueAmount: plan.totalOverdueAmount,
            updatedBy: user.id
          };
          const collectionCase = plan.existingCase
            ? await tx.collectionCase.update({
                data: caseData,
                where: { id: plan.existingCase.id }
              })
            : await tx.collectionCase.create({
                data: {
                  ...caseData,
                  caseNo: createBusinessNo("COL"),
                  caseStatus: CollectionCaseStatus.ACTIVE,
                  createdBy: user.id,
                  customerId: plan.customerId,
                  orderId: plan.orderId
                }
              });

          if (plan.existingCase) {
            updatedCases.push(collectionCase);
          } else {
            createdCases.push(collectionCase);
          }

          for (const bill of plan.bills) {
            const overdueDays = calculateOverdueDays(bill.dueDate, asOfDate);
            const existingLink = await tx.collectionCaseBill.findFirst({
              where: {
                billId: bill.id,
                caseId: collectionCase.id,
                deletedAt: null
              }
            });

            if (existingLink) {
              linkedCaseBills.push(
                await tx.collectionCaseBill.update({
                  data: {
                    overdueAmount: bill.remainingAmount,
                    overdueDays
                  },
                  where: { id: existingLink.id }
                })
              );
              continue;
            }

            linkedCaseBills.push(
              await tx.collectionCaseBill.create({
                data: {
                  billId: bill.id,
                  caseId: collectionCase.id,
                  customerId: bill.customerId,
                  orderId: bill.orderId,
                  overdueAmount: bill.remainingAmount,
                  overdueDays
                }
              })
            );
          }
        }

        await this.auditService.write(
          {
            action: AuditAction.UPDATE,
            after: {
              asOfDate: toIsoDate(asOfDate),
              billIds: updatedBills.map((bill) => bill.id),
              dryRun,
              overdueBillCount: overdueBills.length
            },
            entityId: refreshAuditEntityId,
            entityType: "overdue_refresh",
            ipAddress: context.ipAddress,
            module: "collection",
            operatorId: user.id,
            userAgent: context.userAgent
          },
          tx
        );

        for (const collectionCase of createdCases) {
          await this.auditService.write(
            {
              action: AuditAction.CREATE,
              after: toCollectionCaseView(collectionCase),
              entityId: collectionCase.id,
              entityType: "collection_case",
              ipAddress: context.ipAddress,
              module: "collection",
              operatorId: user.id,
              userAgent: context.userAgent
            },
            tx
          );
        }

        for (const collectionCase of updatedCases) {
          await this.auditService.write(
            {
              action: AuditAction.UPDATE,
              after: toCollectionCaseView(collectionCase),
              entityId: collectionCase.id,
              entityType: "collection_case",
              ipAddress: context.ipAddress,
              module: "collection",
              operatorId: user.id,
              userAgent: context.userAgent
            },
            tx
          );
        }

        return { createdCases, linkedCaseBills, updatedBills, updatedCases };
      })
    );

    return {
      asOfDate: toIsoDate(asOfDate),
      createdCaseCount: result.createdCases.length,
      dryRun,
      items: overdueBills.map((bill) => toOverdueRefreshItem(bill, asOfDate)),
      overdueBillCount: overdueBills.length,
      updatedCaseCount: result.updatedCases.length
    };
  }

  async listOverdueBills(query: OverdueBillsQueryDto, user: RequestUser) {
    const where: Prisma.ReceivableBillWhereInput = {
      billStatus: BillStatus.OVERDUE,
      deletedAt: null,
      remainingAmount: { gt: 0 }
    };

    if (query.billType) {
      where.billType = query.billType;
    }

    if (query.orderNo || !canViewAllFinanceOrders(user)) {
      where.order = {
        ...(query.orderNo ? { orderNo: { contains: query.orderNo } } : {}),
        ...(!canViewAllFinanceOrders(user) ? { application: { salesUserId: user.id } } : {})
      };
    }

    if (query.customerName) {
      where.customer = { name: { contains: query.customerName } };
    }

    const asOfDate = toBillingDateOnly(new Date());
    const bills = await this.prisma.receivableBill.findMany({
      include: overdueBillInclude,
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      where
    });

    return bills
      .map((bill) => toOverdueBillView(bill, asOfDate))
      .filter((bill) => query.collectionLevel === undefined || bill.collectionLevel === query.collectionLevel)
      .filter((bill) => query.minOverdueDays === undefined || bill.overdueDays >= query.minOverdueDays)
      .filter((bill) => query.maxOverdueDays === undefined || bill.overdueDays <= query.maxOverdueDays);
  }

  async listCollectionCases(query: CollectionCasesQueryDto, user: RequestUser) {
    const where: Prisma.CollectionCaseWhereInput = { deletedAt: null };

    if (query.caseStatus) {
      where.caseStatus = query.caseStatus;
    }
    if (query.collectionLevel) {
      where.collectionLevel = query.collectionLevel;
    }
    if (query.assignedTo) {
      where.assignedTo = query.assignedTo;
    }
    if (query.customerName) {
      where.customer = { name: { contains: query.customerName } };
    }
    if (query.orderNo || !canViewAllFinanceOrders(user)) {
      where.order = {
        ...(query.orderNo ? { orderNo: { contains: query.orderNo } } : {}),
        ...(!canViewAllFinanceOrders(user) ? { application: { salesUserId: user.id } } : {})
      };
    }

    const cases = await this.prisma.collectionCase.findMany({
      include: collectionCaseListInclude,
      orderBy: [{ caseStatus: "asc" }, { maxOverdueDays: "desc" }, { createdAt: "desc" }],
      where
    });

    return cases.map(toCollectionCaseListView);
  }

  async getCollectionCase(id: string, user: RequestUser) {
    const collectionCase = await this.findCollectionCaseOrThrow(id);
    ensureCanAccessOrderFinance(collectionCase.order, user);
    return toCollectionCaseDetailView(collectionCase);
  }

  async createCollectionAction(
    id: string,
    dto: CreateCollectionActionDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const collectionCase = await this.findCollectionCaseOrThrow(id);
    ensureCanAccessOrderFinance(collectionCase.order, user);

    if (collectionCase.caseStatus === CollectionCaseStatus.CLOSED) {
      throw new BadRequestException(COLLECTION_CASE_ACTION_CLOSED_MESSAGE);
    }

    if (dto.promisedAmount !== undefined) {
      assertPositiveInteger(dto.promisedAmount, "promisedAmount");
    }

    const promisedPayAt = dto.promisedPayAt ? parseBillingDate(dto.promisedPayAt, "promisedPayAt") : null;
    const nextFollowUpAt = dto.nextFollowUpAt ? parseDateTime(dto.nextFollowUpAt, "nextFollowUpAt") : null;

    const result = await this.prisma.$transaction(async (tx) => {
      const action = await tx.collectionAction.create({
        data: {
          actionResult: dto.actionResult,
          actionType: dto.actionType,
          caseId: collectionCase.id,
          contactMethod: dto.contactMethod,
          content: dto.content,
          createdBy: user.id,
          customerId: collectionCase.customerId,
          nextFollowUpAt,
          orderId: collectionCase.orderId,
          promisedAmount: dto.promisedAmount === undefined ? null : BigInt(dto.promisedAmount),
          promisedPayAt
        }
      });
      const updatedCase = nextFollowUpAt
        ? await tx.collectionCase.update({
            data: { nextFollowUpAt, updatedBy: user.id },
            where: { id: collectionCase.id }
          })
        : collectionCase;

      return { action, updatedCase };
    });

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toCollectionActionView(result.action),
      entityId: result.action.id,
      entityType: "collection_action",
      ipAddress: context.ipAddress,
      module: "collection",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    if (nextFollowUpAt) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: toCollectionCaseView(result.updatedCase),
        entityId: collectionCase.id,
        entityType: "collection_case",
        ipAddress: context.ipAddress,
        module: "collection",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }

    return toCollectionActionView(result.action);
  }

  async closeCollectionCase(
    id: string,
    dto: CloseCollectionCaseDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const collectionCase = await this.findCollectionCaseOrThrow(id);
    ensureCanAccessOrderFinance(collectionCase.order, user);

    if (!collectionCase.bills.every((caseBill) => isBillSettled(caseBill.bill))) {
      throw new BadRequestException(COLLECTION_CASE_CLOSE_UNSETTLED_MESSAGE);
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const updatedCase = await tx.collectionCase.update({
        data: {
          caseStatus: CollectionCaseStatus.CLOSED,
          closedAt: now,
          closeReason: dto.closeReason,
          updatedBy: user.id
        },
        where: { id: collectionCase.id }
      });
      const action = await tx.collectionAction.create({
        data: {
          actionResult: CollectionActionResult.SUCCESS,
          actionType: CollectionActionType.CLOSE,
          caseId: collectionCase.id,
          contactMethod: ContactMethod.SYSTEM,
          content: dto.closeReason,
          createdBy: user.id,
          customerId: collectionCase.customerId,
          orderId: collectionCase.orderId
        }
      });

      return { action, updatedCase };
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toCollectionCaseView(result.updatedCase),
      entityId: collectionCase.id,
      entityType: "collection_case",
      ipAddress: context.ipAddress,
      module: "collection",
      operatorId: user.id,
      userAgent: context.userAgent
    });
    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toCollectionActionView(result.action),
      entityId: result.action.id,
      entityType: "collection_action",
      ipAddress: context.ipAddress,
      module: "collection",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return {
      action: toCollectionActionView(result.action),
      case: toCollectionCaseView(result.updatedCase)
    };
  }

  async getOrderFinanceSummary(orderId: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrderFinance(order, user);

    const bills = await this.prisma.receivableBill.findMany({
      orderBy: { createdAt: "asc" },
      where: { billStatus: { not: BillStatus.CANCELLED }, deletedAt: null, orderId }
    });
    const requiredDepositAmount = resolveRequiredDepositAmount(order) ?? 0n;
    const deposit = summarizeDepositBills(bills, requiredDepositAmount);
    const firstMonthlyFee = summarizeBills(bills, BillType.FIRST_MONTHLY_FEE);
    const totalReceivableAmount = bills.reduce((sum, bill) => sum + bill.amount, 0n);
    const totalPaidAmount = bills.reduce((sum, bill) => sum + bill.paidAmount, 0n);
    const payments = await this.prisma.paymentRecord.findMany({
      include: paymentWriteOffInclude,
      orderBy: { createdAt: "asc" },
      where: { deletedAt: null, orderId, paymentStatus: PaymentStatus.CONFIRMED }
    });
    const registeredReceiptAmount = payments.reduce((sum, payment) => sum + payment.paymentAmount, 0n);
    const allocatedPaidAmount = payments.reduce((sum, payment) => sum + sumWriteOffAmount(payment.writeOffs), 0n);
    const unallocatedReceiptAmount =
      registeredReceiptAmount > allocatedPaidAmount ? registeredReceiptAmount - allocatedPaidAmount : 0n;
    const deliveryPaymentSatisfied = deposit.status === BillStatus.PAID && firstMonthlyFee.status === BillStatus.PAID;

    return {
      allocatedPaidAmount: Number(allocatedPaidAmount),
      depositPaidAmount: Number(deposit.paidAmount),
      depositReceivableAmount: Number(deposit.receivableAmount),
      depositStatus: deposit.status,
      deliveryPaymentStatus: deliveryPaymentSatisfied
        ? "WRITTEN_OFF"
        : unallocatedReceiptAmount > 0n
          ? "REGISTERED_UNALLOCATED"
          : registeredReceiptAmount > 0n
            ? "REGISTERED_ALLOCATED"
            : "UNPAID",
      firstMonthlyFeePaidAmount: Number(firstMonthlyFee.paidAmount),
      firstMonthlyFeeReceivableAmount: Number(firstMonthlyFee.receivableAmount),
      firstMonthlyFeeStatus: firstMonthlyFee.status,
      registeredReceiptAmount: Number(registeredReceiptAmount),
      totalPaidAmount: Number(totalPaidAmount),
      totalReceivableAmount: Number(totalReceivableAmount),
      unallocatedReceiptAmount: Number(unallocatedReceiptAmount),
      deliveryPaymentSatisfied
    };
  }

  async getDepositSettlement(orderId: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrderFinance(order, user);

    const [ledgers, damageFeeBills, damages] = await Promise.all([
      this.prisma.depositLedger.findMany({
        orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
        where: { customerId: order.customerId, deletedAt: null, orderId: order.id }
      }),
      this.prisma.receivableBill.findMany({
        orderBy: [{ createdAt: "asc" }],
        where: activeDamageFeeBillWhere(order.id)
      }),
      this.prisma.vehicleReturnDamage.findMany({
        orderBy: [{ createdAt: "asc" }],
        where: { deletedAt: null, orderId: order.id }
      })
    ]);

    const balance = calculateDepositBalanceDetailsFromLedgers(ledgers);
    const damageFeeBillIds = new Set(damageFeeBills.map((bill) => bill.id));
    const damageFeeAmount = damageFeeBills.reduce((sum, bill) => sum + bill.amount, 0n);
    const damageFeePaidAmount = damageFeeBills.reduce((sum, bill) => sum + bill.paidAmount, 0n);
    const damageFeeRemainingAmount = damageFeeBills.reduce((sum, bill) => sum + bill.remainingAmount, 0n);
    const damageFeeDeductedAmount = ledgers
      .filter(
        (ledger) =>
          ledger.transactionStatus === DepositTransactionStatus.CONFIRMED &&
          ledger.deletedAt === null &&
          ledger.transactionType === DepositTransactionType.DEDUCT &&
          ledger.billId !== null &&
          damageFeeBillIds.has(ledger.billId)
      )
      .reduce((sum, ledger) => sum + ledger.amount, 0n);
    const deductibleAmount =
      balance.availableBalance < damageFeeRemainingAmount ? balance.availableBalance : damageFeeRemainingAmount;
    const refundableAmount = balance.availableBalance - deductibleAmount;

    return {
      availableBalance: Number(balance.availableBalance),
      availableDepositBalance: Number(balance.availableBalance),
      collectedAmount: Number(balance.collectedAmount),
      customer: {
        id: order.customer.id,
        mobile: order.customer.mobile,
        name: order.customer.name
      },
      damageFeeAmount: Number(damageFeeAmount),
      damageFeeBills: damageFeeBills.map(toBillView),
      damageFeeDeductedAmount: Number(damageFeeDeductedAmount),
      damageFeePaidAmount: Number(damageFeePaidAmount),
      damageFeeRemainingAmount: Number(damageFeeRemainingAmount),
      damages: damages.map(toReturnDamageView),
      deductibleAmount: Number(deductibleAmount),
      deductedAmount: Number(balance.deductedAmount),
      depositLedgers: ledgers.map(toDepositLedgerView),
      latestLedger: balance.latestLedger ? toDepositLedgerView(balance.latestLedger) : null,
      orderId: order.id,
      orderNo: order.orderNo,
      refundableAmount: Number(refundableAmount),
      refundedAmount: Number(balance.refundedAmount),
      releasedAmount: Number(balance.releasedAmount)
    };
  }

  async deductDeposit(orderId: string, dto: DeductDepositDto, user: RequestUser, context: RequestContext) {
    assertPositiveInteger(dto.amount, "amount");
    if (!dto.billId) {
      throw new BadRequestException(DAMAGE_FEE_BILL_REQUIRED_MESSAGE);
    }

    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrderFinance(order, user);
    const amount = BigInt(dto.amount);

    const result = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await lockReceivableBills(tx, [dto.billId!]);
        const bill = await tx.receivableBill.findFirst({
          where: {
            deletedAt: null,
            id: dto.billId
          }
        });

        if (
          !bill ||
          bill.orderId !== order.id ||
          bill.customerId !== order.customerId ||
          bill.billType !== BillType.DAMAGE_FEE ||
          bill.billStatus === BillStatus.CANCELLED ||
          bill.remainingAmount <= 0n
        ) {
          throw new BadRequestException(DAMAGE_FEE_BILL_INVALID_MESSAGE);
        }

        const balance = await calculateDepositBalanceDetails(tx, order.customerId, order.id);

        if (balance.collectedAmount <= 0n || balance.availableBalance <= 0n) {
          throw new BadRequestException(DEPOSIT_NOT_COLLECTED_MESSAGE);
        }

        if (amount > balance.availableBalance) {
          throw new BadRequestException(DEPOSIT_BALANCE_INSUFFICIENT_MESSAGE);
        }

        if (amount > bill.remainingAmount) {
          throw new BadRequestException(DEPOSIT_DEDUCT_OVER_BILL_MESSAGE);
        }

        const balanceAfter = balance.availableBalance - amount;
        if (balanceAfter < 0n) {
          throw new BadRequestException(DEPOSIT_BALANCE_INSUFFICIENT_MESSAGE);
        }

        const now = new Date();
        const ledger = await tx.depositLedger.create({
          data: {
            amount,
            balanceAfter,
            billId: bill.id,
            createdBy: user.id,
            customerId: order.customerId,
            ledgerNo: createBusinessNo("DPL"),
            occurredAt: now,
            orderId: order.id,
            remark: dto.remark,
            snapshot: toJsonValue({
              amount: Number(amount),
              bill: toBillView(bill),
              orderNo: order.orderNo,
              transactionType: DepositTransactionType.DEDUCT
            }),
            transactionStatus: DepositTransactionStatus.CONFIRMED,
            transactionType: DepositTransactionType.DEDUCT
          }
        });
        const nextRemainingAmount = bill.remainingAmount - amount;
        const nextPaidAmount = bill.paidAmount + amount;
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

        return { bill: updatedBill, ledger };
      })
    );

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: buildDepositLedgerAuditPayload(result.ledger),
      entityId: result.ledger.id,
      entityType: "deposit_ledger",
      ipAddress: context.ipAddress,
      module: "deposit_ledger",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return {
      bill: toBillView(result.bill),
      depositBalance: Number(result.ledger.balanceAfter),
      ledger: toDepositLedgerView(result.ledger)
    };
  }

  async refundDeposit(orderId: string, dto: RefundDepositDto, user: RequestUser, context: RequestContext) {
    assertPositiveInteger(dto.amount, "amount");
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrderFinance(order, user);
    ensureOrderCanRefundDeposit(order);
    const amount = BigInt(dto.amount);

    const ledger = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const balance = await calculateDepositBalanceDetails(tx, order.customerId, order.id);

        if (amount > balance.availableBalance) {
          throw new BadRequestException(DEPOSIT_REFUND_OVER_BALANCE_MESSAGE);
        }

        const balanceAfter = balance.availableBalance - amount;
        if (balanceAfter < 0n) {
          throw new BadRequestException(DEPOSIT_REFUND_OVER_BALANCE_MESSAGE);
        }

        return tx.depositLedger.create({
          data: {
            amount,
            balanceAfter,
            createdBy: user.id,
            customerId: order.customerId,
            ledgerNo: createBusinessNo("DPL"),
            occurredAt: new Date(),
            orderId: order.id,
            remark: dto.remark,
            snapshot: toJsonValue({
              amount: Number(amount),
              orderNo: order.orderNo,
              transactionType: DepositTransactionType.REFUND
            }),
            transactionStatus: DepositTransactionStatus.CONFIRMED,
            transactionType: DepositTransactionType.REFUND
          }
        });
      })
    );

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: buildDepositLedgerAuditPayload(ledger),
      entityId: ledger.id,
      entityType: "deposit_ledger",
      ipAddress: context.ipAddress,
      module: "deposit_ledger",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return {
      depositBalance: Number(ledger.balanceAfter),
      ledger: toDepositLedgerView(ledger)
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

  private async findRefreshableOverdueBills(asOfDate: Date, user: RequestUser) {
    const where: Prisma.ReceivableBillWhereInput = {
      billStatus: { in: [...OVERDUE_BILL_STATUSES] },
      deletedAt: null,
      dueDate: { lt: asOfDate },
      remainingAmount: { gt: 0 }
    };

    if (!canViewAllFinanceOrders(user)) {
      where.order = { application: { salesUserId: user.id } };
    }

    const bills = await this.prisma.receivableBill.findMany({
      include: overdueBillInclude,
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      where
    });

    return bills.filter((bill) => calculateOverdueDays(bill.dueDate, asOfDate) > 0);
  }

  private async buildCollectionCasePlans(
    overdueBills: OverdueBillWithRelations[],
    asOfDate: Date,
    db: Pick<Prisma.TransactionClient, "collectionCase">
  ) {
    const billsByOrder = new Map<string, OverdueBillWithRelations[]>();

    for (const bill of overdueBills) {
      const groupedBills = billsByOrder.get(bill.orderId) ?? [];
      groupedBills.push(bill);
      billsByOrder.set(bill.orderId, groupedBills);
    }

    const plans: CollectionCasePlan[] = [];

    for (const [orderId, bills] of billsByOrder) {
      const existingCase = await db.collectionCase.findFirst({
        where: {
          caseStatus: CollectionCaseStatus.ACTIVE,
          deletedAt: null,
          orderId
        }
      });
      const overdueDays = bills.map((bill) => calculateOverdueDays(bill.dueDate, asOfDate));
      const maxOverdueDays = Math.max(...overdueDays);
      const totalOverdueAmount = bills.reduce((sum, bill) => sum + bill.remainingAmount, 0n);
      const latestDueDate = bills.reduce<Date | null>(
        (latest, bill) => (latest === null || bill.dueDate.getTime() > latest.getTime() ? bill.dueDate : latest),
        null
      );
      const firstBill = bills[0]!;

      plans.push({
        bills,
        collectionLevel: calculateCollectionLevel(maxOverdueDays),
        customerId: firstBill.customerId,
        existingCase,
        latestDueDate: latestDueDate ?? firstBill.dueDate,
        maxOverdueDays,
        orderId,
        snapshot: buildCollectionCaseSnapshot(firstBill.order, bills, asOfDate, totalOverdueAmount, maxOverdueDays),
        totalOverdueAmount
      });
    }

    return plans;
  }

  private async findCollectionCaseOrThrow(id: string) {
    const collectionCase = await this.prisma.collectionCase.findUnique({
      include: collectionCaseDetailInclude,
      where: { id }
    });

    if (!collectionCase || collectionCase.deletedAt) {
      throw new NotFoundException(COLLECTION_CASE_NOT_FOUND_MESSAGE);
    }

    return collectionCase;
  }
}

function calculateOverdueDays(dueDate: Date, asOfDate: Date) {
  const dueDateOnly = toBillingDateOnly(dueDate);
  const asOfDateOnly = toBillingDateOnly(asOfDate);
  return Math.max(0, Math.floor((asOfDateOnly.getTime() - dueDateOnly.getTime()) / MS_PER_DAY));
}

function calculateCollectionLevel(overdueDays: number) {
  if (overdueDays <= 3) {
    return CollectionLevel.D1;
  }
  if (overdueDays <= 7) {
    return CollectionLevel.D2;
  }
  if (overdueDays <= 15) {
    return CollectionLevel.D3;
  }
  if (overdueDays <= 30) {
    return CollectionLevel.D4;
  }
  return CollectionLevel.D5;
}

function toOverdueRefreshItem(bill: OverdueBillWithRelations, asOfDate: Date) {
  const overdueDays = calculateOverdueDays(bill.dueDate, asOfDate);

  return {
    amount: Number(bill.amount),
    billId: bill.id,
    billNo: bill.billNo,
    billStatus: bill.billStatus,
    billType: bill.billType,
    collectionLevel: calculateCollectionLevel(overdueDays),
    customerId: bill.customerId,
    customerName: bill.customer.name,
    dueDate: toIsoDate(bill.dueDate),
    orderId: bill.orderId,
    orderNo: bill.order.orderNo,
    overdueDays,
    paidAmount: Number(bill.paidAmount),
    remainingAmount: Number(bill.remainingAmount)
  };
}

function toOverdueBillView(bill: OverdueBillWithRelations, asOfDate: Date) {
  const overdueDays = calculateOverdueDays(bill.dueDate, asOfDate);
  const activeCaseBill = bill.collectionCaseBills.find((caseBill) => !caseBill.case.deletedAt);

  return {
    amount: Number(bill.amount),
    billId: bill.id,
    billNo: bill.billNo,
    billStatus: bill.billStatus,
    billType: bill.billType,
    collectionCaseId: activeCaseBill?.caseId ?? null,
    collectionCaseStatus: activeCaseBill?.case.caseStatus ?? null,
    collectionLevel: calculateCollectionLevel(overdueDays),
    customer: {
      id: bill.customer.id,
      mobile: bill.customer.mobile,
      name: bill.customer.name
    },
    dueDate: toIsoDate(bill.dueDate),
    order: {
      id: bill.order.id,
      orderNo: bill.order.orderNo
    },
    overdueDays,
    paidAmount: Number(bill.paidAmount),
    remainingAmount: Number(bill.remainingAmount)
  };
}

function toCollectionCaseView(collectionCase: CollectionCaseRecord) {
  return {
    assignedTo: collectionCase.assignedTo,
    caseNo: collectionCase.caseNo,
    caseStatus: collectionCase.caseStatus,
    closeReason: collectionCase.closeReason,
    closedAt: toIsoDateTime(collectionCase.closedAt),
    collectionLevel: collectionCase.collectionLevel,
    createdAt: toIsoDateTime(collectionCase.createdAt),
    customerId: collectionCase.customerId,
    id: collectionCase.id,
    latestDueDate: toIsoDate(collectionCase.latestDueDate),
    maxOverdueDays: collectionCase.maxOverdueDays,
    nextFollowUpAt: toIsoDateTime(collectionCase.nextFollowUpAt),
    orderId: collectionCase.orderId,
    remark: collectionCase.remark,
    snapshot: collectionCase.snapshot,
    totalOverdueAmount: Number(collectionCase.totalOverdueAmount),
    updatedAt: toIsoDateTime(collectionCase.updatedAt)
  };
}

function toCollectionCaseListView(collectionCase: CollectionCaseListRecord) {
  return {
    ...toCollectionCaseView(collectionCase),
    customer: {
      id: collectionCase.customer.id,
      mobile: collectionCase.customer.mobile,
      name: collectionCase.customer.name
    },
    order: {
      id: collectionCase.order.id,
      orderNo: collectionCase.order.orderNo
    }
  };
}

function toCollectionCaseDetailView(collectionCase: CollectionCaseDetailRecord) {
  return {
    ...toCollectionCaseView(collectionCase),
    actions: collectionCase.actions.map(toCollectionActionView),
    bills: collectionCase.bills.map(toCollectionCaseBillView),
    customer: {
      id: collectionCase.customer.id,
      mobile: collectionCase.customer.mobile,
      name: collectionCase.customer.name
    },
    order: {
      id: collectionCase.order.id,
      orderNo: collectionCase.order.orderNo
    }
  };
}

function toCollectionCaseBillView(caseBill: CollectionCaseBillRecord & { bill: ReceivableBillRecord }) {
  return {
    bill: toBillView(caseBill.bill),
    billId: caseBill.billId,
    caseId: caseBill.caseId,
    createdAt: toIsoDateTime(caseBill.createdAt),
    customerId: caseBill.customerId,
    id: caseBill.id,
    orderId: caseBill.orderId,
    overdueAmount: Number(caseBill.overdueAmount),
    overdueDays: caseBill.overdueDays
  };
}

function toCollectionActionView(action: CollectionActionRecord) {
  return {
    actionResult: action.actionResult,
    actionType: action.actionType,
    caseId: action.caseId,
    contactMethod: action.contactMethod,
    content: action.content,
    createdAt: toIsoDateTime(action.createdAt),
    customerId: action.customerId,
    id: action.id,
    nextFollowUpAt: toIsoDateTime(action.nextFollowUpAt),
    orderId: action.orderId,
    promisedAmount: action.promisedAmount === null ? null : Number(action.promisedAmount),
    promisedPayAt: toIsoDate(action.promisedPayAt)
  };
}

function buildCollectionCaseSnapshot(
  order: FinanceOrder,
  bills: OverdueBillWithRelations[],
  asOfDate: Date,
  totalOverdueAmount: bigint,
  maxOverdueDays: number
) {
  return {
    asOfDate: toIsoDate(asOfDate),
    bills: bills.map((bill) => ({
      billId: bill.id,
      billNo: bill.billNo,
      billType: bill.billType,
      dueDate: toIsoDate(bill.dueDate),
      overdueDays: calculateOverdueDays(bill.dueDate, asOfDate),
      remainingAmount: Number(bill.remainingAmount)
    })),
    collectionLevel: calculateCollectionLevel(maxOverdueDays),
    customer: {
      id: order.customerId,
      mobile: order.customer.mobile,
      name: order.customer.name
    },
    maxOverdueDays,
    orderId: order.id,
    orderNo: order.orderNo,
    totalOverdueAmount: Number(totalOverdueAmount)
  };
}

function isBillSettled(bill: ReceivableBillRecord) {
  return bill.remainingAmount === 0n || bill.billStatus === BillStatus.PAID;
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
  userId: string | undefined,
  source: MonthlyRentBillSource,
  sourceKey = billingSourceKey(order.id, period.start)
) {
  const existingBill = await tx.receivableBill.findFirst({
    where: monthlyRentPeriodWhere(order.id, period)
  });

  if (existingBill) {
    const reconciledBill =
      existingBill.sourceKey === null
        ? await tx.receivableBill.update({
            data: { sourceKey },
            where: { id: existingBill.id }
          })
        : existingBill;
    return { bill: reconciledBill, created: false, period };
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
      sourceKey,
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
  const index = existingMonthlyRentBillCount + 1;
  const cycle = buildBillingCycleForDelivery(actualDeliveryAt, index);
  return { end: cycle.periodEnd, index, start: cycle.periodStart };
}

function toBillingDateOnly(value: Date) {
  const shifted = new Date(value.getTime() + CHINA_TIME_OFFSET_MINUTES * 60 * 1000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
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
    modelCode: order.modelCodeSnapshot,
    modelDefinitionId: order.modelDefinitionIdSnapshot,
    modelDisplayName: order.modelDisplayNameSnapshot
  };
}

function buildDamageFeeBillSnapshot(
  order: FinanceOrder,
  vehicleReturn: VehicleReturnRecord,
  damages: VehicleReturnDamageRecord[],
  amount: bigint
) {
  return {
    amount: Number(amount),
    billType: BillType.DAMAGE_FEE,
    customer: {
      id: order.customerId,
      mobile: order.customer.mobile,
      name: order.customer.name
    },
    damages: damages.map((damage) => ({
      damageLevel: damage.damageLevel,
      damageType: damage.damageType,
      description: damage.description,
      estimatedRepairAmount: damage.estimatedRepairAmount === null ? null : Number(damage.estimatedRepairAmount),
      id: damage.id,
      responsibleParty: damage.responsibleParty,
      status: damage.status
    })),
    orderId: order.id,
    orderNo: order.orderNo,
    returnId: vehicleReturn.id,
    returnNo: vehicleReturn.returnNo,
    returnedAt: toIsoDateTime(vehicleReturn.returnedAt),
    vehicleId: order.vehicleId
  };
}

function buildBillAuditPayload(bill: ReceivableBillRecord) {
  return {
    ...toBillView(bill),
    amount: Number(bill.amount),
    billId: bill.id,
    customerId: bill.customerId,
    orderId: bill.orderId,
    remark: bill.remark
  };
}

function buildDepositLedgerAuditPayload(ledger: DepositLedgerRecord) {
  return {
    ...toDepositLedgerView(ledger),
    amount: Number(ledger.amount),
    billId: ledger.billId,
    customerId: ledger.customerId,
    orderId: ledger.orderId,
    remark: ledger.remark,
    transactionType: ledger.transactionType
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

function activeDamageFeeBillWhere(orderId: string) {
  return {
    billStatus: { not: BillStatus.CANCELLED },
    billType: BillType.DAMAGE_FEE,
    deletedAt: null,
    orderId
  } satisfies Prisma.ReceivableBillWhereInput;
}

function findBillableReturnDamages(tx: Prisma.TransactionClient, orderId: string, returnId: string) {
  return tx.vehicleReturnDamage.findMany({
    orderBy: [{ createdAt: "asc" }],
    where: {
      deletedAt: null,
      estimatedRepairAmount: { gt: 0 },
      orderId,
      responsibleParty: VehicleDamageResponsibleParty.CUSTOMER,
      returnId,
      status: { in: [VehicleReturnDamageStatus.RECORDED, VehicleReturnDamageStatus.CONFIRMED] }
    }
  });
}

function sumDamageRepairAmount(damages: VehicleReturnDamageRecord[]) {
  return damages.reduce((sum, damage) => sum + (damage.estimatedRepairAmount ?? 0n), 0n);
}

function ensureOrderCanGenerateDamageFeeBill(order: FinanceOrder) {
  if (!order.actualReturnAt) {
    throw new BadRequestException(DAMAGE_FEE_RETURN_NOT_COMPLETED_MESSAGE);
  }
}

function ensureOrderCanRefundDeposit(order: FinanceOrder) {
  if (!order.actualReturnAt && order.orderStatus !== OrderStatus.COMPLETED && order.orderStatus !== OrderStatus.TERMINATED) {
    throw new BadRequestException(DEPOSIT_REFUND_NOT_ALLOWED_MESSAGE);
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

function resolveRequiredDepositAmount(order: FinanceOrder) {
  return pickNonNegativeAmount(
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

export function resolveMonthlyRentAmountWithSource(order: {
  monthlyFeeAmount: unknown;
  quote?: { monthlyFeeAmount: unknown } | null;
  quoteSnapshot: unknown;
}) {
  const candidates = [
    {
      amountSource: "ORDER_MONTHLY_FEE",
      value: order.monthlyFeeAmount
    },
    {
      amountSource: "QUOTE_SNAPSHOT_PRICING",
      value: readSnapshotAmount(order.quoteSnapshot, [
        "pricing",
        "monthlyFeeAmount"
      ])
    },
    {
      amountSource: "QUOTE_SNAPSHOT",
      value: readSnapshotAmount(order.quoteSnapshot, ["monthlyFeeAmount"])
    },
    {
      amountSource: "QUOTE_MONTHLY_FEE",
      value: order.quote?.monthlyFeeAmount
    }
  ];
  for (const candidate of candidates) {
    const amount = toPositiveBigInt(candidate.value);
    if (amount !== null) {
      return {
        amount,
        amountSource: candidate.amountSource
      };
    }
  }
  return {
    amount: null,
    amountSource: "MISSING"
  };
}

function resolveMonthlyRentAmount(order: FinanceOrder) {
  return resolveMonthlyRentAmountWithSource(order).amount;
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

function pickNonNegativeAmount(...values: unknown[]) {
  for (const value of values) {
    const amount = toNonNegativeBigInt(value);
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

function toNonNegativeBigInt(value: unknown) {
  if (typeof value === "bigint") {
    return value >= 0n ? value : null;
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
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
  const details = await calculateDepositBalanceDetails(tx, customerId, orderId);
  return details.availableBalance;
}

async function calculateDepositBalanceDetails(
  tx: Prisma.TransactionClient,
  customerId: string,
  orderId: string
): Promise<DepositBalanceDetails> {
  const ledgers = await tx.depositLedger.findMany({
    orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
    where: {
      customerId,
      deletedAt: null,
      orderId,
      transactionStatus: DepositTransactionStatus.CONFIRMED
    }
  });

  return calculateDepositBalanceDetailsFromLedgers(ledgers);
}

function calculateDepositBalanceDetailsFromLedgers(ledgers: DepositLedgerRecord[]): DepositBalanceDetails {
  const confirmedLedgers = ledgers.filter(
    (ledger) => ledger.deletedAt === null && ledger.transactionStatus === DepositTransactionStatus.CONFIRMED
  );

  return confirmedLedgers.reduce<DepositBalanceDetails>(
    (details, ledger) => {
      if (ledger.transactionType === DepositTransactionType.COLLECT) {
        details.collectedAmount += ledger.amount;
      }
      if (ledger.transactionType === DepositTransactionType.DEDUCT) {
        details.deductedAmount += ledger.amount;
      }
      if (ledger.transactionType === DepositTransactionType.REFUND) {
        details.refundedAmount += ledger.amount;
      }
      if (ledger.transactionType === DepositTransactionType.RELEASE) {
        details.releasedAmount += ledger.amount;
      }

      details.availableBalance += signedDepositLedgerAmount(ledger);
      details.latestLedger = ledger;
      return details;
    },
    {
      availableBalance: 0n,
      collectedAmount: 0n,
      deductedAmount: 0n,
      latestLedger: null,
      refundedAmount: 0n,
      releasedAmount: 0n
    }
  );
}

function signedDepositLedgerAmount(ledger: Pick<DepositLedgerRecord, "amount" | "transactionType">) {
  if (
    ledger.transactionType === DepositTransactionType.DEDUCT ||
    ledger.transactionType === DepositTransactionType.REFUND ||
    ledger.transactionType === DepositTransactionType.RELEASE
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

function summarizeDepositBills(bills: ReceivableBillRecord[], requiredDepositAmount: bigint) {
  const deposit = summarizeBills(bills, BillType.DEPOSIT);
  if (deposit.status === null && requiredDepositAmount === 0n) {
    return {
      paidAmount: 0n,
      receivableAmount: 0n,
      remainingAmount: 0n,
      status: BillStatus.PAID
    };
  }
  return deposit;
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
    sourceKey: bill.sourceKey,
    snapshot: bill.snapshot,
    updatedAt: toIsoDateTime(bill.updatedAt)
  };
}

function toReturnDamageView(damage: VehicleReturnDamageRecord) {
  return {
    billable: isBillableReturnDamage(damage),
    createdAt: toIsoDateTime(damage.createdAt),
    damageLevel: damage.damageLevel,
    damageType: damage.damageType,
    description: damage.description,
    estimatedRepairAmount: damage.estimatedRepairAmount === null ? null : Number(damage.estimatedRepairAmount),
    id: damage.id,
    orderId: damage.orderId,
    photoUrls: damage.photoUrls ?? [],
    responsibleParty: damage.responsibleParty,
    returnId: damage.returnId,
    status: damage.status,
    updatedAt: toIsoDateTime(damage.updatedAt),
    vehicleId: damage.vehicleId
  };
}

function isBillableReturnDamage(damage: VehicleReturnDamageRecord) {
  return (
    damage.deletedAt === null &&
    damage.responsibleParty === VehicleDamageResponsibleParty.CUSTOMER &&
    (damage.status === VehicleReturnDamageStatus.RECORDED || damage.status === VehicleReturnDamageStatus.CONFIRMED) &&
    damage.estimatedRepairAmount !== null &&
    damage.estimatedRepairAmount > 0n
  );
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

async function lockReceivableBills(
  tx: Prisma.TransactionClient,
  billIds: string[]
) {
  const ids = [...new Set(billIds)].sort();
  if (ids.length === 0) {
    return;
  }
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "receivable_bill"
    WHERE "id" = ANY(ARRAY[${Prisma.join(ids)}]::uuid[])
    ORDER BY "id"
    FOR UPDATE
  `);
}

async function lockPaymentOrder(
  tx: Prisma.TransactionClient,
  paymentOrderId: string
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "payment_order"
    WHERE "id" = ${paymentOrderId}::uuid
    FOR UPDATE
  `);
}

function paymentMethodForChannel(channel: PaymentChannel) {
  if (channel === PaymentChannel.ALIPAY_H5) {
    return PaymentMethod.ALIPAY;
  }
  if (channel === PaymentChannel.BANK_TRANSFER) {
    return PaymentMethod.BANK_TRANSFER;
  }
  return PaymentMethod.WECHAT;
}

export function calculateWriteOffAmount(
  itemAmount: bigint,
  billRemainingAmount: bigint,
  paymentRemainingAmount: bigint
) {
  if (
    itemAmount < 0n ||
    billRemainingAmount < 0n ||
    paymentRemainingAmount < 0n
  ) {
    throw new RangeError("Settlement amounts cannot be negative.");
  }
  return [itemAmount, billRemainingAmount, paymentRemainingAmount].reduce(
    (minimum, value) => (value < minimum ? value : minimum)
  );
}

async function lockSubscriptionOrders(
  tx: Prisma.TransactionClient,
  orderIds: string[]
) {
  const ids = [...new Set(orderIds)].sort();
  if (ids.length === 0) {
    return;
  }
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "subscription_order"
    WHERE "id" = ANY(ARRAY[${Prisma.join(ids)}]::uuid[])
    ORDER BY "id"
    FOR UPDATE
  `);
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
