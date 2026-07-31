# Stage 1B-A Recurring Billing and Overdue Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically create recurring monthly-rent bills at D-3, notify customers, create collection cases at D+5, and cancel future work after settlement while retaining manual fallbacks.

**Architecture:** `BillingSchedule` owns the next billing cycle, while `SubscriptionAutomationJob` is a database-backed transactional outbox and execution queue. A dedicated Nest module owns calendar rules, schedule reconciliation, job leasing, handlers, Worker and admin recovery APIs; existing finance, payment, notification and lease services remain authoritative for their domain facts.

**Tech Stack:** TypeScript 6, NestJS 11, Prisma 7/PostgreSQL, Vitest 4, Next.js 16, React 19, Ant Design 6, pnpm 11.

## Global Constraints

- All money remains integer cents represented with `BigInt` in persistence and domain calculations.
- Business dates use `Asia/Shanghai`; PostgreSQL timestamps remain UTC.
- `ReceivableBill`, payments and write-offs remain the only authoritative customer-funds facts.
- Automatic work must be persistent, idempotent, retryable, auditable and manually recoverable.
- The Worker is disabled unless `BILLING_AUTOMATION_WORKER_ENABLED=true`.
- Manual monthly-rent generation and manual overdue refresh remain available as fallback operations.
- This plan does not implement `PaymentMandate`, `DebitAttempt`, real delegated debit, SMS integration or Stage 2 capital workflows.
- Existing migrations are immutable; add one new migration only.
- Every production behavior is introduced by a failing test first.

---

### Task 1: Billing calendar, schema and database idempotency

**Files:**
- Create: `apps/api/src/billing-automation/billing-automation.calendar.ts`
- Create: `apps/api/test/billing-automation-calendar.spec.ts`
- Create: `apps/api/test/billing-automation-schema.spec.ts`
- Create: `apps/api/prisma/migrations/20260731120000_stage1b_billing_automation/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`

**Interfaces:**
- Produces: `BillingCycle`, `buildInitialBillingCycle(actualDeliveryAt)`, `buildNextBillingCycle(current)`, `billingSourceKey(orderId, periodStart)`, `dueNoticeJobKey(billId)`, `overdueJobKey(billId, dueDate)`, and `overdueNoticeJobKey(billId)`.
- Produces Prisma models `BillingSchedule` and `SubscriptionAutomationJob`, plus enums `BillingScheduleStatus`, `SubscriptionAutomationJobType`, and `SubscriptionAutomationJobStatus`.

- [x] **Step 1: Write failing calendar tests**

```ts
expect(buildInitialBillingCycle(new Date("2026-01-31T03:00:00Z"))).toMatchObject({
  cycleNo: 1,
  periodStart: new Date("2026-02-28T00:00:00.000Z"),
  periodEnd: new Date("2026-03-30T00:00:00.000Z"),
  generateAt: new Date("2026-02-25T00:00:00.000Z")
});
expect(billingSourceKey("order-1", new Date("2026-02-28T00:00:00Z")))
  .toBe("monthly-rent:order-1:2026-02-28");
```

- [x] **Step 2: Run the calendar test and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api test -- billing-automation-calendar.spec.ts
```

Expected: FAIL because `billing-automation.calendar.ts` does not exist.

- [x] **Step 3: Implement the pure calendar and key functions**

Use UTC date-only values after converting the activation timestamp to a China business date. Clamp the day when moving to a shorter month. Derive `periodEnd` as one day before the following clamped boundary, `generateAt` as three days before `periodStart`, and the overdue date as five days after `dueDate`.

- [x] **Step 4: Run the calendar test and verify GREEN**

Run:

```bash
pnpm --filter @subscription-saas/api test -- billing-automation-calendar.spec.ts
```

Expected: PASS for normal dates, month-end clamping, leap year, D-3, D+5 and stable keys.

- [x] **Step 5: Write the failing schema contract test**

The test reads `schema.prisma` and asserts observable persistence contracts:

```ts
expect(schema).toContain("model BillingSchedule {");
expect(schema).toContain("orderId          String                @unique");
expect(schema).toContain("idempotencyKey   String");
expect(schema).toContain("sourceKey        String?           @unique");
```

- [x] **Step 6: Run the schema test and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api test -- billing-automation-schema.spec.ts
```

Expected: FAIL because the models and source key are absent.

- [x] **Step 7: Add Prisma schema and migration**

Add:

