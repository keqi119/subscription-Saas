import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  AuditAction,
  BillingScheduleStatus,
  BillStatus,
  BillType,
  ContractSegmentStatus,
  ContractSegmentType,
  LeaseStatus,
  OrderStatus,
  Prisma,
  SubscriptionAutomationJobType,
  SubscriptionChangeStatus
} from "@prisma/client";

import { FinanceService, MonthlyRentAutomationCycleInput } from "../finance/finance.service";
import { AutoDebitScheduler } from "../auto-debit/auto-debit.scheduler";
import { activateLeaseRecord } from "../lease/lease-activation.persistence";
import { PrismaService } from "../prisma/prisma.service";
import { ContractSegmentService } from "../subscription-change/contract-segment.service";
import { ContractSegmentError } from "../subscription-change/subscription-change.errors";
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
import { BillingAutomationError, ClaimedBillingAutomationJob } from "./billing-automation.types";

export const BILLING_AUTOMATION_CLOCK = Symbol("BILLING_AUTOMATION_CLOCK");
export type BillingAutomationClock = () => Date;

type BillingScheduleDb = Pick<Prisma.TransactionClient, "billingSchedule">;

@Injectable()
export class BillingAutomationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: BillingAutomationRepository,
    private readonly financeService: FinanceService,
    private readonly autoDebitScheduler: AutoDebitScheduler,
    private readonly contractSegmentService: ContractSegmentService,
    @Optional()
    @Inject(BILLING_AUTOMATION_CLOCK)
    private readonly clock: BillingAutomationClock = () => new Date()
  ) {}

  async ensureActiveSchedule(tx: BillingScheduleDb, orderId: string, actualDeliveryAt: Date) {
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
        status: completed ? BillingScheduleStatus.COMPLETED : BillingScheduleStatus.ACTIVE,
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
        lease: true,
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
      leaseAction: "NONE" | "ACTIVATED" | "WOULD_ACTIVATE";
      leaseStatus: LeaseStatus | null;
      nextCycleNo: number;
      nextGenerateAt: string;
      nextPeriodEnd: string;
      nextPeriodStart: string;
      orderId: string;
      orderNo: string;
      scheduleId: string | null;
    }> = [];

    for (const order of orders) {
      const effectiveServiceEndDate =
        await this.contractSegmentService.resolveEffectiveServiceEndDate(order.id);
      const leaseNeedsActivation =
        !order.lease || Boolean(order.lease.deletedAt) || order.lease.status !== LeaseStatus.ACTIVE;
      const leasePreview = {
        leaseAction: leaseNeedsActivation ? ("WOULD_ACTIVATE" as const) : ("NONE" as const),
        leaseStatus: order.lease?.status ?? null
      };
      if (order.billingSchedule) {
        const amount = await this.reconciliationSegmentAmount(
          order.id,
          order.billingSchedule.nextPeriodStart
        );
        let leaseResult: {
          leaseAction: "NONE" | "ACTIVATED" | "WOULD_ACTIVATE";
          leaseStatus: LeaseStatus | null;
        } = leasePreview;
        if (!input.dryRun && leaseNeedsActivation) {
          const repaired = await this.prisma.$transaction(async (tx) => {
            const activation = await activateLeaseRecord(tx, {
              activatedAt: order.actualDeliveryAt!,
              orderId: order.id
            });
            await writeLeaseReconciliationAudit(tx, activation.existing, activation.lease);
            return activation.lease;
          });
          leaseResult = {
            leaseAction: "ACTIVATED",
            leaseStatus: repaired.status
          };
        }
        items.push({
          action: "EXISTING",
          ...amount,
          ...leaseResult,
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
      const baseline = reconciliationBaseline(order.actualDeliveryAt!, order.receivableBills, now);
      const amount = await this.reconciliationSegmentAmount(order.id, baseline.cycle.periodStart);
      const completed =
        effectiveServiceEndDate instanceof Date &&
        baseline.cycle.periodStart.getTime() > effectiveServiceEndDate.getTime();
      const itemFacts = {
        ...amount,
        baselineReason: baseline.reason,
        basisBillId: baseline.basisBillId,
        basisPeriodStart: baseline.basisPeriodStart ? isoDate(baseline.basisPeriodStart) : null,
        nextCycleNo: baseline.cycle.cycleNo,
        nextGenerateAt: isoDate(baseline.cycle.generateAt),
        nextPeriodEnd: isoDate(baseline.cycle.periodEnd),
        nextPeriodStart: isoDate(baseline.cycle.periodStart)
      };
      if (input.dryRun) {
        items.push({
          action: "WOULD_CREATE",
          ...itemFacts,
          ...leasePreview,
          orderId: order.id,
          orderNo: order.orderNo,
          scheduleId: null
        });
        continue;
      }

      const applied = await this.prisma.$transaction(async (tx) => {
        let leaseStatus = order.lease?.status ?? null;
        if (leaseNeedsActivation) {
          const activation = await activateLeaseRecord(tx, {
            activatedAt: order.actualDeliveryAt!,
            orderId: order.id
          });
          await writeLeaseReconciliationAudit(tx, activation.existing, activation.lease);
          leaseStatus = activation.lease.status;
        }
        const schedule = await this.ensureScheduleAtCycle(tx, order.id, baseline.cycle, completed);
        return { leaseStatus, schedule };
      });
      items.push({
        action: "CREATED",
        ...itemFacts,
        leaseAction: leaseNeedsActivation ? "ACTIVATED" : "NONE",
        leaseStatus: applied.leaseStatus,
        orderId: order.id,
        orderNo: order.orderNo,
        scheduleId: applied.schedule.id
      });
    }

    return {
      createdCount: items.filter(
        (item) => item.action === "CREATED" || item.action === "WOULD_CREATE"
      ).length,
      dryRun: input.dryRun,
      eligibleCount: orders.length,
      existingCount: items.filter((item) => item.action === "EXISTING").length,
      leaseActivationCount: items.filter(
        (item) => item.leaseAction === "ACTIVATED" || item.leaseAction === "WOULD_ACTIVATE"
      ).length,
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
        idempotencyKey: billingSourceKey(schedule.orderId, schedule.nextPeriodStart),
        jobType: SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
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

  private async reconciliationSegmentAmount(orderId: string, periodStart: Date) {
    const segment = await this.contractSegmentService.resolveSegmentForPeriod(orderId, periodStart);
    return {
      amountSource: "CONTRACT_SEGMENT",
      monthlyRentAmount: Number(segment.monthlyFeeAmount)
    };
  }

  async generateScheduledMonthlyRent(job: ClaimedBillingAutomationJob) {
    if (!job.billingScheduleId || !job.orderId) {
      throw configurationError();
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const [lockedOrder] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "subscription_order"
          WHERE "id" = ${job.orderId}::uuid
          FOR UPDATE
        `);
        if (!lockedOrder) throw configurationError();
        const [lockedSchedule] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "billing_schedule"
          WHERE "id" = ${job.billingScheduleId}::uuid
          FOR UPDATE
        `);
        if (!lockedSchedule) throw configurationError();
        const schedule = await tx.billingSchedule.findUnique({
          include: { order: { include: { lease: true } } },
          where: { id: job.billingScheduleId! }
        });
        if (schedule?.status === BillingScheduleStatus.PAUSED) {
          throw pausedScheduleError();
        }
        const activePerformance =
          schedule?.order.orderStatus === OrderStatus.ACTIVE &&
          schedule.order.lease?.status === LeaseStatus.ACTIVE;
        const expiryCatchUp =
          schedule?.order.orderStatus === OrderStatus.PENDING_RETURN &&
          schedule.order.lease?.status === LeaseStatus.RETURN_DUE;
        const returnedCatchUp =
          schedule?.order.orderStatus === OrderStatus.COMPLETED &&
          schedule.order.lease?.status === LeaseStatus.COMPLETED;
        if (
          !schedule ||
          schedule.status !== BillingScheduleStatus.ACTIVE ||
          schedule.orderId !== job.orderId ||
          schedule.order.deletedAt ||
          !schedule.order.actualDeliveryAt ||
          !schedule.order.lease ||
          schedule.order.lease.deletedAt ||
          (!activePerformance && !expiryCatchUp && !returnedCatchUp)
        ) {
          throw configurationError();
        }

        const cycle = cycleAt(schedule.order.actualDeliveryAt, schedule.nextCycleNo);
        assertScheduleMatchesCycle(schedule, cycle);
        const sourceKey = billingSourceKey(schedule.orderId, cycle.periodStart);
        if (job.idempotencyKey !== sourceKey) {
          throw configurationError();
        }
        const generatedAt = this.clock();
        const contractServiceEndDate =
          await this.contractSegmentService.resolveEffectiveServiceEndDate(schedule.orderId, tx);
        const effectiveServiceEndDate = earliestServiceEndDate(
          contractServiceEndDate,
          schedule.serviceEndDate
        );
        if (
          effectiveServiceEndDate instanceof Date &&
          cycle.periodStart.getTime() > effectiveServiceEndDate.getTime()
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

        let segment;
        try {
          segment = await this.contractSegmentService.resolveSegmentForPeriod(
            schedule.orderId,
            cycle.periodStart,
            { db: tx, periodEnd: cycle.periodEnd }
          );
        } catch (error) {
          if (
            error instanceof ContractSegmentError &&
            error.code === "BILLING_PERIOD_CROSSES_SEGMENT"
          ) {
            await this.moveCrossingPeriodToManualTakeover(tx, {
              changeOrderId: error.context?.changeOrderId,
              generatedAt,
              jobId: job.id,
              scheduleId: schedule.id,
              scheduleVersion: schedule.version,
              sourceKey
            });
            return { billingFailure: crossingSegmentError() } as const;
          }
          throw error;
        }

        const financeInput: MonthlyRentAutomationCycleInput = {
          actorId: null,
          contractSegmentId: segment.segmentId,
          cycleNo: cycle.cycleNo,
          monthlyRentAmount: segment.monthlyFeeAmount,
          orderId: schedule.orderId,
          periodEnd: cycle.periodEnd,
          periodStart: cycle.periodStart,
          sourceKey
        };
        const generated = await this.financeService.generateMonthlyRentBillForCycle(
          tx,
          financeInput
        );
        const nextCycle = buildNextBillingCycle(cycle);
        const completed =
          effectiveServiceEndDate instanceof Date &&
          nextCycle.periodStart.getTime() > effectiveServiceEndDate.getTime();
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
          jobType: SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE,
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
          idempotencyKey: overdueJobKey(generated.bill.id, cycle.dueDate),
          jobType: SubscriptionAutomationJobType.MARK_BILL_OVERDUE,
          orderId: schedule.orderId,
          payload: {
            asOfDate: isoDate(cycle.overdueAt),
            billId: generated.bill.id
          }
        });
        await this.autoDebitScheduler.enqueueForBill(tx, generated.bill, schedule.id);
        await tx.auditLog.create({
          data: {
            action: generated.created ? AuditAction.CREATE : AuditAction.UPDATE,
            afterSnapshot: {
              actorType: "SYSTEM",
              billId: generated.bill.id,
              contractSegmentId: segment.segmentId,
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
      if ("billingFailure" in result) {
        throw result.billingFailure;
      }
      return result;
    } catch (error) {
      const classified = classifyExecutionError(error);
      if (classified.code === "BILLING_EXECUTION_ERROR" && job.billingScheduleId) {
        const currentSchedule = await this.prisma.billingSchedule
          .findUnique({
            select: { status: true },
            where: { id: job.billingScheduleId }
          })
          .catch(() => null);
        if (currentSchedule?.status === BillingScheduleStatus.PAUSED) {
          throw pausedScheduleError();
        }
      }
      throw classified;
    }
  }

  async resumeForExtension(orderId: string, segmentId: string, now = this.clock()) {
    return this.prisma.$transaction(async (tx) => {
      const segment = await tx.subscriptionContractSegment.findUnique({
        select: {
          endDate: true,
          id: true,
          orderId: true,
          segmentType: true,
          status: true
        },
        where: { id: segmentId }
      });
      const schedule = await tx.billingSchedule.findUnique({
        where: { orderId }
      });
      if (
        !segment ||
        segment.orderId !== orderId ||
        segment.segmentType !== ContractSegmentType.EXTENSION ||
        segment.status === ContractSegmentStatus.CANCELLED ||
        !schedule ||
        schedule.nextPeriodStart.getTime() > segment.endDate.getTime()
      ) {
        throw configurationError();
      }
      if (schedule.status === BillingScheduleStatus.ACTIVE) {
        return schedule;
      }
      if (schedule.status !== BillingScheduleStatus.COMPLETED) {
        throw configurationError();
      }

      const updated = await tx.billingSchedule.updateMany({
        data: {
          completedAt: null,
          pauseReason: null,
          status: BillingScheduleStatus.ACTIVE,
          version: { increment: 1 }
        },
        where: {
          id: schedule.id,
          status: BillingScheduleStatus.COMPLETED,
          version: schedule.version
        }
      });
      if (updated.count !== 1) {
        throw retryableExecutionError();
      }
      await tx.auditLog.create({
        data: {
          action: AuditAction.UPDATE,
          afterSnapshot: {
            actorType: "SYSTEM",
            contractSegmentId: segment.id,
            reason: "EXTENSION_BILLING_CONTINUATION",
            resumedAt: now
          },
          entityId: schedule.id,
          entityType: "billing_schedule",
          module: "billing",
          operatorId: null
        }
      });
      return tx.billingSchedule.findUniqueOrThrow({
        where: { id: schedule.id }
      });
    });
  }

  private async moveCrossingPeriodToManualTakeover(
    tx: Prisma.TransactionClient,
    input: {
      changeOrderId?: string;
      generatedAt: Date;
      jobId: string;
      scheduleId: string;
      scheduleVersion: number;
      sourceKey: string;
    }
  ) {
    const paused = await tx.billingSchedule.updateMany({
      data: {
        pauseReason: "BILLING_PERIOD_CROSSES_SEGMENT",
        status: BillingScheduleStatus.PAUSED,
        version: { increment: 1 }
      },
      where: {
        id: input.scheduleId,
        status: BillingScheduleStatus.ACTIVE,
        version: input.scheduleVersion
      }
    });
    if (paused.count !== 1) {
      throw retryableExecutionError();
    }
    if (input.changeOrderId) {
      await tx.subscriptionChangeOrder.updateMany({
        data: {
          failureCode: "BILLING_PERIOD_CROSSES_SEGMENT",
          failureMessage: "The monthly billing period crosses a contract segment boundary.",
          manualTakeoverAt: input.generatedAt,
          status: SubscriptionChangeStatus.MANUAL_TAKEOVER,
          version: { increment: 1 }
        },
        where: {
          id: input.changeOrderId,
          status: {
            in: [
              SubscriptionChangeStatus.SCHEDULED,
              SubscriptionChangeStatus.EXECUTING,
              SubscriptionChangeStatus.COMPLETED
            ]
          }
        }
      });
    }
    await tx.auditLog.create({
      data: {
        action: AuditAction.UPDATE,
        afterSnapshot: {
          actorType: "SYSTEM",
          changeOrderId: input.changeOrderId ?? null,
          jobId: input.jobId,
          reason: "BILLING_PERIOD_CROSSES_SEGMENT",
          sourceKey: input.sourceKey
        },
        entityId: input.scheduleId,
        entityType: "billing_schedule",
        module: "billing",
        operatorId: null
      }
    });
  }

  async markScheduledBillOverdue(job: ClaimedBillingAutomationJob) {
    if (!job.billId) {
      throw configurationError();
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const result = await this.financeService.markBillOverdueForAutomation(
          tx,
          job.billId!,
          this.clock()
        );
        if (result.action === "MARKED_OVERDUE" || result.action === "ALREADY_OVERDUE") {
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
            jobType: SubscriptionAutomationJobType.SEND_BILL_OVERDUE_NOTICE,
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

async function writeLeaseReconciliationAudit(
  tx: Pick<Prisma.TransactionClient, "auditLog">,
  before: {
    activatedAt: Date | null;
    deletedAt: Date | null;
    id: string;
    orderId: string;
    status: LeaseStatus;
  } | null,
  after: {
    activatedAt: Date | null;
    deletedAt: Date | null;
    id: string;
    orderId: string;
    status: LeaseStatus;
  }
) {
  await tx.auditLog.create({
    data: {
      action: before ? AuditAction.UPDATE : AuditAction.CREATE,
      afterSnapshot: leaseReconciliationSnapshot(after),
      beforeSnapshot: before ? leaseReconciliationSnapshot(before) : undefined,
      entityId: after.id,
      entityType: "lease",
      module: "billing",
      operatorId: null
    }
  });
}

function leaseReconciliationSnapshot(lease: {
  activatedAt: Date | null;
  deletedAt: Date | null;
  orderId: string;
  status: LeaseStatus;
}) {
  return {
    activatedAt: lease.activatedAt?.toISOString() ?? null,
    actorType: "SYSTEM",
    deletedAt: lease.deletedAt?.toISOString() ?? null,
    orderId: lease.orderId,
    reason: "BILLING_SCHEDULE_RECONCILIATION",
    status: lease.status
  };
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
    const matched = cycleForPeriodStart(actualDeliveryAt, bill.billPeriodStart);
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

function cycleForPeriodStart(actualDeliveryAt: Date, periodStart: Date) {
  let cycle = buildInitialBillingCycle(actualDeliveryAt);
  for (let cycleNo = 1; cycleNo <= 1200; cycleNo += 1) {
    const difference = cycle.periodStart.getTime() - periodStart.getTime();
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

function crossingSegmentError() {
  return new BillingAutomationError({
    code: "BILLING_PERIOD_CROSSES_SEGMENT",
    message: "The billing period crosses a contract segment boundary and requires manual takeover.",
    retryable: false
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

function earliestServiceEndDate(left: Date | null, right: Date | null) {
  if (!left) return right;
  if (!right) return left;
  return left.getTime() <= right.getTime() ? left : right;
}
