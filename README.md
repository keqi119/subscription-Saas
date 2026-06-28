# 纯电汽车订阅运营中台

上海二手纯电车辆订阅运营 Back Office。首期面向内部运营团队，优先跑通
客户、进件、风控、产品套餐、报价、订单、合同、车辆资产池和后续账务/资产报表闭环。

当前项目路径：

```text
D:\Projects\auto-subscription-platform
```

## 当前阶段

当前本地分支是 `feature/ab-order-review-flow`。代码已完成阶段 5 基线并进入阶段 5
优化后的接管校准：

- 已有登录、JWT Cookie、RBAC、菜单权限、用户/角色/权限管理、审计日志。
- 已有客户中心、进件管理、资料上传、进件审核、风控审批、A/B/C 押金规则。
- 已有产品、产品版本、旧版 `ProductPriceRule`、产品组件包和 `SubscriptionPlan`。
- 已有订阅报价、订单、合同模板、合同管理、订单变更基础能力。
- 已新增车辆资产池、车辆当前销售价初始化、季度 review、销售价历史、可用车辆接口。
- 已重新校准 A/B 双线主线：A 线客户自助进件，B 线销售人工进件，两线合并到进件审核后再生成正式订单。
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
- `docs/reporting-metrics.md`：报表口径文档
- `docs/aliyun-db-only.md`：阿里云方案 A，服务器只跑 PostgreSQL/Redis，本地跑应用

Stage 9 / Production readiness：

- `docs/deployment.md`：部署步骤、migration、seed、smoke 和回滚原则
- `docs/backup-restore.md`：PostgreSQL 备份、恢复和恢复后校验
- `docs/permission-matrix.md`：角色、权限域、菜单和 seed/re-login 说明
- `docs/manual-acceptance.md`：全系统人工验收总清单
- `docs/scenario-seeds.md`：Stage 9C 场景 seed、cleanup、JSON 输出和 smoke 配合说明
- `docs/release-checklist.md`：Stage 9D 发布前、中、后检查与回滚清单
- `docs/mainline-acceptance-freeze.md`：Stage 9D 主线验收冻结范围和发布阻断项
- `docs/release-candidate-report.md`：Stage 9E Release Candidate 验收报告
- `docs/release-notes-rc.md`：Stage 9 Release Notes 草稿
- `docs/stage-9-launch-readiness-audit.zh-CN.md`：Stage 9A 中文审计报告
- `docs/stage-9-launch-readiness-audit.md`：Stage 9A 英文审计报告
- `docs/stage-10-customer-portal-audit.md`：Stage 10.0 客户门户 / A 线线上旅程接管审计
- `docs/stage-10a-customer-account-portal.md`：Stage 10A 客户账号与门户基础
- `docs/stage-10b-portal-catalog-application.md`：Stage 10B 商品浏览与自助申请
- `docs/stage-10c-portal-application-progress-final-plan.md`：Stage 10C 申请进度与最终方案确认
- `docs/stage-10d-esign-foundation.md`：Stage 10D-A 电子签约基础与 Mock 签署闭环
- `docs/stage-10d-fadada-api-audit.md`: Stage 10D-B0 Fadada API audit and integration matrix
- `docs/stage-10d-fadada-provider-skeleton.md`: Stage 10D-B1 Fadada provider skeleton
- `docs/stage-10d-fadada-upload-sign-url-prep.md`: Stage 10D-B2-A Fadada upload and sign URL prep
- `docs/stage-10d-fadada-sandbox-preflight-smoke.md`: Stage 10D-B2-B Fadada sandbox preflight and optional smoke gate
- `docs/stage-10d-fadada-sandbox-upload-signurl-smoke.md`: Stage 10D-B2-B-R1 Fadada sandbox upload/signUrl smoke
- `docs/stage-10d-fadada-production-upload-signurl-smoke.md`: Stage 10D-B2-C-R1 Fadada production-host upload/signUrl controlled smoke
- `docs/stage-10d-fadada-full-signing-validation-plan.md`: Stage 10D-B5-A/B5-A-R1 Fadada full signing validation plan and signer customer_id resolver gate
- `docs/stage-10d-fadada-full-signing-validation-result.md`: Stage 10D-B5-B Fadada controlled full signing execution result / ENV-A blocker / H1 hardening / ENV-B readiness / pending-sign sample blocker log
- `docs/stage-10d-fadada-production-migration-preflight.md`: Stage 10D-B5-B-MIGRATION-PREFLIGHT production pending migration impact review and isolated clone rehearsal
- `docs/stage-10d-fadada-production-migration-apply.md`: Stage 10D-B5-B-MIGRATION-APPLY production no-seed migrate deploy result and ENV-B follow-up
- `docs/stage-10d-c1-fadada-test-signer-realname-prep.md`: Stage 10D-C1 Fadada production-host test signer real-name prep
- `docs/stage-10d-c1-fadada-test-signer-realname-smoke.md`: Stage 10D-C1-B Fadada production-host test signer preflight/prepare smoke result
- `docs/stage-10d-fadada-callback-idempotency.md`: Stage 10D-B3 Fadada callback verification and idempotency
- `docs/stage-10d-fadada-signed-pdf-archive.md`: Stage 10D-B4 Fadada signed PDF archive preparation
- `docs/stage-10d-fadada-artifact-archive-mock-smoke.md`: Stage 10D-B4-B Fadada artifact archive mock smoke
- `docs/stage-10e-payment-foundation.md`：Stage 10E-A 支付基础与 Mock 支付闭环
- `docs/stage-10e-wechat-jsapi-payment.md`：Stage 10E-B 微信支付 JSAPI Provider
- `docs/stage-10f-portal-billing-entitlements.md`：Stage 10F 客户账单 / 押金 / 权益中心
- `docs/stage-10g-service-case-portal.md`：Stage 10G-A 服务工单 / 事故报案 / 救援申请
- `docs/stage-10h-notification-wechat-foundation.md`：Stage 10H-A 通知中心与微信服务号基础
- `docs/stage-10h-wechat-official-account-validation.md`：Stage 10H-B 微信服务号真实联调报告
- `docs/stage-10k-portal-production-login-beta-gate.md`：Stage 10K-A 阿里云短信验证码 Provider 与受邀试运行门禁
- `docs/stage-10k-b-r4a-controlled-beta-business-sample-review.md`: Stage 10K-B-R4A/R4B/R4C Controlled Beta 业务样本复核、P1 验证缺口收口与订单车辆材料 ownership 补验
- `docs/portal-security-audit.md`：Customer Portal 数据隔离与脱敏审计
- `docs/customer-portal-release-checklist.md`：Customer Portal 发布前检查清单
- `docs/customer-portal-manual-acceptance.md`：Customer Portal 全链路人工验收手册
- `docs/customer-portal-release-candidate-report.md`: Stage 10J Customer Portal RC report
- `docs/customer-portal-production-rollout-plan.md`: Stage 10J Customer Portal production rollout plan
- `docs/wechat-official-account-setup.md`：微信服务号菜单与域名配置建议

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

