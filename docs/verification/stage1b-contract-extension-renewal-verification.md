# Stage 1B 合同延期/续订验收证据

## 1. 范围与安全边界

- 实现分支：`feat/stage1b-contract-extension-renewal-20260805`
- 验收范围：`origin/main..HEAD`
- 生产默认值：`SUBSCRIPTION_EXTENSION_ENABLED=false`
- 本地验收未迁移 staging、未启用 staging/生产开关、未调用真实短信或电子签供应商、未发送外部通知。
- 只有“真实短信送达”和“真实电子签交互”保留为 staging 人工检查；它们之前和之后的业务状态转换均由 provider mock 自动化测试覆盖。

## 2. 精确验收命令

以下命令均从仓库根目录运行。

### A. 报价与生命周期

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-extension-pricing.spec.ts test/subscription-change.service.spec.ts test/portal-renewal.spec.ts
```

### B. 合同模板、电子签与回调竞争

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-extension-contract.spec.ts test/stage3-extension-esign.spec.ts test/stage3-extension-archive-race.spec.ts
```

### C. 分段、账单、权益、支付与激活

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/contract-segment.service.spec.ts test/contract-segment.integration.spec.ts test/subscription-segment-consistency.spec.ts test/billing-contract-segment.spec.ts test/extension-entitlement-renewal.spec.ts test/extension-payment-continuity.spec.ts test/subscription-extension-activation.spec.ts
```

### D. 提醒、缺失模板、到期、还车与 Worker

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/renewal-calendar.spec.ts test/renewal-consideration.spec.ts test/renewal-reminder-notification.spec.ts test/sms.spec.ts test/subscription-change-worker.spec.ts test/subscription-expiry.spec.ts test/subscription-expiry-return.integration.spec.ts test/order-return.spec.ts
```

### E. 权限、Schema 与迁移合同

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts test/subscription-change-schema.spec.ts test/subscription-change-migration.spec.ts
pnpm --filter @subscription-saas/api test -- --project database test/subscription-change-migration.integration.spec.ts
pnpm prisma:migrate:status
pnpm prisma:validate
pnpm prisma:generate
```

### F. 跨模块端到端与运维工具

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-extension-e2e.spec.ts test/subscription-segment-consistency.spec.ts
node --test scripts/subscription-segment-bootstrap-core.test.mjs scripts/subscription-segment-bootstrap-apply.test.mjs scripts/subscription-renewal-reconcile.test.mjs
pnpm subscription-segments:bootstrap:dry-run
pnpm subscription-renewals:reconcile
```

`bootstrap:dry-run` 和 `subscription-renewals:reconcile` 对异常数据返回退出码 2 是预期的安全失败：报告异常但不写数据库。任何写入均要求显式 `--apply`。

