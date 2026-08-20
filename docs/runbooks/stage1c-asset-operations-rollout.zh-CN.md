# Stage 1C-B 资产工单与车辆运营限制发布运行手册

## 1. 目的、依赖与非目标

本手册用于发布 Stage 1C-B 的通用资产工单、只追加事件/证据、车辆运营限制，以及统一的车辆可用性守卫。
它依赖 [Stage 1C-A 车辆订阅期间与权属期间发布运行手册](./stage1c-period-facts-rollout.zh-CN.md)
中的期间、权属、访问基线和证据控制。本手册提供的是**只读核对，不是 apply**；Stage 1C-B 没有
reconciliation writer，也没有历史转换脚本。

严格非目标：

- 不创建、补录、推断或批量转换工单、限制、事件或证据；不得从车辆、订单、Lease、交付、退还、
  服务案件、车况报告的状态或缺失关系推断新事实。
- 不替换或写回 `VehicleHandoverWorkOrder`、`VehicleReturn`、`ServiceCase`、
  `VehicleConditionReport`、`InsuranceClaim` 或它们的附件/证据。
- 不启用 P0 `RETURN_INBOUND` handover，不实现追回、正常结束、最终结算或成本/追回台账编排。
- 不接管 `Vehicle.status`、订单、合同或 Lease 生命周期；Stage 1C-A 期间事实继续是占用事实权威来源。
- 不推断 `AssetOwner` 或权属期间；不因默认平台 owner 存在而分配车辆。
- 不得执行历史 apply，不提供 apply/reconciliation writer，不得修改历史 migration，不修复历史 checksum。
- 不得执行 `prisma migrate reset` 或 `prisma db push`。
- 不得执行 `pnpm prisma:seed` 或 `pnpm prisma:seed:verify`。generic seed 会写默认用户和演示业务数据，
  在 Staging/Production 以及本手册核对数据库中均禁止运行。
- 不执行 Production 数据写入、权限 apply、部署或网络操作。本次只读本地证据不能替代 Staging 或
  Production 的独立变更单和证据。

`UNLINKED_REVIEW_REQUIRED` 不授权创建工单或限制，也不授权修改来源记录。所有人工处置必须另行提出、
审核并使用已批准的管理 API；本手册本身不产生任何写权限。

## 2. 发布前迁移、checksum 与 drift 停止门禁

只把 `DATABASE_URL` 注入当前子进程；不得把连接串写入命令行、脚本参数、控制台或报告。按以下顺序
执行并保存**原始退出码**：

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

判定不可放宽：

- **迁移状态门禁**：failed、rolled-back、意外 pending、disk-only 或 database-only migration 均停止发布。
- **原始字节 checksum 门禁**：`pnpm prisma:migrate:checksum:verify` 的 `0` 才通过；`2` 表示非空差异，
  不得通过改历史文件或数据库 checksum 消除。
- **datasource→schema drift 门禁**：必须在 `apps/api` 中直接运行并保留 Prisma 原始退出码；`0` 表示无
  drift，`2` 表示发现 drift，`1` 表示命令错误；`1`、`2` 都停止发布。
- `prisma validate` 只验证 schema 语法；`migrate status` 只验证迁移清单状态。它们不能替代 checksum
  或 drift 门禁。
- 只有全部门禁退出码为 `0` 才能继续。任何非零、数量变化、命令异常或输出不完整都必须停止发布。

2026-08-20 对专用本地数据库的本任务只读检查结果记录在第 12 节。该库的已知 checksum/drift 结果
使它 rollout-ineligible；不得修复、接受或忽略这些结果来推进发布。

迁移目录只读摘要用于发现 failed/rolled-back 历史行；任何异常计数非零均停止：

<!-- stage1c-sql:01-migration-catalog -->

```sql
BEGIN TRANSACTION READ ONLY;
SELECT
  COUNT(*) FILTER (
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  ) AS applied_migration_count,
  COUNT(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back_migration_count,
  COUNT(*) FILTER (
    WHERE finished_at IS NULL AND rolled_back_at IS NULL
  ) AS failed_or_incomplete_migration_count,
  md5(COALESCE(string_agg(
    migration_name || ':' || checksum,
    ',' ORDER BY migration_name, started_at, id
  ), '')) AS migration_catalog_fingerprint
FROM _prisma_migrations;
COMMIT;
```

## 3. 权限定义与 Stage 1C-A 分层矩阵

Stage 1C-B 新增且仅新增以下五个 `asset_operations` 权限：

- `asset_operations:view`
- `asset_work_order:manage`
- `vehicle_restriction:manage`
- `vehicle_restriction:release`
- `vehicle_restriction:approve_release`

精确物料身份如下；同 code 的 name/module/action 漂移必须停止，不能原地覆盖成期望值：

| code                                  | name                       | module             | action                        |
| ------------------------------------- | -------------------------- | ------------------ | ----------------------------- |
| `asset_operations:view`               | 查看资产运营工单与限制     | `asset_operations` | `view`                        |
| `asset_work_order:manage`             | 管理资产运营工单           | `asset_operations` | `work_order_manage`           |
| `vehicle_restriction:manage`          | 管理车辆运营限制           | `asset_operations` | `restriction_manage`          |
| `vehicle_restriction:release`         | 解除车辆运营限制           | `asset_operations` | `restriction_release`         |
| `vehicle_restriction:approve_release` | 审批高风险车辆运营限制解除 | `asset_operations` | `restriction_approve_release` |

高风险 `LEGAL_HOLD`、`OWNERSHIP_EXCEPTION`、`EVIDENCE_EXCEPTION` 解除要求
`vehicle_restriction:approve_release`；其他限制解除要求 `vehicle_restriction:release`。下面是与 Stage
1C-A 三个权限叠加后的**八角色精确矩阵**；`no` 也必须验证，不得仅验证正向授权：

| 角色    | `asset_facts:view` | `asset_owner:manage` | `vehicle_period:manage` | `asset_operations:view` | `asset_work_order:manage` | `vehicle_restriction:manage` | `vehicle_restriction:release` | `vehicle_restriction:approve_release` |
| ------- | ------------------ | -------------------- | ----------------------- | ----------------------- | ------------------------- | ---------------------------- | ----------------------------- | ------------------------------------- |
| `ADMIN` | yes                | yes                  | yes                     | yes                     | yes                       | yes                          | yes                           | yes                                   |
| `AS`    | yes                | yes                  | yes                     | yes                     | yes                       | yes                          | yes                           | yes                                   |
| `OP`    | yes                | no                   | yes                     | yes                     | yes                       | yes                          | yes                           | no                                    |
| `GM`    | yes                | no                   | no                      | yes                     | no                        | no                           | no                            | yes                                   |
| `FI`    | yes                | no                   | no                      | yes                     | no                        | no                           | no                            | no                                    |
| `RC`    | no                 | no                   | no                      | yes                     | no                        | no                           | no                            | no                                    |
| `SA`    | no                 | no                   | no                      | no                      | no                        | no                           | no                            | no                                    |
| `CS`    | no                 | no                   | no                      | no                      | no                        | no                           | no                            | no                                    |

只使用 Stage 1C 专用访问同步器的 dry-run/apply/replay 流程；本任务没有运行 apply。部署环境完成获批
同步后，受影响用户必须退出并重新登录以刷新 JWT/Cookie。以下只读矩阵查询必须返回零行：

<!-- stage1c-sql:02-permission-matrix -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH expected_role(role_code) AS (
  VALUES ('ADMIN'), ('AS'), ('OP'), ('GM'), ('FI'), ('RC'), ('SA'), ('CS')
)
SELECT expected.role_code
FROM expected_role AS expected
LEFT JOIN "role" AS actual ON actual.code::text = expected.role_code
WHERE actual.id IS NULL
   OR actual.status::text <> 'ACTIVE'
   OR actual.deleted_at IS NOT NULL
ORDER BY expected.role_code;

WITH permission_definition(code, name, module, action) AS (
  VALUES
    ('asset_facts:view', '查看车辆事实台账', 'asset_facts', 'view'),
    ('asset_owner:manage', '管理车辆权属期间', 'asset_facts', 'owner_manage'),
    ('vehicle_period:manage', '修复车辆订阅期间', 'asset_facts', 'period_manage'),
    ('asset_operations:view', '查看资产运营工单与限制', 'asset_operations', 'view'),
    ('asset_work_order:manage', '管理资产运营工单', 'asset_operations', 'work_order_manage'),
    ('vehicle_restriction:manage', '管理车辆运营限制', 'asset_operations', 'restriction_manage'),
    ('vehicle_restriction:release', '解除车辆运营限制', 'asset_operations', 'restriction_release'),
    ('vehicle_restriction:approve_release', '审批高风险车辆运营限制解除', 'asset_operations', 'restriction_approve_release')
)
SELECT expected.code
FROM permission_definition AS expected
LEFT JOIN permission AS actual ON actual.code = expected.code
WHERE actual.id IS NULL
   OR actual.name IS DISTINCT FROM expected.name
   OR actual.module IS DISTINCT FROM expected.module
   OR actual.action IS DISTINCT FROM expected.action
   OR actual.status::text <> 'ACTIVE'
   OR actual.deleted_at IS NOT NULL
ORDER BY expected.code;

WITH role_code(role_code) AS (
  VALUES ('ADMIN'), ('AS'), ('OP'), ('GM'), ('FI'), ('RC'), ('SA'), ('CS')
), permission_code(permission_code) AS (
  VALUES
    ('asset_facts:view'),
    ('asset_owner:manage'),
    ('vehicle_period:manage'),
    ('asset_operations:view'),
    ('asset_work_order:manage'),
    ('vehicle_restriction:manage'),
    ('vehicle_restriction:release'),
    ('vehicle_restriction:approve_release')
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
    ('AS', 'asset_facts:view'),
    ('AS', 'asset_owner:manage'),
    ('AS', 'vehicle_period:manage'),
    ('AS', 'asset_operations:view'),
    ('AS', 'asset_work_order:manage'),
    ('AS', 'vehicle_restriction:manage'),
    ('AS', 'vehicle_restriction:release'),
    ('AS', 'vehicle_restriction:approve_release'),
    ('OP', 'asset_facts:view'),
    ('OP', 'vehicle_period:manage'),
    ('OP', 'asset_operations:view'),
    ('OP', 'asset_work_order:manage'),
    ('OP', 'vehicle_restriction:manage'),
    ('OP', 'vehicle_restriction:release'),
    ('GM', 'asset_facts:view'),
    ('GM', 'asset_operations:view'),
    ('GM', 'vehicle_restriction:approve_release'),
    ('FI', 'asset_facts:view'),
    ('FI', 'asset_operations:view'),
    ('RC', 'asset_operations:view')
), actual_grant AS (
  SELECT role.code::text AS role_code, permission.code AS permission_code
  FROM role_permission
  JOIN "role" AS role ON role.id = role_permission.role_id
  JOIN permission ON permission.id = role_permission.permission_id
  WHERE role_permission.deleted_at IS NULL
    AND role.code::text IN ('ADMIN', 'AS', 'OP', 'GM', 'FI', 'RC', 'SA', 'CS')
    AND permission.code IN (
      'asset_facts:view',
      'asset_owner:manage',
      'vehicle_period:manage',
      'asset_operations:view',
      'asset_work_order:manage',
      'vehicle_restriction:manage',
      'vehicle_restriction:release',
      'vehicle_restriction:approve_release'
    )
)
SELECT
  role_code.role_code,
  permission_code.permission_code,
  (expected_grant.role_code IS NOT NULL) AS expected,
  (actual_grant.role_code IS NOT NULL) AS actual
FROM role_code
CROSS JOIN permission_code
LEFT JOIN expected_grant USING (role_code, permission_code)
LEFT JOIN actual_grant USING (role_code, permission_code)
WHERE (expected_grant.role_code IS NOT NULL)
  IS DISTINCT FROM (actual_grant.role_code IS NOT NULL)
