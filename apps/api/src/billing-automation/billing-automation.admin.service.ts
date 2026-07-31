import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AuditAction,
  BillingSchedule,
  BillingScheduleStatus,
  SubscriptionAutomationJob,
  SubscriptionAutomationJobStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { BillingAutomationJobQueryDto, BillingScheduleQueryDto } from "./billing-automation.dto";
import { BillingAutomationRepository } from "./billing-automation.repository";
import { BillingAutomationService } from "./billing-automation.service";

@Injectable()
export class BillingAutomationAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: BillingAutomationRepository,
    private readonly service: BillingAutomationService,
    private readonly auditService: AuditService
  ) {}

  async summary() {
    const [scheduleGroups, jobGroups, nextSchedule, oldestPendingJob] = await Promise.all([
      this.prisma.billingSchedule.groupBy({
        _count: { _all: true },
        by: ["status"]
      }),
      this.prisma.subscriptionAutomationJob.groupBy({
        _count: { _all: true },
        by: ["jobStatus"]
      }),
      this.prisma.billingSchedule.findFirst({
        orderBy: { nextGenerateAt: "asc" },
        select: {
          nextGenerateAt: true,
          nextPeriodEnd: true,
          nextPeriodStart: true,
          orderId: true
        },
        where: { status: BillingScheduleStatus.ACTIVE }
      }),
      this.prisma.subscriptionAutomationJob.findFirst({
        orderBy: { availableAt: "asc" },
        select: { availableAt: true, id: true },
        where: {
          jobStatus: SubscriptionAutomationJobStatus.PENDING
        }
      })
    ]);

    return {
      jobs: countByEnum(Object.values(SubscriptionAutomationJobStatus), jobGroups, "jobStatus"),
      nextSchedule: nextSchedule
        ? {
            ...nextSchedule,
            nextGenerateAt: toIso(nextSchedule.nextGenerateAt),
            nextPeriodEnd: toIso(nextSchedule.nextPeriodEnd),
            nextPeriodStart: toIso(nextSchedule.nextPeriodStart)
          }
        : null,
      oldestPendingJob: oldestPendingJob
        ? {
            ...oldestPendingJob,
            availableAt: toIso(oldestPendingJob.availableAt)
          }
        : null,
      schedules: countByEnum(Object.values(BillingScheduleStatus), scheduleGroups, "status")
    };
  }

  async listSchedules(query: BillingScheduleQueryDto) {
    const { page, pageSize, skip } = pagination(query);
    const where = {
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.status ? { status: query.status } : {})
    };
    const [items, total] = await Promise.all([
      this.prisma.billingSchedule.findMany({
        include: {
          lastGeneratedBill: {
            select: { billNo: true, id: true }
          },
          order: {
            select: {
              customer: { select: { name: true } },
              orderNo: true
            }
          }
        },
        orderBy: [{ nextGenerateAt: "asc" }, { createdAt: "asc" }],
        skip,
        take: pageSize,
        where
      }),
      this.prisma.billingSchedule.count({ where })
    ]);

    return {
      items: items.map(toScheduleView),
      page,
      pageSize,
      total
    };
  }

  async listJobs(query: BillingAutomationJobQueryDto) {
    const { page, pageSize, skip } = pagination(query);
    const where = {
      ...(query.billId ? { billId: query.billId } : {}),
      ...(query.jobStatus ? { jobStatus: query.jobStatus } : {}),
      ...(query.jobType ? { jobType: query.jobType } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {})
    };
    const [items, total] = await Promise.all([
      this.prisma.subscriptionAutomationJob.findMany({
        include: {
          bill: { select: { billNo: true } },
          order: { select: { orderNo: true } }
        },
        orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
        skip,
        take: pageSize,
        where
      }),
      this.prisma.subscriptionAutomationJob.count({ where })
    ]);

    return {
      items: items.map(toJobView),
      page,
      pageSize,
      total
    };
  }

  async reconcile(dryRun: boolean, user: RequestUser, context: RequestContext) {
    const result = await this.service.reconcileSchedules({ dryRun });
    if (!dryRun) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: result,
        entityType: "billing_schedule_reconciliation",
        ipAddress: context.ipAddress,
        module: "billing",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }
    return result;
  }

  async pauseSchedule(id: string, reason: string, user: RequestUser, context: RequestContext) {
    const before = await this.prisma.billingSchedule.findUnique({
      where: { id }
    });
    if (!before) {
      throw new NotFoundException("账单计划不存在。");
    }
    if (
      before.status === BillingScheduleStatus.COMPLETED ||
      before.status === BillingScheduleStatus.CANCELLED
    ) {
      throw new BadRequestException("已结束的账单计划不能暂停。");
    }
    const schedule = await this.prisma.billingSchedule.update({
      data: {
        pauseReason: reason,
        status: BillingScheduleStatus.PAUSED
      },
      where: { id }
    });
    await this.writeScheduleAudit(before, schedule, user, context);
    return toScheduleView(schedule);
  }

  async resumeSchedule(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.prisma.billingSchedule.findUnique({
      where: { id }
    });
    if (!before) {
      throw new NotFoundException("账单计划不存在。");
    }
    if (before.status !== BillingScheduleStatus.PAUSED) {
      throw new BadRequestException("只有已暂停的账单计划可以恢复。");
    }
    const schedule = await this.prisma.billingSchedule.update({
      data: {
        pauseReason: null,
        status: BillingScheduleStatus.ACTIVE
      },
      where: { id }
    });
    await this.writeScheduleAudit(before, schedule, user, context);
    return toScheduleView(schedule);
  }

  async retryJob(id: string, user: RequestUser, context: RequestContext) {
    const retried = await this.repository.retryDeadLetter(id);
    if (!retried) {
      throw new BadRequestException("只有死信任务可以人工重试。");
    }
    const job = await this.prisma.subscriptionAutomationJob.findUniqueOrThrow({
      where: { id }
    });
    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: {
        id: job.id,
        jobStatus: job.jobStatus,
        retryRequested: true
      },
      entityId: job.id,
      entityType: "subscription_automation_job",
      ipAddress: context.ipAddress,
      module: "billing",
      operatorId: user.id,
      userAgent: context.userAgent
    });
    return toJobView(job);
  }

  private async writeScheduleAudit(
    before: unknown,
    after: { id: string },
    user: RequestUser,
    context: RequestContext
  ) {
    await this.auditService.write({
      action: AuditAction.UPDATE,
      after,
      before,
      entityId: after.id,
      entityType: "billing_schedule",
      ipAddress: context.ipAddress,
      module: "billing",
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }
}

function pagination(query: { page?: number; pageSize?: number }) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function countByEnum<
  T extends string,
  K extends string,
  R extends Record<K, T> & { _count: { _all: number } }
>(values: T[], rows: R[], key: K) {
  return Object.fromEntries(
    values.map((value) => [value, rows.find((row) => row[key] === value)?._count._all ?? 0])
  ) as Record<T, number>;
}

type BillingScheduleViewRecord = BillingSchedule & {
  lastGeneratedBill?: { billNo: string; id: string } | null;
  order?: {
    customer: { name: string };
    orderNo: string;
  };
};

function toScheduleView(schedule: BillingScheduleViewRecord) {
  return {
    completedAt: toIso(schedule.completedAt),
    createdAt: toIso(schedule.createdAt),
    customerName: schedule.order?.customer?.name ?? null,
    id: schedule.id,
    lastGeneratedAt: toIso(schedule.lastGeneratedAt),
    lastGeneratedBillId: schedule.lastGeneratedBillId,
    lastGeneratedBillNo: schedule.lastGeneratedBill?.billNo ?? null,
    nextCycleNo: schedule.nextCycleNo,
    nextGenerateAt: toIso(schedule.nextGenerateAt),
    nextPeriodEnd: toIso(schedule.nextPeriodEnd),
    nextPeriodStart: toIso(schedule.nextPeriodStart),
    orderId: schedule.orderId,
    orderNo: schedule.order?.orderNo ?? null,
    pauseReason: schedule.pauseReason,
    status: schedule.status,
    timezone: schedule.timezone,
    updatedAt: toIso(schedule.updatedAt)
  };
}

type BillingAutomationJobViewRecord = SubscriptionAutomationJob & {
  bill?: { billNo: string } | null;
  order?: { orderNo: string } | null;
};

function toJobView(job: BillingAutomationJobViewRecord) {
  return {
    attemptCount: job.attemptCount,
    availableAt: toIso(job.availableAt),
    billId: job.billId,
    billNo: job.bill?.billNo ?? null,
    completedAt: toIso(job.completedAt),
    createdAt: toIso(job.createdAt),
    id: job.id,
    idempotencyKey: job.idempotencyKey,
    jobStatus: job.jobStatus,
    jobType: job.jobType,
    lastErrorCode: job.lastErrorCode,
    lastErrorMessage: job.lastErrorMessage,
    maxAttempts: job.maxAttempts,
    orderId: job.orderId,
    orderNo: job.order?.orderNo ?? null,
    updatedAt: toIso(job.updatedAt)
  };
}

function toIso(value: unknown) {
  return value instanceof Date ? value.toISOString() : null;
}
