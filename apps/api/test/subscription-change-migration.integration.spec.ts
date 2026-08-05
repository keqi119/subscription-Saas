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
const legacyProductId = randomUUID();
let baselineFixtureRoot: string | undefined;

describe("Stage 1B migration deployment", () => {
  const cleanupClient = new Client({ connectionString: BASE_DATABASE_URL });

  beforeAll(async () => {
    await cleanupClient.connect();
  });

  afterAll(async () => {
    if (
      !/^stage1b_migration_[a-f0-9]{32}$/.test(freshSchema) ||
      !/^stage1b_upgrade_[a-f0-9]{32}$/.test(upgradeSchema)
    ) {
      throw new Error("Refusing to drop an unexpected migration-test schema.");
    }
    await cleanupClient.query(`DROP SCHEMA IF EXISTS "${freshSchema}" CASCADE`);
    await cleanupClient.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
    await cleanupClient.end();
    if (baselineFixtureRoot) {
      rmSync(baselineFixtureRoot, { force: true, recursive: true });
    }
  });

  it("deploys every migration into a fresh PostgreSQL schema", async () => {
    const deploy = runPrismaMigration("deploy", freshDatabaseUrl);
    expect(deploy.status, deploy.output).toBe(0);

    const client = new Client({ connectionString: freshDatabaseUrl });
    await client.connect();
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

      expect(Number(applied.rows[0]?.count)).toBe(migrationCount);
      expect(commandColumn.rows).toEqual([{ data_type: "timestamp with time zone" }]);
      expect(activeTaskIndex.rows[0]?.indexdef).toContain("UNIQUE INDEX");
      expect(activeTaskIndex.rows[0]?.indexdef).toContain("contract_id");
    } finally {
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
