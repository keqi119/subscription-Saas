# Stage 10X-B Vehicle Model Master Data Audit

## 1. 背景

Stage 10X-A 已经完成 `VehicleModel` enum 漂移收口，将 `ET5T`、`EC6`、`ES8`、`ET9`、`ES9` 纳入 Prisma schema、migration、前端 options、labels 和测试。当前系统可以继续录入 ROE 样例车辆，但车型代码仍然依赖 Prisma enum 和前端硬编码列表。

本阶段只做影响审计和迁移设计，不修改业务代码，不修改 Prisma schema，不新增 migration，不新增 `VehicleModelDefinition`，不修改历史车辆数据。

## 2. 当前 Enum 现状

当前 `VehicleModel` 定义在 `apps/api/prisma/schema.prisma`：

```prisma
enum VehicleModel {
  ET5
  ET5T
  ET7
  ES6
  EC6
  ES8
  ET9
  ES9

  @@map("vehicle_model")
}
```

数据库 enum 已通过 `20260623170000_vehicle_model_codes` 迁移收口，迁移使用 `ALTER TYPE "vehicle_model" ADD VALUE IF NOT EXISTS ...`，兼容数据库已手工存在 enum 值的场景。

schema 中直接使用 `VehicleModel` enum 的核心字段：

| 模型 | 字段 | 当前含义 | 风险 |
| --- | --- | --- | --- |
| `VehiclePackage` | `vehicleModel` | 车型包适用车型 | High |
| `ProductPriceRule` | `vehicleModel` | 旧报价规则适用车型 | Medium |
| `Vehicle` | `vehicleModel` | 车辆资产车型代码 | High |
| `SubscriptionQuote` | `vehicleModel` | 报价快照车型 | High |
| `SubscriptionOrder` | `vehicleModel` | 订单快照车型 | High |

相关但非 enum 字段：

| 模型 | 字段 | 当前含义 |
| --- | --- | --- |
| `Application` | `intendedModel String?` | 进件意向车型，已是字符串 |
| `VehicleMarketPriceObservation` | `brand/series/model/modelYear/trim` | 残值市场样本维度 |
| `VehicleResidualCurve` | `brand/series/model/modelYear/trim` | 残值曲线维度 |
| `VehicleResidualForecast` | `brand/series/model/modelYear/trim` | 残值预测快照维度 |

## 3. 使用点清单

### 后端使用点

强依赖 enum 或 `vehicleModel` 字段的后端文件：

```text
apps/api/prisma/schema.prisma
apps/api/src/vehicle/dto/vehicle.dto.ts
apps/api/src/vehicle/vehicle.service.ts
apps/api/src/product/dto/product.dto.ts
apps/api/src/product/product.service.ts
apps/api/src/customer/customer.service.ts
apps/api/src/order/order.service.ts
apps/api/src/portal/portal-catalog.service.ts
apps/api/src/portal/portal-application.service.ts
apps/api/src/portal/portal-billing.service.ts
apps/api/src/report/dto/report.dto.ts
apps/api/src/report/report.service.ts
apps/api/src/vehicle/vehicle-listing.service.ts
apps/api/src/vehicle-asset-pool/vehicle-asset-pool.service.ts
apps/api/src/financing/financing.service.ts
apps/api/src/finance/finance.service.ts
apps/api/src/esign/esign.service.ts
apps/api/src/service-case/service-case.service.ts
```

重点依赖方式：

- `CreateVehicleDto` / `UpdateVehicleDto` 用 `@IsEnum(VehicleModel)` 校验车辆车型代码。
- `CreateVehiclePackageDto` / `CreatePriceRuleDto` / `CreateQuoteDto` 用 `VehicleModel` 约束套餐和报价输入。
- `ProductService` 用 `vehicle.vehicleModel === plan.vehiclePackage.vehicleModel` 判断车辆是否适用套餐。
- `CustomerService` / `OrderService` 在自助进件、方案确认、下单、订单变更中校验车型匹配。
- `PortalCatalogService` 用车辆 `vehicleModel` fallback 查找可用套餐。
- `ReportService` 用 `vehicleModel` 做订单、车辆资产、资产收益过滤、分组和 CSV 输出。
- `ESignService`、`PortalApplicationService`、`PortalBillingService`、`FinanceService`、`FinancingService`、`ServiceCaseService` 主要作为展示 / 快照字段使用。

