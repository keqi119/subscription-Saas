# Stage 10X-H 新建车辆 ModelDefinition 必填

## 1. 目标

Stage 10X-H 是 legacy enum 冻结路线的第一步：不删除 `VehicleModel` enum，不修改 `Vehicle.vehicleModel` 类型，但要求新建车辆最终必须写入 `modelDefinitionId`，避免继续产生缺失车型主数据的新车辆记录。

本阶段只覆盖车辆创建和车辆编辑入口，不修改 Product / Portal / Reports / Residual / Quote / Order，也不迁移历史车辆。

## 2. Create 行为

创建车辆时采用 `modelDefinitionId` first：

```text
传入 modelDefinitionId:
  校验 VehicleModelDefinition 存在、未删除、enabled=true
  校验 legacyVehicleModel 不为空
  如同时传 vehicleModel，必须与 legacyVehicleModel 一致
  写入 Vehicle.modelDefinitionId
  写入 Vehicle.vehicleModel = definition.legacyVehicleModel

只传 legacy vehicleModel:
  后端通过 VehicleModelDefinition.legacyVehicleModel 自动解析
  匹配到唯一且 enabled 的主数据后写入 modelDefinitionId
  匹配不到返回 400

modelDefinitionId 和 vehicleModel 都未传:
  返回 400
```

错误边界：

```text
车型代码主数据缺失，无法创建车辆。请先维护车型代码。
请选择车型代码。
```

## 3. Update 行为

编辑车辆时不强制历史车辆立即补齐 `modelDefinitionId`，但不再允许主动清空车型主数据。

```text
传入 modelDefinitionId:
  校验存在、未删除、enabled=true、legacyVehicleModel 不为空
  同步 Vehicle.modelDefinitionId 和 Vehicle.vehicleModel

显式传入 modelDefinitionId = null:
  返回 400
  不允许清除已有车型代码主数据

只传 vehicleModel:
  通过 legacyVehicleModel 自动解析 VehicleModelDefinition
  解析成功则同步 modelDefinitionId
  解析失败返回 400

未传 modelDefinitionId 且未传 vehicleModel:
  保持现有车型字段不变
```

这保证历史车辆可以继续读取和编辑非车型字段，同时当车型被修改时不会继续产生主数据漂移。

## 4. Web 车辆页面

`/vehicles` 新建车辆表单调整为：

```text
车型代码（主数据）必填
只展示 enabled=true 且 legacyVehicleModel != null 的车型主数据
选择车型代码后自动带出兼容 vehicleModel
兼容车型字段作为只读兼容展示
```

编辑历史车辆时：

```text
已有 modelDefinitionId 的车辆正常显示主数据
无 modelDefinitionId 的历史车辆显示补充车型代码提示
不强制用户打开编辑页就迁移
选择主数据后保存会同步 modelDefinitionId
```

## 5. Seed / Scenario Seed

主 seed 和 scenario seed 直接使用 Prisma 写车辆，不经过 `VehicleService`，因此本阶段显式连接车型主数据：

```text
seed.mjs demoVehicles:
  通过 demo vehicleModel 反查 enabled VehicleModelDefinition
  create/update 车辆时 connect modelDefinition

seed-scenario.mjs:
  场景车辆 ET5 创建前反查 VehicleModelDefinition
  create 车辆时 connect modelDefinition
```

如果缺少对应主数据，seed 会失败并提示先维护车型代码。

## 6. Legacy Fallback

本阶段继续保留：

```text
Vehicle.vehicleModel
VehicleModel enum
VEHICLE_MODEL_LABELS fallback
历史车辆 modelDefinitionId = null 的读取和展示
```

无 `legacyVehicleModel` 的 `VehicleModelDefinition` 可以继续维护，但暂不能用于车辆创建，因为当前 `Vehicle.vehicleModel` 仍是必填 legacy enum 字段。

## 7. 本阶段不做

```text
不删除 VehicleModel enum
不修改 Vehicle.vehicleModel 类型
不迁移历史车辆
不修改 Product / VehiclePackage / ProductPriceRule
不修改 Portal catalog
不修改 Reports
不修改 Residual market / forecast
不修改 SubscriptionQuote / SubscriptionOrder 快照
不新增 modelDefinition snapshot
不修改 ROE / 折旧 / BaaS
不修改支付 / 核销 / 账单 / 合同 / 工单主逻辑
```

## 8. 后续阶段

```text
Stage 10X-I: Product / Package 新建规则 modelDefinitionId 必填
Stage 10X-J: Residual 新建 sample / curve modelDefinitionId 必填
Stage 10X-K: legacy enum freeze guard
Stage 10X-L: backfill dry-run / report
Stage 10X-M: enum removal feasibility review
```

10X-H 完成后，系统不再通过车辆创建入口产生新的 `modelDefinitionId` 缺失记录，后续阶段可以逐步把产品、价格规则和残值新建流程收紧到同一标准。