ORDER BY role_code.role_code, permission_code.permission_code;
COMMIT;
```

## 4. 领域枚举、不变量与可用性语义

发布 SHA 必须逐字保留以下枚举：

```text
AssetWorkOrderType = DELIVERY_OUTBOUND | RETURN_INBOUND | SWAP_OUTBOUND | SWAP_INBOUND | RECOVERY | RECONDITIONING | MAINTENANCE
AssetWorkOrderStatus = PENDING | IN_PROGRESS | WAITING_EXTERNAL | PENDING_ACCEPTANCE | PENDING_COST_CONFIRMATION | CLOSED | CANCELLED
AssetWorkOrderPriority = LOW | NORMAL | HIGH | URGENT
AssetWorkOrderEventType = CREATED | ASSIGNED | STARTED | WAITING_EXTERNAL | RESUMED | EVIDENCE_ATTACHED | SUBMITTED_FOR_ACCEPTANCE | ACCEPTED | COST_CONFIRMED | PHYSICAL_CONTROL_CONFIRMED | INSPECTION_RECORDED | RESTRICTION_CREATED | RESTRICTION_RELEASED | CLOSED | CANCELLED | NOTE_ADDED
AssetWorkOrderEvidenceAction = ATTACH | SUPERSEDE | REMOVE
AssetWorkOrderEvidenceType = PHOTO | VIDEO | DOCUMENT | SIGNATURE | LOCATION_PROOF | THIRD_PARTY_RECEIPT | INSPECTION_REPORT | OTHER
VehicleOperationalRestrictionType = RETURN_INSPECTION_PENDING | REINSPECTION_PENDING | RECONDITIONING_PENDING | MAINTENANCE_OR_ACCIDENT | RECOVERY_IN_PROGRESS | LEGAL_HOLD | EVIDENCE_EXCEPTION | OWNERSHIP_EXCEPTION | OTHER
VehicleOperationalRestrictionSeverity = ADVISORY | BLOCKING
VehicleOperationalRestrictionScope = ALLOCATION | DELIVERY | CUSTOMER_USE | INVENTORY_RELEASE
VehicleOperationalRestrictionStatus = ACTIVE | RELEASED | VOIDED
```

`CLOSED`、`CANCELLED` 是工单终态。`DEAD_LETTER` 不是资产工单或运营限制的业务状态；技术任务失败
不能关闭工单或解除限制。

`AssetWorkOrderEvent` 和 `AssetWorkOrderEvidence` 事件和证据均为只追加、不可更新、不可删除；数据库
trigger 拒绝 `UPDATE`/`DELETE`。证据更正只能追加 `SUPERSEDE` 或 `REMOVE`。`ATTACH`、`SUPERSEDE`
冻结 live `FileObject` 的 bucket、object key、size、MIME 与小写 64-hex SHA-256；一个旧证据最多一个
successor。

限制的开始身份、车辆、工单、类型、severity、scopes、开始时间、条件/证据快照和创建信息不可变。
`ACTIVE` 时解除身份、解除人、时间、理由和快照全部为 `NULL`；`RELEASED`/`VOIDED` 时全部非空，
即解除元组必须全空或全非空。一个限制只能关闭一次。关联工单未到
`PENDING_COST_CONFIRMATION` 或 `CLOSED` 时不得解除。

权威可用性用途与规则：

- `ALLOCATION`：车辆必须为 `AVAILABLE`，销售价 `EFFECTIVE` 且大于零，没有当前开放订阅期间，
  没有已开始、`ACTIVE`、`BLOCKING` 且含 `ALLOCATION` 的限制。
- `DELIVERY`：车辆必须为 `RESERVED`；保留已评审价格，不重复要求当前销售价；没有当前开放订阅期间，
  没有已开始、`ACTIVE`、`BLOCKING` 且含 `DELIVERY` 的限制。
- `MARK_AVAILABLE`：普通 evaluator 状态只允许 `DRAFT`、`IN_PREPARATION`、`RETURNED`、
  `MAINTENANCE`、`AVAILABLE`；必须具有有效正销售价、无开放订阅期间，且没有含 `ALLOCATION`、
  `DELIVERY` 或 `INVENTORY_RELEASE` 任一 scope 的已开始 active blocker。仅在既有业务流已经验证
  `REVIEW_RESERVED|RESERVED -> AVAILABLE` 时，事务内守卫可覆盖**生命周期状态一个字段**，不能覆盖
  删除、价格、占用或限制事实。

任何 reason 都 fail-closed；返回结果按 `(code, restrictionId)` 确定排序。可用列表 SQL、分配/预留、
同步 Field 开始、权威 Lease 激活和所有当前进入 `AVAILABLE` 的路径都必须使用同一事实规则。

```text
VehicleAvailabilityReasonCode = VEHICLE_NOT_FOUND | VEHICLE_DELETED | LIFECYCLE_STATUS_BLOCKED | SALE_PRICE_NOT_EFFECTIVE | SALE_PRICE_NOT_POSITIVE | ACTIVE_SUBSCRIPTION_PERIOD | ACTIVE_OPERATIONAL_RESTRICTION
```

## 5. 历史专业事实的精确来源元组与三态分类

本节只定义核对身份，不授权创建。每个候选的 exact stable source tuple 固定为：

| 专业来源                     | `type`                        | `id`                             | `key`                                               |
| ---------------------------- | ----------------------------- | -------------------------------- | --------------------------------------------------- |
| 交付 handover 工单           | `VEHICLE_HANDOVER_WORK_ORDER` | `vehicle_handover_work_order.id` | `stage1c-b:legacy:vehicle-handover-work-order:<id>` |
| 未删除退还记录               | `VEHICLE_RETURN`              | `vehicle_return.id`              | `stage1c-b:legacy:vehicle-return:<id>`              |
| 未删除开放服务案件           | `SERVICE_CASE`                | `service_case.id`                | `stage1c-b:legacy:service-case:<id>`                |
| 未删除已发布且阻断的车况报告 | `VEHICLE_CONDITION_REPORT`    | `vehicle_condition_report.id`    | `stage1c-b:legacy:vehicle-condition-report:<id>`    |

每个 SQL 同时检查 `asset_work_order.create_source_*` 与
`vehicle_operational_restriction.start_source_*`：

- `LINKED`：按 `type + id` 只找到一个 material owner，且 `key` 与车辆均精确一致。
- `UNLINKED_REVIEW_REQUIRED`：按 `type + id` 没有 material owner；只进入人工核对。
- `SOURCE_CONFLICT`：存在非预期 key、车辆不一致、缺少来源车辆却已有 link，或同一来源由多个 material
  owner 占用。停止，不得把其中任一行当成可信 link。

### 5.1 现有 handover 工单

<!-- stage1c-sql:03-handover-source -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH expected_source AS (
  SELECT
    handover.id AS source_id,
    source_order.vehicle_id,
    'VEHICLE_HANDOVER_WORK_ORDER'::text AS source_type,
    'stage1c-b:legacy:vehicle-handover-work-order:' || handover.id::text AS source_key
  FROM vehicle_handover_work_order AS handover
  JOIN subscription_order AS source_order ON source_order.id = handover.order_id
), event_only_type(event_type) AS (
  VALUES
    ('ASSIGNED'), ('STARTED'), ('WAITING_EXTERNAL'), ('RESUMED'),
    ('SUBMITTED_FOR_ACCEPTANCE'), ('ACCEPTED'), ('COST_CONFIRMED'),
    ('PHYSICAL_CONTROL_CONFIRMED'), ('INSPECTION_RECORDED'), ('CLOSED'),
    ('CANCELLED'), ('NOTE_ADDED')
), material_pair_type(event_type) AS (
  VALUES
    ('CREATED'), ('EVIDENCE_ATTACHED'),
    ('RESTRICTION_CREATED'), ('RESTRICTION_RELEASED')
), collision_material_owner AS (
  SELECT
    work_order.create_source_type AS source_type,
    work_order.create_source_id AS source_id,
    work_order.create_source_key AS source_key,
    work_order.vehicle_id,
    'ASSET_WORK_ORDER'::text AS owner_kind,
    work_order.id AS claim_id,
    work_order.id AS work_order_id,
    'CREATED'::text AS expected_event_type,
    NULL::text AS reference_key,
    true AS event_required
  FROM asset_work_order AS work_order
  UNION ALL
  SELECT
    evidence.source_type, evidence.source_id, evidence.source_key,
    work_order.vehicle_id, 'ASSET_WORK_ORDER_EVIDENCE', evidence.id,
    evidence.work_order_id, 'EVIDENCE_ATTACHED', 'evidenceId', true
  FROM asset_work_order_evidence AS evidence
  JOIN asset_work_order AS work_order ON work_order.id = evidence.work_order_id
  UNION ALL
  SELECT
    restriction.start_source_type,
    restriction.start_source_id,
    restriction.start_source_key,
    restriction.vehicle_id,
    'VEHICLE_OPERATIONAL_RESTRICTION_START', restriction.id,
    restriction.work_order_id, 'RESTRICTION_CREATED', 'restrictionId',
    restriction.work_order_id IS NOT NULL
  FROM vehicle_operational_restriction AS restriction
  UNION ALL
  SELECT
    restriction.release_source_type, restriction.release_source_id,
    restriction.release_source_key, restriction.vehicle_id,
    'VEHICLE_OPERATIONAL_RESTRICTION_RELEASE', restriction.id,
    restriction.work_order_id, 'RESTRICTION_RELEASED', 'restrictionId',
    restriction.work_order_id IS NOT NULL
  FROM vehicle_operational_restriction AS restriction
  WHERE restriction.release_source_type IS NOT NULL
    AND restriction.release_source_id IS NOT NULL
    AND restriction.release_source_key IS NOT NULL
), authoritative_link_owner AS (
  SELECT *
  FROM collision_material_owner
  WHERE owner_kind = 'ASSET_WORK_ORDER'
     OR owner_kind = 'VEHICLE_OPERATIONAL_RESTRICTION_START'
), source_event AS (
  SELECT
    event.source_type, event.source_id, event.source_key,
    event.id, event.work_order_id, event.event_type::text AS event_type,
    event.detail_snapshot
  FROM asset_work_order_event AS event
), joined_claim AS (
  SELECT
    COALESCE(material.source_type, event.source_type) AS source_type,
    COALESCE(material.source_id, event.source_id) AS source_id,
    COALESCE(material.source_key, event.source_key) AS source_key,
    material.vehicle_id,
    material.owner_kind,
    material.claim_id,
    authority.claim_id AS authoritative_claim_id,
    material.event_required,
    event.id AS event_id,
    CASE
      WHEN material.claim_id IS NULL THEN NOT EXISTS (
        SELECT 1 FROM event_only_type WHERE event_type = event.event_type
      )
      WHEN NOT EXISTS (
        SELECT 1 FROM material_pair_type
        WHERE event_type = material.expected_event_type
      ) THEN true
      WHEN event.id IS NULL THEN material.event_required
      WHEN NOT material.event_required THEN true
      WHEN event.work_order_id IS DISTINCT FROM material.work_order_id THEN true
      WHEN event.event_type IS DISTINCT FROM material.expected_event_type THEN true
      WHEN material.reference_key IS NOT NULL
        AND event.detail_snapshot ->> material.reference_key
          IS DISTINCT FROM material.claim_id::text THEN true
      ELSE false
    END AS source_conflict
  FROM collision_material_owner AS material
  FULL JOIN source_event AS event
    ON event.source_type = material.source_type
   AND event.source_id = material.source_id
   AND event.source_key = material.source_key
  LEFT JOIN authoritative_link_owner AS authority
    ON authority.owner_kind = material.owner_kind
   AND authority.claim_id = material.claim_id
   AND authority.source_type = material.source_type
   AND authority.source_id = material.source_id
   AND authority.source_key = material.source_key
), source_integrity AS (
  SELECT
    source_type,
    source_id,
    source_key,
    (MIN(vehicle_id::text) FILTER (
      WHERE authoritative_claim_id IS NOT NULL
    ))::uuid AS vehicle_id,
    COUNT(DISTINCT owner_kind || ':' || claim_id::text) AS material_owner_count,
    COUNT(DISTINCT owner_kind || ':' || authoritative_claim_id::text)
      AS authoritative_owner_count,
    COUNT(DISTINCT event_id) AS event_owner_count,
    BOOL_OR(source_conflict)
      OR COUNT(DISTINCT owner_kind || ':' || claim_id::text) > 1
      OR CASE
        WHEN COUNT(DISTINCT claim_id) = 0 THEN COUNT(DISTINCT event_id) <> 1
        WHEN BOOL_AND(event_required) THEN COUNT(DISTINCT event_id) <> 1
        ELSE COUNT(DISTINCT event_id) <> 0
      END AS source_conflict
  FROM joined_claim
  GROUP BY source_type, source_id, source_key
)
SELECT
  expected.source_type,
  expected.source_id,
  expected.source_key,
  CASE
    WHEN COALESCE(SUM(link.authoritative_owner_count), 0) = 0
      AND COALESCE(SUM(link.material_owner_count), 0) = 0
      AND BOOL_AND(NOT COALESCE(link.source_conflict, false))
      THEN 'UNLINKED_REVIEW_REQUIRED'
    WHEN COALESCE(SUM(link.authoritative_owner_count), 0) = 1
      AND COALESCE(SUM(link.material_owner_count), 0) = 1
      AND BOOL_AND(link.source_key = expected.source_key)
      AND BOOL_AND(link.vehicle_id = expected.vehicle_id)
      AND BOOL_AND(NOT link.source_conflict)
      THEN 'LINKED'
    ELSE 'SOURCE_CONFLICT'
  END AS classification,
  COALESCE(SUM(link.material_owner_count + link.event_owner_count), 0)
    AS source_claim_count
FROM expected_source AS expected
LEFT JOIN source_integrity AS link
  ON link.source_type = expected.source_type
 AND link.source_id = expected.source_id
GROUP BY expected.source_type, expected.source_id, expected.source_key, expected.vehicle_id
ORDER BY expected.source_type, expected.source_id;
COMMIT;
```

