# Stage 9A 发布准备与 CI/CD 文档级审计报告

> 审计日期：2026-06-13  
> 审计范围：仅做文档级、流程级、产品闭环级审计。  
> 明确边界：未读取真实业务代码，未运行 API、数据库、浏览器或测试命令。

## 1. 审计输入

本次审计参考以下文档和阶段记录：

- `DEV_SPEC.md`
- `CODEX_TASKS.md`
- `README.md`
- `docs/reporting-metrics.md`
- `docs/stage-8.5-pr-acceptance.md`
- `docs/deployment-aliyun.md`
- `docs/aliyun-db-only.md`
- `docs/residual-market-user-guide.md`
- `docs/capital-structure-revenue-rights-user-guide.md`
- Git 提交标题中可见的 Stage 5.5 到 Stage 8.6A 阶段记录

## 2. 总体闭环判断

**Stage 9 闭环判断：Partial，部分闭环。**

Stage 9 目前还不能判断为生产部署端到端闭环。文档已经定义了发布准备目标、质量门禁命令、seed 策略、基础部署入口和多条业务验收路径；Stage 8.5 也有明确的人工验收通过记录和质量门禁通过记录。

但 Stage 9 自身仍缺少生产发布所需的关键操作闭环证据：

- 缺少实际 CI pipeline 配置和当前 CI 通过记录；
- 缺少完整 Web/API 生产部署 runbook；
- 缺少生产环境变量清单和校验规则；
- 缺少最终 migration 历史、生产迁移步骤和发布前迁移确认；
- 缺少生产权限矩阵导出和复核记录；
- 缺少备份、恢复和回滚操作手册；
- 缺少统一的全系统人工验收清单；
- 缺少生产 smoke check 和可观测性 hook 说明。

因此，当前状态应定义为：**业务能力较完整，发布准备已启动，但 Stage 9 尚未达到可安全生产上线的闭环状态。**

## 3. Stage 9 内容复核

### 3.1 业务目标

`CODEX_TASKS.md` 中 Stage 9 的目标是：

```text
Make the system stable enough for deployment, rollback, regression testing, and manual acceptance.
```

中文审计解释：

- 从功能建设阶段进入可发布阶段；
- 新环境应可根据文档完成初始化；
- CI 应能捕获回归；
- 备份、恢复、回滚、权限初始化和人工验收应被明确记录；
- 发布准备应以可重复、可验证、可回退为核心标准。

### 3.2 范围

Stage 9 范围包括：

- CI 质量门禁；
- 测试覆盖；
- seed 策略；
- 环境变量模板；
- 部署文档；
- 数据备份和恢复计划；
- 权限初始化；
- 人工验收清单。

### 3.3 禁止事项

Stage 9 明确禁止：

- migration 未清理或存在 pending migration 时部署；
- 存在未文档化环境变量时部署；
- 依赖本地 seed 状态作为生产角色初始化依据；
- 将工作流验收记录重新放回默认 seed。

### 3.4 后端 API 端点

Stage 9 本身只概括提到：

- health checks；
- smoke paths；
- deployment observability hooks as needed。

README 中明确存在健康检查入口：

- `GET /api/health`

基于前序阶段文档，Stage 9 建议纳入 smoke check 的业务 API 包括：

- `POST /api/self-service-applications`
- `GET /api/applications/:id/available-subscription-plans`
- `POST /api/applications/:id/quotes`
- `POST /api/quotes/:id/confirm`
- `POST /api/quotes/:id/cancel`
- `POST /api/orders/from-quote/:quoteId`
- `POST /api/orders/:id/cancel`
- `POST /api/orders/:id/generate-contract`
- 合同签署、归档、取消端点
- 交付和退车端点
- 账单、收款核销、保证金、催收、权益端点
- `/api/reports/*`
- `/api/reports/details/*`
- `/api/reports/asset-profitability/*`
- residual market、curve、forecast、model run、valuation review 相关端点
- 车辆销售价、状态、历史、可用车池、估值复核相关端点

