# Stage 10X-L modelDefinitionId Backfill Dry-run Report

## 1. Executive Summary

本报告基于 `pnpm model-definition:backfill-dry-run` 的只读扫描结果生成，数据快照时间：

```text
2026-06-24T08:32:53.023Z
2026-06-24 16:32:53 Asia/Shanghai
```

本轮 dry-run 没有写数据库，没有新增 migration，没有修改业务逻辑。

总体结论：

```text
Vehicle / VehiclePackage / ProductPriceRule: 可以按 legacy VehicleModel 自动回填
SubscriptionQuote / SubscriptionOrder: legacy snapshot 可解释，但不建议原地改写历史快照
Residual sample / curve / forecast / model run: 仍存在大量 legacy-only 数据，且 strict brand + series + model 规则无法直接匹配
```

不建议直接做全量 backfill。建议 10X-M 分阶段执行：先回填低风险 Vehicle/Product，再治理 Quote/Order snapshot 字段方案，最后处理 Residual 维度规范化和人工 mapping。

## 2. Vehicle Backfill Analysis

映射规则：

```text
Vehicle.vehicleModel -> VehicleModelDefinition.legacyVehicleModel
```

| Metric | Count |
| --- | ---: |
| total vehicles | 13 |
| with modelDefinitionId | 3 |
| modelDefinitionId null | 10 |
| legacy-only matched | 10 |
| legacy-only unmatched | 0 |
| legacy-only ambiguous | 0 |
| existing mapping conflicts | 0 |

Legacy distribution：

| legacy vehicleModel | Count |
| --- | ---: |
| ET9 | 5 |
| ET5 | 4 |
| ET5T | 2 |
| ES6 | 1 |
| ET7 | 1 |

结论：

```text
Vehicle 历史记录可映射比例：10 / 10 legacy-only = 100%
如执行真实 backfill，Vehicle 可作为第一批低风险对象
```

注意：当前已有关联的 3 台车没有 missing reference、mapping conflict 或 legacy mismatch。

## 3. Quote / Order Analysis

`SubscriptionQuote` 和 `SubscriptionOrder` 当前没有 `modelDefinitionId` 字段，本轮只分析 legacy `vehicleModel` 快照是否可解释。

### SubscriptionQuote

| Metric | Count |
| --- | ---: |
| total quotes | 10 |
| snapshot legacy matched | 10 |
| snapshot legacy unmatched | 0 |
| snapshot legacy ambiguous | 0 |
| linked vehicles | 7 |
| linked vehicles without modelDefinitionId | 7 |
| current vehicle legacy mismatch | 0 |
| current vehicle definition mismatch | 0 |

Legacy distribution：

| legacy vehicleModel | Count |
| --- | ---: |
| ET5 | 5 |
| ET9 | 5 |

### SubscriptionOrder

| Metric | Count |
| --- | ---: |
| total orders | 8 |
| snapshot legacy matched | 8 |
| snapshot legacy unmatched | 0 |
| snapshot legacy ambiguous | 0 |
| linked vehicles | 7 |
| linked vehicles without modelDefinitionId | 7 |
| current vehicle legacy mismatch | 0 |
| current vehicle definition mismatch | 0 |

Legacy distribution：

| legacy vehicleModel | Count |
| --- | ---: |
| ET9 | 5 |
| ET5 | 3 |

结论：

```text
Quote / Order 的 legacy vehicleModel 均可映射到 VehicleModelDefinition
但它们是历史报价 / 订单事实，不建议原地覆盖或删除 legacy snapshot
```

后续如要治理，应新设计：

```text
modelDefinitionSnapshot
modelDisplayNameSnapshot
legacyVehicleModelSnapshot
```

并保持现有 `vehicleModel` 作为审计解释字段。

## 4. Product / Package / PriceRule Analysis

### VehiclePackage

| Metric | Count |
| --- | ---: |
| total vehicle packages | 7 |
| with modelDefinitionId | 1 |
| modelDefinitionId null | 6 |
| legacy-only matched | 6 |
| legacy-only unmatched | 0 |
| legacy-only ambiguous | 0 |
| existing mapping conflicts | 0 |

Legacy distribution：

| legacy vehicleModel | Count |
| --- | ---: |
| ET5 | 3 |
| ES6 | 2 |
| ET7 | 2 |

