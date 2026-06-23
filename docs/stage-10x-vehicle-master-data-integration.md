# Stage 10X-D Vehicle Master Data Integration

## 1. 目标

Stage 10X-D 将 `VehicleModelDefinition` 以最小安全版本接入车辆管理页和车辆 API。

本阶段采用双轨策略：

```text
VehicleModelDefinition 开始关联 Vehicle
Vehicle.vehicleModel legacy enum 继续保留
历史车辆不强制迁移
Product / Portal / Reports / Residual 暂不接入
```

## 2. 双轨策略

车辆表新增可选字段：

```text
Vehicle.modelDefinitionId
```

它指向 `VehicleModelDefinition`，但不替代 `Vehicle.vehicleModel`。当前车辆创建和编辑仍然必须保证 legacy `VehicleModel` 可写入，因为产品、Portal、报表、残值等模块仍依赖 legacy enum。

## 3. Create 行为

创建车辆时：

```text
传入 modelDefinitionId:
  校验主数据存在、未删除、enabled=true
  校验 legacyVehicleModel 不为空
  如同时传入 vehicleModel，必须与 legacyVehicleModel 一致
  写入 Vehicle.modelDefinitionId
  自动写入 Vehicle.vehicleModel = legacyVehicleModel

未传 modelDefinitionId:
  保持原 legacy vehicleModel 创建逻辑
  Vehicle.modelDefinitionId = null
```

因此，本阶段只有已经映射 `legacyVehicleModel` 的车型主数据可以用于车辆创建。

## 4. Update 行为

编辑车辆时：

```text
传入 modelDefinitionId:
  执行与 create 相同的主数据校验
  同步更新 Vehicle.modelDefinitionId 和 Vehicle.vehicleModel

显式传入 modelDefinitionId = null:
  清除主数据关联
  保留或使用请求中的 legacy vehicleModel

只传 vehicleModel:
  保持原 legacy 更新逻辑
  不自动反查 VehicleModelDefinition
```

不自动反查是为了避免历史车辆被隐式迁移。

## 5. 后台车辆页面变化

`/vehicles` 新增：

```text
车型代码（主数据）选择器
兼容车型（legacy）下拉
```

选择主数据时会自动带出其 `legacyVehicleModel`。如果用户手动选择不一致的 legacy enum，页面会清空主数据关联，避免提交时出现不一致。

列表和详情优先展示 `modelDefinition.displayName`，没有主数据关联时 fallback 到 legacy `vehicleModel` 标签。

## 6. Legacy Fallback

历史车辆无需迁移。无 `modelDefinitionId` 的车辆继续使用：

```text
Vehicle.vehicleModel
VEHICLE_MODEL_LABELS
```

后端返回：

```text
modelDefinitionId
modelDefinition
modelDisplayName
```

其中 `modelDisplayName` 优先来自主数据，缺失时 fallback legacy enum。

## 7. 本阶段不接入的模块

本阶段不修改：

```text
Product / VehiclePackage / ProductPriceRule
Portal catalog
Reports / CSV
Residual market / forecast
ROE / depreciation / BaaS
Payment / write-off / billing
```

这些模块仍按 Stage 10X-B 审计拆分留到后续阶段。

## 8. 为什么只允许已映射 legacy 的主数据

`Vehicle.vehicleModel` 当前仍是业务主链路必需字段。没有 `legacyVehicleModel` 的主数据虽然可以在后台维护，但无法安全写入车辆表的 legacy enum，也无法被现有产品、报表和 Portal 逻辑解释。

因此 10X-D 只允许：

```text
VehicleModelDefinition.enabled = true
VehicleModelDefinition.deletedAt = null
VehicleModelDefinition.legacyVehicleModel != null
```

用于车辆创建和编辑。

## 9. Migration

本阶段新增 migration：

```text
20260624110000_vehicle_model_definition_on_vehicle
```

仅新增 nullable `Vehicle.modelDefinitionId`、索引和外键，不修改 `Vehicle.vehicleModel`，不迁移历史车辆。

## 10. 后续阶段

建议继续：

```text
Stage 10X-E: Portal / Product / Reports 接入车型主数据
Stage 10X-F: Residual market / forecast 接入车型主数据
Stage 10X-G: legacy enum 退场评估
```

