# Stage 1C-C 资产成本与业务例外发布运行手册

## 1. 目的、依赖与非目标

本手册用于 Stage 1C-C 车辆成本只追加台账、冲正、snapshot-bound 业务例外审批和 command receipt 的
发布前/发布后核对。它依赖 [Stage 1C-A 期间与权属事实](./stage1c-period-facts-rollout.zh-CN.md)和
[Stage 1C-B 资产工单与运营限制](./stage1c-asset-operations-rollout.zh-CN.md)。本手册提供的是只读核对，
不是 apply；换言之，这是“只读核对，不是 apply”，不 backfill，也没有 reconciliation writer。

严格非目标：

- 不创建、补录、推断或批量转换成本、冲正、审批、receipt 或 AuditLog；不从工单事件推断成本事实。
- 不改写或删除任何 original/reversal、审批请求/决定/过期事实、receipt 或 AuditLog。
- 不提供权限 apply、migration deploy、历史 apply 或 seed；不得执行历史 apply，本手册不提供 apply 命令。
- 不得执行 `pnpm prisma:seed` 或 `pnpm prisma:seed:verify`。不得执行 `prisma migrate reset` 或 `prisma db push`。
- 不得修改历史 migration 或数据库 checksum，不清理 rolled-back 行，不用 schema push 消除 drift。
- 不执行网络、Production、Task 9、发布或业务写入。本地只读证据不能替代 Staging/Production 的独立
  变更单、审批和核对。

## 2. migration、checksum 与 drift 停止门禁

只把 `DATABASE_URL` 注入当前子进程；不得把连接串、用户名或密码写入参数、控制台或报告。按以下顺序
运行并保留每个原始退出码；任一非零立即停止：

```powershell
pnpm prisma:migrate:status
$migrationStatusExit = $LASTEXITCODE
if ($migrationStatusExit -ne 0) {
  throw "Migration status gate failed with exit code $migrationStatusExit"
}

pnpm prisma:validate
$schemaValidateExit = $LASTEXITCODE
if ($schemaValidateExit -ne 0) {
  throw "Prisma schema validation failed with exit code $schemaValidateExit"
}

pnpm prisma:migrate:checksum:verify
$migrationChecksumExit = $LASTEXITCODE
if ($migrationChecksumExit -ne 0) {
  throw "Migration checksum gate failed with exit code $migrationChecksumExit"
}

$schemaDiffExit = 1
Push-Location apps/api
try {
  pnpm exec prisma migrate diff `
    --from-config-datasource `
    --to-schema prisma/schema.prisma `
    --exit-code
  $schemaDiffExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($schemaDiffExit -ne 0) {
  throw "Datasource/schema drift gate failed with exit code $schemaDiffExit"
}
```

`migrate status`、`validate`、checksum 和 datasource→schema diff 是四个独立门禁，不能互相替代；
只有全部门禁退出码为 `0` 才能继续。已知专用 Local 数据库虽然有 97 个 migration 且 status/validate 为
`0`，但继承的 checksum mismatch `58`、非空 drift 和 rolled-back `1` 保持不变，因此明确
rollout-ineligible。不得修复、接受、忽略或重新基线化这些历史异常。

以下查询核对目录摘要和 Stage 1C-C 四个最终 migration；任一计数异常停止：

<!-- stage1c-accounting-sql:01-migration-catalog -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH expected_migration(migration_name) AS (
  VALUES
    ('20260821000000_stage1c_cost_ledger_exception_approval'),
    ('20260821000100_stage1c_cost_ledger_exception_approval_hardening'),
    ('20260821000200_stage1c_reversal_period_integrity'),
    ('20260821000300_stage1c_approval_decision_comment_integrity')
)
SELECT
  COUNT(*) FILTER (
    WHERE migration.finished_at IS NOT NULL
      AND migration.rolled_back_at IS NULL
  ) AS applied_migration_count,
  COUNT(*) FILTER (
    WHERE migration.rolled_back_at IS NOT NULL
  ) AS rolled_back_migration_count,
  COUNT(*) FILTER (
    WHERE migration.finished_at IS NULL
      AND migration.rolled_back_at IS NULL
  ) AS failed_or_incomplete_migration_count,
  COUNT(*) FILTER (
    WHERE expected.migration_name IS NOT NULL
      AND migration.finished_at IS NOT NULL
      AND migration.rolled_back_at IS NULL
  ) AS expected_stage1c_c_applied_count,
  md5(COALESCE(string_agg(
    migration.migration_name || ':' || migration.checksum,
    ',' ORDER BY migration.migration_name, migration.started_at, migration.id
  ), '')) AS migration_catalog_fingerprint
FROM _prisma_migrations AS migration
LEFT JOIN expected_migration AS expected
  ON expected.migration_name = migration.migration_name;
COMMIT;
```

## 3. 精确 enum、权限与双模式访问基线

以下顺序与 Prisma schema 精确一致；增删、重排或拼写变化均停止：

VehicleCostEntryKind = ORIGINAL | REVERSAL

VehicleCostActionType = ACTUAL_COST | RESPONSIBILITY_CONFIRMED | RECOVERY_EXPOSURE | RECOVERY_RECEIVED | WAIVER | WRITE_OFF

VehicleCostCategory = DAMAGE | CLEANING | REPAIR | MAINTENANCE | EXCESS_MILEAGE | VIOLATION | TOWING | INSURANCE | BAAS | DEPRECIATION | OTHER

VehicleCostResponsiblePartyType = CUSTOMER | INSURER | SUPPLIER | ASSET_OWNER | PLATFORM | OTHER

BusinessExceptionType = VEHICLE_REGISTRATION_DOCUMENT_MISSING | HANDOVER_EVIDENCE_EXCEPTION | SETTLEMENT_WAIVER | SETTLEMENT_WRITE_OFF | RECOVERY_EXECUTION_APPROVAL

BusinessExceptionSubjectType = VEHICLE | ORDER | CONTRACT | ASSET_WORK_ORDER | HANDOVER_WORK_ORDER | SETTLEMENT_CASE | RECOVERY_CASE

BusinessExceptionApprovalStatus = PENDING | APPROVED | REJECTED | EXPIRED

BusinessExceptionDecision = APPROVED | REJECTED

AssetAccountingCommandType = COST_APPEND | COST_REVERSE | EXCEPTION_REQUEST | EXCEPTION_DECIDE | EXCEPTION_EXPIRE

Stage 1C-C 新增且仅新增六个 permission definition：

| code                          | name             | module                | action    |
| ----------------------------- | ---------------- | --------------------- | --------- |
| `vehicle_cost_ledger:view`    | 查看车辆成本台账 | `vehicle_cost_ledger` | `view`    |
| `vehicle_cost_ledger:confirm` | 确认车辆成本台账 | `vehicle_cost_ledger` | `confirm` |
| `vehicle_cost_ledger:reverse` | 冲正车辆成本台账 | `vehicle_cost_ledger` | `reverse` |
| `business_exception:view`     | 查看业务例外审批 | `business_exception`  | `view`    |
| `business_exception:request`  | 发起业务例外审批 | `business_exception`  | `request` |
| `business_exception:approve`  | 审批业务例外     | `business_exception`  | `approve` |

Stage 1C-C 六权限的八角色精确矩阵如下；`no` 同样是 contract：

| 角色    | ledger view | ledger confirm | ledger reverse | exception view | exception request | exception approve |
| ------- | ----------- | -------------- | -------------- | -------------- | ----------------- | ----------------- |
| `ADMIN` | yes         | yes            | yes            | yes            | yes               | yes               |
| `AS`    | yes         | yes            | no             | yes            | yes               | no                |
| `OP`    | yes         | yes            | no             | yes            | yes               | no                |
| `FI`    | yes         | yes            | yes            | yes            | yes               | no                |
| `GM`    | yes         | no             | yes            | yes            | no                | yes               |
| `RC`    | yes         | no             | no             | yes            | yes               | no                |
| `SA`    | no          | no             | no             | no             | no                | no                |
| `CS`    | no          | no             | no             | no             | no                | no                |

访问同步器有两个不可混淆的模式。`--permissions-only` 是零 ownership coupling：只核对/同步角色、permission
和 grant，不读、不锁、不写 `AssetOwner` 或 `VehicleOwnershipPeriod`，报告 `platformOwner = NOT_MANAGED`
且没有 ownership period count。默认 legacy 模式保留平台 owner convergence，会读取、锁定并可能写平台
owner，也会读取/锁定 ownership period。两种 apply 都要求精确环境确认
`STAGE1C_ACCESS_BASELINE_APPLY=SYNC_STAGE1C_ACCESS_BASELINE`；但本手册只允许 permissions-only dry-run，
本手册不提供 apply 命令。

以下查询绑定六个新 definition、八个角色以及完整 Stage 1C 14 权限/54 个正向 grant；预期零行：