### ProductPriceRule

| Metric | Count |
| --- | ---: |
| total price rules | 3 |
| with modelDefinitionId | 1 |
| modelDefinitionId null | 2 |
| legacy-only matched | 2 |
| legacy-only unmatched | 0 |
| legacy-only ambiguous | 0 |
| existing mapping conflicts | 0 |

Legacy distribution：

| legacy vehicleModel | Count |
| --- | ---: |
| ET5 | 3 |

结论：

```text
Product / Package / PriceRule 历史 legacy-only 记录均可自动映射
没有发现 modelDefinitionId + vehicleModel 冲突
```

这部分可以和 Vehicle 一起进入第一批低风险 backfill。

## 5. Residual Analysis

Residual 使用 legacy `brand / series / model` 维度。严格规则为：

```text
brand exact match
modelName exact match OR modelCode exact match
series match if provided
```

当前数据中 residual `series` 多数是 `ET5 / ES6 / EC6` 这类车型代码，而 `VehicleModelDefinition.series` 是 `ET / ES / EC` 这类车系。按 strict 规则，Residual 历史数据无法直接安全映射。

### VehicleMarketPriceObservation

| Metric | Count |
| --- | ---: |
| total observations | 556 |
| with modelDefinitionId | 0 |
| modelDefinitionId null | 556 |
| strict matched | 0 |
| strict unmatched | 556 |
| strict ambiguous | 0 |
| relaxed matched ignoring series | 514 |
| relaxed unmatched ignoring series | 42 |

Top legacy dimensions：

| brand / series / model | Count |
| --- | ---: |
| NIO / ET5 / ET5 | 237 |
| NIO / ES6 / ES6 | 125 |
| NIO / EC6 / EC6 | 64 |
| NIO / ES8 / ES8 | 44 |
| NIO / ET7 / ET7 | 44 |
| NIO / ET5 / ET5 75kWh | 9 |
| NIO / ES6 / ES6 75kWh | 8 |
| NIO / ET5T / ET5T 75kWh | 7 |

### VehicleResidualCurve

| Metric | Count |
| --- | ---: |
| total curves | 5 |
| with modelDefinitionId | 0 |
| modelDefinitionId null | 5 |
| strict matched | 0 |
| strict unmatched | 5 |
| relaxed matched ignoring series | 4 |
| relaxed unmatched ignoring series | 1 |

Curve statuses：

| status | Count |
| --- | ---: |
| ACTIVE | 2 |
| DRAFT | 2 |
| ARCHIVED | 1 |

One relaxed-unmatched curve uses `NIO / - / es6`, which needs casing or manual mapping review.

### VehicleResidualForecast

| Metric | Count |
| --- | ---: |
| total forecasts | 4 |
| with modelDefinitionId | 0 |
| modelDefinitionId null | 4 |
| strict matched | 0 |
| strict unmatched | 4 |
| relaxed matched ignoring series | 3 |
| relaxed unmatched ignoring series | 1 |
| forecasts using legacy-only curve | 4 |
| null forecasts with vehicle.modelDefinitionId | 1 |
| null forecasts with curve.modelDefinitionId | 0 |
| null forecasts with no related modelDefinitionId | 3 |

Forecast statuses：

| status | Count |
| --- | ---: |
| GENERATED | 2 |
| ADOPTED | 1 |
| VOIDED | 1 |

结论：

```text
所有 forecast 当前仍挂在 legacy-only curve 上
其中存在 ADOPTED forecast，不能通过简单重算或覆盖方式处理
```

### ResidualModelRun

| Metric | Count |
| --- | ---: |
| total model runs | 3 |
| with targetModelDefinitionId | 0 |
| targetModelDefinitionId null | 3 |
| full runs without target dimensions | 1 |
| target-specific without targetModelDefinitionId | 2 |
| strict target matched | 0 |
| strict target unmatched | 2 |
| relaxed target matched ignoring series | 2 |
| relaxed target unmatched ignoring series | 0 |

结论：

```text
ResidualModelRun 的 target-specific 历史记录可通过更宽松规则解释
但 strict 规则仍不满足，需要先明确 residual series 规范化策略
```

## 6. Mapping Strategy

建议分三类策略。

### Low Risk: direct legacy enum mapping

适用：

```text
Vehicle
VehiclePackage
ProductPriceRule
```

