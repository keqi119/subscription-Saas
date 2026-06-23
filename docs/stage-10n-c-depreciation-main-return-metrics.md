# Stage 10N-C-B 折旧接入资产收益主口径

## 目标

Stage 10N-C-B 将正式车辆折旧记录接入资产收益主口径。主 ROE / ROA 继续采用会计折旧口径，且仅使用已确认、可追溯的折旧记录。

## Record vs Schedule

- `VehicleDepreciationSchedule` 是折旧计划，不直接进入主 ROE。
- `VehicleDepreciationRecord` 是确认后的折旧记录，是本阶段进入资产收益主口径的唯一新折旧来源。
- 标准流程为：schedule -> confirm -> 生成 / 更新 record -> record 进入报表。

## 纳入规则

仅纳入：

- `recordStatus = CONFIRMED`
- `recordStatus = LOCKED`
- `deletedAt = null`

排除：

- `DRAFT`
- `VOIDED`
- `deletedAt != null`

## periodStart / periodEnd 分摊

折旧记录按 `periodStart` / `periodEnd` 与分析周期的重叠天数分摊，不按 `costPeriod`、`createdAt` 或 `confirmedAt` 归属。

分摊规则：

```text
totalDays = record.periodStart 至 record.periodEnd 的 inclusive 天数
overlapDays = record 与分析周期重叠的 inclusive 天数
includedAmount = round(record.amount * overlapDays / totalDays)
```

金额按分四舍五入；期间无效时按 0 计入并返回 warning，不让整份报表失败。

## Active policy 优先

有 `ACTIVE VehicleDepreciationPolicy` 时：

- `NONE`：折旧为 0，`depreciationSource = NONE`。
- `MANUAL`：依赖 `CONFIRMED / LOCKED` records；缺记录时 ROE 不可用。
- `STRAIGHT_LINE`：依赖 `CONFIRMED / LOCKED` records；schedule 未 confirm 不进入主口径。

无 `ACTIVE VehicleDepreciationPolicy` 时：

- 暂时 fallback 到 `VehicleAssetCostProfile` 的旧即时折旧；
- `depreciationSource = LEGACY_COST_PROFILE`。

## 防止双扣

有 ACTIVE 折旧策略时，报表会剥离 `VehicleAssetCostProfile` 中的即时折旧，只使用折旧 policy 对应的主口径结果。这样不会同时扣旧即时折旧和新 records 折旧。

## 返回字段

Summary / vehicle list / detail 新增折旧字段，包括：

- `depreciationAmount`
- `depreciationRecordAmount`
- `legacyDepreciationAmount`
- `depreciationRecordCount`
- `depreciationSource`
- `depreciationMissingReasons`

`depreciationSource` 取值：

- `RECORDS`
- `LEGACY_COST_PROFILE`
- `NONE`
- `UNAVAILABLE`

## 本阶段不做

- 不修改折旧 policy / schedule / record schema。
- 不修改 schedule 生成逻辑。
- 不接市场校准折旧。
- 不让残值预测自动更新折旧基准。
- 不做残值滑块。
- 不修改支付 / 核销 / 账单 / 合同 / 订单 / 权益 / 工单主逻辑。

## 下一步

Stage 10N-C-C 建议进入市场校准折旧与残值敏感性对比，继续保持主会计折旧口径与对比分析口径分离。
