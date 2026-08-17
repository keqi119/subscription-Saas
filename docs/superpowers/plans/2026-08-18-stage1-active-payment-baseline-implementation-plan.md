# Stage 1 Active-Payment-Only Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire delegated auto debit from the Stage 1 runtime baseline, keep recurring bill generation and dunning active, make customer-initiated WeChat JSAPI payment the only collection path, and preserve existing mandate/debit facts as read-only history.

**Architecture:** Enforce one `ACTIVE_PAYMENT_ONLY` collection policy at configuration, scheduling, worker, API, UI, and deployment boundaries. Keep the existing auto-debit schema and settled history intact, remove all customer and administrator mutation surfaces, exclude retired auto-debit jobs from live Stage 1 metrics, and cancel only still-executable legacy jobs with an idempotent audited operations script.

**Tech Stack:** NestJS 11, Prisma 7/PostgreSQL, TypeScript 6, Vitest 4, Next.js 16, React 19, Ant Design 6, Node.js test runner, pnpm workspace.

**Approved design:** `docs/superpowers/specs/2026-08-18-stage1-capability-boundary-audit-revised-baseline-design.zh-CN.md`

## Split-Plan Sequence

The approved design spans independent subsystems and must not be implemented as one giant change. Execute separate implementation plans in this order:

1. Active-payment-only baseline — this plan.
2. Stage 1C common operational facts and immutable vehicle cost/recovery ledger.
3. Vehicle return, recovery, normal contract completion, and final settlement.
4. Structured handover facts, registration-certificate approval fallback, signed PDF convergence, and evidence-rejection recovery.
5. Collection policy/cases, D-3 through D+7 dunning cadence, manual tasks, and manager-approved recovery assessment.
6. Change center for same-order vehicle swap and early termination.
7. Remaining inherited Stage 1 capabilities and the overall semi-automated acceptance gate.

This plan only retires delegated debit and protects the existing bill/reminder/active-payment path. It does not add the approved `CollectionPolicy`, D-3/D+7 cadence, recovery work orders, Stage 1C tables, handover fields, or contract-change flows; those belong to the later plans above.

## Global Constraints

- Stage 1 collection mode is exactly `ACTIVE_PAYMENT_ONLY`; no local, Staging, or Production runtime may enable delegated auto debit.
- Keep `PaymentMandate`, `DebitAttempt`, auto-debit payment orders, payment records, write-offs, completed jobs, dead-letter jobs, enums, and migrations. They remain historical facts.
- Do not create a new Prisma migration for this plan; it changes runtime policy and projections, not persisted schema.
- Keep recurring bill generation, due/overdue notifications, collection cases, and customer-initiated WeChat JSAPI payment operational.
- Removing UI buttons is not sufficient: configuration parsing, the worker supported-type list, schedulers, mutation controllers, and generic dead-letter retry must all fail closed.
- The retirement script may change only `PENDING` auto-debit jobs and `PROCESSING` auto-debit jobs whose lease has expired. A non-expired `PROCESSING` lease blocks apply.
- Every job cancellation performed by the retirement script must write an `AuditLog`; dry-run must not write.
- Never use `prisma migrate reset`, `prisma db push`, or destructive deletion of auto-debit history.
- Preserve unrelated working-tree changes, especially `Dockerfile.api`, `Dockerfile.web`, `.superpowers/`, `apps/api/tmp/`, `output/`, and `tmp/`.
- Use TDD for every behavior change and commit each independently testable task.

## Exact File Map

### New files

- `apps/api/src/auto-debit/auto-debit.policy.ts`
- `apps/api/test/stage1-active-payment-baseline.spec.ts`
- `apps/web/test/stage1-active-payment-portal.spec.tsx`
- `scripts/stage1-auto-debit-retirement-core.mjs`
- `scripts/stage1-auto-debit-retirement-core.test.mjs`
- `scripts/stage1-auto-debit-retirement-executor.mjs`
- `scripts/stage1-auto-debit-retirement-executor.test.mjs`
- `scripts/stage1-auto-debit-retirement.mjs`

### Renamed files

- `apps/web/src/app/billing/monthly-rent/auto-debit-operations-panel.tsx` -> `apps/web/src/app/billing/monthly-rent/historical-auto-debit-panel.tsx`

### Deleted files

- `apps/api/src/auto-debit/portal-auto-debit.controller.ts`
- `apps/api/test/portal-auto-debit.spec.ts`
- `apps/web/src/app/portal/auto-debit/auto-debit-status-card.tsx`
- `apps/web/src/app/portal/auto-debit/auto-debit.module.css`
- `apps/web/src/lib/portal-auto-debit-view-model.ts`
- `apps/web/test/portal-auto-debit-pages.spec.tsx`
- `apps/web/test/portal-auto-debit-view-model.spec.ts`

### Modified files

- `.env.example`
- `.env.production.images.example`
- `.env.staging.images.example`
- `apps/api/.env.example`
- `apps/api/src/auto-debit/auto-debit.config.ts`
- `apps/api/src/auto-debit/auto-debit.module.ts`
- `apps/api/src/auto-debit/auto-debit.controller.ts`
- `apps/api/src/auto-debit/auto-debit.scheduler.ts`
- `apps/api/src/billing-automation/billing-automation.admin.service.ts`
- `apps/api/src/billing-automation/billing-automation.handlers.ts`
- `apps/api/src/portal/portal.module.ts`
- `apps/api/test/auto-debit-config.spec.ts`
- `apps/api/test/auto-debit-controller.spec.ts`
- `apps/api/test/auto-debit-production-safety.spec.ts`
- `apps/api/test/auto-debit-scheduler.spec.ts`
- `apps/api/test/billing-automation-controller.spec.ts`
- `apps/api/test/billing-automation.integration.spec.ts`
- `apps/api/test/billing-automation-service.spec.ts`
- `apps/api/test/billing-automation-worker.spec.ts`
- `apps/web/src/app/billing/monthly-rent/page.tsx`
- `apps/web/src/app/orders/[id]/page.tsx`
- `apps/web/src/app/portal/page.tsx`
- `apps/web/src/app/portal/auto-debit/page.tsx`
- `apps/web/src/app/portal/auto-debit/[id]/page.tsx`
- `apps/web/src/app/portal/bills/page.tsx`
- `apps/web/src/app/portal/bills/[id]/page.tsx`
- `apps/web/src/app/portal/bills/portal-bill-card.tsx`
- `apps/web/src/app/portal/bills/portal-bill-card.module.css`
- `apps/web/src/lib/billing-automation-view-model.ts`
- `apps/web/src/lib/portal-api.ts`
- `apps/web/src/lib/portal-types.ts`
- `apps/web/test/auto-debit-admin-ui.spec.tsx`
- `apps/web/test/billing-automation-view-model.spec.ts`
- `apps/web/test/deployment-ops-safety.spec.ts`
- `apps/web/test/portal-bill-card.spec.tsx`
- `docker-compose.production.images.example.yml`
- `docker-compose.staging.images.example.yml`
- `docs/operations/stage1b-auto-debit-runbook.zh-CN.md`
- `docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md`
- `package.json`
- `scripts/stage1-golden-path-production-preflight.mjs`
- `scripts/stage1-golden-path-production-preflight.test.mjs`