```prisma
enum BillingScheduleStatus {
  ACTIVE
  PAUSED
  COMPLETED
  CANCELLED
}

enum SubscriptionAutomationJobType {
  GENERATE_MONTHLY_RENT_BILL
  SEND_BILL_DUE_NOTICE
  MARK_BILL_OVERDUE
  SEND_BILL_OVERDUE_NOTICE
}

enum SubscriptionAutomationJobStatus {
  PENDING
  PROCESSING
  COMPLETED
  DEAD_LETTER
  CANCELLED
}
```

`BillingSchedule` has unique `orderId`, next cycle and period fields, `nextGenerateAt`, last result fields, pause/completion fields and `version`. `SubscriptionAutomationJob` has optional schedule/order/bill relations, unique `idempotencyKey`, lease, retry, payload, result and error fields. Add nullable unique `ReceivableBill.sourceKey` and relations on `SubscriptionOrder`, `ReceivableBill`, and `BillingSchedule`.

- [x] **Step 8: Validate schema and migration**

Run:

```bash
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api test -- billing-automation-schema.spec.ts billing-automation-calendar.spec.ts
```

Expected: all commands PASS.

- [x] **Step 9: Commit Task 1**

```bash
git add apps/api/prisma apps/api/src/billing-automation/billing-automation.calendar.ts apps/api/test/billing-automation-calendar.spec.ts apps/api/test/billing-automation-schema.spec.ts
git commit -m "feat(billing): add recurring schedule persistence"
```

---

### Task 2: Durable automation job repository

**Files:**
- Create: `apps/api/src/billing-automation/billing-automation.types.ts`
- Create: `apps/api/src/billing-automation/billing-automation.repository.ts`
- Create: `apps/api/test/billing-automation-repository.spec.ts`

**Interfaces:**
- Consumes: Prisma `SubscriptionAutomationJob` and its status/type enums.
- Produces: `enqueue(tx, input)`, `claimDue(limit, leaseMs, supportedTypes)`, `complete(id, leaseToken, result)`, `reschedule(id, leaseToken, input)`, `deadLetter(id, leaseToken, error)`, `cancelPendingForBills(tx, billIds)`, `cancelPendingForSchedule(tx, scheduleId)`, and `retryDeadLetter(id)`.
- Produces: `BillingAutomationError` with `{ code, message, retryable }`.

- [ ] **Step 1: Write failing repository tests**

Cover:

```ts
await repository.enqueue(tx, {
  idempotencyKey: "monthly-rent:order-1:2026-08-10",
  jobType: SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
  orderId: "order-1",
  billingScheduleId: "schedule-1",
  availableAt: new Date("2026-08-07T00:00:00Z")
});
```

Assert duplicate enqueue returns the same row, concurrent claim uses `FOR UPDATE SKIP LOCKED`, completion requires the current lease, settlement cancellation affects only pending bill jobs, and retry reuses the same job/idempotency key.

- [ ] **Step 2: Run the repository test and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api test -- billing-automation-repository.spec.ts
```

Expected: FAIL because repository and types do not exist.

- [ ] **Step 3: Implement repository and types**

Mirror the proven Stage 2 lease pattern but target `subscription_automation_job`. Use database time for claiming and delayed availability. Sanitize persisted errors to fixed codes/messages and never persist raw provider or customer data.

- [ ] **Step 4: Run repository tests and verify GREEN**

Run:

```bash
pnpm --filter @subscription-saas/api test -- billing-automation-repository.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/api/src/billing-automation/billing-automation.repository.ts apps/api/src/billing-automation/billing-automation.types.ts apps/api/test/billing-automation-repository.spec.ts
git commit -m "feat(billing): add durable automation job repository"
```

---

### Task 3: Schedule reconciliation and finance-domain execution

**Files:**
- Create: `apps/api/src/billing-automation/billing-automation.service.ts`
- Create: `apps/api/src/billing-automation/billing-automation.handlers.ts`
- Create: `apps/api/test/billing-automation-service.spec.ts`
- Modify: `apps/api/src/finance/finance.service.ts`
- Modify: `apps/api/test/finance-billing.spec.ts`

**Interfaces:**
- Consumes: calendar functions and repository enqueue/cancel functions.
- Produces: `reconcileSchedules({ dryRun, now, actorId })`, `ensureActiveSchedule(tx, orderId, actualDeliveryAt)`, `enqueueDueSchedules(now)`, `generateScheduledMonthlyRent(job)`, `markScheduledBillOverdue(job)`, and `cancelSettledBillJobs(tx, billIds)`.
- Finance produces system-callable `generateMonthlyRentBillForCycle(tx, input)` and `markBillOverdue(tx, input)` methods shared by manual and automatic paths.

- [ ] **Step 1: Write failing service tests**

Cover the observable behaviors:

```ts
const first = await service.ensureActiveSchedule(tx, orderId, deliveredAt);
const second = await service.ensureActiveSchedule(tx, orderId, deliveredAt);
expect(second.id).toBe(first.id);

