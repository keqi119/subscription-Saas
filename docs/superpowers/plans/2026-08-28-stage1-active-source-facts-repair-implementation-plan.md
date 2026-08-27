# Stage 1 Active Source Facts Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authoritative delivery activation atomically establish original contract-performance facts, repair only provable historical gaps, and keep one anomalous order from stopping healthy billing maintenance.

**Architecture:** Add a small Shanghai calendar unit and transaction-local BASE-segment interface, then compose them with the existing caller-owned `AssetFactsService` transaction during lease activation. A separate dry-run-first repair CLI reconstructs only order dates and already-existing signed-contract archive/binding facts; existing BASE and Stage 1C tools remain the downstream materializers. Billing reconciliation classifies contract fact errors per order while still throwing infrastructure errors.

**Tech Stack:** TypeScript 6, NestJS 11, Prisma 7/PostgreSQL, Vitest 4, Node.js test runner, Next.js 16, React 19, Ant Design 6, pnpm 11, Docker.

**Spec:** `docs/superpowers/specs/2026-08-28-stage1-active-source-facts-repair-design.zh-CN.md`

## Global Constraints

- Use the isolated worktree branch `fix/stage1-active-source-facts-repair`; do not touch the dirty main checkout or its Docker mirror edits.
- Do not write business code until `prisma validate` passes and migration status is recorded. Local status may remain unavailable only because `DATABASE_URL` is absent; Staging status must remain 109/109 before any data apply.
- `actualDeliveryAt` and authoritative handover `completedAt` must be the same instant; all contract-performance dates use `Asia/Shanghai` calendar parts.
- `endDate = addCalendarMonths(startDate, periodMonths) - 1 day`, with clamped month ends.
- Never infer a start from order creation, customer confirmation, final-plan confirmation, or manual free text.
- Never overwrite a non-null date, contract binding, segment, period, or bill that differs from the provable value.
- Existing `SubscriptionOrder.endDate`, archived main contract, confirmed quote, and created contract segments remain immutable after the source fact is established.
- Known contract-data errors fail closed per order; database, transaction, or unknown programming errors still fail the whole maintenance call.
- Critical repairs write audit logs; public reports and logs contain no customer PII, database URL, storage credentials, or e-sign access parameters.
- Every production change follows RED -> minimal GREEN -> focused regression -> commit.
- No historical `--apply` is authorized by implementation approval. Stop after clean dry-runs and request a separate explicit approval for each apply stage.

---

### Task 1: Shanghai original-performance calendar

**Files:**
- Create: `apps/api/src/lease/subscription-performance-calendar.ts`
- Test: `apps/api/test/subscription-performance-calendar.spec.ts`

**Interfaces:**
- Produces: `deriveOriginalSubscriptionPeriod(activatedAt: Date, periodMonths: number): { startDate: Date; endDate: Date }`.
- Produces: UTC-midnight `Date` values that encode Shanghai business dates for Prisma `@db.Date` fields.
- Consumes: no NestJS or Prisma dependency.

- [ ] **Step 1: Write failing calendar tests**