---

### Task 0: Record the implementation baseline

**Files:**

- Read: `AGENTS.md`
- Read: `DEV_SPEC.md`
- Read: `docs/superpowers/specs/2026-08-18-stage1-capability-boundary-audit-revised-baseline-design.zh-CN.md`

- [ ] **Step 1: Re-read repository rules and the approved design**

Read all three files completely. Confirm that this plan changes collection policy only; it does not authorize deletion of historical payment facts or implementation of later return/change-center work.

- [ ] **Step 2: Capture the dirty-worktree boundary**

Run:

```powershell
git status --short
```

Expected: the known user-owned changes may be present. Record them in the implementation notes and do not stage them in any task commit.

- [ ] **Step 3: Run mandatory pre-change database checks**

Run:

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm prisma:validate
```

Expected: schema validation passes. If migration status cannot connect to the dedicated database, preserve the exact error as an environment blocker; do not reset or mutate the database to bypass it.

---

### Task 1: Make the runtime collection policy impossible to enable

**Files:**

- Create: `apps/api/src/auto-debit/auto-debit.policy.ts`
- Modify: `apps/api/src/auto-debit/auto-debit.config.ts`
- Modify: `apps/api/src/auto-debit/auto-debit.module.ts`
- Modify: `apps/api/test/auto-debit-config.spec.ts`
- Modify: `apps/api/test/auto-debit-production-safety.spec.ts`

**Interfaces:**

- Produces: `STAGE1_COLLECTION_MODE = "ACTIVE_PAYMENT_ONLY"`.
- Produces: `STAGE1_AUTO_DEBIT_JOB_TYPES` and `isStage1AutoDebitJobType(jobType)` for worker, metrics, retry, and cleanup consistency.
- `readAutoDebitConfig` returns a `Stage1AutoDebitRuntimeConfig` with `enabled: false`, `provider: "disabled"`, `mockEnabled: false`, and `collectionMode: "ACTIVE_PAYMENT_ONLY"`. The narrower runtime type extends the legacy `AutoDebitConfig` interface so isolated historical-service fixtures do not need to pretend they are deployable runtime configuration.
- Stable configuration errors: `AUTO_DEBIT_STAGE1_BASELINE_DISABLED`, `AUTO_DEBIT_STAGE1_PROVIDER_MUST_BE_DISABLED`, and `AUTO_DEBIT_STAGE1_MOCK_MUST_BE_DISABLED`.

- [ ] **Step 1: Replace enablement tests with failing Stage 1 policy tests**

Update `auto-debit-config.spec.ts` so default configuration requires the collection mode and every enablement seam is rejected:

```ts
it("uses the active-payment-only Stage 1 baseline by default", () => {
  expect(readAutoDebitConfig({ NODE_ENV: "development" })).toEqual({
    collectionMode: "ACTIVE_PAYMENT_ONLY",
    enabled: false,
    environment: "development",
    mockEnabled: false,
    provider: "disabled",
    runTime: "09:00",
    wechatTemplateId: null
  });
});

it.each([
  { AUTO_DEBIT_ENABLED: "true", PAYMENT_MANDATE_PROVIDER: "disabled" },
  { AUTO_DEBIT_ENABLED: "true", PAYMENT_MANDATE_PROVIDER: "mock" },
  { AUTO_DEBIT_ENABLED: "true", PAYMENT_MANDATE_PROVIDER: "wechat_auto_renew" }
])("rejects delegated debit enablement: %o", (environment) => {
  expect(() => readAutoDebitConfig(environment)).toThrow("AUTO_DEBIT_STAGE1_BASELINE_DISABLED");
});

it("rejects a dormant non-disabled provider", () => {
  expect(() =>
    readAutoDebitConfig({
      AUTO_DEBIT_ENABLED: "false",
      PAYMENT_MANDATE_PROVIDER: "mock"
    })
  ).toThrow("AUTO_DEBIT_STAGE1_PROVIDER_MUST_BE_DISABLED");
});

it("rejects the legacy mock safety switch even while disabled", () => {
  expect(() =>
    readAutoDebitConfig({
      AUTO_DEBIT_ENABLED: "false",
      PAYMENT_MANDATE_MOCK_ENABLED: "true",
      PAYMENT_MANDATE_PROVIDER: "disabled"
    })
  ).toThrow("AUTO_DEBIT_STAGE1_MOCK_MUST_BE_DISABLED");
});
```

Change `auto-debit-production-safety.spec.ts` so both Production and Staging examples must parse to the same disabled policy. Remove the tests that approve Staging mock or a WeChat template.

- [ ] **Step 2: Run the focused config tests and verify RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/auto-debit-config.spec.ts test/auto-debit-production-safety.spec.ts
```

Expected: FAIL because the config has no `collectionMode` and still accepts Staging mock/WeChat enablement.

- [ ] **Step 3: Add the shared Stage 1 policy**

Create `auto-debit.policy.ts`:

```ts
import { SubscriptionAutomationJobType } from "@prisma/client";

export const STAGE1_COLLECTION_MODE = "ACTIVE_PAYMENT_ONLY" as const;

export const STAGE1_AUTO_DEBIT_JOB_TYPES = [
  SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
  SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT,
  SubscriptionAutomationJobType.SEND_DEBIT_FAILURE_NOTICE,
  SubscriptionAutomationJobType.SYNC_PAYMENT_MANDATE
] as const;

export function isStage1AutoDebitJobType(value: SubscriptionAutomationJobType) {
  return STAGE1_AUTO_DEBIT_JOB_TYPES.includes(
    value as (typeof STAGE1_AUTO_DEBIT_JOB_TYPES)[number]
  );
}
```

- [ ] **Step 4: Enforce the policy in configuration parsing**

Keep `AutoDebitConfig` as the compatibility shape used by isolated historical-service tests. Add the narrower runtime type and return it from the parser:

