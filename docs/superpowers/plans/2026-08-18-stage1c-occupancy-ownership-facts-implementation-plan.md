# Stage 1C Vehicle Occupancy and Ownership Facts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add trustworthy, non-overlapping vehicle subscription-period and asset-ownership-period facts, plus an idempotent dry-run-first reconciliation/backfill tool, without changing the existing order, lease, contract, or vehicle-status write paths yet.

**Architecture:** Introduce `AssetOwner`, `VehicleOwnershipPeriod`, and `VehicleSubscriptionPeriod` as additive Stage 1C facts. PostgreSQL range exclusion constraints are the concurrency authority for period overlap, partial unique indexes protect single open periods, NestJS commands provide audited/idempotent open and close operations, and a read projection exposes discrepancies between the new facts and current order/lease/vehicle projections. Backfill trusts only explicit delivery/lease/return facts; ambiguous records are reported for manual cleanup and never guessed.

**Tech Stack:** NestJS 11, Prisma 7, PostgreSQL 16, TypeScript 6, Vitest 4, Node.js test runner, pnpm workspace.

**Approved design:** `docs/superpowers/specs/2026-08-18-stage1-capability-boundary-audit-revised-baseline-design.zh-CN.md`

## Position in the Approved Sequence

This is increment **1C-A** of the approved Stage 1 continuation:

1. **1C-A — vehicle occupancy and ownership facts — this plan.**
2. 1C-B — asset work orders, append-only work-order events/evidence, operational restrictions, and availability evaluation.
3. 1C-C — append-only vehicle cost/recovery ledger and snapshot-bound business exception approvals.
4. P0 vertical slice — physical return/recovery, occupancy closure, inspection/reconditioning, final settlement, normal contract completion, and inventory release.

Do not add work orders, restrictions, ledger entries, approvals, return workflow behavior, or vehicle-status dual writes in this plan. Those are separate deployable increments.

## Global Constraints

- Use additive migrations only. Never edit a historical migration, run `prisma migrate reset`, or use `prisma db push`.
- `Vehicle.status`, `SubscriptionOrder.orderStatus`, `Lease.status`, and `Contract.status` remain existing runtime projections in this increment.
- Money is not introduced in this increment.
- Period time ranges are half-open: `[startedAt, endedAt)`. `endedAt` must be later than `startedAt`.
- A vehicle cannot have overlapping subscription periods, including two concurrently opened rows.
- An order cannot have more than one open subscription period.
- A vehicle cannot have overlapping ownership periods.
- Replaying the same stable source key with the same payload returns the original fact. Reusing it with a different payload fails closed.
- Closing an already closed period with the same end command is idempotent; a different end instant, reason, or snapshot conflicts.
- No ownership period is fabricated during backfill. Seed the platform `AssetOwner`, but report vehicles without a provable current owner as `OWNERSHIP_UNKNOWN`.
- Backfill may infer a subscription period only when vehicle, customer, delivery/lease activation, and return facts are internally consistent.
- All command writes and backfill applies write `AuditLog` entries in the same transaction.
- Dry-run performs no writes and emits a machine-readable report with source counts, proposed inserts, existing matches, ambiguous rows, and invariant violations.
- API mutation endpoints require dedicated permissions. `ADMIN` receives all new permissions; other roles receive only the approved minimum.
- Use TDD for behavior and integration constraints. Commit each independently testable task.

## Data Contract

### `AssetOwner`

- `id`, stable unique `ownerNo`, `name`, optional `legalName` and registration identifier.
- `ownerType`: `PLATFORM` or `EXTERNAL_COMPANY`.
- `status`: `ACTIVE` or `INACTIVE`.
- Optional immutable onboarding snapshot plus normal create/update audit metadata.
- The seed creates one stable platform owner; it does not assign vehicles automatically.

### `VehicleOwnershipPeriod`

- `vehicleId`, `assetOwnerId`, `startedAt`, nullable `endedAt`.
- `startReason`, nullable `endReason`.
- Stable start source type/id/key and optional end source type/id/key.
- Start/end snapshots and confirmed-by/confirmed-at metadata.
- PostgreSQL exclusion constraint prevents overlap for the same vehicle.
- Partial unique index permits at most one open row per vehicle.

