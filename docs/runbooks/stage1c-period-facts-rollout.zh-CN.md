# Stage 1C 车辆订阅期间与权属期间发布运行手册

## 1. 目的与边界

本手册用于发布 Stage 1C-A 的 `AssetOwner`、`VehicleOwnershipPeriod` 和
`VehicleSubscriptionPeriod` 事实模型，并安全执行车辆订阅期间的只读核对、受控补录和重放验收。
执行依据是 [Stage 1C 实施计划](../superpowers/plans/2026-08-18-stage1c-occupancy-ownership-facts-implementation-plan.md)。

本次增量只增加事实表、审计命令、只读投影、专用访问/平台 owner 基线同步器和订阅期间补录工具。
下列行为不在范围内：

- 不接管或改写 `Vehicle.status`、`SubscriptionOrder.orderStatus`、`Lease.status`、
  `Contract.status`；这些现有运行时状态写入仍是权威来源，直到后续独立评审的双写、核对和切换完成。
- 不向订单、租约、合同、交付、还车或车辆状态的正常写路径增加双写。
- 不推断车辆权属，不因为存在 `PLATFORM` 类型的 `AssetOwner` 就把车辆归给平台。
- 不创建工单、限制、资金/成本台账、例外审批或财务聚合。
- 不修改历史 migration，不执行 `prisma migrate reset` 或 `prisma db push`。
- 本次文档编制和验证**没有执行，也不得执行 Production apply**。未来 Production apply
  必须是独立审批的发布动作。

## 2. 权限、基线同步与会话刷新

稳定权限码和精确角色授权如下。`yes` 表示必须存在有效授权；`no` 表示这三个 Stage 1C 权限不得
授权给该角色。当前没有资产事实菜单或按钮。

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

所有部署环境只使用 Stage 1C 专用同步器。先 dry-run；它在单个 `REPEATABLE READ` 事务内只读，
不写权限、角色授权、owner、权属期间或审计：

```powershell
$accessDryRunReport = '<仓库外受控路径>/stage1c-access-baseline-dry-run.json'
pnpm stage1c:access-baseline:dry-run -- --output $accessDryRunReport
$accessDryRunExit = $LASTEXITCODE
if ($accessDryRunExit -ne 0) {
  throw "Stage 1C access baseline dry-run failed with exit code $accessDryRunExit"
}
```

同步器只精确收敛上述三个权限在八个角色上的授权；其他权限和授权不受影响。以下任一情况使
dry-run/apply 非零并在任何写入前停止：八个角色缺失、非 `ACTIVE` 或已软删除；`ownerNo =
PLATFORM` 的既有 owner 名称/类型与稳定平台主体冲突；或存在另一个 `PLATFORM + ACTIVE` owner。

同步器会创建或验证且仅保留一个稳定的 `ownerNo = PLATFORM`、`name = 平台资产主体`、
`ownerType = PLATFORM`、`status = ACTIVE` 平台 owner。它只允许把身份一致的该 owner 从非活跃状态
恢复为 `ACTIVE`；保留既有 `legalName` 和 `registrationIdentifier`，绝不猜测、覆盖法律身份或登记标识。
它**不分配任何车辆，也不创建 `VehicleOwnershipPeriod`**。

dry-run 输出经双人复核且单独批准后，apply 必须使用以下精确专用确认值。必须捕获退出码，并在
`finally` 中清理变量；非零时抛错，因此后续步骤不会执行：

```powershell
$accessApplyReport = '<仓库外受控路径>/stage1c-access-baseline-apply.json'
$accessApplyExit = 1
$env:STAGE1C_ACCESS_BASELINE_APPLY = 'SYNC_STAGE1C_ACCESS_BASELINE'
try {
  pnpm stage1c:access-baseline:apply -- --output $accessApplyReport
  $accessApplyExit = $LASTEXITCODE
} finally {
  Remove-Item Env:STAGE1C_ACCESS_BASELINE_APPLY -ErrorAction SilentlyContinue
}
if ($accessApplyExit -ne 0) {
  throw "Stage 1C access baseline apply failed with exit code $accessApplyExit"
}
```

