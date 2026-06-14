# Stage 9F-A 生产部署演练 Runbook

本文档是 `docs/production-deployment-runbook.md` 的中文版本，用于 Stage 9F-A：Production Deployment Dry Run。

本阶段目标不是直接上线，而是在准生产环境中验证完整部署链路：

```text
全新环境
  -> 配置 env
  -> PostgreSQL 准备
  -> prisma migrate deploy
  -> baseline seed
  -> API / Web 启动
  -> 域名 / HTTPS
  -> release:check
  -> smoke
  -> 备份恢复演练
```

## 1. 阶段边界

Stage 9F-A 只做部署演练资产和流程验证。

本阶段允许：

- 使用 Docker Compose 在准生产环境中演练部署；
- 使用占位符或准生产 secret；
- 执行 `prisma migrate deploy`；
- 执行 baseline seed；
- 执行 smoke；
- 执行备份与恢复演练；
- 记录部署证据和阻断项。

本阶段禁止：

- 不直接切真实生产流量；
- 不连接未经确认的真实生产数据库；
- 不提交真实服务器 IP；
- 不提交真实数据库密码；
- 不提交真实 `JWT_SECRET`；
- 不提交真实 `COOKIE_SECRET`；
- 不执行 `prisma migrate reset`；
- 不执行 `prisma db push`；
- 不修改业务逻辑；
- 不修改 Prisma schema；
- 不新增 migration；
- 不修改默认 seed 的业务数据策略。

## 2. 目标域名

当前域名：

```text
keybox.cloud
```

已完成 ICP 备案：

```text
沪ICP备18045696号
```

推荐第一版线上域名结构：

```text
admin.subauto.keybox.cloud  -> Web 管理后台
api.subauto.keybox.cloud    -> API 服务
subauto.keybox.cloud        -> 未来官网 / 客户下单入口
```

DNS / HTTPS / Cookie / CORS 细节见：

```text
docs/domain-dns-ssl.md
```

## 3. 推荐部署架构

第一版建议采用低复杂度单服务器部署：

```text
Caddy HTTPS 反向代理
  -> Web container :3000
  -> API container :3001

API
  -> PostgreSQL
  -> API uploads volume

PostgreSQL
  -> pg_dump 备份
```

仓库已提供：

```text
Dockerfile.api
Dockerfile.web
docker-compose.prod.example.yml
Caddyfile.example
.env.production.example
```

说明：

- `postgres` 使用 named volume；
- `api` 通过 `DATABASE_URL` 连接 PostgreSQL；
- `web` 在构建期读取 `NEXT_PUBLIC_API_BASE_URL`；
- `reverse-proxy` 使用 Caddy 自动处理 HTTPS；
- API 上传文件使用 `api_uploads` volume；
- 后续规模扩大后，建议迁移到托管 PostgreSQL 和对象存储。

## 4. 当前构建与启动命令

| 模块 | 命令 |
| --- | --- |
| API build | `pnpm --filter @subscription-saas/api build` |
| API start | `pnpm --filter @subscription-saas/api start` |
| Web build | `pnpm --filter @subscription-saas/web build` |
| Web start | `pnpm --filter @subscription-saas/web start` |
| Prisma generate | `pnpm prisma:generate` |
| Prisma migrate deploy | `pnpm prisma:migrate:deploy` |
| Prisma migrate status | `pnpm prisma:migrate:status` |
| baseline seed | `pnpm prisma:seed` |
| release check | `pnpm release:check` |
| API smoke | `pnpm smoke:api` |
| mainline smoke | `pnpm smoke:mainline` |
| residual smoke | `pnpm smoke:residual` |

默认 `pnpm prisma:seed` 只能初始化 baseline master data。

复杂验收数据必须使用 scenario seed，且只允许在开发 / 验收 / 准生产演练环境执行，不用于真实生产 cutover。

## 5. 服务器准备

准生产服务器建议准备：

- Linux 服务器；
- Docker Engine；
- Docker Compose plugin；
- 开放 `80` 和 `443`；
- SSH 访问受控；
- 足够磁盘空间用于 PostgreSQL、上传文件、Caddy 证书和备份；
- 独立备份目录；
- 日志查看和磁盘空间监控手段。

不要把生产部署目录放在桌面同步盘或不稳定挂载目录中。

## 6. 环境变量准备

服务器上复制模板：

```bash
cp .env.production.example .env.production
cp Caddyfile.example Caddyfile
```