```ts
import { describe, expect, it } from "vitest";
import { deriveOriginalSubscriptionPeriod } from "../src/lease/subscription-performance-calendar";

describe("deriveOriginalSubscriptionPeriod", () => {
  it("uses the Shanghai date across a UTC boundary", () => {
    expect(
      deriveOriginalSubscriptionPeriod(new Date("2026-08-25T19:53:26.694Z"), 12)
    ).toEqual({
      startDate: new Date("2026-08-26T00:00:00.000Z"),
      endDate: new Date("2027-08-25T00:00:00.000Z")
    });
  });

  it("clamps month ends before subtracting the inclusive final day", () => {
    expect(
      deriveOriginalSubscriptionPeriod(new Date("2024-01-31T04:00:00.000Z"), 1)
    ).toEqual({
      startDate: new Date("2024-01-31T00:00:00.000Z"),
      endDate: new Date("2024-02-28T00:00:00.000Z")
    });
  });

  it.each([0, -1, 1.5])("rejects invalid periodMonths %s", (periodMonths) => {
    expect(() => deriveOriginalSubscriptionPeriod(new Date(), periodMonths)).toThrow(
      "SUBSCRIPTION_PERIOD_MONTHS_INVALID"
    );
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-performance-calendar.spec.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure calendar**

```ts
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function deriveOriginalSubscriptionPeriod(activatedAt: Date, periodMonths: number) {
  assertDate(activatedAt);
  if (!Number.isSafeInteger(periodMonths) || periodMonths <= 0) {
    throw new RangeError("SUBSCRIPTION_PERIOD_MONTHS_INVALID");
  }
  const shifted = new Date(activatedAt.getTime() + SHANGHAI_OFFSET_MS);
  const startDate = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  );
  const exclusiveEnd = addMonthsClampedUtc(startDate, periodMonths);
  return { startDate, endDate: addDaysUtc(exclusiveEnd, -1) };
}
```

Implement private `assertDate`, `addMonthsClampedUtc`, and `addDaysUtc` using UTC calendar parts. Do not use local machine timezone methods.

- [ ] **Step 4: Run GREEN and regression**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-performance-calendar.spec.ts test/billing-automation-calendar.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/lease/subscription-performance-calendar.ts apps/api/test/subscription-performance-calendar.spec.ts
git commit -m "feat: add subscription performance calendar"
```

---

### Task 2: Transaction-local BASE segment establishment

**Files:**
- Modify: `apps/api/src/subscription-change/contract-segment.service.ts`
- Modify: `apps/api/src/subscription-change/subscription-change.errors.ts`
- Modify: `apps/api/test/contract-segment.service.spec.ts`
- Modify: `apps/api/test/contract-segment.integration.spec.ts`

**Interfaces:**
- Produces: `ensureBaseSegmentInTransaction(tx: Prisma.TransactionClient, orderId: string, actorId?: string): Promise<SubscriptionContractSegment>`.
- Preserves: `ensureBaseSegment(orderId, actorId?)`, which wraps the new interface in a Serializable transaction and locks the order.
- Guarantees: an existing BASE row is returned only if all immutable source fields match the current archived contract/order authority.

- [ ] **Step 1: Add failing unit tests for caller-owned transaction and conflict detection**

Add tests equivalent to:

```ts
it("establishes BASE inside the caller-owned transaction", async () => {
  const harness = createHarness();
  await expect(
    harness.service.ensureBaseSegmentInTransaction(harness.tx as never, "order-1", "actor-1")
  ).resolves.toMatchObject({ segmentType: "BASE", sequenceNo: 1 });
  expect(harness.transactionCalls).toBe(0);
});

it("fails closed when an existing BASE differs from the order authority", async () => {
  const harness = createHarness({
    existingBase: { monthlyFeeAmount: 1n }
  });
  await expect(
    harness.service.ensureBaseSegmentInTransaction(harness.tx as never, "order-1")
  ).rejects.toMatchObject({ code: "CONTRACT_SEGMENT_SOURCE_CONFLICT" });
});
```

Extend `ContractSegmentErrorCode` with `CONTRACT_SEGMENT_SOURCE_CONFLICT` and assert mismatches for source contract, dates, commercial terms, snapshots, and status.

- [ ] **Step 2: Run RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/contract-segment.service.spec.ts
```

Expected: FAIL because the transaction-local method and conflict code do not exist.

- [ ] **Step 3: Extract the transaction-local implementation**

Use this public shape:

```ts
async ensureBaseSegment(orderId: string, actorId?: string) {
  return this.serializable(async (tx) => {
    await lockOrder(tx, orderId);
    return this.ensureBaseSegmentInTransaction(tx, orderId, actorId);
  });
}

async ensureBaseSegmentInTransaction(
  tx: Prisma.TransactionClient,
  orderId: string,
  actorId?: string
) {
  const order = await tx.subscriptionOrder.findUnique({
    include: { contract: true },
    where: { id: orderId }
  });
  if (!order) throw new ContractSegmentError("ORDER_NOT_FOUND", "...");
  assertBaseSourceComplete(order);
  const existing = await tx.subscriptionContractSegment.findFirst({
    where: { orderId, segmentType: ContractSegmentType.BASE }
  });
  if (existing) {
    assertBaseMatchesAuthority(existing, order);
    return existing;
  }
  return createBaseSegment(tx, order, actorId);
}
```

Use canonical deep equality for JSON snapshots so key order cannot create a false mismatch. The transaction-local method assumes the caller already owns the order lock; do not open a nested transaction.

- [ ] **Step 4: Run GREEN and integration regression**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/contract-segment.service.spec.ts test/contract-segment.integration.spec.ts
```