`1`、`true`、大小写不同、前后空格、空值或缺失都拒绝。apply 后以同一审批范围重放一次；预期
`permissionsChanged = grantsChanged = ownerChanged = auditsCreated = 0`。然后在只读事务中执行以下
精确正/负授权矩阵检查；所有查询都必须返回零行（owner 查询必须恰好返回一行）：

```sql
WITH role_code(role_code) AS (
  VALUES ('ADMIN'), ('AS'), ('OP'), ('FI'), ('GM'), ('SA'), ('RC'), ('CS')
)
SELECT expected.role_code
FROM role_code AS expected
LEFT JOIN "role" AS actual ON actual.code::text = expected.role_code
WHERE actual.id IS NULL
   OR actual.status::text <> 'ACTIVE'
   OR actual.deleted_at IS NOT NULL
ORDER BY expected.role_code;

WITH permission_definition(code, name, module, action) AS (
  VALUES
    ('asset_facts:view', '查看车辆事实台账', 'asset_facts', 'view'),
    ('asset_owner:manage', '管理车辆权属期间', 'asset_facts', 'owner_manage'),
    ('vehicle_period:manage', '修复车辆订阅期间', 'asset_facts', 'period_manage')
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
  VALUES ('ADMIN'), ('AS'), ('OP'), ('FI'), ('GM'), ('SA'), ('RC'), ('CS')
), permission_code(permission_code) AS (
  VALUES ('asset_facts:view'), ('asset_owner:manage'), ('vehicle_period:manage')
), expected_grant(role_code, permission_code) AS (
  VALUES
    ('ADMIN', 'asset_facts:view'),
    ('ADMIN', 'asset_owner:manage'),
    ('ADMIN', 'vehicle_period:manage'),
    ('AS', 'asset_facts:view'),
    ('AS', 'asset_owner:manage'),
    ('AS', 'vehicle_period:manage'),
    ('OP', 'asset_facts:view'),
    ('OP', 'vehicle_period:manage'),
    ('FI', 'asset_facts:view'),
    ('GM', 'asset_facts:view')
), actual_grant AS (
  SELECT "role".code::text AS role_code, permission.code AS permission_code
  FROM role_permission
  JOIN "role" ON "role".id = role_permission.role_id
  JOIN permission ON permission.id = role_permission.permission_id
  WHERE role_permission.deleted_at IS NULL
    AND "role".code::text IN ('ADMIN', 'AS', 'OP', 'FI', 'GM', 'SA', 'RC', 'CS')
    AND permission.code IN (
      'asset_facts:view',
      'asset_owner:manage',
      'vehicle_period:manage'
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

SELECT owner_no, name, owner_type, status
FROM asset_owner
WHERE owner_no = 'PLATFORM'
   OR (owner_type = 'PLATFORM' AND status = 'ACTIVE')
ORDER BY owner_no;
```

最后一个查询必须恰好只有 `PLATFORM | 平台资产主体 | PLATFORM | ACTIVE`；多一行、少一行或字段
不同都停止。apply 前后还必须比较第 9.0 节的权属期间计数，证明零增长。

`pnpm prisma:seed` 会创建/恢复默认用户（存在默认密码回退）、清理并写入演示流程数据，还会写产品、
客户、车辆和模板；`pnpm prisma:seed:verify` 验证的是演示基线。两者**禁止在 Staging 或 Production
执行**，不得描述为“只校准权限”。仅可丢弃的 Local 首次演示数据引导允许执行 generic seed；它会
调用同一专用同步逻辑以兑现平台 owner 基线，但仍不会创建权属期间或分配车辆。

同步完成后，受影响用户必须退出登录并重新登录，或通过既有认证流程重新签发 JWT/Cookie。旧 JWT
中的权限声明不会自动刷新；不得用旧会话判断授权结果。复核必须包含全部八个角色，尤其验证
`SA`、`RC`、`CS` 的三个权限均为禁止授权。

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

在本节任何期间命令之前，先为**当前环境**定义三个仓库外报告路径。以下是可直接执行的 Local
示例；Staging/Production 必须把 `$stage1cEnvironment` 和变更单目录改成该环境获批的独立值，且
证据根目录必须是仓库外的受控存储。路径检查失败时停止，不得退回仓库内保存：

