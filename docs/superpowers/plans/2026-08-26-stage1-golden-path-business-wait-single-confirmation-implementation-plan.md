# Stage 1 Golden Path Business-Wait and Single-Confirmation Implementation Plan

> **Execution rule:** The primary agent executes this plan directly. Do not spawn subagents or parallel implementation workers. Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before opening the PR.

**Goal:** Fix `ACC-20260825-01` through `ACC-20260825-03` so normal application review is a recoverable business wait, application-fact signals cannot be misrouted, and Admin atomically publishes one vehicle-backed final-plan revision that the customer confirms once.

**Architecture:** Keep the current `SubscriptionJourney` aggregate and outbox/worker. Replace exception-driven readiness with a structured validation result, persist monotonically increasing application fact versions, and make signal dispatch target-aware. Reorder vehicle allocation before customer confirmation and combine plan decision plus soft reservation into one Admin command. Use one canonical commercial snapshot/hash implementation in both idempotency and plan-change comparison. Migrate/reconcile only affected in-flight journeys; completed journeys remain immutable.

**Tech stack:** NestJS 11, Prisma 7, PostgreSQL 16, TypeScript 6, Vitest 4, Next.js 16, React 19, Ant Design 6, pnpm workspace.

**Approved design:** `docs/superpowers/specs/2026-08-26-stage1-golden-path-business-wait-and-single-confirmation-design.zh-CN.md`

**Base:** commit `8a036c3` on `fix/stage1-acceptance-round1-remediation-20260826`.

## Binding invariants

- `WAITING_MANUAL`, `WAITING_CUSTOMER`, and explicit rejection are business outcomes, never dead-letter errors.
- Domain signals declare their target step and fact version. A stale signal cannot schedule work for a later current step.
- Admin final-plan publication includes vehicle soft reservation and publishes only after both succeed.
- The normal path has no separate Admin `FINAL_VEHICLE_ALLOCATION` action after customer confirmation.
- Object-key ordering never creates a commercial revision. A deliberate commercial change still creates a new revision and invalidates the old customer confirmation.
- Exact command replay is idempotent; payload drift fails closed.
- Forward-only migrations only. Do not edit historical migrations, use `prisma db push`, or reset a database.

---

## Task A0: Capture the failing acceptance behavior and baseline

**Files:**

- Modify `apps/api/test/subscription-journey-application.spec.ts`.
- Modify `apps/api/test/subscription-journey-worker.spec.ts`.
- Modify `apps/api/test/subscription-journey-golden-path.e2e-spec.ts`.
- Modify `apps/web/test/subscription-journey-golden-path.spec.tsx`.

**Steps:**

1. Add a RED test proving a submitted application with pending manual reviews returns a business wait and does not invoke `deadLetterJob`.
2. Add a RED test proving an `APPLICATION_FACTS_CHANGED` event consumed after the Journey has advanced cannot open a task or enqueue a job for the later step.
3. Add a RED E2E scenario matching `APP20260825134151PYGE`: submit, complete material/credit/deposit facts, Admin publishes the final plan, customer confirms once, and the next step is contract creation.
4. Add a RED Web test proving the vehicle-confirmation card/button does not appear after customer confirmation in the normal path.
5. Run:

   ```bash
   pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-application.spec.ts test/subscription-journey-worker.spec.ts test/subscription-journey-golden-path.e2e-spec.ts
   pnpm --filter @subscription-saas/web exec vitest run test/subscription-journey-golden-path.spec.tsx
   ```

6. Confirm failures are behavioral assertions, not fixture/type failures.
7. Commit the RED tests separately.

## Task A1: Add canonical Journey JSON and commercial snapshot hashing

**Files:**

- Add `apps/api/src/subscription-journey/subscription-journey-json.ts`.
- Add `apps/api/test/subscription-journey-json.spec.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey.repository.ts`.
- Modify `apps/api/src/customer/customer.service.ts`.
- Modify `apps/api/test/application-review-api.spec.ts`.

