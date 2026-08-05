# Stage 1B-B 微信授权代扣基础能力实施计划

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:test-driven-development` for every behavior change, `superpowers:verification-before-completion` before claiming completion, and `superpowers:requesting-code-review` before integration.

**Goal:** 在现有周期账单、支付单、收款和核销权威链路上，交付可在 Staging 以 Mock 完整验收、在 Production 默认关闭的授权代扣基础能力。

**Architecture:** 新增独立 `auto-debit` 领域模块，拥有授权、扣款尝试、Mock 渠道和任务调度服务；现有 `billing-automation` Worker 继续租约抢占并把新增任务分派给该模块。成功扣款仍创建现有 `PaymentOrder`，并通过重构后的原子结算入口生成 `PaymentRecord` 和不超过剩余应收的 `PaymentWriteOff`。Portal 和 Admin 只调用领域服务，不直接写授权、扣款或核销表。

**Tech Stack:** NestJS 11、Prisma 7/PostgreSQL、Vitest、Next.js 16/React 19、Ant Design 6、TypeScript 6。

**Approved design:** `docs/superpowers/specs/2026-08-04-stage1b-wechat-auto-debit-foundation-design.zh-CN.md`

---

## 施工约束

- 在隔离 worktree 中实施，不修改主工作区现有未跟踪目录。
- 每个任务执行严格 RED → GREEN → REFACTOR；先运行失败测试并记录预期失败，再写最小实现。
- 每轮开始执行 `git status --short --branch`、`prisma migrate status`、`prisma validate`。
- 金额全部使用分和 `BigInt`，任何 DTO 的 number 只在 API 边界转换。
- 不修改历史迁移，不使用 `migrate reset`。
- Production 不允许 Mock 静默启用；真实微信适配器不在本计划中伪装完成。
- 自动任务、人工重试、人工扣款、授权同步和解约均写审计。
- 任何支付渠道成功交易必须入账一次；核销总额不得超过账单剩余金额。

## Task 1：数据库模型、约束、权限和通知枚举

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260804163000_stage1b_auto_debit_foundation/migration.sql`
- Modify: `apps/api/prisma/seed.mjs`
- Modify: `packages/shared/src/auth.ts`
- Modify: `apps/web/src/constants/labels.ts`
- Create: `apps/api/test/auto-debit-schema.spec.ts`
- Modify: `apps/api/test/notification.spec.ts`

### Step 1：写失败的 schema 契约测试

测试必须从 Prisma DMMF/生成客户端验证可观察契约：

- `PaymentMandate`、`DebitAttempt` 模型存在；
- 授权、扣款、轮次枚举值完整；
- `SubscriptionAutomationJobType` 包含提交扣款、查询扣款、失败通知、授权同步；
- `PaymentChannel` 包含 `WECHAT_AUTO_DEBIT`；
- 通知类型/事件/模板包含代扣失败；
- 共享权限包含 `AUTO_DEBIT_VIEW`、`AUTO_DEBIT_MANAGE`、`AUTO_DEBIT_EXECUTE`。