### 5.2 未删除退还记录

<!-- stage1c-sql:04-return-source -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH expected_source AS (
  SELECT
    source_return.id AS source_id,
    source_return.vehicle_id,
    'VEHICLE_RETURN'::text AS source_type,
    'stage1c-b:legacy:vehicle-return:' || source_return.id::text AS source_key
  FROM vehicle_return AS source_return
  WHERE source_return.deleted_at IS NULL
), event_only_type(event_type) AS (
  VALUES
    ('ASSIGNED'), ('STARTED'), ('WAITING_EXTERNAL'), ('RESUMED'),
    ('SUBMITTED_FOR_ACCEPTANCE'), ('ACCEPTED'), ('COST_CONFIRMED'),
    ('PHYSICAL_CONTROL_CONFIRMED'), ('INSPECTION_RECORDED'), ('CLOSED'),
    ('CANCELLED'), ('NOTE_ADDED')
), material_pair_type(event_type) AS (
  VALUES
    ('CREATED'), ('EVIDENCE_ATTACHED'),
    ('RESTRICTION_CREATED'), ('RESTRICTION_RELEASED')
), collision_material_owner AS (
  SELECT create_source_type AS source_type, create_source_id AS source_id,
    create_source_key AS source_key, vehicle_id, 'ASSET_WORK_ORDER'::text AS owner_kind,
    id AS claim_id, id AS work_order_id, 'CREATED'::text AS expected_event_type,
    NULL::text AS reference_key, true AS event_required
  FROM asset_work_order
  UNION ALL
  SELECT evidence.source_type, evidence.source_id, evidence.source_key,
    work_order.vehicle_id, 'ASSET_WORK_ORDER_EVIDENCE', evidence.id,
    evidence.work_order_id, 'EVIDENCE_ATTACHED', 'evidenceId', true
  FROM asset_work_order_evidence AS evidence
  JOIN asset_work_order AS work_order ON work_order.id = evidence.work_order_id
  UNION ALL
  SELECT start_source_type, start_source_id, start_source_key, vehicle_id,
    'VEHICLE_OPERATIONAL_RESTRICTION_START', id, work_order_id,
    'RESTRICTION_CREATED', 'restrictionId', work_order_id IS NOT NULL
  FROM vehicle_operational_restriction
  UNION ALL
  SELECT release_source_type, release_source_id, release_source_key, vehicle_id,
    'VEHICLE_OPERATIONAL_RESTRICTION_RELEASE', id, work_order_id,
    'RESTRICTION_RELEASED', 'restrictionId', work_order_id IS NOT NULL
  FROM vehicle_operational_restriction
  WHERE release_source_type IS NOT NULL
    AND release_source_id IS NOT NULL
    AND release_source_key IS NOT NULL
), authoritative_link_owner AS (
  SELECT *
  FROM collision_material_owner
  WHERE owner_kind = 'ASSET_WORK_ORDER'
     OR owner_kind = 'VEHICLE_OPERATIONAL_RESTRICTION_START'
), source_event AS (
  SELECT source_type, source_id, source_key, event.id, event.work_order_id,
    event.event_type::text AS event_type, event.detail_snapshot
  FROM asset_work_order_event AS event
), joined_claim AS (
  SELECT
    COALESCE(material.source_type, event.source_type) AS source_type,
    COALESCE(material.source_id, event.source_id) AS source_id,
    COALESCE(material.source_key, event.source_key) AS source_key,
    material.vehicle_id, material.owner_kind, material.claim_id,
    authority.claim_id AS authoritative_claim_id,
    material.event_required, event.id AS event_id,
    CASE
      WHEN material.claim_id IS NULL THEN NOT EXISTS (
        SELECT 1 FROM event_only_type WHERE event_type = event.event_type
      )
      WHEN NOT EXISTS (
        SELECT 1 FROM material_pair_type
        WHERE event_type = material.expected_event_type
      ) THEN true
      WHEN event.id IS NULL THEN material.event_required
      WHEN NOT material.event_required THEN true
      WHEN event.work_order_id IS DISTINCT FROM material.work_order_id THEN true
      WHEN event.event_type IS DISTINCT FROM material.expected_event_type THEN true
      WHEN material.reference_key IS NOT NULL
        AND event.detail_snapshot ->> material.reference_key
          IS DISTINCT FROM material.claim_id::text THEN true
      ELSE false
    END AS source_conflict
  FROM collision_material_owner AS material
  FULL JOIN source_event AS event
    ON event.source_type = material.source_type
   AND event.source_id = material.source_id
   AND event.source_key = material.source_key
  LEFT JOIN authoritative_link_owner AS authority
    ON authority.owner_kind = material.owner_kind
   AND authority.claim_id = material.claim_id
   AND authority.source_type = material.source_type
   AND authority.source_id = material.source_id
   AND authority.source_key = material.source_key
), source_integrity AS (
  SELECT
    source_type,
    source_id,
    source_key,
    (MIN(vehicle_id::text) FILTER (
      WHERE authoritative_claim_id IS NOT NULL
    ))::uuid AS vehicle_id,
    COUNT(DISTINCT owner_kind || ':' || claim_id::text) AS material_owner_count,
    COUNT(DISTINCT owner_kind || ':' || authoritative_claim_id::text)
      AS authoritative_owner_count,
    COUNT(DISTINCT event_id) AS event_owner_count,
    BOOL_OR(source_conflict)
      OR COUNT(DISTINCT owner_kind || ':' || claim_id::text) > 1
      OR CASE
        WHEN COUNT(DISTINCT claim_id) = 0 THEN COUNT(DISTINCT event_id) <> 1
        WHEN BOOL_AND(event_required) THEN COUNT(DISTINCT event_id) <> 1
        ELSE COUNT(DISTINCT event_id) <> 0
      END AS source_conflict
  FROM joined_claim
  GROUP BY source_type, source_id, source_key
)
SELECT
  expected.source_type,
  expected.source_id,
  expected.source_key,
  CASE
    WHEN COALESCE(SUM(link.authoritative_owner_count), 0) = 0
      AND COALESCE(SUM(link.material_owner_count), 0) = 0
      AND BOOL_AND(NOT COALESCE(link.source_conflict, false))
      THEN 'UNLINKED_REVIEW_REQUIRED'
    WHEN COALESCE(SUM(link.authoritative_owner_count), 0) = 1
      AND COALESCE(SUM(link.material_owner_count), 0) = 1
      AND BOOL_AND(link.source_key = expected.source_key)
      AND BOOL_AND(link.vehicle_id = expected.vehicle_id)
      AND BOOL_AND(NOT link.source_conflict)
      THEN 'LINKED'
    ELSE 'SOURCE_CONFLICT'
  END AS classification,
  COALESCE(SUM(link.material_owner_count + link.event_owner_count), 0)
    AS source_claim_count
FROM expected_source AS expected
LEFT JOIN source_integrity AS link
  ON link.source_type = expected.source_type
 AND link.source_id = expected.source_id
