# Stage 10X-G VehicleModel Enum Retirement Audit

## 1. 背景

Stage 10X-A 到 10X-F 已完成车型主数据双轨接入：

```text
10X-A: VehicleModel enum 漂移收口，ET5T / EC6 / ES8 / ET9 / ES9 纳入 enum / labels / tests
10X-B: 完成车型主数据影响审计，确定双轨过渡
10X-C: 新增 VehicleModelDefinition、后台维护、seed legacy enum 映射
10X-D: Vehicle 接入 modelDefinitionId，保留 Vehicle.vehicleModel
10X-E: Product / Portal catalog / Reports 接入 modelDefinitionId
10X-F: Residual market / forecast / valuation review 接入 modelDefinitionId
```

本阶段只做退场评估，不修改 schema、不新增 migration、不迁移历史数据、不修改业务逻辑。

## 2. 当前车型主数据接入状态

当前主流程已经支持 `modelDefinitionId` 优先，但 legacy enum 仍承担三个职责：

```text
active dependency: 仍参与新流程匹配、校验或分组
fallback/display: 作为无 modelDefinitionId 历史数据的展示和筛选 fallback
historical snapshot: 报价、订单、合同、复核等历史事实解释
```

`rg` 审计结果摘要：

```text
apps/api/src: 25 个文件仍引用 VehicleModel / vehicleModel / legacyVehicleModel
apps/api/test: 30 个测试文件仍使用 legacy enum fixture 或断言
apps/web/src: 19 个文件仍引用 vehicleModel、VEHICLE_MODEL_LABELS 或 legacy 下拉
docs / README: 9 个文档入口仍记录 VehicleModel / legacy fallback
packages/shared: 未发现 VehicleModel 直接使用
```

结论：`VehicleModel` enum 不再是唯一车型来源，但仍是多个主流程的兼容字段和历史快照字段。

## 3. VehicleModel Enum 剩余使用点

### 3.1 Schema 层

`VehicleModel` enum 仍存在：

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
}
```

仍直接使用 enum 的模型：

```text
Vehicle.vehicleModel
VehiclePackage.vehicleModel
ProductPriceRule.vehicleModel
VehicleModelDefinition.legacyVehicleModel
SubscriptionQuote.vehicleModel
SubscriptionOrder.vehicleModel
```

已接入 `modelDefinitionId` 的模型：

```text
Vehicle.modelDefinitionId
VehiclePackage.modelDefinitionId
ProductPriceRule.modelDefinitionId
VehicleMarketPriceObservation.modelDefinitionId
VehicleResidualCurve.modelDefinitionId
VehicleResidualForecast.modelDefinitionId
ResidualModelRun.targetModelDefinitionId
```

未接入 `modelDefinitionId` 且仍保留 enum 快照的模型：

```text
SubscriptionQuote
SubscriptionOrder
```

### 3.2 API DTO 层

仍使用 `VehicleModel` enum 校验的 DTO：

```text
apps/api/src/vehicle/dto/vehicle.dto.ts
apps/api/src/product/dto/product.dto.ts
apps/api/src/portal/portal-catalog.dto.ts
apps/api/src/report/dto/report.dto.ts
apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts
```

这些 DTO 同时保留或已新增 `modelDefinitionId` 的场景主要是：

```text
Vehicle create / update
VehiclePackage / ProductPriceRule create / update
Portal catalog filter
Reports filter
VehicleModelDefinition legacy mapping
```

### 3.3 Service 层

active business dependency：

```text
vehicle.service.ts:
  create / update 时仍写入 Vehicle.vehicleModel
  modelDefinitionId 存在时通过 legacyVehicleModel 同步 enum

product.service.ts:
  VehiclePackage / ProductPriceRule 仍写入 vehicleModel
  price rule lookup 仍按 vehicleModel 查找
  quote 创建仍生成 SubscriptionQuote.vehicleModel

order.service.ts / customer.service.ts:
  订单创建、换车、自助申请仍校验 vehicle.vehicleModel 与 package.vehicleModel
  order / quote snapshot 仍写入 vehicleModel

portal-catalog.service.ts:
  catalog filter 支持 modelDefinitionId，但可 fallback legacy vehicleModel
  vehicle-plan matching 在 modelDefinitionId 不完整时 fallback vehicleModel

report.service.ts:
  报表筛选支持 modelDefinitionId，但仍按 order.vehicleModel / vehicle.vehicleModel 分组和导出 legacy 字段

