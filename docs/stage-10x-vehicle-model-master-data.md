# Stage 10X-C Vehicle Model Master Data

## 1. 目标

Stage 10X-C 新增车型代码主数据基础能力，让后台可以维护 `VehicleModelDefinition`，为后续从 Prisma enum 车型代码迁移到可运营主数据做准备。

本阶段只上线主数据表、CRUD API、后台页面、权限、菜单、seed 和测试，不接入车辆新增 / 编辑，不迁移历史车辆，也不改产品、Portal、报表或残值模块。

## 2. 为什么需要车型代码主数据

当前车型代码仍由 `VehicleModel` Prisma enum 和前端硬编码选项管理。每次新增车型都需要改 schema、migration、前端 options、labels、seed 和测试，无法支撑二手车多品牌、多车系、多年款持续扩展。

主数据化后的目标是：车型代码由后台维护，车辆、车型包、Portal catalog、残值市场和报表逐步读取统一的车型主数据。

## 3. VehicleModelDefinition 字段

新增模型：`VehicleModelDefinition`。

核心字段：

```text
modelCode             唯一、稳定业务代码，例如 ET5 / ET5T / ES8
legacyVehicleModel    可选且唯一，用于映射当前 VehicleModel enum
brand                 品牌，必填
series                车系
modelName             车型，必填
modelYear             年款，可选
variantName           版本，可选
displayName           后台显示名称，必填
customerDisplayName   客户侧显示名称
enabled               默认 true
portalVisible         默认 false
sortOrder             排序
```

补充字段包括能源类型、车身类型、座位数、驱动形式、电池容量、官方续航、备注、snapshot、创建 / 更新 / 软删审计字段。

## 4. legacyVehicleModel 映射

本阶段保留 `VehicleModel` enum，并通过 `legacyVehicleModel` 建立可选映射。该字段用于双轨过渡，不会修改 `Vehicle.vehicleModel`。

唯一性规则：

```text
modelCode 全局唯一
legacyVehicleModel 可空且唯一
soft delete 后 modelCode 仍不复用
```

## 5. 初始 Seed

`pnpm prisma:seed` 初始化当前 8 个 legacy enum 映射：

| modelCode | legacyVehicleModel | brand | series | displayName |
| --- | --- | --- | --- | --- |
| ET5 | ET5 | NIO | ET | ET5 |
| ET5T | ET5T | NIO | ET | ET5T |
| ET7 | ET7 | NIO | ET | ET7 |
| EC6 | EC6 | NIO | EC | EC6 |
| ES6 | ES6 | NIO | ES | ES6 |
| ES8 | ES8 | NIO | ES | ES8 |
| ET9 | ET9 | NIO | ET | ET9 |
| ES9 | ES9 | NIO | ES | ES9 |

seed 使用 upsert，不删除人工新增主数据，不覆盖 remark。品牌 / 车系是当前内部映射建议，后续可在后台调整。

## 6. 后台页面

新增页面：

```text
/vehicle-model-definitions
```

功能：

```text
列表
搜索
品牌 / 车系筛选
启用状态筛选
客户侧可见筛选
新建
编辑
启用 / 停用
归档 soft delete
```

页面提示当前车辆新增 / 编辑仍使用 legacy `VehicleModel` enum，Stage 10X-D 再接入车辆管理。

## 7. 权限 / 菜单

新增权限：

```text
vehicle_model:view
vehicle_model:manage
```

角色默认：

```text
ADMIN: all
OP: view/manage
FI: view/manage
GM: view
SA: view
```

当前系统没有“基础资料”一级菜单，因此本阶段先放在：

```text
车辆资产 -> 车型代码
```

seed 后需要重新登录后台刷新 token。

## 8. 本阶段不接入车辆主流程

本阶段明确不做：

```text
不修改 Vehicle.model
不新增 Vehicle.modelDefinitionId
不修改车辆新增 / 编辑页面车型下拉
不迁移历史车辆
不修改产品 / 套餐 / Portal / 报表 / 残值
不移除 VehicleModel enum
```

## 9. 后续阶段

建议继续：

```text
Stage 10X-D：车辆管理页接入车型主数据
Stage 10X-E：Portal / 产品 / 报表接入车型主数据
Stage 10X-F：残值市场接入车型主数据
Stage 10X-G：legacy enum 退场评估
```

## 10. Stage 10X-D 更新

Stage 10X-D 已开始把车型主数据接入车辆管理：

```text
Vehicle 新增可选 modelDefinitionId
车辆 create / update 支持 modelDefinitionId
选择主数据时自动同步 legacy VehicleModel
车辆列表 / 详情返回 modelDefinition 摘要
/vehicles 页面增加车型代码（主数据）选择器
```

当前仍保留双轨策略：

```text
Vehicle.vehicleModel enum 继续保留
历史车辆不强制迁移
未映射 legacyVehicleModel 的主数据暂不能用于车辆创建 / 编辑
Product / Portal / Reports / Residual 留到后续阶段接入
```

详见：

```text
docs/stage-10x-vehicle-master-data-integration.md
```

## 11. Stage 10X-E 更新

Stage 10X-E 已将车型主数据接入 Product、Portal catalog 和 Reports：

```text
Product / VehiclePackage / ProductPriceRule 支持可选 modelDefinitionId
Portal catalog 返回 modelDefinition、modelDisplayName、customerModelDisplayName
Portal catalog 支持 modelDefinitionId 筛选并保留 vehicleModel legacy filter
Reports 查询、展示和 CSV 支持 modelDefinitionId
CSV 输出车型代码、车型显示名、legacy 车型
```

仍保留双轨边界：

```text
VehicleModel enum 不删除
legacy VehicleModel fallback 不删除
SubscriptionQuote / SubscriptionOrder 历史快照不迁移
Residual market / forecast 留到 Stage 10X-F
```

详见：

```text
docs/stage-10x-model-master-data-portal-product-reports.md
```