### G. 管理端、Portal 权限与呈现

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-change.controller.spec.ts test/portal-renewal-security.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/subscription-change-view-model.spec.ts test/subscription-change-admin-pages.spec.tsx test/portal-renewal-view-model.spec.ts test/portal-renewal-pages.spec.tsx
```

### H. 最终门禁

```powershell
pnpm quality:gate
pnpm build
git diff --check
git status --short --branch
git log --oneline --decorate -15
```

## 3. 验收追踪矩阵

| 验收项                | 自动化证据（精确测试名）                                                                                                                                                                                                                                                                               | 命令    | 结论                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------- |
| 当前版本定价          | `prices an ACTIVE current-version plan without requiring the leased vehicle to be saleable`；`keeps a plan available through the end of its Shanghai effective date`                                                                                                                                   | A       | 自动化覆盖                      |
| 原价定价              | `uses the immutable source segment facts for ORIGINAL_PRICE even when old master data is inactive`；`requires a different user to approve original-price and discount exceptions`；`requires an approved exception before publishing an ORIGINAL_PRICE quote`                                          | A       | 自动化覆盖                      |
| 审批折扣              | `accepts a positive approved discount not exceeding the current-version baseline`；`requires a different user to approve original-price and discount exceptions`                                                                                                                                       | A       | 自动化覆盖                      |
| 不可变报价修订        | `creates append-only quote revisions and supersedes the prior formal quote`；`never replaces a confirmed quote`；`confirms only the exact published formal quote revision`；`rejects stale and superseded quote identities`                                                                            | A       | 自动化覆盖                      |
| 严格补充协议模板      | `selects only an active SUBSCRIPTION_EXTENSION template and preserves the original contract`；`fails closed when no active extension template exists`；`keeps the original contract mapping unchanged`                                                                                                 | B       | 自动化覆盖                      |
| 电子签回调与到期竞争  | `is idempotent for duplicate and out-of-order callbacks`；`lets a callback completed before the deadline win`；`treats completion exactly at the deadline as late evidence only`；`lets expiry win when the expiry path acquired and committed the business state first`                               | B       | provider mock 自动化覆盖        |
| BASE/EXTENSION 连续性 | `requires an extension to start on the day after the current last segment`；`accepts a non-overlapping extension adjacent to the current last segment`；`rejects a billing period that crosses into the next contract segment`；`accepts adjacent BASE and EXTENSION segments with one ACTIVE segment` | C       | 自动化覆盖                      |
| 分段账单              | `uses BASE segment terms before an extension starts`；`uses the segment amount and identity without changing the existing source key`；`pauses billing and moves the extension to manual takeover when a cycle crosses segments`                                                                       | C       | 自动化覆盖                      |
| 权益续期              | `creates the new period entitlement from the extension segment snapshot with a segment-scoped key`；`does not duplicate grants when a recovered worker repeats the same renewal`                                                                                                                       | C       | 自动化覆盖                      |
| 支付连续性            | `does not revoke the active mandate or mutate existing payable receivables during activation`；`continues submitting an existing payable bill through the existing active mandate`                                                                                                                     | C       | 自动化覆盖                      |
| 激活与完成            | `activates the scheduled segment, completes the prior segment, and enqueues stable continuation jobs`；`moves the change to COMPLETED only after every continuation job has completed`                                                                                                                 | C       | 自动化覆盖                      |
| D-30/D-14/D-3         | `schedules D-30, D-14 and D-3 at 09:00 Shanghai with a next-day deadline`；`creates only one consideration and three durable reminder jobs for a segment`；`completes a claimed reminder only once across duplicate polls`                                                                             | D       | 自动化覆盖                      |
| 短信模板缺失          | `keeps the in-app success when the SMS template is not configured`；`reports CONFIG_MISSING without calling the provider for an unconfigured renewal slot`；`retries the same slot and idempotency key after SMS configuration is fixed`                                                               | D       | provider mock 自动化覆盖        |
| 迟加入考虑期          | `late enrollment skips obsolete slots and keeps only the latest applicable reminder pending`；`late enrollment makes only the latest applicable reminder immediately pending`                                                                                                                          | D、F    | 自动化覆盖                      |
| 未签署到期与还车      | `moves an unsigned expiring subscription to return due without touching existing money or mandate facts`；`allows a PENDING_RETURN order with its leased vehicle to prepare and confirm the normal return`；`creates only one D+1 return-overdue notice and never creates a fee`                       | D       | 自动化覆盖                      |
| 权限与客户隔离        | `assigns the approved subscription change permissions and menu by role`；`protects price override approval with the dedicated permission`；`returns 404 rather than exposing another customer's consideration`；`returns 404 rather than exposing another customer's change`                           | E、G    | 自动化覆盖                      |
| 新库/存量库迁移       | `defines the approved extension, quote, segment, consideration, and reminder enums`；`enforces active-change, BASE, active-segment, date, and revision constraints in SQL`；新鲜 schema 部署全部 84 个迁移；一次性 schema 先部署前 78 个迁移并写入旧 `product` 数据，再升级至 84 个迁移并确认旧数据存活；现有开发 schema `migrate:status` 为最新 | E       | 自动化合同 + 新库/升级库/现有库实证 |
| Worker 重启           | `recovers the same leased job after a worker restart`；`does not dead-letter a completed side effect when completion reconciliation temporarily fails`                                                                                                                                                 | D、F    | 自动化覆盖                      |
| 引导与对账幂等        | `apply is transactional and an idempotent rerun creates no second BASE`；`dry run never opens a write transaction`；`apply is transactional, idempotent, and only enqueues work without sending SMS`                                                                                                   | F       | 自动化覆盖                      |
| 回滚                  | `fails closed when the feature flag is not the exact string true`；`does not write when the extension feature is disabled`；只读 reconcile 覆盖分段异常；发布手册第 8 节要求关开关并保留合同、分段、报价、通知、任务、审计、账单和支付委托事实                                                         | A、D、F | 自动化安全边界 + 可审计 Runbook |

## 4. Staging 唯一人工验收项

### 4.1 真实短信供应商

前置自动化证据：命令 D 已覆盖五个模板变量、`CONFIG_MISSING`、同槽重试、站内信与短信通道独立性及幂等键。

经发布负责人授权后，仅在 staging：

1. 配置五个 `RENEWAL_*_TEMPLATE_CODE`，参数严格为 `orderNo`、`plateNo`、`endDate`、`daysRemaining`、`portalPath`。
2. 分别触发 D-30、D-14、D-3、到期还车、D+1 逾期还车样例。
3. 核对供应商回执、脱敏手机号、模板代码快照、通道结果及站内信；不得把真实通知发给非测试号码。

### 4.2 真实电子签供应商

前置自动化证据：命令 B 已覆盖专用 Stage 3 身份、客户归属、签署前状态门禁、重复/乱序回调、归档与到期竞争以及 EXTENSION 分段创建。

经发布负责人授权后，仅在 staging：

1. 用专用测试客户生成 `SUBSCRIPTION_EXTENSION` 补充协议并取得签署链接。
2. 完成真实签署，核对已签 PDF 归档、供应商事件时间、合同状态和唯一 SCHEDULED EXTENSION 分段。
3. 重放同一回调，确认不重复归档、不重复建分段；到期边界样例按发布手册执行并保留证据。

## 5. 验证结果

- Task 13 全量测试：shared 8、web 533、API 2467，共 3008 个测试通过。
- Task 13 构建：`pnpm build` 通过。
- Task 14 迁移实证：`subscription-change-migration.integration.spec.ts` 3/3 通过，覆盖新鲜库、78→84 存量升级及现有开发库状态；本地专用 PostgreSQL 共 84 个迁移且状态最新。
- Task 14 最终门禁：`pnpm quality:gate` 通过；API 214 个测试文件、2495 个测试全部通过，lint、Prisma schema、API/Web 类型检查及迁移状态均通过。
- Task 14 生产构建：`pnpm build` 通过，Nest API 与 Next.js Web 均成功产出。
- 独立代码审查：修复并复核并发、幂等、迁移升级与合同生成恢复问题后，无剩余 Critical 或 Important。
- 完成前差异检查：`git diff --check` 通过；未执行 push、PR、merge、staging migration、功能开关启用或外部通知。

## 6. 发布/回滚交接

发布顺序、五个短信环境变量、staging smoke、异常退出码与保留事实回滚步骤见 `docs/runbooks/stage1b-contract-extension-renewal-release.md`。本验收不授权 push、PR、merge、staging migration、开关启用或任何外部通知。