GROUP BY expected.source_type, expected.source_id, expected.source_key, expected.vehicle_id
ORDER BY expected.source_type, expected.source_id;
COMMIT;
```

### 5.3 未删除开放服务案件

开放状态与当前 Fleet Ops 规则精确一致：`SUBMITTED`、`ACCEPTED`、`IN_PROGRESS`、
`WAITING_CUSTOMER`。`vehicle_id IS NULL` 且无 link 时仍是 `UNLINKED_REVIEW_REQUIRED`；若已有 link，
因为无法证明车辆一致性，分类为 `SOURCE_CONFLICT`。

<!-- stage1c-sql:05-service-case-source -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH expected_source AS (
  SELECT
    service.id AS source_id,
    service.vehicle_id,
    'SERVICE_CASE'::text AS source_type,
    'stage1c-b:legacy:service-case:' || service.id::text AS source_key
  FROM service_case AS service
  WHERE service.deleted_at IS NULL
    AND service.case_status IN ('SUBMITTED', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_CUSTOMER')
), event_only_type(event_type) AS (
  VALUES
    ('ASSIGNED'), ('STARTED'), ('WAITING_EXTERNAL'), ('RESUMED'),
    ('SUBMITTED_FOR_ACCEPTANCE'), ('ACCEPTED'), ('COST_CONFIRMED'),
    ('PHYSICAL_CONTROL_CONFIRMED'), ('INSPECTION_RECORDED'), ('CLOSED'),
    ('CANCELLED'), ('NOTE_ADDED')
), material_pair_type(event_type) AS (
  VALUES
    ('CREATED'), ('EVIDENCE_ATTACHED'),
    ('RESTRICTION_CREATED'), ('RESTRICTION_RELEASED')
), collision_material_owner AS (
  SELECT create_source_type AS source_type, create_source_id AS source_id,
    create_source_key AS source_key, vehicle_id, 'ASSET_WORK_ORDER'::text AS owner_kind,
    id AS claim_id, id AS work_order_id, 'CREATED'::text AS expected_event_type,
    NULL::text AS reference_key, true AS event_required
  FROM asset_work_order
  UNION ALL
  SELECT evidence.source_type, evidence.source_id, evidence.source_key,
    work_order.vehicle_id, 'ASSET_WORK_ORDER_EVIDENCE', evidence.id,
    evidence.work_order_id, 'EVIDENCE_ATTACHED', 'evidenceId', true
  FROM asset_work_order_evidence AS evidence
  JOIN asset_work_order AS work_order ON work_order.id = evidence.work_order_id
  UNION ALL
  SELECT start_source_type, start_source_id, start_source_key, vehicle_id,
    'VEHICLE_OPERATIONAL_RESTRICTION_START', id, work_order_id,
    'RESTRICTION_CREATED', 'restrictionId', work_order_id IS NOT NULL
  FROM vehicle_operational_restriction
  UNION ALL
  SELECT release_source_type, release_source_id, release_source_key, vehicle_id,
    'VEHICLE_OPERATIONAL_RESTRICTION_RELEASE', id, work_order_id,
    'RESTRICTION_RELEASED', 'restrictionId', work_order_id IS NOT NULL
  FROM vehicle_operational_restriction
  WHERE release_source_type IS NOT NULL
    AND release_source_id IS NOT NULL
    AND release_source_key IS NOT NULL
), authoritative_link_owner AS (
  SELECT *
  FROM collision_material_owner
  WHERE owner_kind = 'ASSET_WORK_ORDER'
     OR owner_kind = 'VEHICLE_OPERATIONAL_RESTRICTION_START'
), source_event AS (
  SELECT source_type, source_id, source_key, event.id, event.work_order_id,
    event.event_type::text AS event_type, event.detail_snapshot
  FROM asset_work_order_event AS event
), joined_claim AS (
  SELECT
    COALESCE(material.source_type, event.source_type) AS source_type,
    COALESCE(material.source_id, event.source_id) AS source_id,
    COALESCE(material.source_key, event.source_key) AS source_key,
    material.vehicle_id, material.owner_kind, material.claim_id,
    authority.claim_id AS authoritative_claim_id,
    material.event_required, event.id AS event_id,
    CASE
      WHEN material.claim_id IS NULL THEN NOT EXISTS (
        SELECT 1 FROM event_only_type WHERE event_type = event.event_type
      )
      WHEN NOT EXISTS (
        SELECT 1 FROM material_pair_type
        WHERE event_type = material.expected_event_type
      ) THEN true
      WHEN event.id IS NULL THEN material.event_required
      WHEN NOT material.event_required THEN true
      WHEN event.work_order_id IS DISTINCT FROM material.work_order_id THEN true
      WHEN event.event_type IS DISTINCT FROM material.expected_event_type THEN true
      WHEN material.reference_key IS NOT NULL
        AND event.detail_snapshot ->> material.reference_key
          IS DISTINCT FROM material.claim_id::text THEN true
      ELSE false
    END AS source_conflict
  FROM collision_material_owner AS material
  FULL JOIN source_event AS event
    ON event.source_type = material.source_type
   AND event.source_id = material.source_id
   AND event.source_key = material.source_key
  LEFT JOIN authoritative_link_owner AS authority
    ON authority.owner_kind = material.owner_kind
   AND authority.claim_id = material.claim_id
   AND authority.source_type = material.source_type
   AND authority.source_id = material.source_id
   AND authority.source_key = material.source_key
), source_integrity AS (
  SELECT
    source_type,
    source_id,
    source_key,
    (MIN(vehicle_id::text) FILTER (
      WHERE authoritative_claim_id IS NOT NULL
    ))::uuid AS vehicle_id,
    COUNT(DISTINCT owner_kind || ':' || claim_id::text) AS material_owner_count,
    COUNT(DISTINCT owner_kind || ':' || authoritative_claim_id::text)
      AS authoritative_owner_count,
    COUNT(DISTINCT event_id) AS event_owner_count,
    BOOL_OR(source_conflict)
      OR COUNT(DISTINCT owner_kind || ':' || claim_id::text) > 1
      OR CASE
        WHEN COUNT(DISTINCT claim_id) = 0 THEN COUNT(DISTINCT event_id) <> 1
        WHEN BOOL_AND(event_required) THEN COUNT(DISTINCT event_id) <> 1
        ELSE COUNT(DISTINCT event_id) <> 0
      END AS source_conflict
  FROM joined_claim
  GROUP BY source_type, source_id, source_key
)
SELECT
  expected.source_type,
  expected.source_id,
  expected.source_key,
  CASE
    WHEN COALESCE(SUM(link.authoritative_owner_count), 0) = 0
      AND COALESCE(SUM(link.material_owner_count), 0) = 0
      AND BOOL_AND(NOT COALESCE(link.source_conflict, false))
      THEN 'UNLINKED_REVIEW_REQUIRED'
    WHEN expected.vehicle_id IS NOT NULL
      AND COALESCE(SUM(link.authoritative_owner_count), 0) = 1
      AND COALESCE(SUM(link.material_owner_count), 0) = 1
      AND BOOL_AND(link.source_key = expected.source_key)
      AND BOOL_AND(link.vehicle_id = expected.vehicle_id)
      AND BOOL_AND(NOT link.source_conflict)
      THEN 'LINKED'
    ELSE 'SOURCE_CONFLICT'
  END AS classification,
  COALESCE(SUM(link.material_owner_count + link.event_owner_count), 0)
    AS source_claim_count
FROM expected_source AS expected
LEFT JOIN source_integrity AS link
  ON link.source_type = expected.source_type
 AND link.source_id = expected.source_id
GROUP BY expected.source_type, expected.source_id, expected.source_key, expected.vehicle_id
ORDER BY expected.source_type, expected.source_id;
COMMIT;
```

### 5.4 未删除已发布且阻断的车况报告

阻断口径与 Fleet Ops 一致：报告必须为 `PUBLISHED`；报告自身任一重大事故、水淹、火烧或结构损伤
标志为 true，或未删除 `vehicle_condition_report_item` 满足 `SAFETY_CRITICAL`、
`MAJOR + ABNORMAL`、`affects_safety` 或 `repair_required`。

<!-- stage1c-sql:06-condition-report-source -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH expected_source AS (
  SELECT
    report.id AS source_id,
    report.vehicle_id,
    'VEHICLE_CONDITION_REPORT'::text AS source_type,
    'stage1c-b:legacy:vehicle-condition-report:' || report.id::text AS source_key
  FROM vehicle_condition_report AS report
  WHERE report.deleted_at IS NULL
    AND report.report_status = 'PUBLISHED'
    AND (
      report.has_major_accident
      OR report.has_flood_damage
      OR report.has_fire_damage
      OR report.has_structural_damage
      OR EXISTS (
        SELECT 1
        FROM vehicle_condition_report_item AS item
        WHERE item.report_id = report.id
          AND item.deleted_at IS NULL
          AND (
            item.severity = 'SAFETY_CRITICAL'
            OR (item.severity = 'MAJOR' AND item.result = 'ABNORMAL')
            OR item.affects_safety
            OR item.repair_required
          )
      )
    )
), event_only_type(event_type) AS (
  VALUES
    ('ASSIGNED'), ('STARTED'), ('WAITING_EXTERNAL'), ('RESUMED'),
    ('SUBMITTED_FOR_ACCEPTANCE'), ('ACCEPTED'), ('COST_CONFIRMED'),
    ('PHYSICAL_CONTROL_CONFIRMED'), ('INSPECTION_RECORDED'), ('CLOSED'),
    ('CANCELLED'), ('NOTE_ADDED')
), material_pair_type(event_type) AS (
  VALUES
    ('CREATED'), ('EVIDENCE_ATTACHED'),
    ('RESTRICTION_CREATED'), ('RESTRICTION_RELEASED')
), collision_material_owner AS (
  SELECT create_source_type AS source_type, create_source_id AS source_id,
    create_source_key AS source_key, vehicle_id, 'ASSET_WORK_ORDER'::text AS owner_kind,
    id AS claim_id, id AS work_order_id, 'CREATED'::text AS expected_event_type,
    NULL::text AS reference_key, true AS event_required
  FROM asset_work_order
  UNION ALL
  SELECT evidence.source_type, evidence.source_id, evidence.source_key,
    work_order.vehicle_id, 'ASSET_WORK_ORDER_EVIDENCE', evidence.id,
    evidence.work_order_id, 'EVIDENCE_ATTACHED', 'evidenceId', true
  FROM asset_work_order_evidence AS evidence
  JOIN asset_work_order AS work_order ON work_order.id = evidence.work_order_id
  UNION ALL
  SELECT start_source_type, start_source_id, start_source_key, vehicle_id,
    'VEHICLE_OPERATIONAL_RESTRICTION_START', id, work_order_id,
    'RESTRICTION_CREATED', 'restrictionId', work_order_id IS NOT NULL
  FROM vehicle_operational_restriction
  UNION ALL
  SELECT release_source_type, release_source_id, release_source_key, vehicle_id,
    'VEHICLE_OPERATIONAL_RESTRICTION_RELEASE', id, work_order_id,
    'RESTRICTION_RELEASED', 'restrictionId', work_order_id IS NOT NULL
  FROM vehicle_operational_restriction
  WHERE release_source_type IS NOT NULL
    AND release_source_id IS NOT NULL
    AND release_source_key IS NOT NULL
), authoritative_link_owner AS (
  SELECT *
  FROM collision_material_owner
  WHERE owner_kind = 'ASSET_WORK_ORDER'
     OR owner_kind = 'VEHICLE_OPERATIONAL_RESTRICTION_START'
), source_event AS (
  SELECT source_type, source_id, source_key, event.id, event.work_order_id,
    event.event_type::text AS event_type, event.detail_snapshot
  FROM asset_work_order_event AS event
), joined_claim AS (
  SELECT
    COALESCE(material.source_type, event.source_type) AS source_type,
    COALESCE(material.source_id, event.source_id) AS source_id,
    COALESCE(material.source_key, event.source_key) AS source_key,
    material.vehicle_id, material.owner_kind, material.claim_id,
    authority.claim_id AS authoritative_claim_id,
    material.event_required, event.id AS event_id,
    CASE
      WHEN material.claim_id IS NULL THEN NOT EXISTS (
        SELECT 1 FROM event_only_type WHERE event_type = event.event_type
      )
      WHEN NOT EXISTS (
        SELECT 1 FROM material_pair_type
        WHERE event_type = material.expected_event_type
      ) THEN true
      WHEN event.id IS NULL THEN material.event_required
      WHEN NOT material.event_required THEN true
      WHEN event.work_order_id IS DISTINCT FROM material.work_order_id THEN true
      WHEN event.event_type IS DISTINCT FROM material.expected_event_type THEN true
      WHEN material.reference_key IS NOT NULL
        AND event.detail_snapshot ->> material.reference_key
          IS DISTINCT FROM material.claim_id::text THEN true
      ELSE false
    END AS source_conflict
  FROM collision_material_owner AS material
  FULL JOIN source_event AS event
    ON event.source_type = material.source_type
   AND event.source_id = material.source_id
   AND event.source_key = material.source_key
  LEFT JOIN authoritative_link_owner AS authority
    ON authority.owner_kind = material.owner_kind
   AND authority.claim_id = material.claim_id
   AND authority.source_type = material.source_type
   AND authority.source_id = material.source_id
   AND authority.source_key = material.source_key
), source_integrity AS (
  SELECT
    source_type,
    source_id,
    source_key,
    (MIN(vehicle_id::text) FILTER (
      WHERE authoritative_claim_id IS NOT NULL
    ))::uuid AS vehicle_id,
    COUNT(DISTINCT owner_kind || ':' || claim_id::text) AS material_owner_count,
    COUNT(DISTINCT owner_kind || ':' || authoritative_claim_id::text)
      AS authoritative_owner_count,
    COUNT(DISTINCT event_id) AS event_owner_count,
    BOOL_OR(source_conflict)
      OR COUNT(DISTINCT owner_kind || ':' || claim_id::text) > 1
      OR CASE
        WHEN COUNT(DISTINCT claim_id) = 0 THEN COUNT(DISTINCT event_id) <> 1
        WHEN BOOL_AND(event_required) THEN COUNT(DISTINCT event_id) <> 1
        ELSE COUNT(DISTINCT event_id) <> 0
      END AS source_conflict
  FROM joined_claim
  GROUP BY source_type, source_id, source_key
)
SELECT
  expected.source_type,
  expected.source_id,
  expected.source_key,
  CASE
    WHEN COALESCE(SUM(link.authoritative_owner_count), 0) = 0
      AND COALESCE(SUM(link.material_owner_count), 0) = 0
      AND BOOL_AND(NOT COALESCE(link.source_conflict, false))
      THEN 'UNLINKED_REVIEW_REQUIRED'
    WHEN COALESCE(SUM(link.authoritative_owner_count), 0) = 1
      AND COALESCE(SUM(link.material_owner_count), 0) = 1
      AND BOOL_AND(link.source_key = expected.source_key)
      AND BOOL_AND(link.vehicle_id = expected.vehicle_id)
      AND BOOL_AND(NOT link.source_conflict)
      THEN 'LINKED'
    ELSE 'SOURCE_CONFLICT'
  END AS classification,
  COALESCE(SUM(link.material_owner_count + link.event_owner_count), 0)
    AS source_claim_count
