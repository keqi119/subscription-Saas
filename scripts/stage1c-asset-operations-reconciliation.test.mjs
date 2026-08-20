import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const rolloutPath = resolve(repoRoot, "docs/runbooks/stage1c-asset-operations-rollout.zh-CN.md");
const periodRunbookPath = resolve(repoRoot, "docs/runbooks/stage1c-period-facts-rollout.zh-CN.md");
const schemaPath = resolve(repoRoot, "apps/api/prisma/schema.prisma");

const sqlBlockOrder = [
  "01-migration-catalog",
  "02-permission-matrix",
  "03-handover-source",
  "04-return-source",
  "05-service-case-source",
  "06-condition-report-source",
  "07-active-blocker-scopes",
  "08-available-blocked-occupied",
  "09-availability-parity",
  "10-release-tuple",
  "11-terminal-timestamp",
  "12-source-integrity",
  "13-event-sequence",
  "14-evidence-successor",
  "15-database-catalog",
  "16-audit-integrity"
];

const stage1cBEnums = {
  AssetWorkOrderType: [
    "DELIVERY_OUTBOUND",
    "RETURN_INBOUND",
    "SWAP_OUTBOUND",
    "SWAP_INBOUND",
    "RECOVERY",
    "RECONDITIONING",
    "MAINTENANCE"
  ],
  AssetWorkOrderStatus: [
    "PENDING",
    "IN_PROGRESS",
    "WAITING_EXTERNAL",
    "PENDING_ACCEPTANCE",
    "PENDING_COST_CONFIRMATION",
    "CLOSED",
    "CANCELLED"
  ],
  AssetWorkOrderPriority: ["LOW", "NORMAL", "HIGH", "URGENT"],
  AssetWorkOrderEventType: [
    "CREATED",
    "ASSIGNED",
    "STARTED",
    "WAITING_EXTERNAL",
    "RESUMED",
    "EVIDENCE_ATTACHED",
    "SUBMITTED_FOR_ACCEPTANCE",
    "ACCEPTED",
    "COST_CONFIRMED",
    "PHYSICAL_CONTROL_CONFIRMED",
    "INSPECTION_RECORDED",
    "RESTRICTION_CREATED",
    "RESTRICTION_RELEASED",
    "CLOSED",
    "CANCELLED",
    "NOTE_ADDED"
  ],
  AssetWorkOrderEvidenceAction: ["ATTACH", "SUPERSEDE", "REMOVE"],
  AssetWorkOrderEvidenceType: [
    "PHOTO",
    "VIDEO",
    "DOCUMENT",
    "SIGNATURE",
    "LOCATION_PROOF",
    "THIRD_PARTY_RECEIPT",
    "INSPECTION_REPORT",
    "OTHER"
  ],
  VehicleOperationalRestrictionType: [
    "RETURN_INSPECTION_PENDING",
    "REINSPECTION_PENDING",
    "RECONDITIONING_PENDING",
    "MAINTENANCE_OR_ACCIDENT",
    "RECOVERY_IN_PROGRESS",
    "LEGAL_HOLD",
    "EVIDENCE_EXCEPTION",
    "OWNERSHIP_EXCEPTION",
    "OTHER"
  ],
  VehicleOperationalRestrictionSeverity: ["ADVISORY", "BLOCKING"],
  VehicleOperationalRestrictionScope: [
    "ALLOCATION",
    "DELIVERY",
    "CUSTOMER_USE",
    "INVENTORY_RELEASE"
  ],
  VehicleOperationalRestrictionStatus: ["ACTIVE", "RELEASED", "VOIDED"]
};