运行：

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/auto-debit-schema.spec.ts test/notification.spec.ts
```

预期：因模型、枚举和权限不存在而失败。

### Step 2：实现 Prisma 模型和关系

按批准设计新增：

- `PaymentMandateStatus`；
- `DebitAttemptStatus`；
- `DebitRetrySlot`；
- `PaymentMandate`；
- `DebitAttempt`；
- Customer、SubscriptionOrder、ReceivableBill、PaymentOrder 的反向关系；
- 新任务类型、支付渠道和通知枚举。

数据库迁移必须显式加入：

- 开放授权部分唯一索引：同一 `order_id` 只允许一个 `PENDING/ACTIVE/SUSPENDED`；
- `(provider, provider_mandate_id)` 条件唯一索引；
- `requested_amount > 0` 和 `confirmed_amount >= 0` 检查；
- `payment_order_id`、`idempotency_key`、`provider_out_trade_no` 唯一；
- 任务、账单、授权和状态查询所需索引。

### Step 3：更新权限、种子和中文标签

- 为系统管理员和财务相关角色加入新权限；
- 新增代扣失败的站内信、微信服务号和短信模板槽位；
- 短信模板 ID 只使用环境变量占位，不写假模板 ID；
- 更新 Admin/Portal 所需枚举标签。

### Step 4：应用并验证本地迁移

```powershell
pnpm --filter @subscription-saas/api prisma:migrate:deploy
pnpm --filter @subscription-saas/api prisma:validate
pnpm --filter @subscription-saas/api prisma:generate
pnpm --filter @subscription-saas/api exec vitest run test/auto-debit-schema.spec.ts test/notification.spec.ts
```

预期：全部通过，迁移状态为 up to date。

### Step 5：提交

```powershell
git add apps/api/prisma packages/shared/src/auth.ts apps/web/src/constants/labels.ts apps/api/test/auto-debit-schema.spec.ts apps/api/test/notification.spec.ts
git commit -m "feat: add auto debit domain schema"
```

## Task 2：渠道接口、配置保护和 Staging Mock

**Files:**

- Create: `apps/api/src/auto-debit/auto-debit-provider.ts`
- Create: `apps/api/src/auto-debit/auto-debit.config.ts`
- Create: `apps/api/src/auto-debit/mock-auto-debit.provider.ts`
- Create: `apps/api/src/auto-debit/auto-debit.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/.env.production.example`
- Create: `apps/api/test/auto-debit-provider.spec.ts`
- Create: `apps/api/test/auto-debit-config.spec.ts`

### Step 1：写失败的渠道行为测试

覆盖真实行为而非只断言 Mock 被调用：

- Mock 签约返回稳定渠道协议 ID，并可查询为 ACTIVE；
- Mock 扣款提交只返回 PROCESSING，不直接返回成功；
- Admin 设置下一结果后，查询返回成功、可重试失败、最终失败或 UNKNOWN；
- 同一商户扣款单号重复提交返回同一渠道交易；
- Production 配置 `provider=mock` 时模块初始化失败；
- `AUTO_DEBIT_ENABLED=false` 时返回明确不可用状态，且不调用渠道。

运行：

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/auto-debit-provider.spec.ts test/auto-debit-config.spec.ts
```

预期：模块和接口不存在而失败。

### Step 2：定义 `MandateDebitProvider`

定义签约、查询授权、解约、提交扣款、查询扣款、验证回调的输入输出类型。结果必须显式区分 `PROCESSING/SUCCEEDED/FAILED_RETRYABLE/FAILED_FINAL/UNKNOWN`。

### Step 3：实现配置和 Production fail-closed

新增：

- `AUTO_DEBIT_ENABLED=false`；
- `PAYMENT_MANDATE_PROVIDER=disabled|mock|wechat_auto_renew`；
- `PAYMENT_MANDATE_MOCK_ENABLED=false`；
- `AUTO_DEBIT_RUN_TIME=09:00`；
- 未来微信模板和回调配置占位。

Production + Mock 必须抛出启动配置错误，不能自动回退 disabled。

### Step 4：实现持久化 Mock 渠道

Mock 结果必须可跨 Worker 重启查询。不得只存在进程内 Map；将必要渠道快照写入授权/扣款记录的 provider snapshot。普通 Portal API 不暴露结果控制字段。