<!-- stage1c-accounting-sql:02-permission-matrix -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH expected_role(role_code) AS (
  VALUES ('ADMIN'), ('AS'), ('OP'), ('FI'), ('GM'), ('RC'), ('SA'), ('CS')
), all_stage1c_permission(code) AS (
  VALUES
    ('asset_facts:view'),
    ('asset_owner:manage'),
    ('vehicle_period:manage'),
    ('asset_operations:view'),
    ('asset_work_order:manage'),
    ('vehicle_restriction:manage'),
    ('vehicle_restriction:release'),
    ('vehicle_restriction:approve_release'),
    ('vehicle_cost_ledger:view'),
    ('vehicle_cost_ledger:confirm'),
    ('vehicle_cost_ledger:reverse'),
    ('business_exception:view'),
    ('business_exception:request'),
    ('business_exception:approve')
), stage1c_c_permission_definition(code, name, module, action) AS (
  VALUES
    ('vehicle_cost_ledger:view', '查看车辆成本台账', 'vehicle_cost_ledger', 'view'),
    ('vehicle_cost_ledger:confirm', '确认车辆成本台账', 'vehicle_cost_ledger', 'confirm'),
    ('vehicle_cost_ledger:reverse', '冲正车辆成本台账', 'vehicle_cost_ledger', 'reverse'),
    ('business_exception:view', '查看业务例外审批', 'business_exception', 'view'),
    ('business_exception:request', '发起业务例外审批', 'business_exception', 'request'),
    ('business_exception:approve', '审批业务例外', 'business_exception', 'approve')
), expected_grant(role_code, permission_code) AS (
  VALUES
    ('ADMIN', 'asset_facts:view'),
    ('ADMIN', 'asset_owner:manage'),
    ('ADMIN', 'vehicle_period:manage'),
    ('ADMIN', 'asset_operations:view'),
    ('ADMIN', 'asset_work_order:manage'),
    ('ADMIN', 'vehicle_restriction:manage'),
    ('ADMIN', 'vehicle_restriction:release'),
    ('ADMIN', 'vehicle_restriction:approve_release'),
    ('ADMIN', 'vehicle_cost_ledger:view'),
    ('ADMIN', 'vehicle_cost_ledger:confirm'),
    ('ADMIN', 'vehicle_cost_ledger:reverse'),
    ('ADMIN', 'business_exception:view'),
    ('ADMIN', 'business_exception:request'),
    ('ADMIN', 'business_exception:approve'),
    ('AS', 'asset_facts:view'),
    ('AS', 'asset_owner:manage'),
    ('AS', 'vehicle_period:manage'),
    ('AS', 'asset_operations:view'),
    ('AS', 'asset_work_order:manage'),
    ('AS', 'vehicle_restriction:manage'),
    ('AS', 'vehicle_restriction:release'),
    ('AS', 'vehicle_restriction:approve_release'),
    ('AS', 'vehicle_cost_ledger:view'),
    ('AS', 'vehicle_cost_ledger:confirm'),
    ('AS', 'business_exception:view'),
    ('AS', 'business_exception:request'),
    ('OP', 'asset_facts:view'),
    ('OP', 'vehicle_period:manage'),
    ('OP', 'asset_operations:view'),
    ('OP', 'asset_work_order:manage'),
    ('OP', 'vehicle_restriction:manage'),
    ('OP', 'vehicle_restriction:release'),
    ('OP', 'vehicle_cost_ledger:view'),
    ('OP', 'vehicle_cost_ledger:confirm'),
    ('OP', 'business_exception:view'),
    ('OP', 'business_exception:request'),
    ('FI', 'asset_facts:view'),
    ('FI', 'asset_operations:view'),
    ('FI', 'vehicle_cost_ledger:view'),
    ('FI', 'vehicle_cost_ledger:confirm'),
    ('FI', 'vehicle_cost_ledger:reverse'),
    ('FI', 'business_exception:view'),
    ('FI', 'business_exception:request'),
    ('GM', 'asset_facts:view'),
    ('GM', 'asset_operations:view'),
    ('GM', 'vehicle_restriction:approve_release'),
    ('GM', 'vehicle_cost_ledger:view'),
    ('GM', 'vehicle_cost_ledger:reverse'),
    ('GM', 'business_exception:view'),
    ('GM', 'business_exception:approve'),
    ('RC', 'asset_operations:view'),
    ('RC', 'vehicle_cost_ledger:view'),
    ('RC', 'business_exception:view'),
    ('RC', 'business_exception:request')
), actual_stage1c_c_permission AS (
  SELECT permission.code, permission.name, permission.module, permission.action,
    permission.status::text AS status, permission.deleted_at
  FROM permission
  WHERE permission.module IN ('vehicle_cost_ledger', 'business_exception')
     OR permission.code LIKE 'vehicle_cost_ledger:%'
     OR permission.code LIKE 'business_exception:%'
), actual_relevant_grant AS (
  SELECT role.code::text AS role_code, permission.code AS permission_code
  FROM role_permission AS grant_row
  JOIN "role" AS role ON role.id = grant_row.role_id
  JOIN permission ON permission.id = grant_row.permission_id
  WHERE permission.code IN (SELECT code FROM all_stage1c_permission)
     OR permission.code IN (SELECT code FROM actual_stage1c_c_permission)
), matrix_cell AS (
  SELECT
    role.role_code,
    permission.code AS permission_code,
    expected.role_code IS NOT NULL AS expected,
    actual.role_code IS NOT NULL AS actual
  FROM expected_role AS role
  CROSS JOIN all_stage1c_permission AS permission
  LEFT JOIN expected_grant AS expected
    ON expected.role_code = role.role_code
   AND expected.permission_code = permission.code
  LEFT JOIN actual_relevant_grant AS actual
    ON actual.role_code = role.role_code
   AND actual.permission_code = permission.code
), anomaly AS (
  SELECT
    'ROLE'::text AS anomaly_kind,
    expected.role_code,
    NULL::text AS permission_code,
    'missing/inactive/deleted role'::text AS detail
  FROM expected_role AS expected
  LEFT JOIN "role" AS actual ON actual.code::text = expected.role_code
  WHERE actual.id IS NULL
     OR actual.status::text IS DISTINCT FROM 'ACTIVE'
     OR actual.deleted_at IS NOT NULL

  UNION ALL

  SELECT
    'UNEXPECTED_PERMISSION_DEFINITION',
    NULL,
    actual.code,
    'unexpected module/namespace permission; active/inactive/deleted all block'
  FROM actual_stage1c_c_permission AS actual
  LEFT JOIN stage1c_c_permission_definition AS expected ON expected.code = actual.code
  WHERE expected.code IS NULL

  UNION ALL

  SELECT
    'PERMISSION_DEFINITION_COUNT',
    NULL,
    NULL,
    'expected=6,actual=' || COUNT(*)::text
  FROM actual_stage1c_c_permission
  HAVING COUNT(*) <> 6

  UNION ALL

  SELECT
    'PERMISSION_DEFINITION',
    NULL,
    expected.code,
    'missing/inactive/deleted/identity drift'
  FROM stage1c_c_permission_definition AS expected
  LEFT JOIN permission AS actual ON actual.code = expected.code
  WHERE actual.id IS NULL
     OR actual.name IS DISTINCT FROM expected.name
     OR actual.module IS DISTINCT FROM expected.module
     OR actual.action IS DISTINCT FROM expected.action
     OR actual.status::text IS DISTINCT FROM 'ACTIVE'
     OR actual.deleted_at IS NOT NULL

  UNION ALL

  SELECT
    'ROLE_PERMISSION',
    role_code,
    permission_code,
    'expected=' || expected::text || ',actual=' || actual::text
  FROM matrix_cell
  WHERE actual IS DISTINCT FROM expected

  UNION ALL

  SELECT
    'UNEXPECTED_ROLE_PERMISSION',
    actual.role_code,
    actual.permission_code,
    'grant is outside the exact 54-grant matrix'
  FROM actual_relevant_grant AS actual
  LEFT JOIN expected_grant AS expected
    ON expected.role_code = actual.role_code
   AND expected.permission_code = actual.permission_code
  WHERE expected.role_code IS NULL

  UNION ALL

  SELECT
    'MATRIX_CONTRACT',
    NULL,
    NULL,
    'expected=54,actual=' || (SELECT COUNT(*) FROM actual_relevant_grant)::text
  WHERE (SELECT COUNT(*) FROM expected_grant) <> 54
     OR (SELECT COUNT(*) FROM actual_relevant_grant) <> 54
)
SELECT anomaly_kind, role_code, permission_code, detail
FROM anomaly
ORDER BY anomaly_kind, role_code, permission_code;
COMMIT;
```

## 4. API、source、replay 与 redaction contract

公开 API 的 verb/path/permission 精确 inventory 为：

| verb | path                                                      | permission                    |
| ---- | --------------------------------------------------------- | ----------------------------- |
| POST | `/asset-accounting/cost-entries`                          | `vehicle_cost_ledger:confirm` |
| POST | `/asset-accounting/cost-entries/:id/reverse`              | `vehicle_cost_ledger:reverse` |
| GET  | `/asset-accounting/cost-entries/:id`                      | `vehicle_cost_ledger:view`    |
| GET  | `/asset-accounting/vehicles/:vehicleId/cost-entries`      | `vehicle_cost_ledger:view`    |
| GET  | `/asset-accounting/orders/:orderId/cost-entries`          | `vehicle_cost_ledger:view`    |
| GET  | `/asset-accounting/work-orders/:workOrderId/cost-entries` | `vehicle_cost_ledger:view`    |
| GET  | `/asset-accounting/exception-approvals/:id`               | `business_exception:view`     |
| GET  | `/asset-accounting/exception-approvals`                   | `business_exception:view`     |

没有 public approval mutation endpoint；审批 request/decide/expire/require-current 只能由 owning workflow 在
同一 caller-owned `READ COMMITTED` transaction 中调用 service。只接受 server-side authority resolver。

所有五种写命令使用 exact source tuple `{ type, id, key }`；`id` 是 UUID 小写 canonical，非空标量
`Idempotency-Key` 必须与 `key` 精确相等。同一 exact source tuple 在所有五种 command type 之间全局唯一。
repository 先锁 source 并执行 receipt-first replay：command type、canonical payload、小写 SHA-256 任一漂移
返回 `ASSET_ACCOUNTING_SOURCE_CONFLICT`；完全相同则返回既存 immutable outcome、`wrote: false`。它不新增 AuditLog。
reason 必须非空并进入 canonical payload 与 AuditLog；重放不能换 key 掩盖 payload/reason 漂移。

公开读取不返回 receipt、payload hash 或 authority resolver 数据；`decisionComment` 不进入 public read。
审批决策只能接收 `approvalId`、subject identity、exception type、`expectedVersion`、decision/comment/source 等
命令字段，不接受 client snapshot 或 client hash。

## 5. 只追加成本、冲正与 CLOSED 工单裁决

original 和 reversal 均为不可变事实。reversal 只能指向 original，且一个 original 最多一个 reversal；金额
必须精确取反。除新的 `confirmedAt`、`confirmedBy` 和 source tuple 外，以下 16 个维度必须与 original
完全相同：vehicle、order、contract、customer、asset owner、work order、`occurredOn`、
`accountingPeriod`、action type、cost category、responsible party type/id、asset-owner snapshot、evidence
id/snapshot、responsibility snapshot。不能冲正 reversal，也不能改变历史发生日或会计期间。

对于 `CLOSED` 且 `costConfirmationRequired = true` 的工单，必须始终至少保留一个 active unreversed
`ORIGINAL / ACTUAL_COST`。冲正最后一个 active original 必须返回
`ASSET_ACCOUNTING_WORK_ORDER_COST_NOT_CONFIRMED`，且零 reversal/receipt/audit 写入。裁决固定为：
先追加 replacement，再冲正原 entry；replacement 必须已经提交并保持 active，不能把已完全冲正的历史 original
当作 replacement。legacy `COST_CONFIRMED` event 不是成本权威事实。

## 6. snapshot-bound approval contract 与 resolver fail-closed

authority snapshot 只由 owning workflow 注册的 server-side authority resolver 在 source→subject 锁顺序内
读取；canonical JSON 后计算小写 SHA-256，request 保存 immutable snapshot/hash。requester 不能审批自己的请求；
ADMIN 也不能绕过。决定使用 `expectedVersion` CAS；合法状态仅为
`PENDING → APPROVED | REJECTED | EXPIRED` 和 `APPROVED → EXPIRED`，每次版本精确加一，APPROVED 决策
元组过期时仍不可改写。APPROVED、REJECTED 以及带 APPROVED 决定元组的 EXPIRED 都必须保存非空、
非空白 `decision_comment`；由 PENDING 直接过期则保持 decision/comment/decider 元组全为 NULL。当前 authority 与保存 hash 不同后，
旧的 live approval 必须 EXPIRED；不能继续
消费旧批准。

当前代码库没有 registered owning writer/resolver，且 subject 是多态的，数据库无法从 subject type/id/field
安全猜测权威 snapshot。因此第 10 节 `registered_resolver` CTE 明确为空：任何 live approval 都报告
`UNRESOLVED_NO_REGISTERED_RESOLVER` 并 fail closed；不得把客户端 snapshot/hash、receipt snapshot、审批
自身 snapshot 或通用 SQL 猜测注册成 resolver。未来 owning writer 合入后，必须以单独评审更新该 CTE 为
明确的 server-derived resolver 输出，并重新执行全部门禁；只有注册输出与保存 hash 不同才分类为
`STALE_ACTIVE_APPROVAL` 并通过已批准 service 过期，不能直接 UPDATE。

## 7. 数据库 catalog 精确身份与语义

以下查询预期零行。它绑定 `current_schema()`，要求四个 trigger 的 table/function/schema、完整规范化定义、
`tgtype`、普通启用状态、空 `tgattr` 和空 `tgqual` 精确一致；要求三个函数完整正文（包括固定
`search_path`）、11 个 validated CHECK、Task 1 全部 15 个 validated FK（名称、本地列、owning/referenced
schema 都是 `current_schema()`、引用表/列、`ON DELETE RESTRICT`）和 15 个 valid/ready index 精确一致。
仅同名、错误 owning/referenced schema、disabled trigger、`UPDATE OF` 缩窄、额外 `WHEN`、无效 FK/index
或部分函数正文都阻断。

<!-- stage1c-accounting-sql:03-database-catalog -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH expected_trigger_raw(
  table_name, trigger_name, function_name, expected_tgtype, trigger_definition
) AS (
  VALUES
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_reversal_integrity',
      'enforce_vehicle_cost_ledger_reversal', 7,
      $definition$CREATE TRIGGER vehicle_cost_ledger_entry_reversal_integrity BEFORE INSERT ON vehicle_cost_ledger_entry FOR EACH ROW EXECUTE FUNCTION enforce_vehicle_cost_ledger_reversal()$definition$),
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_append_only',
      'reject_asset_accounting_append_only_mutation', 27,
      $definition$CREATE TRIGGER vehicle_cost_ledger_entry_append_only BEFORE DELETE OR UPDATE ON vehicle_cost_ledger_entry FOR EACH ROW EXECUTE FUNCTION reject_asset_accounting_append_only_mutation()$definition$),
    ('asset_accounting_command_receipt', 'asset_accounting_command_receipt_append_only',
      'reject_asset_accounting_append_only_mutation', 27,
      $definition$CREATE TRIGGER asset_accounting_command_receipt_append_only BEFORE DELETE OR UPDATE ON asset_accounting_command_receipt FOR EACH ROW EXECUTE FUNCTION reject_asset_accounting_append_only_mutation()$definition$),
    ('business_exception_approval', 'business_exception_approval_transition_only',
      'enforce_business_exception_approval_transition', 31,
      $definition$CREATE TRIGGER business_exception_approval_transition_only BEFORE INSERT OR DELETE OR UPDATE ON business_exception_approval FOR EACH ROW EXECUTE FUNCTION enforce_business_exception_approval_transition()$definition$)
), expected_trigger AS (
  SELECT
    table_name, trigger_name, function_name, expected_tgtype,
    btrim(regexp_replace(trigger_definition, '\s+', ' ', 'g')) AS normalized_definition
  FROM expected_trigger_raw
), expected_function_raw(function_name, function_definition) AS (
  VALUES
    ('enforce_vehicle_cost_ledger_reversal', $definition$CREATE OR REPLACE FUNCTION enforce_vehicle_cost_ledger_reversal()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
    original "public"."vehicle_cost_ledger_entry"%ROWTYPE;
BEGIN
    IF NEW."entry_kind" <> 'REVERSAL' THEN
        RETURN NEW;
    END IF;

    SELECT * INTO original
    FROM "public"."vehicle_cost_ledger_entry"
    WHERE "id" = NEW."reversal_of_entry_id"
    FOR KEY SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'vehicle_cost_ledger_entry_reversal_target_fkey', MESSAGE = 'reversal target does not exist';
    END IF;

    IF original."entry_kind" = 'REVERSAL' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'vehicle_cost_ledger_entry_reverse_of_reversal_chk', MESSAGE = 'a reversal cannot target another reversal';
    END IF;

    IF NEW."amount_cents" <> -original."amount_cents" THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'vehicle_cost_ledger_entry_reversal_amount_chk', MESSAGE = 'reversal amount must be the exact opposite of the original';
    END IF;

    IF ROW(
        NEW."vehicle_id", NEW."order_id", NEW."contract_id", NEW."customer_id",
        NEW."asset_owner_id", NEW."work_order_id", NEW."occurred_on", NEW."accounting_period",
        NEW."action_type", NEW."cost_category", NEW."responsible_party_type", NEW."responsible_party_id",
        NEW."asset_owner_snapshot", NEW."evidence_id", NEW."evidence_snapshot", NEW."responsibility_snapshot"
    ) IS DISTINCT FROM ROW(
        original."vehicle_id", original."order_id", original."contract_id", original."customer_id",
        original."asset_owner_id", original."work_order_id", original."occurred_on", original."accounting_period",
        original."action_type", original."cost_category", original."responsible_party_type", original."responsible_party_id",
        original."asset_owner_snapshot", original."evidence_id", original."evidence_snapshot", original."responsibility_snapshot"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'vehicle_cost_ledger_entry_reversal_reference_chk', MESSAGE = 'reversal must preserve the original accounting and authority references';
    END IF;

    RETURN NEW;
END;
$function$
$definition$),
    ('reject_asset_accounting_append_only_mutation', $definition$CREATE OR REPLACE FUNCTION reject_asset_accounting_append_only_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = format('%I is append-only', TG_TABLE_NAME);
END;
$function$
$definition$),
    ('enforce_business_exception_approval_transition', $definition$CREATE OR REPLACE FUNCTION enforce_business_exception_approval_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT (
            NEW."status" = 'PENDING' AND NEW."version" = 0
            AND NEW."decision" IS NULL AND NEW."decision_comment" IS NULL
            AND NEW."decided_by" IS NULL AND NEW."decided_at" IS NULL
            AND NEW."expiry_reason" IS NULL AND NEW."expired_by" IS NULL AND NEW."expired_at" IS NULL
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'business_exception_approval must be inserted as a new pending request';
        END IF;

        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'business_exception_approval cannot be deleted';
    END IF;

    IF ROW(
        NEW."id", NEW."approval_no", NEW."exception_type", NEW."subject_type", NEW."subject_id",
        NEW."subject_field", NEW."subject_snapshot", NEW."subject_snapshot_hash", NEW."request_reason",
        NEW."request_evidence_snapshot", NEW."requested_by", NEW."requested_at", NEW."request_source_type",
        NEW."request_source_id", NEW."request_source_key", NEW."created_at"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."approval_no", OLD."exception_type", OLD."subject_type", OLD."subject_id",
        OLD."subject_field", OLD."subject_snapshot", OLD."subject_snapshot_hash", OLD."request_reason",
        OLD."request_evidence_snapshot", OLD."requested_by", OLD."requested_at", OLD."request_source_type",
        OLD."request_source_id", OLD."request_source_key", OLD."created_at"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'business_exception_approval request facts are immutable';
    END IF;

    IF NOT (
        (OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'REJECTED', 'EXPIRED'))
        OR (OLD."status" = 'APPROVED' AND NEW."status" = 'EXPIRED')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'business_exception_approval has an invalid status transition';
    END IF;

    IF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'business_exception_approval version must increment by one';
    END IF;

    IF OLD."status" = 'APPROVED' AND ROW(
        NEW."decision", NEW."decision_comment", NEW."decided_by", NEW."decided_at"
    ) IS DISTINCT FROM ROW(
        OLD."decision", OLD."decision_comment", OLD."decided_by", OLD."decided_at"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'business_exception_approval decision facts are immutable';
    END IF;

    RETURN NEW;
END;
$function$
$definition$)
), expected_function AS (
  SELECT
    function_name,
    btrim(regexp_replace(function_definition, '\s+', ' ', 'g')) AS normalized_definition
  FROM expected_function_raw
), expected_constraint_raw(table_name, constraint_name, constraint_definition) AS (
  VALUES
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_amount_nonzero_chk',
      $definition$CHECK ((amount_cents <> 0))$definition$),
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_kind_amount_shape_chk',
      $definition$CHECK ((((entry_kind = 'ORIGINAL'::vehicle_cost_entry_kind) AND (amount_cents > 0) AND (reversal_of_entry_id IS NULL)) OR ((entry_kind = 'REVERSAL'::vehicle_cost_entry_kind) AND (amount_cents < 0) AND (reversal_of_entry_id IS NOT NULL))))$definition$),
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_accounting_period_chk',
      $definition$CHECK (((accounting_period)::text ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))$definition$),
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_source_key_not_blank_chk',
      $definition$CHECK (((btrim((source_type)::text) <> ''::text) AND (btrim((source_key)::text) <> ''::text)))$definition$),
    ('business_exception_approval', 'business_exception_approval_snapshot_hash_chk',
      $definition$CHECK (((subject_snapshot_hash)::text ~ '^[0-9a-f]{64}$'::text))$definition$),
    ('business_exception_approval', 'business_exception_approval_request_source_key_not_blank_chk',
      $definition$CHECK (((btrim((request_source_type)::text) <> ''::text) AND (btrim((request_source_key)::text) <> ''::text)))$definition$),
    ('business_exception_approval', 'business_exception_approval_version_nonnegative_chk',
      $definition$CHECK ((version >= 0))$definition$),
    ('business_exception_approval', 'business_exception_approval_status_shape_chk',
      $definition$CHECK ((((status = 'PENDING'::business_exception_approval_status) AND (decision IS NULL) AND (decision_comment IS NULL) AND (decided_by IS NULL) AND (decided_at IS NULL) AND (expiry_reason IS NULL) AND (expired_by IS NULL) AND (expired_at IS NULL)) OR ((status = 'APPROVED'::business_exception_approval_status) AND (decision = 'APPROVED'::business_exception_decision) AND (decision_comment IS NOT NULL) AND (btrim(decision_comment) <> ''::text) AND (decided_by IS NOT NULL) AND (decided_at IS NOT NULL) AND (expiry_reason IS NULL) AND (expired_by IS NULL) AND (expired_at IS NULL)) OR ((status = 'REJECTED'::business_exception_approval_status) AND (decision = 'REJECTED'::business_exception_decision) AND (decision_comment IS NOT NULL) AND (btrim(decision_comment) <> ''::text) AND (decided_by IS NOT NULL) AND (decided_at IS NOT NULL) AND (expiry_reason IS NULL) AND (expired_by IS NULL) AND (expired_at IS NULL)) OR ((status = 'EXPIRED'::business_exception_approval_status) AND (expiry_reason IS NOT NULL) AND (expired_by IS NOT NULL) AND (expired_at IS NOT NULL) AND (((decision IS NULL) AND (decision_comment IS NULL) AND (decided_by IS NULL) AND (decided_at IS NULL)) OR ((decision = 'APPROVED'::business_exception_decision) AND (decision_comment IS NOT NULL) AND (btrim(decision_comment) <> ''::text) AND (decided_by IS NOT NULL) AND (decided_at IS NOT NULL))))))$definition$),
    ('asset_accounting_command_receipt', 'asset_accounting_command_receipt_payload_hash_chk',
      $definition$CHECK (((payload_hash)::text ~ '^[0-9a-f]{64}$'::text))$definition$),
    ('asset_accounting_command_receipt', 'asset_accounting_command_receipt_source_key_not_blank_chk',
      $definition$CHECK (((btrim((source_type)::text) <> ''::text) AND (btrim((source_key)::text) <> ''::text)))$definition$),
    ('asset_accounting_command_receipt', 'asset_accounting_command_receipt_target_shape_chk',
      $definition$CHECK ((((cost_entry_id IS NOT NULL) AND (approval_id IS NULL)) OR ((cost_entry_id IS NULL) AND (approval_id IS NOT NULL))))$definition$)
), expected_constraint AS (
  SELECT
    table_name, constraint_name,
    btrim(regexp_replace(constraint_definition, '\s+', ' ', 'g')) AS normalized_definition
  FROM expected_constraint_raw
), expected_foreign_key(
  constraint_name, table_name, local_columns,
  referenced_table, referenced_columns, confdeltype
) AS (
  VALUES
    ('vehicle_cost_ledger_entry_vehicle_id_fkey', 'vehicle_cost_ledger_entry', 'vehicle_id', 'vehicle', 'id', 'r'),
    ('vehicle_cost_ledger_entry_order_id_fkey', 'vehicle_cost_ledger_entry', 'order_id', 'subscription_order', 'id', 'r'),
    ('vehicle_cost_ledger_entry_contract_id_fkey', 'vehicle_cost_ledger_entry', 'contract_id', 'contract', 'id', 'r'),
    ('vehicle_cost_ledger_entry_customer_id_fkey', 'vehicle_cost_ledger_entry', 'customer_id', 'customer', 'id', 'r'),
    ('vehicle_cost_ledger_entry_asset_owner_id_fkey', 'vehicle_cost_ledger_entry', 'asset_owner_id', 'asset_owner', 'id', 'r'),
    ('vehicle_cost_ledger_entry_work_order_id_fkey', 'vehicle_cost_ledger_entry', 'work_order_id', 'asset_work_order', 'id', 'r'),
    ('vehicle_cost_ledger_entry_evidence_id_fkey', 'vehicle_cost_ledger_entry', 'evidence_id', 'asset_work_order_evidence', 'id', 'r'),
    ('vehicle_cost_ledger_entry_confirmed_by_fkey', 'vehicle_cost_ledger_entry', 'confirmed_by', 'user', 'id', 'r'),
    ('vehicle_cost_ledger_entry_reversal_of_entry_id_fkey', 'vehicle_cost_ledger_entry', 'reversal_of_entry_id', 'vehicle_cost_ledger_entry', 'id', 'r'),
    ('business_exception_approval_requested_by_fkey', 'business_exception_approval', 'requested_by', 'user', 'id', 'r'),
    ('business_exception_approval_decided_by_fkey', 'business_exception_approval', 'decided_by', 'user', 'id', 'r'),
    ('business_exception_approval_expired_by_fkey', 'business_exception_approval', 'expired_by', 'user', 'id', 'r'),
    ('asset_accounting_command_receipt_cost_entry_id_fkey', 'asset_accounting_command_receipt', 'cost_entry_id', 'vehicle_cost_ledger_entry', 'id', 'r'),
    ('asset_accounting_command_receipt_approval_id_fkey', 'asset_accounting_command_receipt', 'approval_id', 'business_exception_approval', 'id', 'r'),
    ('asset_accounting_command_receipt_actor_id_fkey', 'asset_accounting_command_receipt', 'actor_id', 'user', 'id', 'r')
), expected_index_raw(table_name, index_name, expected_unique, index_definition) AS (
  VALUES
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_vehicle_occurred_on_idx', false,
      $definition$CREATE INDEX vehicle_cost_ledger_entry_vehicle_occurred_on_idx ON vehicle_cost_ledger_entry USING btree (vehicle_id, occurred_on)$definition$),
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_order_id_idx', false,
      $definition$CREATE INDEX vehicle_cost_ledger_entry_order_id_idx ON vehicle_cost_ledger_entry USING btree (order_id)$definition$),
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_contract_id_idx', false,
      $definition$CREATE INDEX vehicle_cost_ledger_entry_contract_id_idx ON vehicle_cost_ledger_entry USING btree (contract_id)$definition$),
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_customer_id_idx', false,
      $definition$CREATE INDEX vehicle_cost_ledger_entry_customer_id_idx ON vehicle_cost_ledger_entry USING btree (customer_id)$definition$),
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_asset_owner_id_idx', false,
      $definition$CREATE INDEX vehicle_cost_ledger_entry_asset_owner_id_idx ON vehicle_cost_ledger_entry USING btree (asset_owner_id)$definition$),
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_work_order_id_idx', false,
      $definition$CREATE INDEX vehicle_cost_ledger_entry_work_order_id_idx ON vehicle_cost_ledger_entry USING btree (work_order_id)$definition$),
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_source_key_idx', false,
      $definition$CREATE INDEX vehicle_cost_ledger_entry_source_key_idx ON vehicle_cost_ledger_entry USING btree (source_type, source_id, source_key)$definition$),
    ('vehicle_cost_ledger_entry', 'vehicle_cost_ledger_entry_reversal_of_entry_id_key', true,
      $definition$CREATE UNIQUE INDEX vehicle_cost_ledger_entry_reversal_of_entry_id_key ON vehicle_cost_ledger_entry USING btree (reversal_of_entry_id) WHERE (reversal_of_entry_id IS NOT NULL)$definition$),
    ('business_exception_approval', 'business_exception_approval_approval_no_key', true,
      $definition$CREATE UNIQUE INDEX business_exception_approval_approval_no_key ON business_exception_approval USING btree (approval_no)$definition$),
    ('business_exception_approval', 'business_exception_approval_subject_idx', false,
      $definition$CREATE INDEX business_exception_approval_subject_idx ON business_exception_approval USING btree (subject_type, subject_id, subject_field)$definition$),
    ('business_exception_approval', 'business_exception_approval_status_idx', false,
      $definition$CREATE INDEX business_exception_approval_status_idx ON business_exception_approval USING btree (status)$definition$),
    ('business_exception_approval', 'business_exception_approval_live_subject_field_snapshot_key', true,
      $definition$CREATE UNIQUE INDEX business_exception_approval_live_subject_field_snapshot_key ON business_exception_approval USING btree (subject_type, subject_id, subject_field, subject_snapshot_hash) WHERE (status = ANY (ARRAY['PENDING'::business_exception_approval_status, 'APPROVED'::business_exception_approval_status]))$definition$),
    ('asset_accounting_command_receipt', 'asset_accounting_command_receipt_source_key', true,
      $definition$CREATE UNIQUE INDEX asset_accounting_command_receipt_source_key ON asset_accounting_command_receipt USING btree (source_type, source_id, source_key)$definition$),
    ('asset_accounting_command_receipt', 'asset_accounting_command_receipt_cost_entry_id_idx', false,
      $definition$CREATE INDEX asset_accounting_command_receipt_cost_entry_id_idx ON asset_accounting_command_receipt USING btree (cost_entry_id)$definition$),
    ('asset_accounting_command_receipt', 'asset_accounting_command_receipt_approval_id_idx', false,
      $definition$CREATE INDEX asset_accounting_command_receipt_approval_id_idx ON asset_accounting_command_receipt USING btree (approval_id)$definition$)
), expected_index AS (
  SELECT
    table_name, index_name, expected_unique,
    btrim(regexp_replace(index_definition, '\s+', ' ', 'g')) AS normalized_definition
  FROM expected_index_raw
), actual_trigger AS (
  SELECT
    table_schema.nspname AS table_schema,
    table_name.relname AS table_name,
    trigger.tgname AS trigger_name,
    trigger.tgenabled,
    trigger.tgtype::integer AS tgtype,
    trigger.tgattr = ''::int2vector AS no_update_column_restriction,
    trigger.tgqual IS NULL AS no_when_condition,
    function_schema.nspname AS function_schema,
    function_name.proname AS function_name,
    btrim(regexp_replace(
      replace(pg_get_triggerdef(trigger.oid), table_schema.nspname || '.', ''),
      '\s+', ' ', 'g'
    )) AS normalized_definition
  FROM pg_trigger AS trigger
  JOIN pg_class AS table_name ON table_name.oid = trigger.tgrelid
  JOIN pg_namespace AS table_schema ON table_schema.oid = table_name.relnamespace
  JOIN pg_proc AS function_name ON function_name.oid = trigger.tgfoid
  JOIN pg_namespace AS function_schema ON function_schema.oid = function_name.pronamespace
  WHERE NOT trigger.tgisinternal
), actual_function AS (
  SELECT
    namespace.nspname AS function_schema,
    function_name.proname AS function_name,
    btrim(regexp_replace(
      replace(pg_get_functiondef(function_name.oid), namespace.nspname || '.', ''),
      '\s+', ' ', 'g'
    )) AS normalized_definition
  FROM pg_proc AS function_name
  JOIN pg_namespace AS namespace ON namespace.oid = function_name.pronamespace
  WHERE function_name.proname IN (
    'enforce_vehicle_cost_ledger_reversal',
    'reject_asset_accounting_append_only_mutation',
    'enforce_business_exception_approval_transition'
  )
), actual_constraint AS (
  SELECT
    namespace.nspname AS table_schema,
    table_name.relname AS table_name,
    constraint_name.conname AS constraint_name,
    constraint_name.convalidated,
    btrim(regexp_replace(
      pg_get_constraintdef(constraint_name.oid), '\s+', ' ', 'g'
    )) AS normalized_definition
  FROM pg_constraint AS constraint_name
  JOIN pg_class AS table_name ON table_name.oid = constraint_name.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = table_name.relnamespace
  WHERE constraint_name.contype = 'c'
), actual_foreign_key AS (
  SELECT
    table_namespace.nspname AS table_schema,
    table_name.relname AS table_name,
    foreign_constraint.conname AS constraint_name,
    array_to_string(ARRAY(
      SELECT attribute.attname
      FROM unnest(foreign_constraint.conkey) WITH ORDINALITY AS key(attnum, position)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = foreign_constraint.conrelid
       AND attribute.attnum = key.attnum
      ORDER BY key.position
    ), ',') AS local_columns,
    referenced_namespace.nspname AS referenced_schema,
    referenced_table.relname AS referenced_table,
    array_to_string(ARRAY(
      SELECT attribute.attname
      FROM unnest(foreign_constraint.confkey) WITH ORDINALITY AS key(attnum, position)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = foreign_constraint.confrelid
       AND attribute.attnum = key.attnum
      ORDER BY key.position
    ), ',') AS referenced_columns,
    foreign_constraint.confdeltype,
    foreign_constraint.convalidated
  FROM pg_constraint AS foreign_constraint
  JOIN pg_class AS table_name ON table_name.oid = foreign_constraint.conrelid
  JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_name.relnamespace
  JOIN pg_class AS referenced_table ON referenced_table.oid = foreign_constraint.confrelid
  JOIN pg_namespace AS referenced_namespace
    ON referenced_namespace.oid = referenced_table.relnamespace
  WHERE foreign_constraint.contype = 'f'
), actual_index AS (
  SELECT
    table_namespace.nspname AS table_schema,
    table_name.relname AS table_name,
    index_name.relname AS index_name,
    index_state.indisunique,
    index_state.indisvalid,
    index_state.indisready,
    btrim(regexp_replace(
      replace(pg_get_indexdef(index_name.oid), table_namespace.nspname || '.', ''),
      '\s+', ' ', 'g'
    )) AS normalized_definition
  FROM pg_index AS index_state
  JOIN pg_class AS index_name ON index_name.oid = index_state.indexrelid
  JOIN pg_class AS table_name ON table_name.oid = index_state.indrelid
  JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_name.relnamespace
), trigger_anomaly AS (
  SELECT
    'TRIGGER'::text AS object_kind,
    expected.table_name,
    expected.trigger_name AS object_name
  FROM expected_trigger AS expected
  LEFT JOIN actual_trigger AS actual
    ON actual.table_name = expected.table_name
   AND actual.trigger_name = expected.trigger_name
  GROUP BY expected.table_name, expected.trigger_name, expected.function_name,
    expected.expected_tgtype, expected.normalized_definition
  HAVING COUNT(*) FILTER (WHERE actual.table_schema = current_schema()) <> 1
     OR COUNT(*) FILTER (WHERE actual.table_schema <> current_schema()) > 0
     OR BOOL_OR(
       actual.table_schema = current_schema()
       AND (
         actual.function_schema IS DISTINCT FROM current_schema()
         OR actual.function_name IS DISTINCT FROM expected.function_name
         OR actual.tgenabled IS DISTINCT FROM 'O'
         OR actual.tgtype IS DISTINCT FROM expected.expected_tgtype
         OR actual.no_update_column_restriction IS NOT TRUE
         OR actual.no_when_condition IS NOT TRUE
         OR actual.normalized_definition IS DISTINCT FROM expected.normalized_definition
       )
     )
), function_anomaly AS (
  SELECT
    'FUNCTION'::text AS object_kind,
    '<none>'::text AS table_name,
    expected.function_name AS object_name
  FROM expected_function AS expected
  LEFT JOIN actual_function AS actual ON actual.function_name = expected.function_name
  GROUP BY expected.function_name, expected.normalized_definition
  HAVING COUNT(*) FILTER (WHERE actual.function_schema = current_schema()) <> 1
     OR COUNT(*) FILTER (WHERE actual.function_schema <> current_schema()) > 0
     OR BOOL_OR(
       actual.function_schema = current_schema()
       AND actual.normalized_definition IS DISTINCT FROM expected.normalized_definition
     )
), constraint_anomaly AS (
  SELECT
    'CHECK'::text AS object_kind,
    expected.table_name,
    expected.constraint_name AS object_name
  FROM expected_constraint AS expected
  LEFT JOIN actual_constraint AS actual
    ON actual.table_name = expected.table_name
   AND actual.constraint_name = expected.constraint_name
  GROUP BY expected.table_name, expected.constraint_name, expected.normalized_definition
  HAVING COUNT(*) FILTER (WHERE actual.table_schema = current_schema()) <> 1
     OR COUNT(*) FILTER (WHERE actual.table_schema <> current_schema()) > 0
     OR BOOL_OR(
       actual.table_schema = current_schema()
       AND (
         actual.convalidated IS NOT TRUE
         OR actual.normalized_definition IS DISTINCT FROM expected.normalized_definition
       )
     )
), foreign_key_anomaly AS (
  SELECT
    'FOREIGN_KEY'::text AS object_kind,
    expected.table_name,
    expected.constraint_name AS object_name
  FROM expected_foreign_key AS expected
  LEFT JOIN actual_foreign_key AS foreign_key
    ON foreign_key.table_name = expected.table_name
   AND foreign_key.constraint_name = expected.constraint_name
  GROUP BY expected.table_name, expected.constraint_name, expected.local_columns,
    expected.referenced_table, expected.referenced_columns, expected.confdeltype
  HAVING COUNT(*) FILTER (WHERE foreign_key.table_schema = current_schema()) <> 1
     OR COUNT(*) FILTER (WHERE foreign_key.table_schema <> current_schema()) > 0
     OR BOOL_OR(
       foreign_key.table_schema = current_schema()
       AND (
         foreign_key.local_columns IS DISTINCT FROM expected.local_columns
         OR foreign_key.referenced_schema IS DISTINCT FROM current_schema()
         OR foreign_key.referenced_table IS DISTINCT FROM expected.referenced_table
         OR foreign_key.referenced_columns IS DISTINCT FROM expected.referenced_columns
         OR foreign_key.confdeltype IS DISTINCT FROM expected.confdeltype::"char"
         OR foreign_key.convalidated IS NOT TRUE
       )
     )

  UNION ALL

  SELECT
    'UNEXPECTED_FOREIGN_KEY',
    foreign_key.table_name,
    foreign_key.constraint_name
  FROM actual_foreign_key AS foreign_key
  LEFT JOIN expected_foreign_key AS expected
    ON expected.table_name = foreign_key.table_name
   AND expected.constraint_name = foreign_key.constraint_name
  WHERE foreign_key.table_schema = current_schema()
    AND foreign_key.table_name IN (
      'vehicle_cost_ledger_entry',
      'business_exception_approval',
      'asset_accounting_command_receipt'
    )
    AND expected.constraint_name IS NULL
), index_anomaly AS (
  SELECT
    'INDEX'::text AS object_kind,
    expected.table_name,
    expected.index_name AS object_name
  FROM expected_index AS expected
  LEFT JOIN actual_index AS actual
    ON actual.table_name = expected.table_name
   AND actual.index_name = expected.index_name
  GROUP BY expected.table_name, expected.index_name, expected.expected_unique,
    expected.normalized_definition
  HAVING COUNT(*) FILTER (WHERE actual.table_schema = current_schema()) <> 1
     OR COUNT(*) FILTER (WHERE actual.table_schema <> current_schema()) > 0
     OR BOOL_OR(
       actual.table_schema = current_schema()
       AND (
         actual.indisvalid IS NOT TRUE
         OR actual.indisready IS NOT TRUE
         OR actual.indisunique IS DISTINCT FROM expected.expected_unique
         OR actual.normalized_definition IS DISTINCT FROM expected.normalized_definition
       )
     )
)
SELECT * FROM trigger_anomaly
UNION ALL
SELECT * FROM function_anomaly
UNION ALL
SELECT * FROM constraint_anomaly
UNION ALL
SELECT * FROM foreign_key_anomaly
UNION ALL
SELECT * FROM index_anomaly
ORDER BY object_kind, table_name, object_name;
COMMIT;
```