### 前端使用点

车型下拉、展示和筛选相关文件：

```text
apps/web/src/app/vehicles/page.tsx
apps/web/src/app/products/page.tsx
apps/web/src/app/reports/page.tsx
apps/web/src/app/reports/asset-profitability/page.tsx
apps/web/src/constants/labels.ts
```

前端展示 / 快照引用相关文件：

```text
apps/web/src/app/applications/[id]/page.tsx
apps/web/src/app/contracts/[id]/page.tsx
apps/web/src/app/financing-instruments/page.tsx
apps/web/src/app/orders/page.tsx
apps/web/src/app/orders/[id]/page.tsx
apps/web/src/app/orders/review/page.tsx
apps/web/src/app/products/page.tsx
apps/web/src/app/quotes/page.tsx
apps/web/src/app/quotes/[id]/page.tsx
apps/web/src/app/revenue-rights/page.tsx
apps/web/src/app/vehicle-asset-pools/page.tsx
apps/web/src/lib/portal-types.ts
```

当前硬编码：

```text
vehicleModelOptions = ["ET5", "ET5T", "ET7", "ES6", "EC6", "ES8", "ET9", "ES9"]
VEHICLE_MODEL_LABELS
CreateVehicleValues.vehicleModel union type
```

### Seed 使用点

```text
apps/api/prisma/seed.mjs
apps/api/prisma/seed-scenario.mjs
apps/api/prisma/verify-seed-baseline.mjs
```

seed 当前主要使用 `ET5`、`ET7`、`ES6` 构造 demo 车辆、车型包、订阅套餐、报价、订单、残值曲线和场景数据。

### Tests 使用点

`apps/api/test` 中至少 36 个测试文件包含 `VehicleModel`、`vehicleModel` 或固定车型代码。高影响测试包括：

```text
apps/api/test/vehicle-model.spec.ts
apps/api/test/subscription-plan.spec.ts
apps/api/test/product-quote.spec.ts
apps/api/test/order-review.spec.ts
apps/api/test/order-change-execute.spec.ts
apps/api/test/customer-order.spec.ts
apps/api/test/customer-view.spec.ts
apps/api/test/self-service-application.spec.ts
apps/api/test/portal-application.spec.ts
apps/api/test/portal-catalog.spec.ts
apps/api/test/report.spec.ts
apps/api/test/residual-market.spec.ts
apps/api/test/vehicle-valuation-review.spec.ts
apps/api/test/vehicle-listing.spec.ts
```

### Docs 使用点

```text
README.md
docs/reporting-metrics.md
docs/residual-market-user-guide.md
docs/stage-10n-c-d-roe-sample-validation.md
docs/stage-10x-vehicle-model-enum-drift-closure.md
```

## 4. 模块影响矩阵

