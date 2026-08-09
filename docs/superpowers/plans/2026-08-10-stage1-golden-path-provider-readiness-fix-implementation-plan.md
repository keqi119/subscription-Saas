# Stage 1 Golden Path Provider Readiness Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. This plan is executed inline by the primary agent; do not delegate implementation to subagents.

**Goal:** 让 Stage 1 Golden Path 的五个微信公众号通知严格匹配已领用模板，使用独立交付模板，修复发布门禁，并在保持 Journey 关闭的前提下完成法大大生产签署人准备、成对镜像部署和真实供应商验收。

**Architecture:** 保留通知记录现有通用 payload；新增纯函数把稳定语义字段转换为微信 Provider 的精确模板变量，并在缺少必填事实时 fail-closed。`SubscriptionJourneyNotificationService` 和既有非 Journey 调用方读取 Application、Order、Vehicle、ReceivableBill 的权威事实后传入语义数据。模板 ID 继续只从受控环境变量读取，不进入 Git；法大大验收绑定只走现有正式开户/实名/证书流程。

**Tech Stack:** NestJS 11、Prisma 7/PostgreSQL、Vitest 4、Next.js 16/React 19、TypeScript 6、pnpm 11、微信公众号模板消息、法大大生产 API、Docker Compose、GHCR。

## Global Constraints

- 批准设计：`docs/superpowers/specs/2026-08-10-stage1-golden-path-provider-readiness-fix-design.zh-CN.md`。
- 本轮不新增或修改数据库 schema、migration、API 合约和页面交互。
- 五个模板分别为申请已受理、最终方案待确认、合同待签署、首期账单待支付、车辆待取车；不得跨场景回退模板。
- 真实模板 ID、AppSecret、access token、完整 OpenID、法大大 Provider Customer ID、签署 URL 和身份证件不得进入 Git、命令输出或验收报告。
- 所有金额在数据库和语义 payload 中保持“分”；转换微信 `amount` 字段时使用 `BigInt`/整数运算生成两位小数元字符串，禁止浮点计算。
- `SUBSCRIPTION_JOURNEY_ENABLED=false` 一直保持到五模板 smoke、法大大绑定预检、镜像部署和数据库状态全部通过。
- 微信委托代扣不属于本轮；`AUTO_DEBIT_ENABLED=false`，支付仍使用客户 Portal 微信 JSAPI。
- 每项代码行为改动执行 RED → GREEN → REFACTOR；每个任务独立提交。任何通过结论都必须来自本轮新运行的命令。
- 使用当前隔离工作树 `fix/stage1-golden-path-provider-readiness-20260810`；保留主工作树的无关未跟踪文件。

---

### Task 0: Baseline and safety gate

**Files:** None.

- [ ] **Step 1: Verify the isolated branch and worktree**

Run:

```powershell
git status --short --branch
git branch --show-current
git rev-parse --show-toplevel
git log -2 --oneline
```

Expected: branch is `fix/stage1-golden-path-provider-readiness-20260810`; root ends in `.worktrees/stage1-golden-path-provider-readiness-20260810`; the design commit `2890940` is present; only this plan may be uncommitted.

- [ ] **Step 2: Restore the locked dependency graph**

Run:

```powershell
pnpm install --frozen-lockfile
pnpm prisma:validate
```

Expected: install does not change `pnpm-lock.yaml`; Prisma schema is valid.

- [ ] **Step 3: Verify migration baseline without changing it**

Load `DATABASE_URL` through the existing ignored secret mechanism, then run:

```powershell
if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL)) { throw "DATABASE_URL is required" }
pnpm prisma:migrate:status
```

Expected: 88 migrations are applied and schema is up to date. If not, stop; do not run reset and do not generate a migration.

- [ ] **Step 4: Capture the known release-guard failure**

Run:

```powershell
pnpm release:check
```

Expected before Task 5: failure contains `VEHICLE_MODEL_COMPATIBILITY_IDENTIFIER` for `vehicle-workspace-header.tsx`; no unrelated failure is accepted as baseline.

### Task 1: Independent handover configuration, preflight, and smoke tooling

**Files:**

