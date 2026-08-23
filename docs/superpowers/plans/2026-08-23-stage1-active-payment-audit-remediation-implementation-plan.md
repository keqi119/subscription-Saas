# Stage 1 Active Payment Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the active-payment callback security gap, restore a truthful release gate, stabilize the recovery journey database-time boundary, and remove residual auto-debit mutation seams without changing historical facts.

**Architecture:** Add one strict payment runtime policy shared by provider construction and callback processing. Bind every callback to both the configured adapter and the persisted payment-order provider, keep Mock callbacks explicitly non-production, make CI execute the same release checks used locally, and enforce retired auto-debit policy at internal service boundaries as well as controllers and workers.

**Tech Stack:** NestJS 11, Prisma 7/PostgreSQL, TypeScript 6, Vitest 4, Next.js 16, Node.js test runner, pnpm workspace, GitHub Actions.

**Spec:** `docs/superpowers/plans/2026-08-18-stage1-active-payment-baseline-implementation-plan.md`

## Global Constraints

- Stage 1 collection mode remains exactly `ACTIVE_PAYMENT_ONLY`.
- Production active payment is exactly WeChat JSAPI: `PAYMENT_PROVIDER=wechat_pay`, `PAYMENT_MOCK_ENABLED=false`, `PAYMENT_DEFAULT_CHANNEL=WECHAT_JSAPI`, `WECHAT_PAY_ENABLED=true`.
- Missing or unknown production payment configuration must prevent application startup.
- A callback may mutate only an order whose provider matches both the route provider and the configured provider adapter.
- Mock callback and mock-pay paths must be unavailable when Mock payment is disabled and must never be available in Production.
- Preserve all historical mandates, debit attempts, payment orders, payment records, write-offs, completed jobs, dead-letter jobs, enums, and migrations.
- Do not add a Prisma migration and do not run `prisma migrate reset` or `prisma db push`.
- Every production behavior change follows RED-GREEN-REFACTOR and is verified independently.
- Work only in `fix/stage1-active-payment-audit-remediation-20260823`; preserve the dirty main checkout.
- The main agent executes every task directly; do not dispatch subagents.

---

### Task 0: Record and verify the repair baseline

**Files:**
- Read: `AGENTS.md`
- Read: `DEV_SPEC.md`
- Read: `docs/superpowers/plans/2026-08-18-stage1-active-payment-baseline-implementation-plan.md`

**Interfaces:**
- Consumes: `origin/main@88b3abeb9fdcd4fd06e5d58a051f06c57314ac55`
- Produces: clean isolated branch and database preflight evidence

- [x] **Step 1:** Create the isolated worktree from `origin/main`.
- [x] **Step 2:** Install dependencies with `pnpm install --frozen-lockfile --offline`.
- [x] **Step 3:** Run `git status --short`, Prisma migration status, and `pnpm prisma:validate`.

### Task 1: Make payment runtime configuration fail closed

**Files:**
- Create: `apps/api/src/payment/payment-runtime.config.ts`
- Modify: `apps/api/src/payment/payment.module.ts`
- Test: `apps/api/test/payment-runtime-config.spec.ts`

**Interfaces:**
- Produces: `readPaymentRuntimeConfig(environment)` returning canonical provider, mock flag, default channel, WeChat enabled flag, and environment
- Produces: `PaymentRuntimeConfig` with provider limited to `mock | wechat_pay`

- [x] **Step 1: Write failing configuration tests**

  Cover Production with missing/unknown provider, enabled Mock, non-JSAPI default channel, or disabled WeChat; each must throw a stable `PAYMENT_RUNTIME_*` code. Cover the valid Production tuple and the explicit non-production Mock tuple.

- [x] **Step 2: Verify RED**

  Run `pnpm --filter @subscription-saas/api exec vitest run test/payment-runtime-config.spec.ts` and confirm failure because `readPaymentRuntimeConfig` does not exist.

- [x] **Step 3: Implement the strict parser and provider factory integration**

  `PaymentModule` must call the parser before constructing an adapter. Unknown providers never fall through to Mock. Production accepts only the exact canonical provider `wechat_pay`; non-production Mock requires `PAYMENT_MOCK_ENABLED=true` and `PAYMENT_DEFAULT_CHANNEL=MOCK`.

- [x] **Step 4: Verify GREEN**

  Run the configuration test and `test/portal-payment.spec.ts`.