| 模块 | 当前依赖方式 | UI 改造 | API / DTO 改造 | 历史数据迁移 | 风险 | 建议阶段 |
| --- | --- | --- | --- | --- | --- | --- |
| 车辆资产台账 | `Vehicle.vehicleModel` enum + `brand/series/model` 字段 | 是 | 是，新增 `modelDefinitionId` | 是，回填可选 relation | High | 10X-D |
| 车辆新增 / 编辑 | 前端硬编码下拉，后端 `@IsEnum(VehicleModel)` | 是 | 是 | 否，短期双写 | High | 10X-D |
| 车辆商品发布 | 商品页显示 `brand/series/model/vehicleModel`，套餐匹配依赖 enum | 中 | 可能需要返回 displayName | 否 | Medium | 10X-E |
| Portal catalog | 按车辆 enum 找可用套餐，展示使用车型文本 | 中 | 是，返回 `modelDefinition` 摘要 | 否 | High | 10X-E |
| 车型包 / 产品套餐 | `VehiclePackage.vehicleModel` enum 是强匹配条件 | 是 | 是，新增车型主数据关联 | 是，回填车型包 relation | High | 10X-C / 10X-D |
| 订阅计划 | 经由 `VehiclePackage` 间接依赖车型 | 低 | 低 | 跟随车型包 | Medium | 10X-D |
| 报价 / 订单 | `SubscriptionQuote.vehicleModel`、`SubscriptionOrder.vehicleModel` 是快照字段 | 低 | 查询 / 输出兼容新字段 | 不建议改历史快照 | High | 10X-E |
| 进件 | `Application.intendedModel` 已是 string，快照中包含车型 | 中 | 可新增 `intendedModelDefinitionId` | 可选 | Medium | 10X-E |
| 残值市场样本 | `brand/series/model/year/trim` 字符串维度 | 是 | 可新增 relation 或映射字段 | 可选 | Medium | 10X-F |
| 残值曲线 / 预测 | 按 brand/series/model 匹配曲线 | 是 | 可新增 `modelDefinitionId` 筛选 | 可选 | Medium | 10X-F |
| 估值复核 | 主要展示车辆 `brand/series/model` 和预测 | 低 | 返回主数据 displayName | 否 | Low | 10X-F |
| 资产收益报表 | `vehicleModel` filter/group/CSV | 是 | 是，新增 `modelDefinitionId` filter | 否，保留 legacy filter | High | 10X-E |
| 综合报表 | `vehicleModel` filter/group/CSV | 是 | 是 | 否 | High | 10X-E |
| 车辆保单 / 权证 | 只展示车辆摘要中的车型 | 低 | 返回 displayName | 否 | Low | 10X-E |
| BaaS / 折旧 | 主要关联 vehicleId，不用车型判定 | 低 | 无或仅展示 | 否 | Low | 10X-E |
| ServiceCase | 车辆摘要展示车型 | 低 | 返回 displayName | 否 | Low | 10X-E |
| seed / scenario seed | 固定 enum 值和 ET5 demo 数据 | 否 | 脚本适配主数据 seed | 是，主数据基础 seed | High | 10X-C |
| 测试 | 大量 fixture 使用 `VehicleModel.ET5` | 否 | 分阶段更新 fixture | 否 | High | 各阶段同步 |
| 权限 / 菜单 | 暂无车型主数据权限 | 是 | 新权限 `vehicle_model:*` | 否 | Medium | 10X-C |

## 5. 推荐主数据模型

建议新增模型方向：`VehicleModelDefinition`。

建议字段：

```text
id                         String @id @default(uuid())
modelCode                  String @unique
brand                      String
series                     String?
modelName                  String
modelYear                  Int?
variantName                String?
displayName                String?
customerDisplayName        String?
manufacturer               String?
generation                 String?
energyType                 String?
bodyType                   String?
seatCount                  Int?
batteryCapacityKwh         Decimal?
officialRangeKm            Int?
driveType                  String?
marketSegment              String?
enabled                    Boolean @default(true)
portalVisible              Boolean @default(true)
sortOrder                  Int @default(0)
aliases                    Json?
residualMappingSnapshot    Json?
remark                     String?
createdAt                  DateTime @default(now())
updatedAt                  DateTime @updatedAt
deletedAt                  DateTime?
createdBy                  String?
updatedBy                  String?
```

字段建议：

- `modelCode` 必须唯一，作为内部稳定代码，建议继续使用 `ET5` / `ET5T` 这类短码。
- `brand`、`modelName` 必填；`series` 建议必填但可在首期允许为空，便于兼容多品牌数据质量。
- `modelYear` 不建议首期必填。二手车业务中同一车型可能跨年款，年款更适合作为车辆资产或 variant 维度。
- `manufacturer`、`generation`、`variantName`、`customerDisplayName` 建议预留。
- `batteryCapacityKwh`、`officialRangeKm`、`seatCount` 作为默认参数，不应覆盖车辆资产实际值。
- `portalVisible` 控制客户侧筛选 / 展示候选，`enabled` 控制后台是否可选。
- `aliases` 可存历史名称、外部平台名称、导入别名。
- `residualMappingSnapshot` 可预留残值市场字段映射，但不应首期绑定模型逻辑。

