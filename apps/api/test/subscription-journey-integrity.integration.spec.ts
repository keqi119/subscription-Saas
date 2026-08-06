import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const apiRoot = resolve(__dirname, "..");
const baseDatabaseUrl = requiredDatabaseUrl();
const isolatedDatabaseName = `journey_task1_${randomUUID().replaceAll("-", "")}`;
const isolatedDatabaseUrl = withDatabase(baseDatabaseUrl, isolatedDatabaseName);
const cleanupClient = new Client({ connectionString: baseDatabaseUrl });
const client = new Client({ connectionString: isolatedDatabaseUrl });
let firstSeedCounts: Record<string, number>;
let secondSeedCounts: Record<string, number>;

const CATALOG_COLUMNS: Record<string, string[]> = {
  subscription_journey: [
    "id:text:NO",
    "application_id:uuid:NO",
    "order_id:uuid:YES",
    "status:subscription_journey_status:NO",
    "current_step_code:subscription_journey_step_code:NO",
    "current_step_status:subscription_journey_step_status:NO",
    "paused_from_status:subscription_journey_status:YES",
    "version:int4:NO",
    "started_at:timestamptz:NO",
    "completed_at:timestamptz:YES",
    "cancelled_at:timestamptz:YES",
    "created_at:timestamptz:NO",
    "updated_at:timestamptz:NO"
  ],
  subscription_journey_step: [
    "id:text:NO",
    "journey_id:text:NO",
    "code:subscription_journey_step_code:NO",
    "status:subscription_journey_step_status:NO",
    "attempt_count:int4:NO",
    "started_at:timestamptz:YES",
    "waiting_at:timestamptz:YES",
    "completed_at:timestamptz:YES",
    "last_error_code:varchar:YES",
    "created_at:timestamptz:NO",
    "updated_at:timestamptz:NO"
  ],
  subscription_journey_job: [
    "id:text:NO",
    "journey_id:text:NO",
    "step_id:text:NO",
    "job_type:subscription_journey_job_type:NO",
    "status:subscription_journey_job_status:NO",
    "source_key:varchar:NO",
    "payload:jsonb:YES",
    "attempt_count:int4:NO",
    "max_attempts:int4:NO",
    "available_at:timestamptz:NO",
    "lease_token:varchar:YES",
    "lease_expires_at:timestamptz:YES",
    "last_error_code:varchar:YES",
    "last_error_message:text:YES",
    "completed_at:timestamptz:YES",
    "created_at:timestamptz:NO",
    "updated_at:timestamptz:NO"
  ],
  subscription_journey_manual_task: [
    "id:text:NO",
    "journey_id:text:NO",
    "step_id:text:NO",
    "task_type:subscription_journey_manual_task_type:NO",
    "status:subscription_journey_manual_task_status:NO",
    "decision:subscription_journey_manual_decision:YES",
    "input_snapshot:jsonb:NO",
    "decided_by:uuid:YES",
    "decision_notes:text:YES",
    "decided_at:timestamptz:YES",
    "version:int4:NO",
    "created_at:timestamptz:NO",
    "updated_at:timestamptz:NO"
  ],
  subscription_journey_event: [
    "id:text:NO",
    "journey_id:text:NO",
    "sequence:int4:NO",
    "event_key:varchar:NO",
    "event_type:subscription_journey_event_type:NO",
    "actor_type:varchar:YES",
    "actor_id:varchar:YES",
    "payload:jsonb:NO",
    "created_at:timestamptz:NO"
  ],
  subscription_journey_exception: [
    "id:text:NO",
    "journey_id:text:NO",
    "step_id:text:NO",
    "job_id:text:YES",
    "status:subscription_journey_exception_status:NO",
    "code:varchar:NO",
    "message:text:NO",
    "retryable:bool:NO",
    "occurrence_count:int4:NO",
    "first_occurred_at:timestamptz:NO",
    "last_occurred_at:timestamptz:NO",
    "acknowledged_by:uuid:YES",
    "acknowledged_at:timestamptz:YES",
    "resolved_by:uuid:YES",
    "resolved_at:timestamptz:YES",
    "resolution_notes:text:YES",
    "created_at:timestamptz:NO",
    "updated_at:timestamptz:NO"
  ],
  subscription_journey_outbox: [
    "id:text:NO",
    "journey_id:text:YES",
    "aggregate_type:varchar:NO",
    "aggregate_id:varchar:NO",
    "event_type:varchar:NO",
    "event_key:varchar:NO",
    "payload:jsonb:NO",
    "status:subscription_journey_outbox_status:NO",
    "attempt_count:int4:NO",
    "available_at:timestamptz:NO",
    "lease_token:varchar:YES",
    "lease_expires_at:timestamptz:YES",
    "last_error_code:varchar:YES",
    "last_error_message:text:YES",
    "delivered_at:timestamptz:YES",
    "created_at:timestamptz:NO",
    "updated_at:timestamptz:NO"
  ]
};