Expected: PASS, including idempotent replay.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/subscription-change/contract-segment.service.ts apps/api/src/subscription-change/subscription-change.errors.ts apps/api/test/contract-segment.service.spec.ts apps/api/test/contract-segment.integration.spec.ts
git commit -m "refactor: establish base segment in caller transaction"
```

---

### Task 3: Atomic authoritative delivery fact closure

**Files:**
- Modify: `apps/api/src/lease/lease-activation.engine.ts`
- Modify: `apps/api/src/lease/lease.module.ts`
- Modify: `apps/api/test/lease-activation.spec.ts`
- Modify: `apps/api/test/order-delivery.spec.ts`
- Modify: `apps/api/test/vehicle-availability.integration.spec.ts`

**Interfaces:**
- Consumes: `deriveOriginalSubscriptionPeriod` from Task 1.
- Consumes: `ContractSegmentService.ensureBaseSegmentInTransaction` from Task 2.
- Consumes: `AssetFactsService.prepareCallerOwnedTransaction` and `openSubscriptionPeriodInTransaction`.
- Produces: activation result/audit fields `startDate`, `endDate`, `baseSegmentId`, and `subscriptionPeriodId`.

- [ ] **Step 1: Add failing activation tests**

Extend the lease activation harness with an archived main contract, final-plan/quote snapshots, contract segments, subscription periods, and injected asset-fact/segment services. Assert:

```ts
expect(harness.state.order).toMatchObject({
  actualDeliveryAt: activatedAt,
  startDate: new Date("2026-08-26T00:00:00.000Z"),
  endDate: new Date("2027-08-25T00:00:00.000Z"),
  orderStatus: OrderStatus.ACTIVE
});
expect(harness.contractSegments).toHaveLength(1);
expect(harness.subscriptionPeriods).toEqual([
  expect.objectContaining({
    contractSegmentId: harness.contractSegments[0]!.id,
    reason: VehicleSubscriptionPeriodStartReason.DELIVERY_CONFIRMED,
    startedAt: activatedAt
  })
]);
```

Add a replay test proving one segment/period, and a failure-injection test after BASE creation proving the caller transaction rolls back every activation fact.

- [ ] **Step 2: Run RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/lease-activation.spec.ts test/order-delivery.spec.ts
```

Expected: FAIL because activation does not write dates, BASE, or the period.

- [ ] **Step 3: Wire modules and dependencies**

Import `AssetFactsModule` and `ContractSegmentModule` in `LeaseModule`. Inject `AssetFactsService` and `ContractSegmentService` into `LeaseActivationEngine` as required dependencies, not optional dependencies.

- [ ] **Step 4: Establish all facts before committing ACTIVE**

Inside `activateFromAuthoritativeHandover`, derive dates before the order update, then:

```ts
const { startDate, endDate } = deriveOriginalSubscriptionPeriod(
  activatedAt,
  facts.order.periodMonths
);
const order = await tx.subscriptionOrder.update({
  data: {
    actualDeliveryAt: activatedAt,
    startDate,
    endDate,
    orderStatus: OrderStatus.ACTIVE,
    updatedBy: actorId
  },
  where: { id: input.orderId }
});
const segment = await this.contractSegmentService.ensureBaseSegmentInTransaction(
  tx,
  order.id,
  actorId
);
const source = {
  id: facts.delivery.id,
  key: `authoritative-delivery:${facts.delivery.id}:subscription-open`,
  type: "VEHICLE_DELIVERY"
};
const capability = await this.assetFactsService.prepareCallerOwnedTransaction(
  tx,
  "subscription",
  "start",
  source
);
const subscriptionPeriod = await this.assetFactsService.openSubscriptionPeriodInTransaction(
  tx,
  {
    confirmedAt: activatedAt.toISOString(),
    contractId: order.contractId,
    contractSegmentId: segment.id,
    customerId: order.customerId,
    orderId: order.id,
    reason: VehicleSubscriptionPeriodStartReason.DELIVERY_CONFIRMED,
    snapshot: { deliveryId: facts.delivery.id, handoverId: facts.handover.id },
    source,
    startedAt: activatedAt.toISOString(),
    vehicleId: order.vehicleId!
  },
  { actorId },
  capability
);
```