- Modify: `apps/api/src/notification/notification.service.ts`
- Modify: `scripts/stage1-golden-path-production-preflight.mjs`
- Modify: `scripts/stage1-golden-path-production-preflight.test.mjs`
- Modify: `scripts/wechat-official-account-smoke.mjs`
- Create: `scripts/wechat-official-account-smoke.test.mjs`
- Modify: `.env.example`
- Modify: `.env.production.example`
- Modify: `.env.production.images.example`
- Modify: `.env.staging.example`
- Modify: `.env.staging.images.example`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/.env.production.example`
- Modify: `docker-compose.production.images.example.yml`
- Modify: `docs/wechat-official-account-setup.md`
- Modify: `docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md`

- [ ] **Step 1: Write failing configuration and smoke tests**

Extend the preflight fixture with `WECHAT_TEMPLATE_HANDOVER_PENDING` and add assertions that an absent, blank, or `<CHANGE_ME>` value produces a blocker keyed to that variable. Add a smoke-tool test that imports the supported-template registry and asserts:

```js
expect(SMOKE_TYPES.HANDOVER_PENDING).toMatchObject({
  envKey: "WECHAT_TEMPLATE_HANDOVER_PENDING",
  eventType: "HANDOVER_ESIGN_PENDING",
  notificationType: "HANDOVER_ESIGN_PENDING",
  templateCode: "HANDOVER_ESIGN_PENDING_WECHAT"
});
```

Also assert all checked-in environment examples contain only:

```env
WECHAT_TEMPLATE_HANDOVER_PENDING=<CHANGE_ME>
```

and never a real template ID.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
node --test scripts/stage1-golden-path-production-preflight.test.mjs scripts/wechat-official-account-smoke.test.mjs
```

Expected: FAIL because handover is not required or supported.

- [ ] **Step 3: Add the independent route and fail-closed preflight**

Change the notification route to:

```ts
[NotificationTemplateType.HANDOVER_ESIGN_PENDING]: "WECHAT_TEMPLATE_HANDOVER_PENDING"
```

Add `WECHAT_TEMPLATE_HANDOVER_PENDING` to `REQUIRED_PROVIDER_KEYS`. Do not retain any fallback to `WECHAT_TEMPLATE_APPLICATION_PROGRESS`.

- [ ] **Step 4: Add safe smoke support**

Add `HANDOVER_PENDING` to `SMOKE_TYPES`, export the registry/normalizer behind a main-module guard, update CLI help, and keep `WECHAT_OA_TEMPLATE_DATA_JSON` as the only way to supply exact live payload data. The script must continue to accept exactly one OpenID and mask template ID, OpenID and provider message ID.

- [ ] **Step 5: Update examples and operator documentation**

Add `<CHANGE_ME>` to all listed examples and the production image compose pass-through. Document the four exact handover fields:

```text
character_string1, thing9, car_number5, thing11
```

Update the Golden Path runbook to require five templates and to keep Journey disabled until all five real smokes pass.

- [ ] **Step 6: Run GREEN verification and commit**

```powershell
node --test scripts/stage1-golden-path-production-preflight.test.mjs scripts/wechat-official-account-smoke.test.mjs
git diff --check
git add apps/api/src/notification/notification.service.ts scripts .env.example .env.production.example .env.production.images.example .env.staging.example .env.staging.images.example apps/api/.env.example apps/api/.env.production.example docker-compose.production.images.example.yml docs/wechat-official-account-setup.md docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md
git commit -m "feat: require independent handover template"
```

### Task 2: Exact WeChat provider payload mapper

**Files:**

- Create: `apps/api/src/notification/wechat-template-data.ts`
- Create: `apps/api/test/wechat-template-data.spec.ts`
- Modify: `apps/api/src/notification/notification.service.ts`
- Modify: `apps/api/test/notification.spec.ts`

- [ ] **Step 1: Write failing pure mapping tests**

Cover the exact keys and values for all five types:

```ts
APPLICATION_PROGRESS -> character_string3, const4, const5, time6
FINAL_PLAN_PENDING    -> character_string2, phrase5, car_number8, thing13, time9
CONTRACT_PENDING      -> character_string2, thing3, thing6, thing1
PAYMENT_PENDING       -> car_number1, thing2, amount4, amount7, time5
HANDOVER_ESIGN_PENDING -> character_string1, thing9, car_number5, thing11
```

