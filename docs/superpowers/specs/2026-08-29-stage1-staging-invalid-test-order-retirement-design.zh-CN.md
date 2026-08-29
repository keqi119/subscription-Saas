# 阶段 1 Staging 无效测试订单一次性退役设计

> 日期：2026-08-29  
> 基线：`main@06b5ae7`  
> 目标环境：仅 Staging  
> 目标订单：`ORD20260726073922TFHF`  
> 设计选择：采用方案 C 一次性清理；不建设常设历史订单治理入口

## 1. 背景与问题定义

阶段 1 代码层和浏览器视觉验收发现，Staging 中有 4 个历史 `ACTIVE` 订单缺失原始合同履行日期、BASE 合同段或车辆在租期间事实。其中 3 个订单存在可唯一证明的交付、租约及电子签证据，可以沿既有“电子签归档修复 → 源事实修复 → BASE 补录 → Stage 1C 周期补录”流水线收敛。

订单 `ORD20260726073922TFHF` 不同：

- 没有 `VehicleDelivery`，无法证明权威交付时间；
- 订单 `actualDeliveryAt` 与 Lease `activatedAt` 为 `2026-07-31T03:01:04Z`，但已归档交接在更早时间完成，时间线不一致；
- 订单没有 BASE 合同段和 `VehicleSubscriptionPeriod`；
- 没有账单、支付、代扣、权益、自动任务、合同变更、退车、结算案件等后续履约事实；
- 车辆 VIN 为 `TESTVINET50000001`，属于明确的 Staging 测试资产；
- 对该订单猜测交付时间或补造 `VehicleDelivery` 会制造无法举证的业务事实。

因此该订单不是源事实自动修复候选，而是无业务价值的历史测试数据。继续保持 `ACTIVE` 会反复阻断源事实、合同段、车辆周期、账单及合同变更验收；直接删除又会破坏已签合同和交接证据的历史可追溯性。

## 2. 已确认的方案选择

本轮评估过三个方案：

1. 方案 A：把旧交接资料接受为交付替代证据；
2. 方案 B：建设管理员双人复核的历史事实重建能力；
3. 方案 C：把明确无效的测试订单退出活跃业务范围。

本次采用方案 C，并限定为一个目标订单的一次性 Staging 运维动作。

不采用方案 A，因为它会放宽交付证据口径并制造无法证明的日期。不在本轮建设方案 B，因为当前只有一个明确的无效测试订单，常设治理入口会扩大产品与权限攻击面。若 Production 未来出现真实历史订单证据缺口，应重新设计方案 B，不能复用本工具。

## 3. 目标与非目标

### 3.1 目标

1. 在不删除任何历史记录的前提下，把唯一目标测试订单退出活跃履约范围。
2. 释放目标车辆库存，同时复用当前车辆可用性的价格、周期和运营限制不变量。
3. 确保订单不再进入主动源事实修复、BASE 合同段补录、Stage 1C 周期补录和合同变更启动门槛。
4. 提供 dry-run 优先、显式 apply、陈旧计划拒绝、单事务、幂等重放和完整审计。
5. 把工具及其直接依赖打包进 API runtime 镜像，避免在线临时复制脚本或手工 SQL。

### 3.2 非目标

- 不删除或软删除订单、租约、合同、电子签任务、交接、文件或审计记录。
- 不创建 `VehicleDelivery`、`VehicleReturn`、退车案件、BASE 合同段或车辆期间。
- 不填写 `actualReturnAt`，不伪造物理退车或客户结算事实。
- 不修改已签合同、已归档交接及其文件对象。
- 不建设 Admin/Portal 页面、通用测试数据删除 API 或批量历史订单清理能力。
- 不修改数据库 schema，不新增迁移。
- 不允许 Production 或任意非 Staging 数据库执行 apply。
- 不因本设计批准而自动执行 Staging 数据写入；每个 apply 仍需单独批准。

## 4. 目标身份与硬边界

工具代码内固化唯一允许目标：

| 字段 | 固定值 |
| --- | --- |
| orderNo | `ORD20260726073922TFHF` |
| orderId | `c392fa54-4784-4e04-ad4a-bfe2fd7e2d10` |
| vehicleId | `70565059-1841-4c97-a32c-7bd09ce0b90f` |
| vehicleNo | `VEH20260713140950K4BT` |
| VIN | `TESTVINET50000001` |
| 固定原因 | `STAGING_INVALID_TEST_DATA_RETIREMENT` |

