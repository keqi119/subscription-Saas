# Stage 0B 车型最终 Schema 初始化说明

## 最终模型

全新数据库只使用以下车型身份：

```text
VehicleModelDefinition.id
VehicleModelDefinition.modelCode
VehicleModelDefinition.displayName
```

业务关系：

| 对象 | 最终字段 |
| --- | --- |
| `Vehicle` | 必填 `modelDefinitionId` |
| `VehiclePackage` | 必填 `modelDefinitionId` |
| `ProductPriceRule` | 必填 `modelDefinitionId`，按产品版本与车型主数据唯一 |
| `SubscriptionQuote` | 三个必填车型快照字段 |
| `SubscriptionOrder` | 三个必填车型快照字段 |

运行时写入只接受主数据 ID；列表、详情和导出使用 `modelCode` 与
`modelDisplayName`；合同事实读取不可变快照，不读取车辆当前车型主数据来改写历史含义。

## 初始化边界

阶段 0B 明确使用全新数据库，因此：

1. 不回填旧测试数据。
2. 不保留旧字段双写、双读或字符串回退。
3. 不保留只服务于旧库的车型回填、报价/订单快照回填和旧价格规则约束退役脚本。
4. 历史迁移文件保持不变，最终形态通过新增迁移形成。

## 新库验收

目标数据库固定为：

```text
subscription_saas_stage0b_verify
```

验收顺序：

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm --filter @subscription-saas/api exec node prisma/seed.mjs
pnpm --filter @subscription-saas/api exec node prisma/seed.mjs
```

随后检查旧枚举和旧列均不存在，三个业务模型的 `model_definition_id` 以及报价、
订单三字段快照均为非空约束。任何验证不得复用阶段 0A 或当前测试数据库。
