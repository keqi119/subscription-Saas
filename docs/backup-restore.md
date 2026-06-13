# 备份与恢复说明

本文档用于 Stage 9B 生产就绪加固，覆盖 PostgreSQL 备份、恢复、恢复后校验和回滚注意事项。

## 1. 备份时机

必须备份：

- 生产部署前；
- 执行 `prisma migrate deploy` 前；
- seed 权限/菜单/主数据前；
- 大批量导入、批量复核、批量状态变更前；
- 数据修复或人工运维脚本执行前。

建议保留：

- 最近一次成功发布前备份；
- 最近 7 天每日备份；
- 最近 4 周每周备份。

具体保留周期以生产合规和成本策略为准。

## 2. pg_dump 备份示例

PowerShell 示例：

```powershell
$env:PGPASSWORD="<password>"
pg_dump `
  --host 127.0.0.1 `
  --port 5432 `
  --username subscription `
  --dbname subscription_saas `
  --format custom `
  --file "backup-subscription-saas-$(Get-Date -Format yyyyMMdd-HHmmss).dump"
```

Bash 示例：

```bash
export PGPASSWORD="<password>"
pg_dump \
  --host 127.0.0.1 \
  --port 5432 \
  --username subscription \
  --dbname subscription_saas \
  --format custom \
  --file "backup-subscription-saas-$(date +%Y%m%d-%H%M%S).dump"
```

如需纯 SQL：

```bash
pg_dump \
  --host 127.0.0.1 \
  --port 5432 \
  --username subscription \
  --dbname subscription_saas \
  --file backup-subscription-saas.sql
```

不要把备份文件提交到 Git。

## 3. 恢复流程

恢复前建议：

1. 停止 API 和 Web 写入流量。
2. 记录当前应用版本、migration 状态和事故原因。
3. 对当前故障库再做一次保护性备份，避免丢失排查证据。

使用 custom dump 恢复：

```powershell
$env:PGPASSWORD="<password>"
pg_restore `
  --host 127.0.0.1 `
  --port 5432 `
  --username subscription `
  --dbname subscription_saas `
  --clean `
  --if-exists `
  "backup-subscription-saas-YYYYMMDD-HHmmss.dump"
```

使用 SQL dump 恢复：

```powershell
$env:PGPASSWORD="<password>"
psql `
  --host 127.0.0.1 `
  --port 5432 `
  --username subscription `
  --dbname subscription_saas `
  --file backup-subscription-saas.sql
```

如需恢复到新库，先创建目标数据库，再执行恢复。

## 4. 恢复后校验

恢复后必须执行：

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm prisma:validate
pnpm prisma:generate
```

启动 API 后执行：

```powershell
Invoke-WebRequest http://localhost:3001/api/health
pnpm smoke
```

人工抽查：

- 管理员能登录；
- `/api/auth/me` 正常返回用户、角色、权限和菜单；
- `/applications`、`/vehicles`、`/orders`、`/reports` 等关键 API 不返回 500；
- 关键页面能打开；
- 最近发布涉及的业务对象存在且状态正确；
- AuditLog 中关键动作可追溯。

## 5. migration 前备份

执行生产 migration 前必须：

1. 确认当前 Git commit / release tag。
2. 执行 `pg_dump`。
3. 记录备份文件名、时间、数据库、执行人。
4. 执行 `prisma migrate status`。
5. 确认无意外 pending migration。
6. 执行 `prisma migrate deploy`。
7. 再次执行 `prisma migrate status`。

## 6. 回滚注意事项

代码回滚：

- 可切回上一版本应用 artifact/commit；
- 重启 API/Web；
- 执行 smoke check。

数据库回滚：

- 已执行 migration 的回滚必须以备份恢复为主，或明确设计 forward-fix migration；
- 不要手工删除 migration 记录；
- 不要在生产执行 `migrate reset`；
- 不要在生产执行 `db push`；
- 如果 migration 已产生不可逆数据变更，必须先评估数据补偿方案。

## 7. 禁止事项

生产环境禁止：

```text
prisma migrate reset
prisma db push
手工删除 _prisma_migrations
把备份文件提交到 Git
在未备份情况下执行 schema migration
```