CLI 仍要求操作者逐项传入订单和车辆选择器，并与代码内固定值完全匹配。这样既防止误选，也避免把脚本演变成通用业务操作面。

apply 必须同时满足：

- `DEPLOYMENT_ENV` 或 `APP_ENV` 规范化后严格等于 `staging`；
- `STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY=1`；
- CLI 传入的全部目标选择器与固定白名单一致；
- CLI 传入有效的内部操作人 UUID；该用户未删除、状态有效且具有系统管理员角色；
- CLI 传入 dry-run 报告中的 `evidenceDigest`，且 apply 事务内重算结果完全一致。

任一条件不满足时只输出稳定错误码，不连接或不写入业务表。

## 5. 工具结构与接口

新增三层脚本：

- `stage1-staging-invalid-test-order-retirement-core.mjs`：参数解析、快照规范化、分类、摘要和脱敏报告；
- `stage1-staging-invalid-test-order-retirement-executor.mjs`：读取快照、事务锁、重分类、更新、审计和后验验证；
- `stage1-staging-invalid-test-order-retirement.mjs`：环境加载、Prisma 连接、CLI 输出和公开错误边界。

命令形态：

```text
node scripts/stage1-staging-invalid-test-order-retirement.mjs \
  --dry-run|--apply \
  --order-id <uuid> \
  --order-no <value> \
  --vehicle-id <uuid> \
  --vehicle-no <value> \
  --vin <value> \
  --operator-id <uuid> \
  [--expected-evidence-digest <sha256>] \
  [--output <path>]
```

`--expected-evidence-digest` 在 dry-run 禁止传入，在 apply 必填。未知参数、重复参数、空值、非 UUID、缺失模式或同时指定两种模式均 fail-closed。

报告只包含业务编号、UUID、状态、关联记录计数、稳定原因码、证据摘要和相关审计关联 ID；禁止输出客户姓名、手机号、身份证件、数据库 URL、对象存储凭证或电子签访问参数。

## 6. 执行前分类与阻断条件

### 6.1 必须满足的目标状态

- 订单未删除，身份与白名单一致，`orderStatus = ACTIVE`，目标车辆关联唯一且一致；
- 唯一 Lease 未删除，`status = ACTIVE`；
- 唯一 BillingSchedule 为 `PAUSED`，没有最近生成账单；
- 车辆未删除，身份与白名单一致，`status = LEASED`；
- 车辆 `salePriceStatus = EFFECTIVE` 且 `currentSalePriceAmount > 0`；
- 不存在 `VehicleDelivery`、`VehicleReturn`，且 `actualReturnAt` 为空。

### 6.2 必须为零的业务关联

以下任一记录存在即阻断：

- 应收账单、支付记录、支付订单、支付委托、扣款尝试、核销、押金台账、催收案件；
- 权益账户、权益授予、权益使用；
- 订阅自动任务，包括尚未执行和已终态任务；
- `OrderChange`、`SubscriptionChangeOrder`、续期考虑记录；
- BASE/EXTENSION/其他合同段；
- `VehicleSubscriptionPeriod`；
- 退车、退车损伤、退车清单、差异修订、结算案件；
- 与该订单或车辆关联的资产工单、有效运营限制；
- 车辆上的其他非终态订单或有效 Lease。

已有主合同、电子签任务、文件对象、Stage 2 交接及其证据允许存在，但只参与摘要，不允许修改。任何新增、删除、状态或关联变化都会改变 `evidenceDigest`，使旧 dry-run 计划在 apply 时失效。

### 6.3 分类结果

分类器只返回三种顶层结果：

- `CANDIDATE`：全部条件满足，可以在独立批准后 apply；
- `UNCHANGED`：四个目标实体已经处于本设计规定的终态，且存在匹配的退役审计；
- `BLOCKED`：存在一个或多个稳定阻断码，不允许写入。

部分终态不属于 `UNCHANGED`。例如订单已取消但车辆仍为 `LEASED` 时必须返回 `PARTIAL_RETIREMENT_STATE`，禁止自动续写。

## 7. 事务写入

apply 使用单个 Serializable 事务：

