import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
const runbookPath = resolve(
  repoRoot,
  "docs/runbooks/stage1-p0-subscription-closure-rollout.zh-CN.md"
);
const controllerPath = resolve(
  repoRoot,
  "apps/api/src/subscription-closure/subscription-closure.controller.ts"
);
const sharedAuthPath = resolve(repoRoot, "packages/shared/src/auth.ts");
const accessCorePath = resolve(repoRoot, "scripts/stage1-p0-closure-access-core.mjs");
const packagePath = resolve(repoRoot, "package.json");
const reconciliationDatabaseUrl =
  process.env.STAGE1_P0_CLOSURE_RECONCILIATION_DATABASE_URL?.trim() ?? null;
if (reconciliationDatabaseUrl) assertSafeReconciliationDatabaseUrl(reconciliationDatabaseUrl);

const sqlBlockOrder = [
  "01-migration-catalog",
  "02-permission-matrix",
  "03-schema-catalog",
  "04-case-state-integrity",
  "05-source-receipt-integrity",
  "06-physical-occupancy-integrity",
  "07-work-order-restriction-integrity",
  "08-settlement-financial-integrity",
  "09-approval-snapshot-integrity",
  "10-projection-integrity",
  "11-audit-integrity",
  "12-fixture-residue"
];

const permissionCodes = [
  "subscription_closure:view",
  "subscription_closure:prepare",
  "subscription_closure:receive",
  "subscription_closure:inspect",
  "subscription_closure:settle",
  "subscription_recovery:assess",
  "subscription_recovery:approve",
  "subscription_recovery:execute",
  "subscription_early_termination:create",
  "subscription_early_termination:execute"
];

const routeInventory = [
  "GET ",
  "GET :id",
  "GET :id/evidence-packages/:exportId/download",
  "GET :id/return-evidence/:linkId/download",
  "GET :id/return-evidence/:linkId/preview",
  "GET :id/return-manifest/signed-document/preview",
  "GET by-order/:orderId",
  "POST :id/approval-requests",
  "POST :id/approvals/:approvalId/decision",
  "POST :id/customer-no-response",
  "POST :id/disputes/:disputeId/decision",
  "POST :id/early-termination/cancel",
  "POST :id/early-termination/execute",
  "POST :id/evidence-packages",
  "POST :id/financial-proofs/upload",
  "POST :id/inspection",
  "POST :id/inventory-release",
  "POST :id/legal-collection",
  "POST :id/legal-collection/events",
  "POST :id/operational-completion",
  "POST :id/pricing",
  "POST :id/receivable-dispositions",
  "POST :id/recovery/actions",
  "POST :id/recovery/approval-requests",
  "POST :id/recovery/approvals/:approvalId/decision",
  "POST :id/recovery/execute",
  "POST :id/recovery/execution-records",
  "POST :id/return-checklists",
  "POST :id/return-deltas",
  "POST :id/return-deltas/confirm",
  "POST :id/return-evidence/upload",
  "POST :id/return-manifest-signing/cancel",
  "POST :id/settlements/finalize",
  "POST :id/settlements/propose",
  "POST :id/settlements/settle",
  "POST early-terminations",
  "POST orders/:orderId/physical-receipt"
];

const requiredSqlFragments = {
  "01-migration-catalog": [
    "FROM _prisma_migrations",
    "rolled_back_migration_count",
    "failed_or_incomplete_migration_count",
    "20260822030000_stage1_p0_return_manifest_esign_durability"
  ],
  "02-permission-matrix": [
    "expected_permission",
    "expected_grant",
    "permission_definition_anomaly_count",
    "role_grant_anomaly_count",
    "subscription_early_termination:execute"
  ],
  "03-schema-catalog": [
    "pg_trigger",
    "pg_constraint",
    "subscription_closure_settlement_chronology",
    "subscription_closure_case_order_id_key",
    "schema_object_anomaly_count"
  ],
  "04-case-state-integrity": [
    "multiple_active_case_count",
    "retired_case_shape_anomaly_count",
    "terminal_settlement_anomaly_count",
    "authority_projection_anomaly_count"
  ],
  "05-source-receipt-integrity": [
    "receipt_event_anomaly_count",
    "event_without_receipt_count",
    "payload_hash_anomaly_count"
  ],
  "06-physical-occupancy-integrity": [
    "physical_return_anomaly_count",
    "subscription_period_anomaly_count",
    "active_period_after_physical_control_count"
  ],
  "07-work-order-restriction-integrity": [
    "work_order_authority_anomaly_count",
    "restriction_link_anomaly_count",
    "restriction_source_anomaly_count"
  ],
  "08-settlement-financial-integrity": [
    "settlement_chain_anomaly_count",
    "terminal_financial_resolution_anomaly_count",
    "approval_link_anomaly_count"
  ],
  "09-approval-snapshot-integrity": [
    "approval_subject_anomaly_count",
    "approval_actor_anomaly_count",
    "approval_hash_shape_anomaly_count"
  ],
  "10-projection-integrity": [
    "order_contract_lease_anomaly_count",
    "pre_settlement_projection_anomaly_count"
  ],
  "11-audit-integrity": ["event_audit_anomaly_count", "terminal_projection_audit_anomaly_count"],
  "12-fixture-residue": [
    "fixture_source_residue_count",
    "fixture_job_residue_count",
    "other_nonidle_session_count",
    "waiting_lock_count",
    "prepared_transaction_count"
  ]
};

