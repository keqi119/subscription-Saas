# 纯电汽车订阅运营中台

上海二手纯电车辆订阅运营 Back Office。首期面向内部运营团队，优先跑通
客户、进件、风控、产品套餐、报价、订单、合同、车辆资产池和后续账务/资产报表闭环。

当前项目路径：

```text
D:\Projects\auto-subscription-platform
```

## 当前阶段

当前本地分支是 `feature/stage5-optimization`。代码已完成阶段 5 基线并进入阶段 5
优化后的接管校准：

- 已有登录、JWT Cookie、RBAC、菜单权限、用户/角色/权限管理、审计日志。
- 已有客户中心、进件管理、资料上传、进件审核、风控审批、A/B/C 押金规则。
- 已有产品、产品版本、旧版 `ProductPriceRule`、产品组件包和 `SubscriptionPlan`。
- 已有订阅报价、订单、合同模板、合同管理、订单变更基础能力。
- 已新增车辆资产池、车辆当前销售价初始化、季度 review、销售价历史、可用车辆接口。
- 当前仍有大量未提交文件，开发前必须先确认工作区和 migration 状态。

`ProductPriceRule` 是旧版价格规则，保留兼容历史报价。新版报价入口是
`SubscriptionPlan`，销售在已审批通过的进件中选择具体车辆和启用套餐生成报价。

## 技术栈

- pnpm workspace
- Next.js + React + Ant Design：`apps/web`
- NestJS：`apps/api`
- PostgreSQL + Prisma
- Redis：后续用于缓存、任务锁和异步任务状态
- Vitest + TypeScript

## 文档入口

- `DEV_SPEC.md`：当前主线业务规格
- `AGENTS.md`：Codex / Agent 执行规则
- `CODEX_TASKS.md`：Stage 0-9 后续开发计划
- `docs/aliyun-db-only.md`：阿里云方案 A，服务器只跑 PostgreSQL/Redis，本地跑应用

## 本地开发启动

安装依赖：

```powershell
corepack enable
corepack prepare pnpm@11.4.0 --activate
pnpm install
```

准备环境变量：

```powershell
Copy-Item .env.example .env
```

可选：使用本地 Docker PostgreSQL/Redis：

```powershell
docker compose up -d postgres redis
```

迁移、seed、校验：

```powershell
pnpm prisma:migrate
pnpm prisma:seed
pnpm prisma:validate
```

启动开发服务：

```powershell
pnpm dev
```

默认端口：

- Web: <http://localhost:3000>
- API: <http://localhost:3001/api/health>

默认种子账号：

- 账号：`admin`
- 密码：`Admin@123456`

如果 seed 更新了权限或菜单，必须重新登录以刷新 JWT 中的 permissions。

## SSH Tunnel / PostgreSQL 注意事项

当前本地开发可能依赖 SSH tunnel 连接远程 PostgreSQL。开始开发前确认：

- `.env` 中 `DATABASE_URL` 指向实际可用数据库。
- SSH tunnel 已启动并将远端 PostgreSQL 映射到 `127.0.0.1:5432`。
- Redis 如需使用，也确认 `127.0.0.1:6379` 可达。
- 如果不使用远程数据库，可以改用 `docker-compose.yml` 提供的本地 PostgreSQL/Redis。

不要使用旧 OneDrive 目录中的项目副本。

## 开发前检查

每轮任务开始前先运行：

```powershell
git status --short
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm prisma:validate
```

如果 migration status 失败、出现 pending migration，或本地数据库不可达，请先记录并处理，
不要继续扩大业务代码修改。

## 常用命令

```powershell
pnpm dev
pnpm build
pnpm -r lint
pnpm -r test
pnpm prisma:validate
pnpm prisma:generate
pnpm prisma:migrate
pnpm prisma:seed
```

## 质量门禁

文档校准或代码修改完成后建议跑：

```powershell
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

## 当前核心业务链路

```text
客户创建
  -> 进件提交
  -> 风控审批通过并写入客户等级/押金规则
  -> 产品中心配置 ProductVersion + SubscriptionPlan
  -> 车辆资产初始化 currentSalePriceAmount 并进入 AVAILABLE
  -> 进件详情选择 vehicleId + subscriptionPlanId 生成报价
  -> 系统按 currentSalePriceAmount 计算车辆基础费上限
  -> 报价确认后锁车 AVAILABLE -> RESERVED
  -> 从报价生成订单
  -> 生成/签署/归档合同
```

关键价格口径：

```text
车辆基础费上限 = currentSalePriceAmount * vehiclePackage.monthlyFeeRate
套餐总价 = 车辆基础费 + 里程包价格 + 补能包价格 + 权益包价格
```

`purchasePriceAmount` 用于资产成本、折旧、ROA/ROE；`currentSalePriceAmount`
用于报价定价。车辆基础费上限不约束套餐总价。

## 当前已实现模块

- Monorepo 项目骨架
- Auth / RBAC / 菜单 / 审计日志
- 客户中心和进件管理
- 风控审批和押金规则
- 产品中心、产品版本、旧版价格规则
- 车型包、里程包、补能包、权益包
- `SubscriptionPlan` 订阅套餐
- 订阅报价和历史报价兼容
- 订单、合同、合同模板、订单变更
- 车辆资产、销售价初始化、销售价 review、销售价历史、可用车辆列表
- 相关 API 单元测试/服务测试

## 当前待处理事项

- 确认大量未提交文件的提交边界。
- 确认 4 个未跟踪 migration 是否已经全部应用到目标数据库。
- 处理 `prisma migrate status` 当前失败的问题。
- 修复 `/api/vehicles/available` 可能因 JWT 缺 `vehicle:view` 导致的 Permission denied。
- 拆分 `vehicle:*` 和 `subscription_plan:*` 细粒度权限。
- 修复 Ant Design `Space direction`、`Drawer width` 迁移到 v6 推荐属性。
- 补齐独立 `VehicleStatusLog` 或等价状态日志。
- 跑完整质量门禁并处理阻断。

## 人工验收路径

1. 使用 `admin / Admin@123456` 登录后台。
2. 进入系统管理，确认用户、角色、权限、菜单正常。
3. 创建客户并提交进件。
4. 风控审批进件为通过，并确认客户等级和押金规则生效。
5. 在产品中心创建产品版本、组件包和启用的订阅套餐。
6. 在车辆资产中创建车辆，初始化当前销售价，流转到 `AVAILABLE`。
7. 在进件详情中打开报价，选择车辆和订阅套餐，输入车辆基础费。
8. 确认报价后检查车辆是否从 `AVAILABLE` 进入 `RESERVED`。
9. 从报价生成订单，生成并签署合同。