## 6. 迁移方案比较

### 方案 A：双轨过渡，推荐

做法：

```text
保留 Vehicle.model enum
新增 VehicleModelDefinition
新增 Vehicle.modelDefinitionId
VehiclePackage / ProductPriceRule 后续新增 modelDefinitionId
新流程优先选择 modelDefinitionId
旧数据继续保留 enum
报表 / Portal / 产品匹配优先读 modelDefinitionId，fallback enum
稳定后再评估 enum 退场
```

优点：

- 风险最低，不一次性改所有强依赖模块。
- 历史报价、订单、报表快照可以继续解释。
- controlled beta 不受影响。
- 可按模块逐步迁移前端下拉、产品、Portal、报表、残值。

缺点：

- 过渡期会存在 enum 与主数据双字段。
- 需要明确优先级和一致性校验。

### 方案 B：直接 enum -> string

做法：

```text
Vehicle.vehicleModel 改为 String
后台用 VehicleModelDefinition 校验 modelCode
产品 / 报表 / 订单继续存 modelCode 字符串
```

优点：

- schema 看起来简单。
- 新增车型不再需要 enum migration。

风险：

- 会弱化数据库约束，脏数据风险上升。
- 产品套餐、报价、订单匹配仍然是字符串匹配，无法表达车型主数据属性。
- 大量 DTO / 测试 / 查询需要一次性更新。

### 方案 C：直接替换为 relation

做法：

```text
Vehicle.modelDefinitionId 必填
VehiclePackage.modelDefinitionId 必填
SubscriptionQuote / SubscriptionOrder 改 relation 或强制快照主数据
删除或弃用 VehicleModel enum
一次性迁移全部历史数据
```

优点：

- 目标态清晰。
- 数据关系最规范。

风险：

- 爆破半径最大，涉及车辆、产品、报价、订单、Portal、报表和测试。
- 历史快照和财务报表可解释性风险高。
- 不适合当前 controlled beta 阶段。

推荐：方案 A，双轨过渡。

## 7. 推荐方案

推荐采用双轨过渡：

```text
短期：
  保留 VehicleModel enum 和现有 vehicleModel 字段
  新增 VehicleModelDefinition
  新增可选 modelDefinitionId
  新数据优先关联 modelDefinitionId
  对缺失 relation 的历史数据 fallback enum

中期：
  车辆管理、车型包、产品套餐、Portal catalog、报表逐步接入 modelDefinitionId
  输出 DTO 同时返回 legacy vehicleModel 和 modelDefinition 摘要
  查询接口同时支持 modelDefinitionId 和 legacy vehicleModel

长期：
  评估 enum 是否只作为 legacy 字段保留
  历史 quote/order 不做 destructive rewrite
  新 quote/order 快照保存 modelDefinitionId + modelCode + displayName
```

## 8. 历史数据映射建议

以下仅为当前代码语义下的内部映射建议，不确认外部事实；品牌、车系、展示名需要业务确认。

| modelCode | brand | series | modelName | defaultDisplayName | 备注 |
| --- | --- | --- | --- | --- | --- |
| `ET5` | NIO | ET | ET5 | 蔚来 ET5 | requires business confirmation |
| `ET5T` | NIO | ET | ET5T | 蔚来 ET5T | requires business confirmation |
| `ET7` | NIO | ET | ET7 | 蔚来 ET7 | requires business confirmation |
| `EC6` | NIO | EC | EC6 | 蔚来 EC6 | requires business confirmation |
| `ES6` | NIO | ES | ES6 | 蔚来 ES6 | requires business confirmation |
| `ES8` | NIO | ES | ES8 | 蔚来 ES8 | requires business confirmation |
| `ET9` | NIO | ET | ET9 | 蔚来 ET9 | requires business confirmation |
| `ES9` | NIO | ES | ES9 | 蔚来 ES9 | requires business confirmation |

迁移原则：

