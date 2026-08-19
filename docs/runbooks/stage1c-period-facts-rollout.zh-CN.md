# Stage 1C 车辆订阅期间与权属期间发布运行手册

## 1. 目的与边界

本手册用于发布 Stage 1C-A 的 `AssetOwner`、`VehicleOwnershipPeriod` 和
`VehicleSubscriptionPeriod` 事实模型，并安全执行车辆订阅期间的只读核对、受控补录和重放验收。
执行依据是 [Stage 1C 实施计划](../superpowers/plans/2026-08-18-stage1c-occupancy-ownership-facts-implementation-plan.md)。

本次增量只增加事实表、审计命令、只读投影和补录工具。下列行为不在范围内：

- 不接管或改写 `Vehicle.status`、`SubscriptionOrder.orderStatus`、`Lease.status`、
  `Contract.status`；这些现有运行时状态写入仍是权威来源，直到后续独立评审的双写、核对和切换完成。
- 不向订单、租约、合同、交付、还车或车辆状态的正常写路径增加双写。
- 不推断车辆权属，不因为存在 `PLATFORM` 类型的 `AssetOwner` 就把车辆归给平台。
- 不创建工单、限制、资金/成本台账、例外审批或财务聚合。
- 不修改历史 migration，不执行 `prisma migrate reset` 或 `prisma db push`。
- 本次文档编制和验证**没有执行，也不得执行 Production apply**。未来 Production apply
  必须是独立审批的发布动作。

## 2. 权限、seed 与会话刷新

稳定权限码和当前 seed 角色授权如下。`yes` 表示角色直接或通过 `ADMIN` 全量授权获得权限；
`no` 表示不得获得。当前没有资产事实菜单或按钮。

| 角色    | `asset_facts:view` | `asset_owner:manage` | `vehicle_period:manage` |
| ------- | ------------------ | -------------------- | ----------------------- |
| `ADMIN` | yes                | yes                  | yes                     |
| `AS`    | yes                | yes                  | yes                     |
| `OP`    | yes                | no                   | yes                     |
| `FI`    | yes                | no                   | no                      |
| `GM`    | yes                | no                   | no                      |
| `SA`    | no                 | no                   | no                      |
| `RC`    | no                 | no                   | no                      |
| `CS`    | no                 | no                   | no                      |

其中：

- `asset_facts:view`：读取车辆/订单事实历史和差异投影。
- `asset_owner:manage`：人工打开或关闭权属期间；仅 `ADMIN`、`AS`。
- `vehicle_period:manage`：人工修复订阅期间；仅 `ADMIN`、`AS`、`OP`。

每个环境在迁移和 API 部署后执行并留存输出：

```powershell
pnpm prisma:seed
pnpm prisma:seed:verify
```

seed 只校准权限定义和角色授权；它不会自动给车辆创建权属期间。seed 完成后，受影响用户必须
退出登录并重新登录，或通过既有认证流程重新签发 JWT/Cookie。旧 JWT 中的权限声明不会自动刷新；
不得用旧会话判断授权结果。复核时至少验证 `ADMIN`、`AS`、`OP`、`FI`、`GM` 和一个无授权角色。

所有管理型事实写入还必须通过认证和权限守卫，并携带唯一、非空的 `Idempotency-Key`；请求体
`source.key` 必须与该请求头一致。不得把操作者、IP 或 User-Agent 伪装进请求体或快照。

## 3. 期间语义与稳定来源键

### 3.1 半开区间

订阅期间和权属期间都使用半开区间 `[startedAt, endedAt)`：

- `startedAt` 包含在期间内，`endedAt` 不包含在期间内。
- `endedAt` 为 `NULL` 表示当前开放期间。
- 已关闭期间必须满足 `endedAt > startedAt`。
- `[10:00, 11:00)` 与 `[11:00, 12:00)` 相邻但不重叠。
- 同一车辆的订阅期间不得重叠；同一车辆的权属期间不得重叠。
- 同一车辆最多一个开放订阅期间，同一订单最多一个开放订阅期间；同一车辆最多一个开放权属期间。

