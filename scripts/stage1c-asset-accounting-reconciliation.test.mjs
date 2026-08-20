import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const rolloutPath = resolve(repoRoot, "docs/runbooks/stage1c-asset-accounting-rollout.zh-CN.md");
const operationsRunbookPath = resolve(
  repoRoot,
  "docs/runbooks/stage1c-asset-operations-rollout.zh-CN.md"
);
const schemaPath = resolve(repoRoot, "apps/api/prisma/schema.prisma");
const controllerPath = resolve(
  repoRoot,
  "apps/api/src/asset-accounting/asset-accounting.controller.ts"
);
const sharedAuthPath = resolve(repoRoot, "packages/shared/src/auth.ts");
const accessCorePath = resolve(repoRoot, "scripts/stage1c-access-baseline-core.mjs");
const accessExecutorPath = resolve(repoRoot, "scripts/stage1c-access-baseline-executor.mjs");

const sqlBlockOrder = [
  "01-migration-catalog",
  "02-permission-matrix",
  "03-database-catalog",
  "04-receipt-integrity",
  "05-ledger-integrity",
  "06-approval-integrity",
  "07-audit-integrity",
  "08-closed-cost-integrity"
];

const catalogDefinitionDigests = {
  expected_constraint_raw: "80cc92be6a2bdaa7da22b8258bee443435b6aba87224e9a1e86e395060442adb",
  expected_function_raw: "80ae1c8e2a4386ef3f2c80cacbcfc4c63c0cc1af8f8e4bdd099be5ea663fa8a5",
  expected_index_raw: "6c60ebf5e65ff483d4fb0934924ff882ed9f53e877618caad36e12e0d995c875",
  expected_trigger_raw: "4e7c1e0270d318a67d339e8af5ae3b2ffc8b645912138d7985ceaaa9df968482"
};

const authorityEvaluationContract = `
SELECT
  candidate.*,
  (
    candidate.missing_vehicle
    OR candidate.missing_order
    OR candidate.missing_contract
    OR candidate.missing_customer
    OR candidate.missing_owner
    OR candidate.missing_work_order
    OR candidate.missing_evidence
    OR candidate.missing_confirmer
    OR candidate.missing_responsible_customer
    OR candidate.missing_responsible_owner
    OR candidate.evidence_work_order_mismatch
    OR candidate.responsible_customer_mismatch
    OR candidate.responsible_owner_mismatch
  ) AS is_anomaly
FROM authority_candidate AS candidate
`;

const stage1cCEnums = {
  VehicleCostEntryKind: ["ORIGINAL", "REVERSAL"],
  VehicleCostActionType: [
    "ACTUAL_COST",
    "RESPONSIBILITY_CONFIRMED",
    "RECOVERY_EXPOSURE",
    "RECOVERY_RECEIVED",
    "WAIVER",
    "WRITE_OFF"
  ],
  VehicleCostCategory: [
    "DAMAGE",
    "CLEANING",
    "REPAIR",
    "MAINTENANCE",
    "EXCESS_MILEAGE",
    "VIOLATION",
    "TOWING",
    "INSURANCE",
    "BAAS",
    "DEPRECIATION",
    "OTHER"
  ],
  VehicleCostResponsiblePartyType: [
    "CUSTOMER",
    "INSURER",
    "SUPPLIER",
    "ASSET_OWNER",
    "PLATFORM",
    "OTHER"
  ],
  BusinessExceptionType: [
    "VEHICLE_REGISTRATION_DOCUMENT_MISSING",
    "HANDOVER_EVIDENCE_EXCEPTION",
    "SETTLEMENT_WAIVER",
    "SETTLEMENT_WRITE_OFF",
    "RECOVERY_EXECUTION_APPROVAL"
  ],
  BusinessExceptionSubjectType: [
    "VEHICLE",
    "ORDER",
    "CONTRACT",
    "ASSET_WORK_ORDER",
    "HANDOVER_WORK_ORDER",
    "SETTLEMENT_CASE",
    "RECOVERY_CASE"
  ],
  BusinessExceptionApprovalStatus: ["PENDING", "APPROVED", "REJECTED", "EXPIRED"],
  BusinessExceptionDecision: ["APPROVED", "REJECTED"],
  AssetAccountingCommandType: [
    "COST_APPEND",
    "COST_REVERSE",
    "EXCEPTION_REQUEST",
    "EXCEPTION_DECIDE",
    "EXCEPTION_EXPIRE"
  ]
};

const permissionDefinitions = [
  ["vehicle_cost_ledger:view", "查看车辆成本台账", "vehicle_cost_ledger", "view"],
  ["vehicle_cost_ledger:confirm", "确认车辆成本台账", "vehicle_cost_ledger", "confirm"],
  ["vehicle_cost_ledger:reverse", "冲正车辆成本台账", "vehicle_cost_ledger", "reverse"],
  ["business_exception:view", "查看业务例外审批", "business_exception", "view"],
  ["business_exception:request", "发起业务例外审批", "business_exception", "request"],
  ["business_exception:approve", "审批业务例外", "business_exception", "approve"]
];