- 对 `Vehicle.vehicleModel` 非空的历史车辆，按 `modelCode` 回填 `Vehicle.modelDefinitionId`。
- 对 `VehiclePackage.vehicleModel`、`ProductPriceRule.vehicleModel` 可按 `modelCode` 回填 relation，但保留原 enum 字段。
- 对 `SubscriptionQuote.vehicleModel`、`SubscriptionOrder.vehicleModel` 不建议重写历史快照，只在新数据中补充主数据快照。

## 9. API / DTO 迁移建议

### 车辆 API

短期：

```text
CreateVehicleDto / UpdateVehicleDto 继续接受 vehicleModel
新增可选 modelDefinitionId
后端校验 modelDefinitionId 是否 enabled
如果同时传 vehicleModel 和 modelDefinitionId，要求两者 modelCode 一致
返回 VehicleView 增加 modelDefinition 摘要
```

中期：

```text
后台 UI 优先传 modelDefinitionId
vehicleModel 由 modelDefinition.modelCode 自动补齐
历史车辆无 modelDefinitionId 时 fallback vehicleModel
```

长期：

```text
新建车辆要求 modelDefinitionId
vehicleModel 仅作为 legacy snapshot / compatibility 字段
```

### 产品 / 套餐 / 报价

短期：

```text
CreateVehiclePackageDto 新增可选 modelDefinitionId
CreatePriceRuleDto 新增可选 modelDefinitionId
CreateQuoteDto 支持 modelDefinitionId，但保留 vehicleModel
```

中期：

```text
套餐匹配优先 modelDefinitionId
fallback vehicleModel
quote/order snapshot 保存 modelDefinitionId, modelCode, displayName
```

长期：

```text
VehiclePackage.modelDefinitionId 必填
ProductPriceRule 可退场或按 modelDefinitionId 唯一
```

### 查询 / 报表

短期：

```text
报告查询继续支持 vehicleModel
新增 modelDefinitionId
同时传入时优先 modelDefinitionId
CSV 输出 displayName，保留 modelCode
```

## 10. 前端 UI 迁移建议

当前前端下拉为硬编码：

```text
vehicles/page.tsx
products/page.tsx
reports/page.tsx
reports/asset-profitability/page.tsx
constants/labels.ts
```

建议新增：

```text
GET /api/vehicle-model-definitions
GET /api/vehicle-model-definitions/:id
```

车辆管理页：

- 新增 / 编辑车辆车型下拉从 API 读取 `enabled=true` 的主数据。
- 展示优先 `modelDefinition.displayName/customerDisplayName`，fallback `vehicleModel`。
- 保留 legacy vehicleModel 只读提示，帮助排查历史数据。

产品页：

- 车型包、价格规则下拉从 API 读取车型主数据。
- 新增 “车型代码 / 展示名 / 车系 / 启用状态” 搜索。

Portal catalog：

- 客户侧筛选只读取 `portalVisible=true` 的车型主数据。
- 车辆详情展示客户展示名，不暴露后台 remark / 内部映射。

报表页：

- 综合报表和资产收益报表筛选增加 `modelDefinitionId`。
- 保留 legacy `vehicleModel` 筛选用于历史数据和过渡期。
- 图表 / CSV 显示 displayName，必要时附 modelCode。

产品车型包改造：

- 后台车型包从 “选择 enum 车型” 改为 “选择车型主数据”。
- 可显示关联车辆数、关联套餐数，避免停用仍被使用的车型。

## 11. 车型代码主数据后台模块设计

菜单位置比较：

| 位置 | 优点 | 缺点 | 建议 |
| --- | --- | --- | --- |
| 车辆资产 -> 车型代码 | 贴近车辆录入、资产台账和残值 | 与产品车型包也有强关系 | 推荐首期使用 |
| 基础资料 -> 车型代码 | 更像企业主数据 | 当前没有基础资料一级菜单，需新增信息架构 | 中长期可考虑 |

建议首期菜单：

```text
车辆资产 -> 车型代码
```

功能：

```text
车型代码列表
新建 / 编辑
启用 / 停用
客户侧可见开关
排序
搜索
导入 / 导出
查看关联车辆数量
查看关联车型包数量
查看关联残值曲线数量
```