FROM expected_source AS expected
LEFT JOIN source_integrity AS link
  ON link.source_type = expected.source_type
 AND link.source_id = expected.source_id
GROUP BY expected.source_type, expected.source_id, expected.source_key, expected.vehicle_id
ORDER BY expected.source_type, expected.source_id;
COMMIT;
```

## 6. 可用性与运营限制只读核对

### 6.1 ACTIVE BLOCKING 按 scope 计数

输出四个 scope 的精确限制数、车辆数和无敏感字段 fingerprint；未来开始的限制不算 active blocker。

<!-- stage1c-sql:07-active-blocker-scopes -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH params AS (
  SELECT CURRENT_TIMESTAMP AS as_of
), expected_scope(scope) AS (
  VALUES ('ALLOCATION'), ('DELIVERY'), ('CUSTOMER_USE'), ('INVENTORY_RELEASE')
), active_scope AS (
  SELECT restriction.id, restriction.vehicle_id, scope_value::text AS scope
  FROM vehicle_operational_restriction AS restriction
  CROSS JOIN params
  CROSS JOIN LATERAL unnest(restriction.scopes) AS scope_value
  WHERE restriction.status = 'ACTIVE'
    AND restriction.severity = 'BLOCKING'
    AND restriction.started_at <= params.as_of
)
SELECT
  expected_scope.scope,
  COUNT(active_scope.id) AS active_blocking_restriction_count,
  COUNT(DISTINCT active_scope.vehicle_id) AS blocked_vehicle_count,
  md5(COALESCE(string_agg(active_scope.id::text, ',' ORDER BY active_scope.id), '')) AS fingerprint
FROM expected_scope
LEFT JOIN active_scope USING (scope)
GROUP BY expected_scope.scope
ORDER BY expected_scope.scope;
COMMIT;
```

### 6.2 AVAILABLE 但受阻或被占用

此查询覆盖 **AVAILABLE 但受阻或被占用**。预期零行；非零不授权修改车辆、期间或限制。

<!-- stage1c-sql:08-available-blocked-occupied -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH params AS (
  SELECT CURRENT_TIMESTAMP AS as_of
)
SELECT
  vehicle.id AS vehicle_id,
  COUNT(DISTINCT period.id) AS open_period_count,
  COUNT(DISTINCT restriction.id) AS active_blocker_count,
  md5(COALESCE(
    string_agg(DISTINCT period.id::text, ',' ORDER BY period.id::text),
    ''
  )) AS period_fingerprint,
  md5(COALESCE(
    string_agg(DISTINCT restriction.id::text, ',' ORDER BY restriction.id::text),
    ''
  )) AS restriction_fingerprint
FROM vehicle
CROSS JOIN params
LEFT JOIN vehicle_subscription_period AS period
  ON period.vehicle_id = vehicle.id
 AND period.started_at <= params.as_of
 AND (period.ended_at IS NULL OR period.ended_at > params.as_of)
LEFT JOIN vehicle_operational_restriction AS restriction
  ON restriction.vehicle_id = vehicle.id
 AND restriction.status = 'ACTIVE'
 AND restriction.severity = 'BLOCKING'
 AND restriction.started_at <= params.as_of
 AND restriction.scopes && ARRAY['ALLOCATION', 'DELIVERY', 'INVENTORY_RELEASE']::vehicle_operational_restriction_scope[]
WHERE vehicle.deleted_at IS NULL
  AND vehicle.status = 'AVAILABLE'
GROUP BY vehicle.id
HAVING COUNT(DISTINCT period.id) > 0 OR COUNT(DISTINCT restriction.id) > 0
ORDER BY vehicle.id;
COMMIT;
```

### 6.3 三用途 evaluator 与 SQL parity

本查询以最终规则计算每辆未删除车辆对 `ALLOCATION`、`DELIVERY`、`MARK_AVAILABLE` 的决定摘要。
记录每个 purpose 的允许/拒绝数与决定 fingerprint；它必须与同一 SHA 的 API/helper 结果相同。

<!-- stage1c-sql:09-availability-parity -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH params AS (
  SELECT CURRENT_TIMESTAMP AS as_of
), purpose(purpose) AS (
  VALUES ('ALLOCATION'), ('DELIVERY'), ('MARK_AVAILABLE')
), decision AS (
  SELECT
    vehicle.id AS vehicle_id,
    purpose.purpose,
    (
      CASE purpose.purpose
        WHEN 'ALLOCATION' THEN vehicle.status = 'AVAILABLE'
        WHEN 'DELIVERY' THEN vehicle.status = 'RESERVED'
        WHEN 'MARK_AVAILABLE' THEN vehicle.status IN (
          'DRAFT', 'IN_PREPARATION', 'RETURNED', 'MAINTENANCE', 'AVAILABLE'
        )
      END
      AND (
        purpose.purpose = 'DELIVERY'
        OR (
          vehicle.sale_price_status = 'EFFECTIVE'
          AND vehicle.current_sale_price_amount IS NOT NULL
          AND vehicle.current_sale_price_amount > 0
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM vehicle_subscription_period AS period
        WHERE period.vehicle_id = vehicle.id
          AND period.started_at <= params.as_of
          AND (period.ended_at IS NULL OR period.ended_at > params.as_of)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM vehicle_operational_restriction AS restriction
        WHERE restriction.vehicle_id = vehicle.id
          AND restriction.status = 'ACTIVE'
          AND restriction.severity = 'BLOCKING'
          AND restriction.started_at <= params.as_of
          AND CASE purpose.purpose
            WHEN 'ALLOCATION' THEN 'ALLOCATION' = ANY(restriction.scopes)
            WHEN 'DELIVERY' THEN 'DELIVERY' = ANY(restriction.scopes)
            WHEN 'MARK_AVAILABLE' THEN restriction.scopes && ARRAY[
              'ALLOCATION', 'DELIVERY', 'INVENTORY_RELEASE'
            ]::vehicle_operational_restriction_scope[]
          END
      )
    ) AS available
  FROM vehicle
  CROSS JOIN purpose
  CROSS JOIN params
  WHERE vehicle.deleted_at IS NULL
)
SELECT
  purpose,
  COUNT(*) FILTER (WHERE available) AS available_count,
  COUNT(*) FILTER (WHERE NOT available) AS blocked_count,
  md5(COALESCE(string_agg(
    vehicle_id::text || ':' || available::text,
    ',' ORDER BY vehicle_id
  ), '')) AS decision_fingerprint
FROM decision
GROUP BY purpose
ORDER BY purpose;
COMMIT;
```

## 7. 不变量、不可变事实与审计核对

### 7.1 限制解除元组完整性

以下**限制解除元组完整性**查询预期零行：

<!-- stage1c-sql:10-release-tuple -->

```sql
BEGIN TRANSACTION READ ONLY;
SELECT id AS restriction_id, status
FROM vehicle_operational_restriction
WHERE (
  status = 'ACTIVE'
  AND num_nonnulls(
    released_at, released_by, release_reason, release_snapshot,
    release_source_type, release_source_id, release_source_key
  ) <> 0
) OR (
  status IN ('RELEASED', 'VOIDED')
  AND num_nonnulls(
    released_at, released_by, release_reason, release_snapshot,
    release_source_type, release_source_id, release_source_key
  ) <> 7
) OR released_at < started_at
ORDER BY id;
COMMIT;
```

### 7.2 工单终态时间戳一致性

以下**工单终态时间戳一致性**查询预期零行：

<!-- stage1c-sql:11-terminal-timestamp -->

```sql
BEGIN TRANSACTION READ ONLY;
SELECT id AS work_order_id, status, closed_at, cancelled_at
FROM asset_work_order
WHERE (status = 'CLOSED' AND (closed_at IS NULL OR cancelled_at IS NOT NULL))
   OR (status = 'CANCELLED' AND (cancelled_at IS NULL OR closed_at IS NOT NULL))
   OR (status NOT IN ('CLOSED', 'CANCELLED') AND (closed_at IS NOT NULL OR cancelled_at IS NOT NULL))
   OR closed_at < created_at
   OR cancelled_at < created_at
ORDER BY id;
COMMIT;
```

### 7.3 重复来源元组

每个 exact source tuple 只能有一个 material owner。工单创建必须精确配对同工单 `CREATED`；证据必须精确配对同工单、
`detail_snapshot.evidenceId` 相同的 `EVIDENCE_ATTACHED`；关联工单的限制开始/解除必须精确配对同工单、
`detail_snapshot.restrictionId` 相同的 `RESTRICTION_CREATED`/`RESTRICTION_RELEASED`。无关联工单的限制
不得有配对 event。唯一且零 material 的 assignment、transition/lifecycle、physical-control、inspection、
note event 是合法 event-only source；一旦与 material 共用 tuple 即冲突。只有工单 create 与限制 START 是
`authoritative_link_owner`；证据与限制 RELEASE 即使合法配对也只能形成 collision claim，绝不能建立 legacy link。
以下**来源 owner 与合法 event 配对完整性**查询预期零行；缺失/错误/多个 event、无关联限制却有 event、
多个 material owner 或跨工单/错误引用全部是 `SOURCE_CONFLICT`：

<!-- stage1c-sql:12-source-integrity -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH event_only_type(event_type) AS (
  VALUES
    ('ASSIGNED'), ('STARTED'), ('WAITING_EXTERNAL'), ('RESUMED'),
    ('SUBMITTED_FOR_ACCEPTANCE'), ('ACCEPTED'), ('COST_CONFIRMED'),
    ('PHYSICAL_CONTROL_CONFIRMED'), ('INSPECTION_RECORDED'), ('CLOSED'),
    ('CANCELLED'), ('NOTE_ADDED')
), material_pair_type(event_type) AS (
  VALUES
    ('CREATED'), ('EVIDENCE_ATTACHED'),
    ('RESTRICTION_CREATED'), ('RESTRICTION_RELEASED')
), collision_material_owner AS (
  SELECT create_source_type AS source_type, create_source_id AS source_id,
    create_source_key AS source_key, 'ASSET_WORK_ORDER'::text AS owner_kind,
    id AS claim_id, id AS work_order_id, 'CREATED'::text AS expected_event_type,
    NULL::text AS reference_key, true AS event_required
  FROM asset_work_order
  UNION ALL
  SELECT source_type, source_id, source_key, 'ASSET_WORK_ORDER_EVIDENCE', id,
    work_order_id, 'EVIDENCE_ATTACHED', 'evidenceId', true
  FROM asset_work_order_evidence
  UNION ALL
  SELECT start_source_type, start_source_id, start_source_key,
    'VEHICLE_OPERATIONAL_RESTRICTION_START', id, work_order_id,
    'RESTRICTION_CREATED', 'restrictionId', work_order_id IS NOT NULL
  FROM vehicle_operational_restriction
  UNION ALL
  SELECT release_source_type, release_source_id, release_source_key,
    'VEHICLE_OPERATIONAL_RESTRICTION_RELEASE', id, work_order_id,
    'RESTRICTION_RELEASED', 'restrictionId', work_order_id IS NOT NULL
  FROM vehicle_operational_restriction
  WHERE release_source_type IS NOT NULL
    AND release_source_id IS NOT NULL
    AND release_source_key IS NOT NULL
), authoritative_link_owner AS (
  SELECT *
  FROM collision_material_owner
  WHERE owner_kind = 'ASSET_WORK_ORDER'
     OR owner_kind = 'VEHICLE_OPERATIONAL_RESTRICTION_START'
), source_event AS (
  SELECT
    event.source_type, event.source_id, event.source_key, event.id AS event_id,
    event.work_order_id, event.event_type::text AS event_type, event.detail_snapshot
  FROM asset_work_order_event AS event
), joined_claim AS (
  SELECT
    COALESCE(material.source_type, event.source_type) AS source_type,
    COALESCE(material.source_id, event.source_id) AS source_id,
    COALESCE(material.source_key, event.source_key) AS source_key,
    material.owner_kind, material.claim_id,
    authority.claim_id AS authoritative_claim_id,
    material.event_required, event.event_id,
    CASE
      WHEN material.claim_id IS NULL THEN NOT EXISTS (
        SELECT 1 FROM event_only_type WHERE event_type = event.event_type
      )
      WHEN NOT EXISTS (
        SELECT 1 FROM material_pair_type
        WHERE event_type = material.expected_event_type
      ) THEN true
      WHEN event.event_id IS NULL THEN material.event_required
      WHEN NOT material.event_required THEN true
      WHEN event.work_order_id IS DISTINCT FROM material.work_order_id THEN true
      WHEN event.event_type IS DISTINCT FROM material.expected_event_type THEN true
      WHEN material.reference_key IS NOT NULL
        AND event.detail_snapshot ->> material.reference_key
          IS DISTINCT FROM material.claim_id::text THEN true
      ELSE false
    END AS row_source_conflict,
    event.event_type
  FROM collision_material_owner AS material
  FULL JOIN source_event AS event
    ON event.source_type = material.source_type
   AND event.source_id = material.source_id
   AND event.source_key = material.source_key
  LEFT JOIN authoritative_link_owner AS authority
    ON authority.owner_kind = material.owner_kind
   AND authority.claim_id = material.claim_id
   AND authority.source_type = material.source_type
   AND authority.source_id = material.source_id
   AND authority.source_key = material.source_key
), source_integrity AS (
  SELECT
    source_type,
    source_id,
    source_key,
    COUNT(DISTINCT owner_kind || ':' || claim_id::text) AS material_owner_count,
    COUNT(DISTINCT owner_kind || ':' || authoritative_claim_id::text)
      AS authoritative_owner_count,
    COUNT(DISTINCT event_id) AS event_owner_count,
    BOOL_OR(row_source_conflict)
      OR COUNT(DISTINCT owner_kind || ':' || claim_id::text) > 1
      OR CASE
        WHEN COUNT(DISTINCT claim_id) = 0 THEN COUNT(DISTINCT event_id) <> 1
        WHEN BOOL_AND(event_required) THEN COUNT(DISTINCT event_id) <> 1
        ELSE COUNT(DISTINCT event_id) <> 0
      END AS source_conflict,
    string_agg(
      DISTINCT owner_kind || ':' || claim_id::text,
      ',' ORDER BY owner_kind || ':' || claim_id::text
    ) AS material_owners,
    string_agg(
      DISTINCT event_type || ':' || event_id::text,
      ',' ORDER BY event_type || ':' || event_id::text
    ) AS event_owners
  FROM joined_claim
  GROUP BY source_type, source_id, source_key
)
SELECT
  source_type, source_id, source_key,
  material_owner_count, authoritative_owner_count, event_owner_count,
  source_conflict, material_owners, event_owners
