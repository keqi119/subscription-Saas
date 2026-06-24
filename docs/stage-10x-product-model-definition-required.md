# Stage 10X-I Product Model Definition Required

## 1. 目标

Stage 10X-I 将 Product / Package / Price Rule 的新建流程推进到 `modelDefinitionId first`：

```text
VehiclePackage 新建最终必须写入 modelDefinitionId
ProductPriceRule 新建最终必须写入 modelDefinitionId
legacy vehicleModel 继续保留并自动同步
历史 Product / Package / PriceRule 不强制迁移
Quote / Order 历史快照不修改
```

本阶段不删除 `VehicleModel` enum，不修改 `Vehicle.vehicleModel` 类型，不调整 Portal / Reports / Residual 逻辑，也不改变 ROE、折旧、BaaS、支付、核销、账单、合同或工单主逻辑。

## 2. 为什么需要主数据

Stage 10X-E 已经让 `VehiclePackage` 和 `ProductPriceRule` 支持 nullable `modelDefinitionId`。10X-I 的变化是阻止新产品配置继续产生缺失车型主数据的记录。

原因：

```text
车辆新建在 10X-H 已要求最终写入 modelDefinitionId
产品配置仍只落 legacy vehicleModel 会继续制造双轨漂移
报价匹配需要继续兼容 legacy，但新规则应有可解释的车型代码来源
ProductPriceRule 当前仍以 vehicleModel 作为唯一约束的一部分，因此 legacy 字段暂不能删除
```

## 3. VehiclePackage Create

创建车型包时：

```text
传 modelDefinitionId:
  校验 VehicleModelDefinition 存在、未删除、enabled=true
  校验 legacyVehicleModel 不为空
  如同时传 vehicleModel，必须与 legacyVehicleModel 一致
  写入 modelDefinitionId
  写入 vehicleModel = definition.legacyVehicleModel

只传 legacy vehicleModel:
  通过 VehicleModelDefinition.legacyVehicleModel 自动解析
  解析成功后写入 modelDefinitionId 和 vehicleModel
  解析失败返回 400

两者都不传:
  返回 400
```

当前 schema 中 `VehiclePackage.vehicleModel` 是必填字段，业务上不存在无车型范围的车型包，因此新建车型包必须最终绑定车型主数据。

## 4. VehiclePackage Update

更新车型包时：

```text
传 modelDefinitionId:
  校验并同步 legacy vehicleModel

只传 legacy vehicleModel:
  自动解析并同步 modelDefinitionId

显式传 modelDefinitionId = null:
  返回 400，不允许清除车型代码主数据

历史记录原本无 modelDefinitionId，且本次不改车型:
  允许保存其他字段，不强制迁移

历史记录原本无 modelDefinitionId，且本次改车型:
  必须解析并同步 modelDefinitionId
```

## 5. ProductPriceRule Create / Update

当前 `ProductPriceRule.vehicleModel` 是必填字段，且存在：

```text
@@unique([productVersionId, vehicleModel])
```

因此现阶段没有真正的全局价格规则。新建价格规则时必须最终写入 `modelDefinitionId`；legacy-only 调用会自动解析，无法解析则返回 400。

更新价格规则时沿用车型包规则：

```text
modelDefinitionId 优先
legacy vehicleModel 自动解析
不允许显式清空已有车型主数据
历史记录不改车型时可继续保存其他字段
```

未来若要支持全局价格规则，应先调整 schema 和唯一约束，再单独设计规则优先级；10X-I 不做该变更。

## 6. Legacy Fallback

本阶段保留 Stage 10X-E 的双轨匹配：

```text
modelDefinitionId 精确匹配优先
vehicleModel legacy fallback 保留
车辆有 modelDefinitionId、旧 package/rule 只有 vehicleModel 时仍可匹配
package/rule 有 modelDefinitionId、旧车辆只有 vehicleModel 时仍可通过 legacyVehicleModel fallback 匹配
```

`VehicleModel` enum 继续作为兼容字段和报价 / 订单旧链路的保护网。

## 7. 后台产品页面

后台产品页中车型包表单调整为：

```text
新建车型包必须选择“车型代码（主数据）”
车型代码选项只展示 enabled=true 且 legacyVehicleModel 不为空的主数据
选择车型代码后自动带出兼容车型
legacy 车型下拉降级为只读兼容字段
编辑历史车型包时，如无 modelDefinitionId，会显示兼容提示，但不强制迁移
```

本阶段未改 Portal catalog、Reports 或 Residual 页面。

## 8. Seed / Scenario

Baseline product seed 直接写入 `VehiclePackage.modelDefinitionId` 和 `ProductPriceRule.modelDefinitionId`，并要求 ET5 legacy 映射已存在。

Scenario seed 当前不直接创建 `VehiclePackage` 或 `ProductPriceRule`，因此无需额外改动。

## 9. 不变边界

```text
不删除 VehicleModel enum
不修改 Quote / Order 历史快照
不迁移历史 Product / Package / PriceRule
不修改 Portal / Reports / Residual
不修改 ProductPriceRule 唯一约束
不修改 ROE / 折旧 / BaaS / 支付 / 核销
不新增 migration
```

## 10. 后续阶段

建议继续：

```text
Stage 10X-J: Residual 新建 sample / curve 强制车型主数据
Stage 10X-K: VehicleModel enum freeze guard
Stage 10X-L: backfill dry-run / report
```