const foreignKeyDefinitions = [
  [
    "vehicle_cost_ledger_entry_vehicle_id_fkey",
    "vehicle_cost_ledger_entry",
    "vehicle_id",
    "vehicle",
    "id",
    "r"
  ],
  [
    "vehicle_cost_ledger_entry_order_id_fkey",
    "vehicle_cost_ledger_entry",
    "order_id",
    "subscription_order",
    "id",
    "r"
  ],
  [
    "vehicle_cost_ledger_entry_contract_id_fkey",
    "vehicle_cost_ledger_entry",
    "contract_id",
    "contract",
    "id",
    "r"
  ],
  [
    "vehicle_cost_ledger_entry_customer_id_fkey",
    "vehicle_cost_ledger_entry",
    "customer_id",
    "customer",
    "id",
    "r"
  ],
  [
    "vehicle_cost_ledger_entry_asset_owner_id_fkey",
    "vehicle_cost_ledger_entry",
    "asset_owner_id",
    "asset_owner",
    "id",
    "r"
  ],
  [
    "vehicle_cost_ledger_entry_work_order_id_fkey",
    "vehicle_cost_ledger_entry",
    "work_order_id",
    "asset_work_order",
    "id",
    "r"
  ],
  [
    "vehicle_cost_ledger_entry_evidence_id_fkey",
    "vehicle_cost_ledger_entry",
    "evidence_id",
    "asset_work_order_evidence",
    "id",
    "r"
  ],
  [
    "vehicle_cost_ledger_entry_confirmed_by_fkey",
    "vehicle_cost_ledger_entry",
    "confirmed_by",
    "user",
    "id",
    "r"
  ],
  [
    "vehicle_cost_ledger_entry_reversal_of_entry_id_fkey",
    "vehicle_cost_ledger_entry",
    "reversal_of_entry_id",
    "vehicle_cost_ledger_entry",
    "id",
    "r"
  ],
  [
    "business_exception_approval_requested_by_fkey",
    "business_exception_approval",
    "requested_by",
    "user",
    "id",
    "r"
  ],
  [
    "business_exception_approval_decided_by_fkey",
    "business_exception_approval",
    "decided_by",
    "user",
    "id",
    "r"
  ],
  [
    "business_exception_approval_expired_by_fkey",
    "business_exception_approval",
    "expired_by",
    "user",
    "id",
    "r"
  ],
  [
    "asset_accounting_command_receipt_cost_entry_id_fkey",
    "asset_accounting_command_receipt",
    "cost_entry_id",
    "vehicle_cost_ledger_entry",
    "id",
    "r"
  ],
  [
    "asset_accounting_command_receipt_approval_id_fkey",
    "asset_accounting_command_receipt",
    "approval_id",
    "business_exception_approval",
    "id",
    "r"
  ],
  [
    "asset_accounting_command_receipt_actor_id_fkey",
    "asset_accounting_command_receipt",
    "actor_id",
    "user",
    "id",
    "r"
  ]
];

const allStage1cPermissions = [
  "asset_facts:view",
  "asset_owner:manage",
  "vehicle_period:manage",
  "asset_operations:view",
  "asset_work_order:manage",
  "vehicle_restriction:manage",
  "vehicle_restriction:release",
  "vehicle_restriction:approve_release",
  ...permissionDefinitions.map(([code]) => code)
];

const roleMatrix = {
  ADMIN: allStage1cPermissions,
  AS: [
    "asset_facts:view",
    "asset_owner:manage",
    "vehicle_period:manage",
    "asset_operations:view",
    "asset_work_order:manage",
    "vehicle_restriction:manage",
    "vehicle_restriction:release",
    "vehicle_restriction:approve_release",
    "vehicle_cost_ledger:view",
    "vehicle_cost_ledger:confirm",
    "business_exception:view",
    "business_exception:request"
  ],
  OP: [
    "asset_facts:view",
    "vehicle_period:manage",
    "asset_operations:view",
    "asset_work_order:manage",
    "vehicle_restriction:manage",
    "vehicle_restriction:release",
    "vehicle_cost_ledger:view",
    "vehicle_cost_ledger:confirm",
    "business_exception:view",
    "business_exception:request"
  ],
  FI: [
    "asset_facts:view",
    "asset_operations:view",
    "vehicle_cost_ledger:view",
    "vehicle_cost_ledger:confirm",
    "vehicle_cost_ledger:reverse",
    "business_exception:view",
    "business_exception:request"
  ],
  GM: [
    "asset_facts:view",
    "asset_operations:view",
    "vehicle_restriction:approve_release",
    "vehicle_cost_ledger:view",
    "vehicle_cost_ledger:reverse",
    "business_exception:view",
    "business_exception:approve"
  ],
  RC: [
    "asset_operations:view",
    "vehicle_cost_ledger:view",
    "business_exception:view",
    "business_exception:request"
  ],
  SA: [],
  CS: []
};