```powershell
$stage1cEnvironment = 'Local'
$stage1cReportDirectory = "D:\Stage1C-Controlled-Evidence\$stage1cEnvironment\CHG-20260820-001"
$repositoryRoot = [System.IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\') + '\'
$resolvedReportDirectory = [System.IO.Path]::GetFullPath($stage1cReportDirectory).TrimEnd('\') + '\'
if ($resolvedReportDirectory.StartsWith($repositoryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Stage 1C reports must be stored outside the repository.'
}
New-Item -ItemType Directory -Force -Path $stage1cReportDirectory | Out-Null
$dryRunReport = Join-Path $stage1cReportDirectory 'stage1c-period-dry-run.json'
$applyReport = Join-Path $stage1cReportDirectory 'stage1c-period-apply.json'
$replayReport = Join-Path $stage1cReportDirectory 'stage1c-period-replay.json'
```

三个变量在本环境整次执行中保持不变；不得让不同环境共用目录或覆盖彼此报告。

```powershell
pnpm stage1c:periods:dry-run -- --output $dryRunReport
pnpm stage1c:periods:apply -- --output $applyReport
```

参数规则：必须且只能选择 `--dry-run` 或 `--apply`；`--output <path>` 或
`--output=<path>` 最多一次且不得为空。root scripts 已固定模式，调用时只追加 `--output`。

apply 的确认值必须**精确**为：

```text
STAGE1C_PERIOD_BACKFILL_APPLY=1
```

`true`、`"1 "`、空值或缺失都拒绝。PowerShell 受控调用方式：

```powershell
$periodApplyExit = 1
$env:STAGE1C_PERIOD_BACKFILL_APPLY = '1'
try {
  pnpm stage1c:periods:apply -- --output $applyReport
  $periodApplyExit = $LASTEXITCODE
} finally {
  Remove-Item Env:STAGE1C_PERIOD_BACKFILL_APPLY -ErrorAction SilentlyContinue
}
if ($periodApplyExit -ne 0) {
  throw "Stage 1C period apply failed with exit code $periodApplyExit"
}
```

不得把 `pnpm` 的非零退出吞掉。变量清理完成后仍必须检查保存的 `$periodApplyExit`；非零即中止，
不得继续重放、对账或退出维护窗口。

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

Stage 1C 管理型事实命令对每个车辆、订单、客户、合同、合同分段或 owner 权威行使用
`FOR SHARE NOWAIT`。权威行正被交付、还车、里程或其他正常业务事务更新时，命令立即返回 HTTP
`409`，稳定代码为 `ASSET_FACT_AUTHORITY_BUSY`；响应只包含稳定代码和脱敏消息，不返回 SQLSTATE、
连接串或原始数据库异常。该冲突不代表正常业务事务失败，也不得终止或绕过正常写入者。

收到该冲突后不要紧密自动重试：等待当前业务事务结束，重新读取车辆/订单事实投影和所选权威聚合，
核对是否已有事实或权威字段变化。若没有事实且原 authority/source/payload 全部不变，可使用同一个
`Idempotency-Key` 重试原命令；authority 已变化、所选合同分段已取消或不再覆盖开始时间时必须停止并
重新复核，不得为了让重放通过而沿用旧快照、改旧事实或绕过权威检查。业务意图经独立复核后确实变化
时，才使用新的稳定来源身份提交新的命令。

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
2. **迁移清单**：在只对当前进程注入目标环境 `DATABASE_URL` 后执行：

   ```powershell
   pnpm prisma:migrate:status
   pnpm prisma:validate
   ```

   这两个命令只用于确认迁移清单/失败状态和本地 Prisma schema 语法；它们**不能证明数据库无 schema
   drift，也不能证明已应用 migration 文件 checksum 相等**。只允许经变更单列明的 Stage 1C migration
   待应用；failed migration 或意外待应用项立即停止。

