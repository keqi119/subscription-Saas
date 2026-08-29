import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

import {
  STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET as TARGET,
  classifyStage1StagingInvalidTestOrderRetirement as classify
} from "./stage1-staging-invalid-test-order-retirement-core.mjs";
import { executeStage1StagingInvalidTestOrderRetirement as execute } from "./stage1-staging-invalid-test-order-retirement-executor.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
const { Pool } = requireFromApi("pg");
const operatorId = "11111111-1111-4111-8111-111111111111";
const databaseUrl = process.env.DATABASE_URL?.trim() ?? null;
const integrationTest = databaseUrl ? test : test.skip;

integrationTest(
  "real PostgreSQL serializes apply/replay and rolls back audit failure",
  async (t) => {
    const harness = await createPostgresHarness(databaseUrl);
    t.after(() => harness.close());

    const initial = await harness.snapshot();
    const evidenceDigest = classify(initial).evidenceDigest;
    const concurrent = await Promise.allSettled([
      harness.apply(evidenceDigest),
      harness.apply(evidenceDigest)
    ]);
    const fulfilled = concurrent.filter(({ status }) => status === "fulfilled");
    const rejected = concurrent.filter(({ status }) => status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(fulfilled[0].value.report.applied.ordersUpdated, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, "40001");
    assert.equal((await harness.snapshot()).auditLogs.length, 4);
    const replay = await harness.apply(evidenceDigest);
    assert.equal(replay.report.classification.disposition, "UNCHANGED");
    assert.equal(replay.report.applied.skippedUnchanged, 1);

    await harness.reset();
    harness.failAuditAt(4);
    await assert.rejects(harness.apply(evidenceDigest), /INJECTED_POSTGRES_AUDIT_FAILURE/);
    const rolledBack = await harness.snapshot();
    assert.equal(rolledBack.order.orderStatus, "ACTIVE");
    assert.equal(rolledBack.lease.status, "ACTIVE");
    assert.equal(rolledBack.billingSchedule.status, "PAUSED");
    assert.equal(rolledBack.vehicle.status, "LEASED");
    assert.equal(rolledBack.auditLogs.length, 0);
  }
);

async function createPostgresHarness(connectionString) {
  const pool = new Pool({ connectionString, max: 4 });
  const schema = `retirement_test_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quoteIdentifier(schema);
  let failAt = null;

  await pool.query(`CREATE SCHEMA ${quotedSchema}`);
  await pool.query(`
    CREATE TABLE ${quotedSchema}.target_state (
      entity text PRIMARY KEY,
      status text NOT NULL,
      version integer NOT NULL DEFAULT 0,
      cancelled_at timestamptz,
      pause_reason text
    )
  `);
  await pool.query(`
    CREATE TABLE ${quotedSchema}.retirement_audit (
      id bigserial PRIMARY KEY,
      data jsonb NOT NULL
    )
  `);
  await reset();

  return {
    apply,
    close,
    failAuditAt(value) {
      failAt = value;
    },
    reset,
    snapshot: () => readSnapshot(pool, quotedSchema)
  };

  async function apply(evidenceDigest) {
    return execute({
      assertDatabaseIdentity: async (tx) => {
        const rows = await tx.$queryRawUnsafe('SELECT current_database() AS "databaseName"');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].databaseName, new URL(connectionString).pathname.slice(1));
      },
      expectedEvidenceDigest: evidenceDigest,
      generatedAt: "2026-08-29T00:00:00.000Z",
      loadSnapshot: (tx) => readSnapshot(tx.$testClient, quotedSchema),
      mode: "apply",
      now: () => new Date("2026-08-29T00:00:00.000Z"),
      operatorId,
      prisma: postgresPrisma(pool, quotedSchema, () => failAt),
      randomUuid: () => "22222222-2222-4222-8222-222222222222"
    });
  }

  async function reset() {
    failAt = null;
    await pool.query(`TRUNCATE ${quotedSchema}.retirement_audit`);
    await pool.query(`TRUNCATE ${quotedSchema}.target_state`);
    await pool.query(
      `INSERT INTO ${quotedSchema}.target_state (entity, status, version, pause_reason)
       VALUES
         ('billing_schedule', 'PAUSED', 0, 'legacy-test-order'),
         ('lease', 'ACTIVE', 0, NULL),
         ('subscription_order', 'ACTIVE', 0, NULL),
         ('vehicle', 'LEASED', 0, NULL)`
    );
  }

  async function close() {
    await pool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
    await pool.end();
  }
}

function postgresPrisma(pool, schema, getFailAt) {
  return {
    async $transaction(work, options) {
      assert.equal(options.isolationLevel, "Serializable");
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const result = await work(postgresTransaction(client, schema, getFailAt));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

function postgresTransaction(client, schema, getFailAt) {
  let auditAttempts = 0;
  return {
    $queryRawUnsafe: async (query, ...params) => (await client.query(query, params)).rows,
    $testClient: client,
    auditLog: {
      create: async ({ data }) => {
        auditAttempts += 1;
        if (auditAttempts === getFailAt()) throw new Error("INJECTED_POSTGRES_AUDIT_FAILURE");
        await client.query(`INSERT INTO ${schema}.retirement_audit (data) VALUES ($1::jsonb)`, [
          JSON.stringify(data)
        ]);
        return data;
      }
    },
    billingSchedule: {
      updateMany: ({ data, where }) =>
        updateState(client, schema, "billing_schedule", data, {
          cancelledAt: where.cancelledAt,
          lastGeneratedBillId: where.lastGeneratedBillId,
          status: where.status,
          version: where.version
        })
    },
    lease: {
      updateMany: ({ data, where }) => updateState(client, schema, "lease", data, where)
    },
    subscriptionOrder: {
      updateMany: ({ data, where }) =>
        updateState(
          client,
          schema,
          "subscription_order",
          { ...data, status: data.orderStatus },
          where
        )
    },
    vehicle: {
      updateMany: ({ data, where }) => updateState(client, schema, "vehicle", data, where)
    }
  };
}

async function updateState(client, schema, entity, data, where) {
  const current = await client.query(
    `SELECT status, version, cancelled_at, pause_reason
       FROM ${schema}.target_state WHERE entity = $1 FOR UPDATE`,
    [entity]
  );
  const row = current.rows[0];
  if (!row || (where.status !== undefined && row.status !== where.status)) return { count: 0 };
  if (where.version !== undefined && row.version !== where.version) return { count: 0 };
  if (where.cancelledAt !== undefined && iso(row.cancelled_at) !== iso(where.cancelledAt)) {
    return { count: 0 };
  }
  if (where.lastGeneratedBillId !== undefined && where.lastGeneratedBillId !== null) {
    return { count: 0 };
  }

  const status = data.status ?? row.status;
  const version = row.version + (data.version?.increment ?? 0);
  const cancelledAt = data.cancelledAt ?? row.cancelled_at;
  const pauseReason = data.pauseReason ?? row.pause_reason;
  await client.query(
    `UPDATE ${schema}.target_state
       SET status = $2, version = $3, cancelled_at = $4, pause_reason = $5
       WHERE entity = $1`,
    [entity, status, version, cancelledAt, pauseReason]
  );
  return { count: 1 };
}

async function readSnapshot(client, schema) {
  const stateResult = await client.query(
    `SELECT entity, status, version, cancelled_at, pause_reason
       FROM ${schema}.target_state ORDER BY entity`
  );
  const auditResult = await client.query(`SELECT data FROM ${schema}.retirement_audit ORDER BY id`);
  const states = new Map(stateResult.rows.map((row) => [row.entity, row]));
  const schedule = states.get("billing_schedule");
  return {
    auditLogs: auditResult.rows.map(({ data }) => data),
    billingSchedule: {
      cancelledAt: schedule.cancelled_at,
      id: "36054e6d-5104-4daf-b8a7-cb7e956fc436",
      lastGeneratedBillId: null,
      orderId: TARGET.orderId,
      pauseReason: schedule.pause_reason,
      status: schedule.status,
      version: schedule.version
    },
    blockingCounts: emptyBlockingCounts(),
    evidenceReferences: {
      contracts: [],
      eSignTasks: [],
      evidenceFiles: [],
      evidenceItems: [],
      fileObjects: [],
      handovers: [],
      handoverWorkOrders: [],
      handoverWorkflowJobs: []
    },
    lease: {
      activatedAt: new Date("2026-07-31T03:01:04.000Z"),
      deletedAt: null,
      id: "44444444-4444-4444-8444-444444444444",
      orderId: TARGET.orderId,
      status: states.get("lease").status
    },
    operator: {
      deletedAt: null,
      id: operatorId,
      roles: [{ code: "ADMIN", deletedAt: null, roleDeletedAt: null, roleStatus: "ACTIVE" }],
      status: "ACTIVE"
    },
    order: {
      actualDeliveryAt: new Date("2026-07-31T03:01:04.000Z"),
      actualReturnAt: null,
      contractId: null,
      deletedAt: null,
      endDate: null,
      id: TARGET.orderId,
      orderNo: TARGET.orderNo,
      orderStatus: states.get("subscription_order").status,
      startDate: null,
      vehicleId: TARGET.vehicleId
    },
    vehicle: {
      activeOtherLeases: [],
      activeOtherOrders: [],
      activeRestrictions: [],
      activeSubscriptionPeriods: [],
      currentSalePriceAmount: 18500000n,
      deletedAt: null,
      id: TARGET.vehicleId,
      salePriceStatus: "EFFECTIVE",
      status: states.get("vehicle").status,
      vehicleNo: TARGET.vehicleNo,
      vin: TARGET.vin
    },
    vehicleDeliveries: []
  };
}

function emptyBlockingCounts() {
  return Object.fromEntries(
    [
      "assetWorkOrders",
      "automationJobs",
      "closureCases",
      "collectionActions",
      "collectionCaseBills",
      "collectionCases",
      "contractSegments",
      "costLedgerEntries",
      "debitAttempts",
      "depositLedgers",
      "entitlementAccounts",
      "entitlementGrants",
      "entitlementUsages",
      "insuranceClaims",
      "mileageReadings",
      "mileageReviews",
      "orderChanges",
      "paymentMandates",
      "paymentOrders",
      "paymentRecords",
      "paymentWriteOffs",
      "receivableBills",
      "renewalConsiderations",
      "returnDamages",
      "returns",
      "revenueRightAssignments",
      "serviceCases",
      "subscriptionChanges",
      "subscriptionPeriods"
    ].map((field) => [field, 0])
  );
}

function quoteIdentifier(value) {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error("INVALID_TEST_SCHEMA");
  return `"${value}"`;
}

function iso(value) {
  if (value == null) return null;
  return new Date(value).toISOString();
}
