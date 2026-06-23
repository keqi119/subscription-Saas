# Stage 10N-C-A 车辆折旧模型与 schedule / record 基础

## 目标

本阶段新增正式车辆折旧基础能力：`VehicleDepreciationPolicy`、`VehicleDepreciationSchedule`、`VehicleDepreciationRecord`，支持直线法计划生成、MANUAL 月度折旧补录、NONE 策略以及 confirm / void / lock 状态流转。

本阶段不接入资产收益主口径，不修改 `platformNetIncomeAmount`、`roeTrial`、`annualizedRoeTrial`、`trialRoa`，也不修改现有 `VehicleAssetCostProfile` 即时试算逻辑。

## 为什么需要正式折旧模块

既有 `VehicleAssetCostProfile` 已能保存折旧方法、起算日、使用月数和残值，并即时试算月折旧。但它没有持久化月度折旧记录，也没有确认、作废、锁定、补录和历史追踪能力，无法支撑生产级 ROE 审计口径。

因此本阶段先建立折旧台账基础，再在后续阶段把确认后的折旧 record 接入主 ROE。

## policy / schedule / record

- `VehicleDepreciationPolicy`：车辆折旧策略，记录方法、折旧基数、残值、使用月数、起算日、状态和来源快照。
- `VehicleDepreciationSchedule`：按月生成的折旧计划，适用于直线法；同一 policy + costPeriod 幂等。
- `VehicleDepreciationRecord`：月度折旧确认记录。后续 Stage 10N-C-B 接入主 ROE 时，优先使用 `CONFIRMED` / `LOCKED` records。

## 折旧方法

- `STRAIGHT_LINE`：默认会计折旧方法。要求 `usefulLifeMonths > 0` 且 `depreciationBasisAmount > residualValueAmount`。
- `NONE`：可激活，但不生成 schedule / record。后续报表口径视为无折旧成本。
- `MANUAL`：可激活，不自动生成 schedule；通过后台手工创建月度 record 补录折旧金额。

## 直线法 schedule 生成

生成规则：

1. `depreciableAmount = depreciationBasisAmount - residualValueAmount`。
2. `monthlyBaseAmount = depreciableAmount / usefulLifeMonths`，按分取整。
3. 取整余数加入最后一个账期，确保 schedule 金额合计等于 `depreciableAmount`。
4. 第一条 `periodStart = depreciationStartDate`，第一条 `periodEnd = 当月月末`。
5. 后续按自然月生成，共生成 `usefulLifeMonths` 条。
6. `costPeriod = YYYY-MM`。
7. `dryRun=true` 只返回候选计划，不写库。
8. `dryRun=false` 仅补齐缺失的 `policyId + costPeriod`，已存在账期跳过。

本阶段以月为最小折旧计划单位；后续接 ROE 时仍按 `periodStart` / `periodEnd` 归属，并支持跨期按天分摊。

## MANUAL 补录

MANUAL policy 下可通过后台创建 `VehicleDepreciationRecord`，必须填写：

- `costPeriod`
- `periodStart`
- `periodEnd`
- `depreciationAmount`

本阶段只建立补录能力，不改变既有 `report.service` 对 MANUAL 折旧的阻断逻辑。

## 状态流转

Policy：

- `DRAFT`
- `ACTIVE`
- `SUSPENDED`
- `TERMINATED`
- `ARCHIVED`

Schedule：

- `SCHEDULED`
- `CONFIRMED`
- `VOIDED`
- `LOCKED`

Record：

- `DRAFT`
- `CONFIRMED`
- `VOIDED`
- `LOCKED`

约束：

- 同一车辆同一时间只允许一个 `ACTIVE` policy。
- schedule confirm 会创建或更新对应 scheduled record。
- schedule void 遇到关联 `CONFIRMED` / `LOCKED` record 时阻止。
- `CONFIRMED` / `LOCKED` record 不允许修改金额。

## 后台能力

新增 `/vehicle-depreciation-policies` 管理页面：

- policy 列表 / 筛选 / 新建 / 编辑 / 激活 / 暂停 / 终止 / 归档
- schedule 试算 / 正式生成 / confirm / void / lock
- record 列表 / MANUAL 补录 / confirm / void / lock

车辆详情新增“折旧管理”摘要：

- 当前 ACTIVE policy
- 折旧方法
- 折旧基数
- 残值
- 使用月数
- 起算日
- 已生成 schedule 数
- 已确认 record 数
- 折旧管理入口

## 权限与菜单

新增权限：

- `vehicle_depreciation:view`
- `vehicle_depreciation:manage`

角色口径：

- ADMIN：全部权限
- OP：view / manage
- FI：view / manage
- GM：view
- SA：view

菜单：

- 车辆资产 -> 折旧管理

执行 `pnpm prisma:seed` 后，需要重新登录刷新后台 token。

## 后续阶段

Stage 10N-C-B：折旧接入资产收益主口径。

待确认事项：

- 是否仅使用 `CONFIRMED` / `LOCKED` depreciation records 进入主口径。
- STRAIGHT_LINE schedule 是否必须先 confirm 才进入主口径。
- MANUAL policy 缺 record 时 ROE 如何提示不可用。
- 折旧按 `periodStart` / `periodEnd` 分摊。
- 与现有 `VehicleAssetCostProfile` depreciation 字段如何过渡。

Stage 10N-C-C：市场校准折旧与残值敏感性对比。