PostgreSQL exclusion constraint、partial unique index 和 end-after-start check 是并发下的最终约束；
应用层预检不能替代数据库约束。

### 3.2 补录稳定键

订阅期间补录使用以下稳定来源身份：

```text
startSourceType = SUBSCRIPTION_ORDER
startSourceId   = <orderId>
startSourceKey  = stage1c-period-backfill:subscription-order:<orderId>
```

闭合期间的结束键为：

```text
endSourceType = SUBSCRIPTION_ORDER
endSourceId   = <orderId>
endSourceKey  = stage1c-period-backfill:subscription-order:<orderId>:end
```

相同完整来源元组和相同 payload 重放为 `UNCHANGED`。相同稳定键对应多个持久化行、来源元组变化，
或任一 payload 字段变化均为 `CONFLICT`，必须停止并人工核对；不得覆盖或 upsert 历史事实。

## 4. 补录信任规则

分类器只处理未删除且满足下列任一条件的订单：`ACTIVE`、`PENDING_RETURN`、`COMPLETED`、
`TERMINATED`、存在 `actualReturnAt`，或存在未删除且 `CONFIRMED` 的还车事实。

### 4.1 公共权威身份

每个候选必须同时满足：

- 订单引用的车辆存在且未删除；客户存在、未删除并与 `order.customerId` 一致。
- 订单引用合同时，合同唯一、未删除，且合同的订单和客户与订单一致。
- 车辆、订单、客户、合同及所选合同分段具有分类器要求的完整权威快照字段。
- 交付、租约和还车证据必须显式带有 `deletedAt` 活跃性标记；`deletedAt = NULL` 才是有效记录，
  明确软删除的记录被忽略，缺失或 `undefined` 的活跃性不能当作未删除。

### 4.2 开放期间：`ACTIVE` / `PENDING_RETURN`

开始时间只接受以下证据：

1. 未删除、状态为 `ACTIVE`、`RETURN_DUE` 或 `COMPLETED` 的 `Lease.activatedAt`；或
2. 未删除、状态为 `DELIVERED`，且订单、车辆、客户身份一致的 `VehicleDelivery.deliveredAt`。

如果两类证据同时存在，当前实现要求时间戳精确一致；多个有效交付时间也必须唯一。缺失、无效、
身份不一致或时间冲突均不得猜测。没有可信结束证据时，合格的 `ACTIVE` / `PENDING_RETURN`
订单产生开放期间。

### 4.3 已关闭期间

结束时间只接受 `SubscriptionOrder.actualReturnAt` 或未删除、状态为 `CONFIRMED` 且身份一致的
`VehicleReturn.returnedAt`。两者同时存在时必须精确一致；多个有效还车时间也必须唯一。
`COMPLETED` / `TERMINATED` 订单没有可信结束证据时不得生成开放期间。任何候选都必须满足
`startedAt < endedAt`。

### 4.4 合同分段

按开始时间的 UTC 日历日查找未取消分段，覆盖规则为 `startDate <= 开始日 <= endDate`。
只有一个身份一致且字段完整的分段覆盖开始日时才写入 `contractSegmentId`。零个或多个覆盖分段时
保持 `contractSegmentId = NULL` 并报告 `CONTRACT_SEGMENT_UNRESOLVED`；当前 apply 会因此被阻断，
必须先修复来源数据并重新 dry-run。

### 4.5 权属

本工具的 `ownership.proposedPeriods` 永远为空。只有数据库中显式存在的开放
`VehicleOwnershipPeriod` 才能证明当前权属；其他未删除车辆报告 `OWNERSHIP_UNKNOWN`。
`OWNERSHIP_UNKNOWN` 本身不阻断订阅期间 apply，但在任何后续资产价值、折旧、ROA/ROE、融资或
收益权聚合前，纳入范围的车辆必须完成第 10 节的人工权属准备和双人复核。

