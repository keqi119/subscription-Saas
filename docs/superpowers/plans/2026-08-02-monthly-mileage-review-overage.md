# Monthly Mileage Review and Overage Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate monthly mileage-review tasks from the actual delivery anniversary, collect dashboard evidence through Portal or admin, settle mileage allowance, update the vehicle ledger, and create a separate over-mileage bill without ever blocking fixed monthly rent.

**Architecture:** Add a `MileageReviewModule` with pure calendar/calculation functions, a transactional review service, admin and Portal controllers, and a polling lifecycle worker. Review confirmation writes entitlement usage, mileage ledger, vehicle projection, optional `OVER_MILEAGE` bill, and the next review atomically. The existing billing automation remains independent and receives regression tests proving pending/overdue mileage reviews do not affect `MONTHLY_RENT` generation.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, Vitest, Next.js App Router, React, Ant Design, existing private object storage and notification infrastructure.

## Global Constraints

- Review periods use actual delivery time in `Asia/Shanghai`, monthly anniversary with month-end clamping.
- A review needs at least one readable image evidence file for both Portal and admin submissions.
- Missing/late customer submission creates no estimate, entitlement usage, vehicle update, or overage bill.
- Pending, returned, overdue, or unconfirmed review state must not pause, skip, or alter `MONTHLY_RENT` schedule generation.
- Prior cycles must be confirmed before a later cycle can be confirmed.
- Overage is a separate `OVER_MILEAGE` receivable bill due five natural days after confirmation.
- Void/reopen is permitted only for the latest confirmed review, with no later confirmed cycle and no paid overage bill.
- GPS, OCR, and telematics validation are not implemented; evidence metadata reserves those fields.
- Use TDD and idempotency keys/unique constraints for every confirming or scheduled side effect.

---

### Task 1: Add review, evidence, overage, and notification schema

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260802130000_monthly_mileage_reviews/migration.sql`
- Create: `apps/api/test/mileage-review-schema.spec.ts`

**Interfaces:**
- Add enums `OrderMileageReviewStatus`, `MileageReviewSubmissionSource`; extend `BillType` with `OVER_MILEAGE`.
- Add `OrderMileageReview` and `OrderMileageReviewEvidence` models and relations to order, vehicle, readings, files, grants, usages, bills, customer/user actors.
- Add optimistic `lockVersion Int @default(0)` and unique `(orderId, cycleNo, version)`.
- Add a partial unique SQL index allowing only one non-voided version per order/cycle.

- [x] **Step 1: Write failing schema tests**

Assert model fields, relations, enum values, overage bill enum, source uniqueness, evidence indexes, and the partial unique migration index.

- [x] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/api test -- mileage-review-schema.spec.ts`

- [x] **Step 3: Implement schema and migration**

Persist `periodStart`, `periodEnd`, `scheduledReviewAt`, `dueAt`, `readingAt`, submitted/reviewed/void timestamps as `Timestamptz(6)`; monetary values as `BigInt`; snapshots and metadata as JSON. Evidence has soft-delete fields and FK to `FileObject`.

- [x] **Step 4: Validate and commit**

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api test -- mileage-review-schema.spec.ts
git add apps/api/prisma apps/api/test/mileage-review-schema.spec.ts
git commit -m "feat: add monthly mileage review schema"
```

### Task 2: Implement the Shanghai anniversary calendar and settlement calculator

**Files:**
- Create: `apps/api/src/mileage-review/mileage-review.calendar.ts`
- Create: `apps/api/src/mileage-review/mileage-review.calculator.ts`
- Create: `apps/api/test/mileage-review-calendar.spec.ts`
- Create: `apps/api/test/mileage-review-calculator.spec.ts`

**Interfaces:**

```ts
export function buildMileageReviewCycle(input: {
  actualDeliveryAt: Date;
  cycleNo: number;
}): { periodStart: Date; periodEnd: Date; scheduledReviewAt: Date; dueAt: Date };