### Task 2: Bind callbacks to configured and persisted providers

**Files:**
- Modify: `apps/api/src/payment/payment-order.service.ts`
- Modify: `apps/api/src/payment/payment.controller.ts`
- Test: `apps/api/test/portal-payment.spec.ts`

**Interfaces:**
- Consumes: `readPaymentRuntimeConfig`
- Produces: callback rejection before provider verification when route provider differs from configured provider
- Produces: provider-scoped payment-order lookup

- [x] **Step 1: Write failing callback security tests**

  Add cases proving that route/config mismatch does not call the adapter, Mock callback is rejected while Mock is disabled, unknown/missing paid events do not settle a bill, and a verified callback cannot select an order owned by another provider.

- [x] **Step 2: Verify RED**

  Run only the new `portal-payment.spec.ts` cases and confirm current code settles or verifies at least one forbidden path.

- [x] **Step 3: Implement minimal callback guards**

  Parse the route provider canonically, compare it to runtime configuration before invoking `verifyCallback`, require an explicit paid event, and add `provider` to every provider-reference lookup. Keep the `paymentOrderNo` race fallback only inside the matching provider predicate.

- [x] **Step 4: Verify GREEN**

  Run the full `portal-payment.spec.ts` and payment runtime configuration tests.

### Task 3: Restore the release guard and make CI truthful

**Files:**
- Modify: `apps/web/src/lib/subscription-journey-view-model.ts`
- Modify: `.github/workflows/ci.yml`
- Test: `scripts/check-vehicle-model-no-compatibility.test.mjs`

**Interfaces:**
- Produces: journey vehicle display derived only from canonical snapshot fields
- Produces: CI steps for Web tests and `pnpm release:check`

- [ ] **Step 1: Record existing RED release check**

  Run `pnpm release:check` and confirm `VEHICLE_MODEL_COMPATIBILITY_IDENTIFIER` at the journey view model.

- [ ] **Step 2: Remove the forbidden compatibility read**

  Keep `modelDisplayNameSnapshot`, `model`, and `series`; remove only `vehicleModel`.

- [ ] **Step 3: Verify the release guard is GREEN**

  Run `pnpm release:check`.

- [ ] **Step 4: Extend CI coverage**

  Add `pnpm --filter @subscription-saas/web test` after Web typecheck and `pnpm release:check` after API tests. Preserve the existing PostgreSQL service and API gate.

- [ ] **Step 5: Execute both added CI commands locally**

  Run Web tests and release check from the repository root.

### Task 4: Stabilize recovery event timestamps at the database boundary

**Files:**
- Modify: `apps/api/test/subscription-expiry-return.integration.spec.ts`
- Modify only if a failing production regression proves it necessary: `apps/api/src/asset-operations/asset-operations.repository.ts`
- Test: `apps/api/test/asset-operations.repository.integration.spec.ts`

**Interfaces:**
- Consumes: PostgreSQL transaction time
- Produces: recovery journey timestamps that are demonstrably not later than the database event recording boundary

- [x] **Step 1: Add failure diagnostics and a deterministic regression**

  Exercise the final asset-event insert with database-derived time and assert the stored `occurredAt <= recordedAt` invariant. For the Task 9 B fixture, derive command timestamps from database time instead of incrementing an application-side timestamp without checking the next transaction boundary.

- [x] **Step 2: Verify the regression fails or reproduces the unsafe fixture boundary**

  Run the exact asset-operations regression and Task 9 B test. If production repository behavior already satisfies the invariant, retain the fix in the fixture only; do not refactor production code without a failing production test.

- [x] **Step 3: Apply the smallest proven fix**

  Prefer database-derived fixture timestamps. Only if the repository regression fails, validate and persist one explicit database `recordedAt` value at the final `createEventRow` boundary.

- [x] **Step 4: Verify stability**

  Run Task 9 B repeatedly, then run the complete `subscription-expiry-return.integration.spec.ts` file.

### Task 5: Make retired auto-debit mutation impossible by injection

**Files:**
- Modify: `apps/api/src/auto-debit/auto-debit.policy.ts`
- Modify: `apps/api/src/auto-debit/auto-debit.admin.service.ts`
- Modify: `apps/api/src/auto-debit/auto-debit.module.ts`
- Modify: `apps/api/src/auto-debit/auto-debit.config.ts`
- Test: `apps/api/test/auto-debit-admin.spec.ts`
- Test: `apps/api/test/auto-debit-config.spec.ts`

