import { BadRequestException } from "@nestjs/common";
import {
  BillingScheduleStatus,
  DebitAttemptStatus,
  PaymentMandateStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { validate } from "class-validator";
import { describe, expect, it, vi } from "vitest";

import {
  REQUIRED_ANY_PERMISSIONS_KEY,
  REQUIRED_PERMISSIONS_KEY
} from "../src/auth/auth.decorators";
import { STAGE1_AUTO_DEBIT_JOB_TYPES } from "../src/auto-debit/auto-debit.policy";
import { BillingAutomationAdminService } from "../src/billing-automation/billing-automation.admin.service";
import { BillingAutomationController } from "../src/billing-automation/billing-automation.controller";
import { PauseBillingScheduleDto } from "../src/billing-automation/billing-automation.dto";

describe("BillingAutomationController", () => {
  it("allows billing or auto-debit viewers to read summary while protecting billing detail", () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_ANY_PERMISSIONS_KEY,
        BillingAutomationController.prototype.summary
      )
    ).toEqual([PermissionCode.BILLING_VIEW, PermissionCode.AUTO_DEBIT_VIEW]);
    for (const handler of [
      BillingAutomationController.prototype.listSchedules,
      BillingAutomationController.prototype.listJobs
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        PermissionCode.BILLING_VIEW
      ]);
    }
  });

  it("uses billing generate permission for recovery actions", () => {
    for (const handler of [
      BillingAutomationController.prototype.reconcile,
      BillingAutomationController.prototype.pauseSchedule,
      BillingAutomationController.prototype.resumeSchedule,
      BillingAutomationController.prototype.retryJob
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        PermissionCode.BILLING_GENERATE
      ]);
    }
  });

  it("requires a non-empty pause reason", async () => {
    const dto = Object.assign(new PauseBillingScheduleDto(), {
      reason: "   "
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
  });

  it("rejects retry when the job is not in dead letter", async () => {
    const prisma = {
      subscriptionAutomationJob: {
        findUnique: vi.fn().mockResolvedValue({
          jobType: SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL
        })
      }
    };
    const repository = {
      retryDeadLetter: vi.fn().mockResolvedValue(false)
    };
    const service = new BillingAutomationAdminService(
      prisma as never,
      repository as never,
      {} as never,
      {} as never
    );

    await expect(
      service.retryJob("00000000-0000-4000-8000-000000000001", testUser(), {})
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects retrying a generation job while its source-fact schedule is paused", async () => {
    const prisma = {
      subscriptionAutomationJob: {
        findUnique: vi.fn().mockResolvedValue({
          billingSchedule: {
            pauseReason: "CONTRACT_SEGMENT_NOT_FOUND",
            status: BillingScheduleStatus.PAUSED
          },
          jobType: SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL
        })
      }
    };
    const repository = {
      retryDeadLetter: vi.fn().mockResolvedValue(true)
    };
    const service = new BillingAutomationAdminService(
      prisma as never,
      repository as never,
      {} as never,
      {} as never
    );

    await expect(
      service.retryJob("00000000-0000-4000-8000-000000000001", testUser(), {})
    ).rejects.toMatchObject({
      response: {
        code: "BILLING_SCHEDULE_SOURCE_FACT_BLOCKED"
      }
    });
    expect(repository.retryDeadLetter).not.toHaveBeenCalled();
  });

  it("rejects retrying a retired auto-debit dead letter", async () => {
    const prisma = {
      subscriptionAutomationJob: {
        findUnique: vi.fn().mockResolvedValue({
          jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT
        })
      }
    };
    const repository = {
      retryDeadLetter: vi.fn().mockResolvedValue(false)
    };
    const service = new BillingAutomationAdminService(
      prisma as never,
      repository as never,
      {} as never,
      {} as never
    );

    await expect(
      service.retryJob("00000000-0000-4000-8000-000000000001", testUser(), {})
    ).rejects.toMatchObject({
      response: {
        code: "AUTO_DEBIT_STAGE1_BASELINE_DISABLED"
      }
    });
    expect(repository.retryDeadLetter).not.toHaveBeenCalled();
  });

  it("rejects manually resuming a schedule that is paused by source-fact reconciliation", async () => {
    const updateMany = vi.fn();
    const prisma = {
      billingSchedule: {
        findUnique: vi.fn().mockResolvedValue({
          id: "00000000-0000-4000-8000-000000000003",
          pauseReason: "BILLING_PERIOD_CROSSES_SEGMENT",
          status: BillingScheduleStatus.PAUSED,
          version: 4
        }),
        updateMany
      }
    };
    const service = new BillingAutomationAdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(
      service.resumeSchedule("00000000-0000-4000-8000-000000000003", testUser(), {})
    ).rejects.toMatchObject({
      response: {
        code: "BILLING_SCHEDULE_SOURCE_FACT_BLOCKED"
      }
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("uses compare-and-swap when manually resuming an ordinary paused schedule", async () => {
    const before = {
      id: "00000000-0000-4000-8000-000000000003",
      pauseReason: "operator pause",
      status: BillingScheduleStatus.PAUSED,
      version: 4
    };
    const after = {
      ...before,
      pauseReason: null,
      status: BillingScheduleStatus.ACTIVE,
      version: 5
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      billingSchedule: {
        findUnique: vi.fn().mockResolvedValue(before),
        findUniqueOrThrow: vi.fn().mockResolvedValue(after),
        updateMany
      }
    };
    const auditService = { write: vi.fn().mockResolvedValue(undefined) };
    const service = new BillingAutomationAdminService(
      prisma as never,
      {} as never,
      {} as never,
      auditService as never
    );

    const result = await service.resumeSchedule(before.id, testUser(), {});

    expect(updateMany).toHaveBeenCalledWith({
      data: {
        pauseReason: null,
        status: BillingScheduleStatus.ACTIVE,
        version: { increment: 1 }
      },
      where: {
        id: before.id,
        status: BillingScheduleStatus.PAUSED,
        version: 4
      }
    });
    expect(result).toMatchObject({
      id: before.id,
      pauseReason: null,
      status: BillingScheduleStatus.ACTIVE
    });
    expect(auditService.write).toHaveBeenCalledOnce();
  });

  it("separates live billing metrics from historical auto-debit facts", async () => {
    const groupByJobs = vi.fn(async ({ where }) =>
      where?.jobType?.in
        ? [
            {
              _count: { _all: 1 },
              jobStatus: SubscriptionAutomationJobStatus.DEAD_LETTER
            }
          ]
        : [
            {
              _count: { _all: 2 },
              jobStatus: SubscriptionAutomationJobStatus.PENDING
            }
          ]
    );
    const findOldestJob = vi.fn().mockResolvedValue(null);
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ paymentCount: 2n, unallocatedAmount: 150n }]),
      billingSchedule: {
        findFirst: vi.fn().mockResolvedValue(null),
        groupBy: vi.fn().mockResolvedValue([])
      },
      debitAttempt: {
        groupBy: vi.fn().mockResolvedValue([
          {
            _count: { _all: 3 },
            status: DebitAttemptStatus.UNKNOWN
          }
        ])
      },
      paymentMandate: {
        groupBy: vi.fn().mockResolvedValue([
          {
            _count: { _all: 4 },
            status: PaymentMandateStatus.ACTIVE
          }
        ])
      },
      subscriptionAutomationJob: {
        findFirst: findOldestJob,
        groupBy: groupByJobs
      }
    };
    const service = new BillingAutomationAdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never
    );

    const result = await service.summary();

    expect(result).toMatchObject({
      collectionMode: "ACTIVE_PAYMENT_ONLY",
      historicalAutoDebit: {
        attempts: { UNKNOWN: 3 },
        jobs: { DEAD_LETTER: 1 },
        mandates: { ACTIVE: 4 },
        unknownCount: 3
      },
      jobs: { DEAD_LETTER: 0, PENDING: 2 },
      payments: {
        unallocated: { amount: "150", count: 2 }
      }
    });
    expect(result).not.toHaveProperty("autoDebit");
    expect(groupByJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          jobType: { notIn: [...STAGE1_AUTO_DEBIT_JOB_TYPES] }
        }
      })
    );
    expect(groupByJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          jobType: { in: [...STAGE1_AUTO_DEBIT_JOB_TYPES] }
        }
      })
    );
    expect(findOldestJob).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          jobStatus: SubscriptionAutomationJobStatus.PENDING,
          jobType: { notIn: [...STAGE1_AUTO_DEBIT_JOB_TYPES] }
        }
      })
    );
  });

  it("excludes retired jobs by default but permits an explicit historical query", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const prisma = {
      subscriptionAutomationJob: { count, findMany }
    };
    const service = new BillingAutomationAdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never
    );

    await service.listJobs({ page: 1, pageSize: 20 });
    await service.listJobs({
      jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
      page: 1,
      pageSize: 20
    });

    expect(findMany.mock.calls[0]?.[0].where).toMatchObject({
      jobType: { notIn: [...STAGE1_AUTO_DEBIT_JOB_TYPES] }
    });
    expect(count.mock.calls[0]?.[0].where).toMatchObject({
      jobType: { notIn: [...STAGE1_AUTO_DEBIT_JOB_TYPES] }
    });
    expect(findMany.mock.calls[1]?.[0].where).toMatchObject({
      jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT
    });
  });
});

function testUser() {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    menus: [],
    name: "Admin",
    permissions: [PermissionCode.BILLING_GENERATE],
    roles: ["ADMIN"],
    username: "admin"
  };
}
