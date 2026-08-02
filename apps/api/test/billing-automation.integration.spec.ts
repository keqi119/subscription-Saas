import { ConfigService } from "@nestjs/config";
import {
  BillStatus,
  BillType,
  OrderMileageReviewStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  billingSourceKey,
  buildBillingCycleForDelivery
} from "../src/billing-automation/billing-automation.calendar";
import { BillingAutomationRepository } from "../src/billing-automation/billing-automation.repository";
import { BillingAutomationService } from "../src/billing-automation/billing-automation.service";
import { buildMileageReviewCycle } from "../src/mileage-review/mileage-review.calendar";
import { PrismaService } from "../src/prisma/prisma.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:5432/subscription_saas?schema=public";
const KEY_PREFIX = "billing-automation-integration:";

describe("BillingAutomationRepository PostgreSQL integration", () => {
  let prisma: PrismaService;
  let repository: BillingAutomationRepository;

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({
        DATABASE_POOL_MAX: "5",
        DATABASE_URL: TEST_DATABASE_URL
      })
    );
    await prisma.onModuleInit();
    repository = new BillingAutomationRepository(prisma);
  });

  beforeEach(async () => {
    await prisma.subscriptionAutomationJob.deleteMany({
      where: { idempotencyKey: { startsWith: KEY_PREFIX } }
    });
  });

  afterAll(async () => {
    await prisma.subscriptionAutomationJob.deleteMany({
      where: { idempotencyKey: { startsWith: KEY_PREFIX } }
    });
    await prisma.onModuleDestroy();
  });

  it("leases a due job while joining an optional billing schedule", async () => {
    const job = await repository.enqueue(prisma, {
      availableAt: new Date("2026-01-01T00:00:00.000Z"),
      idempotencyKey: `${KEY_PREFIX}claim-left-join`,
      jobType: SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE
    });

    const claimed = await repository.claimDue(1, 120_000, [
      SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE
    ]);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: job.id });
  });

  it("defers a paused job without consuming a retry attempt", async () => {
    const job = await repository.enqueue(prisma, {
      availableAt: new Date("2026-01-01T00:00:00.000Z"),
      idempotencyKey: `${KEY_PREFIX}defer-paused`,
      jobType: SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE
    });
    const [claimed] = await repository.claimDue(1, 120_000, [
      SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE
    ]);

    await expect(
      repository.defer(job.id, claimed!.leaseToken, {
        code: "BILLING_SCHEDULE_PAUSED",
        message: "Billing schedule is paused.",
        retryable: true
      })
    ).resolves.toBe(true);

    await expect(
      prisma.subscriptionAutomationJob.findUniqueOrThrow({
        where: { id: job.id }
      })
    ).resolves.toMatchObject({
      attemptCount: 0,
      jobStatus: SubscriptionAutomationJobStatus.PENDING,
      lastErrorCode: "BILLING_SCHEDULE_PAUSED",
      leaseExpiresAt: null,
      leaseToken: null
    });
  });

  it("installs database uniqueness for active collection cases and bill links", async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string; indexname: string }>>`
      SELECT "indexdef", "indexname"
      FROM "pg_indexes"
      WHERE "schemaname" = 'public'
        AND "indexname" IN (
          'collection_case_one_active_per_order_key',
          'collection_case_bill_case_id_bill_id_key'
        )
      ORDER BY "indexname"
    `;

    expect(indexes.map((index) => index.indexname)).toEqual([
      "collection_case_bill_case_id_bill_id_key",
      "collection_case_one_active_per_order_key"
    ]);
    expect(indexes[0]?.indexdef).toContain("WHERE (deleted_at IS NULL)");
    expect(indexes[1]?.indexdef).toContain(
      "WHERE ((case_status = 'ACTIVE'::collection_case_status) AND (deleted_at IS NULL))"
    );
  });

  it("does not lease a generation job while its schedule is paused", async () => {
    const scheduleId = randomUUID();
    const orderId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`
        INSERT INTO "billing_schedule" (
          "id",
          "order_id",
          "status",
          "next_cycle_no",
          "next_period_start",
          "next_period_end",
          "next_generate_at",
          "created_at",
          "updated_at"
        )
        VALUES (
          ${scheduleId}::uuid,
          ${orderId}::uuid,
          'PAUSED',
          1,
          DATE '2026-01-01',
          DATE '2026-01-31',
          TIMESTAMPTZ '2025-12-29T00:00:00Z',
          clock_timestamp(),
          clock_timestamp()
        )
      `;
    });
    try {
      await repository.enqueue(prisma, {
        availableAt: new Date("2025-12-29T00:00:00.000Z"),
        billingScheduleId: scheduleId,
        idempotencyKey: `${KEY_PREFIX}paused-schedule`,
        jobType: SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL
      });

      await expect(
        repository.claimDue(1, 120_000, [SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL])
      ).resolves.toEqual([]);
    } finally {
      await prisma.subscriptionAutomationJob.deleteMany({
        where: { billingScheduleId: scheduleId }
      });
      await prisma.billingSchedule.delete({ where: { id: scheduleId } });
    }
  });

  it.each([
    ["pending submission", OrderMileageReviewStatus.PENDING_SUBMISSION, false],
    ["overdue submission", OrderMileageReviewStatus.PENDING_SUBMISSION, true],
    ["returned", OrderMileageReviewStatus.RETURNED, false],
    ["pending review", OrderMileageReviewStatus.PENDING_REVIEW, false]
  ])(
    "generates fixed monthly rent exactly once while mileage review is %s",
    async (_label, reviewStatus, overdue) => {
      const ids = {
        application: randomUUID(),
        customer: randomUUID(),
        order: randomUUID(),
        quote: randomUUID(),
        review: randomUUID(),
        schedule: randomUUID(),
        vehicle: randomUUID()
      };
      const actualDeliveryAt = new Date("2026-07-10T02:00:00.000Z");
      const cycle = buildBillingCycleForDelivery(actualDeliveryAt, 1);
      const reviewCycle = buildMileageReviewCycle({
        actualDeliveryAt,
        cycleNo: 1
      });
      const hasSubmission =
        reviewStatus === OrderMileageReviewStatus.RETURNED ||
        reviewStatus === OrderMileageReviewStatus.PENDING_REVIEW;
      const sourceKey = billingSourceKey(ids.order, cycle.periodStart);
      const finance = {
        generateMonthlyRentBillForCycle: vi.fn(
          async (
            tx: PrismaService,
            input: {
              orderId: string;
              periodEnd: Date;
              periodStart: Date;
              sourceKey: string;
            }
          ) => {
            const bill = await tx.receivableBill.upsert({
              create: {
                amount: 300_000n,
                billNo: `BILINT${randomUUID().replaceAll("-", "").slice(0, 20)}`,
                billPeriodEnd: input.periodEnd,
                billPeriodStart: input.periodStart,
                billStatus: BillStatus.PENDING,
                billType: BillType.MONTHLY_RENT,
                customerId: ids.customer,
                dueDate: input.periodStart,
                orderId: input.orderId,
                paidAmount: 0n,
                remainingAmount: 300_000n,
                sourceKey: input.sourceKey
              },
              update: {},
              where: { sourceKey: input.sourceKey }
            });
            return { bill, created: true };
          }
        )
      };
      const enqueue = vi.fn(async () => ({ id: randomUUID() }));
      const service = new BillingAutomationService(
        prisma,
        { enqueue } as never,
        finance as never,
        () => cycle.generateAt
      );

      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          await tx.$executeRaw`
            INSERT INTO "customer" (
              "id", "customer_no", "name", "mobile", "status", "created_at", "updated_at"
            ) VALUES (
              ${ids.customer}::uuid,
              ${`CUSINT${ids.customer.replaceAll("-", "").slice(0, 18)}`},
              'Billing integration',
              ${`139${ids.customer.replaceAll("-", "").slice(0, 8)}`},
              'ACTIVE',
              clock_timestamp(),
              clock_timestamp()
            )
          `;
          await tx.$executeRaw`
            INSERT INTO "subscription_order" (
              "id", "order_no", "customer_id", "application_id", "quote_id",
              "vehicle_id", "product_id", "product_version_id",
              "vehicle_purchase_price_amount", "monthly_fee_amount", "deposit_amount",
              "period_months", "mileage_limit_km", "over_mileage_fee_amount",
              "model_definition_id_snapshot", "model_code_snapshot",
              "model_display_name_snapshot", "quote_snapshot", "order_status",
              "actual_delivery_at", "created_at", "updated_at"
            ) VALUES (
              ${ids.order}::uuid,
              ${`ORDINT${ids.order.replaceAll("-", "").slice(0, 20)}`},
              ${ids.customer}::uuid,
              ${ids.application}::uuid,
              ${ids.quote}::uuid,
              ${ids.vehicle}::uuid,
              ${randomUUID()}::uuid,
              ${randomUUID()}::uuid,
              20000000,
              300000,
              100000,
              12,
              1500,
              100,
              ${randomUUID()}::uuid,
              'NIO_ET5_2024',
              'NIO ET5',
              '{}'::jsonb,
              'ACTIVE',
              ${actualDeliveryAt},
              clock_timestamp(),
              clock_timestamp()
            )
          `;
          await tx.$executeRaw`
            INSERT INTO "lease" (
              "id", "order_id", "status", "activated_at", "created_at", "updated_at"
            ) VALUES (
              ${randomUUID()}::uuid,
              ${ids.order}::uuid,
              'ACTIVE',
              ${actualDeliveryAt},
              clock_timestamp(),
              clock_timestamp()
            )
          `;
          await tx.$executeRaw`
            INSERT INTO "billing_schedule" (
              "id", "order_id", "status", "timezone", "next_cycle_no",
              "next_period_start", "next_period_end", "next_generate_at",
              "version", "created_at", "updated_at"
            ) VALUES (
              ${ids.schedule}::uuid,
              ${ids.order}::uuid,
              'ACTIVE',
              'Asia/Shanghai',
              ${cycle.cycleNo},
              ${cycle.periodStart}::date,
              ${cycle.periodEnd}::date,
              ${cycle.generateAt},
              0,
              clock_timestamp(),
              clock_timestamp()
            )
          `;
          await tx.$executeRaw`
            INSERT INTO "order_mileage_review" (
              "id", "order_id", "vehicle_id", "cycle_no", "version",
              "period_start", "period_end", "scheduled_review_at", "due_at",
              "status", "baseline_reading_id", "baseline_mileage_km",
              "submitted_mileage_km", "reading_at", "submission_source",
              "submitted_by_customer_id", "submitted_at",
              "lock_version", "created_at", "updated_at"
            ) VALUES (
              ${ids.review}::uuid,
              ${ids.order}::uuid,
              ${ids.vehicle}::uuid,
              1,
              1,
              ${reviewCycle.periodStart},
              ${reviewCycle.periodEnd},
              ${reviewCycle.scheduledReviewAt},
              ${overdue ? reviewCycle.dueAt : new Date("2027-08-01T00:00:00.000Z")},
              ${reviewStatus}::order_mileage_review_status,
              ${randomUUID()}::uuid,
              1000,
              ${hasSubmission ? 1250 : null},
              ${hasSubmission ? reviewCycle.scheduledReviewAt : null},
              ${hasSubmission ? "PORTAL" : null}::mileage_review_submission_source,
              ${hasSubmission ? ids.customer : null}::uuid,
              ${hasSubmission ? reviewCycle.scheduledReviewAt : null},
              0,
              clock_timestamp(),
              clock_timestamp()
            )
          `;
        });

        const result = await service.generateScheduledMonthlyRent({
          attemptCount: 0,
          availableAt: cycle.generateAt,
          billId: null,
          billingScheduleId: ids.schedule,
          cancelledAt: null,
          completedAt: null,
          createdAt: cycle.generateAt,
          id: randomUUID(),
          idempotencyKey: sourceKey,
          jobStatus: SubscriptionAutomationJobStatus.PROCESSING,
          jobType: SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
          lastErrorCode: null,
          lastErrorMessage: null,
          leaseExpiresAt: new Date(cycle.generateAt.getTime() + 120_000),
          leaseToken: randomUUID(),
          maxAttempts: 6,
          orderId: ids.order,
          payload: null,
          resultSnapshot: null,
          startedAt: cycle.generateAt,
          updatedAt: cycle.generateAt
        });

        expect(result).toMatchObject({ created: true, sourceKey });
        await expect(
          prisma.receivableBill.count({
            where: {
              billType: BillType.MONTHLY_RENT,
              orderId: ids.order,
              sourceKey
            }
          })
        ).resolves.toBe(1);
        expect(finance.generateMonthlyRentBillForCycle).toHaveBeenCalledTimes(1);
      } finally {
        const bills = await prisma.receivableBill
          .findMany({
            select: { id: true },
            where: { orderId: ids.order }
          })
          .catch(() => []);
        const entityIds = [ids.order, ids.review, ids.schedule, ...bills.map((bill) => bill.id)];
        await prisma.subscriptionAutomationJob.deleteMany({ where: { orderId: ids.order } });
        await prisma.billingSchedule.deleteMany({ where: { orderId: ids.order } });
        await prisma.orderMileageReview.deleteMany({ where: { orderId: ids.order } });
        await prisma.lease.deleteMany({ where: { orderId: ids.order } });
        await prisma.receivableBill.deleteMany({ where: { orderId: ids.order } });
        await prisma.auditLog.deleteMany({ where: { entityId: { in: entityIds } } });
        await prisma.subscriptionOrder.deleteMany({ where: { id: ids.order } });
        await prisma.customer.deleteMany({ where: { id: ids.customer } });
      }
    }
  );
});
