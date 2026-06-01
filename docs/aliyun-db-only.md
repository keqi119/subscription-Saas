# 阿里云方案 A：服务器只跑数据库，本地跑应用

本方案用于阶段 1 快速验证登录、RBAC、菜单权限和审计日志：

- 阿里云轻量服务器运行 PostgreSQL + Redis。
- 本地电脑继续运行 Next.js Web 和 NestJS API。
- PostgreSQL/Redis 不开放公网端口，只通过 SSH 隧道访问。

服务器信息：

- 公网 IP：`139.196.227.195`
- 私网 IP：`172.24.18.174`
- 实例 ID：`e81c1a9c7b2e4fe79367f04045150b57`

## 1. 服务器侧启动数据库

在宝塔面板终端或 SSH 里执行：

```bash
mkdir -p /opt/subscription-saas-db
```

从本地把数据库部署文件上传到服务器：

```powershell
scp deploy/aliyun/db-only/docker-compose.yml root@139.196.227.195:/opt/subscription-saas-db/
scp deploy/aliyun/db-only/.env.example root@139.196.227.195:/opt/subscription-saas-db/.env
```

登录服务器并编辑真实密码：

```bash
ssh root@139.196.227.195
cd /opt/subscription-saas-db
openssl rand -base64 32
vi .env
```

把 `.env` 中的 `POSTGRES_PASSWORD` 和 `REDIS_PASSWORD` 改成强密码。

启动服务：

```bash
docker compose up -d
docker compose ps
```

如果服务器只有旧版 Docker Compose，使用：

```bash
docker-compose up -d
docker-compose ps
```

## 2. 本地打开 SSH 隧道

在本地 PowerShell 执行：

```powershell
.\scripts\start-aliyun-db-tunnel.ps1 -User root
```

这个窗口需要保持打开。隧道建立后，本地会看到：

- `localhost:5432` -> 服务器 PostgreSQL
- `localhost:6379` -> 服务器 Redis

本地验证端口：

```powershell
Test-NetConnection localhost -Port 5432
Test-NetConnection localhost -Port 6379
```

## 3. 本地更新环境变量

更新根目录 `.env`：

```env
DATABASE_URL=postgresql://subscription:<POSTGRES_PASSWORD>@localhost:5432/subscription_saas?schema=public
REDIS_URL=redis://:<REDIS_PASSWORD>@localhost:6379
SEED_ADMIN_PASSWORD=Admin@123456
```

如果密码包含 `@`、`#`、`:`、`/` 等特殊字符，需要在 URL 中做 percent-encoding。

## 4. 本地执行迁移和 seed

保持 SSH 隧道打开，然后执行：

```powershell
pnpm prisma:migrate
pnpm prisma:seed
pnpm prisma:validate
pnpm dev
```

登录账号：

- 账号：`admin`
- 密码：`Admin@123456`

## 5. 安全注意

不要在阿里云安全组或宝塔防火墙开放 `5432` / `6379` 公网端口。
本方案的 `docker-compose.yml` 已经把数据库端口绑定到服务器 `127.0.0.1`，外网不能直接访问。
