# Stage 10X-M-A ModelDefinition Low-risk Backfill

## 1. 目标

Stage 10X-M-A 将 10X-L dry-run 已确认 100% 可映射的低风险历史数据写入 `modelDefinitionId`。

回填范围仅限：

```text
Vehicle.modelDefinitionId
VehiclePackage.modelDefinitionId
ProductPriceRule.modelDefinitionId
```

本阶段不新增 migration，不修改 schema，不修改业务逻辑，不删除 legacy 字段。

## 2. 不回填范围

本阶段明确不回填：

```text
SubscriptionQuote
SubscriptionOrder
VehicleMarketPriceObservation
VehicleResidualCurve
VehicleResidualForecast
ResidualModelRun
```

原因：

```text
Quote / Order 是历史报价和订单快照，需要 additive snapshot 字段设计
Residual 仍存在 legacy brand / series / model 维度规范化问题，需要人工 mapping review
```

## 3. 脚本和命令

新增脚本：

```text
scripts/model-definition-backfill.mjs
scripts/model-definition-backfill-core.mjs
scripts/model-definition-backfill-core.test.mjs
```

命令：

```powershell
pnpm model-definition:backfill:dry-run
$env:MODEL_DEFINITION_BACKFILL_APPLY="1"; pnpm model-definition:backfill:apply
pnpm model-definition:backfill:test
```

10X-L 全量分析命令继续保留：

```powershell
pnpm model-definition:backfill-dry-run
```

脚本每次运行都会输出：

```text
.tmp/model-definition-backfill/latest.json
.tmp/model-definition-backfill/latest.md
```

`.tmp/` 已在 `.gitignore` 中，不纳入版本控制。

## 4. 安全阀

默认模式是 dry-run：

```powershell
pnpm model-definition:backfill:dry-run
```

apply 必须同时满足：

```text
命令包含 --apply
环境变量 MODEL_DEFINITION_BACKFILL_APPLY=1
```

如果缺少环境变量，脚本失败：

```text
Backfill apply requires MODEL_DEFINITION_BACKFILL_APPLY=1.
```

production 额外安全阀：

```text
APP_ENV=production 或 NODE_ENV=production 时，apply 默认拒绝
只有同时设置 ALLOW_PRODUCTION_MODEL_DEFINITION_BACKFILL=1 才允许继续
```

production apply 前必须完成备份和人工审批。

## 5. 回填规则

三张表共用同一规则：

```text
legacy VehicleModel -> VehicleModelDefinition.legacyVehicleModel
只使用 deletedAt=null、enabled=true、legacyVehicleModel not null 的主数据
已有 modelDefinitionId 的记录跳过，不覆盖
unresolved / conflict 任一存在时禁止 apply
apply 在 transaction 中执行
每条记录用 updateMany where id + modelDefinitionId=null 防止并发覆盖
```

## 6. Dry-run 结果

执行命令：

```powershell
pnpm model-definition:backfill:dry-run
```

执行环境：

```text
NODE_ENV=development
APP_ENV unset
isProduction=false
```

结果：

| Table | total | matched | skippedExisting | unresolved | conflicts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Vehicle | 13 | 10 | 3 | 0 | 0 |
| VehiclePackage | 7 | 6 | 1 | 0 | 0 |
| ProductPriceRule | 3 | 2 | 1 | 0 | 0 |
| Total | 23 | 18 | 5 | 0 | 0 |

结论：

```text
dry-run clean
unresolved=0
conflicts=0
可以在非 production 环境执行 apply
```

## 7. Apply 结果

本轮已在本地/dev 数据库执行 apply：

```powershell
$env:MODEL_DEFINITION_BACKFILL_APPLY="1"; pnpm model-definition:backfill:apply
```

执行环境：

```text
NODE_ENV=development
APP_ENV unset
isProduction=false
Production not executed
```

结果：

| Table | matched | updated | skippedExisting | unresolved | conflicts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Vehicle | 10 | 10 | 3 | 0 | 0 |
| VehiclePackage | 6 | 6 | 1 | 0 | 0 |
| ProductPriceRule | 2 | 2 | 1 | 0 | 0 |
| Total | 18 | 18 | 5 | 0 | 0 |

## 8. 幂等复跑

apply 后再次执行：

```powershell
pnpm model-definition:backfill:dry-run
```

结果：

| Table | total | matched | skippedExisting | unresolved | conflicts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Vehicle | 13 | 0 | 13 | 0 | 0 |
| VehiclePackage | 7 | 0 | 7 | 0 | 0 |
| ProductPriceRule | 3 | 0 | 3 | 0 | 0 |
| Total | 23 | 0 | 23 | 0 | 0 |

结论：

```text
脚本可重复执行
第二次无待回填记录
不会覆盖已有 modelDefinitionId
执行 pnpm prisma:seed 和验证测试后再次 dry-run，结果仍为 matched=0 / skippedExisting=23 / unresolved=0 / conflicts=0
```

## 9. 命令级安全验证

执行：

```powershell
pnpm model-definition:backfill:apply
```

未设置 `MODEL_DEFINITION_BACKFILL_APPLY=1` 时，命令失败：

```text
Backfill apply requires MODEL_DEFINITION_BACKFILL_APPLY=1.
```

## 10. Production Runbook

production 执行前必须：

```text
1. 备份数据库
2. 执行 pnpm model-definition:backfill:dry-run
3. 确认 unresolved=0 且 conflicts=0
4. 人工审批 dry-run 报告
5. 设置 MODEL_DEFINITION_BACKFILL_APPLY=1
6. 如 APP_ENV 或 NODE_ENV 为 production，再设置 ALLOW_PRODUCTION_MODEL_DEFINITION_BACKFILL=1
7. 执行 pnpm model-definition:backfill:apply
8. 再次执行 pnpm model-definition:backfill:dry-run 验证幂等
```

本轮没有执行 production apply。

## 11. 后续阶段

建议继续：

```text
Stage 10X-M-B: Quote / Order additive snapshot 字段设计
Stage 10X-M-C: Residual legacy dimension mapping review
```

M-B 不应原地覆盖 Quote / Order 历史快照，而应先设计 `modelDefinitionSnapshot`、`modelDisplayNameSnapshot`、`legacyVehicleModelSnapshot` 等 additive 字段。