权限：

```text
vehicle_model:view
vehicle_model:manage
```

角色建议：

```text
ADMIN: view/manage
OP: view/manage
GM: view
SA: view
FI: view
```

## 12. 残值 / 报表影响

### 残值模块

当前残值模块不直接依赖 `VehicleModel` enum，而是用：

```text
brand
series
model
modelYear
trim
batteryCapacityKwh
batteryUsageType
```

影响：

- `VehicleResidualCurve` 匹配车辆时要求车辆有 `brand/model`，与 `Vehicle.vehicleModel` 是两套维度。
- 主数据化后应建立 `VehicleModelDefinition` 到残值字段的映射，减少手工输入误差。
- 不建议首期强制 residual curve 必须有 `modelDefinitionId`，否则历史曲线和外部样本会被打断。

建议：

```text
短期：VehicleModelDefinition 保存 residualMappingSnapshot，残值仍按 brand/series/model 匹配。
中期：VehicleMarketPriceObservation / VehicleResidualCurve / VehicleResidualForecast 增加可选 modelDefinitionId。
长期：残值曲线支持按 modelDefinitionId 聚合，同时保留 brand/series/model 外部数据维度。
```

### 报表模块

当前报表强依赖 `vehicleModel`：

- 订单综合报表按 `SubscriptionOrder.vehicleModel` filter/group。
- 车辆资产报表按 `Vehicle.vehicleModel` filter/group。
- 资产收益报表按 `Vehicle.vehicleModel` filter/list/export。
- CSV 直接输出 enum code 或 `vehicle.model ?? vehicle.vehicleModel`。

建议：

```text
新增 modelDefinitionId 查询参数。
保留 legacy vehicleModel 查询参数。
聚合优先 modelDefinitionId/displayName，fallback vehicleModel。
CSV 输出：车型展示名、车型代码、legacy enum code。
```

## 13. 后续阶段计划

### Stage 10X-C：车型代码主数据模型与后台维护

目标：新增 `VehicleModelDefinition` schema、migration、seed、权限、菜单和后台维护页面。

改动范围：

```text
Prisma model
API CRUD
Web 管理页面
permissions / seed / menu
```

风险：Medium。

验收标准：

```text
可新增 / 编辑 / 启停车型代码
初始 enum 映射 seed 完成
不影响车辆新增和旧流程
```

是否需要 migration：是。

### Stage 10X-D：车辆管理页接入车型主数据

目标：`Vehicle` 新增可选 `modelDefinitionId`，车辆新增 / 编辑优先选择车型主数据。

改动范围：

```text
Vehicle schema relation
Create / Update DTO
Vehicle service
Vehicles page
历史车辆回填脚本 / seed
```

风险：High。

验收标准：

```text
新车辆可选择 modelDefinitionId
vehicleModel legacy fallback 保留
已有车辆展示不回退
```

是否需要 migration：是。

### Stage 10X-E：Portal catalog / 商品 / 报表接入车型主数据

目标：产品车型包、Portal catalog、综合报表、资产收益报表支持车型主数据。

改动范围：

```text
VehiclePackage / ProductPriceRule 可选 relation
套餐匹配逻辑
Portal catalog DTO
Report DTO / service / CSV
前端筛选
```

风险：High。

验收标准：

```text
套餐匹配优先 modelDefinitionId
报表筛选支持 modelDefinitionId
CSV 显示 displayName 和 modelCode
legacy vehicleModel 仍可用
```

是否需要 migration：可能需要。

### Stage 10X-F：残值市场 / 预测接入车型主数据

目标：残值市场样本、曲线、预测可选关联车型主数据。

改动范围：

```text
ResidualMarketSample / Curve / Forecast 可选 relation
曲线生成筛选
预测匹配
残值页面筛选
```

风险：Medium。

验收标准：

```text
历史 brand/model 曲线仍可用
新曲线可按 modelDefinitionId 归集
估值复核展示车型主数据名称
```

是否需要 migration：是。

### Stage 10X-G：legacy enum 退场评估