export function calculateMileageSettlement(input: {
  baselineMileageKm: number;
  submittedMileageKm: number;
  allowanceKm: number;
  overMileageFeeAmount: bigint;
}): MileageSettlement;
```

- [x] **Step 1: Write failing calendar/calculation tests**

Cover Jan 29/30/31, Feb leap/non-leap, Aug 31 to Sep 30 and Oct 31, UTC-to-Shanghai date boundary, period-end semantics, 24-hour due window, zero usage, within allowance, exact allowance, and overage amount in cents.

- [x] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/api test -- mileage-review-calendar.spec.ts mileage-review-calculator.spec.ts`

- [x] **Step 3: Implement pure functions**

Anchor each cycle directly to the original delivery local date, not the prior clamped date. Reject unsafe integers, negative values, and mileage regression. Use `bigint` for money.

- [x] **Step 4: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api test -- mileage-review-calendar.spec.ts mileage-review-calculator.spec.ts
git add apps/api/src/mileage-review apps/api/test/mileage-review-calendar.spec.ts apps/api/test/mileage-review-calculator.spec.ts
git commit -m "feat: calculate monthly mileage review cycles"
```

### Task 3: Create review lifecycle and first task at delivery

**Files:**
- Create: `apps/api/src/mileage-review/mileage-review.module.ts`
- Create: `apps/api/src/mileage-review/mileage-review.service.ts`
- Create: `apps/api/src/mileage-review/mileage-review.repository.ts`
- Create: `apps/api/src/mileage-review/mileage-review.types.ts`
- Create: `apps/api/test/mileage-review-lifecycle.spec.ts`
- Modify: `apps/api/src/order/order.module.ts`
- Modify: `apps/api/src/order/order.service.ts`

**Interfaces:**
- `createFirstReview(tx, { orderId, vehicleId, deliveryReadingId, actualDeliveryAt, actorId })` creates cycle 1 as `SCHEDULED` idempotently.
- `activateDueReviews(asOf)` moves due tasks to `PENDING_SUBMISSION` and sets no business estimates.
- `deriveOverdue` is response-time logic: pending submission plus `now > dueAt`.

- [x] **Step 1: Write failing lifecycle tests**

Assert first cycle creation in the delivery transaction, duplicate delivery retry idempotency, due activation, overdue derivation, and no mutation before scheduled time.

- [x] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/api test -- mileage-review-lifecycle.spec.ts order-delivery.spec.ts`

- [x] **Step 3: Implement repository and service**

Use source reading as baseline, store cycle snapshot, and create the review in the same delivery transaction. Delivery confirmation must roll back if review creation fails.

- [x] **Step 4: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api test -- mileage-review-lifecycle.spec.ts order-delivery.spec.ts
git add apps/api/src/mileage-review apps/api/src/order apps/api/test/mileage-review-lifecycle.spec.ts apps/api/test/order-delivery.spec.ts
git commit -m "feat: start mileage reviews from delivery"
```

### Task 4: Add admin review APIs, evidence validation, and permissions

**Files:**
- Create: `apps/api/src/mileage-review/mileage-review.controller.ts`
- Create: `apps/api/src/mileage-review/dto/mileage-review.dto.ts`
- Modify: `apps/api/src/mileage-review/mileage-review.service.ts`
- Modify: `packages/shared/src/auth.ts`
- Modify: `packages/shared/src/menus.ts`
- Modify: `apps/api/prisma/seed.mjs`
- Create: `apps/api/test/mileage-review-admin-api.spec.ts`

**Interfaces:**
- `GET /mileage-reviews` and `GET /orders/:orderId/mileage-reviews`
- `GET /mileage-reviews/:id`
- `PUT /mileage-reviews/:id/admin-draft`
- `POST /mileage-reviews/:id/evidence`
- `DELETE /mileage-reviews/:id/evidence/:evidenceId`
- `POST /mileage-reviews/:id/submit`
- `POST /mileage-reviews/:id/return`
- `POST /mileage-reviews/:id/confirm`
- `POST /mileage-reviews/:id/void-reopen`

- [x] **Step 1: Write failing permission and API tests**

Cover `mileage_review:view|submit|confirm|return|void`, status transitions, optimistic `lockVersion`, evidence ownership/readability/MIME checks, missing evidence rejection, and admin submission source.

- [x] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/api test -- mileage-review-admin-api.spec.ts`

