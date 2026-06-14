# 生产部署说明

本文档用于 Stage 9B Production Readiness Hardening，目标是把当前后台系统从“可本地运行”收口到“可按步骤部署、可回归、可回滚”的最小生产就绪状态。

部署前必须完成 `docs/release-checklist.md`。生产发布应先确认 CI、备份、migration、seed 策略、smoke 和人工验收负责人，再执行本文档中的部署步骤。

## 1. 部署目标和架构

当前系统是 pnpm workspace：

- API：NestJS，包名 `@subscription-saas/api`，默认端口 `3001`，健康检查 `GET /api/health`。
- Web：Next.js，包名 `@subscription-saas/web`，默认端口 `3000`。
- Database：PostgreSQL，通过 Prisma migration 管理。
- Redis：当前文档保留运行入口，后续用于缓存、任务锁和异步任务状态。

推荐生产拓扑：

```text
Nginx / HTTPS
  -> Web service :3000
  -> API service :3001
API service
  -> PostgreSQL
  -> Redis
```

## 2. 前置依赖

推荐版本：

- Node.js `>=20.9.0`，CI 使用 Node.js 22。
- pnpm `11.4.0`，通过 Corepack 或 pnpm/action-setup 管理。
- PostgreSQL 16。
- Redis 7 或兼容版本。

本地准备：

```powershell
corepack enable
corepack prepare pnpm@11.4.0 --activate
pnpm install
```

生产环境不要使用旧 OneDrive 项目副本。

## 3. 环境变量准备

复制模板：

```powershell
Copy-Item .env.example .env
```

核心变量：

| 变量 | 用途 | 备注 |
| --- | --- | --- |
| `NODE_ENV` | 运行环境 | 生产使用 `production` |
| `PORT` | API 监听端口 | API 当前实际读取 `PORT`，默认 `3001` |
| `API_PORT` | 部署文档端口标识 | 当前应用不直接读取，用于进程管理/文档统一 |
| `WEB_PORT` | Web 端口标识 | Web scripts 当前默认 `3000` |
| `DATABASE_URL` | PostgreSQL 连接 | 必填，生产必须使用真实 secret |
| `DATABASE_POOL_MAX` | PG 连接池最大连接数 | 默认 `10` |
| `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | PG 连接超时 | 默认 `10000` |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | PG idle 超时 | 默认 `30000` |
| `REDIS_URL` | Redis 连接 | 后续缓存和异步任务使用 |
| `JWT_SECRET` | JWT 签名密钥 | 生产必须使用长随机 secret |
| `JWT_EXPIRES_IN` | JWT 过期时间 | 默认 `7d` |
| `COOKIE_SECRET` | Cookie 签名预留 | 当前代码未直接读取，保留给签名 Cookie 扩展 |
| `CORS_ORIGIN` | API CORS 白名单 | 多域名用逗号分隔 |
| `API_JSON_BODY_LIMIT` | API JSON body 限制 | 默认 `5mb` |
| `LOCAL_FILE_STORAGE_DIR` | 本地文件存储目录 | 生产建议替换为持久化目录或对象存储 |
| `NEXT_PUBLIC_API_BASE_URL` | Web 浏览器访问 API 地址 | 例如 `https://api.example.com/api` |
| `SEED_ADMIN_PASSWORD` | seed 默认用户密码 | 生产初始化后应立刻改密 |

不要把真实 secret、生产数据库地址或云账号凭据提交到 Git。

Upload storage variables added in Stage 9G-A:

| Variable | Purpose | Notes |
| --- | --- | --- |
| `UPLOAD_STORAGE_DRIVER` | Upload storage driver | Default `local`; set `oss` after Aliyun OSS validation |
| `UPLOAD_LOCAL_DIR` | Local upload directory | Used by local provider and as fallback temp storage |
| `OSS_REGION` / `OSS_BUCKET` / `OSS_ENDPOINT` | Aliyun OSS target | Required only when `UPLOAD_STORAGE_DRIVER=oss` |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | Aliyun OSS credentials | Server secrets only; never commit to Git |
| `OSS_PREFIX` | Aliyun OSS object key prefix | Example: `subscription-saas/staging` |
| `OSS_INTERNAL_ENDPOINT` | Optional internal OSS endpoint | Use only when the server can reach OSS over an internal network |

