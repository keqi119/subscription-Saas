import { ConfigService } from "@nestjs/config";
import {
  ContractSegmentStatus,
  ESignDocumentType,
  ESignProviderType,
  ESignSigningStage,
  ESignTaskStatus,
  LeaseStatus,
  OrderStatus,
  Prisma,
  SubscriptionAutomationJobStatus,
  SubscriptionChangeStatus,
  VehicleReturnStatus,
  VehicleStatus
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { Stage3ExtensionArchiveService } from "../src/esign/stage3-extension-archive.service";
import { buildReturnEligibility } from "../src/order/order.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { SubscriptionExpiryService } from "../src/subscription-change/subscription-expiry.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:55432/subscription_saas_codex?schema=public";

describe("subscription expiry to normal return integration boundary", () => {
  it("allows a PENDING_RETURN order with its leased vehicle to prepare and confirm the normal return", () => {
    expect(
      buildReturnEligibility({
        actualDeliveryAt: new Date("2026-08-02T11:03:00.000Z"),
        actualReturnAt: null,
        orderStatus: OrderStatus.PENDING_RETURN,
        vehicle: { deletedAt: null, id: "vehicle-1", status: VehicleStatus.LEASED },
        vehicleId: "vehicle-1"
      }, {
        returnStatus: VehicleReturnStatus.PENDING,
        returnedAt: null
      })
    ).toMatchObject({
      canConfirmReturn: false,
      canPrepareReturn: true
    });
  });
});

describe("SubscriptionExpiryService PostgreSQL concurrency", () => {
  let prisma: PrismaService;
  let service: SubscriptionExpiryService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
    service = new SubscriptionExpiryService(
      prisma,
      {
        notifyRenewalExpiryInApp: vi.fn(async () => ({ created: true })),
        notifyRenewalReturnOverdueInApp: vi.fn(async () => ({ created: true }))
      } as never,
      new AuditService(prisma)
    );
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("converges duplicate workers on one return while preserving the earned rent job", async () => {
    const fixture = await createExpiryFixture(prisma);
    try {
      const attempts = await Promise.allSettled([
        service.expireSegment(fixture.segmentId, new Date("2026-09-02T16:00:00.000Z")),
        service.expireSegment(fixture.segmentId, new Date("2026-09-02T16:00:00.000Z"))
      ]);
      for (const attempt of attempts) {
        if (attempt.status === "rejected") {
          await service.expireSegment(
            fixture.segmentId,
            new Date("2026-09-02T16:00:00.000Z")
          );
        }
      }

      await expect(prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })).resolves.toBe(1);
      await expect(prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } })).resolves.toMatchObject({
        orderStatus: OrderStatus.PENDING_RETURN
      });
      await expect(prisma.lease.findUniqueOrThrow({ where: { orderId: fixture.orderId } })).resolves.toMatchObject({
        status: LeaseStatus.RETURN_DUE
      });
      await expect(prisma.subscriptionContractSegment.findUniqueOrThrow({ where: { id: fixture.segmentId } })).resolves.toMatchObject({
        status: ContractSegmentStatus.COMPLETED
      });
      await expect(prisma.billingSchedule.findUniqueOrThrow({ where: { orderId: fixture.orderId } })).resolves.toMatchObject({
        status: "ACTIVE"
      });
      await expect(prisma.subscriptionAutomationJob.findUniqueOrThrow({ where: { id: fixture.earnedJobId } })).resolves.toMatchObject({
        jobStatus: SubscriptionAutomationJobStatus.PENDING
      });
      await expect(prisma.subscriptionAutomationJob.findUniqueOrThrow({ where: { id: fixture.futureJobId } })).resolves.toMatchObject({
        jobStatus: SubscriptionAutomationJobStatus.CANCELLED
      });
    } finally {
      await cleanupExpiryFixture(
        prisma,
        fixture.orderId,
        fixture.segmentId,
        fixture.customerId,
        fixture.vehicleId
      );
    }
  });

  it("lets a committed archive win while the expiry worker is waiting on the same rows", async () => {
    const fixture = await createRaceFixture(prisma);
    const barrier = createBarrier();
    const archiveService = new Stage3ExtensionArchiveService(
      hookTransaction(prisma, "subscriptionContractSegment", "create", barrier),
      new AuditService(prisma)
    );
    try {
      const archivePromise = archiveService.finalizeArchivedContract({
        completedAt: new Date("2026-09-02T15:59:00.000Z"),
        contractId: fixture.contractId,
        source: "CALLBACK",
        taskId: fixture.taskId
      });
      await barrier.entered;
      const expiryPromise = service.expireSegment(
        fixture.segmentId,
        new Date("2026-09-02T16:00:00.000Z")
      );
      await shortTurn();
      barrier.release();

      const [archiveResult, expiryResult] = await Promise.allSettled([
        archivePromise,
        expiryPromise
      ]);
      if (archiveResult.status === "rejected") throw archiveResult.reason;
      if (expiryResult.status === "rejected") throw expiryResult.reason;
      expect(archiveResult).toMatchObject({
        status: "fulfilled",
        value: { outcome: "SCHEDULED" }
      });
      expect(expiryResult).toEqual({
        status: "fulfilled",
        value: { outcome: "EXTENDED" }
      });
      await expect(prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } })).resolves.toMatchObject({
        orderStatus: OrderStatus.ACTIVE
      });
      await expect(prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: fixture.changeId } })).resolves.toMatchObject({
        status: SubscriptionChangeStatus.SCHEDULED
      });
      await expect(prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })).resolves.toBe(0);
      await expect(prisma.subscriptionContractSegment.count({ where: { orderId: fixture.orderId } })).resolves.toBe(2);
    } finally {
      barrier.release();
      await cleanupExpiryFixture(prisma, fixture.orderId, fixture.segmentId, fixture.customerId, fixture.vehicleId);
    }
  });

  it("records late evidence only when expiry commits before the archive callback", async () => {
    const fixture = await createRaceFixture(prisma);
    const barrier = createBarrier();
    const expiryService = new SubscriptionExpiryService(
      hookTransaction(prisma, "vehicleReturn", "create", barrier),
      {
        notifyRenewalExpiryInApp: vi.fn(async () => ({ created: true })),
        notifyRenewalReturnOverdueInApp: vi.fn(async () => ({ created: true }))
      } as never,
      new AuditService(prisma)
    );
    const archiveService = new Stage3ExtensionArchiveService(prisma, new AuditService(prisma));
    try {
      const expiryPromise = expiryService.expireSegment(
        fixture.segmentId,
        new Date("2026-09-02T16:00:00.000Z")
      );
      await barrier.entered;
      const archivePromise = archiveService.finalizeArchivedContract({
        completedAt: new Date("2026-09-02T15:59:00.000Z"),
        contractId: fixture.contractId,
        source: "CALLBACK",
        taskId: fixture.taskId
      });
      await shortTurn();
      barrier.release();

      const [expiryResult, archiveResult] = await Promise.allSettled([
        expiryPromise,
        archivePromise
      ]);
      expect(expiryResult).toMatchObject({
        status: "fulfilled",
        value: { outcome: "EXPIRED" }
      });
      expect(archiveResult).toEqual({
        status: "fulfilled",
        value: { outcome: "LATE_EVIDENCE_ONLY" }
      });
      await expect(prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } })).resolves.toMatchObject({
        orderStatus: OrderStatus.PENDING_RETURN
      });
      await expect(prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: fixture.changeId } })).resolves.toMatchObject({
        failureCode: "EXTENSION_DEADLINE_MISSED",
        status: SubscriptionChangeStatus.FAILED
      });
      await expect(prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })).resolves.toBe(1);
      await expect(prisma.subscriptionContractSegment.count({ where: { orderId: fixture.orderId } })).resolves.toBe(1);
    } finally {
      barrier.release();
      await cleanupExpiryFixture(prisma, fixture.orderId, fixture.segmentId, fixture.customerId, fixture.vehicleId);
    }
  });
});