FROM source_integrity
WHERE source_conflict
ORDER BY source_type, source_id, source_key;
COMMIT;
```

### 7.4 事件 sequence 缺口

以下**事件 sequence 缺口**查询预期零行；每个工单必须从 `1` 开始连续递增：

<!-- stage1c-sql:13-event-sequence -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH sequenced AS (
  SELECT
    event.id,
    event.work_order_id,
    event.sequence,
    row_number() OVER (
      PARTITION BY event.work_order_id
      ORDER BY event.sequence, event.id
    ) AS expected_sequence
  FROM asset_work_order_event AS event
)
SELECT id AS event_id, work_order_id, sequence, expected_sequence
FROM sequenced
WHERE sequence IS DISTINCT FROM expected_sequence
ORDER BY work_order_id, expected_sequence;
COMMIT;
```

### 7.5 证据竞争 successor

以下**证据竞争 successor**查询预期零行：

<!-- stage1c-sql:14-evidence-successor -->

```sql
BEGIN TRANSACTION READ ONLY;
SELECT
  supersedes_evidence_id,
  COUNT(*) AS successor_count,
  string_agg(id::text, ',' ORDER BY id) AS successor_ids
FROM asset_work_order_evidence
WHERE supersedes_evidence_id IS NOT NULL
GROUP BY supersedes_evidence_id
HAVING COUNT(*) > 1
ORDER BY supersedes_evidence_id;
COMMIT;
```

### 7.6 数据库专属约束、索引与不可变 trigger catalog

以下 catalog 查询预期零行。它绑定 `current_schema()`，检查三个 row-level `BEFORE UPDATE OR DELETE`
trigger 的完整规范化定义、精确 trigger→function 身份、启用状态和函数语义；`tgattr` 必须为空，不能
缩窄为 `UPDATE OF` 部分列，`tgqual` 必须为空，不能增加 `WHEN` 条件。它还检查 migration 中 Prisma drift 无法完整表达的
十个 CHECK、七个 source/sequence/successor UNIQUE guard 以及 active restriction partial index。缺失、重复、
禁用、仅存在于错误 schema、名称/列序/谓词/函数体定义漂移都会返回 stop row：

