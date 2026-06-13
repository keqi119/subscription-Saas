# Stage 9D Release Checklist

本文档用于发布前检查、发布执行和发布后回归。它把 Stage 9B/9C 已完成的 CI、部署、备份恢复、scenario seed、smoke 和人工验收路径收束为一套可执行清单。

## 1. Release 基本信息

| 项目 | 填写 |
| --- | --- |
| Release 名称 |  |
| Release 日期 |  |
| 目标环境 | dev / staging / production |
| Git branch |  |
| Git commit |  |
| migration 数量 |  |
| 是否包含 schema 变更 | 是 / 否 |
| 是否需要默认 seed | 是 / 否 |
| 是否需要 scenario seed | 仅 dev/staging 可选，production 必须为否 |
| 负责人 |  |
| 验收人 |  |
| 回滚负责人 |  |

## 2. Release 前置检查

发布前必须完成：

- `git status --short` 为空。
- 当前分支为 `main`、release 分支或指定发布分支。
- `pnpm prisma:validate` 通过。
- `pnpm prisma:generate` 通过。
- `pnpm -r lint` 通过。
- API typecheck 通过。
- Web typecheck 通过。
- API tests 通过。
- `pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma` 检查完成。
- CI 全部通过。
- `.env` / 平台环境变量已确认。
- 数据库备份已完成且可定位。
- `docs/backup-restore.md` 中的恢复流程已确认。
- `docs/manual-acceptance.md` 的人工验收负责人已确认。

本地发布前门禁：

```powershell
pnpm release:check
```

默认 `release:check` 不执行 scenario seed，也不执行 smoke。

## 3. Migration 检查

生产发布只允许使用：

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
```

要求：

- migration 前必须完成数据库备份。
- migration 前后都必须执行 migrate status。
- migration 失败必须停止发布。
- migration 失败后不得继续启动新版本服务。
- 生产环境禁止 `prisma migrate reset`。
- 生产环境禁止 `prisma db push`。

## 4. Seed 检查

默认 seed 策略：

- `pnpm prisma:seed` 只初始化 baseline master data。
- baseline master data 包括用户、角色、权限、菜单、客户线索、产品、套餐、押金规则、baseline 车辆池和车辆销售价初始化记录。
- 默认 seed 不得创建进件、报价、订单、合同、账单、收款、交付、退车、催收、残值预测或估值复核等复杂流程数据。
- 生产环境执行默认 seed 必须经发布负责人确认。
- seed 后如权限或菜单变化，必须退出并重新登录刷新 JWT。

## 5. Scenario Seed 检查

scenario seed 只允许在开发 / 验收环境执行：

```powershell
pnpm seed:scenario cleanup
pnpm seed:scenario mainline
pnpm seed:scenario residual
pnpm seed:scenario all
```

约束：

- scenario seed 只清理 `SCN9_` 前缀数据。
- scenario seed 输出 `.tmp/scenarios/*.json`。
- scenario seed 使用专用车辆，不污染 baseline vehicle pool。
- scenario seed 不得用于生产环境。
- `release:check` 默认不执行 scenario seed。

需要本地 release gate 同时执行 scenario seed 时：

```powershell
$env:RUN_RELEASE_SCENARIOS="1"; pnpm release:check
```

## 6. Smoke 检查

API smoke：

```powershell
pnpm smoke:api
```

场景 smoke：

```powershell
pnpm smoke:mainline
pnpm smoke:residual
```

说明：

- `smoke:api` 校验基础 API：health、login、`/auth/me`、核心列表、报表、系统接口。
- `smoke:mainline` 读取 `.tmp/scenarios/mainline.json` 并校验客户、进件、车辆等详情。
- `smoke:residual` 读取 `.tmp/scenarios/residual.json` 并校验车辆、残值曲线、单车预测、估值复核。
- Web route 检查需要设置 `SMOKE_WEB_BASE_URL`。

PowerShell 示例：

```powershell
$env:SMOKE_API_BASE_URL="http://localhost:3001"
$env:SMOKE_WEB_BASE_URL="http://localhost:3000"
pnpm smoke:api
```

需要本地 release gate 同时执行 smoke 时：

```powershell
$env:RUN_RELEASE_SMOKE="1"; pnpm release:check
```

## 7. 人工验收检查

人工验收以 `docs/manual-acceptance.md` 为准。发布前至少覆盖：

- 登录 / 权限刷新
- A/B 进件
- 审核
- 报价
- 订单
- 合同
- 初始账单 / 收款
- 交付
- 权益
- 月租
- 逾期催收
- 退车
- 损伤费
- 押金扣减 / 退款
- 车辆再入池
- 经营看板
- 资产经营分析
- 残值样本
- 残值曲线
- 单车残值预测
- 预测点采用
- 估值复核
- CSV 导出
- 审计日志抽查

人工验收中使用 scenario seed 时，以 `docs/scenario-seeds.md` 为准。

## 8. Release 执行顺序

推荐顺序：

1. 确认发布 commit 和分支。
2. 确认 CI 通过。
3. 备份数据库。
4. 确认环境变量。
5. 安装依赖。
6. 执行 `prisma migrate deploy`。
7. 执行 `prisma generate`。
8. 根据发布计划确认是否执行默认 seed。
9. 构建并启动 API。
10. 构建并启动 Web。
11. 执行 health check。
12. 执行 smoke。
13. 执行人工验收。
14. 检查错误日志、审计日志和权限菜单。

## 9. Release 后检查

发布后必须检查：

- 服务健康检查通过。
- 登录 smoke 通过。
- 关键 API smoke 通过。
- 关键页面 smoke 通过。
- API 错误日志无新增异常。
- Web 错误日志无新增异常。
- 审计日志有关键动作记录。
- 数据库连接正常。
- 权限菜单正常。
- 备份文件仍可定位。

## 10. 回滚条件

以下情况必须停止发布或触发回滚：

- migration 失败。
- 服务启动失败。
- 登录失败。
- 核心 smoke 失败。
- API test 在 CI 中失败。
- 权限菜单大面积异常。
- 关键业务状态机异常。
- 数据库备份不可用。
- 默认 seed 污染复杂业务流程数据。
- scenario cleanup 误删 baseline 数据。

## 11. 回滚步骤

回滚步骤：

1. 停止继续发布。
2. 记录当前 commit、migration 状态、错误日志和负责人。
3. 回滚代码到上一稳定 commit 或上一 release tag。
4. 重启 API / Web 服务。
5. 如已执行 migration 且需要数据回退，以数据库备份恢复为主。
6. 恢复后执行 migrate status。
7. 恢复后执行 health check。
8. 恢复后执行 smoke。
9. 记录事故、处理动作和最终结论。

参考 `docs/backup-restore.md`。

## 12. 发布阻断条件

以下任一项未满足，不允许进入发布：

- `pnpm release:check` 未通过。
- CI 未通过。
- migrate status 不正常。
- 数据库备份缺失。
- 环境变量未确认。
- 核心 smoke 未通过。
- release checklist 未填写负责人和验收人。
- manual acceptance 无法完成最小主线。
