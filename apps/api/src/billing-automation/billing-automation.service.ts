import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  AuditAction,
  BillingScheduleStatus,
  BillStatus,
  BillType,
  LeaseStatus,
  OrderStatus,
  Prisma,
  SubscriptionAutomationJobType
} from "@prisma/client";

import {
  FinanceService,
  MonthlyRentAutomationCycleInput
} from "../finance/finance.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  BillingCycle,
  billingSourceKey,
  buildBillingCycleForDelivery,
  buildInitialBillingCycle,
  buildNextBillingCycle,
  dueNoticeJobKey,
  overdueJobKey,
  overdueNoticeJobKey,
  toBillingBusinessDate
} from "./billing-automation.calendar";
import { BillingAutomationRepository } from "./billing-automation.repository";
import {
  BillingAutomationError,
  ClaimedBillingAutomationJob
} from "./billing-automation.types";

export const BILLING_AUTOMATION_CLOCK = Symbol(
  "BILLING_AUTOMATION_CLOCK"
);
export type BillingAutomationClock = () => Date;

type BillingScheduleDb = Pick<
  Prisma.TransactionClient,
  "billingSchedule"
>;

@Injectable()
export class BillingAutomationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: BillingAutomationRepository,
    private readonly financeService: FinanceService,
    @Optional()
    @Inject(BILLING_AUTOMATION_CLOCK)
    private readonly clock: BillingAutomationClock = () => new Date()
  ) {}

  async ensureActiveSchedule(
    tx: BillingScheduleDb,
    orderId: string,
    actualDeliveryAt: Date
  ) {
    const cycle = buildInitialBillingCycle(actualDeliveryAt);
    return this.ensureScheduleAtCycle(tx, orderId, cycle, false);
  }

  private async ensureScheduleAtCycle(
    tx: BillingScheduleDb,
    orderId: string,
    cycle: BillingCycle,
    completed: boolean
  ) {
    return tx.billingSchedule.upsert({
      create: {
        completedAt: completed ? this.clock() : undefined,
        nextCycleNo: cycle.cycleNo,
        nextGenerateAt: cycle.generateAt,
        nextPeriodEnd: cycle.periodEnd,
        nextPeriodStart: cycle.periodStart,
        orderId,
        status: completed
          ? BillingScheduleStatus.COMPLETED
          : BillingScheduleStatus.ACTIVE,
        timezone: "Asia/Shanghai"
      },
      update: {},
      where: { orderId }
    });
  }

  async reconcileSchedules(input: { dryRun: boolean }) {
    const now = this.clock();
    const orders = await this.prisma.subscriptionOrder.findMany({
      include: {
        billingSchedule: true,
        receivableBills: {
          orderBy: { billPeriodStart: "asc" },
          select: {
            billPeriodEnd: true,
            billPeriodStart: true,
            id: true,
            sourceKey: true
          },
          where: {
            billPeriodEnd: { not: null },
            billPeriodStart: { not: null },
            billStatus: { not: BillStatus.CANCELLED },
            billType: BillType.MONTHLY_RENT,
            deletedAt: null
          }
        }
      },
      orderBy: { createdAt: "asc" },
      where: {
        actualDeliveryAt: { not: null },
        deletedAt: null,
        lease: {
          is: {
            deletedAt: null,
            status: LeaseStatus.ACTIVE
          }
        },
        orderStatus: OrderStatus.ACTIVE
      }
    });
    const items: Array<{
      action: "EXISTING" | "CREATED" | "WOULD_CREATE";
      amountSource: string;
      baselineReason: string;
      basisBillId: string | null;
      basisPeriodStart: string | null;
      monthlyRentAmount: number | null;
      nextCycleNo: number;
      nextGenerateAt: string;
      nextPeriodEnd: string;
      nextPeriodStart: string;
      orderId: string;
      orderNo: string;
      scheduleId: string | null;
    }> = [];

    for (const order of orders) {
      const amount = reconciliationAmount(order);
      if (order.billingSchedule) {
        items.push({
          action: "EXISTING",
          ...amount,
          baselineReason: "EXISTING_SCHEDULE",
          basisBillId: order.billingSchedule.lastGeneratedBillId,
          basisPeriodStart: null,
          nextCycleNo: order.billingSchedule.nextCycleNo,
          nextGenerateAt: isoDate(order.billingSchedule.nextGenerateAt),
          nextPeriodEnd: isoDate(order.billingSchedule.nextPeriodEnd),
          nextPeriodStart: isoDate(order.billingSchedule.nextPeriodStart),
          orderId: order.id,
          orderNo: order.orderNo,
          scheduleId: order.billingSchedule.id
        });
        continue;
      }
      const baseline = reconciliationBaseline(
        order.actualDeliveryAt!,
        order.receivableBills,
        now
      );
      const completed =
        order.endDate instanceof Date &&
        baseline.cycle.periodStart.getTime() > order.endDate.getTime();
      const itemFacts = {
        ...amount,
        baselineReason: baseline.reason,
        basisBillId: baseline.basisBillId,
        basisPeriodStart: baseline.basisPeriodStart
          ? isoDate(baseline.basisPeriodStart)
          : null,
        nextCycleNo: baseline.cycle.cycleNo,
        nextGenerateAt: isoDate(baseline.cycle.generateAt),
        nextPeriodEnd: isoDate(baseline.cycle.periodEnd),
        nextPeriodStart: isoDate(baseline.cycle.periodStart)
      };
      if (input.dryRun) {
        items.push({
          action: "WOULD_CREATE",
          ...itemFacts,
          orderId: order.id,
          orderNo: order.orderNo,
          scheduleId: null
        });
        continue;
      }

      const schedule = await this.prisma.$transaction((tx) =>
        this.ensureScheduleAtCycle(
          tx,
          order.id,
          baseline.cycle,
          completed
        )
      );
      items.push({
        action: "CREATED",
        ...itemFacts,
        orderId: order.id,
        orderNo: order.orderNo,
        scheduleId: schedule.id
      });
    }

    return {
      createdCount: items.filter((item) =>
        item.action === "CREATED" || item.action === "WOULD_CREATE"
      ).length,
      dryRun: input.dryRun,
      eligibleCount: orders.length,
      existingCount: items.filter((item) => item.action === "EXISTING")
        .length,
      items
    };
  }

  async enqueueDueSchedules(now = this.clock()) {
    const schedules = await this.prisma.billingSchedule.findMany({
      orderBy: { nextGenerateAt: "asc" },
      where: {
        nextGenerateAt: { lte: now },
        status: BillingScheduleStatus.ACTIVE
      }
    });

    for (const schedule of schedules) {
      await this.repository.enqueue(this.prisma, {
        availableAt: schedule.nextGenerateAt,
        billingScheduleId: schedule.id,
        idempotencyKey: billingSourceKey(
          schedule.orderId,
          schedule.nextPeriodStart
        ),
        jobType:
          SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
        orderId: schedule.orderId,
        payload: {
          cycleNo: schedule.nextCycleNo,
          periodEnd: isoDate(schedule.nextPeriodEnd),
          periodStart: isoDate(schedule.nextPeriodStart)
        }
      });
    }

    return {
      dueCount: schedules.length,
      enqueuedCount: schedules.length
    };
  }

  async generateScheduledMonthlyRent(job: ClaimedBillingAutomationJob) {
    if (!job.billingScheduleId || !job.orderId) {
      throw configurationError();
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const schedule = await tx.billingSchedule.findUnique({
          include: { order: { include: { lease: true } } },
          where: { id: job.billingScheduleId! }
        });
        if (schedule?.status === BillingScheduleStatus.PAUSED) {
          throw pausedScheduleError();
        }
        if (
          !schedule ||
          schedule.status !== BillingScheduleStatus.ACTIVE ||
          schedule.orderId !== job.orderId ||
          schedule.order.deletedAt ||
          schedule.order.orderStatus !== OrderStatus.ACTIVE ||
          !schedule.order.actualDeliveryAt ||
          !schedule.order.lease ||
          schedule.order.lease.deletedAt ||
          schedule.order.lease.status !== LeaseStatus.ACTIVE
        ) {
          throw configurationError();
        }

        const cycle = cycleAt(
          schedule.order.actualDeliveryAt,
          schedule.nextCycleNo
        );
        assertScheduleMatchesCycle(schedule, cycle);
        const sourceKey = billingSourceKey(
          schedule.orderId,
          cycle.periodStart
        );
        if (job.idempotencyKey !== sourceKey) {
          throw configurationError();
        }
        const generatedAt = this.clock();
        if (
          schedule.order.endDate instanceof Date &&
          cycle.periodStart.getTime() > schedule.order.endDate.getTime()
        ) {
          const completedSchedule = await tx.billingSchedule.updateMany({
            data: {
              completedAt: generatedAt,
              status: BillingScheduleStatus.COMPLETED,
              version: { increment: 1 }
            },
            where: {
              id: schedule.id,
              status: BillingScheduleStatus.ACTIVE,
              version: schedule.version
            }
          });
          if (completedSchedule.count !== 1) {
            throw retryableExecutionError();
          }
          await tx.auditLog.create({
            data: {
              action: AuditAction.UPDATE,
              afterSnapshot: {
                actorType: "SYSTEM",
                jobId: job.id,
                reason: "CONTRACT_ENDED_BEFORE_PERIOD",
                sourceKey
              },
              entityId: schedule.id,
              entityType: "billing_schedule",
              module: "billing",
              operatorId: null
            }
          });
          return {
            billId: null,
            completed: true,
            created: false,
            sourceKey
          };
        }

        const financeInput: MonthlyRentAutomationCycleInput = {
          actorId: null,
          cycleNo: cycle.cycleNo,
          orderId: schedule.orderId,
          periodEnd: cycle.periodEnd,
          periodStart: cycle.periodStart,
          sourceKey
        };
        const generated =
          await this.financeService.generateMonthlyRentBillForCycle(
            tx,
            financeInput
          );
        const nextCycle = buildNextBillingCycle(cycle);
        const completed =
          schedule.order.endDate instanceof Date &&
          nextCycle.periodStart.getTime() >
            schedule.order.endDate.getTime();
        const updated = await tx.billingSchedule.updateMany({
          data: completed
            ? {
                completedAt: generatedAt,
                lastGeneratedAt: generatedAt,
                lastGeneratedBillId: generated.bill.id,
                status: BillingScheduleStatus.COMPLETED,
                version: { increment: 1 }
              }
            : {
                lastGeneratedAt: generatedAt,
                lastGeneratedBillId: generated.bill.id,
                nextCycleNo: nextCycle.cycleNo,
                nextGenerateAt: nextCycle.generateAt,
                nextPeriodEnd: nextCycle.periodEnd,
                nextPeriodStart: nextCycle.periodStart,
                version: { increment: 1 }
              },
          where: {
            id: schedule.id,
            status: BillingScheduleStatus.ACTIVE,
            version: schedule.version
          }
        });
        if (updated.count !== 1) {
          throw retryableExecutionError();
        }

        await this.repository.enqueue(tx, {
          availableAt: generatedAt,
          billId: generated.bill.id,
          billingScheduleId: schedule.id,
          idempotencyKey: dueNoticeJobKey(generated.bill.id),
          jobType:
            SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE,
          orderId: schedule.orderId,
          payload: {
            billId: generated.bill.id,
            sourceKey
          }
        });
        await this.repository.enqueue(tx, {
          availableAt: cycle.overdueAt,
          billId: generated.bill.id,
          billingScheduleId: schedule.id,
          idempotencyKey: overdueJobKey(
            generated.bill.id,
            cycle.dueDate
          ),
          jobType: SubscriptionAutomationJobType.MARK_BILL_OVERDUE,
          orderId: schedule.orderId,
          payload: {
            asOfDate: isoDate(cycle.overdueAt),
            billId: generated.bill.id
          }
        });
        await tx.auditLog.create({
          data: {
            action: generated.created
              ? AuditAction.CREATE
              : AuditAction.UPDATE,
            afterSnapshot: {
              actorType: "SYSTEM",
              billId: generated.bill.id,
              jobId: job.id,
              sourceKey
            },
            entityId: generated.bill.id,
            entityType: "receivable_bill",
            module: "billing",
            operatorId: null
          }
        });

        return {
          billId: generated.bill.id,
          completed,
          created: generated.created,
          sourceKey
        };
      });
    } catch (error) {
      throw classifyExecutionError(error);
    }
  }

  async markScheduledBillOverdue(job: ClaimedBillingAutomationJob) {
    if (!job.billId) {
      throw configurationError();
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const result =
          await this.financeService.markBillOverdueForAutomation(
            tx,
            job.billId!,
            this.clock()
          );
        if (
          result.action === "MARKED_OVERDUE" ||
          result.action === "ALREADY_OVERDUE"
        ) {
          await tx.auditLog.create({
            data: {
              action: AuditAction.UPDATE,
              afterSnapshot: {
                actorType: "SYSTEM",
                collectionCaseId: result.collectionCase.id,
                jobId: job.id,
                overdueAction: result.action
              },
              entityId: result.bill.id,
              entityType: "receivable_bill",
              module: "collection",
              operatorId: null
            }
          });
          await this.repository.enqueue(tx, {
            availableAt: this.clock(),
            billId: result.bill.id,
            idempotencyKey: overdueNoticeJobKey(result.bill.id),
            jobType:
              SubscriptionAutomationJobType.SEND_BILL_OVERDUE_NOTICE,
            orderId: job.orderId ?? undefined,
            payload: {
              billId: result.bill.id,
              collectionCaseId: result.collectionCase.id
            }
          });
        }
        return result;
      });
    } catch (error) {
      throw classifyExecutionError(error);
    }
  }
}

