# Stage 10X-F Residual Market / Forecast Model Master Data

Stage 10X-F 将 `VehicleModelDefinition` 接入残值市场、残值曲线、残值预测和估值复核展示链路，继续保持双轨兼容：

```text
modelDefinitionId 优先
legacy brand / series / model fallback
不重算历史 forecast
不自动 adopt residual
不更新车辆当前销售价
不修改 ROE / 折旧 / BaaS 主口径
```

## 1. 接入范围

本阶段新增 nullable 主数据外键：

```text
VehicleMarketPriceObservation.modelDefinitionId
VehicleResidualCurve.modelDefinitionId
VehicleResidualForecast.modelDefinitionId
ResidualModelRun.targetModelDefinitionId
```

这些字段只用于新数据的关联、筛选、展示和预测时的车型快照，不回填历史 residual 数据。

## 2. Residual Market Sample

市场样本仍保留 legacy 字段：

```text
brand
series
model
modelYear
trim
```

新增 `modelDefinitionId` 后，样本 create / CSV import 会校验主数据存在、未删除且 `enabled=true`。列表和详情返回：

```text
modelDefinition
modelDefinitionId
modelDisplayName
```

CSV import 模板新增 `modelDefinitionId` 列，但 legacy brand / series / model 仍保留。

## 3. Residual Curve

残值曲线支持按 `modelDefinitionId` 创建、查询和展示，同时保留 legacy 建模维度。

生成绑定主数据的曲线时，样本选择逻辑为：

```text
sample.modelDefinitionId = input.modelDefinitionId
OR sample.modelDefinitionId IS NULL AND legacy brand / series / model 匹配
```

这样新曲线可使用主数据样本，也不会丢失历史 legacy 样本。

## 4. Forecast Lookup

单车残值预测的曲线查找优先级：

```text
1. 显式 curveId
2. vehicle.modelDefinitionId 对应的 ACTIVE curve
3. legacy brand / model ACTIVE curve
```

如果车辆有 `modelDefinitionId`，正式生成 forecast 时会保存 `VehicleResidualForecast.modelDefinitionId` 快照，便于历史预测解释。

预测点计算公式、插值逻辑和置信度口径不变。

## 5. Valuation Review

估值复核列表和详情的车辆车型展示优先：

```text
vehicle.modelDefinition.displayName
legacy vehicle.model
```

本阶段不修改复核状态机，不修改 approve / reject / cancel 行为。

## 6. 明确不做

```text
不重算历史 forecast
不自动 adopt residual forecast point
不更新 Vehicle.currentSalePriceAmount
不修改 VehicleAssetCostProfile.residualValueAmount
不删除 legacy brand / series / model 字段
不删除 VehicleModel enum
不修改 ROE / 折旧 / BaaS 主口径
不执行 production deploy
```

## 7. 后续 Stage 10X-G

Stage 10X-G 应先评估 enum 退场，而不是直接删除 `VehicleModel`：

```text
新流程是否都已优先 modelDefinitionId
历史 Quote / Order snapshot 是否仍依赖 enum
Residual / Reports / Product / Portal fallback 是否稳定
是否需要长期保留 enum 作为 legacy field
是否具备安全回填历史 modelDefinitionId 的脚本
```

短期建议仍是保留 `VehicleModel` enum，新主流程优先使用 `modelDefinitionId`。

## 8. Stage 10X-J 完成后状态

Stage 10X-J 在 10X-F 双轨接入基础上收紧 residual 新数据入口：

```text
Residual market 新增样本必须最终写入 modelDefinitionId
Residual market CSV 导入样本必须最终写入 modelDefinitionId
Residual curve 新建 / 生成必须最终写入 modelDefinitionId
ResidualModelRun 如指定目标车型，必须最终写入 targetModelDefinitionId
legacy brand / series / model 继续保留历史 fallback
```

10X-J 仍不迁移历史 residual 数据，不重算历史 forecast，不自动 adopt residual，不更新车辆当前销售价。

详见：

```text
docs/stage-10x-residual-model-definition-required.md
```
