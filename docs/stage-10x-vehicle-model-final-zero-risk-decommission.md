# Stage 0B 车型兼容能力最终退役状态

## 结论

阶段 0B 已在代码源层完成车型兼容字段硬移除：

- Prisma schema 不再包含 `VehicleModel` 枚举或旧兼容列。
- 车辆、车型包、价格规则统一使用必填 `modelDefinitionId`。
- 报价与订单统一保存 `modelDefinitionIdSnapshot`、`modelCodeSnapshot`、`modelDisplayNameSnapshot`。
- API、Portal、报表、CSV、Web 页面不再接受或输出旧车型兼容契约。
- 初始化种子直接创建车型主数据并按 ID 建立关系。
- 仅用于旧库回填或旧约束退役的脚本及命令入口已经下线。

本阶段采用全新数据库初始化，不承担旧测试库或历史业务库的数据兼容与回填。

## 可执行验收门

```powershell
node scripts/check-vehicle-model-no-compatibility.mjs
pnpm vehicle-model:removal-readiness
pnpm vehicle-model:contract-governance
```

预期结果：

```text
decision = READY
enumUsageCount = 0
externalUsageCount = 0
fallbackUsageCount = 0
readinessScore = 100
hardRemovalReady = true
```

外部兼容消费者登记以
[vehicle-model-external-contract-consumer-register.json](vehicle-model-external-contract-consumer-register.json)
为准。阶段 0B 基线的活跃消费者为零。

## 数据库声明

以上结论只说明源码和迁移链已经具备最终形态。数据库完成状态必须以独立新库
`subscription_saas_stage0b_verify` 的迁移、结构查询和两次幂等种子执行结果为准，
不得据此推断任何既有数据库已经升级。