1. 获取专用 PostgreSQL transaction advisory lock；
2. 按稳定顺序锁定目标订单、Lease、BillingSchedule、车辆及所有阻断关联行；
3. 重新加载完整快照并重跑分类器；
4. 校验 apply 参数中的 `expectedEvidenceDigest`；
5. 使用同一个数据库事务时间和同一个 `correlationId` 执行：
   - BillingSchedule：`PAUSED → CANCELLED`，写 `cancelledAt`，写固定 `pauseReason`，`version + 1`；
   - Lease：`ACTIVE → COMPLETED`，写 `updatedBy`；
   - SubscriptionOrder：`ACTIVE → CANCELLED`，写 `updatedBy`；
   - Vehicle：`LEASED → AVAILABLE`，写 `updatedBy`；
6. 为四个实体分别写 `AuditLog(action = UPDATE)`；
7. 在事务内重新读取并验证全部后验条件；
8. 任一步骤不满足预期更新行数、状态或关联不变量，整笔回滚。

车辆采用 `LEASED → AVAILABLE` 的一次性纠错转换，不经过 `RETURNED`，因为该订单没有可证明的物理退车事实。该例外只对硬编码测试车辆生效。转换前仍强制检查有效正数销售价、零有效车辆期间、零阻断运营限制、零其他非终态订单，避免释放不可销售或仍被占用的车辆。

订单原有 `actualDeliveryAt/startDate/endDate/actualReturnAt/contractId` 均不改写；其中 `actualReturnAt` 必须保持为空。

## 8. 审计与幂等

四条审计使用统一：

- `module = STAGE1_STAGING_TEST_DATA_RETIREMENT`；
- 固定原因码 `STAGING_INVALID_TEST_DATA_RETIREMENT`；
- `correlationId`；
- `operatorId`；
- `evidenceDigest`；
- 脱敏的前后状态快照；
- 固定 CLI user-agent 标识。

审计不得把合同文件、交接证据或客户身份信息复制进 JSON。

重放规则：

- 四个实体均处于预期终态，且四条审计的关联 ID、目标身份和证据摘要一致时，返回 `UNCHANGED`，零业务写入、零新增审计；
- 终态一致但审计缺失或不一致时返回 `RETIREMENT_AUDIT_MISMATCH`；
- 任何混合状态返回 `PARTIAL_RETIREMENT_STATE`；
- 并发执行由 advisory lock、行锁、状态条件更新和 Serializable 隔离共同保证最多一次提交。

## 9. 退出验收门槛的代码语义

清理后的订单为 `CANCELLED`，没有 `actualReturnAt` 和已确认 VehicleReturn，因此：

- 主动源事实修复只查询 `ACTIVE/PENDING_RETURN`，不会再包含该订单；
- BASE 合同段补录只查询 `ACTIVE/PENDING_RETURN`，不会再包含该订单；
- Stage 1C 周期补录只分类 `ACTIVE/PENDING_RETURN/COMPLETED/TERMINATED` 或具有退车事实的订单，不会再包含该订单；
- 合同变更 bootstrap 只处理 `ACTIVE` 订单，不会再包含该订单；
- BillingSchedule 为 `CANCELLED` 且没有自动任务，不会再被账单 worker 执行；
- 车辆为 `AVAILABLE`，可重新进入正常库存分配校验。

这使方案 C 是业务范围退出，而不是只在页面上隐藏异常。

## 10. 发布、执行与回滚

### 10.1 发布前

1. 完成脚本单元、执行器、CLI、runtime 媒体及全量质量门槛测试；
2. 合并并部署包含工具的新 API 镜像；
3. 暂停 Staging 验收写操作；
4. 创建新的 PostgreSQL 备份并记录路径、时间、镜像版本和 SHA-256；
5. 在已发布 API 容器中执行 dry-run，保存报告；
6. 人工核对唯一候选、零阻断及证据摘要；
7. 取得独立 apply 批准。

### 10.2 apply 与验证

1. 使用 dry-run 摘要执行 apply；
2. 保存 apply 报告；
3. 立即重放相同命令并确认 `UNCHANGED`；
4. 查询四个实体状态、四条审计、车辆其他活跃占用和全部禁止关联；
5. 重新运行四类验收门槛，确认该订单完全退出候选与异常清单。

### 10.3 回滚