const expectedCountValues = {
  "01-migration-catalog": {
    failed_or_incomplete_migration_count: "0",
    expected_stage1_p0_applied_count: "8"
  },
  "02-permission-matrix": {
    expected_permission_count: "10",
    expected_grant_count: "32",
    permission_definition_anomaly_count: "0",
    role_grant_anomaly_count: "0"
  },
  "03-schema-catalog": {
    schema_object_anomaly_count: "0",
    expected_relation_count: "6",
    expected_trigger_count: "8"
  }
};

async function readRequired(path) {
  return readFile(path, "utf8");
}

function extractMarkedSqlBlocks(runbook) {
  const blocks = new Map();
  const pattern =
    /<!-- stage1-p0-reconcile:([a-z0-9-]+):start -->\s*```sql\s*([\s\S]*?)```\s*<!-- stage1-p0-reconcile:\1:end -->/g;
  for (const match of runbook.matchAll(pattern)) blocks.set(match[1], match[2].trim());
  return blocks;
}

function validateRunbookSql(runbook) {
  const blocks = extractMarkedSqlBlocks(runbook);
  assert.deepEqual([...blocks.keys()], sqlBlockOrder, "SQL block inventory/order drift");
  for (const name of sqlBlockOrder) {
    const sql = blocks.get(name);
    assert.ok(sql, `${name} is missing`);
    assert.match(sql, /^BEGIN TRANSACTION READ ONLY;/, `${name} is not independently read-only`);
    assert.match(sql, /COMMIT;$/, `${name} has no independent COMMIT`);
    assert.doesNotMatch(
      sql,
      /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|CALL|DO|COPY)\b/im,
      `${name} contains a write-capable statement`
    );
    for (const fragment of requiredSqlFragments[name]) {
      assert.ok(sql.includes(fragment), `${name} is missing ${fragment}`);
    }
  }
  return blocks;
}