const result = await service.generateScheduledMonthlyRent(job);
expect(result.bill.sourceKey).toBe("monthly-rent:order-1:2026-08-10");
expect(result.nextSchedule.nextCycleNo).toBe(2);
```

Also assert: existing same-period bill is reconciled, missing price leaves schedule unchanged, bill/schedule/follow-up jobs are one transaction, paid/cancelled bills produce no overdue change, and repeated overdue handling keeps one active collection case link.

- [ ] **Step 2: Run service tests and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api test -- billing-automation-service.spec.ts
```

Expected: FAIL because the service and handlers do not exist.

- [ ] **Step 3: Extract shared finance-domain functions**

Move existing month-period bill creation and overdue case mutation behind transaction-aware methods. Keep current controller methods as adapters using the authenticated actor. Add `sourceKey` to both manual single/batch and automatic month-rent creation.

- [ ] **Step 4: Implement schedule reconciliation and handlers**

Rules:

- eligible order requires `OrderStatus.ACTIVE`, `LeaseStatus.ACTIVE`, actual delivery time, and no deleted facts;
- a paused schedule is never overwritten by reconciliation;
- generate job re-checks order and lease before mutation;
- bill creation, schedule advance and due/overdue job enqueue occur in one transaction;
- overdue handler re-checks bill status/remaining amount immediately before mutation;
- automatic audit entries use `operatorId = null` and include `actorType: "SYSTEM"` plus the job ID.

- [ ] **Step 5: Run service and finance tests and verify GREEN**

Run:

```bash
pnpm --filter @subscription-saas/api test -- billing-automation-service.spec.ts finance-billing.spec.ts
```

Expected: PASS, including all pre-existing finance tests.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/api/src/billing-automation apps/api/src/finance/finance.service.ts apps/api/test/billing-automation-service.spec.ts apps/api/test/finance-billing.spec.ts
git commit -m "feat(billing): automate recurring bills and overdue cases"
```

---

### Task 4: Idempotent notifications and Worker execution

**Files:**
- Create: `apps/api/src/billing-automation/billing-automation.worker.ts`
- Create: `apps/api/test/billing-automation-worker.spec.ts`
- Modify: `apps/api/src/notification/notification.service.ts`
- Modify: `apps/api/test/notification.spec.ts`

**Interfaces:**
- Consumes: repository claim/transition methods and handler dispatch.
- Produces: `BillingAutomationWorker.runOnce()` and idempotent `NotificationService.notifyBillLifecycle(input)`.
- `notifyBillLifecycle` consumes `{ billId, customerId, eventType, idempotencyKey, data }` and returns existing or newly created notification records.

- [ ] **Step 1: Write failing notification tests**

Invoke `notifyBillLifecycle` twice with `bill-due-notice:{billId}` and assert one logical Portal notification/event. Assert a retry after provider failure reuses the same notification identity.

- [ ] **Step 2: Run notification test and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api test -- notification.spec.ts
```

Expected: FAIL because `notifyBillLifecycle` is absent.

- [ ] **Step 3: Implement idempotent bill notifications**

Derive deterministic `notificationNo` values from the idempotency key. Reconcile the existing record on unique conflict. Do not let notification failure roll back bill or overdue facts.

- [ ] **Step 4: Write failing Worker tests**

Assert:

- disabled Worker never polls;
- enabled Worker claims only four supported billing job types;
- successful handler completes the leased job;
- retryable errors use 1m, 5m, 15m, 1h and 6h delays;
- deterministic errors enter dead letter immediately;
- sixth transient failure enters dead letter;
- logs and persisted errors exclude raw sensitive content;
- configured concurrency is respected.