### Step 5：运行测试和提交

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/auto-debit-provider.spec.ts test/auto-debit-config.spec.ts
pnpm --filter @subscription-saas/api typecheck
git add apps/api/src/auto-debit apps/api/src/app.module.ts apps/api/.env.example apps/api/.env.production.example apps/api/test/auto-debit-provider.spec.ts apps/api/test/auto-debit-config.spec.ts
git commit -m "feat: add guarded auto debit provider"
```

## Task 3：授权领域服务与 Portal/Admin API

**Files:**

- Create: `apps/api/src/auto-debit/auto-debit.dto.ts`
- Create: `apps/api/src/auto-debit/payment-mandate.service.ts`
- Create: `apps/api/src/auto-debit/auto-debit.controller.ts`
- Create: `apps/api/src/auto-debit/portal-auto-debit.controller.ts`
- Modify: `apps/api/src/auto-debit/auto-debit.module.ts`
- Modify: `apps/api/src/portal/portal.module.ts`
- Create: `apps/api/test/payment-mandate.service.spec.ts`
- Create: `apps/api/test/portal-auto-debit.spec.ts`
- Create: `apps/api/test/auto-debit-controller.spec.ts`

### Step 1：写失败的授权状态测试

测试以下业务破坏点：

- 客户只能为自己的 ACTIVE 订单发起授权；
- 同一订单不能创建两个开放授权；
- PENDING 可变为 ACTIVE/FAILED/REVOKED，终态不能复活；
- 解约不删除历史授权；
- Portal 不返回完整渠道敏感标识；
- Admin 查询需要新权限；
- 授权激活和人工同步写审计。

### Step 2：实现授权服务

- 在事务中检查客户、订单和开放授权；
- 创建 PENDING 事实后调用 provider；
- Mock 可同步完成签约，但仍通过统一结果解释器转为 ACTIVE；
- 使用渠道协议 ID 幂等处理重复结果；
- 解约先持久化请求，再同步渠道结果；失败保留可重试状态和错误快照。

### Step 3：实现 API

Portal：

- `GET /portal/auto-debit/mandates?orderId=`；
- `POST /portal/auto-debit/mandates`；
- `POST /portal/auto-debit/mandates/:id/revoke`；
- `GET /portal/auto-debit/attempts?orderId=&billId=`。

Admin：

- `GET /billing/automation/mandates`；
- `POST /billing/automation/mandates/:id/sync`；
- `POST /billing/automation/mandates/:id/revoke`。

### Step 4：验证和提交

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/payment-mandate.service.spec.ts test/portal-auto-debit.spec.ts test/auto-debit-controller.spec.ts
pnpm --filter @subscription-saas/api typecheck
git add apps/api/src/auto-debit apps/api/src/portal/portal.module.ts apps/api/test/payment-mandate.service.spec.ts apps/api/test/portal-auto-debit.spec.ts apps/api/test/auto-debit-controller.spec.ts
git commit -m "feat: add payment mandate APIs"
```

## Task 4：D、D+1、D+3 调度与账单事务接入

**Files:**

- Create: `apps/api/src/auto-debit/auto-debit.calendar.ts`
- Create: `apps/api/src/auto-debit/auto-debit.scheduler.ts`
- Modify: `apps/api/src/auto-debit/payment-mandate.service.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.service.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.types.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.module.ts`
- Create: `apps/api/test/auto-debit-calendar.spec.ts`
- Create: `apps/api/test/auto-debit-scheduler.spec.ts`
- Modify: `apps/api/test/billing-automation-service.spec.ts`
- Modify: `apps/api/test/billing-automation.integration.spec.ts`

### Step 1：写失败的日历和事务测试

使用手算的固定日期断言：

- dueDate 为 2026-09-02 时，三轮分别为 09-02、09-03、09-05 的 09:00 Asia/Shanghai；
- D+5 仍为现有 09-07 自动逾期；
- 账单生成事务一次插入三个稳定幂等任务；
- 重复生成或协调不新增任务；
- 授权在 D 后激活时只补建尚未来临的 D+1/D+3；
- D+3 已经过后不补建自动扣款任务。

### Step 2：实现纯日历函数和稳定键

纯函数只负责业务日和轮次时间，不访问数据库。稳定键格式必须包含 bill ID 和轮次，不使用当前时间或随机数。

### Step 3：实现事务内调度

`AutoDebitScheduler.enqueueForBill(tx, bill)` 使用 `upsert` 插入三个任务；账单创建和任务插入处于同一事务。授权激活调用同一调度器，只补未来轮次。