## 5. 报告分类与阻断规则

apply 的 `safeToApply` 仅在以下条件全部满足时为 `true`：每个订阅期间处置仅为 `CREATE` 或
`UNCHANGED`，且 `ambiguities`、`overlaps`、`segmentOmissions`、`invariantViolations` 全部为空。
任何不认识的 disposition 也按不安全处理。

### 5.1 `ambiguities`：全部阻断

| 代码                                    | 含义/处置                                          |
| --------------------------------------- | -------------------------------------------------- |
| `MISSING_VEHICLE`                       | 车辆缺失或已删除；修复订单引用或权威车辆资料。     |
| `MISSING_CUSTOMER`                      | 客户缺失、已删除或订单/客户身份不一致。            |
| `MISSING_CONTRACT`                      | 订单引用的合同不存在或已删除。                     |
| `SUBSCRIPTION_AGGREGATE_MISMATCH`       | 订单、合同、客户或覆盖分段不属于同一订阅聚合。     |
| `INCOMPLETE_AUTHORITY_SNAPSHOT`         | 权威车辆、订单、客户、合同或唯一分段缺少必需字段。 |
| `LEASE_LIVENESS_UNKNOWN`                | 租约缺少明确 `deletedAt` 活跃性标记。              |
| `ACTIVATION_EVIDENCE_IDENTITY_MISMATCH` | 租约/交付证据的订单、车辆或客户身份不一致。        |
| `INVALID_LEASE_ACTIVATION_TIMESTAMP`    | 可信状态租约的 `activatedAt` 不是有效时间。        |
| `DELIVERY_EVIDENCE_LIVENESS_UNKNOWN`    | 交付证据缺少明确 `deletedAt` 活跃性标记。          |
| `INVALID_DELIVERY_TIMESTAMP`            | 已交付证据的 `deliveredAt` 不是有效时间。          |
| `CONFLICTING_START_TIMESTAMPS`          | 租约与交付，或多个交付证据的开始时间不一致。       |
| `MISSING_ACTIVATION_EVIDENCE`           | 没有可信租约激活或确认交付证据。                   |
| `INVALID_RETURN_TIMESTAMP`              | 订单或确认还车的结束时间无效。                     |
| `RETURN_EVIDENCE_LIVENESS_UNKNOWN`      | 还车证据缺少明确 `deletedAt` 活跃性标记。          |
| `RETURN_EVIDENCE_IDENTITY_MISMATCH`     | 还车证据的订单、车辆或客户身份不一致。             |
| `CONFLICTING_RETURN_TIMESTAMPS`         | 订单与还车，或多个还车证据的结束时间不一致。       |
| `MISSING_RETURN_EVIDENCE`               | `COMPLETED` / `TERMINATED` 订单缺少可信结束证据。  |
| `INVALID_PERIOD_RANGE`                  | 开始时间晚于或等于结束时间。                       |

每个歧义必须回到权威来源取证；禁止选择“看起来合理”的时间、车辆、客户、合同或分段。

### 5.2 `CONFLICT`：全部阻断

- 完整来源元组只匹配一行但 payload 有 `differingFields`：同键事实漂移；逐字段核对原始证据。
- `MULTIPLE_PERSISTED_SOURCE_ROWS`：同一稳定键匹配多个持久化行。
- `PERSISTED_SOURCE_IDENTITY_CONFLICT`：稳定键存在，但来源 type/id/key 元组与候选不一致；该问题也会
  进入 `invariantViolations`。

不得通过修改来源键、覆盖、upsert、删除旧行或直接更新快照消除冲突。

### 5.3 `overlaps` / `invariantViolations`：全部阻断