describe("subscription journey migrated database and seeded RBAC", () => {
  beforeAll(async () => {
    await cleanupClient.connect();
    await cleanupClient.query(`CREATE DATABASE "${isolatedDatabaseName}"`);

    const deploy = runCommand(["exec", "prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"]);
    expect(deploy.status, deploy.output).toBe(0);

    await client.connect();

    const firstSeed = runCommand(["exec", "node", "prisma/seed.mjs"]);
    expect(firstSeed.status, firstSeed.output).toBe(0);
    firstSeedCounts = await seedCounts();

    const secondSeed = runCommand(["exec", "node", "prisma/seed.mjs"]);
    expect(secondSeed.status, secondSeed.output).toBe(0);
    secondSeedCounts = await seedCounts();
  }, 180_000);

  afterAll(async () => {
    await client.end();
    if (!/^journey_task1_[a-f0-9]{32}$/.test(isolatedDatabaseName)) {
      throw new Error("Refusing to drop an unexpected journey test database.");
    }
    await cleanupClient.query(`DROP DATABASE IF EXISTS "${isolatedDatabaseName}" WITH (FORCE)`);
    await cleanupClient.end();
  });

  it("migrates the exact journey columns, PostgreSQL types, and nullability", async () => {
    const result = await client.query<{
      column_name: string;
      is_nullable: string;
      table_name: string;
      udt_name: string;
    }>(`
      SELECT table_name, column_name, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position
    `, [Object.keys(CATALOG_COLUMNS)]);

    for (const [tableName, expected] of Object.entries(CATALOG_COLUMNS)) {
      expect(
        result.rows
          .filter((row) => row.table_name === tableName)
          .map((row) => `${row.column_name}:${row.udt_name}:${row.is_nullable}`),
        tableName
      ).toEqual(expected);
    }
  });

  it("migrates exact unique and claim index definitions", async () => {
    const expected = {
      subscription_journey_application_id_key: [true, ["application_id"], null],
      subscription_journey_order_id_key: [true, ["order_id"], "(order_id IS NOT NULL)"],
      subscription_journey_step_code_key: [true, ["journey_id", "code"], null],
      subscription_journey_job_source_key_key: [true, ["source_key"], null],
      subscription_journey_open_manual_task_key: [
        true,
        ["journey_id", "task_type"],
        "(status = 'OPEN'::subscription_journey_manual_task_status)"
      ],
      subscription_journey_event_event_key_key: [true, ["event_key"], null],
      subscription_journey_event_sequence_key: [true, ["journey_id", "sequence"], null],
      subscription_journey_outbox_event_key_key: [true, ["event_key"], null],
      subscription_journey_job_claim_idx: [
        false,
        ["status", "available_at", "lease_expires_at"],
        null
      ],
      subscription_journey_outbox_claim_idx: [
        false,
        ["status", "available_at", "lease_expires_at"],
        null
      ]
    } as const;
    const result = await client.query<{
      columns: string[];
      index_name: string;
      is_unique: boolean;
      predicate: string | null;
    }>(`
      SELECT index_class.relname AS index_name,
             index_meta.indisunique AS is_unique,
             ARRAY(
               SELECT pg_get_indexdef(index_meta.indexrelid, position, true)
               FROM generate_series(1, index_meta.indnkeyatts) AS position
               ORDER BY position
             ) AS columns,
             pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate
      FROM pg_index index_meta
      JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
      JOIN pg_class table_class ON table_class.oid = index_meta.indrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = current_schema()
        AND index_class.relname = ANY($1::text[])
      ORDER BY index_class.relname
    `, [Object.keys(expected)]);

    expect(Object.fromEntries(result.rows.map((row) => [
      row.index_name,
      [row.is_unique, row.columns, row.predicate]
    ]))).toEqual(expected);
  });

  it("migrates composite candidate keys and journey-consistent foreign keys", async () => {
    const expected = {
      subscription_journey_step_id_journey_id_key: [
        "u",
        "subscription_journey_step",
        ["id", "journey_id"],
        null,
        []
      ],
      subscription_journey_job_identity_key: [
        "u",
        "subscription_journey_job",
        ["id", "step_id", "journey_id"],
        null,
        []
      ],
      subscription_journey_job_step_journey_fkey: [
        "f",
        "subscription_journey_job",
        ["step_id", "journey_id"],
        "subscription_journey_step",
        ["id", "journey_id"]
      ],
      subscription_journey_manual_task_step_journey_fkey: [
        "f",
        "subscription_journey_manual_task",
        ["step_id", "journey_id"],
        "subscription_journey_step",
        ["id", "journey_id"]
      ],
      subscription_journey_exception_step_journey_fkey: [
        "f",
        "subscription_journey_exception",
        ["step_id", "journey_id"],
        "subscription_journey_step",
        ["id", "journey_id"]
      ],
      subscription_journey_exception_job_identity_fkey: [
        "f",
        "subscription_journey_exception",
        ["job_id", "step_id", "journey_id"],
        "subscription_journey_job",
        ["id", "step_id", "journey_id"]
      ]
    };
    const constraints = await constraintCatalog(Object.keys(expected));

    expect(constraints).toEqual(expected);
  });

  it("rejects cross-journey step and job identities", async () => {
    const fixture = await createJourneyFixture();

    await expect(
      client.query(
        `INSERT INTO subscription_journey_job
          (id, journey_id, step_id, job_type, source_key, updated_at)
         VALUES ($1, $2, $3, 'VALIDATE_APPLICATION', $4, clock_timestamp())`,
        [`invalid-job-${fixture.suffix}`, fixture.journeyB, fixture.stepA, `invalid-job-${fixture.suffix}`]
      )
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query(
        `INSERT INTO subscription_journey_manual_task
          (id, journey_id, step_id, task_type, input_snapshot, updated_at)
         VALUES ($1, $2, $3, 'FINAL_PLAN_DECISION', '{}'::jsonb, clock_timestamp())`,
        [`invalid-task-${fixture.suffix}`, fixture.journeyB, fixture.stepA]
      )
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query(
        `INSERT INTO subscription_journey_exception
          (id, journey_id, step_id, code, message, updated_at)
         VALUES ($1, $2, $3, 'STEP_MISMATCH', 'safe', clock_timestamp())`,
        [`invalid-exception-step-${fixture.suffix}`, fixture.journeyB, fixture.stepA]
      )
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query(
        `INSERT INTO subscription_journey_exception
          (id, journey_id, step_id, job_id, code, message, updated_at)
         VALUES ($1, $2, $3, $4, 'JOB_MISMATCH', 'safe', clock_timestamp())`,
        [
          `invalid-exception-job-${fixture.suffix}`,
          fixture.journeyB,
          fixture.stepB,
          fixture.jobA
        ]
      )
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("seeds twice idempotently and persists the exact journey permission matrix", async () => {
    expect(secondSeedCounts).toEqual(firstSeedCounts);
    expect(secondSeedCounts).toMatchObject({
      journeyMenus: 1,
      journeyPermissions: 6,
      journeyRoleMenus: 4,
      journeyRolePermissions: 13
    });

    const result = await client.query<{ code: string; permissions: string[] }>(`
      SELECT role.code,
             COALESCE(
               array_agg(permission.code ORDER BY permission.code)
                 FILTER (WHERE permission.code IS NOT NULL),
               ARRAY[]::text[]
             ) AS permissions
      FROM role
      LEFT JOIN role_permission ON role_permission.role_id = role.id
        AND role_permission.deleted_at IS NULL
      LEFT JOIN permission ON permission.id = role_permission.permission_id
        AND permission.deleted_at IS NULL
        AND permission.code LIKE 'subscription_journey:%'
      GROUP BY role.code
      ORDER BY role.code::text
    `);

    expect(Object.fromEntries(result.rows.map((row) => [row.code, row.permissions]))).toEqual({
      ADMIN: [
        "subscription_journey:cancel",
        "subscription_journey:delivery_evidence_decide",
        "subscription_journey:plan_decide",
        "subscription_journey:recover",
        "subscription_journey:vehicle_allocate",
        "subscription_journey:view"
      ],
      AS: ["subscription_journey:view"],
      CS: [],
      FI: [],
      GM: [],
      OP: [
        "subscription_journey:delivery_evidence_decide",
        "subscription_journey:plan_decide",
        "subscription_journey:recover",
        "subscription_journey:vehicle_allocate",
        "subscription_journey:view"
      ],
      RC: [],
      SA: ["subscription_journey:view"]
    });
  });

  it("persists one Orders child filter and grants it only to approved roles", async () => {
    const menu = await client.query<{
      code: string;
      parent_code: string;
      path: string;
      permission_code: string;
    }>(`
      SELECT child.code, parent.code AS parent_code, child.path, child.permission_code
      FROM menu child
      JOIN menu parent ON parent.id = child.parent_id
      WHERE child.code = 'orders.journey_exceptions'
    `);
    expect(menu.rows).toEqual([
      {
        code: "orders.journey_exceptions",
        parent_code: "orders",
        path: "/orders?journeyStatus=EXCEPTION",
        permission_code: "subscription_journey:view"
      }
    ]);

    const grants = await client.query<{ code: string }>(`
      SELECT role.code
      FROM role_menu
      JOIN role ON role.id = role_menu.role_id
      JOIN menu ON menu.id = role_menu.menu_id
      WHERE role_menu.deleted_at IS NULL
        AND menu.code = 'orders.journey_exceptions'
      ORDER BY role.code::text
    `);
    expect(grants.rows.map((row) => row.code)).toEqual(["ADMIN", "AS", "OP", "SA"]);
  });
});

async function seedCounts() {
  const result = await client.query<{
    journey_menus: string;
    journey_permissions: string;
    journey_role_menus: string;
    journey_role_permissions: string;
    menus: string;
    permissions: string;
    role_menus: string;
    role_permissions: string;
  }>(`
    SELECT
      (SELECT count(*) FROM permission)::text AS permissions,
      (SELECT count(*) FROM menu)::text AS menus,
      (SELECT count(*) FROM role_permission WHERE deleted_at IS NULL)::text AS role_permissions,
      (SELECT count(*) FROM role_menu WHERE deleted_at IS NULL)::text AS role_menus,
      (SELECT count(*) FROM permission WHERE code LIKE 'subscription_journey:%')::text AS journey_permissions,
      (SELECT count(*) FROM menu WHERE code = 'orders.journey_exceptions')::text AS journey_menus,
      (SELECT count(*) FROM role_permission rp JOIN permission p ON p.id = rp.permission_id
        WHERE rp.deleted_at IS NULL AND p.code LIKE 'subscription_journey:%')::text AS journey_role_permissions,
      (SELECT count(*) FROM role_menu rm JOIN menu m ON m.id = rm.menu_id
        WHERE rm.deleted_at IS NULL AND m.code = 'orders.journey_exceptions')::text AS journey_role_menus
  `);
  const row = result.rows[0]!;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [camelCase(key), Number(value)])
  );
}

async function constraintCatalog(names: string[]) {
  const result = await client.query<{
    columns: string[];
    constraint_name: string;
    constraint_type: string;
    foreign_table: string | null;
    referenced_columns: string[];
    table_name: string;
  }>(`
    SELECT constraint_meta.conname AS constraint_name,
           constraint_meta.contype::text AS constraint_type,
           table_class.relname AS table_name,
           foreign_class.relname AS foreign_table,
           ARRAY(
             SELECT attribute.attname
             FROM unnest(constraint_meta.conkey) WITH ORDINALITY AS key(attnum, position)
             JOIN pg_attribute attribute
               ON attribute.attrelid = constraint_meta.conrelid
              AND attribute.attnum = key.attnum
             ORDER BY key.position
           )::text[] AS columns,
           (CASE WHEN constraint_meta.confrelid = 0 THEN ARRAY[]::text[] ELSE ARRAY(
             SELECT attribute.attname
             FROM unnest(constraint_meta.confkey) WITH ORDINALITY AS key(attnum, position)
             JOIN pg_attribute attribute
               ON attribute.attrelid = constraint_meta.confrelid
              AND attribute.attnum = key.attnum
             ORDER BY key.position
           ) END)::text[] AS referenced_columns
    FROM pg_constraint constraint_meta
    JOIN pg_class table_class ON table_class.oid = constraint_meta.conrelid
    JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
    LEFT JOIN pg_class foreign_class ON foreign_class.oid = constraint_meta.confrelid
    WHERE namespace.nspname = current_schema()
      AND constraint_meta.conname = ANY($1::text[])
    ORDER BY constraint_meta.conname
  `, [names]);

  return Object.fromEntries(result.rows.map((row) => [
    row.constraint_name,
    [
      row.constraint_type,
      row.table_name,
      row.columns,
      row.foreign_table,
      row.referenced_columns
    ]
  ]));
}

async function createJourneyFixture() {
  const suffix = randomUUID().replaceAll("-", "");
  const principals = await client.query<{ customer_id: string; user_id: string }>(`
    SELECT (SELECT id::text FROM customer ORDER BY created_at LIMIT 1) AS customer_id,
           (SELECT id::text FROM "user" ORDER BY created_at LIMIT 1) AS user_id
  `);
  const customerId = principals.rows[0]?.customer_id;
  const userId = principals.rows[0]?.user_id;
  if (!customerId || !userId) throw new Error("Seed principals are missing");
  const applicationA = randomUUID();
  const applicationB = randomUUID();
  const journeyA = `journey-a-${suffix}`;
  const journeyB = `journey-b-${suffix}`;
  const stepA = `step-a-${suffix}`;
  const stepB = `step-b-${suffix}`;
  const jobA = `job-a-${suffix}`;

  await client.query(
    `INSERT INTO application
      (id, application_no, customer_id, sales_user_id, updated_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, clock_timestamp()),
            ($5::uuid, $6, $3::uuid, $4::uuid, clock_timestamp())`,
    [
      applicationA,
      `APP-JA-${suffix}`,
      customerId,
      userId,
      applicationB,
      `APP-JB-${suffix}`
    ]
  );
  await client.query(
    `INSERT INTO subscription_journey
      (id, application_id, current_step_code, updated_at)
     VALUES ($1, $2::uuid, 'APPLICATION_VALIDATION', clock_timestamp()),
            ($3, $4::uuid, 'APPLICATION_VALIDATION', clock_timestamp())`,
    [journeyA, applicationA, journeyB, applicationB]
  );
  await client.query(
    `INSERT INTO subscription_journey_step
      (id, journey_id, code, updated_at)
     VALUES ($1, $2, 'APPLICATION_VALIDATION', clock_timestamp()),
            ($3, $4, 'APPLICATION_VALIDATION', clock_timestamp())`,
    [stepA, journeyA, stepB, journeyB]
  );
  await client.query(
    `INSERT INTO subscription_journey_job
      (id, journey_id, step_id, job_type, source_key, updated_at)
     VALUES ($1, $2, $3, 'VALIDATE_APPLICATION', $4, clock_timestamp())`,
    [jobA, journeyA, stepA, `valid-job-${suffix}`]
  );

  return { jobA, journeyA, journeyB, stepA, stepB, suffix };
}

function runCommand(args: string[]) {
  const executable = process.platform === "win32" ? process.execPath : "pnpm";
  const commandArgs = process.platform === "win32"
    ? [resolve(process.execPath, "..", "node_modules", "corepack", "dist", "pnpm.js"), ...args]
    : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: apiRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: isolatedDatabaseUrl
    },
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`,
    status: result.status
  };
}

function requiredDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for journey integration tests");
  const url = new URL(value);
  if (url.port !== "55432") throw new Error("Journey integration tests require port 55432");
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

function withDatabase(value: string, databaseName: string) {
  const url = new URL(value);
  url.pathname = `/${databaseName}`;
  url.searchParams.set("schema", "public");
  return url.toString();
}

function camelCase(value: string) {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