### Step 4：验证和提交

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/auto-debit-calendar.spec.ts test/auto-debit-scheduler.spec.ts test/billing-automation-service.spec.ts test/billing-automation.integration.spec.ts
git add apps/api/src/auto-debit apps/api/src/billing-automation apps/api/test/auto-debit-calendar.spec.ts apps/api/test/auto-debit-scheduler.spec.ts apps/api/test/billing-automation-service.spec.ts apps/api/test/billing-automation.integration.spec.ts
git commit -m "feat: schedule recurring debit attempts"
```

## Task 5：扣款执行、状态不明查询与 Worker 恢复

**Files:**

- Create: `apps/api/src/auto-debit/debit-attempt.service.ts`
- Create: `apps/api/src/auto-debit/auto-debit.handlers.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.handlers.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.worker.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.repository.ts`
- Modify: `apps/api/src/auto-debit/auto-debit.module.ts`
- Create: `apps/api/test/debit-attempt.service.spec.ts`
- Create: `apps/api/test/auto-debit-worker.spec.ts`
- Modify: `apps/api/test/billing-automation-repository.spec.ts`
- Modify: `apps/api/test/billing-automation-worker.spec.ts`

### Step 1：写失败的扣款状态测试

覆盖：

- 账单结清时任务 SKIPPED 且无尝试；
- 无 ACTIVE 授权时当前轮次跳过；
- 有未决尝试时只创建查询任务；
- 渠道受理只进入 PROCESSING；
- 调用期间异常进入 UNKNOWN；
- 查询明确不存在后才允许相同商户单号重放；
- D/D+1 失败映射为 FAILED_RETRYABLE，D+3 为 FAILED_FINAL；
- Worker 租约过期后恢复不创建第二个尝试。

### Step 2：实现扣款执行

- 事务中锁定账单和开放授权；
- 以任务幂等键创建或读取 `DebitAttempt` 和底层 `PaymentOrder`；
- 提交前写 `SUBMITTING`；
- 网络调用在事务外；
- 结果解释后持久化 PROCESSING/FAILED/UNKNOWN；
- PROCESSING/UNKNOWN 插入查询任务；
- 查询任务使用原商户扣款单号，不新建 Attempt。

### Step 3：接入现有 Worker

扩展 supported job types 和 handler 分派。沿用现有租约、指数退避、死信和人工重试，不复制第二个 Worker。

### Step 4：验证和提交

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/debit-attempt.service.spec.ts test/auto-debit-worker.spec.ts test/billing-automation-repository.spec.ts test/billing-automation-worker.spec.ts
git add apps/api/src/auto-debit apps/api/src/billing-automation apps/api/test/debit-attempt.service.spec.ts apps/api/test/auto-debit-worker.spec.ts apps/api/test/billing-automation-repository.spec.ts apps/api/test/billing-automation-worker.spec.ts
git commit -m "feat: execute idempotent debit jobs"
```

## Task 6：原子支付结算、并发上限和未分配收款

**Files:**

- Modify: `apps/api/src/finance/finance.service.ts`
- Modify: `apps/api/src/finance/finance.module.ts`
- Modify: `apps/api/src/payment/payment-order.service.ts`
- Modify: `apps/api/src/payment/payment.module.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.repository.ts`
- Modify: `apps/api/src/auto-debit/debit-attempt.service.ts`
- Create: `apps/api/test/payment-settlement.spec.ts`
- Create: `apps/api/test/auto-debit-settlement.integration.spec.ts`
- Modify: `apps/api/test/portal-payment.spec.ts`
- Modify: `apps/api/test/finance-billing.spec.ts`

### Step 1：写失败的并发结算测试

必须使用真实 PostgreSQL 集成测试验证锁，而不是只断言 Prisma Mock：

- 两个并发渠道成功结算同一 0.01 元账单，只核销 0.01 元；
- 两个渠道交易各只创建一个 `PaymentRecord`；
- 后完成的收款保留未分配余额；
- 重复回调不重复入账；
- 已结清账单取消 PENDING 代扣任务；
- 现有主动支付仍完整核销且无回归。

### Step 2：提取原子结算入口

在 `FinanceService` 中增加内部/领域级 `settlePaymentOrder`：

- 锁定 PaymentOrder、PaymentRecord 唯一关系和所有目标账单；
- 创建一次 PaymentRecord；
- 按 PaymentOrderItem 顺序读取实时 remainingAmount；
- 每项核销 `min(itemAmount, billRemaining, paymentRemaining)`；
- 同一事务更新账单、写核销、取消待执行任务并关联 PaymentOrder；
- 返回 allocated/unallocated 金额；
- 事务后写审计。

不要让 API DTO 或 Portal RequestContext 进入底层金额算法。

### Step 3：重构主动支付和代扣共用入口