- `SUBSCRIPTION_PERIOD_OVERLAP`：候选之间为 `PROPOSED` 重叠，或候选与既有事实为 `PERSISTED`
  重叠；冲突候选从 `CREATE` 中省略。
- `ONE_ORDER_MULTIPLE_CURRENT_PERIODS`：同一订单存在多个当前开放期间。
- `PERSISTED_SOURCE_IDENTITY_CONFLICT`：持久化来源身份不唯一或不一致。

数据库还会独立拒绝同车重叠、同车多个开放期间、同订单多个开放期间和非法时间范围。

### 5.4 `segmentOmissions` 与权属报告

- `CONTRACT_SEGMENT_UNRESOLVED`：零个或多个分段覆盖开始日；`contractSegmentId` 被省略，apply 阻断。
- `OWNERSHIP_UNKNOWN`：没有显式开放权属期间；不生成权属候选，也不阻断订阅期间 apply。

## 6. CLI 契约与非零退出

必须从仓库根目录使用现有 root scripts：

```powershell
pnpm stage1c:periods:dry-run -- --output <report-path>
pnpm stage1c:periods:apply -- --output <report-path>
```

参数规则：必须且只能选择 `--dry-run` 或 `--apply`；`--output <path>` 或
`--output=<path>` 最多一次且不得为空。root scripts 已固定模式，调用时只追加 `--output`。

apply 的确认值必须**精确**为：

```text
STAGE1C_PERIOD_BACKFILL_APPLY=1
```

`true`、`"1 "`、空值或缺失都拒绝。PowerShell 受控调用方式：

```powershell
$env:STAGE1C_PERIOD_BACKFILL_APPLY = '1'
try {
  pnpm stage1c:periods:apply -- --output $applyReport
} finally {
  Remove-Item Env:STAGE1C_PERIOD_BACKFILL_APPLY -ErrorAction SilentlyContinue
}
```

退出行为：

- dry-run 无写入；安全集合退出 `0`，任何阻断项退出 `1`，但仍向 stdout 和 `--output` 写完整报告。
- apply 无确认值时退出 `1`；不得把补录脚本改成默认 apply。
- apply 对不安全集合退出 `1`、报告 `applied.blocked = true`，且插入事实/审计均为 `0`。
- 安全 apply 只插入 `CREATE`，跳过 `UNCHANGED`；事实和每条对应 `AuditLog` 在同一事务提交。
- 数据库、锁、参数、输出流或清理失败时，公开 stderr 只输出
  `{"error":"STAGE1C_PERIOD_BACKFILL_FAILED"}` 并退出 `1`；不得因此认定“没有部分状态”，必须先做
  第 9 节只读核对。
- CLI 不输出 `DATABASE_URL`、用户名、密码或原始连接异常。操作人员也不得用 shell tracing、
  `Write-Output $env:DATABASE_URL` 或进程参数记录连接串。

## 7. 锁竞争、维护窗口与重试

apply 在单个 `REPEATABLE READ` 事务内先取得
`vehicle_subscription_period` 的 `SHARE ROW EXCLUSIVE` 锁，再用一个 `SHARE MODE NOWAIT` 语句锁定
以下来源表，随后取得事务级 advisory lock 并读取快照：

```text
asset_owner
contract
customer
lease
subscription_contract_segment
subscription_order
vehicle
vehicle_delivery
vehicle_ownership_period
vehicle_return
```

来源表若正被正常业务写事务占用，`NOWAIT` 会立即失败；这是预期的 fail-closed 行为。apply 前必须
进入维护/静默窗口：暂停会写上述表的 API 流量、worker、定时任务和管理修复入口，等待在途事务结束，
但继续保留只读监控。不要依赖“低流量时碰运气”。

发生竞争或通用失败时：

1. 停止自动重试，不做紧密循环；记录时间、目标 Git SHA、退出码和脱敏错误引用。
2. 确认维护/静默措施和在途事务状态；不得终止不明业务事务。
3. 运行第 9 节只读 SQL，确认事实和审计计数是否变化。
4. 重新执行 dry-run，生成新的报告和 SHA-256；来源快照变化时，原审批失效。
5. 由复核人重新审核报告并单独授权后，才可再次设置确认变量执行 apply。