**Steps:**

1. Write RED tests for recursive object-key normalization, array-order preservation, `null` handling, unsupported non-JSON values, and stable `sha256:` hashing.
2. Export narrowly scoped functions:

   ```ts
   canonicalJourneyJson(value: unknown): Prisma.InputJsonValue
   sameJourneyJson(left: unknown, right: unknown): boolean
   commercialPlanSnapshot(value: unknown): Prisma.InputJsonObject
   commercialPlanHash(value: unknown): string
   ```

3. Move Repository idempotency comparison to the shared implementation.
4. Replace `commercialPlanChanged` string comparison with semantic snapshot hashes.
5. Assert that PostgreSQL JSONB key reordering is unchanged while price, period, package, entitlement, deposit, vehicle, effective date, or contract version changes are detected.
6. Run the new and affected Repository/application tests and commit.

## Task A2: Persist fact versions, business-wait detail, and commercial hash

**Files:**

- Modify `apps/api/prisma/schema.prisma`.
- Add `apps/api/prisma/migrations/20260826010000_stage1_journey_business_wait/migration.sql`.
- Modify `apps/api/test/subscription-journey-schema.spec.ts`.
- Modify `apps/api/test/subscription-journey-integrity.integration.spec.ts`.

**Data contract:**

- `Application.journeyFactVersion Int @default(0)`.
- `Application.finalPlanCommercialHash String? @db.VarChar(71)` with a `sha256:` shape check.
- `SubscriptionJourney.lastApplicationFactVersion Int @default(0)`.
- `SubscriptionJourneyStep.waitingReasonSnapshot Json?` for customer-safe reason codes and observed fact version.

**Steps:**

1. Write RED schema assertions for columns, defaults, hash check, non-negative fact versions, and `lastApplicationFactVersion <= Application.journeyFactVersion` verification at the service boundary.
2. Add the forward migration without rewriting completed rows.
3. Backfill existing final-plan hashes only when the stored snapshot is valid; leave invalid/missing snapshots `NULL` for runtime reconciliation rather than inventing data.
4. Add rollback-only PostgreSQL constraint proofs.
5. Run `pnpm prisma:validate`, `pnpm prisma:generate`, and the two schema/integration test files.
6. Commit schema and migration.

## Task A3: Replace validation exceptions with a structured readiness result

**Files:**

- Add `apps/api/src/subscription-journey/application-readiness.ts`.
- Modify `apps/api/src/customer/customer.service.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey.service.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey.repository.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey.types.ts`.
- Modify `apps/api/test/subscription-journey-application.spec.ts`.
- Modify `apps/api/test/subscription-journey.repository.spec.ts`.

**Behavior:**

- `validateJourneyApplication` returns `READY`, `WAITING_MANUAL`, `WAITING_CUSTOMER`, or `REJECTED` with stable reason codes and observed fact version.
- Add a Repository transition that atomically records `STEP_WAITING_MANUAL`/`STEP_WAITING_CUSTOMER`, updates `waitingReasonSnapshot`, and does not create an exception or dead-letter job.
- `READY` completes the step; `REJECTED` closes open tasks, records the rejection transition, and invokes the existing safe soft-reservation release path.

**Steps:**

1. Convert existing tests that expected `JOURNEY_APPLICATION_MATERIALS_INCOMPLETE` and `JOURNEY_APPLICATION_CREDIT_NOT_APPROVED` throws into RED readiness-result tests.
2. Implement a pure classifier first, then wire database lookups.
3. Change `validateApplicationJob` to switch on the result and return a completed Job outcome for business waits.
4. Keep invalid database relations, missing application rows, corrupt snapshots, and infrastructure failures as technical errors.
5. Prove the Worker completes the validation job without dead-lettering when the outcome is a business wait.
6. Run targeted API tests and commit.

## Task A4: Make application-fact signaling versioned and target-aware

**Files:**