`PaymentOrderService.completePaymentOrder` 和 `DebitAttemptService` 都调用同一结算方法。保留渠道实收必须等于 PaymentOrder 请求金额的校验，但核销金额允许因并发低于实收。

### Step 4：验证和提交

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/payment-settlement.spec.ts test/auto-debit-settlement.integration.spec.ts test/portal-payment.spec.ts test/finance-billing.spec.ts
git add apps/api/src/finance apps/api/src/payment apps/api/src/auto-debit apps/api/src/billing-automation/billing-automation.repository.ts apps/api/test/payment-settlement.spec.ts apps/api/test/auto-debit-settlement.integration.spec.ts apps/api/test/portal-payment.spec.ts apps/api/test/finance-billing.spec.ts
git commit -m "feat: settle concurrent payments atomically"
```

## Task 7：扣款失败通知和催收协调

**Files:**

- Modify: `apps/api/src/notification/notification.service.ts`
- Modify: `apps/api/src/auto-debit/auto-debit.handlers.ts`
- Modify: `apps/api/src/auto-debit/debit-attempt.service.ts`
- Modify: `apps/api/src/finance/finance.service.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/.env.production.example`
- Create: `apps/api/test/auto-debit-notification.spec.ts`
- Modify: `apps/api/test/notification.spec.ts`
- Modify: `apps/api/test/billing-automation-service.spec.ts`

### Step 1：写失败的通知测试

- D+3 最终失败只产生一组幂等通知；
- Portal 和微信服务号记录存在；
- 短信模板未配置时记录 `CHANNEL_NOT_CONFIGURED`，但任务完成且不回滚 Attempt；
- 迟到扣款成功会按剩余金额更新/关闭催收案件；
- 通知重试不重复创建客户通知。

### Step 2：实现通知和协调

新增代扣失败通知模板映射。短信仍由通知框架处理，不在扣款服务直接调用阿里云 SDK。成功结算复用账单结清协调逻辑取消剩余任务并更新催收。

### Step 3：验证和提交

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/auto-debit-notification.spec.ts test/notification.spec.ts test/billing-automation-service.spec.ts
git add apps/api/src/notification apps/api/src/auto-debit apps/api/src/finance apps/api/.env.example apps/api/.env.production.example apps/api/test/auto-debit-notification.spec.ts apps/api/test/notification.spec.ts apps/api/test/billing-automation-service.spec.ts
git commit -m "feat: notify final debit failures"
```

## Task 8：Admin 查询、人工恢复和 Mock 控制

**Files:**

- Modify: `apps/api/src/auto-debit/auto-debit.controller.ts`
- Modify: `apps/api/src/auto-debit/auto-debit.dto.ts`
- Create: `apps/api/src/auto-debit/auto-debit.admin.service.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.admin.service.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.controller.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.dto.ts`
- Modify: `apps/api/src/auto-debit/auto-debit.module.ts`
- Create: `apps/api/test/auto-debit-admin.spec.ts`
- Modify: `apps/api/test/billing-automation-controller.spec.ts`

### Step 1：写失败的权限与恢复测试

- view/manage/execute 三类权限边界正确；
- UNKNOWN 只能查询，人工重试被拒绝；
- 人工扣款要求原因、ACTIVE 授权、未结账单和无未决尝试；
- Mock 结果设置接口只在 Mock/Staging 可用；
- 所有人工动作写操作人、原因和审计快照。

### Step 2：实现 Admin API

新增：

- 授权/扣款分页和筛选；
- 状态不明查询；
- 死信恢复；
- 人工扣款；
- 取消未执行任务；
- Staging Mock 下一结果设置；
- summary 中授权、扣款、UNKNOWN、死信和未分配收款统计。