目标：评估是否继续保留 `VehicleModel` enum 作为 legacy 字段，或进入退场。

改动范围：

```text
只读数据审计
查询使用率
历史快照影响评估
可能的字段废弃计划
```

风险：High。

验收标准：

```text
确认所有新流程不再依赖 enum
历史 quote/order/report 可解释
给出 keep/deprecate/remove 决策
```

是否需要 migration：评估阶段不需要；退场实施需要。

## 14. 风险和人工确认项

高风险点：

1. 套餐适配逻辑当前严格依赖 `vehicle.vehicleModel === vehiclePackage.vehicleModel`。
2. `SubscriptionQuote` / `SubscriptionOrder` 是财务和合同相关快照，不应破坏历史可解释性。
3. 报表按车型 filter/group/CSV 已经进入经营分析链路。
4. seed 和测试大量使用固定 enum，主数据化需要统一 fixture 工具。
5. 残值模块与 enum 不是同一套维度，需要业务确认映射关系。

人工确认项：

```text
1. modelCode 命名规范：是否继续使用 ET5/ET5T 这种短码。
2. brand/series/modelName/customerDisplayName 是否由业务统一维护。
3. NIO / 蔚来等品牌展示语言是否区分后台和客户侧。
4. modelYear 是否纳入车型主数据，还是继续作为车辆资产字段。
5. variantName / batteryCapacityKwh 是否用于区分不同配置。
6. portalVisible 的默认值。
7. 停用车型后，已有车辆 / 套餐 / 报表是否仍可查询。
8. 残值 market sample 是否必须强制映射到车型主数据。
9. CSV 是否同时输出 displayName 和 legacy modelCode。
10. 车型代码主数据菜单放在 “车辆资产” 还是新增 “基础资料”。
```

## 15. 本阶段结论

建议进入 Stage 10X-C，但仅实施主数据模型和后台维护，不急于改车辆 / 套餐 / 报表主逻辑。

推荐路径：

```text
Stage 10X-C: VehicleModelDefinition + 后台维护 + seed 初始映射
Stage 10X-D: 车辆管理页接入 modelDefinitionId
Stage 10X-E: Portal / 产品 / 报表接入
Stage 10X-F: 残值模块接入
Stage 10X-G: legacy enum 退场评估
```

核心原则：

```text
保留 enum，新增主数据，优先 relation，fallback enum，逐步迁移。
```

## 16. Stage 10X-C 实施状态

Stage 10X-C 已按本审计推荐的双轨过渡路线新增车型代码主数据维护基础：

```text
VehicleModelDefinition schema / migration
vehicle_model:view / vehicle_model:manage 权限
车辆资产 -> 车型代码 菜单入口
/api/vehicle-model-definitions CRUD API
/vehicle-model-definitions 后台维护页面
8 个 legacy VehicleModel enum 映射 seed
```

10X-C 仍未接入车辆主流程：

```text
未修改 Vehicle.model
未新增 Vehicle.modelDefinitionId
未修改车辆新增 / 编辑页面车型下拉
未迁移历史车辆
未修改产品 / Portal / 报表 / 残值模块
```

## 17. Stage 10X-D 实施状态

Stage 10X-D 已按本审计建议完成车辆管理的最小安全接入：

```text
Vehicle 新增可选 modelDefinitionId
Vehicle.vehicleModel enum 继续保留
车辆 create / update 支持 modelDefinitionId
有 modelDefinitionId 时校验 enabled / deletedAt / legacyVehicleModel
有 modelDefinitionId 时自动同步 Vehicle.vehicleModel
车辆列表 / 详情返回 modelDefinition 摘要和 modelDisplayName
/vehicles 页面优先展示主数据 displayName，fallback legacy enum
```

仍未接入的范围：

```text
Product / VehiclePackage / ProductPriceRule
Portal catalog
Reports / CSV
Residual market / forecast
legacy enum 退场
```

因此当前仍处于双轨过渡，不应删除 `VehicleModel` enum，也不应把无 `legacyVehicleModel` 映射的主数据用于车辆创建 / 编辑。