Keep these operations inside the existing delivery transaction and before journey completion. Add only IDs/dates to the activation audit payload.

- [ ] **Step 5: Run GREEN and delivery regressions**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-performance-calendar.spec.ts test/contract-segment.service.spec.ts test/lease-activation.spec.ts test/order-delivery.spec.ts test/subscription-journey-golden-path.e2e-spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/api/src/lease apps/api/test/lease-activation.spec.ts apps/api/test/order-delivery.spec.ts
git commit -m "fix: close delivery activation source facts"
```

---

### Task 4: Historical source-fact classifier

**Files:**
- Create: `scripts/stage1-active-source-facts-repair-core.mjs`
- Create: `scripts/stage1-active-source-facts-repair-core.test.mjs`

**Interfaces:**
- Produces: `parseStage1ActiveSourceFactsRepairArgs(args)`.
- Produces: `classifyStage1ActiveSourceFactsRepair(snapshot)` returning `{ candidates, exceptions, unchanged, summary }`.
- Candidate actions: `SET_ORDER_DATES`, `ARCHIVE_CONTRACT`, and `BIND_CONTRACT`.
- Stable exception codes: `ACTIVATION_EVIDENCE_MISSING`, `ACTIVATION_EVIDENCE_AMBIGUOUS`, `ACTIVATION_TIMESTAMP_CONFLICT`, `ACTIVATION_IDENTITY_MISMATCH`, `ORDER_DATE_PARTIAL`, `ORDER_DATE_CONFLICT`, `CONTRACT_AUTHORITY_MISSING`, `CONTRACT_AUTHORITY_AMBIGUOUS`, `SIGNED_ARTIFACT_INCOMPLETE`, `SIGNED_ARTIFACT_MISMATCH`, `CONTRACT_TIMELINE_INVALID`, and `DOWNSTREAM_FACTS_ALREADY_PRESENT`.

- [ ] **Step 1: Write the classifier tests first**

Cover at least these literal cases:

```js
test("classifies a provable combined date, archive, and binding repair", () => {
  const report = classifyStage1ActiveSourceFactsRepair(
    snapshot({ contractId: null, contractStatus: "SIGNED", dates: null })
  );
  assert.deepEqual(report.candidates[0].actions, [
    "ARCHIVE_CONTRACT",
    "BIND_CONTRACT",
    "SET_ORDER_DATES"
  ]);
  assert.equal(report.candidates[0].startDate, "2026-08-26");
  assert.equal(report.candidates[0].endDate, "2027-08-25");
});

test("fails closed on a one-day activation conflict", () => {
  const input = snapshot();
  input.orders[0].lease.activatedAt = "2026-08-26T03:53:26.694Z";
  assert.equal(
    classifyStage1ActiveSourceFactsRepair(input).exceptions[0].code,
    "ACTIVATION_TIMESTAMP_CONFLICT"
  );
});
```

Also test: two viable contracts, two completed Stage 1 tasks, task/file object-key mismatch, missing PDF, `signedAt > completedAt`, partial dates, conflicting dates, existing segment/period, healthy unchanged order, deterministic source ordering, and output without raw object keys.

- [ ] **Step 2: Run RED**

```powershell
node --test scripts/stage1-active-source-facts-repair-core.test.mjs
```

Expected: FAIL because the core module does not exist.

- [ ] **Step 3: Implement pure classification**

Use only plain objects and deterministic sort keys. Derive Shanghai dates with an internal pure helper matching Task 1 semantics. A viable contract must satisfy:

```js
const viable =
  ["SIGNED", "ARCHIVED"].includes(contract.status) &&
  timestamp(contract.signedAt) &&
  isJsonObject(contract.contractSnapshot) &&
  tasks.length === 1 &&
  tasks[0].taskStatus === "COMPLETED" &&
  tasks[0].signingStage === "STAGE1_SUBSCRIPTION_CONTRACT" &&
  tasks[0].documentType === "SUBSCRIPTION_CONTRACT" &&
  timestamp(tasks[0].completedAt) &&
  file?.mimeType === "application/pdf" &&
  typeof file?.sizeBytes === "bigint" &&
  file.sizeBytes > 0n &&
  file.objectKey === tasks[0].signedDocumentObjectKey;