- [x] **Step 3: Implement APIs and menu seed**

Add `/mileage-reviews` under the order center menu. Evidence attachment must accept only active private image `FileObject` rows and store safe metadata; API responses expose preview/download routes, never bucket/object keys.

- [x] **Step 4: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api test -- mileage-review-admin-api.spec.ts
git add apps/api/src/mileage-review packages/shared/src apps/api/prisma/seed.mjs apps/api/test/mileage-review-admin-api.spec.ts
git commit -m "feat: add admin mileage review workflow"
```

### Task 5: Add Portal ownership-guarded submission APIs

**Files:**
- Create: `apps/api/src/portal/portal-mileage-review.controller.ts`
- Create: `apps/api/src/portal/portal-mileage-review.service.ts`
- Create: `apps/api/src/portal/portal-mileage-review.dto.ts`
- Modify: `apps/api/src/portal/portal.module.ts`
- Modify: `apps/api/src/portal/portal-billing.service.ts`
- Create: `apps/api/test/portal-mileage-review.spec.ts`

**Interfaces:**
- `GET /portal/mileage-reviews`
- `GET /portal/mileage-reviews/:id`
- `PUT /portal/mileage-reviews/:id/draft`
- `POST /portal/mileage-reviews/:id/evidence`
- `DELETE /portal/mileage-reviews/:id/evidence/:evidenceId`
- `POST /portal/mileage-reviews/:id/submit`

- [ ] **Step 1: Write failing Portal security tests**

Cover own active order access, cross-customer 404, final-order history read-only behavior, at-least-one-image rule, regression rejection, post-submit edit rejection, returned resubmission, and safe file metadata.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/api test -- portal-mileage-review.spec.ts`

- [ ] **Step 3: Implement Portal service/controller**

Reuse shared review transition functions but enforce `currentCustomer.customerId` in every locator query. Extend Portal order detail with `mileageReviewSummary` and a `nextAction` pointing to the current review when due/returned.

- [ ] **Step 4: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api test -- portal-mileage-review.spec.ts portal-order-billing.spec.ts
git add apps/api/src/portal apps/api/test/portal-mileage-review.spec.ts apps/api/test/portal-order-billing.spec.ts
git commit -m "feat: let customers submit mileage reviews"
```

### Task 6: Confirm settlement atomically and issue the independent bill

**Files:**
- Create: `apps/api/src/mileage-review/mileage-review-settlement.service.ts`
- Modify: `apps/api/src/mileage-review/mileage-review.service.ts`
- Modify: `apps/api/src/vehicle-mileage/vehicle-mileage.service.ts`
- Modify: `apps/api/src/finance/finance.service.ts`
- Modify: `apps/api/test/mileage-review-admin-api.spec.ts`
- Create: `apps/api/test/mileage-review-settlement.spec.ts`
- Modify: `apps/api/test/finance-billing.spec.ts`

**Interfaces:**
- Confirm accepts `lockVersion` and `idempotencyKey`.
- Overage bill source key: `over-mileage:{reviewId}:v{version}`.
- Bill type: `OVER_MILEAGE`; due date: confirmation timestamp plus five natural days.

- [ ] **Step 1: Write failing settlement tests**

Cover entitlement grant lookup/backfill, allowance consumption, unused allowance expiry, zero-usage handling, overage calculation, bill uniqueness, five-day due date, mileage reading/projection update, residual marker, next-cycle creation, duplicate/concurrent confirmation, and full rollback on any failed write.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/api test -- mileage-review-settlement.spec.ts finance-billing.spec.ts`

- [ ] **Step 3: Implement one serializable confirmation transaction**

Lock the review, vehicle/latest reading, prior cycles, entitlement grant/usages, and source-key bill. Validate evidence and state, calculate, consume up to allowance, expire remainder, append `MONTHLY_REVIEW`, update review snapshot, create overage bill only when amount is positive, and create the next cycle. Never call the public over-consumption endpoint.