- Modify `apps/api/src/customer/customer.service.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey.types.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey-signal.service.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey.repository.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey.service.ts`.
- Modify `apps/api/test/application-review-api.spec.ts`.
- Modify `apps/api/test/subscription-journey-application.spec.ts`.
- Modify `apps/api/test/subscription-journey.repository.integration.spec.ts`.

**Steps:**

1. Write RED tests requiring each material/credit/product fact mutation to increment `journeyFactVersion` in the same transaction and publish `{targetStepCode: "APPLICATION_VALIDATION", factType, factVersion, sourceActionId}`.
2. Persist the exact payload and keep event-key idempotency.
3. In `dispatchSignalOutbox`, route `APPLICATION_FACTS_CHANGED` before generic current-step dispatch:
   - current step is validation and version is newer: enqueue one validation job keyed by fact version;
   - current step is later: acknowledge with no side effect;
   - version is stale/equal: acknowledge with no side effect.
4. Advance `lastApplicationFactVersion` only with the committed readiness transition.
5. Prove concurrent fact updates create monotonically increasing versions and no duplicate transition.
6. Run targeted unit/integration tests and commit.

## Task A5: Reorder the final-plan steps and reconcile in-flight Journeys

**Files:**

- Modify `apps/api/src/subscription-journey/subscription-journey-state-machine.ts`.
- Add `scripts/stage1-journey-final-plan-order-reconcile-core.mjs`.
- Add `scripts/stage1-journey-final-plan-order-reconcile.mjs`.
- Add `scripts/stage1-journey-final-plan-order-reconcile.test.mjs`.
- Modify `package.json`.
- Modify `apps/api/test/subscription-journey-state-machine.spec.ts`.
- Modify `apps/api/test/subscription-journey-recovery.spec.ts`.

**Steps:**

1. Write RED transition tests for `FINAL_PLAN_DECISION -> FINAL_VEHICLE_ALLOCATION -> CUSTOMER_PLAN_CONFIRMATION`.
2. Implement the sequence change without altering later Golden Path ordering.
3. Build a dry-run-first reconciliation script for non-terminal Journeys:
   - customer-waiting with vehicle step pending returns to vehicle allocation without losing the pending customer revision;
   - vehicle-allocation after a matching customer confirmation uses the matching commercial hash to avoid requesting another confirmation;
   - mismatched/corrupt records are reported and left unchanged.
4. Require explicit `--apply`, stable row counts, idempotent replay, and no credential logging.
5. Add root scripts `stage1:journey-plan-order:dry-run`, `:apply`, and `:test`.
6. Run state-machine and script tests; commit.

## Task A6: Make final-plan publication and vehicle soft reservation atomic

**Files:**

- Modify `apps/api/src/subscription-journey/subscription-journey.service.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey-signal.service.ts`.
- Modify `apps/api/src/customer/customer.service.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey.dto.ts`.
- Modify `apps/api/test/subscription-journey-application.spec.ts`.
- Modify `apps/api/test/subscription-journey-golden-path.e2e-spec.ts`.
- Modify `apps/api/test/application-review-api.spec.ts`.

**Steps:**

1. Add RED tests proving `decideFinalPlan` requires/resolves a concrete final vehicle, soft-reserves it, writes the commercial hash, completes both Admin steps, and opens customer confirmation in one transaction.
2. Reuse existing vehicle availability/soft-reservation guards; do not duplicate inventory rules.
3. Keep `POST /:id/vehicle-allocation` as a compatibility/recovery route only for legacy in-flight Journeys; remove it from normal `availableActions`.
4. On any validation or reservation failure, roll back the plan revision, hash, Journey transitions, manual decisions, and vehicle reservation.
5. Exact replay with the same Journey version/payload returns the committed result; payload drift returns `JOURNEY_IDEMPOTENCY_CONFLICT`.
6. Prove two applications racing for one vehicle yield one committed publisher.
7. Run targeted API tests and commit.

## Task A7: Repair Admin and Portal projections and actions

**Files:**