```ts
export interface Stage1AutoDebitRuntimeConfig extends AutoDebitConfig {
  collectionMode: typeof STAGE1_COLLECTION_MODE;
  enabled: false;
  mockEnabled: false;
  provider: "disabled";
}
```

Validate in this order so explicit enablement always receives the baseline error:

```ts
if (enabled) {
  throw new Error("AUTO_DEBIT_STAGE1_BASELINE_DISABLED");
}
if (provider !== "disabled") {
  throw new Error("AUTO_DEBIT_STAGE1_PROVIDER_MUST_BE_DISABLED");
}
if (mockEnabled) {
  throw new Error("AUTO_DEBIT_STAGE1_MOCK_MUST_BE_DISABLED");
}
```

Return the literal policy values rather than the parsed legacy values:

```ts
return {
  collectionMode: STAGE1_COLLECTION_MODE,
  enabled: false,
  environment: nodeEnvironment,
  mockEnabled: false,
  provider: "disabled",
  runTime,
  wechatTemplateId: null
};
```

Keep local-time validation because old rows and historical tools may still display the configured run time.

- [ ] **Step 5: Remove the unimplemented provider construction path**

In `auto-debit.module.ts`, remove `MockAutoDebitProvider` construction and the `AUTO_DEBIT_WECHAT_PROVIDER_NOT_IMPLEMENTED` branch. The `MANDATE_DEBIT_PROVIDER` factory must always return `DisabledAutoDebitProvider`; continue exporting the token for historical read services and old isolated unit fixtures.

- [ ] **Step 6: Run the focused config tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 7: Commit the runtime policy**

```powershell
git add apps/api/src/auto-debit/auto-debit.policy.ts apps/api/src/auto-debit/auto-debit.config.ts apps/api/src/auto-debit/auto-debit.module.ts apps/api/test/auto-debit-config.spec.ts apps/api/test/auto-debit-production-safety.spec.ts
git commit -m "feat: enforce active payment only baseline"
```

---

### Task 2: Close scheduling, worker, mutation, and retry seams

**Files:**

- Create: `apps/api/test/stage1-active-payment-baseline.spec.ts`
- Modify: `apps/api/src/auto-debit/auto-debit.scheduler.ts`
- Modify: `apps/api/src/auto-debit/auto-debit.controller.ts`
- Delete: `apps/api/src/auto-debit/portal-auto-debit.controller.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.handlers.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.admin.service.ts`
- Modify: `apps/api/src/portal/portal.module.ts`
- Modify: `apps/api/test/auto-debit-controller.spec.ts`
- Delete: `apps/api/test/portal-auto-debit.spec.ts`
- Modify: `apps/api/test/auto-debit-scheduler.spec.ts`
- Modify: `apps/api/test/billing-automation.integration.spec.ts`
- Modify: `apps/api/test/billing-automation-service.spec.ts`
- Modify: `apps/api/test/billing-automation-worker.spec.ts`

**Interfaces:**

- `AutoDebitScheduler.enqueueForBill` and `enqueueFutureForBill` always resolve to `[]`.
- `BillingAutomationHandlers.supportedJobTypes` contains only bill generation and dunning jobs.
- Admin auto-debit API exposes only `GET /billing/automation/mandates` and `GET /billing/automation/attempts`.
- No `/portal/auto-debit/*` API route remains.
- Generic `POST /billing/automation/jobs/:id/retry` rejects retired auto-debit job types with `AUTO_DEBIT_STAGE1_BASELINE_DISABLED`.

- [ ] **Step 1: Write failing boundary tests**

Add `stage1-active-payment-baseline.spec.ts`:

```ts
it("never schedules delegated debit jobs", async () => {
  const scheduler = new AutoDebitScheduler();
  const transaction = {
    subscriptionAutomationJob: { upsert: vi.fn() }
  };

  await expect(
    scheduler.enqueueForBill(transaction as never, {
      dueDate: new Date("2026-09-01T00:00:00.000Z"),
      id: "bill-1",
      orderId: "order-1"
    })
  ).resolves.toEqual([]);
  expect(transaction.subscriptionAutomationJob.upsert).not.toHaveBeenCalled();
});

it("does not advertise retired job types to the billing worker", () => {
  const handlers = new BillingAutomationHandlers({} as never, {} as never, {} as never);
  expect(handlers.supportedJobTypes).not.toEqual(
    expect.arrayContaining([...STAGE1_AUTO_DEBIT_JOB_TYPES])
  );
});

it("exposes no auto-debit mutation methods", () => {
  for (const method of [
    "queryAttempt",
    "requestManualDebit",
    "cancelJob",
    "setMockNextResult",
    "syncMandate",
    "revokeMandate"
  ]) {
    expect(AutoDebitController.prototype).not.toHaveProperty(method);
  }
});
```

In `billing-automation-controller.spec.ts`, add a service-level test that builds a dead-letter `SUBMIT_BILL_DEBIT` job and expects `retryJob` to reject with a `BadRequestException` response containing code `AUTO_DEBIT_STAGE1_BASELINE_DISABLED` without calling `repository.retryDeadLetter`.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/stage1-active-payment-baseline.spec.ts test/auto-debit-controller.spec.ts test/auto-debit-scheduler.spec.ts test/billing-automation-controller.spec.ts test/billing-automation-service.spec.ts test/billing-automation.integration.spec.ts test/billing-automation-worker.spec.ts
```

Expected: FAIL because the scheduler creates debit jobs, worker claims them, and mutation routes still exist.

- [ ] **Step 3: Make the scheduler a compatibility no-op**

Remove its config dependency and calendar imports. Keep both public method names and their argument signatures so billing generation code does not require a parallel refactor:

```ts
@Injectable()
export class AutoDebitScheduler {
  async enqueueForBill(
    _tx: AutoDebitSchedulerDb,
    _bill: SchedulableBill,
    _billingScheduleId?: string
  ) {
    return [];
  }