- [ ] **Step 4: Preserve fixed monthly rent independence**

Do not import `MileageReviewService` into `BillingAutomationModule` and do not add review predicates to billing schedules. The review settlement may create only `OVER_MILEAGE` bills.

- [ ] **Step 5: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api test -- mileage-review-settlement.spec.ts mileage-review-admin-api.spec.ts finance-billing.spec.ts
git add apps/api/src/mileage-review apps/api/src/vehicle-mileage apps/api/src/finance apps/api/test
git commit -m "feat: settle mileage and bill overage atomically"
```

### Task 7: Implement controlled void/reopen

**Files:**
- Modify: `apps/api/src/mileage-review/mileage-review.service.ts`
- Modify: `apps/api/src/mileage-review/mileage-review-settlement.service.ts`
- Create: `apps/api/test/mileage-review-void.spec.ts`

- [ ] **Step 1: Write failing rollback tests**

Cover latest-confirmed success, later confirmed-cycle refusal, paid/part-paid bill refusal, entitlement restoration, unpaid bill cancellation, reading void, projection restoration, replacement version creation, residual marker update, and atomic rollback.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/api test -- mileage-review-void.spec.ts`

- [ ] **Step 3: Implement the guarded transaction**

Lock the same records as confirmation. Mark usage cancelled/deleted according to existing ledger semantics, restore grant counters/status, cancel only unpaid overage bills, void the latest reading, restore the preceding active reading projection, mark review `VOIDED`, and create version `n+1` for the same cycle with the original baseline.

- [ ] **Step 4: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api test -- mileage-review-void.spec.ts mileage-review-settlement.spec.ts
git add apps/api/src/mileage-review apps/api/test/mileage-review-void.spec.ts
git commit -m "feat: support controlled mileage review reopening"
```

### Task 8: Add activation/reminder worker and non-blocking notifications

**Files:**
- Create: `apps/api/src/mileage-review/mileage-review.worker.ts`
- Modify: `apps/api/src/mileage-review/mileage-review.module.ts`
- Modify: `apps/api/src/notification/notification.service.ts`
- Modify: `apps/api/prisma/seed.mjs`
- Modify: `.env.example`
- Modify: `.env.staging.example`
- Create: `apps/api/test/mileage-review-worker.spec.ts`
- Modify: `apps/api/test/notification.spec.ts`

- [ ] **Step 1: Write failing worker/notification tests**

Cover disabled worker, due activation, daily reminder idempotency, failed SMS/WeChat not rolling back review state, Portal in-app record creation, retry observability, and no duplicate reminder on repeated polls.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/api test -- mileage-review-worker.spec.ts notification.spec.ts`

- [ ] **Step 3: Implement polling and templates**

Add `MILEAGE_REVIEW_WORKER_ENABLED` and poll interval configuration. Reconcile due reviews and notifications in bounded batches. Use deterministic event/idempotency keys `mileage-review:{reviewId}:{event}:{localDate}`. Seed in-app templates; SMS/WeChat template codes remain environment/config driven and optional.

- [ ] **Step 4: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api test -- mileage-review-worker.spec.ts notification.spec.ts
git add apps/api/src/mileage-review apps/api/src/notification apps/api/prisma/seed.mjs .env.example .env.staging.example apps/api/test
git commit -m "feat: activate and remind mileage reviews"
```

### Task 9: Build admin and Portal mileage-review pages

**Files:**
- Create: `apps/web/src/app/mileage-reviews/page.tsx`
- Create: `apps/web/src/app/mileage-reviews/[id]/page.tsx`
- Create: `apps/web/src/app/portal/mileage-reviews/page.tsx`
- Create: `apps/web/src/app/portal/mileage-reviews/[id]/page.tsx`
- Create: `apps/web/src/lib/mileage-review-view-model.ts`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Modify: `apps/web/src/app/portal/orders/[id]/page.tsx`
- Modify: `apps/web/src/app/portal/page.tsx`
- Create: `apps/web/test/mileage-review-view-model.spec.ts`
- Create: `apps/web/test/mileage-review-ui.spec.ts`

- [ ] **Step 1: Write failing view-model and UI tests**

Cover status/color mapping, overdue derivation, admin queue ordering, draft/submit/return/confirm/void action availability, image-required validation, mobile card layout, Portal next-action guidance, confirmed calculation and bill link, and read-only history.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/web test -- mileage-review-view-model.spec.ts mileage-review-ui.spec.ts`