以上 API 均属于 **requires Codex verification**。

### 3.5 前端页面和人工验收路径

Stage 9 要求 README 文档化人工验收路径。当前文档中已有分散验收路径：

- 登录和系统管理：
  - 使用 `admin / Admin@123456` 登录；
  - 验证用户、角色、权限、菜单和审计日志。
- B 线销售辅助主链路：
  - `/customers`
  - `/applications`
  - `/applications/:id`
  - `/vehicles`
  - `/quotes`
  - `/quotes/:id`
  - `/orders`
  - `/orders/[id]`
  - `/contracts`
  - `/contracts/[id]`
  - `/contract-versions`
- A/B 双线进件：
  - 新主线入口是 `/applications` 和 `/applications/:id`；
  - `/orders/review` 仅为 legacy 入口，不是 Stage 5.5 后的新主线。
- 交付、退车、账务运营：
  - Delivery center；
  - Return management；
  - Billing center；
  - Deposit pool；
  - Collection center；
  - Benefits center。
- 报表和资产经营分析：
  - `/reports`
  - `/reports/asset-profitability`
- 残值与估值：
  - `/residual-market`
  - 车辆详情残值预测区块；
  - `/vehicle-valuation-reviews`

主要缺口：这些路径尚未汇总为一份 Stage 9 发布验收清单，也缺少每一步期望数据、期望状态流转和验收证据记录。

### 3.6 Seed 策略

当前文档已定义较清晰的 seed 策略：

- 默认 `pnpm prisma:seed` 只初始化基础主数据；
- seed 内容包括权限、角色、菜单、测试用户、干净客户 leads、产品/套餐、押金规则、车辆资产池和车辆销售价初始化记录；
- 默认 seed 不再创建测试进件、报价、订单、合同、账单、收款、交付、退车、催收或权益履约数据；
- seed 后车辆资产应处于：
  - `AVAILABLE`
  - `currentSalePriceAmount > 0`
  - `salePriceStatus = EFFECTIVE`
  - 保险日期有效
  - 有 `INITIAL_POOL` 销售价历史
- 复杂验收数据应拆分为独立场景 seed：
  - `pnpm seed:scenario delivery`
  - `pnpm seed:scenario return`
  - `pnpm seed:scenario billing`
  - `pnpm seed:scenario collection`
  - `pnpm seed:scenario entitlement`
- 如果 seed 更新权限或菜单，用户必须退出并重新登录，以刷新 JWT/access token 中的权限。

需要 Codex 验证：

- 场景 seed 命令是否真实存在；
- 场景 seed 是否幂等；
- 是否使用专用测试车辆；
- 是否不会污染默认车辆池；
- 是否会输出生成的进件、订单和车辆编号。

### 3.7 环境变量指引

当前文档已有基础环境变量说明：

- `Copy-Item .env.example .env`
- `DATABASE_URL`
- `REDIS_URL`
- `SEED_ADMIN_PASSWORD`
- `POSTGRES_PASSWORD`
- `REDIS_PASSWORD`

`docs/aliyun-db-only.md` 还说明：

- 使用 SSH tunnel 将远端 PostgreSQL 映射到本地 `127.0.0.1:5432`；
- Redis 可映射到 `127.0.0.1:6379`；
- 密码中如含特殊字符，需要在 URL 中做 percent-encoding；
- 不应开放 PostgreSQL/Redis 公网端口。

主要缺口：

- 缺少完整生产环境变量矩阵；
- 缺少 required/optional 分类；
- 缺少生产、预发、本地差异；
- 缺少 secret owner 和轮换策略；
- 缺少环境变量校验命令；
- 缺少部署前环境变量检查清单。

### 3.8 部署说明

当前部署文档覆盖：