### Step 3：验证和提交

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/auto-debit-admin.spec.ts test/billing-automation-controller.spec.ts
git add apps/api/src/auto-debit apps/api/src/billing-automation apps/api/test/auto-debit-admin.spec.ts apps/api/test/billing-automation-controller.spec.ts
git commit -m "feat: add auto debit operations controls"
```

## Task 9：Portal 授权、账单状态和主动支付兜底 UI

**Files:**

- Modify: `apps/web/src/lib/portal-types.ts`
- Modify: `apps/web/src/lib/portal-api.ts`
- Create: `apps/web/src/lib/portal-auto-debit-view-model.ts`
- Create: `apps/web/src/app/portal/auto-debit/page.tsx`
- Create: `apps/web/src/app/portal/auto-debit/[id]/page.tsx`
- Create: `apps/web/src/app/portal/auto-debit/auto-debit.module.css`
- Modify: `apps/web/src/app/portal/bills/page.tsx`
- Modify: `apps/web/src/app/portal/bills/[id]/page.tsx`
- Modify: `apps/web/src/app/portal/page.tsx`
- Create: `apps/web/test/portal-auto-debit-view-model.spec.ts`
- Create: `apps/web/test/portal-auto-debit-pages.spec.tsx`
- Modify: `apps/web/test/portal-bill-card.spec.tsx`

### Step 1：写失败的客户可见行为测试

- disabled 状态显示“自动扣款暂未开通”且没有 Mock 控件；
- 未授权显示开通入口和主动支付；
- ACTIVE 显示下一扣款日、最近结果和解约；
- PROCESSING 明确提示结果未定，主动支付仍可用；
- 失败显示下一次重试时间和立即支付；
- 移动端 390px 不横向溢出；
- Portal 不显示完整渠道协议 ID 或测试结果控制入口。

### Step 2：实现 view model 和页面

先实现纯 view model，将 API 状态映射成文案、Tag、按钮和 helper。页面按已批准长图实现，但保留现有 Portal 组件和视觉语言。

### Step 3：验证和提交

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-auto-debit-view-model.spec.ts test/portal-auto-debit-pages.spec.tsx test/portal-bill-card.spec.tsx
pnpm --filter @subscription-saas/web typecheck
git add apps/web/src/lib apps/web/src/app/portal apps/web/test/portal-auto-debit-view-model.spec.ts apps/web/test/portal-auto-debit-pages.spec.tsx apps/web/test/portal-bill-card.spec.tsx
git commit -m "feat: add portal auto debit journey"
```

## Task 10：Admin 月租自动化和订单财务 UI

**Files:**

- Modify: `apps/web/src/lib/billing-automation-view-model.ts`
- Modify: `apps/web/src/app/billing/monthly-rent/page.tsx`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Modify: `apps/web/src/lib/admin-order-workspace.ts`
- Modify: `apps/web/src/constants/labels.ts`
- Modify: `apps/web/test/billing-automation-view-model.spec.ts`
- Modify: `apps/web/test/admin-order-workspace.spec.ts`
- Create: `apps/web/test/auto-debit-admin-ui.spec.tsx`

### Step 1：写失败的 Admin 行为测试

- summary 展示授权、PROCESSING、UNKNOWN、失败、未分配收款；
- 列表可按授权/扣款状态筛选；
- UNKNOWN 只显示“查询结果”；
- 人工扣款和取消按钮受权限及状态控制；
- 订单财务 Tab 能追踪 Mandate → Attempt → PaymentOrder → PaymentRecord → WriteOff；
- Mock 环境显示醒目标识，Production 不显示结果模拟按钮。

### Step 2：实现 UI

在现有月租自动化页增加授权与扣款区域，不新建重复菜单。订单财务 Tab 增加只读追踪卡片和允许的操作入口。