- [ ] **Step 5: Run Worker tests and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api test -- billing-automation-worker.spec.ts
```

Expected: FAIL because the Worker does not exist.

- [ ] **Step 6: Implement Worker**

Use `BILLING_AUTOMATION_WORKER_ENABLED`, `BILLING_AUTOMATION_WORKER_CONCURRENCY`, `BILLING_AUTOMATION_WORKER_LEASE_MS`, and `BILLING_AUTOMATION_WORKER_POLL_INTERVAL_MS`. Before claiming jobs, enqueue due schedules and reconcile eligible active orders on a bounded cadence.

- [ ] **Step 7: Run notification and Worker tests and verify GREEN**

Run:

```bash
pnpm --filter @subscription-saas/api test -- notification.spec.ts billing-automation-worker.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add apps/api/src/billing-automation/billing-automation.worker.ts apps/api/src/notification/notification.service.ts apps/api/test/billing-automation-worker.spec.ts apps/api/test/notification.spec.ts
git commit -m "feat(billing): run idempotent billing automation jobs"
```

---

### Task 5: Lease activation and payment-settlement integration

**Files:**
- Modify: `apps/api/src/lease/lease-activation.engine.ts`
- Modify: `apps/api/src/lease/lease.module.ts`
- Modify: `apps/api/src/finance/finance.service.ts`
- Modify: `apps/api/test/lease-activation.spec.ts`
- Modify: `apps/api/test/finance-billing.spec.ts`

**Interfaces:**
- Consumes: `BillingAutomationService.ensureActiveSchedule` and `cancelSettledBillJobs`.
- Produces: activation creates/returns the lease and its billing schedule transactionally; all finance write-off paths cancel pending bill jobs when the bill becomes fully settled.

- [ ] **Step 1: Write failing lease activation test**

```ts
const lease = await engine.activate(orderId, user, context);
expect(lease.status).toBe(LeaseStatus.ACTIVE);
expect(state.billingSchedules).toHaveLength(1);
```

Call activation twice and assert one schedule.

- [ ] **Step 2: Run lease test and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api test -- lease-activation.spec.ts
```

Expected: FAIL because activation does not create a billing schedule.

- [ ] **Step 3: Integrate schedule creation with lease activation**

Persist lease activation and schedule initialization in one Prisma transaction. Keep audit writes after commit. Reconciliation remains the recovery path for pre-existing active leases.

- [ ] **Step 4: Write failing settlement cancellation test**

After fully writing off a monthly-rent bill, assert pending `SEND_BILL_DUE_NOTICE`, `MARK_BILL_OVERDUE` and `SEND_BILL_OVERDUE_NOTICE` jobs are `CANCELLED`, while completed history remains unchanged.

- [ ] **Step 5: Run finance test and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api test -- finance-billing.spec.ts
```

Expected: FAIL because write-off does not cancel future jobs.

- [ ] **Step 6: Add transaction-local settlement coordination**

At the end of each write-off transaction, collect bills whose `remainingAmount` becomes zero and call `cancelSettledBillJobs(tx, ids)`. Online payment already uses `FinanceService.writeOffPayment`, so no second payment-specific implementation is added.

- [ ] **Step 7: Run integration tests and verify GREEN**

Run:

```bash
pnpm --filter @subscription-saas/api test -- lease-activation.spec.ts finance-billing.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 5**

```bash
git add apps/api/src/lease apps/api/src/finance/finance.service.ts apps/api/test/lease-activation.spec.ts apps/api/test/finance-billing.spec.ts
git commit -m "feat(billing): start and settle billing automation"
```

---

### Task 6: Admin APIs and monthly-rent automation workbench

**Files:**
- Create: `apps/api/src/billing-automation/billing-automation.controller.ts`
- Create: `apps/api/src/billing-automation/billing-automation.dto.ts`
- Create: `apps/api/src/billing-automation/billing-automation.module.ts`
- Create: `apps/api/test/billing-automation-controller.spec.ts`
- Create: `apps/web/src/lib/billing-automation-view-model.ts`
- Create: `apps/web/test/billing-automation-view-model.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/lease/lease.module.ts`
- Modify: `apps/web/src/app/billing/monthly-rent/page.tsx`

**Interfaces:**
- API endpoints:
  - `GET /billing/automation/summary`
  - `GET /billing/automation/schedules`
  - `GET /billing/automation/jobs`
  - `POST /billing/automation/reconcile`
  - `POST /billing/automation/schedules/:id/pause`
  - `POST /billing/automation/schedules/:id/resume`
  - `POST /billing/automation/jobs/:id/retry`
- View model produces status labels/colors and safe date/error formatting.

