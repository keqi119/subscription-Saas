# Stage 10X-E Portal / Product / Reports Model Master Data

## 1. 目标

Stage 10X-E 将 `VehicleModelDefinition` 接入 Product、Portal catalog 和 Reports，继续保持双轨兼容：

```text
modelDefinitionId 优先
legacy VehicleModel fallback 保留
VehicleModel enum 不删除
历史 Quote / Order 快照不迁移
Residual market 留到 Stage 10X-F
```

本阶段不修改 ROE、折旧、BaaS、支付、核销、账单、合同、权益或工单主逻辑。

## 2. Product / Package 双轨接入

`VehiclePackage` 和 `ProductPriceRule` 新增 nullable `modelDefinitionId` 外键，保留原 `vehicleModel` enum 字段。

创建或更新产品配置时：

```text
传 modelDefinitionId:
  校验 VehicleModelDefinition 存在、未删除、enabled=true
  校验 legacyVehicleModel 不为空
  如果同时传 vehicleModel，必须与 legacyVehicleModel 一致
  写入 modelDefinitionId
  同步 legacy vehicleModel = legacyVehicleModel

不传 modelDefinitionId:
  保持原 legacy vehicleModel 行为

显式传 modelDefinitionId = null:
  清除主数据关联
  保留 legacy vehicleModel
```

后台产品页面增加“车型代码（主数据）”选择器，选项来自：

```text
GET /api/vehicle-model-definitions?enabled=true&pageSize=100
```

列表优先展示 `modelDefinition.displayName`，没有主数据时 fallback 到 `VEHICLE_MODEL_LABELS[vehicleModel]`。

## 3. Portal Catalog 展示和筛选

Portal catalog 车辆列表和详情返回：

```text
modelDefinition
modelDefinitionId
modelDisplayName
customerModelDisplayName
vehicleModel
```

展示优先级：

```text
modelDefinition.customerDisplayName
modelDefinition.displayName
legacy VehicleModel label
```

新增筛选参数：

```text
modelDefinitionId
```

过滤逻辑：

```text
vehicle.modelDefinitionId = modelDefinitionId
OR vehicle.modelDefinitionId IS NULL AND vehicle.vehicleModel = definition.legacyVehicleModel
```

`vehicleModel` legacy 筛选继续保留。若 `modelDefinitionId` 和 `vehicleModel` 同时传入且不一致，返回 400。

筛选选项只返回：

```text
deletedAt = null
enabled = true
portalVisible = true
```

disabled / portalVisible=false 的历史关联车辆仍可展示名称，但不会出现在 Portal 筛选选项中。

## 4. Reports 展示、筛选和 CSV

综合报表、资产经营分析及明细导出支持：

```text
modelDefinitionId
vehicleModel legacy filter
```

过滤逻辑与 Portal 一致：

```text
vehicle.modelDefinitionId = modelDefinitionId
OR legacy fallback vehicleModel = definition.legacyVehicleModel
```

同时传入 `modelDefinitionId` 和 `vehicleModel` 时校验一致；不一致返回 400。

报表列表 / 明细返回：

```text
modelDefinition
modelDefinitionId
modelDisplayName
```

CSV 输出增加或调整为：

```text
车型代码
车型显示名
legacy 车型
```

旧 `vehicleModel` 字段仍保留，供历史兼容和 legacy 筛选使用。

## 5. Legacy Fallback

Stage 10X-E 不要求历史数据补齐主数据关联。无 `modelDefinitionId` 的车辆、车型包或价格规则继续使用：

```text
VehicleModel enum
VEHICLE_MODEL_LABELS
vehicleModel filter
```

新规则若绑定 `modelDefinitionId`，仍会同步写入 `legacyVehicleModel`，避免旧链路失配。

## 6. 本阶段不接入范围

本阶段明确不修改：

```text
ResidualMarketSample
VehicleResidualCurve
VehicleResidualForecast
VehicleResidualForecastPoint
VehicleValuationReview
SubscriptionQuote / SubscriptionOrder 历史快照
ROE / 折旧 / BaaS 公式
支付 / 核销 / 账单 / 合同 / 权益 / 工单主逻辑
```

## 7. Migration

新增 migration：

```text
20260624123000_product_model_definition_links
```

仅新增：

```text
VehiclePackage.modelDefinitionId nullable FK
ProductPriceRule.modelDefinitionId nullable FK
index / foreign key
```

不修改已有 `vehicleModel`，不迁移历史产品配置。

## 8. 后续阶段

建议继续：

```text
Stage 10X-F: Residual market / forecast 接入车型主数据
Stage 10X-G: legacy enum 退场评估
```

10X-F 仍应遵循：

```text
modelDefinitionId 优先
legacy brand / series / model fallback
不破坏历史曲线和样本
不自动重算旧预测
```

## 9. Stage 10X-F 完成后状态

Stage 10X-F 已完成 Residual market / forecast 接入车型主数据：

```text
Residual market sample 支持 modelDefinitionId
Residual curve 支持 modelDefinitionId
Residual forecast 保存 modelDefinitionId 快照
ResidualModelRun 支持 targetModelDefinitionId
Vehicle valuation review 展示优先 modelDefinition.displayName
```

10X-F 仍未改变 10X-E 的边界：`VehicleModel` enum、legacy filter、Quote / Order 历史快照继续保留。

详见：

```text
docs/stage-10x-model-master-data-residual-market.md
```

## 10. Stage 10X-I 完成后状态

Stage 10X-I 在 10X-E 的 Product 双轨基础上继续收紧新流程：

```text
VehiclePackage 新建最终必须写入 modelDefinitionId
ProductPriceRule 新建最终必须写入 modelDefinitionId
legacy-only create 会通过 VehicleModelDefinition.legacyVehicleModel 自动解析
显式清空已有 modelDefinitionId 会返回 400
历史 Product / Package / PriceRule 不强制迁移
```

10X-I 仍保留 `VehicleModel` enum、legacy matching fallback 和 Quote / Order 历史快照。

详见：

```text
docs/stage-10x-product-model-definition-required.md
```