function reconciliationBaseline(
  actualDeliveryAt: Date,
  bills: Array<{
    billPeriodStart: Date | null;
    id: string;
  }>,
  now: Date
) {
  const businessDate = toBillingBusinessDate(now);
  let cycle = buildInitialBillingCycle(actualDeliveryAt);
  while (cycle.periodEnd.getTime() < businessDate.getTime()) {
    cycle = buildNextBillingCycle(cycle);
  }

  let basisBillId: string | null = null;
  let basisCycle: BillingCycle | null = null;
  for (const bill of bills) {
    if (!(bill.billPeriodStart instanceof Date)) {
      continue;
    }
    const matched = cycleForPeriodStart(
      actualDeliveryAt,
      bill.billPeriodStart
    );
    if (matched && (!basisCycle || matched.cycleNo > basisCycle.cycleNo)) {
      basisBillId = bill.id;
      basisCycle = matched;
    }
  }

  if (basisCycle && basisCycle.cycleNo >= cycle.cycleNo) {
    cycle = buildNextBillingCycle(basisCycle);
  }

  return {
    basisBillId,
    basisPeriodStart: basisCycle?.periodStart ?? null,
    cycle,
    reason:
      basisCycle && basisCycle.cycleNo >= cycle.cycleNo - 1
        ? "EXISTING_BILL"
        : cycle.cycleNo === 1
          ? "INITIAL_PERIOD"
          : "CURRENT_PERIOD"
  };
}