- [ ] **Step 1: Write failing controller permission/contract tests**

Assert read endpoints require `PermissionCode.BILLING_VIEW`; reconcile, pause, resume and retry require `PermissionCode.BILLING_GENERATE`. Assert retry rejects non-dead-letter jobs and pause requires a non-empty reason.

- [ ] **Step 2: Run controller tests and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api test -- billing-automation-controller.spec.ts
```

Expected: FAIL because controller/module do not exist.

- [ ] **Step 3: Implement admin module, DTOs and APIs**

Return paged, JSON-safe views with `BigInt` converted to numbers only at response boundaries. Write audit entries for reconcile apply, pause, resume and retry using the authenticated operator.

- [ ] **Step 4: Write failing web view-model tests**

```ts
expect(scheduleStatusView("ACTIVE")).toEqual({ color: "green", label: "运行中" });
expect(jobStatusView("DEAD_LETTER")).toEqual({ color: "red", label: "需人工处理" });
```

Also test unknown statuses and sanitized error display.

- [ ] **Step 5: Run web test and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/web test -- billing-automation-view-model.spec.ts
```

Expected: FAIL because the view model does not exist.

- [ ] **Step 6: Implement workbench UI**

Replace the obsolete “不包含自动定时任务、逾期催收” copy. Add summary cards, schedule and job tables, reconciliation preview/apply, pause/resume and dead-letter retry controls. Retain the existing manual batch card under an “应急兜底” heading.

- [ ] **Step 7: Run API and web tests and verify GREEN**

Run:

```bash
pnpm --filter @subscription-saas/api test -- billing-automation-controller.spec.ts
pnpm --filter @subscription-saas/web test -- billing-automation-view-model.spec.ts
pnpm --filter @subscription-saas/web typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 6**

```bash
git add apps/api/src/billing-automation apps/api/src/app.module.ts apps/api/src/lease/lease.module.ts apps/api/test/billing-automation-controller.spec.ts apps/web/src/app/billing/monthly-rent/page.tsx apps/web/src/lib/billing-automation-view-model.ts apps/web/test/billing-automation-view-model.spec.ts
git commit -m "feat(billing): add automation operations workbench"
```

---

### Task 7: Configuration, end-to-end regression and release evidence

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Create: `docs/superpowers/plans/2026-07-31-stage1b-billing-automation-acceptance.md`

**Interfaces:**
- Documents the four Worker environment variables, migration command, staging enablement order, rollback switch and acceptance evidence.

- [ ] **Step 1: Add safe configuration defaults**

Document:

```dotenv
BILLING_AUTOMATION_WORKER_ENABLED=false
BILLING_AUTOMATION_WORKER_CONCURRENCY=1
BILLING_AUTOMATION_WORKER_LEASE_MS=120000
BILLING_AUTOMATION_WORKER_POLL_INTERVAL_MS=5000
```

- [ ] **Step 2: Run focused full feature tests**

```bash
pnpm --filter @subscription-saas/api test -- billing-automation-calendar.spec.ts billing-automation-schema.spec.ts billing-automation-repository.spec.ts billing-automation-service.spec.ts billing-automation-worker.spec.ts billing-automation-controller.spec.ts finance-billing.spec.ts lease-activation.spec.ts notification.spec.ts
pnpm --filter @subscription-saas/web test -- billing-automation-view-model.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run repository quality gates**

```bash
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
pnpm build
pnpm prisma:migrate:status
git diff --check
```

Expected: every applicable command PASS and migration status reports the new migration pending only until it is deployed to the target database.

- [ ] **Step 4: Write acceptance and rollout evidence**

Record exact command results and staging procedure:

1. deploy image with Worker disabled;
2. run `pnpm prisma:migrate:deploy`;
3. run schedule reconciliation preview;
4. apply reconciliation;
5. enable Worker;
6. verify D-3 generation, idempotent replay, settlement cancellation, D+5 collection and manual dead-letter retry;
7. disable Worker as the immediate rollback without disabling manual finance operations.

- [ ] **Step 5: Commit Task 7**

```bash
git add .env.example README.md docs/superpowers/plans/2026-07-31-stage1b-billing-automation-acceptance.md
git commit -m "docs(billing): add automation rollout runbook"
```

- [ ] **Step 6: Review branch and prepare integration**

Run:

```bash
git status --short
git log --oneline main..HEAD
git diff --stat main...HEAD
```

Expected: clean worktree, intentional commits only, and no unrelated user files.
