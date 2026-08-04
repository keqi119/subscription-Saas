import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import {
  AuditAction,
  BillStatus,
  DebitAttemptStatus,
  DebitRetrySlot,
  PaymentMandateStatus,
  Prisma,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { randomUUID } from "node:crypto";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  AdminDebitAttemptQueryDto,
  AutoDebitActionReasonDto,
  SetMockDebitResultDto
} from "./auto-debit.dto";
import { AutoDebitConfig } from "./auto-debit.config";
import {
  AUTO_DEBIT_CONFIG,
  MandateDebitProvider,
  MANDATE_DEBIT_PROVIDER,
  ProviderSnapshot
} from "./auto-debit-provider";
import { MockAutoDebitProvider } from "./mock-auto-debit.provider";

const UNRESOLVED_ATTEMPT_STATUSES = [
  DebitAttemptStatus.CREATED,
  DebitAttemptStatus.SUBMITTING,
  DebitAttemptStatus.PROCESSING,
  DebitAttemptStatus.UNKNOWN
] as const;

const OPEN_BILL_STATUSES = [
  BillStatus.PENDING,
  BillStatus.PARTIALLY_PAID,
  BillStatus.OVERDUE
] as const;

@Injectable()
export class AutoDebitAdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MANDATE_DEBIT_PROVIDER)
    private readonly provider: MandateDebitProvider,
    @Inject(AUTO_DEBIT_CONFIG)
    private readonly config: AutoDebitConfig,
    private readonly audit: AuditService
  ) {}

  async listAttempts(query: AdminDebitAttemptQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.DebitAttemptWhereInput = {
      ...(query.billId ? { billId: query.billId } : {}),
      ...(query.mandateId ? { mandateId: query.mandateId } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.status ? { status: query.status } : {})
    };
    const [items, total] = await Promise.all([
      this.prisma.debitAttempt.findMany({
        include: {
          bill: { select: { billNo: true, remainingAmount: true } },
          customer: { select: { customerNo: true, name: true } },
          mandate: { select: { mandateNo: true, providerMode: true } },
          order: { select: { orderNo: true } },
          paymentOrder: {
            select: {
              paymentOrderNo: true,
              paymentStatus: true,
              providerTransactionId: true
            }
          }
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      }),
      this.prisma.debitAttempt.count({ where })
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        confirmedAmount: item.confirmedAmount.toString(),
        requestedAmount: item.requestedAmount.toString(),
        bill: {
          ...item.bill,
          remainingAmount: item.bill.remainingAmount.toString()
        }
      })),
      page,
      pageSize,
      total
    };
  }

  async queryAttempt(
    id: string,
    dto: AutoDebitActionReasonDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const attempt = await this.prisma.debitAttempt.findUnique({ where: { id } });
    if (!attempt) {
      throw new NotFoundException("Debit attempt does not exist.");
    }
    if (attempt.status !== DebitAttemptStatus.UNKNOWN) {
      throw new BadRequestException("Only UNKNOWN debit attempts can be queried manually.");
    }
    const idempotencyKey = `debit-query:${attempt.id}`;
    const existing = await this.prisma.subscriptionAutomationJob.findFirst({
      where: { idempotencyKey }
    });
    const now = new Date();
    const job = existing
      ? await this.requeueQueryJob(existing.id, now)
      : await this.prisma.subscriptionAutomationJob.create({
          data: {
            availableAt: now,
            billId: attempt.billId,
            idempotencyKey,
            jobType: SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT,
            orderId: attempt.orderId,
            payload: { debitAttemptId: attempt.id }
          }
        });
    await this.writeAudit(
      "debit_attempt_query",
      attempt.id,
      { jobId: job.id, reason: dto.reason },
      user,
      context
    );
    return {
      action: "QUERY_QUEUED" as const,
      attemptId: attempt.id,
      jobId: job.id
    };
  }

  async requestManualDebit(
    billId: string,
    dto: AutoDebitActionReasonDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const job = await this.prisma.$transaction(async (tx) => {
      await lockBill(tx, billId);
      const bill = await tx.receivableBill.findUnique({ where: { id: billId } });
      if (
        !bill ||
        bill.deletedAt ||
        !OPEN_BILL_STATUSES.includes(bill.billStatus as (typeof OPEN_BILL_STATUSES)[number]) ||
        bill.remainingAmount <= 0n
      ) {
        throw new BadRequestException("Only an unpaid active bill can be debited manually.");
      }
      const mandate = await tx.paymentMandate.findFirst({
        where: {
          orderId: bill.orderId,
          status: PaymentMandateStatus.ACTIVE
        }
      });
      if (!mandate) {
        throw new BadRequestException("An ACTIVE payment mandate is required.");
      }
      const unresolved = await tx.debitAttempt.findFirst({
        where: {
          billId: bill.id,
          status: { in: [...UNRESOLVED_ATTEMPT_STATUSES] }
        }
      });
      if (unresolved) {
        throw new BadRequestException("The bill already has an unresolved debit attempt.");
      }
      const pendingJob = await tx.subscriptionAutomationJob.findFirst({
        where: {
          billId: bill.id,
          jobStatus: {
            in: [
              SubscriptionAutomationJobStatus.PENDING,
              SubscriptionAutomationJobStatus.PROCESSING
            ]
          },
          jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT
        }
      });
      if (pendingJob) {
        throw new BadRequestException("The bill already has a pending debit job.");
      }
      return tx.subscriptionAutomationJob.create({
        data: {
          billId: bill.id,
          idempotencyKey: `manual-debit:${bill.id}:${randomUUID()}`,
          jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
          orderId: bill.orderId,
          payload: {
            billId: bill.id,
            requestedBy: user.id,
            retrySlot: DebitRetrySlot.MANUAL
          }
        }
      });
    });
    await this.writeAudit(
      "manual_debit_job",
      job.id,
      { billId, reason: dto.reason, retrySlot: DebitRetrySlot.MANUAL },
      user,
      context
    );
    return {
      action: "DEBIT_QUEUED" as const,
      billId,
      jobId: job.id,
      retrySlot: DebitRetrySlot.MANUAL
    };
  }

  async cancelJob(
    id: string,
    dto: AutoDebitActionReasonDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.prisma.subscriptionAutomationJob.findUnique({
      where: { id }
    });
    if (!before) {
      throw new NotFoundException("Automation job does not exist.");
    }
    const now = new Date();
    const updated = await this.prisma.subscriptionAutomationJob.updateMany({
      data: {
        cancelledAt: now,
        completedAt: now,
        jobStatus: SubscriptionAutomationJobStatus.CANCELLED,
        lastErrorCode: "ADMIN_CANCELLED",
        lastErrorMessage: dto.reason,
        leaseExpiresAt: null,
        leaseToken: null
      },
      where: {
        id,
        jobStatus: SubscriptionAutomationJobStatus.PENDING
      }
    });
    if (updated.count !== 1) {
      throw new BadRequestException("Only a pending automation job can be cancelled.");
    }
    const job = await this.prisma.subscriptionAutomationJob.findUnique({
      where: { id }
    });
    await this.writeAudit(
      "subscription_automation_job",
      id,
      { jobStatus: job?.jobStatus, reason: dto.reason },
      user,
      context,
      before
    );
    return job;
  }

  async setMockNextResult(
    id: string,
    dto: SetMockDebitResultDto,
    user: RequestUser,
    context: RequestContext
  ) {
    if (
      this.config.environment === "production" ||
      !this.config.mockEnabled ||
      this.config.provider !== "mock" ||
      !(this.provider instanceof MockAutoDebitProvider)
    ) {
      throw new ServiceUnavailableException("Mock debit controls are only available in Staging mock mode.");
    }
    const attempt = await this.prisma.debitAttempt.findUnique({ where: { id } });
    if (!attempt) {
      throw new NotFoundException("Debit attempt does not exist.");
    }
    if (
      attempt.status !== DebitAttemptStatus.PROCESSING &&
      attempt.status !== DebitAttemptStatus.UNKNOWN
    ) {
      throw new BadRequestException("Only unresolved debit attempts accept a mock result.");
    }
    const snapshot = providerSnapshot(attempt.responseSnapshot ?? attempt.requestSnapshot);
    const responseSnapshot = this.provider.withNextDebitResult(
      snapshot,
      dto.nextResult
    );
    const updated = await this.prisma.debitAttempt.update({
      data: { responseSnapshot: toJson(responseSnapshot), updatedBy: user.id },
      where: { id: attempt.id }
    });
    await this.writeAudit(
      "debit_attempt_mock_result",
      attempt.id,
      { nextResult: dto.nextResult, reason: dto.reason },
      user,
      context,
      { status: attempt.status }
    );
    return {
      attemptId: updated.id,
      nextResult: dto.nextResult,
      status: updated.status
    };
  }

  private async requeueQueryJob(id: string, now: Date) {
    const current = await this.prisma.subscriptionAutomationJob.findUnique({
      where: { id }
    });
    if (current?.jobStatus === SubscriptionAutomationJobStatus.PROCESSING) {
      throw new BadRequestException("The provider query job is already processing.");
    }
    return this.prisma.subscriptionAutomationJob.update({
      data: {
        attemptCount: 0,
        availableAt: now,
        cancelledAt: null,
        completedAt: null,
        jobStatus: SubscriptionAutomationJobStatus.PENDING,
        lastErrorCode: null,
        lastErrorMessage: null,
        leaseExpiresAt: null,
        leaseToken: null,
        startedAt: null
      },
      where: { id }
    });
  }

  private writeAudit(
    entityType: string,
    entityId: string,
    after: unknown,
    user: RequestUser,
    context: RequestContext,
    before?: unknown
  ) {
    return this.audit.write({
      action: AuditAction.UPDATE,
      after,
      before,
      entityId,
      entityType,
      ipAddress: context.ipAddress,
      module: "auto_debit",
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }
}

async function lockBill(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  billId: string
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "receivable_bill" WHERE "id" = ${billId}::uuid FOR UPDATE
  `);
}

function providerSnapshot(value: Prisma.JsonValue | null): ProviderSnapshot {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new BadRequestException("Debit attempt provider snapshot is missing.");
  }
  return value as ProviderSnapshot;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