## 8. receipt uniqueness、target、event kind 与 source pairing

每个 source tuple 只能有一个 receipt。成本 entry 必须恰有一个正确 command/target/source receipt，且
outcome 的全部 public 字段、confirmed/source identity、target id 与 immutable row 精确一致，actor 必须是
confirmer。审批 request/decide/expire receipt 的完整内部 outcome、精确 version/status、immutable request、
decision/expiry facts 与命令生命周期匹配；actor 分别绑定 requester/decider/expirer，并支持
APPROVED 后 EXPIRED。审批必须恰有一个 request receipt，且终态 receipt 数量与状态路径精确一致。
decision/expiry 的 source 由第 11 节 AuditLog 配对验证，不回写 request source。以下查询预期零行：

<!-- stage1c-accounting-sql:04-receipt-integrity -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH duplicate_source AS (
  SELECT source_type, source_id, source_key, COUNT(*) AS receipt_count
  FROM asset_accounting_command_receipt
  GROUP BY source_type, source_id, source_key
  HAVING COUNT(*) <> 1
), cost_target AS (
  SELECT entry.*,
    jsonb_build_object(
      'actionType', entry.action_type::text,
      'accountingPeriod', entry.accounting_period,
      'amountCents', entry.amount_cents::text,
      'assetOwnerId', entry.asset_owner_id,
      'assetOwnerSnapshot', entry.asset_owner_snapshot,
      'confirmedAt', to_char(
        entry.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'confirmedBy', entry.confirmed_by,
      'contractId', entry.contract_id,
      'costCategory', entry.cost_category::text,
      'customerId', entry.customer_id,
      'entryKind', entry.entry_kind::text,
      'evidenceId', entry.evidence_id,
      'evidenceSnapshot', entry.evidence_snapshot,
      'id', entry.id,
      'occurredOn', to_char(entry.occurred_on, 'YYYY-MM-DD') || 'T00:00:00.000Z',
      'orderId', entry.order_id,
      'responsiblePartyId', entry.responsible_party_id,
      'responsiblePartyType', entry.responsible_party_type::text,
      'responsibilitySnapshot', entry.responsibility_snapshot,
      'reversalOfEntryId', entry.reversal_of_entry_id,
      'sourceId', entry.source_id,
      'sourceKey', entry.source_key,
      'sourceType', entry.source_type,
      'vehicleId', entry.vehicle_id,
      'workOrderId', entry.work_order_id
    ) AS expected_outcome
  FROM vehicle_cost_ledger_entry AS entry
), approval_target AS (
  SELECT approval.*,
    jsonb_build_object(
      'approvalNo', approval.approval_no,
      'decidedAt', CASE WHEN approval.decided_at IS NULL THEN NULL ELSE to_char(
        approval.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) END,
      'decidedBy', approval.decided_by,
      'decision', approval.decision::text,
      'decisionComment', approval.decision_comment,
      'exceptionType', approval.exception_type::text,
      'expiredAt', CASE WHEN approval.expired_at IS NULL THEN NULL ELSE to_char(
        approval.expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) END,
      'expiredBy', approval.expired_by,
      'expiryReason', approval.expiry_reason,
      'id', approval.id,
      'requestEvidenceSnapshot', approval.request_evidence_snapshot,
      'requestReason', approval.request_reason,
      'requestedAt', to_char(
        approval.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'requestedBy', approval.requested_by,
      'requestSourceId', approval.request_source_id,
      'requestSourceKey', approval.request_source_key,
      'requestSourceType', approval.request_source_type,
      'status', approval.status::text,
      'subjectField', approval.subject_field,
      'subjectId', approval.subject_id,
      'subjectSnapshot', approval.subject_snapshot,
      'subjectSnapshotHash', approval.subject_snapshot_hash,
      'subjectType', approval.subject_type::text,
      'version', approval.version
    ) AS current_outcome
  FROM business_exception_approval AS approval
), approval_command_target AS (
  SELECT
    approval.id AS approval_id,
    'EXCEPTION_REQUEST'::text AS command_type,
    approval.requested_by AS expected_actor_id,
    approval.current_outcome || jsonb_build_object(
      'decidedAt', NULL, 'decidedBy', NULL, 'decision', NULL, 'decisionComment', NULL,
      'expiredAt', NULL, 'expiredBy', NULL, 'expiryReason', NULL,
      'status', 'PENDING', 'version', 0
    ) AS expected_outcome
  FROM approval_target AS approval

  UNION ALL

  SELECT
    approval.id,
    'EXCEPTION_DECIDE',
    approval.decided_by,
    approval.current_outcome || jsonb_build_object(
      'expiredAt', NULL, 'expiredBy', NULL, 'expiryReason', NULL,
      'status', approval.decision::text, 'version', 1
    )
  FROM approval_target AS approval
  WHERE approval.decision IS NOT NULL

  UNION ALL

  SELECT
    approval.id,
    'EXCEPTION_EXPIRE',
    approval.expired_by,
    approval.current_outcome
  FROM approval_target AS approval
  WHERE approval.status = 'EXPIRED'
), receipt_target_anomaly AS (
  SELECT receipt.id AS receipt_id
  FROM asset_accounting_command_receipt AS receipt
  LEFT JOIN cost_target AS entry ON entry.id = receipt.cost_entry_id
  LEFT JOIN approval_target AS approval ON approval.id = receipt.approval_id
  LEFT JOIN approval_command_target AS target
    ON target.approval_id = receipt.approval_id
   AND target.command_type = receipt.command_type::text
  LEFT JOIN "user" AS actor ON actor.id = receipt.actor_id
  WHERE (
      receipt.command_type::text IN ('COST_APPEND', 'COST_REVERSE')
      AND (
        receipt.cost_entry_id IS NULL
        OR receipt.approval_id IS NOT NULL
        OR entry.id IS NULL
        OR actor.id IS NULL
        OR receipt.outcome_snapshot ->> 'id' IS DISTINCT FROM entry.id::text
        OR receipt.outcome_snapshot IS DISTINCT FROM entry.expected_outcome
        OR receipt.actor_id IS DISTINCT FROM entry.confirmed_by
        OR (receipt.command_type::text = 'COST_APPEND'
          AND entry.entry_kind IS DISTINCT FROM 'ORIGINAL')
        OR (receipt.command_type::text = 'COST_REVERSE'
          AND entry.entry_kind IS DISTINCT FROM 'REVERSAL')
        OR receipt.source_type IS DISTINCT FROM entry.source_type
        OR receipt.source_id IS DISTINCT FROM entry.source_id
        OR receipt.source_key IS DISTINCT FROM entry.source_key
      )
    )
    OR (
      receipt.command_type::text IN (
        'EXCEPTION_REQUEST', 'EXCEPTION_DECIDE', 'EXCEPTION_EXPIRE'
      )
      AND (
        receipt.approval_id IS NULL
        OR receipt.cost_entry_id IS NOT NULL
        OR approval.id IS NULL
        OR actor.id IS NULL
        OR target.approval_id IS NULL
        OR receipt.outcome_snapshot ->> 'id' IS DISTINCT FROM approval.id::text
        OR receipt.outcome_snapshot IS DISTINCT FROM target.expected_outcome
        OR receipt.actor_id IS DISTINCT FROM target.expected_actor_id
        OR (receipt.command_type::text = 'EXCEPTION_REQUEST'
          AND receipt.actor_id IS DISTINCT FROM approval.requested_by)
        OR (receipt.command_type::text = 'EXCEPTION_DECIDE'
          AND receipt.actor_id IS DISTINCT FROM approval.decided_by)
        OR (receipt.command_type::text = 'EXCEPTION_EXPIRE'
          AND receipt.actor_id IS DISTINCT FROM approval.expired_by)
        OR (receipt.command_type::text = 'EXCEPTION_REQUEST' AND (
          receipt.source_type IS DISTINCT FROM approval.request_source_type
          OR receipt.source_id IS DISTINCT FROM approval.request_source_id
          OR receipt.source_key IS DISTINCT FROM approval.request_source_key
        ))
      )
    )
), cost_fact_receipt AS (
  SELECT
    entry.id AS fact_id,
    COUNT(receipt.id) AS cost_receipt_count,
    COUNT(receipt.id) FILTER (
      WHERE receipt.command_type::text = CASE entry.entry_kind::text
        WHEN 'ORIGINAL' THEN 'COST_APPEND'
        WHEN 'REVERSAL' THEN 'COST_REVERSE'
      END
        AND receipt.source_type = entry.source_type
        AND receipt.source_id = entry.source_id
        AND receipt.source_key = entry.source_key
    ) AS valid_cost_receipt_count
  FROM vehicle_cost_ledger_entry AS entry
  LEFT JOIN asset_accounting_command_receipt AS receipt
    ON receipt.cost_entry_id = entry.id
  GROUP BY entry.id, entry.entry_kind, entry.source_type, entry.source_id, entry.source_key
), approval_receipt AS (
  SELECT
    approval.id AS approval_id,
    approval.status::text AS status,
    approval.decision::text AS decision,
    COUNT(receipt.id) FILTER (
      WHERE receipt.command_type::text = 'EXCEPTION_REQUEST'
        AND receipt.source_type = approval.request_source_type
        AND receipt.source_id = approval.request_source_id
        AND receipt.source_key = approval.request_source_key
    ) AS request_receipt_count,
    COUNT(receipt.id) FILTER (
      WHERE receipt.command_type::text IN ('EXCEPTION_DECIDE', 'EXCEPTION_EXPIRE')
    ) AS terminal_receipt_count,
    COUNT(receipt.id) FILTER (
      WHERE receipt.command_type::text = 'EXCEPTION_DECIDE'
    ) AS decision_receipt_count,
    COUNT(receipt.id) FILTER (
      WHERE receipt.command_type::text = 'EXCEPTION_EXPIRE'
    ) AS expiry_receipt_count
  FROM business_exception_approval AS approval
  LEFT JOIN asset_accounting_command_receipt AS receipt
    ON receipt.approval_id = approval.id
  GROUP BY approval.id, approval.status, approval.decision
), anomaly AS (
  SELECT
    'DUPLICATE_SOURCE'::text AS anomaly_kind,
    NULL::uuid AS target_id,
    source_type || ':' || source_id::text || ':' || source_key AS detail
  FROM duplicate_source

  UNION ALL

  SELECT 'RECEIPT_TARGET_OR_SOURCE', receipt_id, NULL
  FROM receipt_target_anomaly

  UNION ALL

  SELECT
    'COST_FACT_RECEIPT_CARDINALITY',
    fact_id,
    'all=' || cost_receipt_count::text || ',valid=' || valid_cost_receipt_count::text
  FROM cost_fact_receipt
  WHERE cost_receipt_count <> 1 OR valid_cost_receipt_count <> 1

  UNION ALL

  SELECT
    'APPROVAL_REQUEST_RECEIPT_CARDINALITY',
    approval_id,
    request_receipt_count::text
  FROM approval_receipt
  WHERE request_receipt_count <> 1

  UNION ALL

  SELECT
    'APPROVAL_TERMINAL_RECEIPT_CARDINALITY',
    approval_id,
    'terminal=' || terminal_receipt_count::text ||
      ',decision=' || decision_receipt_count::text ||
      ',expiry=' || expiry_receipt_count::text
  FROM approval_receipt
  WHERE terminal_receipt_count <> CASE
      WHEN status = 'PENDING' THEN 0
      WHEN status IN ('APPROVED', 'REJECTED') THEN 1
      WHEN status = 'EXPIRED' AND decision IS NULL THEN 1
      WHEN status = 'EXPIRED' AND decision = 'APPROVED' THEN 2
      ELSE -1
    END
    OR decision_receipt_count <> CASE
      WHEN status IN ('APPROVED', 'REJECTED') THEN 1
      WHEN status = 'EXPIRED' AND decision = 'APPROVED' THEN 1
      ELSE 0
    END
    OR expiry_receipt_count <> CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END
)
SELECT anomaly_kind, target_id, detail
FROM anomaly
ORDER BY anomaly_kind, target_id;
COMMIT;
```

## 9. ledger 只追加、authority existence/immutable identity、单次冲正与 16 维相等

以下查询检查 base shape、ledger FK/command authority existence、immutable evidence→work-order identity、
ledger 内部 responsible-party identity、单次冲正、金额符号，以及 reversal 对 original 的全部 16 维相等；
预期零行。这里只核对引用存在和能证明不可变的 identity；不得把 authority 后来 soft-delete、状态变化、
order vehicle/customer、contract/work-order 当前 projection 或历史 ownership projection 漂移误报为 orphan。
内嵌 fixture 明确要求正常的 post-append order vehicle/customer drift 为零 anomaly，同时 missing vehicle、
missing evidence、两个非空且不同的 evidence/work-order，以及 evidence 存在但 ledger work-order 为 NULL
都必须命中。append-only trigger 的完整 catalog 身份由第 7 节单独核对。

<!-- stage1c-accounting-sql:05-ledger-integrity -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH reversal_row AS (
  SELECT
    reversal.*,
    COUNT(*) OVER (PARTITION BY reversal_of_entry_id) AS reversal_count
  FROM vehicle_cost_ledger_entry AS reversal
  WHERE reversal.entry_kind = 'REVERSAL'
), reversal_anomaly AS (
  SELECT reversal.id AS entry_id
  FROM reversal_row AS reversal
  LEFT JOIN vehicle_cost_ledger_entry AS original
    ON reversal.reversal_of_entry_id = original.id
  WHERE original.id IS NULL
     OR original.entry_kind IS DISTINCT FROM 'ORIGINAL'
     OR reversal.reversal_count <> 1
     OR reversal.amount_cents IS DISTINCT FROM -original.amount_cents
     OR reversal.vehicle_id IS DISTINCT FROM original.vehicle_id
     OR reversal.order_id IS DISTINCT FROM original.order_id
     OR reversal.contract_id IS DISTINCT FROM original.contract_id
     OR reversal.customer_id IS DISTINCT FROM original.customer_id
     OR reversal.asset_owner_id IS DISTINCT FROM original.asset_owner_id
     OR reversal.work_order_id IS DISTINCT FROM original.work_order_id
     OR reversal.occurred_on IS DISTINCT FROM original.occurred_on
     OR reversal.accounting_period IS DISTINCT FROM original.accounting_period
     OR reversal.action_type IS DISTINCT FROM original.action_type
     OR reversal.cost_category IS DISTINCT FROM original.cost_category
     OR reversal.responsible_party_type IS DISTINCT FROM original.responsible_party_type
     OR reversal.responsible_party_id IS DISTINCT FROM original.responsible_party_id
     OR reversal.asset_owner_snapshot IS DISTINCT FROM original.asset_owner_snapshot
     OR reversal.evidence_id IS DISTINCT FROM original.evidence_id
     OR reversal.evidence_snapshot IS DISTINCT FROM original.evidence_snapshot
     OR reversal.responsibility_snapshot IS DISTINCT FROM original.responsibility_snapshot
), base_shape_anomaly AS (
  SELECT entry.id AS entry_id
  FROM vehicle_cost_ledger_entry AS entry
  WHERE entry.confirmed_by IS NULL
     OR btrim(entry.source_type) = ''
     OR btrim(entry.source_key) = ''
     OR entry.accounting_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     OR (entry.entry_kind = 'ORIGINAL' AND (
       entry.amount_cents <= 0 OR entry.reversal_of_entry_id IS NOT NULL
     ))
     OR (entry.entry_kind = 'REVERSAL' AND (
       entry.amount_cents >= 0 OR entry.reversal_of_entry_id IS NULL
     ))
), authority_candidate(
  entry_id, fixture_name, expected_anomaly,
  missing_vehicle, missing_order, missing_contract, missing_customer, missing_owner,
  missing_work_order, missing_confirmer,
  missing_responsible_customer, missing_responsible_owner,
  evidence_id, resolved_evidence_id, ledger_work_order_id, evidence_work_order_id,
  responsible_customer_mismatch,
  responsible_owner_mismatch, order_vehicle_drift, order_customer_drift
) AS (
  SELECT
    entry.id,
    NULL::text,
    NULL::boolean,
    vehicle.id IS NULL,
    entry.order_id IS NOT NULL AND order_row.id IS NULL,
    entry.contract_id IS NOT NULL AND contract_row.id IS NULL,
    entry.customer_id IS NOT NULL AND customer.id IS NULL,
    entry.asset_owner_id IS NOT NULL AND owner_row.id IS NULL,
    entry.work_order_id IS NOT NULL AND work_order.id IS NULL,
    confirmer.id IS NULL,
    entry.responsible_party_type = 'CUSTOMER'
      AND entry.responsible_party_id IS NOT NULL AND responsible_customer.id IS NULL,
    entry.responsible_party_type = 'ASSET_OWNER'
      AND entry.responsible_party_id IS NOT NULL AND responsible_owner.id IS NULL,
    entry.evidence_id,
    evidence.id,
    entry.work_order_id,
    evidence.work_order_id,
    entry.responsible_party_type = 'CUSTOMER'
      AND entry.responsible_party_id IS NOT NULL AND entry.customer_id IS NOT NULL
      AND entry.responsible_party_id IS DISTINCT FROM entry.customer_id,
    entry.responsible_party_type = 'ASSET_OWNER'
      AND entry.responsible_party_id IS NOT NULL AND entry.asset_owner_id IS NOT NULL
      AND entry.responsible_party_id IS DISTINCT FROM entry.asset_owner_id,
    false,
    false
  FROM vehicle_cost_ledger_entry AS entry
  LEFT JOIN vehicle AS vehicle ON vehicle.id = entry.vehicle_id
  LEFT JOIN subscription_order AS order_row ON order_row.id = entry.order_id
  LEFT JOIN contract AS contract_row ON contract_row.id = entry.contract_id
  LEFT JOIN customer AS customer ON customer.id = entry.customer_id
  LEFT JOIN asset_owner AS owner_row ON owner_row.id = entry.asset_owner_id
  LEFT JOIN asset_work_order AS work_order ON work_order.id = entry.work_order_id
  LEFT JOIN asset_work_order_evidence AS evidence ON evidence.id = entry.evidence_id
  LEFT JOIN "user" AS confirmer ON confirmer.id = entry.confirmed_by
  LEFT JOIN customer AS responsible_customer
    ON entry.responsible_party_type = 'CUSTOMER'
   AND responsible_customer.id = entry.responsible_party_id
  LEFT JOIN asset_owner AS responsible_owner
    ON entry.responsible_party_type = 'ASSET_OWNER'
   AND responsible_owner.id = entry.responsible_party_id

  UNION ALL

  VALUES
    (NULL::uuid, 'NORMAL_POST_APPEND_ORDER_DRIFT', false,
      false, false, false, false, false, false, false, false, false,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
      false, false, true, true),
    (NULL::uuid, 'MISSING_VEHICLE', true,
      true, false, false, false, false, false, false, false, false,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
      false, false, false, false),
    (NULL::uuid, 'MISSING_EVIDENCE', true,
      false, false, false, false, false, false, false, false, false,
      '00000000-0000-4000-8000-000000000101'::uuid,
      NULL::uuid,
      '00000000-0000-4000-8000-000000000201'::uuid,
      NULL::uuid,
      false, false, false, false),
    (NULL::uuid, 'EVIDENCE_WORK_ORDER_MISMATCH', true,
      false, false, false, false, false, false, false, false, false,
      '00000000-0000-4000-8000-000000000101'::uuid,
      '00000000-0000-4000-8000-000000000101'::uuid,
      '00000000-0000-4000-8000-000000000201'::uuid,
      '00000000-0000-4000-8000-000000000202'::uuid,
      false, false, false, false),
    (NULL::uuid, 'EVIDENCE_WITH_NULL_LEDGER_WORK_ORDER', true,
      false, false, false, false, false, false, false, false, false,
      '00000000-0000-4000-8000-000000000101'::uuid,
      '00000000-0000-4000-8000-000000000101'::uuid,
      NULL::uuid,
      '00000000-0000-4000-8000-000000000202'::uuid,
      false, false, false, false)
), authority_derived AS (
  SELECT
    candidate.*,
    (
      candidate.evidence_id IS NOT NULL
      AND candidate.resolved_evidence_id IS NULL
    ) AS missing_evidence,
    (
      candidate.evidence_id IS NOT NULL
      AND candidate.resolved_evidence_id IS NOT NULL
      AND (
        candidate.ledger_work_order_id IS NULL
        OR candidate.evidence_work_order_id IS DISTINCT FROM candidate.ledger_work_order_id
      )
    ) AS evidence_work_order_mismatch
  FROM authority_candidate AS candidate
), authority_evaluation AS (
  SELECT
    derived.*,
    (
      derived.missing_vehicle
      OR derived.missing_order
      OR derived.missing_contract
      OR derived.missing_customer
      OR derived.missing_owner
      OR derived.missing_work_order
      OR derived.missing_evidence
      OR derived.missing_confirmer
      OR derived.missing_responsible_customer
      OR derived.missing_responsible_owner
      OR derived.evidence_work_order_mismatch
      OR derived.responsible_customer_mismatch
      OR derived.responsible_owner_mismatch
    ) AS is_anomaly
  FROM authority_derived AS derived
), authority_anomaly AS (
  SELECT entry_id
  FROM authority_evaluation
  WHERE fixture_name IS NULL
    AND is_anomaly
), authority_fixture_contract AS (
  SELECT fixture_name
  FROM authority_evaluation
  WHERE fixture_name IS NOT NULL
    AND is_anomaly IS DISTINCT FROM expected_anomaly
)
SELECT 'BASE_SHAPE'::text AS anomaly_kind, entry_id
FROM base_shape_anomaly
UNION ALL
SELECT 'REVERSAL_EQUALITY_OR_ORPHAN', entry_id
FROM reversal_anomaly
UNION ALL
SELECT 'AUTHORITY_ORPHAN_OR_MISMATCH', entry_id
FROM authority_anomaly
UNION ALL
SELECT 'AUTHORITY_FIXTURE_CONTRACT:' || fixture_name, NULL::uuid
FROM authority_fixture_contract
ORDER BY anomaly_kind, entry_id;
COMMIT;
```

## 10. approval tuple、version、live uniqueness 与 registered resolver

以下查询检查 request/decision/expiry tuple、self-approval、精确 version 和 live uniqueness。当前
`registered_resolver` 故意是空 registry；出现 live approval 会以
`UNRESOLVED_NO_REGISTERED_RESOLVER` 返回并阻断。未来只能通过已评审的 server-derived resolver 更新它。

<!-- stage1c-accounting-sql:06-approval-integrity -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH registered_resolver(subject_type, subject_id, subject_field, authoritative_snapshot_hash) AS (
  SELECT
    NULL::business_exception_subject_type,
    NULL::uuid,
    NULL::varchar(128),
    NULL::varchar(64)
  WHERE false
), approval_shape_anomaly AS (
  SELECT approval.id AS approval_id
  FROM business_exception_approval AS approval
  WHERE btrim(approval.subject_field) = ''
     OR btrim(approval.request_reason) = ''
     OR btrim(approval.request_source_type) = ''
     OR btrim(approval.request_source_key) = ''
     OR approval.subject_snapshot_hash !~ '^[0-9a-f]{64}$'
     OR approval.version < 0
     OR (
       approval.status IN ('APPROVED', 'REJECTED')
       AND btrim(COALESCE(approval.decision_comment, '')) = ''
     )
     OR (
       approval.status = 'EXPIRED'
       AND approval.decision = 'APPROVED'
       AND btrim(COALESCE(approval.decision_comment, '')) = ''
     )
     OR (
       approval.status = 'EXPIRED'
       AND btrim(COALESCE(approval.expiry_reason, '')) = ''
     )
     OR approval.requested_by = approval.decided_by
     OR (approval.status = 'PENDING' AND approval.version <> 0)
     OR (approval.status IN ('APPROVED', 'REJECTED') AND approval.version <> 1)
     OR (approval.status = 'EXPIRED' AND approval.decision IS NULL AND approval.version <> 1)
     OR (approval.status = 'EXPIRED' AND approval.decision = 'APPROVED' AND approval.version <> 2)
     OR (approval.status = 'PENDING' AND num_nonnulls(
       approval.decision, approval.decision_comment, approval.decided_by,
       approval.decided_at, approval.expiry_reason, approval.expired_by, approval.expired_at
     ) <> 0)
     OR (approval.status = 'APPROVED' AND (
       approval.decision IS DISTINCT FROM 'APPROVED'
       OR num_nonnulls(approval.decision, approval.decision_comment,
         approval.decided_by, approval.decided_at) <> 4
       OR num_nonnulls(approval.expiry_reason, approval.expired_by, approval.expired_at) <> 0
     ))
     OR (approval.status = 'REJECTED' AND (
       approval.decision IS DISTINCT FROM 'REJECTED'
       OR num_nonnulls(approval.decision, approval.decision_comment,
         approval.decided_by, approval.decided_at) <> 4
       OR num_nonnulls(approval.expiry_reason, approval.expired_by, approval.expired_at) <> 0
     ))
     OR (approval.status = 'EXPIRED' AND (
       num_nonnulls(approval.expiry_reason, approval.expired_by, approval.expired_at) <> 3
       OR (approval.decision IS NULL AND num_nonnulls(
         approval.decision_comment, approval.decided_by, approval.decided_at
       ) <> 0)
       OR (approval.decision = 'APPROVED' AND num_nonnulls(
         approval.decision_comment, approval.decided_by, approval.decided_at
       ) <> 3)
       OR approval.decision = 'REJECTED'
     ))
), live_duplicate AS (
  SELECT id AS approval_id
  FROM (
    SELECT
      id,
      COUNT(*) OVER (
        PARTITION BY subject_type, subject_id, subject_field, subject_snapshot_hash
      ) AS live_count
    FROM business_exception_approval
    WHERE status IN ('PENDING', 'APPROVED')
  ) AS live
  WHERE live_count <> 1
), approval_actor_anomaly AS (
  SELECT approval.id AS approval_id
  FROM business_exception_approval AS approval
  LEFT JOIN "user" AS requester ON requester.id = approval.requested_by
  LEFT JOIN "user" AS decider ON decider.id = approval.decided_by
  LEFT JOIN "user" AS expirer ON expirer.id = approval.expired_by
  WHERE requester.id IS NULL
     OR (approval.decided_by IS NOT NULL AND decider.id IS NULL)
     OR (approval.expired_by IS NOT NULL AND expirer.id IS NULL)
), resolver_anomaly AS (
  SELECT
    approval.id AS approval_id,
    CASE
      WHEN resolver.subject_type IS NULL
        THEN 'UNRESOLVED_NO_REGISTERED_RESOLVER'
      WHEN resolver.authoritative_snapshot_hash IS DISTINCT FROM approval.subject_snapshot_hash
        THEN 'STALE_ACTIVE_APPROVAL'
      ELSE NULL
    END AS anomaly_kind
  FROM business_exception_approval AS approval
  LEFT JOIN registered_resolver AS resolver
    ON resolver.subject_type = approval.subject_type
   AND resolver.subject_id = approval.subject_id
   AND resolver.subject_field = approval.subject_field
  WHERE approval.status IN ('PENDING', 'APPROVED')
)
SELECT 'APPROVAL_TUPLE_OR_VERSION'::text AS anomaly_kind, approval_id
FROM approval_shape_anomaly
UNION ALL
SELECT 'LIVE_DUPLICATE', approval_id
FROM live_duplicate
UNION ALL
SELECT 'APPROVAL_ACTOR_ORPHAN', approval_id
FROM approval_actor_anomaly
UNION ALL
SELECT anomaly_kind, approval_id
FROM resolver_anomaly
WHERE anomaly_kind IS NOT NULL
ORDER BY anomaly_kind, approval_id;
COMMIT;
```

## 11. AuditLog exact cardinality、source、fact 与 hash

每个新 receipt 必须精确对应一个 `module = asset_accounting` audit；exact replay 不产生第二条，其他 module
即使复用同一 source 也不计入该 cardinality。该 module 的每条 audit 都必须带结构合法的 top-level source；
无 source 或 malformed source 自身就是 anomaly，不能被过滤隐藏。查询检查 missing、duplicate、extra、
orphan，以及 entity/action/operator/permission/reason/source/idempotency key/hash，并从真实 target row 与命令
lifecycle 构造 public fact/version，不能拿 receipt outcome 自证。审批 hash 可与保存 subject hash 或 expiry
resolver hash 精确比较；成本 hash 由于数据库没有注册应用 canonical JSON resolver，必须是小写 64 位并
同时要求 audit fact 与 target-derived public fact 精确相等，不能伪造通用 SQL hash。以下查询预期零行：

<!-- stage1c-accounting-sql:07-audit-integrity -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH cost_target AS (
  SELECT entry.*,
    jsonb_build_object(
      'actionType', entry.action_type::text,
      'accountingPeriod', entry.accounting_period,
      'amountCents', entry.amount_cents::text,
      'assetOwnerId', entry.asset_owner_id,
      'assetOwnerSnapshot', entry.asset_owner_snapshot,
      'confirmedAt', to_char(
        entry.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'confirmedBy', entry.confirmed_by,
      'contractId', entry.contract_id,
      'costCategory', entry.cost_category::text,
      'customerId', entry.customer_id,
      'entryKind', entry.entry_kind::text,
      'evidenceId', entry.evidence_id,
      'evidenceSnapshot', entry.evidence_snapshot,
      'id', entry.id,
      'occurredOn', to_char(entry.occurred_on, 'YYYY-MM-DD') || 'T00:00:00.000Z',
      'orderId', entry.order_id,
      'responsiblePartyId', entry.responsible_party_id,
      'responsiblePartyType', entry.responsible_party_type::text,
      'responsibilitySnapshot', entry.responsibility_snapshot,
      'reversalOfEntryId', entry.reversal_of_entry_id,
      'sourceId', entry.source_id,
      'sourceKey', entry.source_key,
      'sourceType', entry.source_type,
      'vehicleId', entry.vehicle_id,
      'workOrderId', entry.work_order_id
    ) AS expected_public_fact
  FROM vehicle_cost_ledger_entry AS entry
), approval_target AS (
  SELECT approval.*,
    jsonb_build_object(
      'approvalNo', approval.approval_no,
      'decidedAt', CASE WHEN approval.decided_at IS NULL THEN NULL ELSE to_char(
        approval.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) END,
      'decidedBy', approval.decided_by,
      'decision', approval.decision::text,
      'decisionComment', approval.decision_comment,
      'exceptionType', approval.exception_type::text,
      'expiredAt', CASE WHEN approval.expired_at IS NULL THEN NULL ELSE to_char(
        approval.expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) END,
      'expiredBy', approval.expired_by,
      'expiryReason', approval.expiry_reason,
      'id', approval.id,
      'requestEvidenceSnapshot', approval.request_evidence_snapshot,
      'requestReason', approval.request_reason,
      'requestedAt', to_char(
        approval.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'requestedBy', approval.requested_by,
      'requestSourceId', approval.request_source_id,
      'requestSourceKey', approval.request_source_key,
      'requestSourceType', approval.request_source_type,
      'status', approval.status::text,
      'subjectField', approval.subject_field,
      'subjectId', approval.subject_id,
      'subjectSnapshot', approval.subject_snapshot,
      'subjectSnapshotHash', approval.subject_snapshot_hash,
      'subjectType', approval.subject_type::text,
      'version', approval.version
    ) AS current_outcome
  FROM business_exception_approval AS approval
), approval_command_target AS (
  SELECT
    approval.id AS approval_id,
    'EXCEPTION_REQUEST'::text AS command_type,
    approval.requested_by AS expected_actor_id,
    (approval.current_outcome || jsonb_build_object(
      'decidedAt', NULL, 'decidedBy', NULL, 'decision', NULL, 'decisionComment', NULL,
      'expiredAt', NULL, 'expiredBy', NULL, 'expiryReason', NULL,
      'status', 'PENDING', 'version', 0
    )) - 'decisionComment' AS expected_public_fact,
    0 AS expected_version,
    approval.subject_snapshot_hash,
    approval.request_reason AS target_reason
  FROM approval_target AS approval

  UNION ALL

  SELECT
    approval.id,
    'EXCEPTION_DECIDE',
    approval.decided_by,
    (approval.current_outcome || jsonb_build_object(
      'expiredAt', NULL, 'expiredBy', NULL, 'expiryReason', NULL,
      'status', approval.decision::text, 'version', 1
    )) - 'decisionComment',
    1,
    approval.subject_snapshot_hash,
    approval.decision_comment
  FROM approval_target AS approval
  WHERE approval.decision IS NOT NULL

  UNION ALL

  SELECT
    approval.id,
    'EXCEPTION_EXPIRE',
    approval.expired_by,
    approval.current_outcome - 'decisionComment',
    approval.version,
    approval.subject_snapshot_hash,
    approval.expiry_reason
  FROM approval_target AS approval
  WHERE approval.status = 'EXPIRED'
), expected_audit AS (
  SELECT
    receipt.id AS receipt_id,
    COALESCE(cost.confirmed_by, approval.expected_actor_id) AS actor_id,
    COALESCE(receipt.cost_entry_id, receipt.approval_id) AS expected_entity_id,
    CASE
      WHEN receipt.command_type::text IN ('COST_APPEND', 'COST_REVERSE')
        THEN 'vehicle_cost_ledger_entry'
      ELSE 'business_exception_approval'
    END AS expected_entity_type,
    CASE receipt.command_type::text
      WHEN 'COST_APPEND' THEN 'CREATE'
      WHEN 'COST_REVERSE' THEN 'CREATE'
      WHEN 'EXCEPTION_REQUEST' THEN 'CREATE'
      WHEN 'EXCEPTION_DECIDE' THEN CASE approval.expected_public_fact ->> 'decision'
        WHEN 'APPROVED' THEN 'APPROVE'
        WHEN 'REJECTED' THEN 'REJECT'
      END
      WHEN 'EXCEPTION_EXPIRE' THEN 'UPDATE'
    END AS expected_action,
    CASE receipt.command_type::text
      WHEN 'COST_APPEND' THEN 'vehicle_cost_ledger:confirm'
      WHEN 'COST_REVERSE' THEN 'vehicle_cost_ledger:reverse'
      WHEN 'EXCEPTION_REQUEST' THEN 'business_exception:request'
      WHEN 'EXCEPTION_DECIDE' THEN 'business_exception:approve'
      WHEN 'EXCEPTION_EXPIRE' THEN 'business_exception:request'
    END AS expected_permission,
    CASE WHEN receipt.command_type::text IN ('COST_APPEND', 'COST_REVERSE')
      THEN receipt.payload_snapshot ->> 'reason'
      ELSE approval.target_reason
    END AS expected_reason,
    COALESCE(cost.expected_public_fact, approval.expected_public_fact) AS expected_fact,
    approval.expected_version,
    jsonb_build_object(
      'type', receipt.source_type,
      'id', receipt.source_id::text,
      'key', receipt.source_key
    ) AS expected_source,
    CASE receipt.command_type::text
      WHEN 'EXCEPTION_REQUEST' THEN approval.subject_snapshot_hash
      WHEN 'EXCEPTION_DECIDE' THEN approval.subject_snapshot_hash
      WHEN 'EXCEPTION_EXPIRE' THEN receipt.payload_snapshot ->> 'authoritySnapshotHash'
      ELSE NULL
    END AS expected_hash,
    receipt.source_type,
    receipt.source_id,
    receipt.source_key
  FROM asset_accounting_command_receipt AS receipt
  LEFT JOIN cost_target AS cost ON cost.id = receipt.cost_entry_id
  LEFT JOIN approval_command_target AS approval
    ON approval.approval_id = receipt.approval_id
   AND approval.command_type = receipt.command_type::text
), module_audit AS (
  SELECT
    audit.*,
    CASE
      WHEN jsonb_typeof(audit.after_snapshot) IS DISTINCT FROM 'object' THEN false
      WHEN jsonb_typeof(audit.after_snapshot -> 'source') IS DISTINCT FROM 'object' THEN false
      WHEN jsonb_typeof(audit.after_snapshot -> 'source' -> 'type') IS DISTINCT FROM 'string'
        THEN false
      WHEN jsonb_typeof(audit.after_snapshot -> 'source' -> 'id') IS DISTINCT FROM 'string'
        THEN false
      WHEN jsonb_typeof(audit.after_snapshot -> 'source' -> 'key') IS DISTINCT FROM 'string'
        THEN false
      WHEN btrim(audit.after_snapshot -> 'source' ->> 'type') = '' THEN false
      WHEN btrim(audit.after_snapshot -> 'source' ->> 'key') = '' THEN false
      WHEN audit.after_snapshot -> 'source' ->> 'id'
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN false
      ELSE true
    END AS source_is_valid,
    audit.after_snapshot -> 'source' ->> 'type' AS source_type,
    audit.after_snapshot -> 'source' ->> 'id' AS source_id,
    audit.after_snapshot -> 'source' ->> 'key' AS source_key
  FROM audit_log AS audit
  WHERE audit.module = 'asset_accounting'
), valid_module_audit AS (
  SELECT *
  FROM module_audit
  WHERE source_is_valid
), malformed_module_audit AS (
  SELECT id AS audit_id
  FROM module_audit
  WHERE NOT source_is_valid
), audit_cardinality AS (
  SELECT
    expected.receipt_id,
    COUNT(audit.id) AS audit_count
  FROM expected_audit AS expected
  LEFT JOIN valid_module_audit AS audit
    ON audit.source_type = expected.source_type
   AND audit.source_id = expected.source_id::text
   AND audit.source_key = expected.source_key
  GROUP BY expected.receipt_id
), paired AS (
  SELECT expected.*, audit.id AS audit_id, audit.module, audit.entity_type,
    audit.entity_id, audit.action, audit.operator_id, audit.after_snapshot
  FROM expected_audit AS expected
  JOIN valid_module_audit AS audit
    ON audit.source_type = expected.source_type
   AND audit.source_id = expected.source_id::text
   AND audit.source_key = expected.source_key
), extra_audit AS (
  SELECT audit.id AS audit_id
  FROM valid_module_audit AS audit
  LEFT JOIN expected_audit AS expected
    ON audit.source_type = expected.source_type
   AND audit.source_id = expected.source_id::text
   AND audit.source_key = expected.source_key
  WHERE expected.receipt_id IS NULL
), orphan_audit AS (
  SELECT audit.id AS audit_id
  FROM module_audit AS audit
  LEFT JOIN vehicle_cost_ledger_entry AS entry
    ON audit.entity_type = 'vehicle_cost_ledger_entry'
   AND entry.id = audit.entity_id
  LEFT JOIN business_exception_approval AS approval
    ON audit.entity_type = 'business_exception_approval'
   AND approval.id = audit.entity_id
  WHERE (
      audit.entity_type NOT IN (
        'vehicle_cost_ledger_entry', 'business_exception_approval'
      )
      OR (audit.entity_type = 'vehicle_cost_ledger_entry' AND entry.id IS NULL)
      OR (audit.entity_type = 'business_exception_approval' AND approval.id IS NULL)
    )
), mismatch AS (
  SELECT
    paired.receipt_id,
    paired.audit_id,
    CASE
      WHEN paired.entity_type IS DISTINCT FROM paired.expected_entity_type
        OR paired.entity_id IS DISTINCT FROM paired.expected_entity_id THEN 'ENTITY_MISMATCH'
      WHEN paired.action::text IS DISTINCT FROM paired.expected_action THEN 'ACTION_MISMATCH'
      WHEN paired.operator_id IS DISTINCT FROM paired.actor_id THEN 'OPERATOR_MISMATCH'
      WHEN paired.after_snapshot ->> 'permission' IS DISTINCT FROM paired.expected_permission
        THEN 'PERMISSION_MISMATCH'
      WHEN paired.after_snapshot ->> 'reason' IS DISTINCT FROM paired.expected_reason
        THEN 'REASON_MISMATCH'
      WHEN paired.after_snapshot -> 'fact' IS DISTINCT FROM paired.expected_fact
        THEN 'FACT_MISMATCH'
      WHEN paired.expected_version IS NOT NULL
        AND paired.after_snapshot -> 'fact' ->> 'version'
          IS DISTINCT FROM paired.expected_version::text THEN 'VERSION_MISMATCH'
      WHEN paired.after_snapshot -> 'source' IS DISTINCT FROM paired.expected_source
        OR paired.after_snapshot #>> '{requestContext,idempotencyKey}'
          IS DISTINCT FROM paired.source_key THEN 'SOURCE_MISMATCH'
      WHEN paired.after_snapshot ->> 'snapshotHash' !~ '^[0-9a-f]{64}$'
        OR (paired.expected_hash IS NOT NULL AND
          paired.after_snapshot ->> 'snapshotHash' IS DISTINCT FROM paired.expected_hash)
        THEN 'HASH_MISMATCH'
      ELSE NULL
    END AS anomaly_kind
  FROM paired
)
SELECT 'MISSING_AUDIT'::text AS anomaly_kind, receipt_id AS reference_id
FROM audit_cardinality
WHERE audit_count = 0
UNION ALL
SELECT 'DUPLICATE_AUDIT', receipt_id
FROM audit_cardinality
WHERE audit_count > 1
UNION ALL
SELECT 'EXTRA_AUDIT', audit_id
FROM extra_audit
UNION ALL
SELECT 'ORPHAN_AUDIT', audit_id
FROM orphan_audit
UNION ALL
SELECT 'MALFORMED_AUDIT_SOURCE', audit_id
FROM malformed_module_audit
UNION ALL
SELECT anomaly_kind, audit_id
FROM mismatch
WHERE anomaly_kind IS NOT NULL
ORDER BY anomaly_kind, reference_id;
COMMIT;
```

## 12. CLOSED cost-required active-cost 不变量

以下查询返回 `CLOSED` 且要求成本确认、却没有 active unreversed `ORIGINAL / ACTUAL_COST` 的工单；预期
零行。非零不授权补数据、重开工单或改写事件，只能停止并走前向纠正。

<!-- stage1c-accounting-sql:08-closed-cost-integrity -->

```sql
BEGIN TRANSACTION READ ONLY;
SELECT work_order.id AS work_order_id
FROM asset_work_order AS work_order
LEFT JOIN vehicle_cost_ledger_entry AS original
  ON original.work_order_id = work_order.id
 AND original.entry_kind = 'ORIGINAL'
 AND original.action_type = 'ACTUAL_COST'
LEFT JOIN vehicle_cost_ledger_entry AS reversal
  ON reversal.reversal_of_entry_id = original.id
WHERE work_order.status = 'CLOSED'
  AND work_order.cost_confirmation_required IS TRUE
GROUP BY work_order.id
HAVING COUNT(original.id) FILTER (WHERE reversal.id IS NULL) = 0
ORDER BY work_order.id;
COMMIT;
```

## 13. contention、错误与 retry

所有写命令要求 caller-owned `READ COMMITTED` interactive transaction。固定锁顺序是全局 source advisory
lock，再按稳定 identity 锁 authority；成本写还锁 vehicle/work order/owner/evidence，reversal 对关联工单
使用 `FOR UPDATE NOWAIT`。审批按 source→subject 排序锁，并通过 resolver 在锁内重读 authoritative state。

- authority 正在修改时返回 HTTP `409` + `ASSET_ACCOUNTING_AUTHORITY_BUSY`，不泄漏 SQLSTATE、连接或
  原始数据库错误。不要紧密自动重试，也不要终止未知正常事务。
- source tuple 的 command/payload/reason/hash 漂移返回 `ASSET_ACCOUNTING_SOURCE_CONFLICT`；approval
  `expectedVersion` 漂移返回稳定 version conflict。它们要求重读和人工判断，不能 blind retry 或换 key。
- 只有 source、payload、authority 和 expected version 均未变时，才用同一个 `Idempotency-Key` 重试。
- CLOSED last-active 冲正失败后必须先追加并提交 replacement，再以原 source retry；不能在同一失败事务
  中伪造 replacement，也不能直接改 ledger、receipt 或 AuditLog。

## 14. SQL 执行方法与停止条件

从本文件按 `stage1c-accounting-sql:NN-name` marker 原样提取恰好八段。每段必须单独交给 `psql`，设置
`ON_ERROR_STOP=1`，独立看到 `BEGIN TRANSACTION READ ONLY` 与 `COMMIT`，记录段名、退出码、返回行数和
脱敏摘要。不得合并段、删除只读事务、把查询改成修复 SQL 或在输出截断后继续。

任一情况停止 rollout：命令门禁非零；catalog/permission/receipt/ledger/approval/audit/CLOSED cost 段出现
异常行；registered resolver 未覆盖 live approval；计数/fingerprint 在未批准窗口变化；运行身份或数据库
不确定；输出包含 secret/PII；或有人要求先 seed/apply/deploy 再核对。

## 15. rollback 与前向纠正

只允许前向、可审计纠正。可以停止新 Stage 1C-C 写入并回退到兼容应用镜像，但保留 additive migration、
original、reversal、approval、receipt 与 AuditLog。错误成本用新的已批准反向 entry；错误审批依状态机拒绝
或过期；错误 authority resolver 先修 owning writer，再过期 stale approval；最后一个 CLOSED active cost
必须 replacement-first。数据库缺少 guard 时先评审新的 additive migration，绝不编辑已应用 migration、
checksum 或历史事实。纠正后重跑四个命令门禁和八个 SQL block，并由双人复核。

## 16. 证据、脱敏与保留

不得输出或保存 `DATABASE_URL`、数据库用户名或密码，也不得记录 token、Cookie、请求头、shell tracing、
原始连接错误或进程环境。脱敏摘要不得包含客户 PII、VIN、车牌、姓名、手机号、证件号、reason 文本、
`decisionComment` 或其他内部审批备注；只保留本手册允许的计数、枚举、匿名 UUID 和 fingerprint。

原始 SQL 输出不得提交 Git；它只进入仓库外受控加密证据存储。证据记录 Git SHA、镜像 digest、受控数据库
标识、执行/复核人、时间、每段退出码/行数，以及原始文件与脱敏摘要各自 SHA-256。保留期限遵循审计、
法务和变更单中较长者；销毁也必须走受控流程，不能删除业务事实或 AuditLog 代替。

## 17. 2026-08-21 专用 Local 数据库只读记录

目标是 loopback `127.0.0.1:55432` 的专用 Local PostgreSQL；凭据从容器环境只注入子进程，未输出
secret。仅在 RED 证据后部署本分支新增的第四个前向纠正 migration；未运行 seed、通用 apply、历史 migration apply、
修复 SQL、网络或 Production 操作。

最终从本文件 marker 原样提取 8/8 个 SQL block；每段独立使用 `ON_ERROR_STOP=1`，退出码均为 `0`，
每段都观察到 `BEGIN` 与 `COMMIT`：

| SQL block                  | 脱敏结果 | 结论                                                                                                                                                           |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-migration-catalog`     | 1 行     | applied `97`、rolled-back `1`、failed/incomplete `0`、Stage 1C-C applied `4`、fingerprint `9c1f7b14ffdfa3e61dfbf6a7d6868d70`；rolled-back 阻断。               |
| `02-permission-matrix`     | 62 行    | 六个 definition 和 54 个 grant 缺失，另有 definition/grant exact-count 两个 contract anomaly；无 unexpected definition/grant，阻断。                           |
| `03-database-catalog`      | 0 行     | 四个 trigger、三个完整函数、11 个 CHECK、Task 1 全部 15 个 FK（含 owning/referenced schema）、15 个 index 均匹配。                                             |
| `04-receipt-integrity`     | 0 行     | 无 source/target/event-kind、target-derived outcome、actor 或 lifecycle/cardinality 异常。                                                                     |
| `05-ledger-integrity`      | 0 行     | 无 base shape、authority existence/immutable evidence identity（含 NULL ledger work-order fixture）、重复冲正或 16 维相等异常。                                |
| `06-approval-integrity`    | 0 行     | 无 approval actor/tuple/version/live/resolver 异常；当前没有 live approval，空 registry 未被绕过。                                                             |
| `07-audit-integrity`       | 0 行     | 无 missing/duplicate/extra/orphan/malformed-source 或 entity/action/source/target-derived fact/version/hash 异常。                                             |
| `08-closed-cost-integrity` | 0 行     | 当前查询为 0 行；Task 8 曾观测 2 行，但未保留 identity fingerprint，后续 guarded fixture cleanup 与该 2 行没有 identity linkage；`2 -> 0` 处置未决并继续阻断。 |

Task 8 的最终只读证据在 `67729df75265398301098c1dc8961bfc34be9419` 记录 block 08 为 2 行；当时没有
保留这两行的工单 ID、source marker 或脱敏 identity fingerprint。Task 9 在
`57f7080df6daef9d33b7276d019bb17075d6b2aa` 记录了受 guard 的 S1CB fixture cleanup，但现有证据没有把
任一受 guard prefix 与先前两行建立 identity linkage，不能据此推断其处置。当前 0 行是有效的当前观测，
但在另行保留 identity-linked 证据前不能清除历史阻断；未授权或证明任何工单/ledger 修复，也未证明
identity-linked disposition。

<!-- CLOSED_COST_EVIDENCE_DISPOSITION:BEGIN -->

```text
prior_observed_count: 2
prior_observation_reference: TASK8_BLOCK08@67729df75265398301098c1dc8961bfc34be9419
current_observed_count: 0
prior_identity_fingerprint: NOT_CAPTURED
guarded_fixture_cleanup_reference: TASK9_GUARDED_S1CB_FIXTURE_CLEANUP@57f7080df6daef9d33b7276d019bb17075d6b2aa
guarded_fixture_cleanup_linkage: NOT_IDENTITY_LINKED
disposition: UNRESOLVED_STOP
postcondition: STOP
rollout_action: STOP
ruling: CURRENT_ZERO_CANNOT_CLEAR_HISTORICAL_BLOCKER_WITHOUT_SEPARATELY_RETAINED_IDENTITY_LINKED_EVIDENCE
```

<!-- CLOSED_COST_EVIDENCE_DISPOSITION:END -->

四个命令门禁的最终脱敏结果：

| 门禁                                  | 退出码 | 脱敏结论                                                                        |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| `pnpm prisma:migrate:status`          | `0`    | 97 migrations；database current。                                               |
| `pnpm prisma:validate`                | `0`    | schema valid。                                                                  |
| `pnpm prisma:migrate:checksum:verify` | `2`    | local/applied `97/97`、duplicate/missing `0/0/0`、mismatch `58`、`safe=false`。 |
| datasource→schema diff                | `2`    | diff 非空；未打印、接受或修复 drift 内容。                                      |

因此该 Local 数据库同时被 rolled-back `1`、checksum mismatch `58`、非空 drift、六个缺失 definition、
54 个缺失 grant、两个 exact-count contract anomaly 和
`CLOSED_COST_EVIDENCE_DISPOSITION=UNRESOLVED_STOP` 阻断，明确
rollout-ineligible。零行不能证明真实业务样本已覆盖；非零也不授权 backfill/apply/UPDATE。原始结果未提交
Git，控制台仅保留以上脱敏计数。
