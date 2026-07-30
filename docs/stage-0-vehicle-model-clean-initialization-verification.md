# 阶段0B：车型主数据全新数据库初始化验收记录

验收日期：2026-07-30  
验收结论：通过

## 1. 验收基线

- 阶段0A基线提交：`f33704b0f2e19fb40d5dffbed83032ae1b24aef0`
- 阶段0B代码头部提交：`b1473d725f1eae5e2f55a47de0ec6bed4ce9b62d`
- 验收分支：`stage0b/vehicle-model-compatibility-hard-removal`
- 阶段0B功能提交数：8
- 验证数据库：`subscription_saas_stage0b_verify`
- 数据库实例：本地专用Codex PostgreSQL实例
- 共享业务数据库：未执行迁移、种子或数据修复

阶段0B采用全新数据库最终态，不承担历史业务数据的字段回填或兼容读取。

## 2. 迁移与最终Schema

执行完整迁移部署和状态检查：

```text
prisma migrate deploy
prisma migrate status
```

结果：

- 迁移数量：71
- 最终迁移：`20260730180000_vehicle_model_compatibility_hard_removal`
- 迁移状态：71个迁移全部成功应用，数据库Schema为最新状态
- Prisma Schema校验：通过
- Prisma Client生成：通过

数据库对象实查结果：

```text
vehicle_model_enum_exists = false
legacy column query = 0 rows
```

以下9个最终主数据引用及快照列均为`NOT NULL`：

| 表 | 列 | 可空 |
| --- | --- | --- |
| `vehicle` | `model_definition_id` | NO |
| `vehicle_package` | `model_definition_id` | NO |
| `product_price_rule` | `model_definition_id` | NO |
| `subscription_quote` | `model_definition_id_snapshot` | NO |
| `subscription_quote` | `model_code_snapshot` | NO |
| `subscription_quote` | `model_display_name_snapshot` | NO |
| `subscription_order` | `model_definition_id_snapshot` | NO |
| `subscription_order` | `model_code_snapshot` | NO |
| `subscription_order` | `model_display_name_snapshot` | NO |

旧列查询覆盖：

- `vehicle_model`
- `legacy_vehicle_model`
- `legacy_vehicle_model_snapshot`
- `legacy_vehicle_model_code_snapshot`

查询返回0行。

## 3. 种子与幂等性

在`prisma.config.ts`登记正式种子入口`node prisma/seed.mjs`后，标准命令：

```text
prisma db seed
prisma db seed
```

连续两次执行成功，未发生唯一键冲突或兼容字段写入。

基线校验脚本全部通过，最终基础数据包括：

- 有效车型定义：8
- 可用验收车辆：3
- 有效订阅套餐：1
- 3辆验收车辆均具备有效销售价、电池信息、交强险、商业险和初始入池价格历史
- 默认种子不创建进件、报价、订单、合同、账单、支付、催收或权益业务流水

## 4. 车型主路径与全量回归

阶段0B聚焦测试：

- API：8个测试文件，262/262通过
- Web：1个测试文件，9/9通过
- PostgreSQL原生SQL交接PDF套件：2/2通过

API全量门禁：

- TypeScript类型检查：通过
- ESLint：通过
- 测试：152/152个测试文件，2001/2001个测试通过
- Nest生产构建：通过

Web全量门禁：

- TypeScript类型检查：通过
- ESLint：通过
- 测试：37/37个测试文件，410/410个测试通过
- Next.js生产构建：通过，55个静态页面完成生成

发布门禁：

- `pnpm release:check`：通过
- 独立迁移状态复核：数据库Schema为最新状态
- 发布检查中的API全量复跑：152/152个测试文件、2001/2001个测试通过
- 场景种子和外部服务Smoke按默认发布检查配置未执行：`RUN_RELEASE_SCENARIOS=0`、`RUN_RELEASE_SMOKE=0`

## 5. 车型治理结果

无枚举和无兼容字段守卫均通过。

车型退役就绪结果：

```json
{
  "decision": "READY",
  "enumUsageCount": 0,
  "externalUsageCount": 0,
  "fallbackUsageCount": 0,
  "readinessScore": 100
}
```

外部契约治理结果：

```json
{
  "blockingConsumers": 0,
  "hardRemovalReady": true,
  "missingReferences": 0,
  "registeredReferences": 0,
  "totalExternalReferences": 0
}
```

## 6. 已确认的最终边界

- 车型由`VehicleModelDefinition`统一治理，业务对象使用`modelDefinitionId`关联。
- 报价和订单固化`modelDefinitionIdSnapshot`、`modelCodeSnapshot`、`modelDisplayNameSnapshot`。
- 套餐与车辆按同一`modelDefinitionId`匹配，不再接受历史枚举或别名映射。
- 运行时代码、种子、CSV和外部契约不存在车型兼容消费者。
- 历史回填、兼容双写、兼容回读及兼容退役脚本不进入阶段0B最终系统。

## 7. 非目标和已知提示

- 本次不迁移阶段0A或测试数据库中的业务数据；生产启用时使用新的受控数据库。
- 本次不实现多运营主体、平台加资产公司模式或资产公司SaaS入口。
- 本次不扩展订阅、履约、资产运营或财务业务能力，仅完成车型主数据最终态初始化基础。
- 数据库集成测试出现一条来自`pg`的并发查询弃用提示，不影响本次测试结果；升级到`pg@9`前应单独治理。
- Next.js构建提示工作树环境存在多个工作区标识文件，不影响本次生产构建结果。

## 8. 结论

阶段0B已在独立全新数据库上完成从首个迁移到最终Schema的完整验证。车型枚举、兼容字段、运行时回退和外部兼容消费者均已清零，标准种子入口具备幂等性，API、Web、数据库集成和发布门禁全部通过，可作为后续阶段开发的新库基础。