function cycleForPeriodStart(
  actualDeliveryAt: Date,
  periodStart: Date
) {
  let cycle = buildInitialBillingCycle(actualDeliveryAt);
  for (let cycleNo = 1; cycleNo <= 1200; cycleNo += 1) {
    const difference =
      cycle.periodStart.getTime() - periodStart.getTime();
    if (difference === 0) {
      return cycle;
    }
    if (difference > 0) {
      return null;
    }
    cycle = buildNextBillingCycle(cycle);
  }
  return null;
}

function reconciliationAmount(order: {
  monthlyFeeAmount: bigint;
  quoteSnapshot: Prisma.JsonValue | null;
}) {
  const candidates: Array<[string, unknown]> = [
    ["ORDER_MONTHLY_FEE", order.monthlyFeeAmount],
    [
      "QUOTE_SNAPSHOT_PRICING",
      readPath(order.quoteSnapshot, ["pricing", "monthlyFeeAmount"])
    ],
    [
      "QUOTE_SNAPSHOT",
      readPath(order.quoteSnapshot, ["monthlyFeeAmount"])
    ]
  ];
  for (const [amountSource, value] of candidates) {
    const amount = positiveBigInt(value);
    if (amount !== null) {
      return {
        amountSource,
        monthlyRentAmount: Number(amount)
      };
    }
  }
  return {
    amountSource: "MISSING",
    monthlyRentAmount: null
  };
}