3. **部署 migration、执行真实 drift/checksum 门禁并部署应用**：

   ```powershell
   pnpm prisma:migrate:deploy
   $migrateDeployExit = $LASTEXITCODE
   if ($migrateDeployExit -ne 0) {
     throw "Migration deploy failed with exit code $migrateDeployExit"
   }

   pnpm prisma:migrate:status
   $migrateStatusExit = $LASTEXITCODE
   if ($migrateStatusExit -ne 0) {
     throw "Migration status failed with exit code $migrateStatusExit"
   }

   pnpm prisma:validate
   $schemaValidateExit = $LASTEXITCODE
   if ($schemaValidateExit -ne 0) {
     throw "Schema validation failed with exit code $schemaValidateExit"
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

   pnpm prisma:migrate:checksum:verify
   $migrationChecksumExit = $LASTEXITCODE
   if ($migrationChecksumExit -ne 0) {
     throw "Migration checksum gate failed with exit code $migrationChecksumExit"
   }

   pnpm prisma:generate
   $prismaGenerateExit = $LASTEXITCODE
   if ($prismaGenerateExit -ne 0) {
     throw "Prisma generate failed with exit code $prismaGenerateExit"
   }
   ```

   必须在 `apps/api` 中直接运行 `migrate diff` 并保存其原始退出码；不要套用会把子命令 `2` 归一为
   `1` 的 workspace filter。原始退出码 `0` 表示 datasource 到当前 schema 没有差异，`2` 表示检测到
   非空 drift，`1` 表示命令错误；这里只有 `0` 可继续。不要使用需要未批准 shadow database 的反向
   diff。
   `prisma:migrate:checksum:verify` 直接读取每个本地 `migration.sql` 的原始字节并计算 SHA-256，在
   `BEGIN TRANSACTION READ ONLY` 中与成功且未回滚的 `_prisma_migrations.checksum` 比较；缺失、多余、
   重复或 checksum 不同都会输出名称清单并以 `2` 停止。禁止通过修改历史 migration、覆盖数据库
   checksum 或“接受现状”让门禁变绿。

   2026-08-20 本任务对专用本地数据库的只读验证中，`migrate status` 显示 92 个 migration 且 up to
   date，但 datasource→schema diff 退出 `2`，原始字节 checksum 比较发现 **58** 个历史 mismatch，
   其中包含 Task 2 报告的两个已知文件。Task 2 报告只记录两个与当前 58 个结果不一致；本任务没有
   归一化或修复任何一项。该数据库因此不是发布合格环境，只能用于与 migration 发布相互独立且可
   精确恢复夹具的访问基线测试。

   所有门禁均为 `0` 后，才部署与该 Git SHA 对应的 API 镜像并完成 readiness/health 验证；随后按
   第 2 节执行专用访问基线 dry-run、独立授权 apply、重放、SQL 正/负矩阵验证和强制重新登录/JWT
   刷新。Staging/Production 严禁运行 generic `prisma:seed` 或 demo `prisma:seed:verify`。

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

### 9.0 事实/审计提交判定基线、delta 与重放零增长证明

在访问基线 apply 前后先单独记录权属期间总数；两次必须完全相同：

```sql
SELECT COUNT(*) AS ownership_period_count
FROM vehicle_ownership_period;
```

在订阅期间 apply 前、apply 后、任何输出/断连失败后以及重放后执行下列同一查询，保存完整单行结果。
它只统计本补录稳定键创建的事实，以及与这些事实按 `entity_id` 精确匹配的
`asset_facts / vehicle_subscription_period / CREATE` 审计：