**Interfaces:**
- Produces: one stable `AUTO_DEBIT_STAGE1_BASELINE_DISABLED` exception factory
- Produces: module exports limited to the no-op scheduler needed by billing automation

- [x] **Step 1: Rewrite mutation tests to expect fail-closed behavior**

  `queryAttempt`, `requestManualDebit`, `cancelJob`, and `setMockNextResult` must reject before any Prisma/provider/audit call. Retain historical list tests.

- [x] **Step 2: Verify RED**

  Run `test/auto-debit-admin.spec.ts` and confirm current mutation methods still write.

- [x] **Step 3: Add service guards and narrow module exports**

  Guard all four mutation methods at entry and stop exporting `AutoDebitAdminService`, `AutoDebitHandlers`, tokens, and `PaymentMandateService`; retain `AutoDebitScheduler` for `BillingAutomationService`.

- [x] **Step 4: Stabilize configuration error precedence**

  Add a failing test where `AUTO_DEBIT_ENABLED=true` and runtime time is malformed; it must report baseline-disabled before validating the historical run time. Move time validation after enabled/provider/mock checks.

- [x] **Step 5: Verify GREEN**

  Run all auto-debit configuration, controller, provider, scheduler, admin, and baseline tests.

### Task 6: Validate production compose values, not just key presence

**Files:**
- Modify: `scripts/stage1-golden-path-production-preflight.mjs`
- Modify: `scripts/stage1-golden-path-production-preflight.test.mjs`

**Interfaces:**
- Produces: `validateProductionComposeGoldenPathConfig(text)` returning stable blockers for unsafe literal/default expressions

- [x] **Step 1: Write failing compose-value tests**

  Inline compose fixtures must reject `AUTO_DEBIT_ENABLED: true`, a Mock mandate provider, enabled mandate Mock, active-payment Mock, or unsafe interpolation defaults, even when every key exists.

- [x] **Step 2: Verify RED**

  Run `pnpm stage1:golden-path:preflight:test` and confirm dangerous values are not detected.

- [x] **Step 3: Implement exact value/default validation**

  Validate the API environment entries for disabled delegated debit and safe Production WeChat active payment. Avoid adding a YAML dependency; accept quoted literals and the approved `${KEY:-safe_default}` expressions only.

- [x] **Step 4: Verify GREEN**

  Run preflight tests and `node scripts/stage1-golden-path-production-preflight.mjs --check-examples`.

### Task 7: Remove misleading retired-path tests and copy

**Files:**
- Modify: `apps/api/test/billing-automation-worker.spec.ts`
- Modify: `apps/web/src/app/billing/monthly-rent/page.tsx`
- Modify: `apps/web/src/constants/labels.ts`
- Test: `apps/api/test/billing-automation-worker.spec.ts`
- Test: `apps/web/test/auto-debit-admin-ui.spec.tsx`

**Interfaces:**
- Produces: retry behavior tested with a supported billing job
- Produces: read-only historical wording for retained permissions and UI

- [ ] **Step 1: Change the worker retry fixture**

  Use a supported due/overdue notification job and a generic retryable billing error; no test may present `QUERY_DEBIT_ATTEMPT` as worker-supported.

- [ ] **Step 2: Change read-only copy**

  Rename `刷新自动扣款` to `刷新历史记录`; describe retained auto-debit permissions as historical query/audit permissions without suggesting execution, retry, sync, pause, or revoke.

- [ ] **Step 3: Run API worker and Web admin UI tests**

  Confirm both suites pass and the historical panel exposes no mutation controls.

### Task 8: Complete verification and integration handoff

**Files:**
- Verify all modified files

**Interfaces:**
- Produces: fresh local evidence suitable for PR and main integration

- [ ] **Step 1:** Run focused Stage 1 retirement, preflight, payment, worker, recovery, release, and Web UI tests.
- [ ] **Step 2:** Run Prisma validate/generate and migration status.
- [ ] **Step 3:** Run full lint, API/Web typecheck, Shared/Web/API full tests, and `pnpm release:check`.
- [ ] **Step 4:** Run retirement database dry-run and confirm zero executable retired jobs.
- [ ] **Step 5:** Inspect `git diff --check`, status, and the complete diff against `origin/main`.
- [ ] **Step 6:** Commit reviewable batches, perform two direct main-agent self-review passes, push, open PR, and merge only after PR and main CI are green.