async function readOrEmpty(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function assertIncludesEvery(contents, values) {
  for (const value of values) assert.ok(contents.includes(value), `missing contract: ${value}`);
}

function markdownRows(contents) {
  return new Set(
    contents
      .split(/\r?\n/)
      .filter((line) => line.startsWith("|") && line.endsWith("|"))
      .map((line) =>
        line
          .slice(1, -1)
          .split("|")
          .map((cell) => cell.trim())
          .join("|")
      )
  );
}

function extractMarkedSqlBlocks(contents) {
  const blocks = [
    ...contents.matchAll(
      /<!-- stage1c-accounting-sql:([a-z0-9-]+) -->\r?\n(?:\r?\n)?```sql\r?\n([\s\S]*?)```/g
    )
  ].map((match) => ({ name: match[1], sql: match[2].trim() }));
  const allSqlFences = [...contents.matchAll(/```sql\r?\n([\s\S]*?)```/g)];

  assert.equal(allSqlFences.length, 8, "the runbook must contain exactly eight SQL fences");
  assert.deepEqual(
    blocks.map(({ name }) => name),
    sqlBlockOrder,
    "SQL markers must be unique, complete, and in approved order"
  );
  return new Map(blocks.map(({ name, sql }) => [name, sql]));
}

function requireSqlFragments(blocks, name, fragments) {
  const sql = blocks.get(name);
  assert.ok(sql, `missing SQL block ${name}`);
  const normalized = normalizeSql(sql);
  for (const fragment of fragments) {
    assert.ok(
      normalized.includes(normalizeSql(fragment)),
      `${name} missing SQL contract: ${fragment}`
    );
  }
}

function requireSqlInvariant(blocks, name, invariant, fragments) {
  const sql = blocks.get(name);
  assert.ok(sql, `${invariant}: missing SQL block ${name}`);
  const normalized = normalizeSql(sql);
  for (const fragment of fragments) {
    assert.ok(
      normalized.includes(normalizeSql(fragment)),
      `${invariant}: ${name} missing ${fragment}`
    );
  }
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function extractCatalogCteBody(sql, cteName, nextCteName) {
  const match = sql.match(
    new RegExp(
      `${cteName}\\([^)]*\\)\\s+AS\\s*\\(\\n([\\s\\S]*?)\\n\\),\\s+${nextCteName}(?:\\([^)]*\\))?\\s+AS\\s*\\(`
    )
  );
  assert.ok(match, `missing or unbounded catalog CTE: ${cteName}`);
  return normalizeSql(match[1]);
}

function extractBoundedCteBody(sql, cteName, nextCteName) {
  const match = sql.match(
    new RegExp(
      `${cteName}(?:\\([^)]*\\))?\\s+AS\\s*\\(\\n([\\s\\S]*?)\\n\\),\\s+${nextCteName}(?:\\([^)]*\\))?\\s+AS\\s*\\(`
    )
  );
  assert.ok(match, `missing or unbounded SQL CTE: ${cteName}`);
  return normalizeSql(match[1]);
}

function validateCatalogDefinitionDigests(blocks) {
  const sql = blocks.get("03-database-catalog");
  assert.ok(sql);
  const boundaries = {
    expected_constraint_raw: "expected_constraint",
    expected_function_raw: "expected_function",
    expected_index_raw: "expected_index",
    expected_trigger_raw: "expected_trigger"
  };
  for (const [cteName, expectedDigest] of Object.entries(catalogDefinitionDigests)) {
    assert.equal(
      sha256(extractCatalogCteBody(sql, cteName, boundaries[cteName])),
      expectedDigest,
      `${cteName} full definitions drifted`
    );
  }
}

function mutateSqlBlock(runbook, blockName, mutation) {
  const pattern = new RegExp(
    `(<!-- stage1c-accounting-sql:${blockName} -->\\r?\\n(?:\\r?\\n)?\`\`\`sql\\r?\\n)([\\s\\S]*?)(\`\`\`)`
  );
  const match = runbook.match(pattern);
  assert.ok(match, `cannot mutate missing SQL block ${blockName}`);
  return runbook.replace(pattern, () => `${match[1]}${mutation(match[2])}${match[3]}`);
}

function extractValuesTuples(sql, cteName, arity) {
  const match = sql.match(
    new RegExp(`${cteName}\\([^)]*\\)\\s+AS\\s*\\(\\s*VALUES([\\s\\S]*?)\\n\\),`, "i")
  );
  assert.ok(match, `missing VALUES CTE ${cteName}`);
  const tuplePattern = new RegExp(
    `\\(${Array.from({ length: arity }, () => "'([^']+)'\\s*").join(",\\s*")}\\)`,
    "g"
  );
  return [...match[1].matchAll(tuplePattern)].map((tuple) => tuple.slice(1));
}

function extractControllerApiTuples(controller, sharedAuth) {
  const controllerMatch = controller.match(/@Controller\("([^"]+)"\)/);
  assert.ok(controllerMatch, "API_INVENTORY: controller root is missing");
  const permissionMap = new Map(
    [...sharedAuth.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*"([^"]+)"/gm)].map((match) => [
      match[1],
      match[2]
    ])
  );
  const tuples = [
    ...controller.matchAll(
      /@(Get|Post|Put|Patch|Delete|Options|Head|All)\("([^"]+)"\)\s*@RequirePermissions\(PermissionCode\.([A-Z0-9_]+)\)/g
    )
  ].map((match) => {
    const permission = permissionMap.get(match[3]);
    assert.ok(permission, `API_INVENTORY: unmapped PermissionCode.${match[3]}`);
    return [match[1].toUpperCase(), `/${controllerMatch[1]}/${match[2]}`, permission];
  });
  return tuples;
}

function extractDocumentedApiTuples(runbook) {
  return [
    ...runbook.matchAll(
      /^\|\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ALL)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|$/gm
    )
  ].map((match) => [match[1], match[2], match[3]]);
}