```sql
WITH backfill_fact AS (
  SELECT
    id,
    order_id,
    started_at,
    ended_at,
    start_source_type,
    start_source_id,
    start_source_key,
    end_source_type,
    end_source_id,
    end_source_key
  FROM vehicle_subscription_period
  WHERE start_source_key LIKE 'stage1c-period-backfill:subscription-order:%'
), backfill_audit AS (
  SELECT audit.id, audit.entity_id, audit.created_at
  FROM audit_log AS audit
  WHERE audit.module = 'asset_facts'
    AND audit.entity_type = 'vehicle_subscription_period'
    AND audit.action = 'CREATE'
    AND audit.after_snapshot ->> 'startSourceKey'
      LIKE 'stage1c-period-backfill:subscription-order:%'
), audit_per_fact AS (
  SELECT entity_id, COUNT(*) AS audit_count
  FROM backfill_audit
  GROUP BY entity_id
)
SELECT
  (SELECT COUNT(*) FROM backfill_fact) AS backfill_fact_count,
  (SELECT COUNT(*) FROM backfill_audit) AS matching_create_audit_count,
  (
    SELECT COUNT(*)
    FROM backfill_fact AS fact
    LEFT JOIN audit_per_fact AS audit ON audit.entity_id = fact.id
    WHERE audit.entity_id IS NULL
  ) AS facts_without_create_audit,
  (
    SELECT COUNT(*)
    FROM backfill_audit AS audit
    LEFT JOIN backfill_fact AS fact ON fact.id = audit.entity_id
    WHERE fact.id IS NULL
  ) AS create_audits_without_fact,
  (
    SELECT COALESCE(SUM(audit_count - 1), 0)
    FROM audit_per_fact
    WHERE audit_count > 1
  ) AS duplicate_create_audits,
  md5(COALESCE((
    SELECT string_agg(
      concat_ws(
        '|',
        id::text,
        order_id::text,
        started_at::text,
        COALESCE(ended_at::text, '<OPEN>'),
        start_source_type,
        start_source_id::text,
        start_source_key,
        COALESCE(end_source_type, '<NULL>'),
        COALESCE(end_source_id::text, '<NULL>'),
        COALESCE(end_source_key, '<NULL>')
      ),
      ',' ORDER BY id
    )
    FROM backfill_fact
  ), '')) AS backfill_fact_fingerprint,
  md5(COALESCE((
    SELECT string_agg(
      concat_ws('|', id::text, entity_id::text, created_at::text),
      ',' ORDER BY id
    )
    FROM backfill_audit
  ), '')) AS matching_audit_fingerprint;
```

判定规则是事务级的：

- 正常 apply：事实数和匹配审计数都精确增加 `applied.inserted`，三个异常计数仍为 `0`。
- stdout 写入、报告文件写入或断连失败：不要猜测。若事实/审计 delta 与已批准 `CREATE` 数完全一致、
  异常计数为 `0`，则数据库事务已提交；重新 dry-run，再经授权重放确认 `inserted = 0`。若两者均无
  增长，则事务未提交；重新 dry-run/审批。任何单侧增长、意外 delta 或异常计数非零都按事故停止，
  保留现场并由数据库负责人核查。
- 重放：事实数、审计数和两个 fingerprint 必须与 apply 后完全相同，且 `inserted = 0`；任何增长都
  不是“可接受的重试”。

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
  period.start_source_key,
  period.end_source_type,
  period.end_source_id,
  period.end_source_key
FROM vehicle_subscription_period AS period
WHERE period.start_source_key LIKE 'stage1c-period-backfill:subscription-order:%'
  AND (
    period.start_source_type IS DISTINCT FROM 'SUBSCRIPTION_ORDER'
    OR period.start_source_id IS DISTINCT FROM period.order_id
    OR period.start_source_key IS DISTINCT FROM
      ('stage1c-period-backfill:subscription-order:' || period.order_id::text)
    OR (
      period.ended_at IS NULL
      AND (
        period.end_source_type IS NOT NULL
        OR period.end_source_id IS NOT NULL
        OR period.end_source_key IS NOT NULL
      )
    )
    OR (
      period.ended_at IS NOT NULL
      AND (
        period.end_source_type IS DISTINCT FROM 'SUBSCRIPTION_ORDER'
        OR period.end_source_id IS DISTINCT FROM period.order_id
        OR period.end_source_key IS DISTINCT FROM
          ('stage1c-period-backfill:subscription-order:' || period.order_id::text || ':end')
      )
    )
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
- migration status/deploy/status、schema validation、datasource→schema diff、原始字节 migration
  checksum 门禁输出；
- 专用访问基线 dry-run/apply/replay 输出、正负角色矩阵零差异、唯一平台 owner 和权属期间零增长证明；
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