### `VehicleSubscriptionPeriod`

- `vehicleId`, `orderId`, optional `contractId`, optional `contractSegmentId`, `customerId`.
- `startedAt`, nullable `endedAt`, `startReason`, nullable `endReason`.
- Stable start source type/id/key and optional end source type/id/key.
- Vehicle/order/contract/customer start and end snapshots stored as JSON.
- Created/confirmed user and time metadata.
- PostgreSQL exclusion constraint prevents overlap for the same vehicle.
- Partial unique indexes permit at most one open row per vehicle and one open row per order.

## Backfill Trust Rules

- Candidate start time is `Lease.activatedAt`; if absent, use confirmed `VehicleDelivery.deliveredAt`; if both exist and materially disagree, report ambiguity.
- `ACTIVE` or `PENDING_RETURN` orders require a non-deleted vehicle, customer, and credible active lease/delivery evidence. They produce an open period.
- Orders with a trusted `actualReturnAt` or confirmed `VehicleReturn.returnedAt` produce a closed period. Conflicting return timestamps are ambiguous.
- A period cannot begin at or after its return timestamp.
- Existing periods are matched by stable source key and compared field by field; matching rows are idempotent, mismatches are conflicts.
- Candidates that overlap another proposed or persisted period are reported and skipped.
- Historical contract segment linkage is included only when one unambiguous segment covers the period start; otherwise `contractSegmentId` remains null and the report records the omission.
- Ownership backfill creates no period unless an explicit future-compatible source has been configured. This first run therefore reports current unowned vehicles and leaves them untouched.

## Exact File Map

### New files

- `apps/api/prisma/migrations/20260818120000_stage1c_occupancy_ownership_facts/migration.sql`
- `apps/api/src/asset-facts/asset-facts.module.ts`
- `apps/api/src/asset-facts/asset-facts.controller.ts`
- `apps/api/src/asset-facts/asset-facts.service.ts`
- `apps/api/src/asset-facts/asset-facts.repository.ts`
- `apps/api/src/asset-facts/asset-facts.types.ts`
- `apps/api/src/asset-facts/dto/asset-facts.dto.ts`
- `apps/api/test/asset-facts.service.spec.ts`
- `apps/api/test/asset-facts.controller.spec.ts`
- `apps/api/test/asset-facts.repository.integration.spec.ts`
- `scripts/stage1c-period-backfill-core.mjs`
- `scripts/stage1c-period-backfill-core.test.mjs`
- `scripts/stage1c-period-backfill-executor.mjs`
- `scripts/stage1c-period-backfill-executor.test.mjs`
- `scripts/stage1c-period-backfill.mjs`
- `docs/runbooks/stage1c-period-facts-rollout.zh-CN.md`

### Modified files

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/seed.mjs`
- `apps/api/src/app.module.ts`
- `apps/api/vitest.config.ts`
- `apps/api/test/permissions.spec.ts`
- `packages/shared/src/auth.ts`
- `package.json`

---

### Task 0: Record baseline and preflight

**Files:**

- Read: `AGENTS.md`
- Read: `DEV_SPEC.md`
- Read: approved design and this plan

- [ ] Verify the isolated worktree is on `stage1c-common-facts-20260818` at current `origin/main` and has no unexpected tracked changes.
- [ ] Run migration status and Prisma validation against the dedicated local test database.
- [ ] Record the baseline commit and current migration count in the implementation notes.

Commands:

```powershell
git status --short
git rev-parse HEAD
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm prisma:validate
```

Expected: clean tracked worktree, database up to date, schema valid.

### Task 1: Add failing schema and database invariant tests

**Files:**

- Create: `apps/api/test/asset-facts.repository.integration.spec.ts`
- Modify: `apps/api/vitest.config.ts`

- [ ] Add the new integration test to the serial `databaseTestFiles` project before implementing the schema.
- [ ] Write tests proving two concurrent attempts cannot create overlapping subscription periods for one vehicle.
- [ ] Write tests proving one order cannot have two open periods, even on different vehicles.
- [ ] Write tests proving adjacent half-open ranges are allowed.
- [ ] Write tests proving ownership periods for one vehicle cannot overlap.
- [ ] Write tests proving repeated inserts with the same stable source identity are distinguishable from conflicting reuse.
- [ ] Run the focused test and confirm it fails because the models/tables do not exist.

Command:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/asset-facts.repository.integration.spec.ts
```