```

Hash canonical evidence identifiers/object keys with SHA-256 and return only `evidenceDigest`. If the order already has a contract segment or vehicle period while a parent source repair is needed, emit `DOWNSTREAM_FACTS_ALREADY_PRESENT`.

- [ ] **Step 4: Run GREEN**

```powershell
node --test scripts/stage1-active-source-facts-repair-core.test.mjs
```

Expected: PASS with no database dependency.

- [ ] **Step 5: Commit**

```powershell
git add scripts/stage1-active-source-facts-repair-core.mjs scripts/stage1-active-source-facts-repair-core.test.mjs
git commit -m "feat: classify active source fact repairs"
```

---

### Task 5: Historical repair executor and CLI

**Files:**
- Create: `scripts/stage1-active-source-facts-repair-executor.mjs`
- Create: `scripts/stage1-active-source-facts-repair-executor.test.mjs`
- Create: `scripts/stage1-active-source-facts-repair.mjs`
- Create: `scripts/stage1-active-source-facts-repair.test.mjs`
- Modify: `package.json`
- Modify: `scripts/subscription-segment-bootstrap-core.mjs`
- Modify: `scripts/subscription-segment-bootstrap-apply.test.mjs`

**Interfaces:**
- Produces: `executeStage1ActiveSourceFactsRepair({ mode, prisma, generatedAt, loadSnapshot, classify })` returning `{ exitCode, report }`.
- Produces package scripts `stage1:active-source-facts:dry-run`, `stage1:active-source-facts:apply`, and `stage1:active-source-facts:test`.
- Apply confirmation: `STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_APPLY=1` exactly.
- Adds one audit row for each changed `contract` and `subscription_order`.
- Adds one `subscription_contract_segment` audit row when the existing BASE bootstrap creates a segment.

- [ ] **Step 1: Write failing executor tests**

Tests must prove:

```js
test("dry-run uses RepeatableRead and performs zero writes", async () => {
  const result = await executeStage1ActiveSourceFactsRepair({ mode: "dry-run", prisma });
  assert.equal(result.exitCode, 0);
  assert.equal(writes.length, 0);
  assert.equal(transactionOptions.isolationLevel, "RepeatableRead");
});