Tests must also prove:

- `thing` values stop at 20 Unicode code points, including emoji/surrogate pairs;
- business identifiers stop at 32 Unicode code points;
- `540000` cents becomes `5400.00`, `1` becomes `0.01`, and values above `Number.MAX_SAFE_INTEGER` remain exact;
- no deposit bill selects `首期租金`, otherwise `押金及首期租金`;
- missing order/application number, plate, model, customer, bill amount, remaining amount or due date returns `WECHAT_TEMPLATE_DATA_MISSING:<field>`.

- [ ] **Step 2: Run mapper tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/wechat-template-data.spec.ts test/notification.spec.ts
```

- [ ] **Step 3: Implement the pure mapper**

Implement a side-effect-free result type:

```ts
type WechatTemplateDataResult =
  | { data: Record<string, string>; error: null }
  | { data: null; error: `WECHAT_TEMPLATE_DATA_MISSING:${string}` };
```

Inputs are stable semantic keys such as `applicationNo`, `orderNo`, `plateNo`, `modelDisplayName`, `initialBillAmountCents`, `initialBillRemainingCents`, `initialBillDueAt`, `hasDepositBill`, and the already resolved `customerName`. Keep application constants fixed to `已受理` and `车辆订阅`.

- [ ] **Step 4: Separate audit payload from provider payload**

Refactor `createNotificationRecords`/`createWechatRecord` so:

- in-app/SMS records keep the existing generic payload;
- the WeChat record also keeps that generic, sanitized payload for audit;
- only `provider.send(...data)` receives the exact mapped object;
- missing template data creates a WeChat record with the stable error and does not call or claim the provider;
- service-case mapping and its `const4` allowlist retain current behavior.

- [ ] **Step 5: Run GREEN verification and commit**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/wechat-template-data.spec.ts test/notification.spec.ts
pnpm --filter @subscription-saas/api typecheck
git diff --check
git add apps/api/src/notification/wechat-template-data.ts apps/api/src/notification/notification.service.ts apps/api/test/wechat-template-data.spec.ts apps/api/test/notification.spec.ts
git commit -m "fix: map golden path wechat template data"
```

### Task 3: Supply authoritative Journey notification facts

**Files:**

- Modify: `apps/api/src/subscription-journey/subscription-journey-notification.service.ts`
- Modify: `apps/api/test/subscription-journey-notification.spec.ts`

- [ ] **Step 1: Write failing context tests**

For each Journey customer-action step, assert `notifyCustomer.data` includes only non-sensitive semantic facts needed by the mapper:

- final plan: Application number plus the `finalVehicleId` vehicle's authoritative plate;
- contract: order number, `modelDisplayNameSnapshot`, and order vehicle plate;
- payment: plate, summed original/remaining cents for active `DEPOSIT` and `FIRST_MONTHLY_FEE`, deposit-presence flag, earliest due date;
- handover: order number, model snapshot and plate.

Add failure cases for missing final vehicle, missing plate, missing order and missing initial bills. Verify stale-plan and delivery retry semantics remain unchanged.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-notification.spec.ts
```

- [ ] **Step 3: Expand the authoritative query**

Select `Application.finalVehicleId`; for order context select `modelDisplayNameSnapshot`, vehicle `plateNo`, and receivable bills filtered to:

```ts
{
  billType: { in: [BillType.DEPOSIT, BillType.FIRST_MONTHLY_FEE] },
  billStatus: { not: BillStatus.CANCELLED },
  deletedAt: null
}
```

Query the final vehicle separately by `finalVehicleId` because Application has no Prisma relation for this scalar. Convert `BigInt` cents to decimal integer strings before placing them in JSON-compatible notification data.

- [ ] **Step 4: Preserve privacy and idempotency**

Do not add OpenID, payment prepay data, Fadada IDs, sign URLs or raw provider payloads. Keep the existing idempotency key and `requireWechatSuccess=true` behavior unchanged.

- [ ] **Step 5: Run GREEN verification and commit**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-notification.spec.ts
pnpm --filter @subscription-saas/api typecheck
git diff --check
git add apps/api/src/subscription-journey/subscription-journey-notification.service.ts apps/api/test/subscription-journey-notification.spec.ts
git commit -m "fix: load authoritative journey notification facts"
```