Expected: FAIL for missing generated models/tables, not test setup errors.

### Task 2: Add Prisma models and additive PostgreSQL constraints

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260818120000_stage1c_occupancy_ownership_facts/migration.sql`

- [ ] Add enums for owner type/status and subscription/ownership start and end reasons.
- [ ] Add `AssetOwner`, `VehicleOwnershipPeriod`, and `VehicleSubscriptionPeriod` with explicit mapped table and column names.
- [ ] Add reverse relations on `Vehicle`, `SubscriptionOrder`, `Contract`, `SubscriptionContractSegment`, `Customer`, and relevant `User` relations.
- [ ] Generate a migration, then review and edit only the new migration to add `btree_gist` if absent, half-open range exclusion constraints, partial unique open-period indexes, and end-after-start checks.
- [ ] Give every non-Prisma constraint and index a stable explicit name.
- [ ] Apply the new migration to the dedicated test database.
- [ ] Generate Prisma Client and rerun the invariant tests until green.
- [ ] Add a migration regression assertion that the exclusion and partial unique constraints remain present.

Commands:

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate dev --schema prisma/schema.prisma --name stage1c_occupancy_ownership_facts --create-only
pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @subscription-saas/api prisma:generate
pnpm --filter @subscription-saas/api exec vitest run test/asset-facts.repository.integration.spec.ts
```

Expected: migration applies once, re-run reports up to date, all database invariant tests pass.

- [ ] Commit: `feat(stage1c): add occupancy and ownership fact schema`

### Task 3: Implement idempotent period command repository with TDD

**Files:**

- Create: `apps/api/src/asset-facts/asset-facts.types.ts`
- Create: `apps/api/src/asset-facts/asset-facts.repository.ts`
- Create: `apps/api/test/asset-facts.service.spec.ts`

- [ ] Write failing tests for opening a subscription period, exact source-key replay, conflicting source-key replay, closing a period, exact close replay, and conflicting close replay.
- [ ] Write failing tests for opening/closing ownership periods with the same idempotency rules.
- [ ] Define serializable command inputs containing stable source identity, actor, confirmed time, and immutable snapshots.
- [ ] Implement repository methods that accept an existing Prisma transaction client; do not start hidden nested transactions.
- [ ] Normalize database unique/exclusion violations to stable domain conflict codes.
- [ ] Ensure repository reads never treat soft-deleted source aggregates as valid.
- [ ] Run focused unit and integration tests until green.

Commands:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/asset-facts.service.spec.ts test/asset-facts.repository.integration.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: all period idempotency and concurrency cases pass.

### Task 4: Add audited domain commands and read projections

**Files:**

- Create: `apps/api/src/asset-facts/asset-facts.service.ts`
- Create: `apps/api/src/asset-facts/dto/asset-facts.dto.ts`
- Extend: `apps/api/test/asset-facts.service.spec.ts`

- [ ] Write failing tests that reject missing vehicle/order/customer/contract references and inconsistent aggregate identity.
- [ ] Write failing tests for invalid time ranges and illegal close reasons.
- [ ] Write failing tests that exact replays do not duplicate audit rows and successful new writes do.
- [ ] Implement transactional open/close commands for subscription and ownership periods.
- [ ] Capture start/end snapshots inside the transaction from authoritative rows; caller-supplied descriptive metadata may supplement but not replace authoritative identifiers.
- [ ] Write `AuditLog` entries for new facts and closures using the shared `AuditService` and the same transaction.
- [ ] Implement read projections by vehicle and by order showing current period, history, source identity, and discrepancy flags against current order/lease/vehicle projections.
- [ ] Keep this service independent from existing status-mutating services; no dual write yet.
- [ ] Run focused tests until green.