vehicle-listing.service.ts:
  车辆 listing 可用套餐匹配仍存在 vehicleModel fallback
```

fallback / display dependency：

```text
finance / financing / service-case / vehicle-asset-pool / e-sign / portal-billing:
  多数为车辆摘要、合同展示、资产池展示或审计上下文，不是车型决策主逻辑

residual-market.service.ts:
  已使用 modelDefinitionId 优先；legacy brand / series / model fallback 保留

vehicle-valuation-review.service.ts:
  展示优先 modelDefinition.displayName；legacy 仅 fallback
```

### 3.4 Web 层

active UI dependency：

```text
/vehicles:
  车型代码主数据选择器已存在，但 legacy 车型仍为必填兼容字段

/products:
  车型包 / 价格规则已支持 modelDefinitionId，但 legacy 车型下拉仍保留

/portal/catalog:
  筛选默认可用 modelDefinitionId

/reports and /reports/asset-profitability:
  默认支持 modelDefinitionId，同时保留 legacy vehicleModel filter

/vehicle-model-definitions:
  legacy enum 映射下拉仍用于维护 legacyVehicleModel
```

fallback / snapshot display：

```text
/applications/[id]
/orders
/orders/[id]
/orders/review
/quotes
/quotes/[id]
/contracts/[id]
/vehicle-asset-pools
/financing-instruments
/revenue-rights
```

这些页面多数展示 quote/order/vehicle snapshot 中的 legacy `vehicleModel`。

### 3.5 Seed / Scenario Seed

`apps/api/prisma/seed.mjs` 仍使用：

```text
vehicleModelDefinitionSeedRows: legacyVehicleModel 映射
demoVehicles.vehicleModel
baseline VehiclePackage / ProductPriceRule vehicleModel
SubscriptionQuote / SubscriptionOrder seed vehicleModel
```

`apps/api/prisma/seed-scenario.mjs` 仍创建 legacy `vehicleModel = ET5` 的车辆。

这些 seed 是兼容和演示数据依赖，不应在 10X-G 直接修改。

### 3.6 Tests

测试中 `VehicleModel` 主要用于：

```text
legacy behavior fixture
modelDefinitionId + legacyVehicleModel 同步断言
legacy mismatch 400 / reject 断言
reports fallback 断言
portal fallback 断言
product / quote / order 旧链路不回归断言
```

在真正退场前，这些测试是重要保护网，不应删除。

### 3.7 Docs

历史文档仍记录 enum 漂移收口、主数据双轨、Residual fallback 和当前建议。10X-G 后应新增本文档作为 enum freeze / retirement 评估入口。

## 4. 模型级影响矩阵

| 模型 / 模块 | 当前 enum 字段 | 已有 modelDefinitionId | 可改必填吗 | 历史迁移风险 | 快照 / 审计风险 | 建议 | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Vehicle | `vehicleModel?` | 是 | 新建可分阶段必填；历史不可直接必填 | 历史车辆可能无主数据映射 | 中 | 10X-H 先要求新建必填，保留 legacy 字段 | High |
| VehicleModelDefinition | `legacyVehicleModel?` | 不适用 | 不应必填 | 新车型可能无 legacy enum | 低 | 冻结 enum 后仅保留 legacy 映射 | Medium |
| VehiclePackage | `vehicleModel` | 是 | 新建可分阶段必填 | 旧套餐仍按 enum 匹配 quote/order | 中 | 10X-I 新建必填，旧数据保留 fallback | High |
| ProductPriceRule | `vehicleModel` | 是 | 新建可分阶段必填 | 唯一约束仍在 `(productVersionId, vehicleModel)` | 中 | 增加 modelDefinitionId 唯一策略前不可删 enum | High |
| SubscriptionQuote | `vehicleModel` | 否 | 不建议改历史必填策略 | 历史报价必须解释当时车型 | 高 | 长期保留或新增 string/display snapshot 后再评估 | High |
| SubscriptionOrder | `vehicleModel` | 否 | 不建议改历史必填策略 | 历史订单和合同必须解释当时车型 | 高 | 长期保留或新增 string/display snapshot 后再评估 | High |
| VehicleMarketPriceObservation | 无 enum，legacy string | 是 | 新建样本可分阶段要求 | 外部样本 brand/model 不一定能映射 | 中 | 10X-J 对内部样本必填，外部导入允许 unresolved | Medium |
| VehicleResidualCurve | 无 enum，legacy string | 是 | 新建曲线可分阶段要求 | 旧曲线需保持可解释 | 中 | 10X-J 新建曲线优先必填，旧曲线不迁移 | Medium |
| VehicleResidualForecast | 无 enum，legacy string | 是 | 新预测可要求来自车辆主数据 | 历史预测不可重算 | 高 | 保留 snapshot，不重算历史 | Medium |
| ResidualModelRun | 无 enum，legacy target string | `targetModelDefinitionId` | 可对单车型 run 逐步必填 | 批量 run 可能无单一车型 | 中 | 仅单车型 run 必填 | Low-Medium |
| VehicleValuationReview | 无 enum 字段 | 通过 vehicle/forecast | 不适用 | 审批历史不可覆盖 | 高 | 展示优先主数据，snapshot 保留原样 | Low-Medium |
| Reports DTO / snapshots | DTO 使用 enum filter | 查询支持 | 可默认主数据筛选 | 历史 group by 仍用 order.vehicleModel | 中 | 默认主数据，legacy filter 兼容模式 | Medium |

## 5. 历史快照和审计风险

### 5.1 SubscriptionQuote

历史报价应保留当时的 legacy `vehicleModel` 快照。

原因：

```text
报价是商业承诺快照
packageSnapshot / vehicleSnapshot / customerSelectedSnapshot 需要可重放
报价生成时的套餐、价格规则和车型枚举是当时事实
```

如果删除 enum，历史报价仍需要解释：

```text
建议未来新增 string snapshot 字段或 JSON snapshot 字段，而不是直接删除旧 enum 字段
建议新增 modelCodeSnapshot / modelDisplayNameSnapshot
不建议回写覆盖历史 quote.vehicleModel
```

### 5.2 SubscriptionOrder

历史订单和合同链路风险最高。

原因：

```text
order.vehicleModel 是订单、合同、账单、权益、核销、售后展示的稳定字段
quoteSnapshot / finalPlanSnapshot / contract snapshot 可能已包含 vehicleModel
合同签署后的车型解释不能因主数据重命名而变化
```

建议：

```text
长期保留 legacyVehicleModel 或转换为 string snapshot
新增 modelDefinitionId / modelCodeSnapshot / modelDisplayNameSnapshot 只能用于新订单
旧订单不强制迁移，不改变合同展示历史事实
```

### 5.3 VehicleResidualForecast

10X-F 已新增 `modelDefinitionId` 快照，但仍保留 legacy `brand / series / model`。

建议：

```text
不重算历史 forecast
不覆盖 forecast.vehicleSnapshot / curveSnapshot
新 forecast 可要求 vehicle.modelDefinitionId
历史 forecast 继续通过 legacy brand/model 和 curveSnapshot 解释
```

### 5.4 VehicleValuationReview

复核本身没有 enum 字段，但依赖车辆、forecast 和审批 snapshot。

建议：

```text
展示优先 modelDefinition.displayName
snapshot 仍保留原始 vehicleModel / brand / model
approve / reject / cancel 状态机不应因 enum 退场改变
```

### 5.5 是否需要长期保留 legacyVehicleModel

需要。至少在以下条件满足前必须保留：

```text
所有新流程已默认且强制 modelDefinitionId
Quote / Order 新快照已有 modelCodeSnapshot / modelDisplayNameSnapshot
历史数据 backfill dry-run 无重大 unresolved
Portal / Reports / Residual fallback 经过完整回归
合同和审计口径确认不再依赖 enum 类型
```

## 6. 退场方案比较

### 方案 A：长期保留 enum 作为 legacy fallback

做法：

```text
继续保留 VehicleModel enum
所有新流程优先 modelDefinitionId
enum 仅用于历史 / fallback / audit
```

优点：

```text
最安全
不影响历史 quote/order/contract snapshot
不需要大规模 schema migration
测试和 seed 改动最小
```

缺点：

```text
enum 仍会出现在 schema 和前端 labels
如果继续新增 enum 值，会削弱主数据治理目标
新车型运营仍可能被 enum 发布周期卡住
```

适用性：短期安全兜底，但需要配合 freeze guard，避免 enum 继续扩张。

### 方案 B：冻结 enum，不再新增值

做法：

```text
保留 VehicleModel enum
标记 deprecated / legacy only
禁止新增 enum 值
新车型只能创建 VehicleModelDefinition
新流程逐步要求 modelDefinitionId
```

优点：

```text
兼顾安全和主数据治理
不破坏历史快照
新车型不再依赖 Prisma enum 发布
可以逐步压缩 active dependency
```

缺点：

```text
需要增加流程 guard 和文档约束
部分旧代码仍需长期维护 fallback
Quote / Order 要真正去 enum 仍需要后续 snapshot 迁移设计
```

适用性：推荐方案。

### 方案 C：彻底退场 enum

做法：

```text
新增 string snapshot 字段
完成历史 backfill
将业务匹配全部迁移到 modelDefinitionId
移除 VehicleModel enum 和 enum 字段
```

优点：

```text
模型治理最彻底
新车型完全由主数据驱动
schema 不再有 enum 漂移问题
```

缺点和风险：

```text
需要多轮 migration
Quote / Order / Contract 历史审计风险很高
ProductPriceRule unique strategy 需要重做
大量 DTO、测试、seed、前端兼容逻辑要迁移
历史 unresolved 数据会阻塞上线
```

适用性：不适合 10X-G 或短期执行。只能在 backfill 和 snapshot 迁移成熟后重新评估。

## 7. 推荐方案

推荐采用方案 B：

```text
冻结 VehicleModel enum，不再新增值
中期继续保留 enum 作为 legacy fallback
所有新流程逐步要求 modelDefinitionId
Quote / Order 历史 enum 快照继续保留
后续通过 backfill dry-run 和 snapshot 迁移评估彻底退场
```

推荐原因：

```text
当前 active dependency 仍覆盖 Product / Quote / Order / Reports
历史报价、订单和合同不应被 schema 退场强制改写
Stage 10X-D/E/F 已证明双轨可运行，应继续压缩 legacy 使用面
```

## 8. Backfill 设计

本阶段不实现 backfill，只设计未来脚本。

### 8.1 覆盖模型

```text
Vehicle.modelDefinitionId
VehiclePackage.modelDefinitionId
ProductPriceRule.modelDefinitionId
VehicleMarketPriceObservation.modelDefinitionId
VehicleResidualCurve.modelDefinitionId
VehicleResidualForecast.modelDefinitionId
ResidualModelRun.targetModelDefinitionId
```

### 8.2 匹配规则

基础规则：

```text
1. 不覆盖已有 modelDefinitionId
2. 优先通过 legacy VehicleModel -> VehicleModelDefinition.legacyVehicleModel 唯一映射
3. residual string 维度通过 brand / series / model / modelYear / batteryCapacityKwh 辅助匹配
4. 无法唯一匹配时记录 unresolved
5. 多候选时记录 conflicts，不自动选择
6. dryRun 默认开启
```

### 8.3 输出统计

每个模型输出：

```text
total
matched
skippedExisting
unresolved
conflicts
wouldUpdate
updated
```

每条 unresolved / conflict 至少输出：

```text
entityType
entityId
legacyVehicleModel 或 legacy brand / series / model
candidateDefinitionIds
reason
```

### 8.4 模型细则

Vehicle：

```text
使用 vehicle.vehicleModel -> legacyVehicleModel 映射
无 vehicleModel 的历史车辆用 brand / series / model 辅助匹配，仅 dryRun 报告
```

VehiclePackage / ProductPriceRule：

```text
使用 vehicleModel -> legacyVehicleModel 映射
若同 productVersion 下已有 modelDefinitionId 冲突，记录 conflicts
不修改现有 vehicleModel
```

VehicleMarketPriceObservation：

```text
若样本已有 modelDefinitionId 跳过
外部样本用 brand / series / model / modelYear 尝试匹配
无法唯一匹配的保留 legacy string
```

VehicleResidualCurve：

```text
优先 brand / series / model / modelYear / battery 参数匹配
旧 ACTIVE curve 不自动归并，不改变 effectiveFrom / effectiveTo
```

VehicleResidualForecast：

```text
优先从 vehicle.modelDefinitionId 回填
其次从 curve.modelDefinitionId 回填
不重算 points，不修改 curveSnapshot / vehicleSnapshot
```

ResidualModelRun：

```text
仅 targetType 为 RESIDUAL_CURVE 且 targetBrand / targetModel 指向单车型时尝试回填
批量 run 或训练集范围不明确时 unresolved
```

## 9. 新流程 modelDefinitionId Required 策略

### Stage 10X-H：新建车辆 modelDefinitionId 必填

目标：

```text
Vehicle create 默认要求 modelDefinitionId
legacy vehicleModel 隐藏到兼容模式
无 legacyVehicleModel 映射的主数据是否允许创建车辆需产品确认
```

风险：

```text
历史导入、seed、测试 fixture 需要补 modelDefinitionId
第三方或脚本调用仍可能只传 vehicleModel
```

验收标准：

```text
新建车辆默认传 modelDefinitionId
编辑历史车辆仍可保留 legacy fallback
API 错误信息清晰
```

是否需要 migration：不需要。

### Stage 10X-I：Product / Package 新建 modelDefinitionId 必填

目标：

```text
VehiclePackage / ProductPriceRule 新建必须绑定 modelDefinitionId
legacy vehicleModel 继续由 definition.legacyVehicleModel 自动同步
```

风险：

```text
ProductPriceRule 当前唯一约束仍基于 vehicleModel
报价链路仍通过 vehicleModel 查 price rule
```

验收标准：

```text
后台产品页默认只选车型主数据
legacy 下拉进入兼容模式
旧套餐和旧价格规则仍能报价
```

是否需要 migration：可能需要新增 modelDefinitionId 维度唯一约束，需单独评估。

### Stage 10X-J：Residual 新建 sample / curve modelDefinitionId 必填

目标：

```text
内部手工样本、后台新曲线要求 modelDefinitionId
外部 CSV 导入可保留 legacy string，并输出 unresolved
forecast 生成要求车辆有 modelDefinitionId，找不到主数据曲线时 fallback legacy
```

风险：

```text
外部市场样本车型命名不标准
历史曲线仍需可用
```

验收标准：

```text
新曲线优先主数据
旧 curve / sample / forecast 不重算、不回写
```

是否需要 migration：不需要。

### Stage 10X-K：legacy enum freeze guard

目标：

```text
明确 VehicleModel enum deprecated
CI 或文档 guard 禁止新增 enum value
新增车型只能通过 VehicleModelDefinition
```

风险：

```text
测试 fixture 或 seed 可能仍硬编码 enum 列表
```

验收标准：

```text
新增 enum 值会被审查阻断
车型主数据页面支持无 legacyVehicleModel 的新车型
```

是否需要 migration：不需要。

### Stage 10X-L：backfill dry-run / report

目标：

```text
实现 dryRun 脚本
输出每个模型 matched / unresolved / conflicts
不写库或仅在显式确认后写库
```

风险：

```text
residual 外部样本无法唯一匹配
Quote / Order 历史快照不应被回写
```

验收标准：

```text
dryRun 报告可审计
无自动覆盖已有 modelDefinitionId
unresolved 清单可人工处理
```

是否需要 migration：不需要。

### Stage 10X-M：enum removal feasibility review

目标：

```text
基于 10X-H/I/J/K/L 结果重新评估是否可移除 enum
设计 Quote / Order string snapshot 迁移
确认合同、审计、报表口径
```

风险：

```text
历史合同解释风险
schema migration 范围大
大量 API / Web / tests 改动
```

验收标准：

```text
active dependency 清零或明确豁免
历史 snapshot 有替代解释字段
backfill unresolved 可接受
```

是否需要 migration：需要，且必须单独分阶段。

## 10. 前端去 enum 化建议

```text
1. 新建 / 编辑页面默认只显示车型主数据选择器
2. legacy enum 下拉隐藏到“兼容模式”
3. 报表筛选默认 modelDefinitionId，legacy vehicleModel 放到兼容筛选
4. CSV 展示主数据 displayName，同时保留 legacy 字段列
5. 详情页和导出中保留 legacy 字段，用于历史解释
6. 车型主数据页面允许创建无 legacyVehicleModel 的新车型
7. legacy 下拉选项不再跟随新车型扩张
```

## 11. API 去 enum 化建议

```text
1. 新 API 和新流程采用 modelDefinitionId first
2. vehicleModel 在 DTO / OpenAPI / 文档中标记 deprecated / legacy only
3. response 标准返回 modelDefinition、modelDefinitionId、modelDisplayName
4. create / update 分阶段要求 modelDefinitionId
5. legacy vehicleModel 仅用于 fallback、snapshot、audit
6. Quote / Order 后续新增 modelCodeSnapshot / modelDisplayNameSnapshot 后，再评估 enum 字段退场
7. 对外文档明确：新增车型不再新增 VehicleModel enum
```

## 12. 后续阶段计划

推荐顺序：

```text
Stage 10X-H: 新建车辆 modelDefinitionId 必填
Stage 10X-I: Product / Package 新建 modelDefinitionId 必填
Stage 10X-J: Residual 新建 sample / curve modelDefinitionId 必填
Stage 10X-K: legacy enum freeze guard
Stage 10X-L: backfill dry-run / report
Stage 10X-M: enum removal feasibility review
```

## 13. 人工确认事项

进入 10X-H 前建议确认：

```text
1. 新车型没有 legacyVehicleModel 时，是否允许创建 Vehicle
2. Quote / Order 是否需要新增 modelCodeSnapshot / modelDisplayNameSnapshot
3. ProductPriceRule 是否新增 modelDefinitionId 唯一约束
4. 外部 residual CSV 样本无法匹配主数据时是否允许入库
5. 现有合同、订单、发票、权益展示是否长期保留 legacy vehicleModel
6. 是否在 CI 中阻止 VehicleModel enum 新增值
7. backfill dryRun 的人工审核责任人和 unresolved 处理流程
```

## 14. 结论

不建议立即删除 `VehicleModel` enum。

推荐结论：

```text
冻结 VehicleModel enum，不再新增值
所有新流程逐步要求 modelDefinitionId
legacy enum 保留用于历史快照 / fallback / 审计解释
完成 backfill dry-run、snapshot 迁移和 active dependency 清零后，再评估真正退场
```

## 15. Stage 10X-H 实施记录

10X-H 采纳本审计的保守路线：冻结 enum 的第一步不是删除 `VehicleModel`，而是先阻止新增车辆继续缺失车型主数据。

已确认的边界：

```text
无 legacyVehicleModel 映射的 VehicleModelDefinition 暂不能用于新建车辆
Web 新建车辆必须选择车型代码主数据
API create 兼容只传 legacy vehicleModel，但必须自动解析出 modelDefinitionId
解析失败返回 400
历史车辆不强制迁移
update 不允许清除已有 modelDefinitionId
Quote / Order 快照不在本阶段修改
Product / Portal / Reports / Residual 不在本阶段修改
CI enum freeze guard 仍留到 Stage 10X-K
```

10X-H 完成后，后续路线保持：

```text
Stage 10X-I: Product / Package 新建规则 modelDefinitionId 必填
Stage 10X-J: Residual 新建 sample / curve modelDefinitionId 必填
Stage 10X-K: legacy enum freeze guard
Stage 10X-L: backfill dry-run / report
Stage 10X-M: enum removal feasibility review
```

详见：

```text
docs/stage-10x-vehicle-model-required-on-create.md
```

## 16. Stage 10X-I 实施记录

10X-I 继续执行本审计推荐的分阶段 required 路线，将 Product / Package / Price Rule 新流程推进到 `modelDefinitionId first`。

实施结果：

```text
VehiclePackage 新建最终必须写入 modelDefinitionId
ProductPriceRule 新建最终必须写入 modelDefinitionId
legacy-only create 会自动解析 VehicleModelDefinition.legacyVehicleModel
update 不强制迁移历史记录，但不允许显式清空车型主数据
Product 后台车型包表单默认选择车型代码主数据
legacy vehicleModel 仍保留为兼容字段
Quote / Order 历史快照未修改
Portal / Reports / Residual 未修改
```

10X-I 完成后，后续路线保持：

```text
Stage 10X-J: Residual 新建 sample / curve modelDefinitionId 必填
Stage 10X-K: legacy enum freeze guard
Stage 10X-L: backfill dry-run / report
Stage 10X-M: enum removal feasibility review
```

详见：

```text
docs/stage-10x-product-model-definition-required.md
```

## 17. Stage 10X-J 实施记录

10X-J 继续执行本审计推荐的分阶段 required 路线，将 residual 新数据入口推进到 `modelDefinitionId first`。

实施结果：

```text
Residual market 新增样本最终必须写入 modelDefinitionId
Residual market CSV 导入样本最终必须写入 modelDefinitionId
legacy-only sample / import row 会自动解析 VehicleModelDefinition brand / series / modelName / modelCode
解析失败的 CSV 行返回 row-level error，不写入该行
Residual curve 新建 / 生成最终必须写入 modelDefinitionId
ResidualModelRun 如指定目标车型，最终必须写入 targetModelDefinitionId
全量 / 泛化 model run 可不传 targetModelDefinitionId
历史 residual sample / curve / forecast 不强制迁移
forecast lookup 优先级未修改
不重算历史 forecast，不自动 adopt residual，不更新车辆销售价
```

10X-J 完成后，后续路线保持：

```text
Stage 10X-K: legacy enum freeze guard
Stage 10X-L: backfill dry-run / report
Stage 10X-M: enum removal feasibility review
```

详见：

```text
docs/stage-10x-residual-model-definition-required.md
```