## 4. 安装依赖

```powershell
pnpm install --frozen-lockfile
```

如需在开发机安装依赖，可使用：

```powershell
pnpm install
```

## 5. Prisma migrate deploy

生产和 CI 应使用：

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
```

迁移后确认：

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

禁止在生产执行：

```text
prisma migrate reset
prisma db push
```

## 6. Prisma generate

```powershell
pnpm prisma:generate
```

## 7. Seed 策略

默认 seed：

```powershell
pnpm prisma:seed
```

默认 `pnpm prisma:seed` 只应初始化 baseline master data：

- 权限、角色、菜单；
- 测试用户；
- 干净客户 leads；
- 产品/套餐；
- 押金规则；
- 车辆资产池；
- 车辆当前销售价初始化记录。

默认 seed 不应创建流程验收数据，例如进件、报价、订单、合同、账单、收款、交付、退车、催收或权益履约数据。

复杂验收数据应使用独立 scenario seed。Stage 9B 仅记录策略，不强制要求所有 scenario seed 已存在。

seed 更新权限或菜单后，用户必须退出并重新登录，刷新 token 中的权限投影。

## 8. API 启动

构建：

```powershell
pnpm --filter @subscription-saas/api build
```

启动：

```powershell
pnpm --filter @subscription-saas/api start
```

健康检查：

```powershell
Invoke-WebRequest http://localhost:3001/api/health
```

生产建议使用 systemd、PM2 或平台托管进程管理，确保异常退出后自动重启并接入日志采集。

## 9. Web 构建与启动

构建：

```powershell
pnpm --filter @subscription-saas/web build
```

启动：

```powershell
pnpm --filter @subscription-saas/web start
```

Web 需要通过 `NEXT_PUBLIC_API_BASE_URL` 指向可被浏览器访问的 API 地址。

## 10. Smoke check

API/Web 服务启动并完成 seed 后执行：

```powershell
pnpm smoke
```

可选环境变量：

```powershell
$env:SMOKE_API_BASE_URL="http://localhost:3001/api"
$env:SMOKE_WEB_BASE_URL="http://localhost:3000"
$env:SMOKE_ADMIN_USERNAME="admin"
$env:SMOKE_ADMIN_PASSWORD="Admin@123456"
pnpm smoke
```

脚本会验证：

- `GET /api/health`
- 登录；
- `GET /api/auth/me`
- 关键 API 列表；
- 如果设置 `SMOKE_WEB_BASE_URL`，会检查关键前端路由是否返回非 4xx/5xx。

## 11. 常见故障

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `DATABASE_URL is required` | `.env` 未加载或变量缺失 | 检查 `.env` 和进程环境 |
| migration pending | 未执行 `migrate deploy` | 部署前先执行迁移 |
| 登录失败 | seed 未执行或密码不一致 | 执行 seed，确认 `SEED_ADMIN_PASSWORD` |
| 权限菜单缺失 | token 未刷新 | 退出并重新登录 |
| CORS 报错 | `CORS_ORIGIN` 未包含 Web 域名 | 更新环境变量并重启 API |
| Web 请求本地 API | `NEXT_PUBLIC_API_BASE_URL` 配置错误 | 重新构建 Web |

## 12. 回滚原则

代码问题优先回滚应用版本：

```text
停止新版本 -> 切回上一版本 artifact/commit -> 重启服务 -> smoke check
```

如果已经执行 migration 且出现数据或 schema 问题，优先使用迁移前备份恢复，详见 `docs/backup-restore.md`。

不要用 `migrate reset` 或 `db push` 作为生产回滚手段。
