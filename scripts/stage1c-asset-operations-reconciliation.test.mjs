import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const rolloutPath = resolve(repoRoot, "docs/runbooks/stage1c-asset-operations-rollout.zh-CN.md");
const periodRunbookPath = resolve(repoRoot, "docs/runbooks/stage1c-period-facts-rollout.zh-CN.md");

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
  const runbook = await readOrEmpty(rolloutPath);

  assertIncludesEvery(runbook, [
    "DELIVERY_OUTBOUND | RETURN_INBOUND | SWAP_OUTBOUND | SWAP_INBOUND | RECOVERY | RECONDITIONING | MAINTENANCE",
    "PENDING | IN_PROGRESS | WAITING_EXTERNAL | PENDING_ACCEPTANCE | PENDING_COST_CONFIRMATION | CLOSED | CANCELLED",
    "RETURN_INSPECTION_PENDING | REINSPECTION_PENDING | RECONDITIONING_PENDING | MAINTENANCE_OR_ACCIDENT | RECOVERY_IN_PROGRESS | LEGAL_HOLD | EVIDENCE_EXCEPTION | OWNERSHIP_EXCEPTION | OTHER",
    "ADVISORY | BLOCKING",
    "ALLOCATION | DELIVERY | CUSTOMER_USE | INVENTORY_RELEASE",
    "ACTIVE | RELEASED | VOIDED",
    "ATTACH | SUPERSEDE | REMOVE",
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

test("makes every reconciliation SQL block independently copy/paste-safe and read-only", async () => {
  const runbook = await readOrEmpty(rolloutPath);
  const sqlBlocks = [...runbook.matchAll(/```sql\r?\n([\s\S]*?)```/g)].map((match) =>
    match[1].trim()
  );

  assert.ok(sqlBlocks.length >= 12, `expected at least 12 SQL blocks, found ${sqlBlocks.length}`);
  for (const [index, sql] of sqlBlocks.entries()) {
    assert.match(sql, /^BEGIN TRANSACTION READ ONLY;/);
    assert.match(sql, /COMMIT;$/);
    assert.doesNotMatch(
      sql,
      /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|CALL|DO|COPY)\b/im,
      `SQL block ${index + 1} contains a write-capable statement`
    );
  }
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