规则：

```text
legacy VehicleModel -> VehicleModelDefinition.legacyVehicleModel
不覆盖已有 modelDefinitionId
只更新 modelDefinitionId = null 的历史记录
执行前后输出 total / matched / skippedExisting / unresolved / conflicts
```

### Audit-only: snapshot explanation

适用：

```text
SubscriptionQuote
SubscriptionOrder
```

规则：

```text
本阶段不原地改写历史快照
保留 legacy vehicleModel
如后续需要主数据快照，应新增 snapshot 字段并单独评审
```

### Medium / High Risk: residual dimension normalization

适用：

```text
VehicleMarketPriceObservation
VehicleResidualCurve
VehicleResidualForecast
ResidualModelRun
```

当前 strict 规则无法映射，原因包括：

```text
series 粒度不一致：ET5 / ES6 vs ET / ES
model 带电池后缀：ET5 75kWh / ES6 100kWh
大小写不一致：es6
forecast 已有 ADOPTED / VOIDED 历史状态
curve 仍为 legacy-only，forecast 依赖 legacy curve
```

建议在真实 backfill 前建立 residual 专用 mapping review：

```text
source brand / series / model
candidate modelDefinitionId
match rule: strict / ignoreSeries / normalizedModel / manual
sample count
approvedBy / approvedAt
```

## 7. Risk Matrix

| Area | Risk | Reason | Recommendation |
| --- | --- | --- | --- |
| Vehicle | Low | 10/10 legacy-only records map cleanly; no conflicts | first batch backfill |
| VehiclePackage | Low | 6/6 legacy-only records map cleanly; no conflicts | first batch backfill |
| ProductPriceRule | Low | 2/2 legacy-only records map cleanly; no conflicts | first batch backfill |
| SubscriptionQuote | High | historical quote facts; no modelDefinitionId field today | do not overwrite; design snapshot fields |
| SubscriptionOrder | High | contract/order audit trail depends on historical snapshot | do not overwrite; design snapshot fields |
| Market observations | Medium | 514/556 can map only with relaxed series; 42 need normalization/manual review | mapping table before write |
| Residual curves | High | active curves are legacy-only and drive forecasts | manual review before write |
| Residual forecasts | High | all 4 use legacy-only curves; 1 adopted forecast exists | do not recalc; preserve forecast explanation |
| Residual model runs | Medium | target-specific runs can map only with relaxed rule | mapping table before write |

## 8. Recommended Backfill Plan

### Stage 10X-M-A: low-risk enum backfill

Scope:

```text
Vehicle.modelDefinitionId
VehiclePackage.modelDefinitionId
ProductPriceRule.modelDefinitionId
```

Execution:

```text
dryRun=true by default
transactional write mode only after dry-run approval
do not overwrite existing modelDefinitionId
fail on unresolved or conflict unless explicitly allowlisted
emit before/after stats
```

Write window:

```text
Short maintenance/write window recommended, but not full system downtime.
New writes already require modelDefinitionId after 10X-H and 10X-I.
```

### Stage 10X-M-B: Quote / Order snapshot design

Scope:

```text
SubscriptionQuote
SubscriptionOrder
```

Recommendation:

```text
Do not backfill by changing current legacy snapshot fields.
Design additive snapshot fields first.
Keep legacy vehicleModel as audit explanation.
```

This stage likely needs schema migration and a separate review.

### Stage 10X-M-C: residual mapping review

Scope:

```text
VehicleMarketPriceObservation
VehicleResidualCurve
VehicleResidualForecast
ResidualModelRun
```

Recommendation:

```text
Do not full backfill residual yet.
Create a residual dimension mapping report/table first.
Normalize series and battery suffix cases explicitly.
Review active curves and adopted forecasts manually.
Only then write modelDefinitionId snapshots.
```

## 9. No-op Confirmation

本轮确认：

```text
No database writes were performed by scripts/model-definition-backfill-dry-run.mjs
No modelDefinitionId values were backfilled
No migration was added
No Prisma schema change was made
No business logic was changed
No ROE / depreciation / BaaS logic was touched
No payment / quote / order behavior was touched
No production deploy was executed
```

验证命令：

```powershell
node --check scripts/model-definition-backfill-dry-run.mjs
pnpm model-definition:backfill-dry-run
```