function validateEnums(runbook, schema) {
  for (const [enumName, expected] of Object.entries(stage1cCEnums)) {
    const schemaMatch = schema.match(new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\n\\}`));
    assert.ok(schemaMatch, `schema enum missing: ${enumName}`);
    const actual = schemaMatch[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("@@"));
    assert.deepEqual(actual, expected, `schema enum drift: ${enumName}`);

    const runbookMatch = runbook.match(new RegExp(`^${enumName}\\s*=\\s*(.+)$`, "m"));
    assert.ok(runbookMatch, `runbook enum missing: ${enumName}`);
    assert.deepEqual(
      runbookMatch[1].split("|").map((value) => value.trim()),
      expected,
      `runbook enum drift: ${enumName}`
    );
  }
}

function validatePermissionSql(blocks) {
  const sql = blocks.get("02-permission-matrix");
  assert.ok(sql);
  assert.deepEqual(
    extractValuesTuples(sql, "stage1c_c_permission_definition", 4),
    permissionDefinitions,
    "the six Stage 1C-C permission definitions must remain exact and ordered"
  );
  const expectedGrants = Object.entries(roleMatrix).flatMap(([role, permissions]) =>
    permissions.map((permission) => [role, permission])
  );
  assert.equal(expectedGrants.length, 54);
  assert.deepEqual(
    extractValuesTuples(sql, "expected_grant", 2),
    expectedGrants,
    "the full Stage 1C 54-grant matrix must remain exact and ordered"
  );
  requireSqlInvariant(blocks, "02-permission-matrix", "PERMISSION_EXACTNESS", [
    "actual_stage1c_c_permission",
    "UNEXPECTED_PERMISSION_DEFINITION",
    "UNEXPECTED_ROLE_PERMISSION",
    "permission.module IN ('vehicle_cost_ledger', 'business_exception')",
    "permission.code LIKE 'vehicle_cost_ledger:%'",
    "permission.code LIKE 'business_exception:%'"
  ]);
  requireSqlInvariant(blocks, "02-permission-matrix", "PERMISSION_UNEXPECTED_DEFINITION", [
    "WHERE expected.code IS NULL"
  ]);
  requireSqlInvariant(blocks, "02-permission-matrix", "PERMISSION_RELEVANT_GRANT_SCOPE", [
    "OR permission.code IN (SELECT code FROM actual_stage1c_c_permission)"
  ]);
  requireSqlInvariant(blocks, "02-permission-matrix", "PERMISSION_EXACT_DEFINITION_COUNT", [
    "HAVING COUNT(*) <> 6"
  ]);
  requireSqlInvariant(blocks, "02-permission-matrix", "PERMISSION_EXACT_GRANT_COUNT", [
    "OR (SELECT COUNT(*) FROM actual_relevant_grant) <> 54"
  ]);
  requireSqlInvariant(blocks, "02-permission-matrix", "PERMISSION_UNEXPECTED_GRANT", [
    "WHERE expected.role_code IS NULL"
  ]);
}

function validateForeignKeySql(blocks) {
  const sql = blocks.get("03-database-catalog");
  assert.ok(sql);
  assert.deepEqual(
    extractValuesTuples(sql, "expected_foreign_key", 6),
    foreignKeyDefinitions,
    "FK_CATALOG_IDENTITY: the 15 foreign keys must remain exact and ordered"
  );
  requireSqlInvariant(blocks, "03-database-catalog", "FK_CATALOG_VALIDATION", [
    "foreign_constraint.contype = 'f'",
    "foreign_constraint.confdeltype",
    "foreign_constraint.convalidated",
    "foreign_key.convalidated IS NOT TRUE",
    "UNEXPECTED_FOREIGN_KEY"
  ]);
  requireSqlInvariant(blocks, "03-database-catalog", "FK_CATALOG_DELETE_ACTION", [
    'foreign_key.confdeltype IS DISTINCT FROM expected.confdeltype::"char"'
  ]);
  requireSqlInvariant(blocks, "03-database-catalog", "FK_CATALOG_REFERENCED_SCHEMA", [
    "JOIN pg_namespace AS referenced_namespace",
    "referenced_namespace.nspname AS referenced_schema",
    "foreign_key.referenced_schema IS DISTINCT FROM current_schema()"
  ]);
}

function validateAuthoritySql(blocks) {
  const sql = blocks.get("05-ledger-integrity");
  assert.ok(sql);
  requireSqlInvariant(blocks, "05-ledger-integrity", "AUTHORITY_HISTORY_FIXTURES", [
    "NORMAL_POST_APPEND_ORDER_DRIFT",
    "MISSING_VEHICLE",
    "EVIDENCE_WORK_ORDER_MISMATCH",
    "authority_fixture_contract",
    "is_anomaly IS DISTINCT FROM expected_anomaly"
  ]);
  requireSqlInvariant(blocks, "05-ledger-integrity", "AUTHORITY_ORPHAN", [
    "candidate.missing_vehicle"
  ]);
  requireSqlInvariant(blocks, "05-ledger-integrity", "AUTHORITY_EVIDENCE_WORK_ORDER", [
    "candidate.evidence_work_order_mismatch"
  ]);
  assert.equal(
    extractBoundedCteBody(sql, "authority_evaluation", "authority_anomaly"),
    normalizeSql(authorityEvaluationContract),
    "AUTHORITY_HISTORICAL_PROJECTION: only existence and immutable ledger/evidence relationships may block"
  );
  assert.doesNotMatch(
    sql,
    /order_row\.(?:vehicle_id|customer_id)|contract_row\.(?:order_id|customer_id)|work_order\.(?:vehicle_id|order_id|contract_id|customer_id|asset_owner_id)\s+IS\s+DISTINCT\s+FROM\s+entry\./,
    "AUTHORITY_HISTORICAL_PROJECTION: mutable current projections must not block frozen history"
  );
}

function validateRunbookSql(runbook) {
  const blocks = extractMarkedSqlBlocks(runbook);
  for (const [name, sql] of blocks) {
    assert.match(sql, /^BEGIN TRANSACTION READ ONLY;/, `${name} is not independently read-only`);
    assert.match(sql, /COMMIT;$/, `${name} has no independent COMMIT`);
    assert.doesNotMatch(
      sql,
      /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|CALL|DO|COPY)\b/im,
      `${name} contains a write-capable statement`
    );
  }

  requireSqlFragments(blocks, "01-migration-catalog", [
    "FROM _prisma_migrations",
    "20260821000000_stage1c_cost_ledger_exception_approval",
    "20260821000100_stage1c_cost_ledger_exception_approval_hardening",
    "20260821000200_stage1c_reversal_period_integrity",
    "rolled_back_migration_count",
    "failed_or_incomplete_migration_count",
    "expected_stage1c_c_applied_count",
    "migration_catalog_fingerprint"
  ]);

  validatePermissionSql(blocks);
  requireSqlFragments(blocks, "02-permission-matrix", [
    "expected_role(role_code)",
    "all_stage1c_permission(code)",
    "stage1c_c_permission_definition(code, name, module, action)",
    "expected_grant(role_code, permission_code)",
    "COUNT(*) FROM expected_grant",
    "<> 54",
    "IS DISTINCT FROM"
  ]);

  const reversalDimensions = [
    "vehicle_id",
    "order_id",
    "contract_id",
    "customer_id",
    "asset_owner_id",
    "work_order_id",
    "occurred_on",
    "accounting_period",
    "action_type",
    "cost_category",
    "responsible_party_type",
    "responsible_party_id",
    "asset_owner_snapshot",
    "evidence_id",
    "evidence_snapshot",
    "responsibility_snapshot"
  ];
  requireSqlFragments(blocks, "03-database-catalog", [
    "current_schema()",
    "pg_get_triggerdef",
    "pg_get_functiondef",
    "pg_get_constraintdef",
    "pg_get_indexdef",
    "trigger.tgenabled",
    "trigger.tgattr = ''::int2vector",
    "trigger.tgqual IS NULL",
    "actual.convalidated IS NOT TRUE",
    "actual.indisvalid IS NOT TRUE",
    "actual.indisready IS NOT TRUE",
    "vehicle_cost_ledger_entry_reversal_integrity",
    "vehicle_cost_ledger_entry_append_only",
    "asset_accounting_command_receipt_append_only",
    "business_exception_approval_transition_only",
    "CREATE OR REPLACE FUNCTION enforce_vehicle_cost_ledger_reversal()",
    "CREATE OR REPLACE FUNCTION reject_asset_accounting_append_only_mutation()",
    "CREATE OR REPLACE FUNCTION enforce_business_exception_approval_transition()",
    "SET search_path TO 'pg_catalog', 'public', 'pg_temp'",
    "OR (OLD.\"status\" = 'APPROVED' AND NEW.\"status\" = 'EXPIRED')",
    'NEW."version" <> OLD."version" + 1',
    "business_exception_approval request facts are immutable",
    "business_exception_approval decision facts are immutable",
    "business_exception_approval_status_shape_chk",
    "vehicle_cost_ledger_entry_reversal_of_entry_id_key",
    "business_exception_approval_live_subject_field_snapshot_key",
    "asset_accounting_command_receipt_source_key",
    ...reversalDimensions.map((name) => `NEW.\"${name}\"`),
    ...reversalDimensions.map((name) => `original.\"${name}\"`)
  ]);
  validateCatalogDefinitionDigests(blocks);
  validateForeignKeySql(blocks);

  requireSqlInvariant(blocks, "04-receipt-integrity", "RECEIPT_TARGET_OUTCOME_ID", [
    "receipt.outcome_snapshot ->> 'id' IS DISTINCT FROM entry.id::text",
    "receipt.outcome_snapshot ->> 'id' IS DISTINCT FROM approval.id::text"
  ]);
  requireSqlInvariant(blocks, "04-receipt-integrity", "RECEIPT_TARGET_OUTCOME_FACT", [
    "receipt.outcome_snapshot IS DISTINCT FROM target.expected_outcome",
    "cost_target",
    "approval_command_target"
  ]);
  requireSqlInvariant(blocks, "04-receipt-integrity", "RECEIPT_COMMAND_ACTOR", [
    "receipt.actor_id IS DISTINCT FROM entry.confirmed_by",
    "receipt.actor_id IS DISTINCT FROM approval.requested_by",
    "receipt.actor_id IS DISTINCT FROM approval.decided_by",
    "receipt.actor_id IS DISTINCT FROM approval.expired_by"
  ]);
  requireSqlInvariant(blocks, "04-receipt-integrity", "RECEIPT_TERMINAL_LIFECYCLE", [
    "COST_APPEND",
    "COST_REVERSE",
    "EXCEPTION_REQUEST",
    "EXCEPTION_DECIDE",
    "EXCEPTION_EXPIRE",
    "receipt.source_type IS DISTINCT FROM entry.source_type",
    "receipt.source_id IS DISTINCT FROM entry.source_id",
    "receipt.source_key IS DISTINCT FROM entry.source_key",
    "receipt.source_type IS DISTINCT FROM approval.request_source_type",
    "entry.entry_kind IS DISTINCT FROM 'ORIGINAL'",
    "entry.entry_kind IS DISTINCT FROM 'REVERSAL'",
    "cost_receipt_count <> 1",
    "request_receipt_count <> 1",
    "terminal_receipt_count",
    "WHEN status = 'PENDING' THEN 0",
    "WHEN status = 'EXPIRED' AND decision = 'APPROVED' THEN 2"
  ]);

  requireSqlFragments(blocks, "05-ledger-integrity", [
    "reversal.reversal_of_entry_id = original.id",
    "original.entry_kind IS DISTINCT FROM 'ORIGINAL'",
    "reversal.amount_cents IS DISTINCT FROM -original.amount_cents",
    "reversal.occurred_on IS DISTINCT FROM original.occurred_on",
    "reversal.accounting_period IS DISTINCT FROM original.accounting_period",
    "COUNT(*) OVER (PARTITION BY reversal_of_entry_id) AS reversal_count",
    "reversal.reversal_count <> 1",
    ...reversalDimensions.map((name) => `reversal.${name} IS DISTINCT FROM original.${name}`)
  ]);
  requireSqlInvariant(blocks, "05-ledger-integrity", "AUTHORITY_ORPHAN", [
    "authority_anomaly",
    "LEFT JOIN vehicle AS vehicle ON vehicle.id = entry.vehicle_id",
    "LEFT JOIN subscription_order AS order_row ON order_row.id = entry.order_id",
    "LEFT JOIN contract AS contract_row ON contract_row.id = entry.contract_id",
    "LEFT JOIN customer AS customer ON customer.id = entry.customer_id",
    "LEFT JOIN asset_owner AS owner_row ON owner_row.id = entry.asset_owner_id",
    "LEFT JOIN asset_work_order AS work_order ON work_order.id = entry.work_order_id",
    "LEFT JOIN asset_work_order_evidence AS evidence ON evidence.id = entry.evidence_id",
    'LEFT JOIN "user" AS confirmer ON confirmer.id = entry.confirmed_by',
    "vehicle.id IS NULL",
    "evidence.work_order_id IS DISTINCT FROM entry.work_order_id"
  ]);
  validateAuthoritySql(blocks);

  requireSqlFragments(blocks, "06-approval-integrity", [
    "approval.requested_by = approval.decided_by",
    "approval.status = 'PENDING' AND approval.version <> 0",
    "approval.status IN ('APPROVED', 'REJECTED') AND approval.version <> 1",
    "approval.status = 'EXPIRED' AND approval.decision IS NULL AND approval.version <> 1",
    "approval.status = 'EXPIRED' AND approval.decision = 'APPROVED' AND approval.version <> 2",
    "PARTITION BY subject_type, subject_id, subject_field, subject_snapshot_hash",
    "registered_resolver(subject_type, subject_id, subject_field, authoritative_snapshot_hash)",
    "WHERE false",
    "UNRESOLVED_NO_REGISTERED_RESOLVER",
    "STALE_ACTIVE_APPROVAL",
    "resolver.authoritative_snapshot_hash IS DISTINCT FROM approval.subject_snapshot_hash"
  ]);
  requireSqlInvariant(blocks, "06-approval-integrity", "APPROVAL_DECISION_COMMENT", [
    "approval.status IN ('APPROVED', 'REJECTED')",
    "btrim(COALESCE(approval.decision_comment, '')) = ''"
  ]);
  requireSqlInvariant(blocks, "06-approval-integrity", "APPROVAL_ACTOR_ORPHAN", [
    'LEFT JOIN "user" AS requester ON requester.id = approval.requested_by',
    'LEFT JOIN "user" AS decider ON decider.id = approval.decided_by',
    'LEFT JOIN "user" AS expirer ON expirer.id = approval.expired_by'
  ]);

  requireSqlInvariant(blocks, "07-audit-integrity", "AUDIT_SOURCE_VALIDITY", [
    "FROM audit_log AS audit WHERE audit.module = 'asset_accounting'",
    "jsonb_typeof(audit.after_snapshot -> 'source') IS DISTINCT FROM 'object'",
    "MALFORMED_AUDIT_SOURCE",
    "valid_module_audit",
    "WHERE NOT source_is_valid"
  ]);
  requireSqlInvariant(blocks, "07-audit-integrity", "AUDIT_TARGET_FACT", [
    "cost_target",
    "approval_command_target",
    "cost.expected_public_fact",
    "approval.expected_public_fact",
    "approval.expected_version"
  ]);
  requireSqlInvariant(blocks, "07-audit-integrity", "AUDIT_EXTRA", [
    "WHERE expected.receipt_id IS NULL"
  ]);
  requireSqlFragments(blocks, "07-audit-integrity", [
    "MISSING_AUDIT",
    "DUPLICATE_AUDIT",
    "EXTRA_AUDIT",
    "ORPHAN_AUDIT",
    "ENTITY_MISMATCH",
    "ACTION_MISMATCH",
    "SOURCE_MISMATCH",
    "HASH_MISMATCH",
    "paired.after_snapshot -> 'fact' IS DISTINCT FROM paired.expected_fact",
    "paired.after_snapshot -> 'source' IS DISTINCT FROM paired.expected_source",
    "after_snapshot #>> '{requestContext,idempotencyKey}'",
    "paired.after_snapshot -> 'fact' ->> 'version' IS DISTINCT FROM paired.expected_version::text",
    "^[0-9a-f]{64}$"
  ]);

  requireSqlFragments(blocks, "08-closed-cost-integrity", [
    "work_order.status = 'CLOSED'",
    "work_order.cost_confirmation_required IS TRUE",
    "original.entry_kind = 'ORIGINAL'",
    "original.action_type = 'ACTUAL_COST'",
    "reversal.reversal_of_entry_id = original.id",
    "HAVING COUNT(original.id) FILTER (WHERE reversal.id IS NULL) = 0"
  ]);
  return blocks;
}

