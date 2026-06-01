# 纯电汽车订阅运营中台

上海二手纯电车辆订阅 / 以租代购业务后台运营中台。首期优先建设 Back Office，
不优先开发用户端 App。

需求基线见：

- `DEV_SPEC.md`：完整开发文档
- `AGENTS.md`：Codex 协作约束
- `CODEX_TASKS.md`：分阶段开发提示词
- `docs/aliyun-db-only.md`：阿里云方案 A，服务器只跑 PostgreSQL/Redis，本地跑应用

## 技术栈

- pnpm workspace
- Next.js + Ant Design：`apps/web`
- NestJS：`apps/api`
- PostgreSQL + Prisma
- Redis：后续用于缓存、任务锁和异步任务状态
- 本地文件存储：后续再替换为对象存储

## 快速启动

```bash
corepack enable
corepack prepare pnpm@11.4.0 --activate
pnpm install
cp .env.example .env
docker compose up -d postgres redis
pnpm prisma:migrate
pnpm prisma:seed
pnpm prisma:validate
pnpm dev
```

默认端口：

- Web: <http://localhost:3000>
- API: <http://localhost:3001/api/health>

## 常用命令

```bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm prisma:migrate
pnpm prisma:seed
pnpm prisma:validate
```

## 阶段边界

当前已进入阶段 3：账号密码登录、JWT Cookie、RBAC、菜单权限、用户/角色/权限管理、
审计日志、客户中心、进件管理、资料上传、基础进件流转、风控审批结果和 A/B/C 押金规则。
产品报价、车辆、合同、账务和报表等业务模块按 `CODEX_TASKS.md` 分阶段推进。

默认种子账号：

- 账号：`admin`
- 密码：`Admin@123456`

如果登录失败，先确认 API 和数据库已经启动，并且已经执行过 seed；否则默认账号不会存在。
在 Windows PowerShell 中可以用 `Copy-Item .env.example .env` 代替上面的 `cp .env.example .env`。
