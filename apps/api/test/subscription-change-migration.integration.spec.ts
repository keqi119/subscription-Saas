import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
import { insertRuntimeOrderGraph } from "./helpers/runtime-domain-fixture";

const TEST_DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/subscription-change-migration.integration.spec.ts"
).databaseUrl;
const apiRoot = resolve(__dirname, "..");
const migrationRoot = resolve(apiRoot, "prisma", "migrations");

describe("Stage 1B migration deployment", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("observes every repository migration and the expected current schema", async () => {
    const migrationCount = readdirSync(migrationRoot, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    ).length;
    const [
      applied,
      commandColumn,
      activeTaskIndex,
      activeChangeTaskIndex,
      changeTypes,
      detailTables
    ] = await Promise.all([
      prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::bigint AS "count"
          FROM "_prisma_migrations"
          WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
        `),
      prisma.$queryRaw<Array<{ data_type: string }>>(Prisma.sql`
          SELECT data_type
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'subscription_change_command'
            AND column_name = 'updated_at'
        `),
      prisma.$queryRaw<Array<{ indexdef: string }>>(Prisma.sql`
          SELECT indexdef
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'contract_esign_task_one_active_per_contract_key'
        `),
      prisma.$queryRaw<Array<{ indexdef: string }>>(Prisma.sql`
          SELECT indexdef
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'contract_esign_task_one_active_subscription_change_source_key'
        `),
      prisma.$queryRaw<Array<{ enumlabel: string }>>(Prisma.sql`
          SELECT value.enumlabel
          FROM pg_type type
          JOIN pg_enum value ON value.enumtypid = type.oid
          JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
          WHERE type.typname = 'subscription_change_type'
            AND namespace.nspname = current_schema()
          ORDER BY value.enumsortorder
        `),
      prisma.$queryRaw<Array<{ table_name: string }>>(Prisma.sql`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name IN (
              'subscription_extension_change_detail',
              'subscription_vehicle_swap_change_detail',
              'subscription_early_termination_change_detail',
              'subscription_managed_other_change_detail'
            )
          ORDER BY table_name
        `)
    ]);
    const legacyColumns = await prisma.$queryRaw<
      Array<{ column_name: string; is_nullable: string }>
    >(Prisma.sql`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'subscription_change_order'
        AND column_name IN (
          'extension_months',
          'pricing_mode',
          'source_segment_id',
          'target_start_date',
          'target_end_date'
        )
      ORDER BY column_name
    `);

    expect(Number(applied[0]?.count)).toBe(migrationCount);
    expect(commandColumn).toEqual([{ data_type: "timestamp with time zone" }]);
    expect(activeTaskIndex[0]?.indexdef).toContain("UNIQUE INDEX");
    expect(activeTaskIndex[0]?.indexdef).toContain("contract_id");
    expect(activeChangeTaskIndex[0]?.indexdef).toContain("UNIQUE INDEX");
    expect(activeChangeTaskIndex[0]?.indexdef).toContain("source_type");
    expect(activeChangeTaskIndex[0]?.indexdef).toContain("source_id");
    expect(changeTypes.map((row) => row.enumlabel)).toEqual([
      "EXTENSION",
      "VEHICLE_SWAP",
      "EARLY_TERMINATION",
      "MANAGED_OTHER"
    ]);
    expect(detailTables.map((row) => row.table_name)).toEqual([
      "subscription_early_termination_change_detail",
      "subscription_extension_change_detail",
      "subscription_managed_other_change_detail",
      "subscription_vehicle_swap_change_detail"
    ]);
    expect(legacyColumns).toHaveLength(5);
    expect(legacyColumns.every((row) => row.is_nullable === "YES")).toBe(true);
  });

  it("retains the typed-detail backfill contract and enforces exactly one matching detail", async () => {
    const migrationSql = readFileSync(
      resolve(migrationRoot, "20260826020000_stage1_active_term_change_center", "migration.sql"),
      "utf8"
    );
    expect(migrationSql).toContain('INSERT INTO "subscription_extension_change_detail"');
    expect(migrationSql).toContain("assert_subscription_change_detail_shape");

    const orderId = randomUUID();
    const sourceSegmentId = randomUUID();
    const changeId = randomUUID();
    const graph = await prisma.$transaction((tx) =>
      insertRuntimeOrderGraph(tx, { label: "TYPED-DETAIL-MIGRATION", orderId })
    );
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "subscription_contract_segment" (
          "id", "segment_no", "order_id", "segment_type", "sequence_no", "status",
          "start_date", "end_date", "product_id", "product_version_id",
          "monthly_fee_amount", "mileage_limit_km", "over_mileage_fee_amount",
          "plan_snapshot", "quote_snapshot", "contract_snapshot"
        ) VALUES (
          $1::uuid, $2, $3::uuid, 'BASE', 1, 'COMPLETED',
          '2026-03-03'::date, '2026-09-02'::date, $4::uuid, $5::uuid,
          88000, 1500, 100, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
        )`,
        [
          sourceSegmentId,
          `SEG-LEGACY-${sourceSegmentId}`,
          orderId,
          graph.productId,
          graph.productVersionId
        ]
      );
      await client.query(
        `INSERT INTO "subscription_change_order" (
          "id", "change_no", "order_id", "change_type", "status",
          "source_segment_id", "extension_months", "pricing_mode",
          "target_start_date", "target_end_date", "completion_deadline_at",
          "price_override_reason", "updated_at"
        ) VALUES (
          $1::uuid, $2, $3::uuid, 'EXTENSION', 'COMPLETED',
          $4::uuid, 6, 'ORIGINAL_PRICE',
          '2026-09-03'::date, '2027-03-02'::date, '2026-09-03T00:00:00Z',
          'retain signed price', clock_timestamp()
        )`,
        [changeId, `SCO-LEGACY-${changeId}`, orderId, sourceSegmentId]
      );
      await client.query(
        `INSERT INTO "subscription_extension_change_detail" (
          "id", "change_order_id", "source_segment_id", "extension_months",
          "pricing_mode", "target_start_date", "target_end_date", "price_override_reason"
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, 6, 'ORIGINAL_PRICE',
          '2026-09-03'::date, '2027-03-02'::date, 'retain signed price'
        )`,
        [randomUUID(), changeId, sourceSegmentId]
      );
      await client.query("COMMIT");

      const detail = await client.query<{
        extension_months: number;
        pricing_mode: string;
        price_override_reason: string;
        target_end_date: string;
        target_start_date: string;
      }>(
        `SELECT extension_months, pricing_mode::text, price_override_reason,
                target_start_date::text, target_end_date::text
         FROM "subscription_extension_change_detail"
         WHERE "change_order_id" = $1::uuid`,
        [changeId]
      );
      expect(detail.rows).toEqual([
        {
          extension_months: 6,
          price_override_reason: "retain signed price",
          pricing_mode: "ORIGINAL_PRICE",
          target_end_date: "2027-03-02",
          target_start_date: "2026-09-03"
        }
      ]);

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "subscription_managed_other_change_detail" (
          "id", "change_order_id", "reason", "effective_date", "evidence_snapshot",
          "approved_operation_snapshot", "before_snapshot"
        ) VALUES ($1::uuid, $2::uuid, 'mismatched detail proof', '2026-09-03'::date, '{}', '{}', '{}')`,
        [randomUUID(), changeId]
      );
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({
        code: "23514"
      });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query(
        'DELETE FROM "subscription_extension_change_detail" WHERE "change_order_id" = $1::uuid',
        [changeId]
      );
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({
        code: "23514"
      });
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  });

  it("keeps existing runtime data readable after the launcher-owned migration phase", async () => {
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        name: "Legacy migration fixture",
        productNo: `LEGACY-${productId}`,
        status: "ACTIVE"
      }
    });
    await expect(
      prisma.product.findUniqueOrThrow({ where: { id: productId } })
    ).resolves.toMatchObject({ name: "Legacy migration fixture", status: "ACTIVE" });
  });

  it("reports the launcher target as fully migrated", async () => {
    const [applied, failed] = await Promise.all([
      prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS "count"
        FROM "_prisma_migrations"
        WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
      `),
      prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS "count"
        FROM "_prisma_migrations"
        WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL
      `)
    ]);
    const migrationCount = readdirSync(migrationRoot, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    ).length;
    expect(Number(applied[0]?.count)).toBe(migrationCount);
    expect(Number(failed[0]?.count)).toBe(0);
  });
});