  async enqueueFutureForBill(
    _tx: AutoDebitSchedulerDb,
    _bill: SchedulableBill,
    _now: Date,
    _billingScheduleId?: string
  ) {
    return [];
  }
}
```

Retain the existing `AutoDebitSchedulerDb` and `SchedulableBill` types. Replace `auto-debit-scheduler.spec.ts` with no-op assertions for both methods and verify that `subscriptionAutomationJob.upsert` is never called. Update `billing-automation-service.spec.ts` and `billing-automation.integration.spec.ts`: generated bill cycles now enqueue only due-notice and overdue jobs; no `SUBMIT_BILL_DEBIT` expectations remain, and both construct `new AutoDebitScheduler()` without a config argument.

- [ ] **Step 4: Remove retired job types from worker dispatch**

In `billing-automation.handlers.ts`:

- remove `AutoDebitHandlers` from imports and constructor;
- remove the three auto-debit job types from `supportedJobTypes`;
- remove their switch cases.

Update the actual-handler assertions in `billing-automation-worker.spec.ts` to the four supported types:

```ts
[
  SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
  SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE,
  SubscriptionAutomationJobType.MARK_BILL_OVERDUE,
  SubscriptionAutomationJobType.SEND_BILL_OVERDUE_NOTICE
];
```

Do not remove old handler classes or settled-attempt logic; they remain historical code until a later schema-retirement decision.

- [ ] **Step 5: Remove customer and administrator mutation routes**

Reduce `AutoDebitController` to the two read methods. Remove mutation DTO imports, request context, `Post`, `Body`, `Param`, and `Req`. Delete `PortalAutoDebitController`, remove it from `PortalModule.controllers`, and remove `AutoDebitModule` from `PortalModule.imports` if no other portal provider consumes it.

Update `auto-debit-controller.spec.ts` to assert only `listMandates` and `listAttempts` carry `AUTO_DEBIT_VIEW`, and that mutation prototype methods are absent.

- [ ] **Step 6: Block generic retries of retired jobs**

Before calling `retryDeadLetter`, load the job type in `BillingAutomationAdminService.retryJob`:

```ts
const current = await this.prisma.subscriptionAutomationJob.findUnique({
  select: { jobType: true },
  where: { id }
});
if (!current) {
  throw new NotFoundException("自动化任务不存在。");
}
if (isStage1AutoDebitJobType(current.jobType)) {
  throw new BadRequestException({
    code: "AUTO_DEBIT_STAGE1_BASELINE_DISABLED",
    message: "阶段 1 已停用委托代扣任务，历史任务不可重试。"
  });
}
```

Then retain the existing dead-letter retry behavior for bill generation and dunning jobs.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 8: Commit the closed runtime seams**

```powershell
git add apps/api/src/auto-debit/auto-debit.scheduler.ts apps/api/src/auto-debit/auto-debit.controller.ts apps/api/src/auto-debit/portal-auto-debit.controller.ts apps/api/src/billing-automation/billing-automation.handlers.ts apps/api/src/billing-automation/billing-automation.admin.service.ts apps/api/src/portal/portal.module.ts apps/api/test/stage1-active-payment-baseline.spec.ts apps/api/test/auto-debit-controller.spec.ts apps/api/test/portal-auto-debit.spec.ts apps/api/test/auto-debit-scheduler.spec.ts apps/api/test/billing-automation-controller.spec.ts apps/api/test/billing-automation-service.spec.ts apps/api/test/billing-automation.integration.spec.ts apps/api/test/billing-automation-worker.spec.ts
git commit -m "feat: retire auto debit execution surfaces"
```

---

### Task 3: Add an idempotent audited retirement script for executable legacy jobs

**Files:**

- Create: `scripts/stage1-auto-debit-retirement-core.mjs`
- Create: `scripts/stage1-auto-debit-retirement-core.test.mjs`
- Create: `scripts/stage1-auto-debit-retirement-executor.mjs`
- Create: `scripts/stage1-auto-debit-retirement-executor.test.mjs`
- Create: `scripts/stage1-auto-debit-retirement.mjs`
- Modify: `package.json`

**Interfaces:**

- Commands: `pnpm stage1:auto-debit-retirement:dry-run`, `pnpm stage1:auto-debit-retirement:apply`, and `pnpm stage1:auto-debit-retirement:test`.
- Cancellation code: `STAGE1_ACTIVE_PAYMENT_BASELINE_RETIRED`.
- Apply returns exit code `2` when a non-expired `PROCESSING` lease exists.
- Completed/dead-letter/cancelled jobs and all mandate/debit/payment facts are never modified.

- [ ] **Step 1: Write failing pure-policy tests**

In the core test, require exact mode parsing and classification:

```js
test("accepts only dry-run and apply modes", () => {
  assert.equal(parseMode(["--dry-run"]), "dry-run");
  assert.equal(parseMode(["--apply"]), "apply");
  assert.throws(() => parseMode([]), /STAGE1_AUTO_DEBIT_RETIREMENT_MODE_REQUIRED/);
  assert.throws(
    () => parseMode(["--dry-run", "--apply"]),
    /STAGE1_AUTO_DEBIT_RETIREMENT_MODE_CONFLICT/
  );
});

test("classifies pending and expired processing jobs without touching history", () => {
  const result = buildRetirementPlan(rows, new Date("2026-08-18T08:00:00.000Z"));
  assert.deepEqual(result.cancellableIds, ["pending-1", "expired-processing-1"]);
  assert.deepEqual(result.blockedProcessingIds, ["leased-processing-1"]);
  assert.equal(result.historicalCount, 3);
});
```

The fixture must cover all four retired job types plus `COMPLETED`, `DEAD_LETTER`, `CANCELLED`, and an unrelated `GENERATE_MONTHLY_RENT_BILL` job.

- [ ] **Step 2: Write failing executor tests**

Use an injected fake Prisma client to prove:

- dry-run performs no update and no audit writes;
- apply refuses while `blockedProcessingIds` is non-empty;
- apply updates only classified IDs to `CANCELLED`;
- each update writes one audit row with `operatorId: null`;
- a second apply cancels zero rows and remains successful.

The returned report must be exactly shaped as:

```js
{
  collectionMode: "ACTIVE_PAYMENT_ONLY",
  mode: "apply",
  scannedCount: 0,
  cancellableCount: 0,
  blockedProcessingCount: 0,
  cancelledCount: 0,
  historicalCount: 0,
  byJobType: {},
  postcondition: { executableJobCount: 0 },
  ok: true
}
```

Counts vary by fixture, but field names and `collectionMode` do not.

- [ ] **Step 3: Run script tests and verify RED**

```powershell
node --test scripts/stage1-auto-debit-retirement-core.test.mjs scripts/stage1-auto-debit-retirement-executor.test.mjs
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement the pure planner**

The core module must define the retired type strings independently of generated Prisma imports so it stays unit-testable:

```js
export const RETIRED_AUTO_DEBIT_JOB_TYPES = Object.freeze([
  "SUBMIT_BILL_DEBIT",
  "QUERY_DEBIT_ATTEMPT",
  "SEND_DEBIT_FAILURE_NOTICE",
  "SYNC_PAYMENT_MANDATE"
]);
```

