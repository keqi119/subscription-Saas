# Stage 10X-J Residual Model Definition Required

## 1. 目标

Stage 10X-J 将 Residual 新数据入口推进到车型主数据轨道：

```text
Residual market 新增样本必须最终写入 modelDefinitionId
Residual market CSV 导入样本必须最终写入 modelDefinitionId
Residual curve 新建 / 生成必须最终写入 modelDefinitionId
Residual model run 如指定目标车型，必须最终写入 targetModelDefinitionId
legacy brand / series / model 继续保留作为历史 fallback
```

本阶段不迁移历史 residual 数据，不重算历史 forecast，不自动 adopt residual forecast，不更新车辆当前销售价，也不修改 ROE、折旧、BaaS、支付或核销主逻辑。

## 2. Sample Create

新建 `VehicleMarketPriceObservation` 时：

```text
传 modelDefinitionId:
  校验 VehicleModelDefinition 存在、未删除、enabled=true
  使用 definition.brand / series / modelName 写入 legacy brand / series / model
  写入 modelDefinitionId

只传 legacy brand / series / model:
  按 brand exact match
  按 modelName exact match OR modelCode exact match
  series 如提供则参与匹配
  唯一匹配时写入 modelDefinitionId
  无匹配或多匹配时返回 400

都未传或 legacy 不完整:
  返回 400
```

历史样本仍可读取和展示；list/detail 不强制历史记录补齐 `modelDefinitionId`。

## 3. CSV Import

CSV import 逐行解析：

```text
modelDefinitionId 优先
无 modelDefinitionId 时尝试 legacy brand / series / model 自动解析
解析失败的行返回 row-level error
失败行不写入
成功行继续写入
```

返回结果继续保留旧字段：

```text
totalRows
importedRows
skippedRows
failedRows
items
```

并新增兼容字段：

```text
createdRows
errors[]
```

CSV 模板继续包含 `modelDefinitionId` 列。legacy-only 导入可以用于兼容，但新导入行不会静默写入空 `modelDefinitionId`。

## 4. Curve Generate

`VehicleResidualCurve` 当前通过生成接口创建。本阶段要求生成新曲线时必须最终解析到 `modelDefinitionId`：

```text
modelDefinitionId 优先
legacy brand / series / model 可自动解析
无法解析返回 400
写入 modelDefinitionId
写入 definition 对应的 legacy brand / series / model
```

样本选择仍兼容历史样本：

```text
sample.modelDefinitionId = input.modelDefinitionId
OR sample.modelDefinitionId IS NULL AND legacy brand / series / model 匹配
```

这样新曲线进入主数据轨道，同时历史 legacy 样本仍能参与生成。

## 5. Residual Model Run

`ResidualModelRun` 支持两类输入：

```text
未指定任何目标车型维度:
  视为全量 / 泛化运行，可不传 targetModelDefinitionId

指定目标车型维度:
  targetModelDefinitionId 优先
  legacy targetBrand / targetSeries / targetModel 可自动解析
  无法解析返回 400
  写入 targetModelDefinitionId
  同步 definition 对应的 targetBrand / targetSeries / targetModel
```

历史 model run 不强制迁移。

## 6. Forecast Lookup

10X-J 不改变 10X-F 已确认的 forecast lookup 优先级：

```text
explicit curveId
> vehicle.modelDefinitionId ACTIVE curve
> legacy brand/model ACTIVE curve
```

新生成 forecast 如 vehicle 已有 `modelDefinitionId`，继续保存 `VehicleResidualForecast.modelDefinitionId` 快照。历史 forecast 不重算。

## 7. Frontend

Residual market 页面调整：

```text
新建市场样本必须选择车型代码主数据
CSV 模板保留 modelDefinitionId 列
curve 生成必须选择车型代码主数据
model run 全量运行可不选目标车型代码
model run 如填写目标车型维度，必须选择目标车型代码主数据
legacy brand / series / model 字段继续展示和自动带出
```

## 8. 不变边界

```text
不删除 legacy brand / series / model
不删除 VehicleModel enum
不强制历史 residual 数据 modelDefinitionId 非空
不重跑全部 residual model
不自动 adopt forecast
不更新 Vehicle.currentSalePriceAmount
不修改 VehicleAssetCostProfile.residualValueAmount
不修改 valuation review 状态机
不修改 ROE / 折旧 / BaaS 主口径
不新增 migration
```

## 9. 后续阶段

建议继续：

```text
Stage 10X-K: VehicleModel enum freeze guard
Stage 10X-L: backfill dry-run / report
Stage 10X-M: enum removal feasibility review
```

## 10. Stage 10X-K 补充

10X-K 已冻结 `VehicleModel` enum，并增加 release / CI guard，防止 residual 新车型再通过 Prisma enum 扩张进入系统。

这不会改变 10X-J 的 residual 规则：

```text
新增 / 导入 residual sample 必须最终写入 modelDefinitionId
新建 / 生成 residual curve 必须最终写入 modelDefinitionId
target-specific model run 必须最终写入 targetModelDefinitionId
历史 residual sample / curve / forecast 继续 legacy fallback
不重算历史 forecast
不自动 adopt residual
不更新车辆销售价
```

后续新增 residual 车型维度应先维护 `VehicleModelDefinition`，而不是新增 `VehicleModel` enum 值。

详见：

```text
docs/stage-10x-vehicle-model-enum-freeze-guard.md
```