test("apply locks, reloads, updates authority, and audits atomically", async () => {
  const result = await executeStage1ActiveSourceFactsRepair({ mode: "apply", prisma });
  assert.equal(result.exitCode, 0);
  assert.equal(contract.status, "ARCHIVED");
  assert.equal(order.contractId, contract.id);
  assert.deepEqual(audits.map((row) => row.entityType).sort(), [
    "contract",
    "subscription_order"
  ]);
});
```

Also prove unsafe apply is read-only/nonzero, a stale candidate aborts all writes, a later audit failure rolls back all writes, concurrent/replayed apply is idempotent, and snapshots never contain raw object keys or credentials.

- [ ] **Step 2: Write failing CLI tests**

Assert strict mode parsing, optional output, awaited stdout, credential-safe public errors, exact apply confirmation, nonzero blockers, and `$disconnect()` in `finally`.

- [ ] **Step 3: Run RED**

```powershell
node --test scripts/stage1-active-source-facts-repair-executor.test.mjs scripts/stage1-active-source-facts-repair.test.mjs
```

Expected: FAIL because executor and CLI do not exist.

- [ ] **Step 4: Implement snapshot loading and atomic apply**

The loader must explicitly select only fields used by the classifier from `SubscriptionOrder`, `VehicleDelivery`, `Lease`, `Contract`, `ContractESignTask`, `FileObject`, `SubscriptionContractSegment`, and `VehicleSubscriptionPeriod`, ordered by ID.

For apply:

```js
await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', APPLY_LOCK_KEY);
await tx.$queryRawUnsafe(`
  LOCK TABLE subscription_order, contract, contract_esign_task,
    file_object, vehicle_delivery, lease, subscription_contract_segment,
    vehicle_subscription_period IN SHARE ROW EXCLUSIVE MODE NOWAIT
`);
const classification = classify(await loadSnapshot(tx));
if (!isClean(classification)) return blockedResult(classification);
```

Update only fields named by candidate actions. Use `task.completedAt` as `archivedAt`; do not call the e-sign provider. Write audit snapshots with IDs, business numbers, dates/status, action names, and `evidenceDigest` only.

- [ ] **Step 5: Add BASE bootstrap audit**

When `applySubscriptionSegmentBootstrapPlan` creates a BASE row, create an audit entry in the same transaction:

```js
await tx.auditLog.create({
  data: {
    action: "CREATE",
    afterSnapshot: jsonSnapshot(winner),
    entityId: winner.id,
    entityType: "subscription_contract_segment",
    module: "subscription_change",
    operatorId: undefined
  }
});
```

Do not audit an idempotent replay. Extend the apply test to prove audit rollback and replay behavior.

- [ ] **Step 6: Implement CLI and package scripts**

The CLI should follow the credential-safe Stage 1C pattern and require:

```js
if (mode === "apply" && process.env.STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_APPLY !== "1") {
  throw new Error("STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_APPLY_CONFIRMATION_REQUIRED");
}
```

- [ ] **Step 7: Run GREEN and downstream script regression**

```powershell
pnpm stage1:active-source-facts:test
node --test scripts/subscription-segment-bootstrap-core.test.mjs scripts/subscription-segment-bootstrap-apply.test.mjs scripts/stage1c-period-backfill-core.test.mjs scripts/stage1c-period-backfill-executor.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add package.json scripts/stage1-active-source-facts-repair*.mjs scripts/subscription-segment-bootstrap-core.mjs scripts/subscription-segment-bootstrap-apply.test.mjs
git commit -m "feat: add audited active source fact repair"
```

---

### Task 6: Per-order billing reconciliation isolation

**Files:**
- Modify: `apps/api/src/billing-automation/billing-automation.service.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.worker.ts`
- Modify: `apps/web/src/app/billing/monthly-rent/page.tsx`
- Modify: `apps/api/test/billing-automation-service.spec.ts`
- Modify: `apps/api/test/billing-automation-worker.spec.ts`

**Interfaces:**
- Reconciliation item action becomes `"EXISTING" | "CREATED" | "WOULD_CREATE" | "BLOCKED"`.
- A blocked item contains `blockerCode`, `nextPeriodStart`, `orderId`, and `orderNo`, with amount/baseline fields set to safe nulls.
- Reconciliation result adds `blockedCount` while preserving existing counts and items.
- Worker logs one `BILLING_SCHEDULE_RECONCILIATION_BLOCKED` warning per maintenance interval with counts/codes only.

- [ ] **Step 1: Add failing mixed-order service test**

Build a harness with one healthy order and one order whose resolver throws:

```ts
new ContractSegmentError(
  "CONTRACT_SEGMENT_NOT_FOUND",
  "No effective contract segment contains the billing period start."
)
```

Assert the result has one `BLOCKED` and one `WOULD_CREATE/CREATED`, the blocked order receives no Lease/Schedule write, and `blockedCount === 1`.

- [ ] **Step 2: Add failing infrastructure-error test**

Make `resolveSegmentForPeriod` throw `new Error("database unavailable")` and assert `reconcileSchedules` rejects. This prevents accidental swallowing of system failures.

- [ ] **Step 3: Add failing worker continuation/logging test**

Mock reconciliation to return one blocked item. Assert `enqueueDueSchedules`, job claim, and job handling still run, while `Logger.warn` receives only:

```ts
{
  blockedCount: 1,
  blockerCodes: ["CONTRACT_SEGMENT_NOT_FOUND"],
  operation: "BILLING_SCHEDULE_RECONCILIATION_BLOCKED"
}
```

- [ ] **Step 4: Run RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/billing-automation-service.spec.ts test/billing-automation-worker.spec.ts
```