### Task 4: Preserve existing non-Journey notification behavior

**Files:**

- Modify: `apps/api/src/customer/customer.service.ts`
- Modify: `apps/api/src/esign/esign.service.ts`
- Modify: `apps/api/test/application-review-api.spec.ts`
- Modify: `apps/api/test/esign.spec.ts`

- [ ] **Step 1: Write regression tests first**

Add positive assertions that:

- Admin final-plan approval passes the approved vehicle's plate and application number;
- Stage 1 contract creation passes order number, order model snapshot and vehicle plate;
- Stage 1 contract completion passes initial bill summary and order vehicle plate for `PAYMENT_PENDING`;
- Stage 2/Stage 3 signing branches still do not emit the Stage 1 payment notification.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/application-review-api.spec.ts test/esign.spec.ts
```

- [ ] **Step 3: Extend the safe notification helpers**

Allow each private `safeNotifyCustomer` helper to merge an optional sanitized semantic-data object with `aggregateNo` and `status`. Preserve the catch boundary so a notification failure never rolls back Application or e-sign domain facts.

- [ ] **Step 4: Pass the authoritative facts**

Use objects already loaded by `applicationInclude`/`esignTaskInclude`; extend the e-sign order include only for filtered initial bills needed by payment mapping. Do not issue per-record loops or use product display text in place of `modelDisplayNameSnapshot`.

- [ ] **Step 5: Run GREEN verification and commit**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/application-review-api.spec.ts test/esign.spec.ts
pnpm --filter @subscription-saas/api typecheck
git diff --check
git add apps/api/src/customer/customer.service.ts apps/api/src/esign/esign.service.ts apps/api/test/application-review-api.spec.ts apps/api/test/esign.spec.ts
git commit -m "fix: retain standard wechat notification facts"
```

### Task 5: Clear the release guard without changing UI

**Files:**

- Modify: `apps/web/src/components/vehicle-workspace/vehicle-workspace-header.tsx`

- [ ] **Step 1: Apply the mechanical rename**

Rename only the local computed display variable:

```ts
vehicleModel -> vehicleDisplayName
```

Do not change JSX structure, text composition, props, routing or styling.

- [ ] **Step 2: Verify the targeted guard and Web build**

```powershell
node scripts/check-vehicle-model-no-compatibility.mjs
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web build
git diff --check
```

- [ ] **Step 3: Commit**

```powershell
git add apps/web/src/components/vehicle-workspace/vehicle-workspace-header.tsx
git commit -m "chore: rename vehicle header display variable"
```

### Task 6: Full verification, review, and integration

**Files:** Only fixes required by failing verification; no scope expansion.

- [ ] **Step 1: Run the complete local gate**

```powershell
node --test scripts/stage1-golden-path-production-preflight.test.mjs scripts/wechat-official-account-smoke.test.mjs
pnpm --filter @subscription-saas/api exec vitest run test/wechat-template-data.spec.ts test/notification.spec.ts test/subscription-journey-notification.spec.ts test/application-review-api.spec.ts test/esign.spec.ts
pnpm prisma:validate
pnpm prisma:migrate:status
pnpm release:check
git diff --check
git status --short
```

Expected: all commands pass; migration count remains 88; no new migration; clean tree.

- [ ] **Step 2: Security and contract self-review**

Review the complete diff and verify:

- no real template IDs or secrets are present;
- Provider receives exact keys only;
- notification audit payload has no OpenID/prepay/sign URL/raw provider data;
- handover has no fallback;
- payment aggregation excludes cancelled/deleted/later-period bills;
- no API, DB or UI behavior beyond the approved scope changed.

- [ ] **Step 3: Push, open PR, and wait for CI**

```powershell
git push -u origin fix/stage1-golden-path-provider-readiness-20260810
```

Use the GitHub publishing workflow/skill to create a PR titled `fix: ready stage1 golden path providers`, then run `gh pr checks --watch` from the branch. Merge only after all checks pass and the final diff matches this plan.

