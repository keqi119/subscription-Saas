import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  AuditAction,
  BillingScheduleStatus,
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
  buildInitialBillingCycle,
  buildNextBillingCycle,
  dueNoticeJobKey,
  overdueJobKey,
  overdueNoticeJobKey
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
    return tx.billingSchedule.upsert({
      create: {
        nextCycleNo: cycle.cycleNo,
        nextGenerateAt: cycle.generateAt,
        nextPeriodEnd: cycle.periodEnd,
        nextPeriodStart: cycle.periodStart,
        orderId,
        status: BillingScheduleStatus.ACTIVE,
        timezone: "Asia/Shanghai"
      },
      update: {},
      where: { orderId }
    });
  }

  async reconcileSchedules(input: { dryRun: boolean }) {
    const orders = await this.prisma.subscriptionOrder.findMany({
      include: { billingSchedule: true },
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
      orderId: string;
      scheduleId: string | null;
    }> = [];

    for (const order of orders) {
      if (order.billingSchedule) {
        items.push({
          action: "EXISTING",
          orderId: order.id,
          scheduleId: order.billingSchedule.id
        });
        continue;
      }
      if (input.dryRun) {
        items.push({
          action: "WOULD_CREATE",
          orderId: order.id,
          scheduleId: null
        });
        continue;
      }

      const schedule = await this.prisma.$transaction((tx) =>
        this.ensureActiveSchedule(
          tx,
          order.id,
          order.actualDeliveryAt!
        )
      );
      items.push({
        action: "CREATED",
        orderId: order.id,
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
        const generatedAt = this.clock();
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

function cycleAt(actualDeliveryAt: Date, cycleNo: number) {
  let cycle = buildInitialBillingCycle(actualDeliveryAt);
  while (cycle.cycleNo < cycleNo) {
    cycle = buildNextBillingCycle(cycle);
  }
  if (cycle.cycleNo !== cycleNo) {
    throw configurationError();
  }
  return cycle;
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
