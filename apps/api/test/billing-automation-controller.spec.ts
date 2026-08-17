import { BadRequestException } from "@nestjs/common";
import {
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

  it("includes mandate, attempt, dead-letter, and unallocated-payment metrics", async () => {
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
        findFirst: vi.fn().mockResolvedValue(null),
        groupBy: vi.fn().mockResolvedValue([
          {
            _count: { _all: 1 },
            jobStatus: SubscriptionAutomationJobStatus.DEAD_LETTER
          }
        ])
      }
    };
    const service = new BillingAutomationAdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(service.summary()).resolves.toMatchObject({
      autoDebit: {
        attempts: { UNKNOWN: 3 },
        deadLetterCount: 1,
        mandates: { ACTIVE: 4 },
        unallocatedPayments: { amount: "150", count: 2 },
        unknownCount: 3
      }
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