async function createRaceFixture(prisma: PrismaService) {
  const fixture = await createExpiryFixture(prisma);
  const changeId = randomUUID();
  const considerationId = randomUUID();
  const contractId = randomUUID();
  const quoteId = randomUUID();
  const taskId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "contract" (
        "id", "contract_no", "order_id", "customer_id", "business_type", "contract_version_id",
        "contract_title", "contract_snapshot", "status", "created_at", "updated_at"
      ) VALUES (${contractId}::uuid, ${`CONRACE${contractId.replaceAll("-", "").slice(0, 18)}`}, ${fixture.orderId}::uuid, ${fixture.customerId}::uuid, 'SUBSCRIPTION', ${randomUUID()}::uuid, 'Extension agreement', '{}'::jsonb, 'SIGNED', clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "renewal_consideration" (
        "id", "consideration_no", "order_id", "segment_id", "status", "consideration_start_at", "completion_deadline_at", "created_at", "updated_at"
      ) VALUES (${considerationId}::uuid, ${`RCNRACE${considerationId.replaceAll("-", "").slice(0, 18)}`}, ${fixture.orderId}::uuid, ${fixture.segmentId}::uuid, 'EXTENSION_IN_PROGRESS', '2026-08-03T00:00:00Z'::timestamptz, '2026-09-02T16:00:00Z'::timestamptz, clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_change_order" (
        "id", "change_no", "order_id", "status", "source_segment_id", "renewal_consideration_id",
        "extension_months", "pricing_mode", "contract_id", "target_start_date", "target_end_date",
        "completion_deadline_at", "created_at", "updated_at"
      ) VALUES (${changeId}::uuid, ${`CHGRACE${changeId.replaceAll("-", "").slice(0, 18)}`}, ${fixture.orderId}::uuid, 'SIGNING_OR_PAYMENT', ${fixture.segmentId}::uuid, ${considerationId}::uuid, 6, 'CURRENT_VERSION', ${contractId}::uuid, '2026-09-03'::date, '2027-03-02'::date, '2026-09-02T16:00:00Z'::timestamptz, clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_change_quote" (
        "id", "quote_no", "change_order_id", "revision", "status", "pricing_mode", "monthly_fee_amount",
        "deposit_amount", "mileage_limit_km", "over_mileage_fee_amount", "plan_snapshot", "price_rule_snapshot",
        "quote_snapshot", "valid_until", "formalized_at", "confirmed_at", "created_at"
      ) VALUES (${quoteId}::uuid, ${`QUORACE${quoteId.replaceAll("-", "").slice(0, 18)}`}, ${changeId}::uuid, 1, 'CUSTOMER_CONFIRMED', 'CURRENT_VERSION', 100, 0, 1500, 100, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '2026-09-02T16:00:00Z'::timestamptz, clock_timestamp(), clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_change_order" SET "current_quote_id" = ${quoteId}::uuid, "confirmed_quote_id" = ${quoteId}::uuid WHERE "id" = ${changeId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "renewal_consideration" SET "change_order_id" = ${changeId}::uuid WHERE "id" = ${considerationId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "contract_esign_task" (
        "id", "task_no", "contract_id", "order_id", "customer_id", "provider", "signing_stage",
        "document_type", "task_status", "signed_document_object_key", "completed_at", "created_at", "updated_at"
      ) VALUES (${taskId}::uuid, ${`ESGRACE${taskId.replaceAll("-", "").slice(0, 18)}`}, ${contractId}::uuid, ${fixture.orderId}::uuid, ${fixture.customerId}::uuid, ${ESignProviderType.MOCK}::esign_provider_type, ${ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION}::esign_signing_stage, ${ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT}::esign_document_type, ${ESignTaskStatus.COMPLETED}::esign_task_status, 'signed/race.pdf', '2026-09-02T15:59:00Z'::timestamptz, clock_timestamp(), clock_timestamp())
    `);
  });
  return { ...fixture, changeId, considerationId, contractId, quoteId, taskId };
}

async function createExpiryFixture(prisma: PrismaService) {
  const customerId = randomUUID();
  const earnedJobId = randomUUID();
  const futureJobId = randomUUID();
  const orderId = randomUUID();
  const scheduleId = randomUUID();
  const segmentId = randomUUID();
  const vehicleId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "customer" ("id", "customer_no", "name", "mobile", "status", "created_at", "updated_at")
      VALUES (${customerId}::uuid, ${`CUSTEXP${customerId.replaceAll("-", "").slice(0, 18)}`}, 'Expiry Integration', '13800000000', 'ACTIVE', clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle" ("id", "vehicle_no", "plate_no", "brand", "model_definition_id", "purchase_price_amount", "status", "created_at", "updated_at")
      VALUES (${vehicleId}::uuid, ${`VEHEXP${vehicleId.replaceAll("-", "").slice(0, 18)}`}, ${`沪E${vehicleId.replaceAll("-", "").slice(0, 5)}`}, 'NIO', ${randomUUID()}::uuid, 20000000, 'LEASED', clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_order" (
        "id", "order_no", "customer_id", "application_id", "quote_id", "vehicle_id",
        "product_id", "product_version_id", "vehicle_purchase_price_amount", "monthly_fee_amount",
        "deposit_amount", "period_months", "mileage_limit_km", "over_mileage_fee_amount",
        "model_definition_id_snapshot", "model_code_snapshot", "model_display_name_snapshot",
        "quote_snapshot", "final_plan_snapshot", "order_status", "start_date", "end_date",
        "actual_delivery_at", "created_at", "updated_at"
      ) VALUES (
        ${orderId}::uuid, ${`ORDEXP${orderId.replaceAll("-", "").slice(0, 20)}`}, ${customerId}::uuid,
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${vehicleId}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, 20000000, 100, 0, 6, 1500, 100, ${randomUUID()}::uuid,
        'NIO_ET5_2024', 'NIO ET5', '{}'::jsonb, '{}'::jsonb, 'ACTIVE', '2026-03-03'::date,
        '2026-09-02'::date, '2026-03-03T02:00:00Z'::timestamptz, clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "lease" ("id", "order_id", "status", "activated_at", "created_at", "updated_at")
      VALUES (${randomUUID()}::uuid, ${orderId}::uuid, 'ACTIVE', '2026-03-03T02:00:00Z'::timestamptz, clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_schedule" (
        "id", "order_id", "status", "next_cycle_no", "next_period_start", "next_period_end", "next_generate_at", "created_at", "updated_at"
      ) VALUES (${scheduleId}::uuid, ${orderId}::uuid, 'ACTIVE', 6, '2026-08-03'::date, '2026-09-02'::date, '2026-08-01T01:00:00Z'::timestamptz, clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_contract_segment" (
        "id", "segment_no", "order_id", "segment_type", "sequence_no", "status", "start_date", "end_date",
        "monthly_fee_amount", "mileage_limit_km", "over_mileage_fee_amount", "plan_snapshot", "quote_snapshot", "contract_snapshot", "activated_at", "created_at"
      ) VALUES (${segmentId}::uuid, ${`SEGEXP${segmentId.replaceAll("-", "").slice(0, 20)}`}, ${orderId}::uuid, 'BASE', 1, 'ACTIVE', '2026-03-03'::date, '2026-09-02'::date, 100, 1500, 100, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '2026-03-03T02:00:00Z'::timestamptz, clock_timestamp())
    `);
    for (const job of [
      { id: earnedJobId, periodStart: "2026-08-03" },
      { id: futureJobId, periodStart: "2026-10-03" }
    ]) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "subscription_automation_job" (
          "id", "billing_schedule_id", "order_id", "job_type", "job_status", "idempotency_key", "available_at", "payload", "created_at", "updated_at"
        ) VALUES (${job.id}::uuid, ${scheduleId}::uuid, ${orderId}::uuid, 'GENERATE_MONTHLY_RENT_BILL', 'PENDING', ${`expiry-integration:${job.id}`}, clock_timestamp(), ${JSON.stringify({ periodStart: job.periodStart })}::jsonb, clock_timestamp(), clock_timestamp())
      `);
    }
  });
  return { customerId, earnedJobId, futureJobId, orderId, segmentId, vehicleId };
}

function createBarrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { enter, entered, release, released };
}

function hookTransaction(
  prisma: PrismaService,
  model: string,
  method: string,
  barrier: ReturnType<typeof createBarrier>
) {
  let invoked = false;
  return {
    $transaction: (
      operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel }
    ) => prisma.$transaction(async (tx) => {
      const hooked = new Proxy(tx, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== model || !value || typeof value !== "object") return value;
          return new Proxy(value, {
            get(delegate, delegateProperty, delegateReceiver) {
              const delegateValue = Reflect.get(delegate, delegateProperty, delegateReceiver);
              if (delegateProperty !== method || typeof delegateValue !== "function") {
                return typeof delegateValue === "function" ? delegateValue.bind(delegate) : delegateValue;
              }
              return async (...args: unknown[]) => {
                if (!invoked) {
                  invoked = true;
                  barrier.enter();
                  await barrier.released;
                }
                return delegateValue.apply(delegate, args);
              };
            }
          });
        }
      });
      return operation(hooked);
    }, options)
  } as PrismaService;
}

async function shortTurn() {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

async function cleanupExpiryFixture(
  prisma: PrismaService,
  orderId: string,
  segmentId: string,
  customerId: string,
  vehicleId: string
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "audit_log"
      WHERE "entity_id" IN (${orderId}::uuid, ${segmentId}::uuid)
         OR "entity_id" IN (
        SELECT "id" FROM "subscription_contract_segment" WHERE "order_id" = ${orderId}::uuid
        UNION
        SELECT "id" FROM "subscription_change_order" WHERE "order_id" = ${orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "contract_esign_task" WHERE "order_id" = ${orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "renewal_reminder" WHERE "renewal_consideration_id" IN (
        SELECT "id" FROM "renewal_consideration" WHERE "order_id" = ${orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_change_quote" WHERE "change_order_id" IN (
        SELECT "id" FROM "subscription_change_order" WHERE "order_id" = ${orderId}::uuid
      )
    `);
    for (const table of [
      "vehicle_return",
      "subscription_automation_job",
      "renewal_consideration",
      "subscription_change_order",
      "subscription_contract_segment",
      "order_entitlement_account",
      "billing_schedule",
      "lease",
      "subscription_order"
    ]) {
      const column = table === "subscription_order" ? "id" : "order_id";
      if (table === "subscription_contract_segment" || table === "billing_schedule" || table === "lease" || table === "vehicle_return" || table === "subscription_automation_job" || table === "renewal_consideration" || table === "subscription_change_order" || table === "order_entitlement_account" || table === "subscription_order") {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${column}" = $1::uuid`, orderId);
      }
    }
    await tx.$executeRaw(Prisma.sql`DELETE FROM "contract" WHERE "order_id" = ${orderId}::uuid`);
    await tx.$executeRaw(Prisma.sql`DELETE FROM "vehicle" WHERE "id" = ${vehicleId}::uuid`);
    await tx.$executeRaw(Prisma.sql`DELETE FROM "customer" WHERE "id" = ${customerId}::uuid`);
  });
}