`buildRetirementPlan` classifies only:

- `PENDING` as cancellable;
- `PROCESSING` with `leaseExpiresAt <= now` as cancellable;
- `PROCESSING` with `leaseExpiresAt > now` or missing expiry as blocking;
- every terminal status as historical.

- [ ] **Step 5: Implement the transactional executor**

Within one Prisma transaction:

1. Re-read the candidate rows.
2. Rebuild the plan at transaction time.
3. Abort without writes if a live lease blocks apply.
4. Update each cancellable row with:

```js
{
  cancelledAt: now,
  completedAt: now,
  jobStatus: "CANCELLED",
  lastErrorCode: "STAGE1_ACTIVE_PAYMENT_BASELINE_RETIRED",
  lastErrorMessage: "Cancelled by Stage 1 active-payment-only baseline rollout.",
  leaseExpiresAt: null,
  leaseToken: null,
  resultSnapshot: {
    collectionMode: "ACTIVE_PAYMENT_ONLY",
    retiredAt: now.toISOString()
  }
}
```

5. Write `AuditLog` rows using `action: "UPDATE"`, `module: "billing"`, `entityType: "subscription_automation_job"`, `operatorId: null`, and before/after status snapshots.
6. Query the postcondition count of remaining `PENDING` or `PROCESSING` retired jobs.

The `updateMany` predicate must include the previously read `id`, `jobStatus`, and lease expiry condition to prevent cancelling a newly claimed live job.

- [ ] **Step 6: Implement the CLI and package scripts**

Use the established repository pattern from `stage2-handover-workflow-backfill.mjs`: load root and API `.env`, resolve Prisma from `apps/api/package.json`, normalize `localhost` to `127.0.0.1`, and always disconnect.

Add:

```json
"stage1:auto-debit-retirement:dry-run": "node scripts/stage1-auto-debit-retirement.mjs --dry-run",
"stage1:auto-debit-retirement:apply": "node scripts/stage1-auto-debit-retirement.mjs --apply",
"stage1:auto-debit-retirement:test": "node --test scripts/stage1-auto-debit-retirement-core.test.mjs scripts/stage1-auto-debit-retirement-executor.test.mjs"
```

Do not log `DATABASE_URL` or raw environment values.

- [ ] **Step 7: Run script tests and verify GREEN**

Run the command from Step 3. Expected: PASS.

- [ ] **Step 8: Commit the operations script**

```powershell
git add package.json scripts/stage1-auto-debit-retirement-core.mjs scripts/stage1-auto-debit-retirement-core.test.mjs scripts/stage1-auto-debit-retirement-executor.mjs scripts/stage1-auto-debit-retirement-executor.test.mjs scripts/stage1-auto-debit-retirement.mjs
git commit -m "feat: add audited auto debit retirement tool"
```

---

### Task 4: Separate live Stage 1 metrics from historical auto-debit facts

**Files:**

- Modify: `apps/api/src/billing-automation/billing-automation.admin.service.ts`
- Modify: `apps/api/test/billing-automation-controller.spec.ts`

**Interfaces:**

- Summary returns `collectionMode: "ACTIVE_PAYMENT_ONLY"`.
- Summary returns `historicalAutoDebit`, not `autoDebit`.
- Confirmed but unallocated payments move to `payments.unallocated`; they are not inherently auto-debit facts.
- Live `jobs`, `oldestPendingJob`, and `deadLetterCount` exclude all retired auto-debit job types.
- Explicit `GET /billing/automation/jobs?jobType=<retired type>` remains a read-only historical query, but retry remains blocked by Task 2.

- [ ] **Step 1: Write failing projection tests**

Update the summary test to require:

```ts
await expect(service.summary()).resolves.toMatchObject({
  collectionMode: "ACTIVE_PAYMENT_ONLY",
  historicalAutoDebit: {
    attempts: { UNKNOWN: 3 },
    jobs: { DEAD_LETTER: 1 },
    mandates: { ACTIVE: 4 },
    unknownCount: 3
  },
  payments: {
    unallocated: { amount: "150", count: 2 }
  }
});
```

Also assert the live job group and `oldestPendingJob` queries use `jobType: { notIn: [...STAGE1_AUTO_DEBIT_JOB_TYPES] }`, while the historical job group uses `in`.

Add a `listJobs` test proving a query without `jobType` excludes retired types and an explicit retired `jobType` filter can return history.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/billing-automation-controller.spec.ts
```

Expected: FAIL because `autoDebit.deadLetterCount` currently reuses all job dead letters and unallocated payments are nested under auto debit.

- [ ] **Step 3: Implement separated projections**

Use `STAGE1_AUTO_DEBIT_JOB_TYPES` in all four queries. Return:

```ts
return {
  collectionMode: STAGE1_COLLECTION_MODE,
  historicalAutoDebit: {
    attempts,
    jobs: historicalAutoDebitJobs,
    mandates,
    unknownCount: attempts.UNKNOWN
  },
  jobs,
  nextSchedule,
  oldestPendingJob,
  payments: {
    unallocated: {
      amount: unallocated.unallocatedAmount.toString(),
      count: Number(unallocated.paymentCount)
    }
  },
  schedules
};
```

For `listJobs`, build the job-type filter as:

```ts
const jobTypeWhere = query.jobType
  ? { jobType: query.jobType }
  : { jobType: { notIn: [...STAGE1_AUTO_DEBIT_JOB_TYPES] } };
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit the metric boundary**

```powershell
git add apps/api/src/billing-automation/billing-automation.admin.service.ts apps/api/test/billing-automation-controller.spec.ts
git commit -m "refactor: separate live billing from auto debit history"
```

---

### Task 5: Replace the customer auto-debit journey with active payment

**Files:**

- Modify: `apps/web/src/app/portal/page.tsx`
- Modify: `apps/web/src/app/portal/auto-debit/page.tsx`
- Modify: `apps/web/src/app/portal/auto-debit/[id]/page.tsx`
- Delete: `apps/web/src/app/portal/auto-debit/auto-debit-status-card.tsx`
- Delete: `apps/web/src/app/portal/auto-debit/auto-debit.module.css`
- Modify: `apps/web/src/app/portal/bills/page.tsx`
- Modify: `apps/web/src/app/portal/bills/[id]/page.tsx`
- Modify: `apps/web/src/app/portal/bills/portal-bill-card.tsx`
- Modify: `apps/web/src/app/portal/bills/portal-bill-card.module.css`
- Delete: `apps/web/src/lib/portal-auto-debit-view-model.ts`
- Modify: `apps/web/src/lib/portal-api.ts`
- Modify: `apps/web/src/lib/portal-types.ts`
- Create: `apps/web/test/stage1-active-payment-portal.spec.tsx`
- Delete: `apps/web/test/portal-auto-debit-pages.spec.tsx`
- Delete: `apps/web/test/portal-auto-debit-view-model.spec.ts`
- Modify: `apps/web/test/portal-bill-card.spec.tsx`

