import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  Prisma,
  RenewalConsiderationStatus,
  RenewalDecision,
  SubscriptionChangePricingMode,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { PortalRenewalService } from "../src/portal/portal-renewal.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ContractSegmentService } from "../src/subscription-change/contract-segment.service";
import { SubscriptionChangeRepository } from "../src/subscription-change/subscription-change.repository";
import { SubscriptionExtensionPricingService } from "../src/subscription-change/subscription-extension-pricing.service";
import { SubscriptionExtensionService } from "../src/subscription-change/subscription-extension.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:55432/subscription_saas_codex?schema=public";

describe("SubscriptionExtensionService PostgreSQL integration", () => {
  let prisma: PrismaService;
  let repository: SubscriptionChangeRepository;
  let segmentService: ContractSegmentService;
  let service: SubscriptionExtensionService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
    segmentService = new ContractSegmentService(prisma);
    repository = new SubscriptionChangeRepository(prisma);
    service = new SubscriptionExtensionService(
      prisma,
      new AuditService(prisma),
      segmentService,
      new SubscriptionExtensionPricingService(prisma),
      {
        enabled: true,
        now: () => new Date("2026-08-05T04:00:00.000Z"),
        quoteValidityHours: 72
      },
      repository
    );
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("persists an ORIGINAL_PRICE extension, append-only quote and idempotent command result", async () => {
    const fixture = await createFixture(prisma);
    const approverId = randomUUID();
    await prisma.user.create({
      data: {
        id: approverId,
        name: "Integration Price Approver",
        passwordHash: "not-used-by-test",
        username: `extension-approver-${approverId}`
      }
    });
    const actor = {
      id: randomUUID(),
      menus: [],
      name: "Integration Operator",
      permissions: [
        PermissionCode.SUBSCRIPTION_CHANGE_CREATE,
        PermissionCode.SUBSCRIPTION_CHANGE_QUOTE
      ],
      roles: ["OP"],
      username: "integration-op"
    };
    const context = { ipAddress: "127.0.0.1", userAgent: "vitest-integration" };

    try {
      const change = await service.createExtension(
        {
          extensionMonths: 6,
          idempotencyKey: `create:${fixture.orderId}`,
          orderId: fixture.orderId,
          priceOverrideReason: "Retain the archived agreement price",
          pricingMode: SubscriptionChangePricingMode.ORIGINAL_PRICE
        },
        actor,
        context
      );
      expect(change).toMatchObject({
        orderId: fixture.orderId,
        status: SubscriptionChangeStatus.DRAFT,
        targetStartDate: new Date("2026-09-03T00:00:00.000Z"),
        targetEndDate: new Date("2027-03-02T00:00:00.000Z")
      });
      const stored = await prisma.subscriptionChangeOrder.findUniqueOrThrow({
        include: { extensionDetail: true },
        where: { id: change.id }
      });
      expect(stored).toMatchObject({
        extensionMonths: null,
        pricingMode: null,
        sourceSegmentId: null,
        targetEndDate: null,
        targetStartDate: null,
        extensionDetail: {
          extensionMonths: 6,
          pricingMode: SubscriptionChangePricingMode.ORIGINAL_PRICE,
          sourceSegmentId: expect.any(String),
          targetEndDate: new Date("2027-03-02T00:00:00.000Z"),
          targetStartDate: new Date("2026-09-03T00:00:00.000Z")
        }
      });

      const quoteInput = {
        idempotencyKey: `quote:${change.id}:1`,
        version: 0
      };
      const quote = await service.createFormalQuote(change.id, quoteInput, actor, context);
      const replay = await service.createFormalQuote(change.id, quoteInput, actor, context);

      expect(quote).toMatchObject({
        monthlyFeeAmount: 88_000n,
        revision: 1,
        status: SubscriptionChangeQuoteStatus.FORMAL
      });
      expect(replay.id).toBe(quote.id);
      await expect(
        prisma.subscriptionChangeQuote.count({ where: { changeOrderId: change.id } })
      ).resolves.toBe(1);
      await expect(
        prisma.subscriptionChangeCommand.count({
          where: { actorId: actor.id, resourceId: { in: [change.id, quote.id] } }
        })
      ).resolves.toBe(2);

      const approver = {
        ...actor,
        id: approverId,
        permissions: [PermissionCode.SUBSCRIPTION_CHANGE_PRICE_OVERRIDE_APPROVE],
        username: `extension-approver-${approverId}`
      };
      await service.approvePriceOverride(
        change.id,
        {
          idempotencyKey: `approve:${change.id}:1`,
          reason: "Approved against the archived agreement",
          version: 1
        },
        approver,
        context
      );

      const approved = await prisma.subscriptionChangeOrder.findUniqueOrThrow({
        include: { extensionDetail: true },
        where: { id: change.id }
      });
      expect(approved).toMatchObject({
        priceOverrideApprovedAt: null,
        priceOverrideApprovedBy: null,
        priceOverrideReason: null,
        extensionDetail: {
          priceOverrideApprovedAt: new Date("2026-08-05T04:00:00.000Z"),
          priceOverrideApprovedBy: approverId,
          priceOverrideReason: "Approved against the archived agreement"
        }
      });
    } finally {
      await cleanupFixture(prisma, fixture.orderId);
      await prisma.user.deleteMany({ where: { id: approverId } });
    }
  });

  it("serializes Admin and customer-renewal creation through one active-change slot", async () => {
    const fixture = await createFixture(prisma);
    const actor = {
      id: randomUUID(),
      menus: [],
      name: "Integration Operator",
      permissions: [PermissionCode.SUBSCRIPTION_CHANGE_CREATE],
      roles: ["OP"],
      username: "integration-op"
    };
    const context = { ipAddress: "127.0.0.1", userAgent: "vitest-integration" };

    try {
      const segment = await segmentService.ensureBaseSegment(fixture.orderId, actor.id);
      const consideration = await prisma.renewalConsideration.create({
        data: {
          completionDeadlineAt: new Date("2026-09-02T16:00:00.000Z"),
          considerationNo: `RNC${randomUUID().replaceAll("-", "").slice(0, 20)}`,
          considerationStartAt: new Date("2026-08-03T00:00:00.000Z"),
          orderId: fixture.orderId,
          segmentId: segment.id,
          status: RenewalConsiderationStatus.PENDING_DECISION
        }
      });
      const portal = new PortalRenewalService(
        prisma,
        new AuditService(prisma),
        {
          enabled: true,
          now: () => new Date("2026-08-05T04:00:00.000Z"),
          quoteValidityHours: 72
        },
        repository
      );

      const results = await Promise.allSettled([
        service.createExtension(
          {
            extensionMonths: 6,
            idempotencyKey: `admin:${fixture.orderId}`,
            orderId: fixture.orderId,
            pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION
          },
          actor,
          context
        ),
        portal.decide(
          consideration.id,
          { decision: RenewalDecision.RENEW, version: 0 },
          {
            accountStatus: "ACTIVE",
            customerAccountId: randomUUID(),
            customerId: fixture.customerId,
            phone: "13800138000"
          } as never,
          context
        )
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(
        prisma.subscriptionChangeOrder.count({
          where: {
            orderId: fixture.orderId,
            status: {
              in: [
                SubscriptionChangeStatus.DRAFT,
                SubscriptionChangeStatus.QUOTED,
                SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
                SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
                SubscriptionChangeStatus.SCHEDULED,
                SubscriptionChangeStatus.EXECUTING,
                SubscriptionChangeStatus.MANUAL_TAKEOVER
              ]
            }
          }
        })
      ).resolves.toBe(1);
      await expect(
        prisma.subscriptionExtensionChangeDetail.count({
          where: { changeOrder: { orderId: fixture.orderId } }
        })
      ).resolves.toBe(1);
    } finally {
      await cleanupFixture(prisma, fixture.orderId);
    }
  });
});

async function createFixture(prisma: PrismaService) {
  const orderId = randomUUID();
  const contractId = randomUUID();
  const customerId = randomUUID();
  const productId = randomUUID();
  const productVersionId = randomUUID();
  const vehicleId = randomUUID();

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "product" (
        "id", "product_no", "name", "product_type", "status", "created_at", "updated_at"
      ) VALUES (
        ${productId}::uuid,
        ${`PRDEXT${productId.replaceAll("-", "").slice(0, 18)}`},
        'Extension integration product',
        'SUBSCRIPTION',
        'ACTIVE',
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "product_version" (
        "id", "product_id", "version_no", "effective_from", "status", "created_at", "updated_at"
      ) VALUES (
        ${productVersionId}::uuid,
        ${productId}::uuid,
        'V1.0',
        '2026-01-01'::date,
        'ACTIVE',
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle" (
        "id", "vehicle_no", "brand", "model_definition_id", "purchase_price_amount",
        "current_sale_price_amount", "status", "created_at", "updated_at"
      ) VALUES (
        ${vehicleId}::uuid,
        ${`VEHEXT${vehicleId.replaceAll("-", "").slice(0, 18)}`},
        'NIO',
        ${randomUUID()}::uuid,
        18000000,
        20000000,
        'LEASED',
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_order" (
        "id", "order_no", "customer_id", "application_id", "quote_id",
        "contract_id", "vehicle_id", "product_id", "product_version_id",
        "vehicle_purchase_price_amount", "monthly_fee_amount", "deposit_amount",
        "period_months", "mileage_limit_km", "over_mileage_fee_amount",
        "energy_limit_count", "model_definition_id_snapshot", "model_code_snapshot",
        "model_display_name_snapshot", "quote_snapshot", "final_plan_snapshot",
        "order_status", "start_date", "end_date", "created_at", "updated_at"
      ) VALUES (
        ${orderId}::uuid,
        ${`ORDEXT${orderId.replaceAll("-", "").slice(0, 20)}`},
        ${customerId}::uuid,
        ${randomUUID()}::uuid,
        ${randomUUID()}::uuid,
        NULL,
        ${vehicleId}::uuid,
        ${productId}::uuid,
        ${productVersionId}::uuid,
        20000000,
        88000,
        0,
        6,
        1500,
        100,
        2,
        ${randomUUID()}::uuid,
        'NIO_ET5_2024',
        'NIO ET5',
        '{"quoteNo":"QUOTE-EXT-1"}'::jsonb,
        '{"subscriptionPlan":{"planNo":"PLAN-EXT-1"}}'::jsonb,
        'ACTIVE',
        '2026-03-03'::date,
        '2026-09-02'::date,
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "contract" (
        "id", "contract_no", "order_id", "customer_id", "business_type",
        "contract_version_id", "contract_title", "contract_snapshot", "status",
        "archived_at", "created_at", "updated_at"
      ) VALUES (
        ${contractId}::uuid,
        ${`CONEXT${contractId.replaceAll("-", "").slice(0, 20)}`},
        ${orderId}::uuid,
        ${customerId}::uuid,
        'SUBSCRIPTION',
        ${randomUUID()}::uuid,
        'Main subscription contract',
        '{"archivedDocument":"main-contract.pdf"}'::jsonb,
        ${ContractStatus.ARCHIVED}::contract_status,
        clock_timestamp(),
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_order"
      SET "contract_id" = ${contractId}::uuid
      WHERE "id" = ${orderId}::uuid
    `);
  });

  return { contractId, customerId, orderId, productId, productVersionId, vehicleId };
}

async function cleanupFixture(prisma: PrismaService, orderId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_change_command"
      WHERE "resource_id" IN (
        SELECT "id" FROM "subscription_change_order" WHERE "order_id" = ${orderId}::uuid
        UNION
        SELECT q."id" FROM "subscription_change_quote" q
        JOIN "subscription_change_order" c ON c."id" = q."change_order_id"
        WHERE c."order_id" = ${orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "audit_log"
      WHERE "entity_id" IN (
        SELECT "id" FROM "subscription_change_order" WHERE "order_id" = ${orderId}::uuid
        UNION
        SELECT q."id" FROM "subscription_change_quote" q
        JOIN "subscription_change_order" c ON c."id" = q."change_order_id"
        WHERE c."order_id" = ${orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_change_quote"
      WHERE "change_order_id" IN (
        SELECT "id" FROM "subscription_change_order" WHERE "order_id" = ${orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_extension_change_detail"
      WHERE "change_order_id" IN (
        SELECT "id" FROM "subscription_change_order" WHERE "order_id" = ${orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "renewal_consideration" WHERE "order_id" = ${orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_change_order" WHERE "order_id" = ${orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_contract_segment" WHERE "order_id" = ${orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "contract" WHERE "order_id" = ${orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "vehicle" WHERE "id" = (
        SELECT "vehicle_id" FROM "subscription_order" WHERE "id" = ${orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "product_version" WHERE "id" = (
        SELECT "product_version_id" FROM "subscription_order" WHERE "id" = ${orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "product" WHERE "id" = (
        SELECT "product_id" FROM "subscription_order" WHERE "id" = ${orderId}::uuid
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "subscription_order" WHERE "id" = ${orderId}::uuid
    `);
  });
}