Expected: FAIL because a business blocker currently aborts reconciliation.

- [ ] **Step 5: Implement narrow business-error classification**

Catch only `ContractSegmentError` codes that represent per-order source facts:

```ts
const RECONCILIATION_BLOCKER_CODES = new Set([
  "CONTRACT_SEGMENT_NOT_FOUND",
  "BILLING_PERIOD_CROSSES_SEGMENT",
  "CONTRACT_SEGMENT_INVALID_DATE_RANGE"
]);
```

Place both effective-end and amount resolution inside the per-order guarded block. Push a `BLOCKED` item and continue. Do not activate a Lease or create a Schedule before both lookups succeed.

- [ ] **Step 6: Display blockers in Admin**

Extend `ReconcileItem/ReconcileResult`, add an action tag for `BLOCKED`, show `blockerCode`, and include `阻断 ${blockedCount} 单` in the summary. Apply results containing blockers use warning presentation rather than success-only presentation.

- [ ] **Step 7: Run GREEN and UI typecheck**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/billing-automation-service.spec.ts test/billing-automation-worker.spec.ts test/billing-automation-controller.spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add apps/api/src/billing-automation apps/api/test/billing-automation-service.spec.ts apps/api/test/billing-automation-worker.spec.ts apps/web/src/app/billing/monthly-rent/page.tsx
git commit -m "fix: isolate billing reconciliation blockers"
```

---

### Task 7: Runtime packaging and release runbook

**Files:**
- Modify: `Dockerfile.api`
- Modify: `apps/api/test/api-runtime-media.spec.ts`
- Modify: `docs/runbooks/stage1-active-term-contract-change-release.md`

**Interfaces:**
- API runtime contains every script needed for source repair, BASE bootstrap, Stage 1C period backfill, and contract-change bootstrap.
- Runbook includes exact dry-run/apply/replay commands, exit semantics, backup gate, flag gate, and stop points.

- [ ] **Step 1: Add failing runtime packaging assertions**

Expand the expected script list to include:

```ts
[
  "stage1-active-source-facts-repair-core.mjs",
  "stage1-active-source-facts-repair-executor.mjs",
  "stage1-active-source-facts-repair.mjs",
  "subscription-segment-bootstrap-core.mjs",
  "subscription-segment-bootstrap.mjs",
  "stage1c-period-backfill-core.mjs",
  "stage1c-period-backfill-executor.mjs",
  "stage1c-period-backfill.mjs",
  "stage1-contract-change-bootstrap-core.mjs",
  "stage1-contract-change-bootstrap.mjs"
]
```

- [ ] **Step 2: Run RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/api-runtime-media.spec.ts
```

Expected: FAIL on missing runtime COPY entries.

- [ ] **Step 3: Package the operational scripts**

Add explicit `COPY --from=build` lines for every listed script. Do not copy the whole repository or test fixtures into runtime.

- [ ] **Step 4: Update the release runbook**

Document these exact gates:

1. migration status/checksum;
2. fresh DB backup and SHA-256;
3. source facts dry-run report and explicit apply approval;
4. source facts apply/replay;
5. BASE dry-run and explicit apply approval;
6. BASE apply/replay;
7. Stage 1C dry-run and explicit apply approval;
8. Stage 1C apply/replay;
9. contract-change bootstrap dry-run;
10. all four exact feature flags; worker log observation; four-type smoke.

State that exit 1/2 or any blocker stops release and that no data apply is implied by code/PR approval.