test("pins purpose, non-goals, gates, and forward-only remediation", async () => {
  const runbook = await readOrEmpty(rolloutPath);
  assertIncludesEvery(runbook, [
    "只读核对，不是 apply",
    "不 backfill",
    "不得执行 `pnpm prisma:seed`",
    "不得执行历史 apply",
    "不得修改历史 migration",
    "不得执行 `prisma migrate reset` 或 `prisma db push`",
    "pnpm prisma:migrate:status",
    "pnpm prisma:validate",
    "pnpm prisma:migrate:checksum:verify",
    "--from-config-datasource",
    "--to-schema prisma/schema.prisma",
    "只有全部门禁退出码为 `0` 才能继续",
    "checksum mismatch `58`",
    "rolled-back `1`",
    "只允许前向、可审计纠正"
  ]);
});

test("pins exact enums, six definitions, and the eight-role Stage 1C-C matrix", async () => {
  const [runbook, schema] = await Promise.all([readOrEmpty(rolloutPath), readOrEmpty(schemaPath)]);
  validateEnums(runbook, schema);
  const rows = markdownRows(runbook);
  for (const [code, name, module, action] of permissionDefinitions) {
    assert.ok(rows.has(`\`${code}\`|${name}|\`${module}\`|\`${action}\``));
  }
  const expectedRows = {
    ADMIN: ["yes", "yes", "yes", "yes", "yes", "yes"],
    AS: ["yes", "yes", "no", "yes", "yes", "no"],
    OP: ["yes", "yes", "no", "yes", "yes", "no"],
    FI: ["yes", "yes", "yes", "yes", "yes", "no"],
    GM: ["yes", "no", "yes", "yes", "no", "yes"],
    RC: ["yes", "no", "no", "yes", "yes", "no"],
    SA: ["no", "no", "no", "no", "no", "no"],
    CS: ["no", "no", "no", "no", "no", "no"]
  };
  for (const [role, grants] of Object.entries(expectedRows)) {
    assert.ok(rows.has(`\`${role}\`|${grants.join("|")}`), `missing role row ${role}`);
  }
});