## 8. Local、Staging 与未来 Production 顺序

三个环境都必须按同一顺序逐级完成；不得跳过 Local/Staging 直接进入 Production。每个环境使用独立
报告路径和审批记录，不复制前一环境的报告充当本环境证据。

### 8.1 每个环境的固定步骤

1. **备份**：完成目标 PostgreSQL 一致性备份，记录备份 ID、时间、数据库版本、Git SHA、镜像 digest
   和恢复验证证据。未验证可恢复的备份不算完成。
2. **迁移状态**：在注入目标环境 `DATABASE_URL` 后执行：

   ```powershell
   pnpm prisma:migrate:status
   pnpm prisma:validate
   ```

   只允许预期的 Stage 1C migration 待应用；出现 failed migration、drift 或意外待应用项立即停止。

3. **部署 migration 与应用**：

   ```powershell
   pnpm prisma:migrate:deploy
   pnpm prisma:migrate:status
   pnpm prisma:validate
   pnpm prisma:generate
   ```

   部署与该 Git SHA 对应的 API 镜像，完成 readiness/health 验证；随后按第 2 节执行 seed、seed verify
   和强制重新登录/JWT 刷新。

4. **dry-run**：进入第 7 节维护/静默准备，执行：

   ```powershell
   pnpm stage1c:periods:dry-run -- --output $dryRunReport
   ```

   dry-run 必须发生在目标 migration 和目标代码已部署后；记录退出码、原始报告 SHA-256 和计数。

5. **脱敏报告复核**：执行人与复核人分别确认 `safeToApply = true`，所有阻断数组为空，处置仅有
   `CREATE` / `UNCHANGED`，并核对 source/reconciliation counters。按第 11 节脱敏；原始报告只进
   受控证据存储。
6. **独立 apply 授权**：把环境、Git SHA、数据库、dry-run 报告 SHA-256、`CREATE` / `UNCHANGED`
   数量、事实/审计基线和维护窗口写入变更单。dry-run 审核不自动授权 apply；必须取得单独批准。
7. **apply**：仅在批准窗口内精确设置 `STAGE1C_PERIOD_BACKFILL_APPLY=1`，按第 6 节 PowerShell
   模板执行并保存 `$applyReport`。退出非零立即停止。
8. **重放**：不改变来源数据，使用新的 `$replayReport` 再执行一次已授权 apply。预期
   `applied.inserted = 0`，候选均为 `UNCHANGED`，事实和 `asset_facts` / `CREATE` 审计计数不再增加。
9. **对账**：再次 dry-run，并执行第 9 节全部只读 SQL。保存计数、异常零行证明、报告 checksum 和
   双人签字后，才退出维护窗口。

### 8.2 环境门禁

- **Local**：只连接专用本地数据库；允许使用可丢弃测试夹具，但清理只能针对明确夹具并记录。
  禁止把本地报告当作 Staging/Production 数据证据。
- **Staging**：使用生产同构备份/恢复与部署程序；任何 ambiguity、conflict、overlap、segment
  omission 或 invariant violation 都必须先在来源系统中纠正，再从 dry-run 重新开始。
- **未来 Production**：重复完整步骤，并由发布负责人、数据库负责人和业务数据负责人单独批准。
  本次执行没有运行且不得运行 Production apply；Production 报告无论原始或脱敏都不得提交 Git。

## 9. 只读 SQL 验收

以下 SQL 与最终 PostgreSQL 表/列名一致。每段都只能在只读会话或只读事务中执行：

```sql
BEGIN TRANSACTION READ ONLY;
-- 在此执行本节查询。
COMMIT;
```

### 9.1 订阅期间重叠：预期零行