- Modify `apps/web/src/components/subscription-journey/application-journey-actions.tsx`.
- Modify `apps/web/src/components/order-workspace/subscription-journey-card.tsx`.
- Modify `apps/web/src/components/order-workspace/subscription-journey-exception-actions.tsx`.
- Modify `apps/web/src/lib/subscription-journey-view-model.ts`.
- Modify `apps/web/src/lib/api.ts`.
- Modify `apps/web/src/app/portal/applications/[id]/page.tsx`.
- Modify `apps/web/test/subscription-journey-view-model.spec.ts`.
- Modify `apps/web/test/subscription-journey-admin-ui.spec.tsx`.
- Modify `apps/web/test/subscription-journey-golden-path.spec.tsx`.
- Modify `apps/web/test/portal-journey-pages.spec.tsx`.

**Steps:**

1. Add RED UI tests for “进件校验 · 等待人工”, customer supplementation text, and the absence of retry controls during business waiting.
2. Make Admin final-plan form require period/package/vehicle and explain that submit also soft-locks inventory.
3. Remove the normal separate vehicle-allocation card; render it only when the backend exposes the legacy recovery action.
4. Keep the customer confirm button disabled after exact revision confirmation and reopen it only for a genuinely new revision.
5. Run the four Web test files, Web typecheck, and Web lint; commit.

## Task A8: Add historical business-wait reconciliation and operational evidence

**Files:**

- Add `scripts/stage1-journey-business-wait-reconcile-core.mjs`.
- Add `scripts/stage1-journey-business-wait-reconcile.mjs`.
- Add `scripts/stage1-journey-business-wait-reconcile.test.mjs`.
- Modify `package.json`.
- Modify `apps/api/test/subscription-journey-failure-recovery.e2e-spec.ts`.
- Modify `docs/acceptance/2026-08-25-stage1-golden-path-manual-acceptance-issues.md` after verification.

**Steps:**

1. Enumerate only open validation exceptions with the two legacy business-wait codes and validation as the current step.
2. Dry-run reports Journey/application IDs, old error code, current fact version, proposed outcome, and no sensitive customer fields.
3. Apply mode locks each Journey, re-evaluates current facts, resolves the exception, writes a recovery event/audit, and is replay-safe.
4. Leave all other exception codes untouched and report them separately.
5. Add root scripts and script tests.
6. Add E2E coverage for historical recovery and commit.

## Task A9: Full verification and PR A

**Steps:**

1. Run targeted suites:

   ```bash
   pnpm --filter @subscription-saas/api exec vitest run \
     test/subscription-journey-application.spec.ts \
     test/subscription-journey-worker.spec.ts \
     test/subscription-journey-state-machine.spec.ts \
     test/subscription-journey-recovery.spec.ts \
     test/subscription-journey-failure-recovery.e2e-spec.ts \
     test/subscription-journey-golden-path.e2e-spec.ts \
     test/subscription-journey.repository.spec.ts \
     test/subscription-journey.repository.integration.spec.ts \
     test/application-review-api.spec.ts
   pnpm --filter @subscription-saas/web exec vitest run \
     test/subscription-journey-view-model.spec.ts \
     test/subscription-journey-admin-ui.spec.tsx \
     test/subscription-journey-golden-path.spec.tsx \
     test/portal-journey-pages.spec.tsx
   pnpm stage1:journey-plan-order:test
   pnpm stage1:journey-business-wait:test
   ```

2. Run `pnpm prisma:validate`, `pnpm prisma:generate`, API/Web typecheck and lint.
3. Run `pnpm test` and `pnpm build`.
4. Run migration checksum/status checks against the dedicated test database; run both reconciliation scripts in dry-run mode.
5. Review `git diff`, ensure no credentials or unrelated changes, and update acceptance issue entries with commit/test evidence but not “closed” before Staging verification.
6. Push PR A, require CI green, merge, deploy, and run automated Staging smoke checks only. Do not request user acceptance; begin PR B after the smoke checks pass.