只在服务器上编辑 `.env.production`。

必须配置：

```text
POSTGRES_PASSWORD=<生产或准生产数据库密码>
DATABASE_URL=postgresql://subscription:<password>@postgres:5432/subscription_saas?schema=public
JWT_SECRET=<长随机 secret>
COOKIE_SECRET=<长随机 secret>
SEED_ADMIN_PASSWORD=<初始管理员密码>
CORS_ORIGIN=https://admin.subauto.keybox.cloud
NEXT_PUBLIC_API_BASE_URL=https://api.subauto.keybox.cloud/api
SMOKE_API_BASE_URL=https://api.subauto.keybox.cloud/api
SMOKE_WEB_BASE_URL=https://admin.subauto.keybox.cloud
```

禁止提交：

```text
.env.production
真实 DATABASE_URL
真实数据库密码
真实 JWT_SECRET
真实 COOKIE_SECRET
真实服务器 IP
```

## 7. Docker Compose 配置校验

在部署前先校验 Compose：

```bash
docker compose --env-file .env.production -f docker-compose.prod.example.yml config
```

本地也可用占位模板做 dry run：

```powershell
Copy-Item .env.production.example .env.production -Force
docker compose --env-file .env.production -f docker-compose.prod.example.yml config
Remove-Item .env.production
```

该命令只校验配置，不启动真实服务。

## 8. 构建镜像

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production build
```

注意：

- Web 的 `NEXT_PUBLIC_API_BASE_URL` 是构建期变量；
- 如果 API 域名变化，需要重新构建 Web；
- 不要把本地源码 volume 挂入生产容器；
- 不要把 `.env.production` 打进镜像。

## 9. 启动 PostgreSQL

先启动 PostgreSQL：

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production up -d postgres
docker compose -f docker-compose.prod.example.yml --env-file .env.production ps
```

确认 PostgreSQL health check 通过后再执行 migration。

## 10. migration 前备份

如果不是全新空库，migration 前必须备份：

```bash
DATABASE_URL="<DATABASE_URL>" ./scripts/backup-postgres.example.sh
```

对于全新准生产 dry run 空库，记录：

```text
fresh database, no previous data
```

备份文件不得提交到 Git。

## 11. Prisma migrate deploy

只允许使用：

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production run --rm api pnpm prisma:migrate:deploy
docker compose -f docker-compose.prod.example.yml --env-file .env.production run --rm api pnpm prisma:migrate:status
```

生产和准生产均禁止：

```text
prisma migrate reset
prisma db push
手工删除 _prisma_migrations
```

如果 migration 失败：

1. 停止部署；
2. 保留日志；
3. 不继续 seed；
4. 评估是否恢复备份或 forward fix；
5. 记录为 release blocker。

## 12. baseline seed

migration 成功后执行：

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production run --rm api pnpm prisma:seed
```

seed 要求：

- 只初始化权限、角色、菜单、基础用户、基础产品、押金规则、车辆资产池等 baseline master data；
- 不创建复杂流程验收数据；
- 不创建进件、报价、订单、合同、账单、收款、交付、退车、催收或权益履约数据；
- 初始管理员登录后必须修改密码。

真实生产 cutover 不执行 scenario seed。