**Interfaces:**

- Portal navigation has no auto-debit entry.
- Legacy `/portal/auto-debit` and `/portal/auto-debit/[id]` pages redirect to `/portal/bills`.
- Bills list/detail fetch only bill/payment data and never call `/portal/auto-debit/*`.
- A payable bill always exposes `去支付`; no authorization/enrollment/revoke UI remains.
- Customer copy states `账单提醒 + 主动支付` and does not promise automatic deduction.

- [ ] **Step 1: Write failing portal baseline tests**

Create `stage1-active-payment-portal.spec.tsx` with source-contract and rendered-card assertions:

```tsx
it("removes delegated debit from the portal journey", () => {
  expect(portalHomeSource).not.toContain('/portal/auto-debit"');
  expect(billsSource).not.toMatch(
    /getPortalAutoDebit|getPortalPaymentMandates|getPortalDebitAttempts/
  );
  expect(billDetailSource).not.toMatch(/PortalAutoDebitStatusCard|getPortalAutoDebit/);
  expect(billsSource).toContain("账单提醒 + 主动支付");
});

it("keeps active payment on payable bills", () => {
  const html = renderToStaticMarkup(
    <PortalBillCard bill={payableBill} onDetails={vi.fn()} onPay={vi.fn()} paying={false} />
  );
  expect(html).toContain("去支付");
  expect(html).not.toMatch(/自动扣款|授权|扣款结果/);
});

it("redirects legacy auto-debit pages to bills", () => {
  expect(autoDebitPageSource).toContain('redirect("/portal/bills")');
  expect(autoDebitDetailSource).toContain('redirect("/portal/bills")');
});
```

- [ ] **Step 2: Run the focused Web tests and verify RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/stage1-active-payment-portal.spec.tsx test/portal-bill-card.spec.tsx
```

Expected: FAIL because the portal still offers auto-debit enrollment, status, and revoke actions.

- [ ] **Step 3: Remove the customer navigation and API client**

Remove the `WalletOutlined` import and auto-debit entry from `portal/page.tsx`. Remove these client functions and their dedicated types:

- `getPortalAutoDebitAvailability`
- `getPortalPaymentMandates`
- `getPortalDebitAttempts`
- `createPortalPaymentMandate`
- `revokePortalPaymentMandate`
- `PortalAutoDebitAvailability`
- `PortalPaymentMandate`
- `PortalDebitAttempt`

Delete the auto-debit view-model and status-card implementation after all consumers are removed.

- [ ] **Step 4: Convert legacy Web routes to redirects**

Both route files become server components:

```tsx
import { redirect } from "next/navigation";

export default function RetiredAutoDebitPage() {
  redirect("/portal/bills");
}
```

Use a distinct component name in the `[id]` file but the same redirect target.

- [ ] **Step 5: Make bills the only collection journey**

In the bill list:

- fetch only `/portal/bills`;
- render an informational `Alert` with message `账单提醒 + 主动支付` and description `系统会按账期生成账单并发送到期、逾期提醒；请在账单页面主动完成微信支付。`;
- pass no auto-debit model to `PortalBillCard`.

In bill detail:

- fetch only the bill;
- delete auto-debit state and status card;
- retain the primary `去支付` button and payment-order creation.

Remove the `autoDebit` prop and auto-debit CSS block from `PortalBillCard`.

- [ ] **Step 6: Replace obsolete tests**

Delete tests that validate enrollment/status behavior. Update `portal-bill-card.spec.tsx` so its third test asserts active payment without any auto-debit copy rather than injecting an `autoDebit` prop.

- [ ] **Step 7: Run focused Web tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 8: Commit the portal baseline**

```powershell
git add apps/web/src/app/portal apps/web/src/lib/portal-api.ts apps/web/src/lib/portal-types.ts apps/web/src/lib/portal-auto-debit-view-model.ts apps/web/test/stage1-active-payment-portal.spec.tsx apps/web/test/portal-auto-debit-pages.spec.tsx apps/web/test/portal-auto-debit-view-model.spec.ts apps/web/test/portal-bill-card.spec.tsx
git commit -m "feat: make portal collections active payment only"
```

---

### Task 6: Convert Admin auto debit to historical read-only views

**Files:**

- Rename: `apps/web/src/app/billing/monthly-rent/auto-debit-operations-panel.tsx` -> `apps/web/src/app/billing/monthly-rent/historical-auto-debit-panel.tsx`
- Modify: `apps/web/src/app/billing/monthly-rent/page.tsx`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Modify: `apps/web/src/lib/billing-automation-view-model.ts`
- Modify: `apps/web/test/auto-debit-admin-ui.spec.tsx`
- Modify: `apps/web/test/billing-automation-view-model.spec.ts`

**Interfaces:**

- Component: `HistoricalAutoDebitPanel` accepts only `attempts`, `mandates`, and `loading`.
- No sync, revoke, query, manual debit, cancel, or mock-result control is rendered or called.
- Monthly rent page uses `summary.collectionMode`, `summary.historicalAutoDebit`, and `summary.payments.unallocated`.
- Order finance tab retains `OrderAutoDebitTracePanel`, relabeled as historical evidence.

- [ ] **Step 1: Write failing Admin read-only tests**

Replace operation tests with:

```tsx
it("renders historical mandate and attempt facts without mutation controls", () => {
  const html = renderToStaticMarkup(
    <HistoricalAutoDebitPanel
      attempts={[attempt({ status: "UNKNOWN" })]}
      loading={false}
      mandates={[mandate({ status: "ACTIVE" })]}
    />
  );

  expect(html).toContain("历史自动扣款（已停用）");
  expect(html).toContain("MDT20260804000001");
  expect(html).toContain("DBT20260902000001");
  expect(html).not.toMatch(/人工扣款|查询结果|同步授权|关闭授权|设置模拟结果/);
});