默认 `pnpm prisma:seed` 只初始化基础主数据：权限、角色、菜单、测试用户、客户
leads、产品/套餐、押金规则、车辆资产池和车辆销售价初始化记录。默认 seed 不再
创建测试进件、报价、订单、合同、账单、收款、交付、退车、催收或权益履约数据；
seed 后车辆资产应处于 `AVAILABLE` 且销售价状态为 `EFFECTIVE`。

车型代码主数据 seed 会初始化 `ET5 / ET5T / ET7 / EC6 / ES6 / ES8 / ET9 / ES9` 的 legacy enum 映射；如权限或菜单发生变化，后台用户需要重新登录刷新 token。

复杂验收数据必须通过显式场景脚本创建，例如：

```powershell
pnpm seed:scenario mainline
pnpm seed:scenario residual
pnpm seed:scenario all
pnpm seed:scenario cleanup
```

场景 seed 必须使用专用测试车辆，执行前清理同场景旧数据，并输出 `.tmp/scenarios/*.json`，避免污染默认车辆池。

API smoke：

```powershell
pnpm smoke:api
pnpm smoke:mainline
pnpm smoke:residual
```

发布前本地门禁：

```powershell
pnpm release:check
```

可选执行 scenario seed 和 smoke 的完整本地 release gate：

```powershell
$env:RUN_RELEASE_SCENARIOS="1"; $env:RUN_RELEASE_SMOKE="1"; pnpm release:check
```

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

## Production Deployment

