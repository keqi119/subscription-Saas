import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE_DATABASE_URL = normalizeDatabaseUrl(
  process.env.DATABASE_URL ??
    "postgresql://subscription:subscription@127.0.0.1:5432/subscription_saas?schema=public"
);
const LEGACY_MIGRATION_COUNT = 78;
const apiRoot = resolve(__dirname, "..");
const freshSchema = `stage1b_migration_${randomUUID().replaceAll("-", "")}`;
const freshDatabaseUrl = withSchema(BASE_DATABASE_URL, freshSchema);
const upgradeSchema = `stage1b_upgrade_${randomUUID().replaceAll("-", "")}`;
const upgradeDatabaseUrl = withSchema(BASE_DATABASE_URL, upgradeSchema);
const typedDetailUpgradeSchema = `stage1b_typed_detail_${randomUUID().replaceAll("-", "")}`;
const typedDetailUpgradeDatabaseUrl = withSchema(BASE_DATABASE_URL, typedDetailUpgradeSchema);
const legacyProductId = randomUUID();
let baselineFixtureRoot: string | undefined;
let typedDetailFixtureRoot: string | undefined;

describe("Stage 1B migration deployment", () => {
  const cleanupClient = new Client({ connectionString: BASE_DATABASE_URL });

  beforeAll(async () => {
    await cleanupClient.connect();
  });

  afterAll(async () => {
    if (
      !/^stage1b_migration_[a-f0-9]{32}$/.test(freshSchema) ||
      !/^stage1b_upgrade_[a-f0-9]{32}$/.test(upgradeSchema) ||
      !/^stage1b_typed_detail_[a-f0-9]{32}$/.test(typedDetailUpgradeSchema)
    ) {
      throw new Error("Refusing to drop an unexpected migration-test schema.");
    }
    await cleanupClient.query(`DROP SCHEMA IF EXISTS "${freshSchema}" CASCADE`);
    await cleanupClient.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
    await cleanupClient.query(`DROP SCHEMA IF EXISTS "${typedDetailUpgradeSchema}" CASCADE`);
    await cleanupClient.end();
    if (baselineFixtureRoot) {
      rmSync(baselineFixtureRoot, { force: true, recursive: true });
    }
    if (typedDetailFixtureRoot) {
      rmSync(typedDetailFixtureRoot, { force: true, recursive: true });
    }
  }, 30_000);

  it("deploys every migration into a fresh PostgreSQL schema", async () => {
    const deploy = runPrismaMigration("deploy", freshDatabaseUrl);
    expect(deploy.status, deploy.output).toBe(0);

    const client = new Client({ connectionString: freshDatabaseUrl });
    await client.connect();
    await setSearchPath(client, freshSchema);
    try {
      const migrationCount = readdirSync(resolve(apiRoot, "prisma", "migrations"), {
        withFileTypes: true
      }).filter((entry) => entry.isDirectory()).length;
      const applied = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS "count" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL'
      );
      const commandColumn = await client.query<{ data_type: string }>(`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'subscription_change_command'
          AND column_name = 'updated_at'
      `);
      const activeTaskIndex = await client.query<{ indexdef: string }>(`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'contract_esign_task_one_active_per_contract_key'
      `);
      const changeTypes = await client.query<{ enumlabel: string }>(`
        SELECT value.enumlabel
        FROM pg_type type
        JOIN pg_enum value ON value.enumtypid = type.oid
        JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
        WHERE type.typname = 'subscription_change_type'
          AND namespace.nspname = current_schema()
        ORDER BY value.enumsortorder
      `);
      const detailTables = await client.query<{ table_name: string }>(`
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
      `);
      const legacyColumns = await client.query<{ column_name: string; is_nullable: string }>(`
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

      expect(Number(applied.rows[0]?.count)).toBe(migrationCount);
      expect(commandColumn.rows).toEqual([{ data_type: "timestamp with time zone" }]);
      expect(activeTaskIndex.rows[0]?.indexdef).toContain("UNIQUE INDEX");
      expect(activeTaskIndex.rows[0]?.indexdef).toContain("contract_id");
      expect(changeTypes.rows.map((row) => row.enumlabel)).toEqual([
        "EXTENSION",
        "VEHICLE_SWAP",
        "EARLY_TERMINATION",
        "MANAGED_OTHER"
      ]);
      expect(detailTables.rows.map((row) => row.table_name)).toEqual([
        "subscription_early_termination_change_detail",
        "subscription_extension_change_detail",
        "subscription_managed_other_change_detail",
        "subscription_vehicle_swap_change_detail"
      ]);
      expect(legacyColumns.rows).toHaveLength(5);
      expect(legacyColumns.rows.every((row) => row.is_nullable === "YES")).toBe(true);
    } finally {
      await client.end();
    }
  }, 120_000);

  it("backfills a populated legacy extension root into exactly one typed detail", async () => {
    const targetMigration = "20260826020000_stage1_active_term_change_center";
    const migrationRoot = resolve(apiRoot, "prisma", "migrations");
    const migrationDirectories = readdirSync(migrationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    typedDetailFixtureRoot = mkdtempSync(resolve(apiRoot, ".typed-detail-migration-baseline-"));
    const baselineMigrationRoot = resolve(typedDetailFixtureRoot, "migrations");
    mkdirSync(baselineMigrationRoot);
    for (const migrationName of migrationDirectories.filter((name) => name !== targetMigration)) {
      cpSync(resolve(migrationRoot, migrationName), resolve(baselineMigrationRoot, migrationName), {
        recursive: true
      });
    }
    const baselineConfigPath = resolve(typedDetailFixtureRoot, "prisma.config.ts");
    writeFileSync(
      baselineConfigPath,
      [
        'import { defineConfig } from "prisma/config";',
        "",
        "export default defineConfig({",
        '  datasource: { url: process.env["DATABASE_URL"] },',
        `  migrations: { path: ${JSON.stringify(baselineMigrationRoot)} },`,
        `  schema: ${JSON.stringify(resolve(apiRoot, "prisma", "schema.prisma"))}`,
        "});",
        ""
      ].join("\n"),
      "utf8"
    );

    const baselineDeploy = runPrismaMigration(
      "deploy",
      typedDetailUpgradeDatabaseUrl,
      baselineConfigPath
    );
    expect(baselineDeploy.status, baselineDeploy.output).toBe(0);

    const client = new Client({ connectionString: typedDetailUpgradeDatabaseUrl });
    await client.connect();
    await setSearchPath(client, typedDetailUpgradeSchema);
    const changeId = randomUUID();
    const orderId = randomUUID();
    const sourceSegmentId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO "subscription_contract_segment" (
          "id", "segment_no", "order_id", "segment_type", "sequence_no", "status",
          "start_date", "end_date", "monthly_fee_amount", "mileage_limit_km",
          "over_mileage_fee_amount", "plan_snapshot", "quote_snapshot", "contract_snapshot"
        ) VALUES (
          $1::uuid, $2, $3::uuid, 'BASE', 1, 'COMPLETED',
          '2026-03-03'::date, '2026-09-02'::date, 88000, 1500,
          100, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
        )`,
        [sourceSegmentId, `SEG-LEGACY-${sourceSegmentId}`, orderId]
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
      await client.query("COMMIT");

      const currentDeploy = runPrismaMigration("deploy", typedDetailUpgradeDatabaseUrl);
      expect(currentDeploy.status, currentDeploy.output).toBe(0);

      const detailTable = await client.query<{ table_name: string | null }>(
        "SELECT to_regclass('subscription_extension_change_detail')::text AS table_name"
      );
      expect(detailTable.rows[0]?.table_name).toBe("subscription_extension_change_detail");
      if (!detailTable.rows[0]?.table_name) return;

      const detail = await client.query<{
        extension_months: number;
        pricing_mode: string;
        price_override_reason: string;
        target_end_date: string;
        target_start_date: string;
      }>(
        `SELECT
          extension_months,
          pricing_mode::text,
          price_override_reason,
          target_start_date::text,
          target_end_date::text
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
  }, 120_000);

  it("upgrades a populated 78-migration schema without losing legacy data", async () => {
    const migrationRoot = resolve(apiRoot, "prisma", "migrations");
    const migrationDirectories = readdirSync(migrationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(migrationDirectories.length).toBeGreaterThan(LEGACY_MIGRATION_COUNT);

    baselineFixtureRoot = mkdtempSync(resolve(apiRoot, ".stage1b-migration-baseline-"));
    const baselineMigrationRoot = resolve(baselineFixtureRoot, "migrations");
    mkdirSync(baselineMigrationRoot);
    for (const migrationName of migrationDirectories.slice(0, LEGACY_MIGRATION_COUNT)) {
      cpSync(resolve(migrationRoot, migrationName), resolve(baselineMigrationRoot, migrationName), {
        recursive: true
      });
    }
    const baselineConfigPath = resolve(baselineFixtureRoot, "prisma.config.ts");
    writeFileSync(
      baselineConfigPath,
      [
        'import { defineConfig } from "prisma/config";',
        "",
        "export default defineConfig({",
        '  datasource: { url: process.env["DATABASE_URL"] },',
        `  migrations: { path: ${JSON.stringify(baselineMigrationRoot)} },`,
        `  schema: ${JSON.stringify(resolve(apiRoot, "prisma", "schema.prisma"))}`,
        "});",
        ""
      ].join("\n"),
      "utf8"
    );

    const baselineDeploy = runPrismaMigration("deploy", upgradeDatabaseUrl, baselineConfigPath);
    expect(baselineDeploy.status, baselineDeploy.output).toBe(0);

    const client = new Client({ connectionString: upgradeDatabaseUrl });
    await client.connect();
    await setSearchPath(client, upgradeSchema);
    try {
      await client.query(
        `INSERT INTO "product" (
          "id", "product_no", "name", "product_type", "status", "updated_at"
        ) VALUES ($1::uuid, $2, $3, 'SUBSCRIPTION', 'ACTIVE', clock_timestamp())`,
        [legacyProductId, `LEGACY-${legacyProductId}`, "Legacy migration fixture"]
      );

      const currentDeploy = runPrismaMigration("deploy", upgradeDatabaseUrl);
      expect(currentDeploy.status, currentDeploy.output).toBe(0);

      const applied = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS "count" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL'
      );
      const legacyProduct = await client.query<{ name: string; status: string }>(
        'SELECT "name", "status"::text FROM "product" WHERE "id" = $1::uuid',
        [legacyProductId]
      );

      expect(Number(applied.rows[0]?.count)).toBe(migrationDirectories.length);
      expect(legacyProduct.rows).toEqual([{ name: "Legacy migration fixture", status: "ACTIVE" }]);
    } finally {
      await client.end();
    }
  }, 120_000);

  it("reports the existing development schema as fully migrated", () => {
    const status = runPrismaMigration("status", BASE_DATABASE_URL);
    expect(status.status, status.output).toBe(0);
    expect(status.output).toContain("Database schema is up to date");
  }, 30_000);
});

function runPrismaMigration(
  command: "deploy" | "status",
  databaseUrl: string,
  configPath?: string
) {
  const prismaArgs = [
    "exec",
    "prisma",
    "migrate",
    command,
    ...(configPath ? ["--config", configPath] : ["--schema", "prisma/schema.prisma"])
  ];
  const executable = process.platform === "win32" ? process.execPath : "pnpm";
  const args =
    process.platform === "win32"
      ? [
          resolve(dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js"),
          ...prismaArgs
        ]
      : prismaArgs;
  const result = spawnSync(executable, args, {
    cwd: apiRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`,
    status: result.status
  };
}

function normalizeDatabaseUrl(value: string) {
  const url = new URL(value);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

function withSchema(value: string, schema: string) {
  const url = new URL(value);
  url.searchParams.set("schema", schema);
  return url.toString();
}

async function setSearchPath(client: Client, schema: string) {
  if (!/^stage1b_(migration|upgrade|typed_detail)_[a-f0-9]{32}$/.test(schema)) {
    throw new Error("Refusing to set an unexpected migration-test search path.");
  }
  await client.query(`SET search_path TO "${schema}"`);
}