it("does not call retired mutation endpoints", () => {
  expect(monthlyRentSource).not.toMatch(
    /attempts\/\$\{attempt\.id\}\/query|bills\/\$\{attempt\.billId\}\/debit|mandates\/\$\{mandate\.id\}\/(sync|revoke)|mock\/attempts/
  );
});
```

Update the view-model test to expect `buildHistoricalAutoDebitSummaryView` and verify unallocated payment counts are no longer part of that view.

- [ ] **Step 2: Run focused Admin Web tests and verify RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/auto-debit-admin-ui.spec.tsx test/billing-automation-view-model.spec.ts
```

Expected: FAIL because the current panel exposes mutation buttons and the page calls mutation endpoints.

- [ ] **Step 3: Rename and reduce the historical panel**

Use `git mv` for the component file. Rename `AutoDebitOperationsPanel` to `HistoricalAutoDebitPanel`. Remove:

- `canExecute` and `canManage` props;
- all callback props;
- action columns and buttons;
- Staging mock controls.

Keep status tags, customer/order/bill identifiers, amounts, provider mode, payment order, payment record, and write-off trace. Add an `Alert` stating that records are retained for audit only and no new debit or provider query will be issued.

Keep `OrderAutoDebitTracePanel` in the renamed file, change its title to `历史自动扣款结算追踪（已停用）`, and change its link text from `进入自动扣款操作台` to `查看历史自动扣款记录`.

- [ ] **Step 4: Remove Admin mutation behavior from the page**

In `monthly-rent/page.tsx`:

- remove `canExecuteAutoDebit` and `canManageAutoDebit`;
- remove `confirmAttemptAction`, `confirmMandateAction`, and `confirmMockResult`;
- remove all retired mutation endpoint calls;
- keep filters and GET requests for authorized historical lookup;
- render `HistoricalAutoDebitPanel` with no action props.

Change the summary contract to:

```ts
interface AutomationSummary {
  collectionMode: "ACTIVE_PAYMENT_ONLY";
  historicalAutoDebit: {
    attempts: Record<string, number>;
    jobs: Record<string, number>;
    mandates: Record<string, number>;
    unknownCount: number;
  };
  payments: {
    unallocated: { amount: string; count: number };
  };
  // existing live schedules/jobs fields remain unchanged
}
```

Render the live billing cards from `summary.jobs`; render a separate, clearly labeled historical card group from `historicalAutoDebit`; render unallocated confirmed payments under the normal payment/billing group.

- [ ] **Step 5: Update the order workspace import and copy**

Point `orders/[id]/page.tsx` to `historical-auto-debit-panel.tsx`. Preserve the `AUTO_DEBIT_VIEW`-guarded GET requests and trace display because those facts are audit evidence, but expose no operation link or mutation.

- [ ] **Step 6: Run focused Admin Web tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 7: Commit the Admin historical view**

```powershell
git add apps/web/src/app/billing/monthly-rent/auto-debit-operations-panel.tsx apps/web/src/app/billing/monthly-rent/historical-auto-debit-panel.tsx apps/web/src/app/billing/monthly-rent/page.tsx apps/web/src/app/orders/[id]/page.tsx apps/web/src/lib/billing-automation-view-model.ts apps/web/test/auto-debit-admin-ui.spec.tsx apps/web/test/billing-automation-view-model.spec.ts
git commit -m "refactor: make auto debit history read only"
```

---

### Task 7: Lock deployment examples and acceptance checks to active payment

**Files:**

- Modify: `.env.example`
- Modify: `.env.production.images.example`
- Modify: `.env.staging.images.example`
- Modify: `apps/api/.env.example`
- Modify: `docker-compose.production.images.example.yml`
- Modify: `docker-compose.staging.images.example.yml`
- Modify: `scripts/stage1-golden-path-production-preflight.mjs`
- Modify: `scripts/stage1-golden-path-production-preflight.test.mjs`
- Modify: `apps/web/test/deployment-ops-safety.spec.ts`
- Modify: `docs/operations/stage1b-auto-debit-runbook.zh-CN.md`
- Modify: `docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md`

**Interfaces:**

- Every checked-in environment example has `AUTO_DEBIT_ENABLED=false`, `PAYMENT_MANDATE_PROVIDER=disabled`, and `PAYMENT_MANDATE_MOCK_ENABLED=false`.
- Both image compose files pass literal disabled values, not overridable `${...:-true}` defaults.
- Preflight rejects a non-disabled provider or enabled mock switch even when `AUTO_DEBIT_ENABLED=false`.
- Acceptance checks require zero executable auto-debit jobs; historical mandate/attempt counts may be non-zero.

- [ ] **Step 1: Write failing deployment/preflight tests**

Extend the Node preflight test:

```js
test("requires the complete active-payment-only policy", () => {
  expectBlocker({ PAYMENT_MANDATE_PROVIDER: "mock" }, "AUTO_DEBIT_PROVIDER_MUST_BE_DISABLED");
  expectBlocker({ PAYMENT_MANDATE_MOCK_ENABLED: "true" }, "AUTO_DEBIT_MOCK_MUST_BE_DISABLED");
});
```

Add both keys to `validEnv()` with disabled values. Extend `deployment-ops-safety.spec.ts` so Staging and Production env/compose examples cannot contain any enabling defaults:

```ts
expect(stagingEnv).toContain("AUTO_DEBIT_ENABLED=false");
expect(stagingEnv).toContain("PAYMENT_MANDATE_PROVIDER=disabled");
expect(stagingEnv).toContain("PAYMENT_MANDATE_MOCK_ENABLED=false");
expect(stagingCompose).not.toMatch(/AUTO_DEBIT_ENABLED:\s*\$\{[^}]*:-true/);
expect(stagingCompose).not.toMatch(/PAYMENT_MANDATE_PROVIDER:\s*\$\{[^}]*:-mock/);
```

- [ ] **Step 2: Run deployment tests and verify RED**

```powershell
node --test scripts/stage1-golden-path-production-preflight.test.mjs
pnpm --filter @subscription-saas/web exec vitest run test/deployment-ops-safety.spec.ts
```

Expected: FAIL because Staging currently enables the persistent mock and preflight checks only `AUTO_DEBIT_ENABLED`.

- [ ] **Step 3: Lock environment and compose examples**

Set the three policy values consistently in all env examples. In both compose files use literals:

```yaml
AUTO_DEBIT_ENABLED: "false"
PAYMENT_MANDATE_PROVIDER: "disabled"
PAYMENT_MANDATE_MOCK_ENABLED: "false"
```

Remove comments instructing operators to enable mock or WeChat auto-renew later. Keep `AUTO_DEBIT_RUN_TIME` and old provider-specific variables only when still needed to parse existing deployment secrets; label them `legacy historical configuration, not an enablement path`.