- `docs/production-deployment-runbook.md`: Stage 9F-A production deployment dry-run runbook
- `docs/production-deployment-runbook.zh-CN.md`: Stage 9F-A 中文生产部署演练 Runbook
- `docs/staging-deployment-runbook.md`: Stage 9F-B staging server deployment dry-run runbook
- `docs/staging-dry-run-report.md`: Stage 9F-B staging dry-run evidence template
- `docs/object-storage-readiness.md`: Stage 9G OSS adapter status and real bucket validation gate
- `docs/image-registry-deployment.md`: Stage 9F-C2 image build / registry deployment path
- `docs/production-cutover-plan.md`: Stage 9F-D production cutover plan and approval inputs
- `docs/production-cutover-approval.md`: Stage 9F-E production Go / No-Go approval gate
- `docs/production-go-no-go-record.md`: final production Go / No-Go decision record
- `docs/production-cutover-execution-report.md`: Stage 9F-F production cutover execution / blocker report
- `docs/production-image-rebuild-report.md`: Stage 9F-F0 production image rebuild evidence
- `docker-compose.staging.images.example.yml`: staging compose for prebuilt API/Web images
- `docker-compose.production.images.example.yml`: production compose for prebuilt API/Web images
- `.env.staging.images.example`: staging env template for registry pull deployment
- `.env.production.images.example`: production env template for registry pull deployment
- `nginx/staging-subauto.example.conf`: BT / Nginx staging reverse proxy example
- `nginx/production-subauto.example.conf`: BT / Nginx production reverse proxy example
- `docs/domain-dns-ssl.md`: `keybox.cloud` DNS, HTTPS, CORS, and cookie guidance
- `docs/production-cutover-checklist.md`: Stage 9F-B production cutover checklist
- `docs/backup-restore.md`: PostgreSQL backup and restore guidance
- `docs/release-checklist.md`: release quality gate and rollback checklist
- `docs/release-candidate-report.md`: Stage 9E RC validation evidence

Dry-run and pre-cutover commands:

```powershell
pnpm release:check
pnpm smoke:api
pnpm smoke:upload
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

当前已实现基线主要对应 B 线销售人工进件、报价后生成订单：

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

## A/B 双线进件目标主线

当前校准后的主线是：

```text
A 线 = SELF_SERVICE Application，客户自助进件
B 线 = SALES_ASSISTED Application，销售人工进件
两线从客户资料审核开始合并
正式 SubscriptionOrder 只在资料、授信、押金、产品套餐、车辆库存、最终方案均确认后生成
```

A 线客户提交时只保存意向选择：

```text
intentVehicleId
intentSubscriptionPlanId
intentPeriodMonths
intentVehicleBaseFeeAmount
intentSnapshot / customerSelectedSnapshot
depositStatus = PENDING_CONFIRM
finalDepositAmount = null
```

B 线继续沿用现有后台进件、风控、报价、订单、合同流程。

后续迁移顺序：

```text
R2: POST /api/self-service-applications
R3: Application 审核 API
R4: 进件列表 / 进件详情审核页面
R5: 废弃或兼容封装 POST /api/customer-orders 和 /orders/review
R6: seed、测试、质量门禁、PR 整理
```

现有 `POST /api/customer-orders`、`CUSTOMER_SELF_SERVICE` 直建订单和
`/orders/review` 属于 Stage 5.5 旧方向遗留能力，本阶段保留但标记为后续迁移对象。

## Stage 5.5 人工验收路径

A 线当前没有客户 App / 小程序前端。默认 `pnpm prisma:seed` 只提供干净基础
主数据和可用车辆池；人工验收应从后台手动创建客户/进件开始，或后续使用独立
场景 seed 创建专用流程数据。

```text
1. pnpm prisma:seed
2. 如 seed 修改过权限，退出并重新登录 admin
3. 打开 /vehicles，确认 seed 车辆均为 AVAILABLE
4. 打开 /customers，选择或创建一个 lead
5. 在 /applications 创建自助或销售人工进件
6. 进入 /applications/:id 详情
7. 查看意向车辆、意向套餐、押金待确认和客户资料区域
8. 依次完成资料审核、客户资质审核、产品匹配审核、车辆库存审核
9. 点击确认最终方案
10. 点击生成正式订单
11. 确认进件显示订单编号并可跳转订单详情
12. 确认车辆从 REVIEW_RESERVED 进入 RESERVED
13. 确认 B线销售人工进件和报价流程仍可用
```

新 A/B 双线主线审核入口是 `/applications` 和 `/applications/:id`，不是 legacy
`/orders/review`。

## Legacy A/B Direct-Order Notes

后续订单主线需要同时支持两条路径，并最终汇入订单、合同、付款、交付、
起租流程。

A 线：客户自动下单。

```text
客户看车
  -> 选择具体车辆
  -> 选择预设订阅套餐
  -> 提交订单申请
  -> 系统生成意向订单和报价快照
  -> 后台审核客户资质、产品匹配、车辆库存
  -> 押金根据审核结果最终确认
  -> 客户确认最终方案
  -> 合同签约
