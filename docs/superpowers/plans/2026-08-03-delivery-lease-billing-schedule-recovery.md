# Delivery Lease And Billing Schedule Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make delivery confirmation atomically activate the order, vehicle and Lease, initialize recurring billing, and recover already-delivered orders that missed Lease/BillingSchedule creation.

**Architecture:** A transaction-local Lease persistence helper owns the idempotent Lease transition and is reused by both delivery confirmation and the existing Lease activation engine. Billing reconciliation scans authoritative delivered `ACTIVE` orders, repairs missing/inactive Lease rows, creates the correctly based BillingSchedule, and reports the repair in preview/apply results. The manual monthly-rent fallback uses the same D-3 generation boundary as automation.

**Tech Stack:** TypeScript 6, NestJS 11, Prisma 7/PostgreSQL, Vitest 4, Next.js 16, React 19, Ant Design 6, pnpm 11.

## Global Constraints

- Order, Vehicle, Lease and BillingSchedule activation facts must commit in one database transaction.
- All repair operations must be idempotent and preserve existing legal, payment, billing and audit facts.
- `actualDeliveryAt` is the recurring billing anchor and all business dates use `Asia/Shanghai`.
- No schema migration is required; existing `lease` and `billing_schedule` tables remain authoritative.
- Existing valid recurring bills must be used as the reconciliation baseline and must never be duplicated.
- Production code is written only after the corresponding test is observed failing.

---

### Task 1: Atomic delivery activation

**Files:**
- Create: `apps/api/src/lease/lease-activation.persistence.ts`
- Modify: `apps/api/src/lease/lease-activation.engine.ts`
- Modify: `apps/api/src/order/order.module.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Test: `apps/api/test/order-delivery.spec.ts`
- Test: `apps/api/test/lease-activation.spec.ts`

**Interfaces:**
- Produces: `activateLeaseRecord(tx, { orderId, activatedAt, actorId })` returning `{ existing, lease }`.
- Consumes: `BillingAutomationService.ensureActiveSchedule(tx, orderId, activatedAt)`.

- [x] **Step 1: Add a failing delivery test**

After `confirmDelivery`, assert literal facts: order `ACTIVE`, vehicle `LEASED`, Lease `ACTIVE` with the submitted delivery timestamp, and one `ACTIVE` BillingSchedule for `2026-07-10` generated at `2026-07-07`.

- [x] **Step 2: Run RED**

```powershell
pnpm --filter @subscription-saas/api test -- order-delivery.spec.ts
```

Expected: FAIL because delivery confirmation currently creates neither Lease nor BillingSchedule.

- [x] **Step 3: Implement the shared transaction-local activation**

Update or restore the unique Lease row, clear `deletedAt`, set `activatedAt/status/updatedBy`, then initialize BillingSchedule inside the existing delivery transaction. Reuse the same helper from `LeaseActivationEngine.activate`.

- [x] **Step 4: Run GREEN**

```powershell
pnpm --filter @subscription-saas/api test -- order-delivery.spec.ts lease-activation.spec.ts
```

Expected: PASS, including repeated activation retaining one Lease and one schedule.

---

### Task 2: Delivered-order reconciliation and explainability

**Files:**
- Modify: `apps/api/src/billing-automation/billing-automation.service.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.admin.service.ts`
- Modify: `apps/web/src/app/billing/monthly-rent/page.tsx`
- Test: `apps/api/test/billing-automation-service.spec.ts`
- Test: `apps/api/test/billing-automation-controller.spec.ts`

**Interfaces:**
- Reconciliation item adds `leaseAction: "NONE" | "WOULD_ACTIVATE" | "ACTIVATED"` and `leaseStatus: LeaseStatus | null`.
- Reconciliation includes delivered `ACTIVE` orders even when Lease is missing or inactive.

- [x] **Step 1: Add failing reconciliation tests**

Assert dry-run reports `WOULD_ACTIVATE` without writes; apply creates/restores Lease and creates one schedule from the existing-bill-aware baseline; replay returns `EXISTING/NONE` without duplicates.

- [x] **Step 2: Run RED**

```powershell
pnpm --filter @subscription-saas/api test -- billing-automation-service.spec.ts billing-automation-controller.spec.ts
```

Expected: FAIL because the current query filters missing Lease rows before reporting them.

- [x] **Step 3: Implement recovery and UI reporting**

Remove the Lease predicate from the candidate query, include Lease state, repair Lease and schedule in one transaction, create a system audit entry, and display the Lease repair result in preview/apply tables.

- [x] **Step 4: Run GREEN**

```powershell
pnpm --filter @subscription-saas/api test -- billing-automation-service.spec.ts billing-automation-controller.spec.ts
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
```

Expected: PASS and the workbench visibly explains which orders will be repaired.

---

### Task 3: D-3 emergency fallback parity

**Files:**
- Modify: `apps/api/src/finance/finance.service.ts`
- Test: `apps/api/test/finance-billing.spec.ts`

**Interfaces:**
- Manual batch generation treats `periodStart - 3 days` as the earliest allowed billing date.

- [x] **Step 1: Add a failing D-3 test**

For delivery `2026-08-02`, assert a dry-run dated `2026-08-30` returns `DRY_RUN_GENERATE` for the `2026-09-02` to `2026-10-01` cycle, while `2026-08-29` still returns `DRY_RUN_SKIP`.

- [x] **Step 2: Run RED**

```powershell
pnpm --filter @subscription-saas/api test -- finance-billing.spec.ts
```

Expected: FAIL because the current fallback waits until `periodStart`.

- [x] **Step 3: Implement the D-3 boundary and run GREEN**

Use a local calendar-day subtraction helper and preserve existing same-period idempotency.

```powershell
pnpm --filter @subscription-saas/api test -- finance-billing.spec.ts
```

Expected: PASS.

---

### Task 4: Verification and staging recovery handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-07-31-stage1b-billing-automation-acceptance.md`

**Interfaces:**
- Documents deployment, reconciliation preview/apply, and acceptance evidence for the three affected staging orders.

- [x] **Step 1: Run focused and full quality gates**

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
git diff --check
```

Expected: all commands PASS and the isolated database reports all 76 migrations applied.

- [x] **Step 2: Record staging recovery procedure**

After deployment, run “协调预览”, verify the three delivered orders show `WOULD_ACTIVATE`, then run “执行协调”; verify Lease and BillingSchedule become `ACTIVE`, next period/generation dates match delivery anchors, and replay creates no duplicates.