- apply 事务内部失败由数据库自动完整回滚；
- 成功提交后不提供逆向 SQL 或通用恢复脚本；
- 若提交后的后验检查失败，立即停止后续写入，在隔离维护窗口恢复本次专用备份；
- 一旦执行了后续电子签归档或源事实补录，不再直接覆盖恢复旧备份，必须先重新评估后续写入影响。

## 11. 清理后的收敛流水线

一次性退役成功后，严格按以下顺序处理剩余有效历史订单：

```text
目标订单退役 apply + replay
  -> 使用现有电子签归档重试能力修复 2 个有效历史主合同
  -> 主动源事实修复 dry-run（预期 3 candidates / 0 exceptions）
  -> 独立批准源事实 apply + replay
  -> BASE 合同段 dry-run
  -> 独立批准 BASE apply + replay
  -> Stage 1C 周期 dry-run
  -> 独立批准 Stage 1C apply + replay
  -> 合同变更 bootstrap / 账单对账 / Stage 1 总门槛
  -> 浏览器视觉验收
  -> 人工验收
```

电子签归档、源事实、BASE 和 Stage 1C 均属于独立业务写入。批准本设计或批准目标订单退役，不代表批准这些后续 apply。

## 12. 测试设计

### 12.1 分类器

- 唯一干净目标生成一个 `CANDIDATE`；
- 任一身份选择器或代码内白名单不一致均阻断；
- 订单、Lease、Schedule、车辆任一状态漂移均产生稳定阻断码；
- 每一类禁止关联独立覆盖；
- 合同、电子签和交接允许存在并进入摘要，但不进入输出敏感字段；
- 快照排序、BigInt、Date 和 JSON 字段生成稳定 SHA-256；
- 完整终态和匹配审计为 `UNCHANGED`；混合终态或审计不一致为 `BLOCKED`。

### 12.2 执行器

- dry-run 使用只读事务且零写入；
- apply 使用 Serializable、advisory lock 和行锁；
- apply 事务内重新分类并拒绝陈旧摘要；
- 四个状态转换、时间、版本、操作人和审计一致；
- 任一步骤注入失败时全部回滚；
- 并发 apply 最多一次提交；
- replay 零更新、零审计。

### 12.3 CLI 与运行时

- 参数严格解析；apply 环境、确认变量、操作人和摘要缺一不可；
- 非 Staging apply 在创建业务连接或执行写入前失败；
- stdout、文件报告及 stderr 公开错误不泄露连接串、客户或文件凭证；
- `Dockerfile.api` 包含脚本及直接依赖；runtime 媒体测试在容器构建上下文中验证路径。

### 12.4 质量门槛

至少执行：

- `git diff --check`；
- Prisma migration status、validate、generate；
- 新增脚本测试及相关源事实、BASE、Stage 1C、合同变更、车辆可用性测试；
- API/Web lint、typecheck、全量测试和 build；
- API runtime 媒体测试；
- main CI 全绿。

测试和 CI 只能使用 fixture 或 mock Prisma，不连接 Staging，不执行真实业务写入。

## 13. 验收标准

1. 工具只能识别一个硬编码 Staging 测试订单，不能改造为任意订单清理器。
2. 未经独立 apply 批准时，Staging 业务数据零写入。
3. apply 后订单、Lease、BillingSchedule、车辆分别为 `CANCELLED/COMPLETED/CANCELLED/AVAILABLE`。
4. 合同、电子签、交接、文件和历史时间未被修改，`actualReturnAt` 仍为空。
5. 四条审计具有相同关联 ID、操作人、原因和证据摘要，且报告脱敏。
6. replay 返回 `UNCHANGED`，零新增写入。
7. 目标订单不再出现在源事实、BASE、Stage 1C、合同变更和账单执行异常中。
8. 车辆重新通过正常库存分配的可用性检查。
9. 后续 3 个有效订单可按既有修复流水线独立收敛，最终 Stage 1 总门槛全绿。

## 14. 已知限制

- 本工具只能解决当前唯一无效 Staging 测试订单，不能治理未来任意历史数据。
- 若未来再次出现真实历史订单证据缺口，应建设带双人复核、证据附件和不可变修订记录的方案 B，而不是扩充本白名单。
- 若 dry-run 后出现账单、任务、变更、退车或其他新事实，本轮方案 C 自动失效，必须重新进行设计审查。
- 存量 apply 始终是业务数据变更；即使代码、测试和 dry-run 全部通过，也必须取得用户新的明确批准。