```

A 线原则：

```text
先下单，后审核
客户选择的是意向方案，不是最终签约方案
客户前端只选择预设套餐，不开放组件自由组合
押金金额审核后确认
```

客户前端提示文案：

```text
您当前选择的是意向订阅方案。押金金额将根据您的资质审核结果、信用等级及平台风控规则最终确认。审核通过后，平台将向您展示最终签约方案，您确认后再进入合同签署流程。
```

客户提交按钮建议使用：

```text
提交审核
```

B 线：销售手动下单。

```text
客户建档 / 进件
  -> 风控审核
  -> 客户评级
  -> 销售选择车辆和套餐
  -> 生成报价 / 订单
  -> 合同签约
```

B 线原则：

```text
先审核，后下单
沿用现有后台进件、报价、订单流程
```

数据模型方向：

```text
保留 SubscriptionQuote
不新增 SubscriptionOrderApplication 第一版
优先扩展 SubscriptionOrder
新增 orderSource
新增 creditReviewStatus / productReviewStatus / vehicleReviewStatus
新增 depositStatus / finalDepositAmount
新增 customerSelectedSnapshot
可选新增 REVIEW_RESERVED 车辆状态
```

A 线押金规则：

```text
客户下单时押金待确认
审核后根据客户等级 A/B/C、押金规则、风控结果生成 finalDepositAmount
如果最终押金或方案发生变化，应进入 PENDING_CUSTOMER_CONFIRMATION
```

车辆状态联动目标：

```text
A 线客户提交订单：AVAILABLE -> REVIEW_RESERVED
A 线审核失败 / 客户取消：REVIEW_RESERVED -> AVAILABLE
A 线审核通过进入签约：REVIEW_RESERVED -> RESERVED
B 线销售下单：AVAILABLE -> RESERVED
合同签署 / 支付 / 交付后续：RESERVED -> LEASED
```

如果第一版不立即实现 `REVIEW_RESERVED`，可以临时复用 `RESERVED`，但目标模型
保留 `REVIEW_RESERVED`，后续应补齐库存审核占用与签约锁定的状态区分。

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
- 按 R2-R6 落地 A/B 双线进件主线、Application 审核 API、后台审核页和车辆状态联动。
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

## Additional Docs

- `docs/wechat-pay-certificate-rotation.md`: WeChat Pay platform certificate rotation runbook.
- `docs/stage-10l-vehicle-listing-product-page.md`: Stage 10L-A vehicle listing profile, gallery, display-plan, and Portal product-page foundation.
- `docs/stage-10l-b-vehicle-condition-report.md`: Stage 10L-B vehicle condition report, report items, battery inspection, and Portal report page foundation.
- `docs/stage-10m-a-portal-material-precheck.md`: Stage 10M-A customer profile material center and application material precheck flow.
- `docs/stage-10m-b-vehicle-insurance-documents-claims.md`: Stage 10M-B vehicle insurance policy, vehicle document, customer-visible order document, and basic claim foundation.
- `docs/stage-10m-c-baas-contract-costs.md`: Stage 10M-C-A BaaS battery contract, attachment, and monthly cost ledger foundation.
- `docs/stage-10m-c-baas-cost-return-analytics.md`: Stage 10M-C-B historical BaaS cost visibility step before the main formula switch.
- `docs/stage-10m-c-baas-cost-main-return-metrics.md`: Stage 10M-C-C BaaS cost inclusion in main asset profitability metrics and CSV exports.
- `docs/stage-10n-c-vehicle-depreciation-foundation.md`: Stage 10N-C-A vehicle depreciation policy, schedule, and record foundation. This stage does not connect depreciation to main ROE yet.
- `docs/stage-10n-c-depreciation-main-return-metrics.md`: Stage 10N-C-B depreciation record inclusion in main asset return metrics with legacy cost-profile fallback.
- `docs/stage-10n-c-market-calibrated-depreciation.md`: Stage 10N-C-C market calibrated depreciation and residual calibration comparison. This is an analysis-only口径 and does not override accounting depreciation main ROE.
- `docs/stage-10x-vehicle-model-enum-drift-closure.md`: Stage 10X-A VehicleModel enum drift closure for ET5T, EC6, ES8, ET9, and ES9 before model-code master-data migration.
- `docs/stage-10x-vehicle-model-master-data-audit.md`: Stage 10X-B vehicle model master-data impact audit and double-track migration plan.
- `docs/stage-10x-vehicle-model-master-data.md`: Stage 10X-C VehicleModelDefinition master data model, CRUD API, seed, permission, menu, and back-office maintenance page.
- `docs/stage-10x-vehicle-master-data-integration.md`: Stage 10X-D vehicle management integration with VehicleModelDefinition while retaining legacy VehicleModel fallback.
- `docs/stage-10x-model-master-data-portal-product-reports.md`: Stage 10X-E Product, Portal catalog, and Reports integration with VehicleModelDefinition while leaving Residual market for Stage 10X-F.
- `docs/stage-10x-model-master-data-residual-market.md`: Stage 10X-F Residual market, residual curve, forecast, model run, and valuation review integration with VehicleModelDefinition while retaining legacy residual dimensions.
- `docs/stage-10x-vehicle-model-enum-retirement-audit.md`: Stage 10X-G VehicleModel enum retirement audit, freeze recommendation, backfill design, and staged modelDefinitionId-required roadmap.
- `docs/stage-10x-vehicle-model-required-on-create.md`: Stage 10X-H vehicle create/update enforcement so new vehicles must resolve VehicleModelDefinition while preserving legacy VehicleModel fallback.
- `docs/stage-10x-product-model-definition-required.md`: Stage 10X-I Product, VehiclePackage, and ProductPriceRule create/update enforcement so new product rules resolve VehicleModelDefinition while preserving legacy VehicleModel fallback.
- `docs/stage-10x-residual-model-definition-required.md`: Stage 10X-J Residual sample import, curve generation, and target-specific model-run enforcement so new residual data resolves VehicleModelDefinition while preserving legacy residual fallback.
- `docs/stage-10x-vehicle-model-enum-freeze-guard.md`: Stage 10X-K VehicleModel enum freeze guard, release/CI check, and rule that new vehicle models must be created through VehicleModelDefinition.
- `docs/stage-10x-model-definition-backfill-dry-run-report.md`: Stage 10X-L modelDefinitionId historical backfill dry-run report covering Vehicle, Product, Quote/Order snapshots, and Residual legacy dimensions.
- `docs/stage-10x-model-definition-low-risk-backfill.md`: Stage 10X-M-A low-risk modelDefinitionId backfill for Vehicle, VehiclePackage, and ProductPriceRule with dry-run, apply guard, and production runbook.
- `docs/stage-10x-quote-order-snapshot.md`: Stage 10X-M-C additive Quote / Order model snapshot fields for immutable audit display without rewriting historical rows.
- `docs/stage-10x-quote-order-snapshot-backfill.md`: Stage 10X-M-D additive Quote / Order snapshot backfill with dry-run, apply guard, idempotency report, and production runbook.
- `docs/stage-10x-quote-order-snapshot-reporting.md`: Stage 10X-M-E Quote / Order snapshot-mode reporting and display rules, with runtime mode retained for current operational objects.
- `docs/stage-10x-vehicle-model-enum-retirement-final-review.md`: Stage 10X-M-F final VehicleModel enum retirement feasibility review, recommending frozen legacy mode now and string snapshot detachment before any removal.
- `docs/stage-10x-legacy-enum-snapshot-to-string.md`: Stage 10X-N Quote / Order legacy enum snapshot to string model-code snapshot, with guarded dry-run/apply backfill and no enum removal.
- `docs/stage-10x-legacy-enum-dewrite-vehicle-product.md`: Stage 10X-O Vehicle / Product legacy enum dewrite, requiring modelDefinitionId for new Vehicle, VehiclePackage, and ProductPriceRule model writes while deriving legacy vehicleModel for compatibility.
- `docs/stage-10x-legacy-enum-read-only-mode.md`: Stage 10X-P VehicleModel enum read-only legacy mode, keeping compatibility reads while rejecting remaining legacy-only new write paths.
- `docs/stage-10x-vehicle-model-enum-removal-rereview.md`: Stage 10X-Q VehicleModel enum removal re-review, confirming active legacy-only writes are closed while schema, ProductPriceRule uniqueness, snapshots, reports, CSV, API contracts, and freeze guard still block immediate enum removal.