- [ ] **Step 5: Run GREEN and Dockerfile regression**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/api-runtime-media.spec.ts
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add Dockerfile.api apps/api/test/api-runtime-media.spec.ts docs/runbooks/stage1-active-term-contract-change-release.md
git commit -m "fix: package active source repair tooling"
```

---

### Task 8: Full verification, PR, merge, and Staging handoff

**Files:**
- Modify only if verification exposes an in-scope defect; use a new RED test before each fix.

**Interfaces:**
- Produces: one merged main commit with green CI and a handoff containing the exact image tag to build/pull.
- Stops: before Staging deployment or any historical data apply until the user reports the new image is pulled and separately approves each apply.

- [ ] **Step 1: Re-run required preflight**

```powershell
git status --short
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm prisma:validate
```

Expected: schema valid. If local migration status lacks `DATABASE_URL`, record the exact failure and verify 109/109 plus checksums against Staging read-only before completion.

- [ ] **Step 2: Run all focused repair tests**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-performance-calendar.spec.ts test/contract-segment.service.spec.ts test/contract-segment.integration.spec.ts test/lease-activation.spec.ts test/order-delivery.spec.ts test/billing-automation-service.spec.ts test/billing-automation-worker.spec.ts test/billing-automation-controller.spec.ts test/api-runtime-media.spec.ts
pnpm stage1:active-source-facts:test
node --test scripts/subscription-segment-bootstrap-core.test.mjs scripts/subscription-segment-bootstrap-apply.test.mjs scripts/stage1c-period-backfill-core.test.mjs scripts/stage1c-period-backfill-executor.test.mjs scripts/stage1-contract-change-bootstrap.test.mjs
```

Expected: all PASS.

- [ ] **Step 3: Run the full local quality gate**

```powershell
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
pnpm -r build
git diff --check
git status --short --branch
```

Expected: every command exits 0 and the worktree contains no uncommitted files.

- [ ] **Step 4: Use verification-before-completion and request code review**

Review the complete branch diff against the spec, verify no PII/secrets, no fallback billing authority, no unapproved data mutation, and no unrelated changes. Resolve every actionable finding with RED/GREEN evidence.

- [ ] **Step 5: Push branch and create PR**

```powershell
git push -u origin fix/stage1-active-source-facts-repair
$prBody = @"
## Summary
- close future delivery activation dates, BASE segment, and vehicle period atomically
- add dry-run-first audited repair for provable historical source facts
- isolate per-order contract blockers from healthy billing maintenance
- package the complete repair toolchain in the API runtime image

## Safety boundary
- no Staging or Production data apply is performed by this PR
- every historical apply requires a clean dry-run and separate explicit approval

## Verification
- focused repair suites
- API/Web lint, typecheck, tests, and build
- Prisma validation and migration/checksum evidence
"@
gh pr create --base main --head fix/stage1-active-source-facts-repair --title "fix: repair active subscription source facts" --body $prBody
```

The PR body must summarize root cause, future atomic closure, historical fail-closed rules, billing isolation, tests, migration status, and the explicit no-apply boundary.

- [ ] **Step 6: Wait for PR CI and merge only when green**

```powershell
$prNumber = gh pr view fix/stage1-active-source-facts-repair --json number --jq .number
gh pr checks $prNumber --watch
gh pr merge $prNumber --merge --delete-branch=false
gh run list --branch main --limit 5
```

Expected: PR merged and latest main CI all green.

- [ ] **Step 7: Notify the user to build and pull images**

Compute the exact tag with `$tag = "Staging-$((Get-Date).ToString('yyyyMMdd'))-$(git rev-parse --short=7 origin/main)"` and provide it with the merged main SHA. Do not build/pull the image on behalf of the user because the standing deployment workflow assigns that step to the user.

- [ ] **Step 8: After the user reports image pull, run deployment preflight only**

Verify image digests, 109/109 migrations, checksums, fresh backup, explicit four flags, and source-facts `--dry-run`. Preserve the report and stop for explicit source-facts apply approval even if the report is clean.

---

## Completion Evidence

The implementation handoff must include:

- branch, commits, PR, merge SHA, and main CI URL;
- changed files and the business behavior of each task;
- focused/full test counts and exact failing/skipped gates;
- local and Staging migration/checksum status kept distinct;
- dry-run report paths and SHA-256 values;
- backup path, size, mode, and SHA-256 before any apply;
- feature-flag values and worker-log observation window;
- the explicit next approval required, with no claim that historical repair has been applied.