### Step 3：验证和提交

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/billing-automation-view-model.spec.ts test/admin-order-workspace.spec.ts test/auto-debit-admin-ui.spec.tsx
pnpm --filter @subscription-saas/web typecheck
git add apps/web/src/lib apps/web/src/app/billing/monthly-rent/page.tsx apps/web/src/app/orders/[id]/page.tsx apps/web/src/constants/labels.ts apps/web/test
git commit -m "feat: expose auto debit operations UI"
```

## Task 11：部署安全、运行手册和 Staging 验收入口

**Files:**

- Modify: `docker-compose.staging.images.example.yml`
- Modify: `docker-compose.production.images.example.yml`
- Modify: `.env.staging.images.example`
- Modify: `.env.production.images.example`
- Modify: `docs/deployment.md`
- Create: `docs/operations/stage1b-auto-debit-runbook.zh-CN.md`
- Modify: `apps/web/test/deployment-ops-safety.spec.ts`
- Create: `apps/api/test/auto-debit-production-safety.spec.ts`

### Step 1：写失败的运行安全测试

测试实际配置解析结果，不只 grep 文本：

- Production 默认 `AUTO_DEBIT_ENABLED=false`；
- Production 选择 Mock 时启动检查失败；
- Staging 明确开启 Mock 后显示 Mock 状态；
- 未提供真实模板 ID 时 `wechat_auto_renew` 不可启动；
- 关闭代扣不影响 billing worker 和主动支付。

### Step 2：实现配置和手册

手册包含：

- 数据库迁移 → healthy → 公网健康检查的固定发布顺序；
- Staging Mock 开关；
- 十项人工验收步骤；
- 死信、UNKNOWN、人工扣款和未分配收款处理；
- 商户开通后真实适配器所需配置清单；
- Portal 产品交互长图链接。

### Step 3：验证和提交

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/auto-debit-production-safety.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/deployment-ops-safety.spec.ts
git add docker-compose.staging.images.example.yml docker-compose.production.images.example.yml .env.staging.images.example .env.production.images.example docs/deployment.md docs/operations/stage1b-auto-debit-runbook.zh-CN.md apps/api/test/auto-debit-production-safety.spec.ts apps/web/test/deployment-ops-safety.spec.ts
git commit -m "docs: add auto debit release safeguards"
```

## Task 12：全量验证、迁移检查和代码审查

**Files:**

- Modify only if verification finds a real defect.

### Step 1：迁移与生成检查

```powershell
pnpm --filter @subscription-saas/api prisma:migrate:status
pnpm --filter @subscription-saas/api prisma:validate
pnpm --filter @subscription-saas/api prisma:generate
```

### Step 2：定向测试

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/auto-debit-schema.spec.ts test/auto-debit-provider.spec.ts test/auto-debit-config.spec.ts test/payment-mandate.service.spec.ts test/portal-auto-debit.spec.ts test/auto-debit-controller.spec.ts test/auto-debit-calendar.spec.ts test/auto-debit-scheduler.spec.ts test/debit-attempt.service.spec.ts test/auto-debit-worker.spec.ts test/payment-settlement.spec.ts test/auto-debit-settlement.integration.spec.ts test/auto-debit-notification.spec.ts test/auto-debit-admin.spec.ts test/auto-debit-production-safety.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/portal-auto-debit-view-model.spec.ts test/portal-auto-debit-pages.spec.tsx test/auto-debit-admin-ui.spec.tsx test/deployment-ops-safety.spec.ts
```

### Step 3：全量质量门禁

```powershell
pnpm -r lint
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
pnpm build
git diff --check origin/main...HEAD
```

### Step 4：变异式自检

逐项确认至少一个测试会捕获：

- 删除开放授权唯一约束；
- 把 PROCESSING 当成功；
- UNKNOWN 直接创建新 Attempt；
- 去掉账单锁；
- 核销使用原 PaymentOrderItem 金额而非实时 remainingAmount；
- Production 允许 Mock；
- 最终失败重复发送通知；
- Portal 暴露完整渠道协议 ID；
- 人工扣款绕过权限或原因。

### Step 5：请求代码审查

使用 `superpowers:requesting-code-review` 审查相对 `origin/main` 的完整差异。修复高/中优先级问题并重新运行受影响验证。

### Step 6：最终提交状态

```powershell
git status --short --branch
git log --oneline --decorate -12
```

只有在工作树仅保留用户原有未跟踪目录、所有必需测试通过且审查无阻塞项时，才进入 `superpowers:finishing-a-development-branch`。

---

## 实施检查点

- **检查点 A（Task 1–3）：** 模型、Mock 渠道和授权 API；
- **检查点 B（Task 4–6）：** 三轮任务、状态恢复和原子核销；
- **检查点 C（Task 7–10）：** 通知、Admin、Portal；
- **检查点 D（Task 11–12）：** 发布安全、全量验证和审查。

每个检查点完成后汇报：已完成行为、测试证据、迁移影响、遗留限制和下一批任务。真实微信实扣仍明确标记为商户能力开通后的外部补充波次。