Command:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/asset-facts.service.spec.ts
```

Expected: command validation, idempotency, audit, and projection tests pass.

- [ ] Commit: `feat(stage1c): add audited occupancy and ownership commands`

### Task 5: Add permission-guarded API surfaces

**Files:**

- Modify: `packages/shared/src/auth.ts`
- Modify: `apps/api/prisma/seed.mjs`
- Create: `apps/api/src/asset-facts/asset-facts.controller.ts`
- Create: `apps/api/src/asset-facts/asset-facts.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/asset-facts.controller.spec.ts`
- Modify: `apps/api/test/permissions.spec.ts`

- [ ] Add `ASSET_FACTS_VIEW`, `ASSET_OWNER_MANAGE`, and `VEHICLE_PERIOD_MANAGE` permission codes.
- [ ] Add seed definitions and assign all three to `ADMIN`; assign view/manage only to roles justified by the existing asset and operations role matrix.
- [ ] Write failing controller tests for authentication, permission denial, DTO validation, and service delegation.
- [ ] Add read endpoints for vehicle/order fact history and discrepancies.
- [ ] Add explicit administrative command endpoints to create/close ownership periods and to repair subscription-period facts. These are repair/admin surfaces, not normal order-flow endpoints.
- [ ] Require `Idempotency-Key` on every mutation and pass actor/request context through for audit.
- [ ] Register `AssetFactsModule` in `AppModule`.
- [ ] Run focused permission/controller tests until green.

Commands:

```powershell
pnpm --filter @subscription-saas/shared test
pnpm --filter @subscription-saas/api exec vitest run test/asset-facts.controller.spec.ts test/permissions.spec.ts
```

Expected: guards fail closed and `ADMIN` seed coverage includes the new permissions.

- [ ] Commit: `feat(stage1c): expose governed asset fact APIs`

### Task 6: Build the pure backfill classifier first

**Files:**

- Create: `scripts/stage1c-period-backfill-core.mjs`
- Create: `scripts/stage1c-period-backfill-core.test.mjs`

- [ ] Write failing Node tests for argument parsing: exactly one of `--dry-run` and `--apply`, with optional `--output`.
- [ ] Write fixtures for trusted active order, trusted pending-return order, trusted closed return, missing vehicle, missing activation evidence, conflicting start timestamps, conflicting return timestamps, invalid ranges, and overlapping candidates.
- [ ] Write tests proving deterministic stable source keys and deterministic report ordering.
- [ ] Write tests proving an existing exact match is `UNCHANGED`, while same-key payload drift is `CONFLICT`.
- [ ] Write tests proving the classifier never proposes ownership rows from an implicit platform-owner assumption.
- [ ] Implement the pure classifier with no database imports and no filesystem writes.
- [ ] Include reconciliation counters for active orders, `LEASED` vehicles, proposed/existing open periods, closed periods, overlaps, one-order-multiple-current anomalies, and ownership-unknown vehicles.
- [ ] Run Node tests until green.

Command:

```powershell
node --test scripts/stage1c-period-backfill-core.test.mjs
```

Expected: deterministic classification and reconciliation tests pass.

- [ ] Commit: `test(stage1c): define period backfill trust rules`

### Task 7: Add dry-run/apply executor and audit-safe CLI

**Files:**

- Create: `scripts/stage1c-period-backfill-executor.mjs`
- Create: `scripts/stage1c-period-backfill-executor.test.mjs`
- Create: `scripts/stage1c-period-backfill.mjs`
- Modify: `package.json`

- [ ] Write failing executor tests proving dry-run performs zero create/update/audit calls.
- [ ] Write failing apply tests proving only `CREATE` candidates are inserted, exact matches are skipped, and any conflict blocks the apply unless the candidate set is explicitly clean.
- [ ] Write failing tests proving apply is transactionally idempotent and writes one audit record per inserted fact.
- [ ] Implement database snapshot loading with the same fields used by the classifier.
- [ ] Implement `--dry-run` JSON report output and `--apply` with an explicit confirmation environment variable, matching existing operations-script conventions.
- [ ] Never print `DATABASE_URL` or credentials.
- [ ] Add root scripts such as `stage1c:periods:dry-run` and `stage1c:periods:apply`.
- [ ] Run unit tests, then dry-run twice against the dedicated test database and compare reports byte-for-byte apart from generated timestamp fields.
- [ ] Apply to a disposable fixture set, rerun apply, and prove zero additional rows/audits on replay.

Commands:

```powershell
node --test scripts/stage1c-period-backfill-executor.test.mjs
pnpm stage1c:periods:dry-run -- --output output/stage1c-periods-local.json
```

Expected: dry-run is read-only; apply and replay are idempotent.

- [ ] Commit: `feat(stage1c): add safe period backfill and reconciliation`

### Task 8: Add rollout runbook and operational acceptance evidence

**Files:**

- Create: `docs/runbooks/stage1c-period-facts-rollout.zh-CN.md`

- [ ] Document purpose, non-goals, permissions, half-open range semantics, stable source keys, trusted backfill rules, and ambiguity categories.
- [ ] Document local/Staging/Production order: backup, migration status, deploy migration, dry-run, report review, apply, replay, reconciliation, and rollback-by-forward-fix.
- [ ] State that no vehicle ownership is assumed and list the manual ownership-data preparation required before later financial aggregation.
- [ ] Document SQL/read-only checks for overlaps, multiple open order periods, active-order/open-period counts, and `LEASED` vehicle discrepancies.
- [ ] Document that existing runtime status writes remain authoritative until a later dual-write cutover.
- [ ] Add expected evidence artifacts and redaction requirements; never store production report data in Git.

### Task 9: Full verification and review gate

**Files:** all changed files.

- [ ] Run format/lint checks for touched packages.
- [ ] Validate schema, regenerate Prisma Client, and verify migration status.
- [ ] Run all focused Stage 1C tests and Node backfill tests.
- [ ] Run full shared, API, and web suites because schema relations and shared permissions affect the workspace.
- [ ] Run API and web typechecks/builds.
- [ ] Inspect `git diff --check`, `git status --short`, and the final diff for secrets, generated artifacts, accidental user changes, and scope creep.
- [ ] Perform code review against the approved design and fix all material findings.
- [ ] Do not claim completion from stale output; rerun the final verification commands after the last code change.

Commands:

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api prisma:generate
pnpm --filter @subscription-saas/shared lint
pnpm --filter @subscription-saas/shared test
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/api build
pnpm --filter @subscription-saas/web build
git diff --check
git status --short
```

Expected: all commands green. If the pre-existing `release:check` issue remains, verify it is unchanged from `origin/main` and report it separately rather than masking it.

### Task 10: Publish as the 1C-A integration increment

- [ ] Confirm the branch contains only this plan and the 1C-A implementation.
- [ ] Push the branch, open a PR with migration/backfill risk notes, and wait for all PR checks.
- [ ] Resolve review findings with focused regression tests.
- [ ] Merge only after required checks are green.
- [ ] Verify the resulting `main` workflow is green and record the merge commit/run URL.
- [ ] Do **not** run Production backfill apply. Production migration/backfill requires a separately reviewed rollout action.
- [ ] Continue to the separate 1C-B plan; no manual product acceptance is required at the end of this foundation increment.

## Completion Criteria

- PostgreSQL, not application timing, prevents subscription and ownership overlap.
- Open/close commands are audited and idempotent under exact replay.
- Read projections expose discrepancies without mutating legacy statuses.
- Backfill dry-run is read-only, deterministic, and refuses ambiguous data.
- Apply is transactional and idempotent on trusted candidates.
- Platform owner exists, but vehicle ownership is not guessed.
- Full automated verification, PR CI, and post-merge `main` CI are green.
- Production data is unchanged until an explicit rollout authorization.