- [ ] **Step 3: Implement admin pages**

Queue filters: pending submission, overdue, pending review, confirmed, voided. Order by overdue priority then scheduled time. Detail shows baseline, evidence, submission, allowance preview, settlement, linked ledger/bill, audit actors, and permitted actions.

- [ ] **Step 4: Implement Portal pages and guidance**

Provide mobile-safe image upload, cumulative mileage input, review period and prior baseline. Continue the Portal home/order guidance until submission; after confirmation show actual usage, allowance, overage, and the independent bill payment/detail link.

- [ ] **Step 5: Run GREEN/typecheck and commit**

```powershell
pnpm --filter @subscription-saas/web test -- mileage-review-view-model.spec.ts mileage-review-ui.spec.ts
pnpm --filter @subscription-saas/web exec tsc --noEmit -p tsconfig.json
git add apps/web/src/app apps/web/src/lib/mileage-review-view-model.ts apps/web/test
git commit -m "feat: add mileage review workspaces"
```

### Task 10: Prove monthly rent independence and complete end-to-end verification

**Files:**
- Modify: `apps/api/test/billing-automation.integration.spec.ts`
- Modify: `apps/api/test/portal-order-billing.spec.ts`
- Create: `apps/api/test/mileage-review-e2e.spec.ts`
- Create: `docs/mileage-review-staging-acceptance.md`

- [ ] **Step 1: Add the fixed-rent non-blocking regression test**

Create active orders whose current review is respectively `PENDING_SUBMISSION`, overdue-by-time, `RETURNED`, and `PENDING_REVIEW`. Run billing reconciliation/generation past the next rent boundary and assert a `MONTHLY_RENT` bill is generated exactly once in every case.

- [ ] **Step 2: Add the complete review E2E test**

Exercise delivery baseline -> due activation -> Portal evidence/submission -> admin confirmation -> entitlement usage -> mileage ledger/projection -> overage bill -> next review, plus admin-entry and void/reopen variants.

- [ ] **Step 3: Run all quality gates**

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/api test -- mileage-review-schema.spec.ts mileage-review-calendar.spec.ts mileage-review-calculator.spec.ts mileage-review-lifecycle.spec.ts mileage-review-admin-api.spec.ts portal-mileage-review.spec.ts mileage-review-settlement.spec.ts mileage-review-void.spec.ts mileage-review-worker.spec.ts mileage-review-e2e.spec.ts billing-automation.integration.spec.ts finance-billing.spec.ts notification.spec.ts
pnpm --filter @subscription-saas/web test -- mileage-review-view-model.spec.ts mileage-review-ui.spec.ts
```

- [ ] **Step 4: Run database consistency checks**

Verify every vehicle projection equals its latest active reading; every confirmed review has an active `MONTHLY_REVIEW` reading; positive overage has one non-cancelled source-key bill; non-positive overage has none; and each active order/cycle has at most one non-voided version.

- [ ] **Step 5: Execute controlled Staging acceptance**

Use a synthetic active order and time-controlled worker run. Record delivery anchor, cycle boundaries, Portal/admin screenshots, evidence file, entitlement before/after, ledger row, vehicle projection, overage bill/due date, next rent bill, next review, notification events, and void guard results. Do not alter a real customer's mileage or bill.

- [ ] **Step 6: Commit verification artifacts**

```powershell
git add apps/api/test apps/web/test docs/mileage-review-staging-acceptance.md
git commit -m "test: verify monthly mileage review workflow"
```