```sql
SELECT
  left_period.vehicle_id,
  left_period.id AS left_period_id,
  right_period.id AS right_period_id
FROM vehicle_subscription_period AS left_period
JOIN vehicle_subscription_period AS right_period
  ON left_period.vehicle_id = right_period.vehicle_id
 AND left_period.id < right_period.id
 AND tstzrange(
       left_period.started_at,
       COALESCE(left_period.ended_at, 'infinity'::timestamptz),
       '[)'
     ) && tstzrange(
       right_period.started_at,
       COALESCE(right_period.ended_at, 'infinity'::timestamptz),
       '[)'
     )
ORDER BY left_period.vehicle_id, left_period.started_at, right_period.started_at;
```

### 9.2 权属期间重叠：预期零行

```sql
SELECT
  left_period.vehicle_id,
  left_period.id AS left_period_id,
  right_period.id AS right_period_id
FROM vehicle_ownership_period AS left_period
JOIN vehicle_ownership_period AS right_period
  ON left_period.vehicle_id = right_period.vehicle_id
 AND left_period.id < right_period.id
 AND tstzrange(
       left_period.started_at,
       COALESCE(left_period.ended_at, 'infinity'::timestamptz),
       '[)'
     ) && tstzrange(
       right_period.started_at,
       COALESCE(right_period.ended_at, 'infinity'::timestamptz),
       '[)'
     )
ORDER BY left_period.vehicle_id, left_period.started_at, right_period.started_at;
```

### 9.3 同一订单多个开放期间：预期零行

```sql
SELECT order_id, COUNT(*) AS open_period_count
FROM vehicle_subscription_period
WHERE ended_at IS NULL
GROUP BY order_id
HAVING COUNT(*) > 1
ORDER BY order_id;
```

### 9.4 活跃/待还订单与开放期间计数

```sql
SELECT
  COUNT(*) FILTER (WHERE order_status = 'ACTIVE') AS active_orders,
  COUNT(*) FILTER (WHERE order_status = 'PENDING_RETURN') AS pending_return_orders,
  COUNT(open_period.id) AS matching_open_periods,
  COUNT(*) FILTER (WHERE open_period.id IS NULL) AS orders_without_open_period
FROM subscription_order AS source_order
LEFT JOIN vehicle_subscription_period AS open_period
  ON open_period.order_id = source_order.id
 AND open_period.ended_at IS NULL
WHERE source_order.deleted_at IS NULL
  AND source_order.order_status IN ('ACTIVE', 'PENDING_RETURN');
```

`orders_without_open_period` 在最终可信数据集上应为 `0`；如非零，必须与 dry-run 的 ambiguity 或
segment omission 逐项对应。不能仅比较总数后忽略身份差异。

### 9.5 `LEASED` 车辆与开放期间差异：最终预期零行

```sql
WITH leased_vehicle AS (
  SELECT id AS vehicle_id
  FROM vehicle
  WHERE deleted_at IS NULL
    AND status = 'LEASED'
),
open_period AS (
  SELECT id AS period_id, vehicle_id, order_id
  FROM vehicle_subscription_period
  WHERE ended_at IS NULL
)
SELECT
  COALESCE(leased_vehicle.vehicle_id, open_period.vehicle_id) AS vehicle_id,
  open_period.order_id,
  open_period.period_id,
  CASE
    WHEN leased_vehicle.vehicle_id IS NULL THEN 'OPEN_PERIOD_BUT_NOT_LEASED'
    WHEN open_period.vehicle_id IS NULL THEN 'LEASED_WITHOUT_OPEN_PERIOD'
  END AS discrepancy
FROM leased_vehicle
FULL OUTER JOIN open_period USING (vehicle_id)
WHERE leased_vehicle.vehicle_id IS NULL
   OR open_period.vehicle_id IS NULL
ORDER BY vehicle_id, order_id;
```