<!-- stage1c-sql:15-database-catalog -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH expected_trigger_raw(table_name, trigger_name, function_name, trigger_definition) AS (
  VALUES
    ('asset_work_order_event', 'asset_work_order_event_append_only',
      'reject_asset_operation_append_only_mutation',
      $definition$CREATE TRIGGER asset_work_order_event_append_only BEFORE DELETE OR UPDATE ON asset_work_order_event FOR EACH ROW EXECUTE FUNCTION reject_asset_operation_append_only_mutation()$definition$),
    ('asset_work_order_evidence', 'asset_work_order_evidence_append_only',
      'reject_asset_operation_append_only_mutation',
      $definition$CREATE TRIGGER asset_work_order_evidence_append_only BEFORE DELETE OR UPDATE ON asset_work_order_evidence FOR EACH ROW EXECUTE FUNCTION reject_asset_operation_append_only_mutation()$definition$),
    ('vehicle_operational_restriction', 'vehicle_operational_restriction_release_only',
      'enforce_vehicle_operational_restriction_release',
      $definition$CREATE TRIGGER vehicle_operational_restriction_release_only BEFORE DELETE OR UPDATE ON vehicle_operational_restriction FOR EACH ROW EXECUTE FUNCTION enforce_vehicle_operational_restriction_release()$definition$)
), expected_trigger AS (
  SELECT
    table_name,
    trigger_name,
    function_name,
    btrim(regexp_replace(trigger_definition, '\s+', ' ', 'g'))
      AS normalized_trigger_definition
  FROM expected_trigger_raw
), expected_function_raw(function_name, function_definition) AS (
  VALUES
    ('reject_asset_operation_append_only_mutation', $definition$CREATE OR REPLACE FUNCTION reject_asset_operation_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = format('%I is append-only', TG_TABLE_NAME); END; $function$$definition$),
    ('enforce_vehicle_operational_restriction_release', $definition$CREATE OR REPLACE FUNCTION enforce_vehicle_operational_restriction_release() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'vehicle_operational_restriction cannot be deleted'; END IF; IF OLD."status" <> 'ACTIVE' OR NEW."status" = 'ACTIVE' THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'vehicle_operational_restriction can be released only once'; END IF; IF ROW( NEW."id", NEW."vehicle_id", NEW."work_order_id", NEW."restriction_type", NEW."severity", NEW."scopes", NEW."started_at", NEW."conditions_snapshot", NEW."evidence_snapshot", NEW."start_source_type", NEW."start_source_id", NEW."start_source_key", NEW."created_at", NEW."created_by" ) IS DISTINCT FROM ROW( OLD."id", OLD."vehicle_id", OLD."work_order_id", OLD."restriction_type", OLD."severity", OLD."scopes", OLD."started_at", OLD."conditions_snapshot", OLD."evidence_snapshot", OLD."start_source_type", OLD."start_source_id", OLD."start_source_key", OLD."created_at", OLD."created_by" ) THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'vehicle_operational_restriction start facts are immutable'; END IF; RETURN NEW; END; $function$$definition$)
), expected_function AS (
  SELECT
    function_name,
    btrim(regexp_replace(function_definition, '\s+', ' ', 'g'))
      AS normalized_function_definition
  FROM expected_function_raw
), actual_trigger AS (
  SELECT
    table_schema.nspname AS table_schema,
    table_name.relname AS table_name,
    trigger.tgname AS trigger_name,
    trigger.tgenabled AS enabled,
    trigger.tgtype = 27 AS exact_row_before_update_delete,
    trigger.tgattr = ''::int2vector AS no_update_column_restriction,
    trigger.tgqual IS NULL AS no_when_condition,
    function_schema.nspname AS function_schema,
    function_name.proname AS function_name,
    btrim(regexp_replace(
      replace(pg_get_triggerdef(trigger.oid), table_schema.nspname || '.', ''),
      '\s+', ' ', 'g'
    )) AS normalized_trigger_definition,
    btrim(regexp_replace(
      replace(pg_get_functiondef(trigger.tgfoid), function_schema.nspname || '.', ''),
      '\s+', ' ', 'g'
    )) AS normalized_function_definition
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
    )) AS normalized_function_definition
  FROM pg_proc AS function_name
  JOIN pg_namespace AS namespace ON namespace.oid = function_name.pronamespace
  WHERE function_name.proname IN (
    'reject_asset_operation_append_only_mutation',
    'enforce_vehicle_operational_restriction_release'
  )
), expected_constraint_raw(table_name, constraint_name, constraint_definition) AS (
  VALUES
    ('asset_work_order', 'asset_work_order_version_nonnegative_chk',
      $definition$CHECK ((version >= 0))$definition$),
    ('asset_work_order_event', 'asset_work_order_event_sequence_positive_chk',
      $definition$CHECK ((sequence > 0))$definition$),
    ('asset_work_order_event', 'asset_work_order_event_occurred_not_future_chk',
      $definition$CHECK ((occurred_at <= recorded_at))$definition$),
    ('asset_work_order_evidence', 'asset_work_order_evidence_sha256_chk',
      $definition$CHECK (((content_sha256 IS NULL) OR ((content_sha256)::text ~ '^[0-9a-f]{64}$'::text)))$definition$),
    ('asset_work_order_evidence', 'asset_work_order_evidence_action_shape_chk',
      $definition$CHECK ((((action = 'REMOVE'::asset_work_order_evidence_action) AND (file_id IS NULL) AND (content_sha256 IS NULL) AND (supersedes_evidence_id IS NOT NULL)) OR ((action = 'ATTACH'::asset_work_order_evidence_action) AND (file_id IS NOT NULL) AND (content_sha256 IS NOT NULL) AND (supersedes_evidence_id IS NULL)) OR ((action = 'SUPERSEDE'::asset_work_order_evidence_action) AND (file_id IS NOT NULL) AND (content_sha256 IS NOT NULL) AND (supersedes_evidence_id IS NOT NULL))))$definition$),
    ('asset_work_order_evidence', 'asset_work_order_evidence_file_snapshot_shape_chk',
      $definition$CHECK ((((file_id IS NULL) AND (file_bucket IS NULL) AND (file_object_key IS NULL) AND (file_size_bytes IS NULL) AND (file_mime_type IS NULL)) OR ((file_id IS NOT NULL) AND (file_bucket IS NOT NULL) AND (file_object_key IS NOT NULL) AND (file_size_bytes IS NOT NULL))))$definition$),
    ('asset_work_order_evidence', 'asset_work_order_evidence_file_size_nonnegative_chk',
      $definition$CHECK (((file_size_bytes IS NULL) OR (file_size_bytes >= 0)))$definition$),
    ('vehicle_operational_restriction', 'vehicle_operational_restriction_scopes_not_empty_chk',
      $definition$CHECK ((cardinality(scopes) > 0))$definition$),
    ('vehicle_operational_restriction', 'vehicle_operational_restriction_release_after_start_chk',
      $definition$CHECK (((released_at IS NULL) OR (released_at >= started_at)))$definition$),
    ('vehicle_operational_restriction', 'vehicle_operational_restriction_release_tuple_chk',
      $definition$CHECK ((((status = 'ACTIVE'::vehicle_operational_restriction_status) AND (released_at IS NULL) AND (released_by IS NULL) AND (release_reason IS NULL) AND (release_snapshot IS NULL) AND (release_source_type IS NULL) AND (release_source_id IS NULL) AND (release_source_key IS NULL)) OR ((status = ANY (ARRAY['RELEASED'::vehicle_operational_restriction_status, 'VOIDED'::vehicle_operational_restriction_status])) AND (released_at IS NOT NULL) AND (released_by IS NOT NULL) AND (release_reason IS NOT NULL) AND (release_snapshot IS NOT NULL) AND (release_source_type IS NOT NULL) AND (release_source_id IS NOT NULL) AND (release_source_key IS NOT NULL))))$definition$)
), expected_constraint AS (
  SELECT
    table_name,
    constraint_name,
    btrim(regexp_replace(constraint_definition, '\s+', ' ', 'g'))
      AS normalized_constraint_definition
  FROM expected_constraint_raw
), actual_constraint AS (
  SELECT
    namespace.nspname AS table_schema, table_name.relname AS table_name,
    constraint_name.conname AS constraint_name,
    constraint_name.convalidated,
    btrim(regexp_replace(pg_get_constraintdef(constraint_name.oid), '\s+', ' ', 'g'))
      AS normalized_constraint_definition
  FROM pg_constraint AS constraint_name
  JOIN pg_class AS table_name ON table_name.oid = constraint_name.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = table_name.relnamespace
  WHERE constraint_name.contype = 'c'
), expected_index_raw(table_name, index_name, expected_unique, index_definition) AS (
  VALUES
    ('asset_work_order', 'asset_work_order_create_source_key',
      true, $definition$CREATE UNIQUE INDEX asset_work_order_create_source_key ON asset_work_order USING btree (create_source_type, create_source_id, create_source_key)$definition$),
    ('asset_work_order_event', 'asset_work_order_event_work_order_sequence_key',
      true, $definition$CREATE UNIQUE INDEX asset_work_order_event_work_order_sequence_key ON asset_work_order_event USING btree (work_order_id, sequence)$definition$),
    ('asset_work_order_event', 'asset_work_order_event_source_key',
      true, $definition$CREATE UNIQUE INDEX asset_work_order_event_source_key ON asset_work_order_event USING btree (source_type, source_id, source_key)$definition$),
    ('asset_work_order_evidence', 'asset_work_order_evidence_source_key',
      true, $definition$CREATE UNIQUE INDEX asset_work_order_evidence_source_key ON asset_work_order_evidence USING btree (source_type, source_id, source_key)$definition$),
    ('asset_work_order_evidence', 'asset_work_order_evidence_supersedes_evidence_id_key',
      true, $definition$CREATE UNIQUE INDEX asset_work_order_evidence_supersedes_evidence_id_key ON asset_work_order_evidence USING btree (supersedes_evidence_id)$definition$),
    ('vehicle_operational_restriction', 'vehicle_operational_restriction_start_source_key',
      true, $definition$CREATE UNIQUE INDEX vehicle_operational_restriction_start_source_key ON vehicle_operational_restriction USING btree (start_source_type, start_source_id, start_source_key)$definition$),
    ('vehicle_operational_restriction', 'vehicle_operational_restriction_release_source_key',
      true, $definition$CREATE UNIQUE INDEX vehicle_operational_restriction_release_source_key ON vehicle_operational_restriction USING btree (release_source_type, release_source_id, release_source_key)$definition$),
    ('vehicle_operational_restriction', 'vehicle_operational_restriction_active_vehicle_idx',
      false, $definition$CREATE INDEX vehicle_operational_restriction_active_vehicle_idx ON vehicle_operational_restriction USING btree (vehicle_id, severity) WHERE (status = 'ACTIVE'::vehicle_operational_restriction_status)$definition$)
), expected_index AS (
  SELECT
    table_name,
    index_name,
    expected_unique,
    btrim(regexp_replace(index_definition, '\s+', ' ', 'g'))
      AS normalized_index_definition
  FROM expected_index_raw
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
    )) AS normalized_index_definition
  FROM pg_index AS index_state
  JOIN pg_class AS index_name ON index_name.oid = index_state.indexrelid
  JOIN pg_class AS table_name ON table_name.oid = index_state.indrelid
  JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_name.relnamespace
), trigger_anomaly AS (
  SELECT
    'TRIGGER'::text AS object_kind,
    expected.table_name,
    expected.trigger_name AS object_name,
    string_agg(DISTINCT actual.table_schema, ',' ORDER BY actual.table_schema) AS actual_schemas,
    md5(COALESCE(string_agg(
      actual.normalized_trigger_definition || ':' || actual.normalized_function_definition,
      ',' ORDER BY actual.table_schema, actual.trigger_name
    ), '')) AS definition_fingerprint
  FROM expected_trigger AS expected
  JOIN expected_function AS expected_body
    ON expected_body.function_name = expected.function_name
  LEFT JOIN actual_trigger AS actual
    ON actual.table_name = expected.table_name
   AND actual.trigger_name = expected.trigger_name
  GROUP BY expected.table_name, expected.trigger_name, expected.function_name,
    expected.normalized_trigger_definition, expected_body.normalized_function_definition
  HAVING COUNT(*) FILTER (WHERE actual.table_schema = current_schema()) <> 1
     OR COUNT(*) FILTER (WHERE actual.table_schema <> current_schema()) > 0
     OR BOOL_OR(
       actual.table_schema = current_schema() AND (
         actual.function_schema IS DISTINCT FROM current_schema()
         OR actual.function_name IS DISTINCT FROM expected.function_name
         OR actual.enabled IS DISTINCT FROM 'O'
         OR actual.exact_row_before_update_delete IS NOT TRUE
         OR actual.no_update_column_restriction IS NOT TRUE
         OR actual.no_when_condition IS NOT TRUE
         OR actual.normalized_trigger_definition IS DISTINCT FROM
           expected.normalized_trigger_definition
         OR actual.normalized_function_definition IS DISTINCT FROM
           expected_body.normalized_function_definition
       )
     )
), function_anomaly AS (
  SELECT
    'FUNCTION'::text AS object_kind,
    '<none>'::text AS table_name,
    expected.function_name AS object_name,
    string_agg(DISTINCT actual.function_schema, ',' ORDER BY actual.function_schema)
      AS actual_schemas,
    md5(COALESCE(string_agg(
      actual.normalized_function_definition,
      ',' ORDER BY actual.function_schema, actual.function_name
    ), '')) AS definition_fingerprint
  FROM expected_function AS expected
  LEFT JOIN actual_function AS actual ON actual.function_name = expected.function_name
  GROUP BY expected.function_name, expected.normalized_function_definition
  HAVING COUNT(*) FILTER (WHERE actual.function_schema = current_schema()) <> 1
     OR COUNT(*) FILTER (WHERE actual.function_schema <> current_schema()) > 0
     OR BOOL_OR(
       actual.function_schema = current_schema()
       AND actual.normalized_function_definition IS DISTINCT FROM
         expected.normalized_function_definition
     )
), constraint_anomaly AS (
  SELECT
    'CHECK'::text AS object_kind,
    expected.table_name,
    expected.constraint_name AS object_name,
    string_agg(DISTINCT actual.table_schema, ',' ORDER BY actual.table_schema) AS actual_schemas,
    md5(COALESCE(string_agg(
      actual.normalized_constraint_definition,
      ',' ORDER BY actual.table_schema, actual.constraint_name
    ), '')) AS definition_fingerprint
  FROM expected_constraint AS expected
  LEFT JOIN actual_constraint AS actual
    ON actual.table_name = expected.table_name
   AND actual.constraint_name = expected.constraint_name
  GROUP BY expected.table_name, expected.constraint_name,
    expected.normalized_constraint_definition
  HAVING COUNT(*) FILTER (WHERE actual.table_schema = current_schema()) <> 1
     OR COUNT(*) FILTER (WHERE actual.table_schema <> current_schema()) > 0
     OR BOOL_OR(
       actual.table_schema = current_schema()
       AND (
         actual.convalidated IS NOT TRUE
         OR actual.normalized_constraint_definition IS DISTINCT FROM
           expected.normalized_constraint_definition
       )
     )
), index_anomaly AS (
  SELECT
    'INDEX'::text AS object_kind,
    expected.table_name,
    expected.index_name AS object_name,
    string_agg(DISTINCT actual.table_schema, ',' ORDER BY actual.table_schema) AS actual_schemas,
    md5(COALESCE(string_agg(
      actual.normalized_index_definition,
      ',' ORDER BY actual.table_schema, actual.index_name
    ), '')) AS definition_fingerprint
  FROM expected_index AS expected
  LEFT JOIN actual_index AS actual
    ON actual.table_name = expected.table_name
   AND actual.index_name = expected.index_name
  GROUP BY expected.table_name, expected.index_name, expected.expected_unique,
    expected.normalized_index_definition
  HAVING COUNT(*) FILTER (WHERE actual.table_schema = current_schema()) <> 1
     OR COUNT(*) FILTER (WHERE actual.table_schema <> current_schema()) > 0
     OR BOOL_OR(
       actual.table_schema = current_schema()
       AND (
         actual.indisvalid IS NOT TRUE
         OR actual.indisready IS NOT TRUE
         OR actual.indisunique IS DISTINCT FROM expected.expected_unique
         OR actual.normalized_index_definition IS DISTINCT FROM
           expected.normalized_index_definition
       )
     )
)
SELECT * FROM trigger_anomaly
UNION ALL
SELECT * FROM function_anomaly
UNION ALL
SELECT * FROM constraint_anomaly
UNION ALL
SELECT * FROM index_anomaly
ORDER BY object_kind, table_name, object_name;
COMMIT;
```

### 7.7 AuditLog 精确计数与 fingerprint

记录这一个完整单行；计数或 fingerprint 在未发生获批写入时必须保持不变。它只输出 UUID、时间、
动作和 hash，不输出 snapshot 内容。每个新 material fact 必须精确对应一个 `CREATE` AuditLog；缺失、
重复/额外 CREATE，或任一审计指向不存在的事实都停止。

<!-- stage1c-sql:16-audit-integrity -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH asset_audit AS (
  SELECT id, entity_type, entity_id, action, created_at
  FROM audit_log
  WHERE module = 'asset_operations'
), fact_identity AS (
  SELECT 'asset_work_order'::text AS entity_type, id FROM asset_work_order
  UNION ALL
  SELECT 'asset_work_order_event', id FROM asset_work_order_event
  UNION ALL
  SELECT 'asset_work_order_evidence', id FROM asset_work_order_evidence
  UNION ALL
  SELECT 'vehicle_operational_restriction', id FROM vehicle_operational_restriction
), create_audit_cardinality AS (
  SELECT
    fact.entity_type,
    fact.id AS entity_id,
    COUNT(audit.id) AS create_audit_count
  FROM fact_identity AS fact
  LEFT JOIN asset_audit AS audit
    ON audit.entity_type = fact.entity_type
   AND audit.entity_id = fact.id
   AND audit.action = 'CREATE'
  GROUP BY fact.entity_type, fact.id
)
SELECT
  (SELECT COUNT(*) FROM asset_work_order) AS work_order_count,
  (SELECT COUNT(*) FROM asset_work_order_event) AS event_count,
  (SELECT COUNT(*) FROM asset_work_order_evidence) AS evidence_count,
  (SELECT COUNT(*) FROM vehicle_operational_restriction) AS restriction_count,
  (SELECT COUNT(*) FROM asset_audit) AS asset_operations_audit_count,
  (
    SELECT COUNT(*)
    FROM create_audit_cardinality
    WHERE create_audit_count <> 1
  ) AS facts_with_invalid_create_audit_count,
  (
    SELECT COUNT(*)
    FROM create_audit_cardinality
    WHERE create_audit_count = 0
  ) AS facts_without_create_audit,
  (
    SELECT COUNT(*)
    FROM create_audit_cardinality
    WHERE create_audit_count > 1
  ) AS facts_with_duplicate_create_audit,
  (
    SELECT COALESCE(SUM(create_audit_count - 1), 0)
    FROM create_audit_cardinality
    WHERE create_audit_count > 1
  ) AS extra_create_audits,
  (
    SELECT COUNT(*)
    FROM asset_audit AS audit
    LEFT JOIN fact_identity AS fact
      ON fact.entity_type = audit.entity_type
     AND fact.id = audit.entity_id
    WHERE fact.id IS NULL
  ) AS audits_without_fact,
  md5(COALESCE((
    SELECT string_agg(
      entity_type || ':' || id::text,
      ',' ORDER BY entity_type, id
    )
    FROM fact_identity
  ), '')) AS fact_fingerprint,
  md5(COALESCE((
    SELECT string_agg(
      entity_type || ':' || COALESCE(entity_id::text, '<NULL>') || ':' ||
        action::text || ':' ||
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || ':' ||
        id::text,
      ',' ORDER BY entity_type, entity_id, created_at, id
    )
    FROM asset_audit
  ), '')) AS audit_fingerprint;
COMMIT;
```