## 13. 启动 API / Web / Caddy

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production up -d
docker compose -f docker-compose.prod.example.yml --env-file .env.production ps
```

查看日志：

```bash
docker compose -f docker-compose.prod.example.yml logs --tail=100 api
docker compose -f docker-compose.prod.example.yml logs --tail=100 web
docker compose -f docker-compose.prod.example.yml logs --tail=100 reverse-proxy
```

## 14. HTTPS 与健康检查

确认 DNS 已指向服务器后检查：

```bash
curl -fsS https://api.subauto.keybox.cloud/api/health
```

浏览器打开：

```text
https://admin.subauto.keybox.cloud
https://api.subauto.keybox.cloud/api/health
```

确认：

- 证书有效；
- HTTPS 可访问；
- API health 返回 OK；
- 登录 cookie 为 secure；
- Web 请求的是线上 API 域名。

## 15. smoke 验证

基础 smoke：

```bash
SMOKE_API_BASE_URL=https://api.subauto.keybox.cloud/api \
SMOKE_WEB_BASE_URL=https://admin.subauto.keybox.cloud \
SMOKE_ADMIN_USERNAME=admin \
SMOKE_ADMIN_PASSWORD="<INITIAL_ADMIN_PASSWORD>" \
pnpm smoke:api
```

准生产 / 验收环境可执行 scenario smoke：

```bash
pnpm seed:scenario cleanup
pnpm seed:scenario mainline
pnpm seed:scenario residual
pnpm smoke:mainline
pnpm smoke:residual
pnpm seed:scenario cleanup
```

说明：

- scenario seed 只清理 `SCN9_` 前缀数据；
- scenario seed 不用于真实生产；
- smoke 失败必须记录失败项、HTTP status 和日志。

## 16. release:check

默认模式：

```bash
pnpm release:check
```

准生产完整模式：

```bash
RUN_RELEASE_SCENARIOS=1 \
RUN_RELEASE_SMOKE=1 \
SMOKE_API_BASE_URL=https://api.subauto.keybox.cloud/api \
SMOKE_WEB_BASE_URL=https://admin.subauto.keybox.cloud \
pnpm release:check
```

Windows PowerShell：

```powershell
$env:RUN_RELEASE_SCENARIOS="1"
$env:RUN_RELEASE_SMOKE="1"
$env:SMOKE_API_BASE_URL="https://api.subauto.keybox.cloud/api"
$env:SMOKE_WEB_BASE_URL="https://admin.subauto.keybox.cloud"
pnpm release:check
```

执行后建议：

```bash
pnpm seed:scenario cleanup
```

## 17. 备份恢复演练

备份：

```bash
DATABASE_URL="<DATABASE_URL>" ./scripts/backup-postgres.example.sh
```

恢复前必须停止写入流量。

恢复：

```bash
DATABASE_URL="<DATABASE_URL>" ./scripts/restore-postgres.example.sh backups/<backup-file>.dump
```

恢复后验证：

```bash
pnpm prisma:migrate:status
curl -fsS https://api.subauto.keybox.cloud/api/health
pnpm smoke:api
```

## 18. 人工验收

参考：

```text
docs/manual-acceptance.md
docs/release-checklist.md
docs/mainline-acceptance-freeze.md
docs/production-cutover-checklist.md
```

最低验收范围：

- 管理员登录；
- 权限和菜单刷新；
- 进件列表；
- 车辆列表；
- 订单列表；
- 报表首页；
- 资产经营分析；
- residual market；
- vehicle valuation review；
- CSV 导出抽查；
- audit log 抽查。

## 19. 回滚原则

应用回滚：

```bash
git checkout <PREVIOUS_RELEASE_TAG_OR_COMMIT>
docker compose -f docker-compose.prod.example.yml --env-file .env.production build
docker compose -f docker-compose.prod.example.yml --env-file .env.production up -d
pnpm smoke:api
```

数据库回滚：

```bash
DATABASE_URL="<DATABASE_URL>" ./scripts/restore-postgres.example.sh backups/<backup-file>.dump
pnpm prisma:migrate:status
pnpm smoke:api
```

如果 migration 已执行，数据库回滚应优先基于备份恢复或经过评审的 forward-fix migration。

不要手工修改 `_prisma_migrations`。

## 20. 演练证据记录

Stage 9F-A 完成后记录：

| 项目 | 记录 |
| --- | --- |
| release tag | `<TAG>` |
| commit | `<SHA>` |
| dry-run server | `<HOST>` |
| DNS 状态 | `<RESULT>` |
| compose config | `<PASSED / FAILED>` |
| image build | `<PASSED / FAILED>` |
| migrate deploy | `<PASSED / FAILED>` |
| migrate status | `<PASSED / FAILED>` |
| baseline seed | `<PASSED / FAILED>` |
| health check | `<PASSED / FAILED>` |
| smoke | `<PASSED / FAILED>` |
| backup file | `<BACKUP_FILE>` |
| restore drill | `<PASSED / FAILED>` |
| blockers | `<NONE / LIST>` |
| 验收人 | `<NAME>` |

## 21. 进入 Stage 9F-B 的条件

只有全部满足后，才建议进入 Production Cutover：

- Compose config 通过；
- Docker image build 通过；
- fresh PostgreSQL migrate deploy 通过；
- baseline seed 通过；
- API/Web/Caddy 启动通过；
- HTTPS 通过；
- `release:check` 通过；
- smoke 通过；
- 备份恢复演练通过；
- release blockers = 0；
- 人工验收签收完成。

Stage 9F-B 才是真实生产切换阶段。