Stage 1C 尚未接管 `Vehicle.status`，所以此查询发现的是需要调查的投影差异，不授权自动修改任一侧。

### 9.6 来源身份冲突：预期零行

```sql
SELECT
  period.id AS period_id,
  period.order_id,
  period.start_source_type,
  period.start_source_id,
  period.start_source_key
FROM vehicle_subscription_period AS period
WHERE period.start_source_key LIKE 'stage1c-period-backfill:subscription-order:%'
  AND (
    period.start_source_type <> 'SUBSCRIPTION_ORDER'
    OR period.start_source_id <> period.order_id
    OR period.start_source_key <>
      ('stage1c-period-backfill:subscription-order:' || period.order_id::text)
  )
ORDER BY period.start_source_key, period.id;
```

### 9.7 订单/期间聚合对账冲突：预期零行

```sql
SELECT
  period.id AS period_id,
  period.order_id,
  period.start_source_key,
  CASE
    WHEN source_order.id IS NULL THEN 'ORDER_MISSING'
    WHEN source_order.deleted_at IS NOT NULL THEN 'ORDER_DELETED'
    WHEN period.vehicle_id IS DISTINCT FROM source_order.vehicle_id THEN 'VEHICLE_MISMATCH'
    WHEN period.customer_id IS DISTINCT FROM source_order.customer_id THEN 'CUSTOMER_MISMATCH'
    WHEN period.contract_id IS DISTINCT FROM source_order.contract_id THEN 'CONTRACT_MISMATCH'
  END AS conflict
FROM vehicle_subscription_period AS period
LEFT JOIN subscription_order AS source_order ON source_order.id = period.order_id
WHERE source_order.id IS NULL
   OR source_order.deleted_at IS NOT NULL
   OR period.vehicle_id IS DISTINCT FROM source_order.vehicle_id
   OR period.customer_id IS DISTINCT FROM source_order.customer_id
   OR period.contract_id IS DISTINCT FROM source_order.contract_id
ORDER BY period.start_source_key, period.id;
```

### 9.8 未解析合同分段：必须与已批准报告一致

```sql
SELECT start_source_key, order_id, started_at
FROM vehicle_subscription_period
WHERE start_source_type = 'SUBSCRIPTION_ORDER'
  AND contract_segment_id IS NULL
ORDER BY start_source_key;
```

补录 apply 的安全集合不允许新建此类行；已有人工事实若返回，必须有独立审批和证据引用。

### 9.9 当前权属未知：财务聚合前预期零行

```sql
SELECT vehicle.id AS vehicle_id, vehicle.vehicle_no
FROM vehicle
LEFT JOIN vehicle_ownership_period AS current_ownership
  ON current_ownership.vehicle_id = vehicle.id
 AND current_ownership.ended_at IS NULL
WHERE vehicle.deleted_at IS NULL
  AND current_ownership.id IS NULL
ORDER BY vehicle.id;
```

结果允许在本增量的订阅期间 apply 后暂时存在，但纳入后续财务聚合前必须处理到零或从财务范围中
有审计地排除。SQL 输出不需要也不得添加客户姓名、手机号、VIN 或车牌。

## 10. 权属人工准备

后续财务能力开始前，由资产运营准备、财务/法务复核以下资料；本补录脚本不完成这些动作：

1. 为每辆纳入范围的未删除车辆确定法律权属主体，核对 `AssetOwner` 的稳定 `ownerNo`、法定名称、
   登记标识、类型和状态；缺少 owner 主数据时先走独立、可审计的 owner onboarding 流程。
2. 收集购车发票、登记证、采购/转让/处置协议等来源证据，确定当前权属的精确 `startedAt` 和
   `startReason`；不以车辆状态、采购价、所在车队或默认平台身份代替权属证据。
3. 为每个权属期间定义稳定来源 type/id/key 和不可变证据快照，指定确认人、确认时间和审批单号。
4. 使用具备 `asset_owner:manage` 的管理命令逐车录入；每次 mutation 使用唯一
   `Idempotency-Key`，先在 Staging 验证精确重放。