- 目标平台：Alibaba Cloud ECS；
- Node.js 20 LTS or newer；
- Corepack 管理 pnpm；
- Docker Compose 运行 PostgreSQL/Redis；
- Nginx 或其他反向代理；
- 默认端口：
  - Web `3000`
  - API `3001`
  - PostgreSQL `5432`
  - Redis `6379`
- First boot：
  - Corepack；
  - pnpm install；
  - docker compose up；
  - copy env；
  - migration；
  - seed；
  - validate；
  - dev server。

主要缺口：

- 当前文档更偏早期开发/数据库验证，不是完整生产部署；
- `docs/aliyun-db-only.md` 是“服务器只跑数据库，本地跑应用”的早期方案；
- 缺少 Web/API 生产构建步骤；
- 缺少 systemd/PM2 进程管理配置；
- 缺少 Nginx/TLS/domain 详细配置；
- 缺少发布版本、tag、artifact、回滚流程；
- 缺少发布后 smoke check；
- 缺少日志、错误和健康检查的可观测性说明。

### 3.9 质量门禁和测试覆盖

当前主质量门禁命令：

```powershell
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Stage 8.5 验收文档记录已通过：

```text
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm prisma:seed
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma

31 files / 524 tests passed
Database schema is up to date
```

文档冲突：

- `DEV_SPEC.md` 仍保留 `prisma migrate status` 失败的旧风险；
- Stage 8.5 验收文档记录 migration status 已通过。

结论：Stage 9 必须重新执行并记录当前质量门禁结果，不能仅依赖历史文档。

## 4. Stage 9 主线能力表

| Stage | 业务域 | 当前完成度 | Must-Have | 端到端闭环 | 主要缺口 | 建议优先级 |
| --- | --- | --- | --- | --- | --- | --- |
| 9 | CI 质量门禁 | 命令已文档化，Stage 8.5 有手工通过记录 | CI 自动运行 lint、Prisma validate/generate、API/Web typecheck、API tests、migration status、smoke | Partial | 未见 CI 配置和当前 CI 结果 | P0 |
| 9 | 回归与 smoke | 可从 Stage 5.5-8.6A 推导 smoke 路径 | 登录、health、A/B 进件、报价、订单、合同、交付、账务、报表、残值估值 smoke | Partial | 无统一 smoke suite 或通过证据 | P0 |
| 9 | Seed 策略 | baseline seed hygiene 文档较完整 | 默认 seed 幂等、生产角色可初始化、场景 seed 隔离 | Partial | 场景 seed 存在性和幂等性需验证 | P0 |
| 9 | 环境变量 | README 和 Aliyun DB-only 文档覆盖基础变量 | 完整生产/预发环境变量矩阵和校验流程 | Partial | 无完整 env inventory、secret 策略 | P0 |
| 9 | 部署文档 | 有 ECS/DB-only 起步文档 | 生产 Web/API 构建、进程管理、反向代理、TLS、发布步骤 | Not closed | 当前偏开发/早期验证，不是生产 runbook | P0 |
| 9 | migration 发布流程 | 命令已记录，但文档证据冲突 | 最终 migration 历史、无 pending、生产迁移步骤、迁移前备份 | Partial | 当前状态需 Codex 验证 | P0 |
| 9 | 备份恢复 | Stage 9 范围已列出 | 备份计划、恢复演练、保留周期、负责人 | Not closed | 未见具体 runbook | P0 |
| 9 | 回滚 | Stage 9 目标列出 | 应用回滚、migration 处理策略、seed 回滚、回滚后 smoke | Not closed | 未见具体 runbook | P0 |
| 9 | 权限初始化 | seed/JWT refresh 文档存在，Stage 8.6B 有残值权限矩阵 | 生产权限矩阵导出并复核 | Partial | 缺少跨域生产权限总表和验收证据 | P1 |
| 9 | 人工验收 | 多份文档有验收路径 | 单份 launch checklist，包含数据准备、状态期望和证据记录 | Partial | 路径分散，缺少发布签收清单 | P1 |
| 9 | 可观测性 | `/api/health` 已文档化，Stage 9 提到 hooks | health、日志、部署事件、错误可见、smoke hooks | Partial | 无可观测性清单 | P1 |
| 9 | 文档一致性 | 核心文档存在 | DEV_SPEC/README/CODEX_TASKS 对当前状态一致 | Partial | 部分 Stage 5/旧 migration 风险仍未更新 | P1 |

## 5. 已闭环或接近闭环的能力

以下能力在文档级别可认为已闭环或接近闭环，生产前仍需 Codex 代码级验证：

1. B 线销售辅助报价、订单、合同基线：
   - 客户、进件、风控、产品、车辆、报价、订单、合同链路已文档化；
   - 报价确认锁车 `AVAILABLE -> RESERVED`；
   - README 和 DEV_SPEC 记录订单/合同基线存在。

2. A/B 双线进件目标主线：
   - A 线是 `SELF_SERVICE Application`，不是直建正式订单；
   - B 线是 `SALES_ASSISTED Application`；
   - 两线在 Application 审核阶段合并；
   - `/orders/review` 和 `POST /api/customer-orders` 被标记为 legacy 兼容对象。

3. baseline seed hygiene：
   - 默认 seed 限定为基础主数据；
   - 默认 seed 不生成流程验收数据；
   - 场景 seed 隔离方向明确。

4. Stage 7.6 经营报表和 CSV 第一版：
   - `/reports` 页面、查看 API、CSV 导出 API 已文档化；
   - 经营总览、订单、财务、保证金、催收、车辆资产等口径明确；
   - 下钻明细和明细导出规则明确。

5. Stage 8 资产经营分析和收益试算：
   - 资产经营分析 API 和导出已文档化；
   - ROA/ROE 明确为经营分析试算，不是正式会计报表；
   - `purchasePriceAmount` 与 `currentSalePriceAmount` 的边界清楚。

6. Stage 8 资本结构和收益权 preview：
   - 融资工具、车辆分摊、资本事件、收益权、分润规则和 preview 口径已文档化；
   - 明确不做真实结算、会计凭证和正式财务入账。

7. Stage 8 残值市场链路：
   - 市场样本、残值曲线、单车预测、模型运行记录、残值敏感性分析均已形成文档链路；
   - 明确不自动修改车辆当前销售价。

8. Stage 8.5 残值预测到车辆估值复核：
   - Stage 8.5 PR 验收文档显示人工验收通过；
   - 质量门禁通过，记录 524 个 API tests passed；
   - 估值复核审核通过是残值链路中唯一能更新 `Vehicle.currentSalePriceAmount` 并写 `VehicleSalePriceHistory` 的动作。

## 6. 部分闭环或未闭环能力

1. Stage 9 CI/CD：
   - 未在审计文档中看到 CI workflow 或最新 CI 运行证据。

2. 完整生产部署：
   - 当前部署文档适合早期 ECS/DB/local dev，但不是完整生产 Web/API 部署手册。

3. 备份、恢复、回滚：
   - Stage 9 作为目标列出，但未形成可执行手册。

4. 生产环境变量：
   - 有 `.env` 基础说明，但缺少完整生产矩阵。

5. 生产权限初始化：
   - 有 seed 和 JWT refresh 指引，但没有生产权限导出和复核记录。

6. 全系统发布验收：
   - 验收路径分散在 README、Stage 8.5、Stage 8.6A 和用户说明中；
   - 缺少统一发布签收清单。

7. 当前 migration 状态：
   - 文档中存在旧风险和新验收记录冲突，需要重新验证。

8. Stage 8.6A 实际执行闭环：
   - `reporting-metrics.md` 定义了 Stage 8.6A 回归范围和结论口径；
   - 但文档未证明完整 8.6A 手工回归已经逐项执行。

9. 正式会计 ROA/ROE 和真实财务结算：
   - 当前明确不做正式会计报表、凭证、真实融资还款和分润付款；
   - 如果首发定位为内部经营试算，这不是上线阻塞；如果要求财务级生产报表，则未闭环。

10. 交付、退车、账务场景 seed：
   - 文档提出命令方向；
   - 实际存在性和隔离性需要验证。

## 7. 可延期增强项

以下内容可延期，不应阻塞 Stage 9 发布准备，除非业务方明确要求首发必须包含：

- Stage 8.5C：估值复核统计报表、批量拒绝、批量取消、批量通过 preview；
- 真实 AI/ML 残值预测、模型训练、Python pipeline、第三方模型服务；
- 爬虫、定时外部采集、第三方车辆平台 API；
- Excel `.xlsx` 导出，当前 CSV 可作为第一版；
- 正式会计 ROA/ROE、会计凭证、日均权益资本、真实融资还款计划；
- 真实分润结算和付款；
- 客户侧 A 线 App/小程序；
- 独立 `VehicleStatusLog` 表，如果现有审计/status 日志可满足第一版；
- 高级可观测性平台集成。

## 8. 候选下一阶段方向

### 方向 A：Stage 9B 生产发布准备硬化

重点：

- CI workflow；
- 环境变量矩阵；
- 生产部署 runbook；
- migration 发布清单；
- 备份/恢复/回滚手册；
- 生产权限导出；
- smoke tests；
- 发布验收清单。

理由：

- 直接补齐 Stage 9 未闭环项，是生产上线前最短路径。

### 方向 B：Stage 9C 端到端验收与场景 seed

重点：

- 实现或验证场景 seed；
- 建立 A/B 进件、订单、合同、交付、账务、退车、报表、残值估值的统一验收链路；
- 固化验收证据。

理由：

- 将分散路径转化为可重复发布验收。

### 方向 C：Stage 8.6C/9 数据一致性与审计验证

重点：

- 验证残值预测、估值复核、报表和 CSV 导出的写入边界；
- 验证关键动作审计日志；
- 确认 GET 和 export 无写入副作用。

理由：

- 降低车辆估值和财务报表相关的高影响生产风险。

### 方向 D：Stage 8.5C 估值复核运营增强

重点：

- 估值复核统计；
- 批量拒绝/取消；
- 批量通过 preview；
- 阈值、低置信度拦截和批量审计。

理由：

- 提升资产运营效率，但应在 Stage 9B 后进行。

### 方向 E：客户侧 A 线产品化

重点：

- 客户自助 UI；
- 最终方案确认页；
- 通知和签约体验。

理由：

- 面向外部用户扩展，但不是内部 Back Office 首发生产准备的前置条件。

## 9. 推荐下一阶段

**推荐下一阶段：Stage 9B 生产发布准备硬化。**

推荐理由：

- Stage 9 当前只是部分闭环；
- 最大阻塞不是新业务功能，而是发布工程、可回滚性、可验证性和生产运维证据；
- 继续追加 Stage 8 功能会增加发布风险；
- Stage 9B 能为 Stage 5.5 到 Stage 8.6A 的全部业务成果建立可靠 release boundary。

建议 Stage 9B 交付物：

1. CI workflow，并运行现有质量门禁。
2. 生产/预发环境变量矩阵和校验清单。
3. Fresh environment provisioning runbook。
4. 当前 migration status、最终 migration 历史和生产迁移步骤。
5. 备份、恢复和回滚手册。
6. 生产权限矩阵导出和 seed/re-login 指引。
7. smoke test 清单或自动 smoke 脚本。
8. 单份全系统人工验收清单。
9. 从 DB-only/dev bootstrap 升级到完整 Web/API 生产部署文档。

## 10. 需要 Codex 代码级验证的事项

### 10.1 API 验证

- `GET /api/health`
- 登录、鉴权、JWT Cookie 和 token size
- `/api/vehicles/available` 权限与过滤
- 车辆销售价初始化、复核、历史、状态 API
- `POST /api/self-service-applications`
- Application 审核队列和详情动作
- `GET /api/applications/:id/available-subscription-plans`
- `POST /api/applications/:id/quotes`
- `POST /api/quotes/:id/confirm`
- `POST /api/quotes/:id/cancel`
- `POST /api/orders/from-quote/:quoteId`
- 订单取消、合同生成、签署、归档、取消
- 交付和退车端点
- 账单、收款核销、保证金台账、催收、权益 API
- `/api/reports/*`
- `/api/reports/details/*`
- `/api/reports/asset-profitability/*`
- residual market、curve、forecast、model run API
- vehicle valuation review 创建、列表、详情、通过、拒绝、取消 API

### 10.2 权限验证

- `ADMIN` 是否拥有全部生产权限；
- `SA`、`OP`、`AS`、`RC`、`FI`、`GM` 是否按业务职责授权；
- `vehicle:*` 和 `subscription_plan:*` 是否拆分并真实生效；
- `quote:create` 是否能读取 active plans 和 available vehicles；
- `report:view`、`report:finance`、`report:asset`、`collection:view` 是否保护报表和导出；
- residual 权限是否完整生效：
  - `residual_market:view/manage/import`
  - `residual_curve:view/generate/manage`
  - `residual_forecast:view/generate/manage`
  - `residual_model_run:view/manage`
  - `vehicle_valuation_review:view/create/approve`
- 菜单、按钮和后端 guard 是否一致；
- seed 更新权限后是否必须重新登录；
- JWT 是否不再因完整 permissions 数组过大而超过 Cookie 限制。

### 10.3 页面验证

- 登录页
- 系统管理页
- `/customers`
- `/applications`
- `/applications/:id`
- `/vehicles`
- 车辆详情销售价和残值预测区块
- `/quotes`
- `/quotes/:id`
- `/orders`
- `/orders/[id]`
- `/contracts`
- `/contracts/[id]`
- `/contract-versions`
- Delivery center
- Return management
- Billing center
- Deposit pool
- Collection center
- Benefits center
- `/reports`
- `/reports/asset-profitability`
- `/residual-market`
- `/vehicle-valuation-reviews`

### 10.4 Migration 与 seed 验证

- 当前 `prisma migrate status`；
- 是否无 pending/untracked production migrations；
- 最终 migration 历史是否匹配目标数据库；
- 生产 migration 流程是否已文档化并测试；
- baseline seed 是否幂等；
- scenario seed 是否存在且隔离；
- seed 车辆是否保持 `AVAILABLE` 和 `EFFECTIVE`；
- seed 是否不会创建流程验收记录；
- 生产权限和菜单 seed 是否不依赖本地状态。

### 10.5 CI/CD 与运维验证

- CI workflow 是否存在；
- CI 是否在 PR/main 运行；
- CI 是否执行 lint、Prisma validate/generate、API/Web typecheck、API tests、migration status 和 smoke；
- 生产 build 命令是否可用；
- fresh environment 是否可按 runbook 初始化；
- 环境变量清单是否完整；
- 备份和恢复是否演练通过；
- 回滚方案是否可执行；
- `/api/health` 和关键 smoke path 是否部署后可观测；
- 部署日志和失败信号是否可被运营/开发看到。

## 11. 最终审计结论

Stage 9 不应立即标记为 Closed。当前更准确的状态是：

```text
Stage 9 = Partial
```

进入 Closed 前，至少需要完成 Stage 9B：

- CI/CD 闭环；
- 生产部署 runbook；
- 环境变量矩阵；
- migration 发布流程；
- 生产权限矩阵；
- 备份、恢复、回滚；
- smoke check；
- 全系统人工验收清单。

前序业务阶段已经积累了相当完整的业务能力，尤其是 Stage 8 残值预测、估值复核和资产报表方向。但 Stage 9 是发布工程和运营可靠性阶段，判断标准应从“功能是否存在”切换为“是否可重复部署、可验证、可回退、可审计”。