## 8. 竞争、错误与重试语义

所有写命令要求调用方持有的 `READ COMMITTED` interactive transaction。锁顺序固定为：统一 source
ownership advisory lock；按表名/UUID 稳定排序的 authority `FOR SHARE NOWAIT`；最后是可变领域行
`FOR UPDATE`。不得改变顺序或自行开启嵌套事务。

- 缺少调用方 transaction 或隔离级别不是 `READ COMMITTED` 时返回
  `ASSET_OPERATION_TRANSACTION_REQUIRED`；不得降级执行。
- 相同 exact source tuple 但 command/payload/authority snapshot 不同返回
  `ASSET_OPERATION_SOURCE_CONFLICT`；同工单的 `expectedVersion` 已变化返回
  `ASSET_WORK_ORDER_VERSION_CONFLICT`。两者都要求重新读取和人工判断，不能换 key、覆盖或 blind retry。
- authority 正在写入时，返回 HTTP `409` + `ASSET_OPERATION_AUTHORITY_BUSY`；不泄漏 SQLSTATE、
  连接信息或原始数据库异常。不要紧密自动重试，也不要终止未知的正常业务事务。
- 先重新读取权威聚合、工单/限制和 availability。只有 authority/source/payload 全部未变时，才用
  同一个 `Idempotency-Key` 重试；任何变化都停止并重新审核。相同 source tuple 的不同 payload 是
  稳定冲突，不得换 key 掩盖。
- 同步 HTTP 可用性拒绝返回 HTTP `409` + `VEHICLE_OPERATIONALLY_RESTRICTED`，且在任何车辆、订单、
  合同、Lease、期间、里程、权益或审计写入前失败。
- Journey 激活遇到这个**精确业务冲突**时必须持久化 `status = PAUSED`、
  `pausedFromStatus = RUNNING` 和一个 `JOURNEY_PAUSED` event/outbox，然后正常完成当前 claimed job；
  不得重试或进入 `DEAD_LETTER`。其他异常仍走原技术错误语义，不能被误归类。
- 有权人员清除阻断并复核后，使用既有 resume；新激活 job 必须携带精确 `orderId` 和
  `finalPlanRevision`。若限制仍在，新 revision 再次进入 PAUSED，而不是重试或死信。
- 已完成的权威激活 exact replay 不因事后新建限制而改写历史结果；新业务动作必须读取当前限制。

## 9. 只读执行方法与停止规则

每个 `sql` fence 已独立包含 `BEGIN TRANSACTION READ ONLY; ... COMMIT;`，必须逐段原样执行，设置
`ON_ERROR_STOP`，保存段编号、退出码、返回行数和脱敏摘要。不要把多个段拼接后只记录一个退出码。

任一情况立即停止发布并保留现场：

- 第 2 节任一门禁非零或数量与批准清单不同；
- SQL 解析/执行错误、只读事务无法建立、输出截断，或运行身份/数据库不确定；
- 角色矩阵差异；任一 `SOURCE_CONFLICT`；未知 classification；
- AVAILABLE 车辆受阻/被占用、不变量/trigger 查询非零；
- `facts_with_invalid_create_audit_count`、`facts_without_create_audit`、
  `facts_with_duplicate_create_audit`、`extra_create_audits` 或 `audits_without_fact` 非零；未获批窗口内
  计数/fingerprint 变化；
- 原始输出包含凭据、客户 PII 或其他不应暴露字段；
- 有人要求运行 seed、历史 apply、临时 UPDATE/DELETE、checksum repair 或“先上线后核对”。

异常只记录，不在本手册内修复。`UNLINKED_REVIEW_REQUIRED` 可存在，但必须逐条进入人工 review，并且
不改变发布 eligibility 的其他 stop gate；`SOURCE_CONFLICT` 始终阻断。

## 10. 回滚与前向纠正

数据库只允许前向、可审计纠正：

- 可回退到兼容的上一版应用镜像并停止新的 Stage 1C-B 管理写入；保留 additive migration 和所有事实、
  event、evidence、restriction、AuditLog。
- 已追加 event/evidence 不得 UPDATE/DELETE；错误证据追加 `SUPERSEDE`/`REMOVE`，保留完整 predecessor。
- 已解除/作废限制不能重开或改写 start/release tuple；若仍需阻断，以新来源元组创建新的、独立审批的
  限制。错误 active 限制通过已批准 release/void 命令前向关闭。
- 工单错误通过合法状态命令、追加 note/event 或未来单独批准的补偿能力表达；不得改历史 source key、
  时间戳或审计。
- 数据库约束无法表达纠正时，先评审新的 additive migration/command，再执行；不回退或编辑已应用
  migration。
- 纠正后重新执行 migration/checksum/drift 门禁、全部只读 SQL、计数/fingerprint 和双人复核。

## 11. 证据脱敏与保留

不得输出或保存 `DATABASE_URL`、数据库用户名或密码，也不得记录 token、Cookie、请求头、原始连接
错误、shell tracing 或进程环境。SQL 输出只保留本手册列出的 UUID、枚举、计数和 fingerprint；报告中
不得增加客户 PII、VIN、车牌、手机号、姓名、证件号或内部审批备注。需要跨报告关联时使用受控 HMAC
或掩码，不使用可逆明文映射。

原始门禁输出和原始 SQL 输出不得提交 Git。它们只进入仓库外受控加密证据存储；记录 Git SHA、镜像
digest、数据库标识、执行/复核人、时间、每段退出码/行数，以及原始文件和脱敏摘要各自的 SHA-256。
控制台日志按同等级敏感证据保护。

保留期限遵循组织的审计/法务保留策略和对应变更单；如两者期限不同，取更长者。期限届满也只能按
受控销毁流程处理，不能以清理仓库、重置数据库或删除 AuditLog 代替。Production 原始或脱敏报告均
不得提交 Git，只在变更/证据系统保留权限受限附件或引用。

## 12. 2026-08-20 专用 Local 数据库只读执行记录

目标固定为容器 `subscription-saas-codex-postgres`、loopback 端口 `55432`、数据库
`subscription_saas_codex`。用户名/密码仅由 `docker inspect` 读入当前父进程变量并注入子进程；没有
打印连接串或 secret。generic seed 未部署且未执行；也未运行 access apply、历史 apply、migration
deploy、数据库写入或网络操作。

本节只记录脱敏计数和异常分类；原始输出不进入 Git。

### 12.1 SQL 执行结果

16/16 个 SQL block 均以 `ON_ERROR_STOP` 执行，退出码全部为 `0`，每段均显示 `BEGIN` 和 `COMMIT`。
第一次执行 trigger catalog 时发现 PostgreSQL 把 migration 中的 `BEFORE UPDATE OR DELETE` 规范化输出为
`BEFORE DELETE OR UPDATE`，导致文档查询误报两行。根因确认后仅把只读 catalog 正则改为接受两个等价
顺序；没有修改 trigger、migration 或数据库。Fix Round 1 又从最终 marker 原文提取恰好 16 段完整重跑，
扩展后的 source/event integrity、数据库 catalog 和 CREATE-audit cardinality 均为零异常。最终结果如下：

| SQL 段                         | 最终返回                           | 脱敏结果/异常解释                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 迁移目录摘要                   | 1 行                               | applied `93`；rolled-back `1`；failed/incomplete `0`；fingerprint `35b4e25989bff2c9b94b04185483aa6d`。rolled-back 非零，停止门禁。                                                                  |
| 八角色权限矩阵                 | role/definition/grant 为 0/8/28 行 | 八个角色均有效；八个 Stage 1C permission definition 缺失，28 个应有授权均为 `expected=true, actual=false`。这是专用访问基线测试清理后的本地状态；未执行 apply，该状态阻断 rollout。                 |
| handover 三态                  | 0 行                               | 候选 `0`，所以 `LINKED/UNLINKED_REVIEW_REQUIRED/SOURCE_CONFLICT = 0/0/0`。                                                                                                                          |
| return 三态                    | 0 行                               | 候选 `0`，三态 `0/0/0`。                                                                                                                                                                            |
| open service case 三态         | 0 行                               | 候选 `0`，三态 `0/0/0`。                                                                                                                                                                            |
| blocking condition report 三态 | 0 行                               | 候选 `0`，三态 `0/0/0`。                                                                                                                                                                            |
| active blocker scopes          | 4 行                               | 四个 scope 的 restriction/vehicle 都为 `0/0`；每项 fingerprint 均为 `d41d8cd98f00b204e9800998ecf8427e`。                                                                                            |
| AVAILABLE 但 blocked/occupied  | 0 行                               | 无异常。                                                                                                                                                                                            |
| availability parity            | 3 行                               | `ALLOCATION 3/1/316ef77f5e1bbde689e82e5ee73f5dfc`；`DELIVERY 0/4/a8533dae0dd0411223402243d5cf320a`；`MARK_AVAILABLE 3/1/316ef77f5e1bbde689e82e5ee73f5dfc`（顺序为 available/blocked/fingerprint）。 |
| release tuple                  | 0 行                               | 无异常。                                                                                                                                                                                            |
| terminal timestamp             | 0 行                               | 无异常。                                                                                                                                                                                            |
| source/event integrity         | 0 行                               | 无 event-only、缺失/错误/多个合法配对、无关联限制 event、多个 material owner、跨工单或错误 material 引用。                                                                                          |
| event sequence                 | 0 行                               | 无异常。                                                                                                                                                                                            |
| evidence successor             | 0 行                               | 无异常。                                                                                                                                                                                            |
| DB-only catalog                | 0 行                               | 三个 trigger/function、十个 CHECK、七个 UNIQUE guard 和 active restriction partial index 在 `current_schema()` 中身份与语义均匹配。                                                                 |
| AuditLog 计数/fingerprint      | 1 行                               | work order/event/evidence/restriction/audit 均为 `0`；invalid/missing/duplicate/extra CREATE 与 orphan audit 五项均为 `0`；fact/audit fingerprint 均为 `d41d8cd98f00b204e9800998ecf8427e`。         |

本地 `availability parity` 的四辆未删除车辆没有 Stage 1C-B restriction/开放期间异常；拒绝数来自车辆
生命周期/价格等现有权威事实，未据此修改数据。四类历史来源候选均为零，所以不能把“无候选”解释为
已完成历史转换或已验证真实业务样本。

### 12.2 门禁原始结果摘要

| 门禁                                  | 原始退出码 | 脱敏原始结论                                                                                           |
| ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm prisma:migrate:status`          | `0`        | `93 migrations found`；`Database schema is up to date!`                                                |
| `pnpm prisma:validate`                | `0`        | `The schema at prisma\schema.prisma is valid`                                                          |
| `pnpm prisma:migrate:checksum:verify` | `2`        | local/applied 均 `93`，duplicate `0`，missing 两侧均 `0`，历史 mismatch **58**，`safe=false`。         |
| datasource→schema diff                | `2`        | 原始 Prisma diff 非空，包含既有 index/FK 名称、`updated_at` default、UUID default 等 drift；没有修复。 |

结论：虽然 status/validate 为 `0`，checksum 和 raw datasource→schema diff 都是 `2`，只读目录还显示一条
rolled-back 历史记录，权限矩阵有 28 行差异。因此该专用 Local 数据库明确
**rollout-ineligible**。本任务没有修改历史 migration、数据库 checksum、schema、权限、业务事实或
审计，也没有尝试让门禁“变绿”。
