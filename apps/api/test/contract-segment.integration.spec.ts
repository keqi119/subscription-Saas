import { ConfigService } from "@nestjs/config";
import { ContractSegmentType, ContractStatus, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";
import { ContractSegmentService } from "../src/subscription-change/contract-segment.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:5432/subscription_saas?schema=public";

describe("ContractSegmentService PostgreSQL integration", () => {
  let prisma: PrismaService;
  let service: ContractSegmentService;

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: TEST_DATABASE_URL })
    );
    await prisma.onModuleInit();
    service = new ContractSegmentService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("persists one BASE segment and resolves it for a period", async () => {
    const fixture = await createFixture(prisma);
    try {
      const first = await service.ensureBaseSegment(fixture.orderId);
      const second = await service.ensureBaseSegment(fixture.orderId);

      expect(first.id).toBe(second.id);
      expect(first).toMatchObject({
        orderId: fixture.orderId,
        segmentType: ContractSegmentType.BASE,
        sequenceNo: 1,
        sourceContractId: fixture.contractId
      });
      await expect(
        service.resolveSegmentForPeriod(fixture.orderId, new Date("2026-08-02T00:00:00.000Z"))
      ).resolves.toMatchObject({
        segmentId: first.id,
        monthlyFeeAmount: 1_000n,
        mileageLimitKm: 1_500
      });
      await expect(
        prisma.subscriptionContractSegment.count({
          where: { orderId: fixture.orderId, segmentType: ContractSegmentType.BASE }
        })
      ).resolves.toBe(1);
    } finally {
      await prisma.subscriptionContractSegment.deleteMany({
        where: { orderId: fixture.orderId }
      });
      await prisma.contract.deleteMany({ where: { id: fixture.contractId } });
      await prisma.subscriptionOrder.deleteMany({ where: { id: fixture.orderId } });
      await prisma.productVersion.deleteMany({ where: { id: fixture.productVersionId } });
      await prisma.product.deleteMany({ where: { id: fixture.productId } });
    }
  });
});

async function createFixture(prisma: PrismaService) {
  const orderId = randomUUID();
  const contractId = randomUUID();
  const customerId = randomUUID();
  const productId = randomUUID();
  const productVersionId = randomUUID();

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "product" (
        "id", "product_no", "name", "product_type", "status", "created_at", "updated_at"
      ) VALUES (
        ${productId}::uuid,
        ${`PRDSEG${productId.replaceAll("-", "").slice(0, 18)}`},
        'Segment integration product',
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
      INSERT INTO "subscription_order" (
        "id", "order_no", "customer_id", "application_id", "quote_id",
        "contract_id", "product_id", "product_version_id",
        "vehicle_purchase_price_amount", "monthly_fee_amount", "deposit_amount",
        "period_months", "mileage_limit_km", "over_mileage_fee_amount",
        "energy_limit_kwh", "model_definition_id_snapshot", "model_code_snapshot",
        "model_display_name_snapshot", "quote_snapshot", "final_plan_snapshot",
        "order_status", "start_date", "end_date", "created_at", "updated_at"
      ) VALUES (
        ${orderId}::uuid,
        ${`ORDSEG${orderId.replaceAll("-", "").slice(0, 20)}`},
        ${customerId}::uuid,
        ${randomUUID()}::uuid,
        ${randomUUID()}::uuid,
        NULL,
        ${productId}::uuid,
        ${productVersionId}::uuid,
        20000000,
        1000,
        0,
        6,
        1500,
        100,
        100,
        ${randomUUID()}::uuid,
        'NIO_ET5_2024',
        'NIO ET5',
        '{"quoteNo":"QUOTE-SEG-1"}'::jsonb,
        '{"subscriptionPlan":{"planNo":"PLAN-SEG-1"}}'::jsonb,
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
        ${`CONSEG${contractId.replaceAll("-", "").slice(0, 20)}`},
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

  return { contractId, orderId, productId, productVersionId };
}