test("pins API, source, replay, approval, redaction, and contention contracts", async () => {
  const [runbook, controller, sharedAuth] = await Promise.all([
    readOrEmpty(rolloutPath),
    readOrEmpty(controllerPath),
    readOrEmpty(sharedAuthPath)
  ]);
  assert.deepEqual(
    extractDocumentedApiTuples(runbook),
    extractControllerApiTuples(controller, sharedAuth),
    "API_INVENTORY: runbook verb/path/permission tuples differ from controller decorators"
  );
  assertIncludesEvery(runbook, [
    "没有 public approval mutation endpoint",
    "exact source tuple `{ type, id, key }`",
    "UUID 小写 canonical",
    "同一 exact source tuple 在所有五种 command type 之间全局唯一",
    "receipt-first replay",
    "`wrote: false`",
    "不新增 AuditLog",
    "reason 必须非空",
    "`decisionComment` 不进入 public read",
    "canonical JSON",
    "小写 SHA-256",
    "只接受 server-side authority resolver",
    "不接受 client snapshot 或 client hash",
    "requester 不能审批自己的请求",
    "ADMIN 也不能绕过",
    "expectedVersion",
    "PENDING → APPROVED | REJECTED | EXPIRED",
    "APPROVED → EXPIRED",
    "先追加 replacement，再冲正原 entry",
    "ASSET_ACCOUNTING_AUTHORITY_BUSY",
    "ASSET_ACCOUNTING_SOURCE_CONFLICT",
    "同一个 `Idempotency-Key`",
    "不要紧密自动重试"
  ]);
});