### Task 7: Controlled Staging config and 1:1 image deployment

**Files on server:** `/opt/subscription-saas/.env.staging.images` only; never commit it.

- [ ] **Step 1: Merge and build from the merged `main` commit**

Create a clean release worktree at updated `origin/main`. Derive one tag for both images:

```powershell
$releaseSha = git rev-parse --short=7 HEAD
$releaseTag = "Staging-20260810-$releaseSha"
docker build -f Dockerfile.api -t "ghcr.io/keqi119/subscription-api:$releaseTag" .
docker build -f Dockerfile.web -t "ghcr.io/keqi119/subscription-web:$releaseTag" .
docker push "ghcr.io/keqi119/subscription-api:$releaseTag"
docker push "ghcr.io/keqi119/subscription-web:$releaseTag"
```

- [ ] **Step 2: Back up and update the controlled server config**

On Staging, verify the resolved target is `/opt/subscription-saas/.env.staging.images`, create a timestamped mode-`600` backup, write the real `WECHAT_TEMPLATE_HANDOVER_PENDING`, and update both image variables to the same release tag. Do not print the template value. Keep `SUBSCRIPTION_JOURNEY_ENABLED=false`.

- [ ] **Step 3: Validate config, pull, migrate, and recreate**

```bash
cd /opt/subscription-saas
docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images config -q
docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images pull api web
docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images run --rm --no-deps api pnpm --filter @subscription-saas/api prisma:migrate:deploy
docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images run --rm --no-deps api pnpm --filter @subscription-saas/api prisma:migrate:status
docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images up -d --no-deps --force-recreate api web
docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images ps
```

- [ ] **Step 4: Prove 1:1 image alignment**

Compare each container's configured image reference, running image ID and pulled digest with the two published images. Reject containers whose writable layer contains copied application code or whose configured image differs from the declared tag. Both services must be healthy and use the same `Staging-20260810-<sha>` suffix.

### Task 8: Real provider gates and Golden Path resumption

**Files:** No repository changes. Store only masked acceptance evidence.

- [ ] **Step 1: Read-only verify all five official templates**

Using the official WeChat list API from the controlled Staging container, match configured IDs to titles and exact field sets. Record only title, field names and a SHA-256/masked ID.

- [ ] **Step 2: Run five single-OpenID real smokes**

For each type, set an explicit exact `WECHAT_OA_TEMPLATE_DATA_JSON` and send to the one approved OpenID:

```text
APPLICATION_PROGRESS
FINAL_PLAN_PENDING
CONTRACT_PENDING
PAYMENT_PENDING
HANDOVER_PENDING
```

All must return success and record a provider message ID. Confirm the application constants `已受理` and `车辆订阅` are accepted. Do not expose IDs or message content outside masked evidence.

- [ ] **Step 3: Establish the dedicated Fadada acceptance binding**

Create a dedicated non-operational local customer through the existing customer entry. Use the existing production onboarding UI/API to register, real-name, bind certificate and refresh readiness for the approved signer. If the provider requires an interactive identity action, pause and ask the user to complete only that action. Never directly update Provider Customer ID or reuse a sandbox binding.

- [ ] **Step 4: Run read-only/preflight gates with Journey still off**

Run the Fadada signer/readiness and upload/sign-URL preflight commands with masked output. Run `stage1:golden-path:preflight` against a controlled copy of the environment that models `SUBSCRIPTION_JOURNEY_ENABLED=true`; do not change the live flag yet.

- [ ] **Step 5: Enable the exact allowlist and resume acceptance**

After all gates pass, back up the controlled env again, set only the approved local customer/Application allowlist, enable worker and Journey, recreate API, and verify health. Execute A line first with a new `SELF_SERVICE` Application, then B line with a different new `SALES_ASSISTED` Application. Stop for the user's Portal confirmation, Fadada signing, JSAPI payment and final human acceptance actions as required by the existing runbook.

- [ ] **Step 6: Close out safely**

After A/B evidence is complete, disable Journey enrollment, clear temporary allowlists, retain worker state long enough to finish or quarantine existing jobs, and preserve masked notification, Fadada, payment, handover and database evidence. Notify the user with the exact manual acceptance entry point and remaining actions.