Do not modify the user-owned Dockerfiles.

- [ ] **Step 4: Extend the preflight guard**

Add these blockers to both `validateStage1GoldenPathPreflight` and `validateProductionImageGoldenPathConfig`:

```js
if (normalized(env.PAYMENT_MANDATE_PROVIDER) !== "disabled") {
  add(
    "AUTO_DEBIT_PROVIDER_MUST_BE_DISABLED",
    "PAYMENT_MANDATE_PROVIDER",
    "Stage 1 requires the delegated debit provider to stay disabled."
  );
}
if (truthy(env.PAYMENT_MANDATE_MOCK_ENABLED)) {
  add(
    "AUTO_DEBIT_MOCK_MUST_BE_DISABLED",
    "PAYMENT_MANDATE_MOCK_ENABLED",
    "Stage 1 forbids delegated debit mock execution."
  );
}
```

For `validateProductionImageGoldenPathConfig`, push `blocker(...)` objects instead of using the local `add` callback. Add both keys to `requiredComposeKeys`. Report `runtime.collectionMode: "active-payment-only"` in the safe summary; never return provider secrets.

- [ ] **Step 5: Rewrite the retired runbook**

Change `stage1b-auto-debit-runbook.zh-CN.md` from an enablement guide to a retirement/history guide with this deployment order:

1. Deploy Task 1/2 code so the worker no longer claims retired types.
2. Run `pnpm stage1:auto-debit-retirement:dry-run` and archive the JSON report.
3. If live leases are reported, wait for the lease window and rerun dry-run; do not force-cancel an in-flight job.
4. Run `pnpm stage1:auto-debit-retirement:apply` in the approved release window.
5. Rerun dry-run and require `postcondition.executableJobCount = 0`.
6. Verify bill generation, due notice, overdue notice, collection case creation, Portal `去支付`, WeChat JSAPI callback, payment record, and write-off.
7. Verify historical mandate/attempt GET pages remain readable and have no action controls.

State explicitly that rollback restores application images only; it must not delete audit or payment history and must not re-enable auto debit.

- [ ] **Step 6: Correct the golden-path acceptance evidence**

Replace the old `mandate/attempt 数量为零` requirement with:

- current collection mode is `ACTIVE_PAYMENT_ONLY`;
- no `PENDING` or `PROCESSING` retired auto-debit job exists;
- no customer/admin mutation route or UI control is available;
- historical mandate/attempt counts are recorded but do not fail acceptance;
- at least one customer-initiated JSAPI payment reaches confirmed payment and write-off.

- [ ] **Step 7: Run deployment tests and verify GREEN**

Run both commands from Step 2. Expected: PASS.

- [ ] **Step 8: Commit deployment and runbook changes**

```powershell
git add .env.example .env.production.images.example .env.staging.images.example apps/api/.env.example docker-compose.production.images.example.yml docker-compose.staging.images.example.yml scripts/stage1-golden-path-production-preflight.mjs scripts/stage1-golden-path-production-preflight.test.mjs apps/web/test/deployment-ops-safety.spec.ts docs/operations/stage1b-auto-debit-runbook.zh-CN.md docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md
git commit -m "docs: lock stage1 deployment to active payment"
```

---

### Task 8: Verify the complete active-payment-only baseline

**Files:**

- Verify only; do not add unrelated fixes to the branch.

- [ ] **Step 1: Run all focused regression tests**

```powershell
pnpm stage1:auto-debit-retirement:test
pnpm stage1:golden-path:preflight:test
pnpm --filter @subscription-saas/api exec vitest run test/auto-debit-config.spec.ts test/auto-debit-production-safety.spec.ts test/auto-debit-controller.spec.ts test/stage1-active-payment-baseline.spec.ts test/billing-automation-controller.spec.ts test/billing-automation-service.spec.ts test/billing-automation-worker.spec.ts test/portal-payment.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/stage1-active-payment-portal.spec.tsx test/portal-bill-card.spec.tsx test/auto-debit-admin-ui.spec.tsx test/billing-automation-view-model.spec.ts test/deployment-ops-safety.spec.ts
```

Expected: all commands PASS.

- [ ] **Step 2: Run static retirement assertions**

```powershell
rg -n "AUTO_DEBIT_ENABLED=true|AUTO_DEBIT_ENABLED:\s*\$\{[^}]*:-true|PAYMENT_MANDATE_PROVIDER=mock|PAYMENT_MANDATE_PROVIDER:\s*\$\{[^}]*:-mock|PAYMENT_MANDATE_MOCK_ENABLED=true" .env.example .env.production.images.example .env.staging.images.example apps/api/.env.example docker-compose.production.images.example.yml docker-compose.staging.images.example.yml
rg -n "getPortalAutoDebitAvailability|getPortalPaymentMandates|getPortalDebitAttempts|createPortalPaymentMandate|revokePortalPaymentMandate|PortalAutoDebitStatusCard" apps/web/src
rg -n "AUTO_DEBIT_WECHAT_PROVIDER_NOT_IMPLEMENTED" apps/api/src
```

Expected: all three commands produce no matches.

- [ ] **Step 3: Run schema, type, lint, and full test gates**

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
pnpm -r lint
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
```

Expected: all commands PASS.

- [ ] **Step 4: Recheck migration status without mutating the database**

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected: migrations are up to date. If the dedicated test database remains unreachable, report the exact credential/connectivity blocker separately; do not claim database verification passed.

- [ ] **Step 5: Run a database-backed retirement dry-run**

With the approved target database configured:

```powershell
pnpm stage1:auto-debit-retirement:dry-run
```

Expected: the command returns safe JSON, leaks no database URL, and reports `blockedProcessingCount: 0`. Archive the report before apply. Do not run `--apply` outside the approved release window.

- [ ] **Step 6: Inspect the final diff boundary**

```powershell
git status --short
git diff --check
git log --oneline -8
```

Expected: no whitespace errors; only planned files are changed by these commits; the pre-existing user-owned dirty paths remain unstaged and unmodified by this plan.

- [ ] **Step 7: Produce the implementation handoff**

Report:

- focused/full test counts and commands;
- Prisma validation and migration-status results separately;
- the retirement dry-run report location and whether apply was intentionally deferred;
- confirmation that recurring billing/dunning and JSAPI active payment remain enabled;
- confirmation that no customer/admin mutation surface or worker claim path remains;
- confirmation that historical mandates, attempts, settlements, and audit facts were preserved.