async function readOrEmpty(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
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

function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function extractMarkedSqlBlocks(contents) {
  const blocks = [
    ...contents.matchAll(
      /<!-- stage1c-sql:([a-z0-9-]+) -->\r?\n(?:\r?\n)?```sql\r?\n([\s\S]*?)```/g
    )
  ].map((match) => ({ name: match[1], sql: match[2].trim() }));
  const allSqlFences = [...contents.matchAll(/```sql\r?\n([\s\S]*?)```/g)];

  assert.equal(allSqlFences.length, 16, "the runbook must contain exactly 16 SQL fences");
  assert.deepEqual(
    blocks.map((block) => block.name),
    sqlBlockOrder,
    "SQL markers must be unique, complete, and in approved order"
  );
  return new Map(blocks.map((block) => [block.name, block.sql]));
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

function validateEnumContracts(runbook, schema) {
  for (const [enumName, expectedValues] of Object.entries(stage1cBEnums)) {
    const schemaMatch = schema.match(new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\n\\}`));
    assert.ok(schemaMatch, `schema enum missing: ${enumName}`);
    const schemaValues = schemaMatch[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("@@"));
    assert.deepEqual(schemaValues, expectedValues, `schema enum drift: ${enumName}`);

    const runbookMatch = runbook.match(new RegExp(`^${enumName}\\s*=\\s*(.+)$`, "m"));
    assert.ok(runbookMatch, `runbook enum missing: ${enumName}`);
    assert.deepEqual(
      runbookMatch[1].split("|").map((value) => value.trim()),
      expectedValues,
      `runbook enum drift: ${enumName}`
    );
  }
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
    "rolled_back_at",
    "failed_or_incomplete_migration_count",
    "migration_catalog_fingerprint"
  ]);
  requireSqlFragments(blocks, "02-permission-matrix", [
    "expected_role(role_code)",
    "permission_definition(code, name, module, action)",
    "expected_grant(role_code, permission_code)",
    "IS DISTINCT FROM"
  ]);

  const classificationContracts = {
    "03-handover-source": [
      "FROM vehicle_handover_work_order AS handover",
      "JOIN subscription_order AS source_order"
    ],
    "04-return-source": [
      "FROM vehicle_return AS source_return",
      "source_return.deleted_at IS NULL"
    ],
    "05-service-case-source": [
      "FROM service_case AS service",
      "service.case_status IN ('SUBMITTED', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_CUSTOMER')"
    ],
    "06-condition-report-source": [
      "FROM vehicle_condition_report AS report",
      "report.report_status = 'PUBLISHED'",
      "item.deleted_at IS NULL"
    ]
  };
  for (const [name, candidateFragments] of Object.entries(classificationContracts)) {
    requireSqlFragments(blocks, name, [
      ...candidateFragments,
      "FROM asset_work_order_event AS event",
      "COUNT(link.claim_id) = 0",
      "COUNT(link.claim_id) = 1",
      "BOOL_AND(link.source_key = expected.source_key)",
      "BOOL_AND(link.vehicle_id = expected.vehicle_id)",
      "BOOL_AND(NOT link.source_conflict)",
      "WHEN event.id IS NULL THEN material.event_required",
      "'CREATED'",
      "'EVIDENCE_ATTACHED'",
      "'RESTRICTION_CREATED'",
      "'RESTRICTION_RELEASED'"
    ]);
  }

  requireSqlFragments(blocks, "07-active-blocker-scopes", [
    "VALUES ('ALLOCATION'), ('DELIVERY'), ('CUSTOMER_USE'), ('INVENTORY_RELEASE')",
    "restriction.started_at <= params.as_of",
    "restriction.status = 'ACTIVE'",
    "restriction.severity = 'BLOCKING'"
  ]);
  requireSqlFragments(blocks, "08-available-blocked-occupied", [
    "period.started_at <= params.as_of",
    "period.ended_at IS NULL OR period.ended_at > params.as_of",
    "restriction.started_at <= params.as_of",
    "restriction.scopes && ARRAY['ALLOCATION', 'DELIVERY', 'INVENTORY_RELEASE']::vehicle_operational_restriction_scope[]"
  ]);
  requireSqlFragments(blocks, "09-availability-parity", [
    "VALUES ('ALLOCATION'), ('DELIVERY'), ('MARK_AVAILABLE')",
    "period.started_at <= params.as_of",
    "restriction.started_at <= params.as_of"
  ]);
  requireSqlFragments(blocks, "10-release-tuple", [
    "num_nonnulls(",
    "<> 7",
    "released_at < started_at"
  ]);
  requireSqlFragments(blocks, "11-terminal-timestamp", [
    "status = 'CLOSED'",
    "status = 'CANCELLED'",
    "closed_at < created_at",
    "cancelled_at < created_at"
  ]);
  requireSqlFragments(blocks, "12-source-integrity", [
    "FROM asset_work_order_event AS event",
    "'CREATED'",
    "'EVIDENCE_ATTACHED'",
    "'RESTRICTION_CREATED'",
    "'RESTRICTION_RELEASED'",
    "event.work_order_id = material.work_order_id",
    "source_conflict",
    "material_owner_count",
    "event_owner_count"
  ]);
  assert.doesNotMatch(blocks.get("12-source-integrity"), /'NOTE_ADDED'/);
  requireSqlFragments(blocks, "13-event-sequence", [
    "row_number() OVER",
    "PARTITION BY event.work_order_id",
    "sequence IS DISTINCT FROM expected_sequence"
  ]);
  requireSqlFragments(blocks, "14-evidence-successor", [
    "GROUP BY supersedes_evidence_id",
    "HAVING COUNT(*) > 1"
  ]);

  const catalogNames = [
    "asset_work_order_event_append_only",
    "asset_work_order_evidence_append_only",
    "vehicle_operational_restriction_release_only",
    "reject_asset_operation_append_only_mutation",
    "enforce_vehicle_operational_restriction_release",
    "asset_work_order_version_nonnegative_chk",
    "asset_work_order_event_sequence_positive_chk",
    "asset_work_order_event_occurred_not_future_chk",
    "asset_work_order_evidence_sha256_chk",
    "asset_work_order_evidence_action_shape_chk",
    "asset_work_order_evidence_file_snapshot_shape_chk",
    "asset_work_order_evidence_file_size_nonnegative_chk",
    "vehicle_operational_restriction_scopes_not_empty_chk",
    "vehicle_operational_restriction_release_after_start_chk",
    "vehicle_operational_restriction_release_tuple_chk",
    "asset_work_order_create_source_key",
    "asset_work_order_event_work_order_sequence_key",
    "asset_work_order_event_source_key",
    "asset_work_order_evidence_source_key",
    "asset_work_order_evidence_supersedes_evidence_id_key",
    "vehicle_operational_restriction_start_source_key",
    "vehicle_operational_restriction_release_source_key",
    "vehicle_operational_restriction_active_vehicle_idx"
  ];
  requireSqlFragments(blocks, "15-database-catalog", [
    "JOIN pg_namespace",
    "current_schema()",
    "trigger.tgfoid",
    "trigger.tgtype = 27",
    "pg_get_functiondef",
    "pg_get_constraintdef",
    "pg_indexes",
    "actual.enabled IS DISTINCT FROM 'O'",
    "actual.function_definition !~ 'ERRCODE = ''55000'''",
    "actual.function_definition !~ 'TG_TABLE_NAME'",
    "actual.function_definition !~ 'TG_OP = ''DELETE'''",
    "actual.function_definition !~ 'OLD\\.\"status\" <> ''ACTIVE'''",
    "actual.function_definition !~ 'NEW\\.\"status\" = ''ACTIVE'''",
    "actual.function_definition !~ 'NEW\\.\"scopes\"'",
    "actual.function_definition !~ 'OLD\\.\"scopes\"'",
    "actual.function_definition !~ 'RETURN NEW'",
    ...catalogNames
  ]);
  requireSqlFragments(blocks, "16-audit-integrity", [
    "GROUP BY fact.entity_type, fact.id",
    "create_audit_count <> 1",
    "facts_with_invalid_create_audit_count",
    "facts_with_duplicate_create_audit",
    "extra_create_audits",
    "audits_without_fact",
    "audit_fingerprint"
  ]);
  return blocks;
}

function mutateSqlBlock(runbook, blockName, mutation) {
  const pattern = new RegExp(
    "(<!-- stage1c-sql:" + blockName + " -->\\r?\\n(?:\\r?\\n)?```sql\\r?\\n)([\\s\\S]*?)(```)"
  );
  const match = runbook.match(pattern);
  assert.ok(match, `cannot mutate missing SQL block ${blockName}`);
  return runbook.replace(pattern, () => `${match[1]}${mutation(match[2])}${match[3]}`);
}

test("pins non-goals, rollout stop gates, and forward-only recovery", async () => {
  const runbook = await readOrEmpty(rolloutPath);

  assertIncludesEvery(runbook, [
    "只读核对，不是 apply",
    "不创建、补录、推断或批量转换工单、限制、事件或证据",
    "不得执行 `pnpm prisma:seed`",
    "generic seed 未部署且未执行",
    "不得执行历史 apply",
    "不得修改历史 migration",
    "不得执行 `prisma migrate reset` 或 `prisma db push`",
    "迁移状态门禁",
    "原始字节 checksum 门禁",
    "datasource→schema drift 门禁",
    "只有全部门禁退出码为 `0` 才能继续",
    "只允许前向、可审计纠正",
    "停止发布"
  ]);
});

test("pins the five permissions and the exact eight-role matrix layered with Stage 1C-A", async () => {
  const runbook = await readOrEmpty(rolloutPath);

  assertIncludesEvery(runbook, [
    "`asset_operations:view`",
    "`asset_work_order:manage`",
    "`vehicle_restriction:manage`",
    "`vehicle_restriction:release`",
    "`vehicle_restriction:approve_release`"
  ]);
  const expectedRows = [
    "`ADMIN`|yes|yes|yes|yes|yes|yes|yes|yes",
    "`AS`|yes|yes|yes|yes|yes|yes|yes|yes",
    "`OP`|yes|no|yes|yes|yes|yes|yes|no",
    "`GM`|yes|no|no|yes|no|no|no|yes",
    "`FI`|yes|no|no|yes|no|no|no|no",
    "`RC`|no|no|no|yes|no|no|no|no",
    "`SA`|no|no|no|no|no|no|no|no",
    "`CS`|no|no|no|no|no|no|no|no"
  ];
  const rows = markdownRows(runbook);
  const expectedDefinitions = [
    "`asset_operations:view`|查看资产运营工单与限制|`asset_operations`|`view`",
    "`asset_work_order:manage`|管理资产运营工单|`asset_operations`|`work_order_manage`",
    "`vehicle_restriction:manage`|管理车辆运营限制|`asset_operations`|`restriction_manage`",
    "`vehicle_restriction:release`|解除车辆运营限制|`asset_operations`|`restriction_release`",
    "`vehicle_restriction:approve_release`|审批高风险车辆运营限制解除|`asset_operations`|`restriction_approve_release`"
  ];
  for (const expected of expectedDefinitions) {
    assert.ok(rows.has(expected), `missing permission definition row: ${expected}`);
  }
  for (const expected of expectedRows) {
    assert.ok(rows.has(expected), `missing role matrix row: ${expected}`);
  }
});

test("pins every work-order and restriction enum", async () => {
  const [runbook, schema] = await Promise.all([readOrEmpty(rolloutPath), readOrEmpty(schemaPath)]);

  validateEnumContracts(runbook, schema);
  assertIncludesEvery(runbook, [
    "事件和证据均为只追加、不可更新、不可删除",
    "解除元组必须全空或全非空"
  ]);
  assert.match(runbook, /`DEAD_LETTER` 不是资产工单或运营限制的业务状态/);
});

test("pins exact legacy source tuples and three-way read-only classification", async () => {
  const runbook = await readOrEmpty(rolloutPath);

  assertIncludesEvery(runbook, [
    "VEHICLE_HANDOVER_WORK_ORDER",
    "stage1c-b:legacy:vehicle-handover-work-order:",
    "VEHICLE_RETURN",
    "stage1c-b:legacy:vehicle-return:",
    "SERVICE_CASE",
    "stage1c-b:legacy:service-case:",
    "VEHICLE_CONDITION_REPORT",
    "stage1c-b:legacy:vehicle-condition-report:",
    "LINKED",
    "UNLINKED_REVIEW_REQUIRED",
    "SOURCE_CONFLICT",
    "`UNLINKED_REVIEW_REQUIRED` 不授权创建工单或限制",
    "vehicle_handover_work_order",
    "vehicle_return",
    "service_case",
    "vehicle_condition_report",
    "vehicle_condition_report_item"
  ]);
});

test("pins availability parity, immutable-fact, and audit evidence queries", async () => {
  const runbook = await readOrEmpty(rolloutPath);

  assertIncludesEvery(runbook, [
    "ALLOCATION",
    "DELIVERY",
    "MARK_AVAILABLE",
    "ACTIVE BLOCKING 按 scope 计数",
    "AVAILABLE 但受阻或被占用",
    "限制解除元组完整性",
    "工单终态时间戳一致性",
    "重复来源元组",
    "事件 sequence 缺口",
    "证据竞争 successor",
    "AuditLog 精确计数与 fingerprint",
    "pg_trigger",
    "vehicle_subscription_period"
  ]);
  assert.match(runbook, /md5\(\s*COALESCE\(\s*string_agg/);
});

test("pins fail-closed contention, stable errors, and PAUSED journey recovery", async () => {
  const runbook = await readOrEmpty(rolloutPath);

  assertIncludesEvery(runbook, [
    "ASSET_OPERATION_AUTHORITY_BUSY",
    "ASSET_OPERATION_TRANSACTION_REQUIRED",
    "ASSET_OPERATION_SOURCE_CONFLICT",
    "ASSET_WORK_ORDER_VERSION_CONFLICT",
    "VEHICLE_OPERATIONALLY_RESTRICTED",
    "VEHICLE_NOT_FOUND | VEHICLE_DELETED | LIFECYCLE_STATUS_BLOCKED | SALE_PRICE_NOT_EFFECTIVE | SALE_PRICE_NOT_POSITIVE | ACTIVE_SUBSCRIPTION_PERIOD | ACTIVE_OPERATIONAL_RESTRICTION",
    "HTTP `409`",
    "不要紧密自动重试",
    "同一个 `Idempotency-Key`",
    "status = PAUSED",
    "pausedFromStatus = RUNNING",
    "JOURNEY_PAUSED",
    "正常完成当前 claimed job",
    "不得重试或进入 `DEAD_LETTER`",
    "orderId",
    "finalPlanRevision"
  ]);
});

test("validates exactly 16 marked SQL blocks and each structural contract", async () => {
  const runbook = await readOrEmpty(rolloutPath);

  validateRunbookSql(runbook);
});

test("rejects dangerous reconciliation SQL mutations", async () => {
  const runbook = await readOrEmpty(rolloutPath);
  validateRunbookSql(runbook);

  const mutations = [
    [
      "accepts multiple material claims",
      mutateSqlBlock(runbook, "03-handover-source", (sql) =>
        sql.replace("COUNT(link.claim_id) = 1", "COUNT(link.claim_id) >= 1")
      )
    ],
    [
      "drops vehicle identity equality",
      mutateSqlBlock(runbook, "04-return-source", (sql) =>
        sql.replace("AND BOOL_AND(link.vehicle_id = expected.vehicle_id)", "")
      )
    ],
    [
      "drops period as-of predicate",
      mutateSqlBlock(runbook, "08-available-blocked-occupied", (sql) =>
        sql.replace("AND period.started_at <= params.as_of", "")
      )
    ],
    [
      "drops restriction as-of predicate",
      mutateSqlBlock(runbook, "08-available-blocked-occupied", (sql) =>
        sql.replace("AND restriction.started_at <= params.as_of", "")
      )
    ],
    [
      "removes a required block",
      runbook.replace(
        /<!-- stage1c-sql:14-evidence-successor -->\r?\n(?:\r?\n)?```sql\r?\n[\s\S]*?```/,
        ""
      )
    ],
    [
      "replaces a gate with SELECT 1",
      mutateSqlBlock(
        runbook,
        "13-event-sequence",
        () => "BEGIN TRANSACTION READ ONLY;\nSELECT 1;\nCOMMIT;\n"
      )
    ],
    [
      "drops restriction trigger",
      mutateSqlBlock(runbook, "15-database-catalog", (sql) =>
        sql.replace("vehicle_operational_restriction_release_only", "restriction_trigger_removed")
      )
    ],
    [
      "accepts a no-op trigger function identity",
      mutateSqlBlock(runbook, "15-database-catalog", (sql) =>
        sql.replaceAll(
          "enforce_vehicle_operational_restriction_release",
          "noop_vehicle_operational_restriction_release"
        )
      )
    ],
    [
      "drops an immutable restriction field from function-body validation",
      mutateSqlBlock(runbook, "15-database-catalog", (sql) =>
        sql.replace('NEW\\."scopes"', "restriction_scope_body_check_removed")
      )
    ],
    [
      "drops a database-only constraint expectation",
      mutateSqlBlock(runbook, "15-database-catalog", (sql) =>
        sql.replace("asset_work_order_evidence_action_shape_chk", "constraint_removed")
      )
    ],
    [
      "drops event ownership from source integrity",
      mutateSqlBlock(runbook, "12-source-integrity", (sql) =>
        sql.replace("FROM asset_work_order_event AS event", "FROM asset_work_order AS event")
      )
    ],
    [
      "accepts NOTE_ADDED as a material pair",
      mutateSqlBlock(runbook, "12-source-integrity", (sql) =>
        sql.replace("'RESTRICTION_RELEASED'", "'NOTE_ADDED'")
      )
    ],
    [
      "drops duplicate CREATE-audit cardinality",
      mutateSqlBlock(runbook, "16-audit-integrity", (sql) =>
        sql.replace("facts_with_duplicate_create_audit", "duplicate_create_check_removed")
      )
    ]
  ];

  for (const [name, mutated] of mutations) {
    assert.notEqual(mutated, runbook, `mutation did not alter the runbook: ${name}`);
    assert.throws(() => validateRunbookSql(mutated), undefined, name);
  }
});

test("rejects AVAILABLE-scope and ordered-enum mutations", async () => {
  const [runbook, schema] = await Promise.all([readOrEmpty(rolloutPath), readOrEmpty(schemaPath)]);
  validateEnumContracts(runbook, schema);
  validateRunbookSql(runbook);

  const scopeMutations = [
    ["ALLOCATION", "'ALLOCATION', "],
    ["DELIVERY", "'DELIVERY', "],
    ["INVENTORY_RELEASE", ", 'INVENTORY_RELEASE'"],
    ["CUSTOMER_USE addition", "'DELIVERY'", "'DELIVERY', 'CUSTOMER_USE'"]
  ];
  for (const mutation of scopeMutations) {
    const [name, from, to = ""] = mutation;
    const mutated = mutateSqlBlock(runbook, "08-available-blocked-occupied", (sql) =>
      sql.replace(from, to)
    );
    assert.notEqual(mutated, runbook, `scope mutation did not alter SQL: ${name}`);
    assert.throws(() => validateRunbookSql(mutated), undefined, name);
  }

  const missingPriority = runbook.replace(
    "AssetWorkOrderPriority = LOW | NORMAL | HIGH | URGENT",
    "AssetWorkOrderPriority = LOW | NORMAL | HIGH"
  );
  const reorderedEvents = runbook.replace(
    "AssetWorkOrderEventType = CREATED | ASSIGNED",
    "AssetWorkOrderEventType = ASSIGNED | CREATED"
  );
  assert.throws(() => validateEnumContracts(missingPriority, schema));
  assert.throws(() => validateEnumContracts(reorderedEvents, schema));
});

test("pins semantic restriction-function body validation", async () => {
  const runbook = await readOrEmpty(rolloutPath);
  const mutated = mutateSqlBlock(runbook, "15-database-catalog", (sql) =>
    sql.replace('NEW\\."scopes"', "restriction_scope_body_check_removed")
  );

  assert.notEqual(mutated, runbook);
  assert.throws(
    () => validateRunbookSql(mutated),
    /15-database-catalog missing SQL contract: actual\.function_definition !~ 'NEW/
  );
});

test("cross-links the Stage 1C-A period rollout and pins evidence redaction", async () => {
  const [runbook, periodRunbook] = await Promise.all([
    readOrEmpty(rolloutPath),
    readOrEmpty(periodRunbookPath)
  ]);

  assert.match(
    periodRunbook,
    /\[Stage 1C-B 资产工单与运营限制发布运行手册\]\(\.\/stage1c-asset-operations-rollout\.zh-CN\.md\)/
  );
  assertIncludesEvery(runbook, [
    "不得输出或保存 `DATABASE_URL`、数据库用户名或密码",
    "客户 PII、VIN、车牌",
    "仓库外受控加密证据存储",
    "SHA-256",
    "保留期限",
    "原始 SQL 输出不得提交 Git"
  ]);
});