5. 运行第 9.2、9.9 节 SQL，证明无同车权属重叠且财务范围内没有未知当前权属；由第二人复核后
   冻结本次财务聚合的数据截止点。

任何不能证明的车辆继续保持 `OWNERSHIP_UNKNOWN`，不得为了让计数归零而批量分配平台 owner。

## 11. 证据、checksum 与脱敏

每个环境至少保留：

- 变更单、执行人/复核人/批准人、维护窗口和目标环境；
- Git SHA、不可变镜像 digest、Node/pnpm/Prisma/PostgreSQL 版本；
- 备份 ID、备份 SHA-256（如适用）和恢复验证引用；
- migration status/deploy/status、schema validation、seed 和 seed verify 输出；
- apply 前事实数、`asset_facts` / `vehicle_subscription_period` `CREATE` 审计数；
- dry-run、apply、replay、最终 dry-run 的退出码、原始 JSON SHA-256、文件字节数和关键 counters；
- 第 9 节 SQL 的零行证明或逐项异常处置引用；
- apply 后插入数、重放 `inserted = 0`、事实/审计计数不再增加的证明；
- 发生锁竞争时的时间线、静默措施、新 dry-run checksum 和重新授权记录；
- 最终双人复核和退出维护窗口的签字。

原始报告含快照，可能包含客户姓名/编号、车辆 VIN/车牌/编号、订单/合同编号。原始报告只能保存到
仓库外的受控加密证据存储；CLI 同时写 stdout，因此控制台日志也必须按同等级敏感证据保护，且不得
进入普通 CI 日志。禁止把报告提交 Git。对复核摘要做最小化脱敏：

- 删除凭据、`DATABASE_URL`、用户名、密码、token、Cookie、请求头和原始连接错误；
- 删除不必要的客户姓名、手机号、证件号及其他客户 PII；
- 删除不必要的 VIN 和车牌；需要跨报告关联时使用受控 HMAC/掩码标识，不使用可逆明文映射；
- 只保留审批所需的代码、计数、掩码 ID、时间范围、checksum 和审计引用；
- 对原始文件和脱敏副本分别计算 SHA-256，复核时绑定原始文件 checksum。

可在 PowerShell 中对仓库外文件计算 checksum，不输出文件内容：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath $dryRunReport
Get-FileHash -Algorithm SHA256 -LiteralPath $applyReport
Get-FileHash -Algorithm SHA256 -LiteralPath $replayReport
```

Production 报告即使已经脱敏也不得提交 Git；只在受控变更/证据系统中保存引用和权限受限附件。

## 12. 回滚与前向纠正

Stage 1C 数据库回滚只允许**前向、可审计纠正**：

- 可以回退到兼容的上一版应用镜像并停止新的管理写入，但保留 additive migration、事实和审计。
- 错误开放事实使用独立审批的管理命令按可信证据关闭，并以新稳定键创建纠正/补偿事实；所有动作
  必须留下 `AuditLog`。若数据库重叠约束使补偿无法表达，先发布独立评审的 additive 修复能力或
  migration，再执行纠正。
- 已关闭错误历史不得直接 `UPDATE` 或 `DELETE`；通过新的可审计纠正/补偿事实表达。
- 不删除期间历史或审计，不把 `endedAt` 改回 `NULL`，不重置数据库，不执行 `db push`，不修改
  已应用的历史 migration，也不通过改旧来源键让重放“通过”。
- 纠正后重新执行 dry-run、重放和第 9 节全部对账，保存新旧证据 checksum 与审批链。

现有运行时状态仍是本增量的业务权威投影；不得为了“回滚事实”而直接改写订单、租约、合同或车辆
历史。发现事实与运行时状态差异时，冻结后续财务使用，保留现场，并分别核对权威来源与事实审计链。