test("detects a synthetic route for every Nest HTTP method decorator", async () => {
  const [runbook, controller, sharedAuth] = await Promise.all([
    readOrEmpty(rolloutPath),
    readOrEmpty(controllerPath),
    readOrEmpty(sharedAuthPath)
  ]);
  const documented = extractDocumentedApiTuples(runbook);
  for (const decorator of ["Get", "Post", "Put", "Patch", "Delete", "Options", "Head", "All"]) {
    const syntheticController = `${controller}\n@${decorator}("synthetic-${decorator.toLowerCase()}")\n@RequirePermissions(PermissionCode.VEHICLE_COST_LEDGER_VIEW)\n`;
    assert.throws(
      () =>
        assert.deepEqual(
          documented,
          extractControllerApiTuples(syntheticController, sharedAuth),
          "API_INVENTORY: synthetic route escaped the exact inventory"
        ),
      (error) => error instanceof Error && error.message.includes("API_INVENTORY"),
      `API_INVENTORY: @${decorator} synthetic route must fail exact inventory`
    );
  }
});

test("pins permissions-only zero ownership coupling and legacy default distinction", async () => {
  const [runbook, core, executor] = await Promise.all([
    readOrEmpty(rolloutPath),
    readOrEmpty(accessCorePath),
    readOrEmpty(accessExecutorPath)
  ]);
  assertIncludesEvery(runbook, [
    "`--permissions-only`",
    "零 ownership coupling",
    "不读、不锁、不写 `AssetOwner` 或 `VehicleOwnershipPeriod`",
    "默认 legacy 模式",
    "平台 owner convergence",
    "STAGE1C_ACCESS_BASELINE_APPLY=SYNC_STAGE1C_ACCESS_BASELINE",
    "本手册不提供 apply 命令"
  ]);
  assertIncludesEvery(core, [
    "STAGE1C_PERMISSION_DEFINITIONS",
    "STAGE1C_ROLE_PERMISSION_MATRIX",
    'platformOwner: { disposition: "NOT_MANAGED" }'
  ]);
  assertIncludesEvery(executor, ["permissionsOnly", "ownershipPeriodCount"]);
});

test("validates eight actual marked SQL blocks", async () => {
  validateRunbookSql(await readOrEmpty(rolloutPath));
});

test("kills structural mutations in actual reconciliation SQL", async () => {
  const runbook = await readOrEmpty(rolloutPath);
  validateRunbookSql(runbook);
  const mutations = [
    ["write-capable transaction", "04-receipt-integrity", (sql) => sql.replace("READ ONLY", "")],
    [
      "drops trigger enablement",
      "03-database-catalog",
      (sql) => sql.replace("trigger.tgenabled", "'O'::text")
    ],
    [
      "changes full trigger definition",
      "03-database-catalog",
      (sql) =>
        sql.replace(
          "BEFORE INSERT ON vehicle_cost_ledger_entry",
          "AFTER INSERT ON vehicle_cost_ledger_entry"
        )
    ],
    [
      "mutates append-only full function",
      "03-database-catalog",
      (sql) => sql.replace("%I is append-only", "%I mutation accepted")
    ],
    [
      "weakens exact CHECK definition",
      "03-database-catalog",
      (sql) => sql.replace("CHECK ((amount_cents <> 0))", "CHECK ((amount_cents >= 0))")
    ],
    [
      "drops exact partial-index predicate",
      "03-database-catalog",
      (sql) => sql.replace(" WHERE (reversal_of_entry_id IS NOT NULL)", "")
    ],
    [
      "drops full reversal function dimension",
      "03-database-catalog",
      (sql) => sql.replace('NEW."occurred_on"', "NEW.date_check_removed")
    ],
    [
      "drops full approval function transition",
      "03-database-catalog",
      (sql) => sql.replace("OLD.\"status\" = 'APPROVED'", "OLD.\"status\" = 'REMOVED'")
    ],
    [
      "weakens receipt source pairing",
      "04-receipt-integrity",
      (sql) => sql.replace("receipt.source_key IS DISTINCT FROM entry.source_key", "false")
    ],
    [
      "drops reversal date equality",
      "05-ledger-integrity",
      (sql) => sql.replace("reversal.occurred_on IS DISTINCT FROM original.occurred_on", "false")
    ],
    [
      "accepts multiple reversals",
      "05-ledger-integrity",
      (sql) => sql.replace("reversal.reversal_count <> 1", "false")
    ],
    [
      "drops reversal period equality",
      "05-ledger-integrity",
      (sql) =>
        sql.replace(
          "reversal.accounting_period IS DISTINCT FROM original.accounting_period",
          "false"
        )
    ],
    [
      "allows self approval",
      "06-approval-integrity",
      (sql) => sql.replace("approval.requested_by = approval.decided_by", "false")
    ],
    [
      "detaches stale approval from resolver",
      "06-approval-integrity",
      (sql) =>
        sql.replace(
          "resolver.authoritative_snapshot_hash IS DISTINCT FROM approval.subject_snapshot_hash",
          "false"
        )
    ],
    [
      "drops audit source equality",
      "07-audit-integrity",
      (sql) =>
        sql.replace(
          "paired.after_snapshot -> 'source' IS DISTINCT FROM paired.expected_source",
          "false"
        )
    ],
    [
      "drops closed work-order cost requirement",
      "08-closed-cost-integrity",
      (sql) => sql.replace("work_order.cost_confirmation_required IS TRUE", "true")
    ],
    [
      "removes permission grant",
      "02-permission-matrix",
      (sql) => sql.replace("('ADMIN', 'business_exception:approve')", "")
    ]
  ];
  for (const [name, block, mutate] of mutations) {
    const mutated = mutateSqlBlock(runbook, block, mutate);
    assert.notEqual(mutated, runbook, `mutation did not alter SQL: ${name}`);
    assert.throws(() => validateRunbookSql(mutated), undefined, name);
  }
});