function readPath(value: unknown, path: string[]) {
  let current = value;
  for (const segment of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function positiveBigInt(value: unknown) {
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

function cycleAt(actualDeliveryAt: Date, cycleNo: number) {
  return buildBillingCycleForDelivery(actualDeliveryAt, cycleNo);
}

function assertScheduleMatchesCycle(
  schedule: {
    nextGenerateAt: Date;
    nextPeriodEnd: Date;
    nextPeriodStart: Date;
  },
  cycle: BillingCycle
) {
  if (
    schedule.nextGenerateAt.getTime() !== cycle.generateAt.getTime() ||
    schedule.nextPeriodEnd.getTime() !== cycle.periodEnd.getTime() ||
    schedule.nextPeriodStart.getTime() !== cycle.periodStart.getTime()
  ) {
    throw configurationError();
  }
}

function configurationError() {
  return new BillingAutomationError({
    code: "BILLING_CONFIGURATION_ERROR",
    message: "Billing automation configuration is invalid.",
    retryable: false
  });
}

function retryableExecutionError() {
  return new BillingAutomationError({
    code: "BILLING_EXECUTION_ERROR",
    message: "Billing automation operation failed.",
    retryable: true
  });
}

function pausedScheduleError() {
  return new BillingAutomationError({
    code: "BILLING_SCHEDULE_PAUSED",
    message: "Billing schedule is paused.",
    retryable: true
  });
}

function classifyExecutionError(error: unknown) {
  if (error instanceof BillingAutomationError) {
    return error;
  }
  if (
    error instanceof Error &&
    (error.message.includes("缺少月租") ||
      error.message.includes("状态不允许") ||
      error.message.includes("尚未起租") ||
      error.message.includes("不存在"))
  ) {
    return configurationError();
  }
  return retryableExecutionError();
}

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}
