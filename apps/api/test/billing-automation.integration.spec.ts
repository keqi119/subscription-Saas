import { ConfigService } from "@nestjs/config";
import {
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BillingAutomationRepository } from "../src/billing-automation/billing-automation.repository";
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
    const indexes = await prisma.$queryRaw<
      Array<{ indexdef: string; indexname: string }>
    >`
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
    expect(indexes[0]?.indexdef).toContain(
      "WHERE (deleted_at IS NULL)"
    );
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
        jobType:
          SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL
      });

      await expect(
        repository.claimDue(1, 120_000, [
          SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL
        ])
      ).resolves.toEqual([]);
    } finally {
      await prisma.subscriptionAutomationJob.deleteMany({
        where: { billingScheduleId: scheduleId }
      });
      await prisma.billingSchedule.delete({ where: { id: scheduleId } });
    }
  });
});