test("kills finding-specific mutations with the intended invariant labels", async () => {
  const runbook = await readOrEmpty(rolloutPath);
  validateRunbookSql(runbook);
  const mutations = [
    [
      "RECEIPT_TARGET_OUTCOME_ID",
      "04-receipt-integrity",
      (sql) =>
        sql.replace("receipt.outcome_snapshot ->> 'id' IS DISTINCT FROM entry.id::text", "false")
    ],
    [
      "RECEIPT_TARGET_OUTCOME_FACT",
      "04-receipt-integrity",
      (sql) =>
        sql.replace("receipt.outcome_snapshot IS DISTINCT FROM target.expected_outcome", "false")
    ],
    [
      "RECEIPT_COMMAND_ACTOR",
      "04-receipt-integrity",
      (sql) => sql.replace("receipt.actor_id IS DISTINCT FROM entry.confirmed_by", "false")
    ],
    [
      "RECEIPT_TERMINAL_LIFECYCLE",
      "04-receipt-integrity",
      (sql) => sql.replace("WHEN status = 'PENDING' THEN 0", "WHEN status = 'PENDING' THEN 1")
    ],
    [
      "FK_CATALOG_IDENTITY",
      "03-database-catalog",
      (sql) => sql.replace(/\s*\('vehicle_cost_ledger_entry_vehicle_id_fkey',[\s\S]*?'r'\),/, "")
    ],
    [
      "FK_CATALOG_VALIDATION",
      "03-database-catalog",
      (sql) => sql.replace("foreign_key.convalidated IS NOT TRUE", "false")
    ],
    [
      "FK_CATALOG_DELETE_ACTION",
      "03-database-catalog",
      (sql) =>
        sql.replace(
          'foreign_key.confdeltype IS DISTINCT FROM expected.confdeltype::"char"',
          "false"
        )
    ],
    [
      "FK_CATALOG_REFERENCED_SCHEMA",
      "03-database-catalog",
      (sql) =>
        sql.replace("foreign_key.referenced_schema IS DISTINCT FROM current_schema()", "false")
    ],
    [
      "AUTHORITY_ORPHAN",
      "05-ledger-integrity",
      (sql) => sql.replace("candidate.missing_vehicle", "false")
    ],
    [
      "AUTHORITY_HISTORICAL_PROJECTION",
      "05-ledger-integrity",
      (sql) =>
        sql.replace(
          "OR candidate.responsible_owner_mismatch",
          "OR candidate.responsible_owner_mismatch OR candidate.order_vehicle_drift"
        )
    ],
    [
      "AUTHORITY_EVIDENCE_WORK_ORDER",
      "05-ledger-integrity",
      (sql) => sql.replace("candidate.evidence_work_order_mismatch", "false")
    ],
    [
      "AUDIT_SOURCE_VALIDITY",
      "07-audit-integrity",
      (sql) => sql.replace("WHERE NOT source_is_valid", "WHERE false")
    ],
    [
      "PERMISSION_UNEXPECTED_DEFINITION",
      "02-permission-matrix",
      (sql) => sql.replace("WHERE expected.code IS NULL", "WHERE false")
    ],
    [
      "PERMISSION_RELEVANT_GRANT_SCOPE",
      "02-permission-matrix",
      (sql) =>
        sql.replace(
          "OR permission.code IN (SELECT code FROM actual_stage1c_c_permission)",
          "OR false"
        )
    ],
    [
      "PERMISSION_EXACT_DEFINITION_COUNT",
      "02-permission-matrix",
      (sql) => sql.replace("HAVING COUNT(*) <> 6", "HAVING false")
    ],
    [
      "PERMISSION_EXACT_GRANT_COUNT",
      "02-permission-matrix",
      (sql) => sql.replace("OR (SELECT COUNT(*) FROM actual_relevant_grant) <> 54", "OR false")
    ],
    [
      "PERMISSION_UNEXPECTED_GRANT",
      "02-permission-matrix",
      (sql) => sql.replace("WHERE expected.role_code IS NULL", "WHERE false")
    ],
    [
      "AUDIT_EXTRA",
      "07-audit-integrity",
      (sql) => sql.replace("WHERE expected.receipt_id IS NULL", "WHERE false")
    ],
    [
      "APPROVAL_DECISION_COMMENT",
      "06-approval-integrity",
      (sql) => sql.replace("btrim(COALESCE(approval.decision_comment, '')) = ''", "false")
    ]
  ];

  for (const [invariant, block, mutate] of mutations) {
    const mutated = mutateSqlBlock(runbook, block, mutate);
    assert.notEqual(mutated, runbook, `${invariant}: mutation did not alter actual SQL`);
    assert.throws(
      () => validateRunbookSql(mutated),
      (error) => error instanceof Error && error.message.includes(invariant),
      `${invariant}: mutation must fail through its intended invariant`
    );
  }
});

test("cross-links Stage 1C-B and pins evidence controls", async () => {
  const [runbook, operations] = await Promise.all([
    readOrEmpty(rolloutPath),
    readOrEmpty(operationsRunbookPath)
  ]);
  assert.match(
    operations,
    /\[Stage 1C-C 资产成本与业务例外发布运行手册\]\(\.\/stage1c-asset-accounting-rollout\.zh-CN\.md\)/
  );
  assertIncludesEvery(runbook, [
    "不得输出或保存 `DATABASE_URL`、数据库用户名或密码",
    "客户 PII、VIN、车牌",
    "内部审批备注",
    "仓库外受控加密证据存储",
    "原始 SQL 输出不得提交 Git",
    "SHA-256",
    "保留期限"
  ]);
});