function validateApiInventory(controller, sharedAuth, accessCore, packageJsonText) {
  const routes = [...controller.matchAll(/@(Get|Post|Put|Patch|Delete)\((?:"([^"]*)")?\)/g)]
    .map(([, method, path = ""]) => `${method.toUpperCase()} ${path}`)
    .sort();
  assert.deepEqual(routes, [...routeInventory].sort(), "closure API route inventory drift");

  const definitions = [...accessCore.matchAll(/definition\(\s*"([^"]+)"/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(definitions, permissionCodes, "closure permission definition inventory drift");
  const sharedCodes = [
    ...sharedAuth.matchAll(
      /SUBSCRIPTION_(?:CLOSURE|RECOVERY|EARLY_TERMINATION)_[A-Z_]+\s*=\s*"([^"]+)"/g
    )
  ].map((match) => match[1]);
  assert.deepEqual(sharedCodes, permissionCodes, "shared auth permission inventory drift");

  const packageJson = JSON.parse(packageJsonText);
  assert.equal(
    packageJson.scripts["stage1:p0-closure:reconcile"],
    "node --test scripts/stage1-p0-subscription-closure-reconciliation.test.mjs"
  );
}

function validateSanitizedCounts(name, row) {
  for (const [field, expected] of Object.entries(expectedCountValues[name] ?? {})) {
    assert.equal(row[field], expected, `${name}.${field} drifted`);
  }
  for (const [field, value] of Object.entries(row)) {
    if (
      /(?:anomaly|residue|session|lock|transaction)_count$/.test(field) ||
      field === "multiple_active_case_count" ||
      field === "active_period_after_physical_control_count"
    ) {
      assert.equal(value, "0", `${name}.${field} must be zero`);
    }
  }
  if (name === "01-migration-catalog") {
    assert.match(row.applied_migration_count, /^\d+$/);
    assert.ok(
      Number(row.applied_migration_count) >= Number(row.expected_stage1_p0_applied_count),
      "01-migration-catalog.applied_migration_count cannot be below the required Stage 1 P0 set"
    );
    assert.match(row.rolled_back_migration_count, /^\d+$/);
    assert.match(row.migration_catalog_fingerprint, /^[0-9a-f]{32}$/);
  }
}

function assertSafeReconciliationDatabaseUrl(value) {
  const databaseName = decodeURIComponent(new URL(value).pathname.slice(1));
  if (
    databaseName !== "subscription_saas_staging" &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*_(test|codex)$/.test(databaseName)
  ) {
    throw new Error("STAGE1_P0_CLOSURE_RECONCILIATION_DATABASE_REQUIRED");
  }
}

function mutateSqlBlock(runbook, name, mutate) {
  const blocks = extractMarkedSqlBlocks(runbook);
  const sql = blocks.get(name);
  assert.ok(sql, `${name} is missing before mutation`);
  const changed = mutate(sql);
  assert.notEqual(changed, sql, `${name} mutation was inoperative`);
  return runbook.replace(sql, () => changed);
}

test("freezes the exact read-only SQL, API, permission, and package inventories", async () => {
  const [runbook, controller, sharedAuth, accessCore, packageJson] = await Promise.all([
    readRequired(runbookPath),
    readRequired(controllerPath),
    readRequired(sharedAuthPath),
    readRequired(accessCorePath),
    readRequired(packagePath)
  ]);
  validateRunbookSql(runbook);
  validateApiInventory(controller, sharedAuth, accessCore, packageJson);
});

test("mutation-tests the actual SQL and exact API/permission inventories", async () => {
  const [runbook, controller, sharedAuth, accessCore, packageJson] = await Promise.all([
    readRequired(runbookPath),
    readRequired(controllerPath),
    readRequired(sharedAuthPath),
    readRequired(accessCorePath),
    readRequired(packagePath)
  ]);
  const writable = mutateSqlBlock(runbook, "04-case-state-integrity", (sql) =>
    sql.replace("BEGIN TRANSACTION READ ONLY;", "BEGIN;")
  );
  assert.throws(() => validateRunbookSql(writable), /not independently read-only/);

  const blindReceipt = mutateSqlBlock(runbook, "05-source-receipt-integrity", (sql) =>
    sql.replace("receipt_event_anomaly_count", "receipt_event_count")
  );
  assert.throws(() => validateRunbookSql(blindReceipt), /receipt_event_anomaly_count/);

  assert.throws(
    () =>
      validateApiInventory(
        controller.replace('@Post(":id/recovery/execute")', '@Post(":id/recovery/run")'),
        sharedAuth,
        accessCore,
        packageJson
      ),
    /route inventory drift/
  );
  assert.throws(
    () =>
      validateApiInventory(
        controller,
        sharedAuth,
        accessCore.replace(
          'definition("subscription_closure:view"',
          'definition("subscription_closure:read"'
        ),
        packageJson
      ),
    /permission definition inventory drift/
  );
  assert.throws(
    () =>
      validateApiInventory(
        controller,
        sharedAuth.replace(
          'SUBSCRIPTION_RECOVERY_EXECUTE = "subscription_recovery:execute"',
          'SUBSCRIPTION_RECOVERY_EXECUTE = "subscription_recovery:run"'
        ),
        accessCore,
        packageJson
      ),
    /shared auth permission inventory drift/
  );
});

test("validates the migration catalog as an append-only inventory", () => {
  assert.doesNotThrow(() =>
    validateSanitizedCounts("01-migration-catalog", {
      applied_migration_count: "124",
      expected_stage1_p0_applied_count: "8",
      failed_or_incomplete_migration_count: "0",
      migration_catalog_fingerprint: "a".repeat(32),
      rolled_back_migration_count: "0"
    })
  );
  assert.throws(
    () =>
      validateSanitizedCounts("01-migration-catalog", {
        applied_migration_count: "7",
        expected_stage1_p0_applied_count: "8",
        failed_or_incomplete_migration_count: "0",
        migration_catalog_fingerprint: "a".repeat(32),
        rolled_back_migration_count: "0"
      }),
    /cannot be below the required Stage 1 P0 set/
  );
});

test("requires an explicit Local/Staging database for live reconciliation", () => {
  for (const database of [
    "subscription_saas_test",
    "subscription_saas_codex",
    "subscription_saas_staging"
  ]) {
    assert.doesNotThrow(() =>
      assertSafeReconciliationDatabaseUrl(
        `postgresql://postgres:postgres@localhost:5432/${database}?schema=public`
      )
    );
  }
  assert.throws(
    () =>
      assertSafeReconciliationDatabaseUrl(
        "postgresql://postgres:postgres@localhost:5432/subscription_saas?schema=public"
      ),
    /STAGE1_P0_CLOSURE_RECONCILIATION_DATABASE_REQUIRED/
  );
});

test(
  "executes every marked block verbatim and emits sanitized counts only",
  { skip: !reconciliationDatabaseUrl },
  async (context) => {
    const runbook = await readRequired(runbookPath);
    const blocks = validateRunbookSql(runbook);
    const { Client } = requireFromApi("pg");
    const client = new Client({ connectionString: reconciliationDatabaseUrl });
    await client.connect();
    try {
      for (const name of sqlBlockOrder) {
        const result = await client.query(blocks.get(name));
        const results = Array.isArray(result) ? result : [result];
        const selected = results.find((entry) => entry.command === "SELECT");
        assert.ok(selected, `${name} returned no SELECT result`);
        assert.equal(selected.rows.length, 1, `${name} must return one sanitized count row`);
        validateSanitizedCounts(name, selected.rows[0]);
        context.diagnostic(`${name}: rows=1 fields=${selected.fields.length}`);
      }
    } finally {
      await client.end();
    }
  }
);

export { extractMarkedSqlBlocks, validateApiInventory, validateRunbookSql };
