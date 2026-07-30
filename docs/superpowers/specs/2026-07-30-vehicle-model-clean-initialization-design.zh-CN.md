# 车型主数据干净初始化设计

日期：2026-07-30

状态：已批准的设计基线

关联：

- GitHub PR [#223 refactor(vehicle): retire VehicleModel enum behind modelCode governance](https://github.com/keqi119/subscription-Saas/pull/223)
- [订阅平台三阶段能力实施路线图](./2026-07-30-three-stage-subscription-capability-roadmap-design.zh-CN.md)

## 背景

系统尚未进入实质生产，后续开发将使用全新数据库。当前测试业务数据会被隔离，不进入新库，因此不需要继续为固定 `VehicleModel` 枚举及其测试数据设计兼容、回填或双写逻辑。

PR #223 已完成枚举退役的主要应用改造：

- 将8个原枚举列转换为字符串；
- 删除 Prisma `VehicleModel` enum 和 PostgreSQL `vehicle_model` 类型；
- 以 `VehicleModelDefinition.modelCode` 作为车型主数据编码；
- 删除运行时代码对 Prisma 枚举的依赖；
- 增加无枚举治理和测试。

但 #223 明确保留 `vehicleModel`、`legacyVehicleModel` 及历史兼容快照字段，物理删除兼容字段仍为 `hardRemovalReady=false`。直接合并 #223 只能解决枚举类型限制，不能形成最终干净Schema。

## 决策

在阶段1A开始前增加强制**初始化阶段0**：

1. 阶段0A将 #223 基于最新主干重新校验并合入；
2. 阶段0B另用增量迁移和应用改造删除旧车型兼容字段及API契约；
3. 全新数据库在阶段0最终Schema上初始化；
4. 新业务只使用 `modelDefinitionId`、`modelCode` 和规范化车型快照；
5. 不为当前测试数据保留旧枚举或旧字段兼容。

阶段0A和0B必须分为两个可独立审查的PR，不能继续扩大已包含72个文件变更的 #223。

## 目标领域模型

### VehicleModelDefinition

`VehicleModelDefinition` 是车型主数据唯一来源，至少提供：

- `id`；
- 唯一、创建后不可修改的 `modelCode`；
- 品牌、车系、车型名称、展示名称、年款及必要技术参数；
- 启用状态、生效时间和审计信息。

删除：

- `legacyVehicleModel`；
- 枚举到主数据的别名映射；
- 依赖固定枚举值的查询、校验和后台控件。

### Vehicle及产品侧引用

- `Vehicle.modelDefinitionId` 成为新车创建的必填引用；
- `VehiclePackage`和`ProductPriceRule`只通过`modelDefinitionId`引用车型主数据；
- 删除上述模型中的`vehicleModel`兼容字段；
- 保留`ProductPriceRule`本身，用于既有定价兼容，不在阶段0删除该业务能力；
- 车型包未来的多车型集合在阶段1产品设计中通过规范化关联表实现，阶段0不把新的集合能力塞入枚举清理。

### Quote及Order快照

新Quote和Order保存：

- `modelDefinitionIdSnapshot`；
- `modelCodeSnapshot`；
- `modelDisplayNameSnapshot`。

删除：

- `vehicleModel`；
- `legacyVehicleModelSnapshot`；
- `legacyVehicleModelCodeSnapshot`。

快照字段用于保存签约时车型事实，不通过当前主数据回算历史合同。

## API、页面及报表契约

写入契约：

- 车辆、产品、报价、订单和筛选条件使用`modelDefinitionId`；
- 不接受`vehicleModel`或`legacyVehicleModel`输入；
- `modelCode`由选定主数据产生，不允许客户端把自由文本代码当成关联键。

读取契约：

- 当前实体返回`modelDefinitionId`、`modelCode`和`modelDisplayName`；
- Quote和Order返回对应快照字段；
- CSV、报表和Portal不再返回旧车型枚举或兼容字段；
- 旧筛选参数、后台枚举下拉框和兼容解析分支直接移除，不提供弃用期。

由于系统未生产且用户已批准终止兼容，以上属于一次受控的预生产破坏性契约调整。

## 迁移策略

不得编辑、删除或压缩已经提交及执行的历史迁移。

迁移链保持：

1. 历史迁移可能在全新数据库初始化过程中创建`vehicle_model`枚举及旧列；
2. #223的增量迁移将枚举列转换为字符串并删除数据库枚举类型；
3. 阶段0B的新增迁移删除旧兼容列，并创建或重命名规范化快照列；
4. 最终Schema、生成的Prisma Client和运行时代码均不包含`VehicleModel`、`vehicleModel`或`legacyVehicleModel`兼容契约。

新库没有业务数据，因此阶段0B不执行旧测试数据回填。受控种子数据直接按最终主数据模型创建。

## 初始化及回退

执行顺序：

1. 备份并只读隔离当前测试数据库；
2. 完成阶段0A和0B代码审查及质量门；
3. 创建独立的新开发数据库；
4. 从零执行完整迁移链；
5. 运行最终车型主数据种子；
6. 验证产品、车辆、报价、订单、Portal和报表主路径；
7. 阶段0验收后才能开始阶段1A。

阶段0发生问题时，不修改旧数据库，也不对新库做人工逆向修补。回退方式是停止应用、修正未发布代码或新增修复迁移，然后删除并重建尚未承载生产数据的新开发数据库。任何删除动作仍需针对明确数据库获得批准。

## 质量门

必须满足：

- Schema中不存在`enum VehicleModel`和`vehicle_model`数据库类型；
- Prisma模型不存在枚举型或字符串型旧`vehicleModel`、`legacyVehicleModel`字段；
- Runtime、DTO、种子和可执行脚本不导入Prisma `VehicleModel`；
- 写接口不接受旧车型参数；
- 响应、Portal、CSV和报表不输出旧车型字段；
- Quote和Order创建时规范化快照完整；
- `modelCode`唯一且创建后不可修改；
- 车辆、产品和价格规则引用有效`modelDefinitionId`；
- 无枚举和无兼容字段守卫通过；
- 全新数据库迁移、种子、API/Web类型检查、相关单元测试及端到端主路径通过；
- `ProductPriceRule`、`RENT_TO_OWN`历史能力及与车型枚举无关的Quote/Order字段不被本次误删。

## 非目标

- 不在阶段0实现车型包多车型集合；
- 不重构订阅定价、合同、账单或车辆状态业务；
- 不迁移当前测试业务数据；
- 不修改历史迁移；
- 不合并与车型主数据无关的代码重构；
- 不因新库而降低新建库和增量升级的迁移校验要求。

## 验收结果

阶段0完成后，车型领域只有一条主线：

`VehicleModelDefinition.id → modelCode / displayName → 业务引用与合同快照`

固定枚举、旧字段、别名解析和兼容API不再进入新库及运行时。阶段1产品、车辆、合同和报表能力可以在稳定的车型主数据基础上继续开发。
