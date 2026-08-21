# Stage 1C-C Cost Ledger and Exception Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the immutable, reversible vehicle cost ledger and snapshot-bound business-exception approval facts required by Stage 1C-C, then connect cost-required asset work-order closure to the canonical ledger.

**Architecture:** A new `asset-accounting` module owns `VehicleCostLedgerEntry`, `BusinessExceptionApproval`, and an internal append-only command receipt. Every mutation uses a caller-owned `READ COMMITTED` transaction, a global stable-source advisory lock, deterministic `NOWAIT` authority locks, exact replay from the receipt, and transaction-local audit. Cost entries are append-only; corrections are one full equal-and-opposite reversal. Approval mutations are internal application interfaces that accept only server-resolved authoritative snapshots; public approval APIs are read-only until an owning P0/handover domain supplies a resolver.

**Tech Stack:** NestJS, TypeScript, Prisma 7, PostgreSQL 16, Vitest, Node test runner, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-18-stage1-capability-boundary-audit-revised-baseline-design.zh-CN.md`

## Global Constraints

- Work only in `D:\Projects\auto-subscription-platform\.worktrees\stage1c-common-facts-20260818`; do not create another worktree or touch user-owned changes in the main checkout.
- Branch from `origin/main` at `6d9f62caf3d110500a81aebc80d28dba80c21996`; use branch `stage1c-c-cost-ledger-exceptions-20260820`.
- Read and obey `AGENTS.md`, `DEV_SPEC.md`, this plan, and the approved spec before each task.
- Use the dedicated local container `subscription-saas-codex-postgres`, port `55432`, database `subscription_saas_codex`; inject user/password from `docker inspect` into the child process only. Never print credentials or `DATABASE_URL`.
- Run `prisma migrate status`, `prisma validate`, and `prisma generate` before schema work. The inherited 58 historical checksum mismatches, datasource drift, and one rolled-back migration row are rollout blockers, not authorization to repair history.
- Add one forward-only migration. Never edit historical migrations, run `migrate reset`, run `db push`, or apply any Production backfill/permission synchronization.
- Amounts are integer fen (`BigInt` in persistence; decimal strings at JSON boundaries). No floating-point money.
- Do not infer historical cost, responsibility, asset ownership, evidence, or approval. Missing authority remains absent or is rejected.
- Existing `ReceivableBill`, `PaymentWriteOff`, `DepositLedger`, `VehicleBaasCostRecord`, depreciation, insurance, and return-damage records remain their owning-domain facts. Stage 1C-C must not rename them, overwrite them, or double-count them.
- `VehicleCostLedgerEntry` has no update/delete path. A correction is a new full equal-and-opposite entry referencing one unreversed original; partial and reversal-of-reversal commands are out of scope.
- `BusinessExceptionApproval` accepts only server-produced canonical fact snapshots. Do not expose a public mutation route that lets a client assert the current snapshot/hash.
- All writes require one nonblank scalar `Idempotency-Key` equal to `source.key`, authenticated actor/request context, exact replay, cross-command source ownership, and audit in the same transaction.
- Source lock is always first. Authority locks are stable by table/id and `NOWAIT`; current mutable rows use `FOR UPDATE NOWAIT`, immutable references use `FOR SHARE NOWAIT`. Normalize only real lock-not-available SQLSTATEs to stable 409 errors.
- No generic seed execution on the dedicated database. The permission-only Stage 1C synchronizer may be proved with guarded disposable fixtures and exact cleanup; never apply it to Production.
- Every task ends with fresh focused tests, lint/typecheck proportional to the change, an independent spec/code review, exact-file commit, and clean tracked status.

---

### Task 1: Persistence contract and forward-only migration

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260821000000_stage1c_cost_ledger_exception_approval/migration.sql`
- Create: `apps/api/test/asset-accounting.schema.spec.ts`

**Interfaces:**

- Consumes: existing `Vehicle`, `SubscriptionOrder`, `Contract`, `Customer`, `AssetOwner`, `AssetWorkOrder`, `AssetWorkOrderEvidence`, and `User` identities.
- Produces: Prisma models `VehicleCostLedgerEntry`, `BusinessExceptionApproval`, `AssetAccountingCommandReceipt` and the exact enums used by later tasks.

- [ ] **Step 1: Write the failing schema/migration contract**

Assert exact enum values:

```ts
VehicleCostEntryKind = ["ORIGINAL", "REVERSAL"];
VehicleCostActionType = [
  "ACTUAL_COST",
  "RESPONSIBILITY_CONFIRMED",
  "RECOVERY_EXPOSURE",
  "RECOVERY_RECEIVED",
  "WAIVER",
  "WRITE_OFF"
];
VehicleCostCategory = [
  "DAMAGE",
  "CLEANING",
  "REPAIR",
  "MAINTENANCE",
  "EXCESS_MILEAGE",
  "VIOLATION",
  "TOWING",
  "INSURANCE",
  "BAAS",
  "DEPRECIATION",
  "OTHER"
];
VehicleCostResponsiblePartyType = [
  "CUSTOMER",
  "INSURER",
  "SUPPLIER",
  "ASSET_OWNER",
  "PLATFORM",
  "OTHER"
];
BusinessExceptionType = [
  "VEHICLE_REGISTRATION_DOCUMENT_MISSING",
  "HANDOVER_EVIDENCE_EXCEPTION",
  "SETTLEMENT_WAIVER",
  "SETTLEMENT_WRITE_OFF",
  "RECOVERY_EXECUTION_APPROVAL"
];
BusinessExceptionSubjectType = [
  "VEHICLE",
  "ORDER",
  "CONTRACT",
  "ASSET_WORK_ORDER",
  "HANDOVER_WORK_ORDER",
  "SETTLEMENT_CASE",
  "RECOVERY_CASE"
];
BusinessExceptionApprovalStatus = ["PENDING", "APPROVED", "REJECTED", "EXPIRED"];
BusinessExceptionDecision = ["APPROVED", "REJECTED"];
AssetAccountingCommandType = [
  "COST_APPEND",
  "COST_REVERSE",
  "EXCEPTION_REQUEST",
  "EXCEPTION_DECIDE",
  "EXCEPTION_EXPIRE"
];
```

The test must assert model columns, reverse FK/unique index, stable-source receipt uniqueness, exact status-shape checks, no `updatedAt`/`deletedAt` on ledger/receipt, and the required trigger/function names.

- [ ] **Step 2: Run the schema test and record RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/asset-accounting.schema.spec.ts
```

Expected: failures because all three models, enums, constraints, and triggers are absent.

- [ ] **Step 3: Add the Prisma models and relations**

`VehicleCostLedgerEntry` must contain required `vehicleId`, optional order/contract/customer/assetOwner/workOrder/evidence references, frozen owner/evidence/responsibility snapshots, `entryKind`, `actionType`, `costCategory`, signed `amountCents`, responsibility identity, `occurredOn @db.Date`, `accountingPeriod @db.VarChar(7)`, `confirmedAt`, `confirmedBy`, `reversalOfEntryId`, the stable source triple, and `createdAt` only.

`BusinessExceptionApproval` must contain approval number, exception/subject/field identity, canonical snapshot/hash, request reason/evidence/requester/time, request source triple, status/version, decision/comment/actor/time, and expiry reason/actor/time. Request identity/snapshot fields never change.

`AssetAccountingCommandReceipt` must contain unique `{sourceType, sourceId, sourceKey}`, command type, canonical payload hash/snapshot, immutable public outcome snapshot, exactly one nullable FK of `costEntryId` or `approvalId`, actor, and created time. Commands pre-generate the target UUID, insert the target fact first, and insert its receipt before the transaction can commit; any receipt conflict rolls the whole transaction back.

- [ ] **Step 4: Author the additive migration**

The migration must:

- create the exact enums and three tables;
- enforce `amount_cents <> 0`, original-positive/reversal-negative shape, `YYYY-MM` accounting period, SHA-256 lowercase hash shape, status/decision/timestamp shape, and version nonnegative;
- add one partial unique index on `reversal_of_entry_id IS NOT NULL` and one live-approval unique index for the same subject/field/hash while status is `PENDING` or `APPROVED`;
- use a cross-row trigger to reject reverse-of-reversal, unequal/opposite amount drift, and vehicle/order/contract/customer/owner/work-order/action/category/responsibility mismatch;
- reject every ledger/receipt `UPDATE` and `DELETE` with named SQLSTATE `55000` triggers;
- allow approval only `PENDING -> APPROVED|REJECTED|EXPIRED` and `APPROVED -> EXPIRED`, while forbidding request identity/snapshot changes, decision rewrites, and deletes;
- use `ON DELETE RESTRICT` for authoritative facts and original entries; never cascade ledger history.

- [ ] **Step 5: Replay migration and verify database constraints**

Run secret-safe:

```powershell
pnpm prisma:migrate:deploy
pnpm prisma:migrate:status
pnpm prisma:validate
pnpm prisma:generate
```

Then run a PostgreSQL transaction that rolls back after proving ledger update/delete, receipt update/delete, invalid reversal shapes, duplicate reversals, and invalid approval transitions are rejected.

- [ ] **Step 6: Run final Task 1 gates and commit**

Run schema test, API lint/typecheck, `git diff --check`, and a read-only datasource/schema diff limited to proving the new objects are represented. Commit only the schema, one migration, and schema test:

```powershell
git add -- apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260821000000_stage1c_cost_ledger_exception_approval/migration.sql apps/api/test/asset-accounting.schema.spec.ts
git commit -m "feat(stage1c): add asset accounting facts"
```

### Task 2: Canonical snapshots, hashes, and ledger summaries

**Files:**

- Create: `apps/api/src/asset-accounting/asset-accounting.types.ts`
- Create: `apps/api/src/asset-accounting/asset-accounting.domain.ts`
- Create: `apps/api/test/asset-accounting.domain.spec.ts`

**Interfaces:**

- Produces: `AssetAccountingSource`, public snapshot types, `canonicalAssetAccountingJson`, `hashBusinessExceptionSnapshot`, `summarizeVehicleCostEntries`, and validation helpers.
- Consumes: the exact enums from Task 1.

- [ ] **Step 1: Write pure-domain RED tests**

Cover key ordering, Date ISO conversion, BigInt decimal conversion, omitted `undefined`, preserved array order, rejection of cycles/non-finite numbers/root non-object, stable SHA-256, one-field hash drift, amount/period/source validation, and signed summary buckets.

```ts
expect(hashBusinessExceptionSnapshot({ b: 2, a: 1n })).toBe(
  hashBusinessExceptionSnapshot({ a: 1n, b: 2 })
);
expect(hashBusinessExceptionSnapshot({ a: 2 })).not.toBe(hashBusinessExceptionSnapshot({ a: 1 }));
```

- [ ] **Step 2: Run RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/asset-accounting.domain.spec.ts
```

Expected: module/export failures.

- [ ] **Step 3: Implement the pure domain**

Use an explicit recursive canonicalizer; do not use locale ordering or `JSON.stringify` on raw BigInt. Summary keys must preserve action type and responsibility rather than netting unlike facts together. Reversals contribute their negative amount to the original action/category bucket.

- [ ] **Step 4: Run mutation-sensitive GREEN and commit**

Mutate key sorting, BigInt conversion, reversal sign, and one action bucket to prove the tests fail, restore, then run tests/Prettier/diff check and commit the exact three files:

```powershell
git commit -m "feat(stage1c): define asset accounting domain"
```

### Task 3: Unified repository source ownership and cost commands

**Files:**

- Create: `apps/api/src/asset-accounting/asset-accounting.repository.ts`
- Create: `apps/api/test/asset-accounting.repository.spec.ts`
- Create: `apps/api/test/asset-accounting.repository.integration.spec.ts`
- Modify: `apps/api/vitest.config.ts`
- Modify: `apps/api/test/vitest-config.spec.ts`

**Interfaces:**

- Produces: `appendCostEntry(tx, command)`, `reverseCostEntry(tx, command)`, `lockSourceOwnership(tx, source)`, and read projections.
- Requires: caller-owned Prisma interactive transaction at `READ COMMITTED` and canonical payload/outcome helpers from Task 2.

- [ ] **Step 1: Register the PostgreSQL suite under RED/GREEN**

Add the integration spec to `databaseTestFiles` and assert it is excluded from the parallel unit project and included in the serial database project.

- [ ] **Step 2: Write repository RED tests**

Test root-client/SERIALIZABLE rejection; append exact replay; payload drift; cross-command source conflict; missing/deleted/mismatched vehicle/order/contract/customer/owner/work-order/evidence; no ownership inference; reversal exact replay; second reversal; reverse-of-reversal; reference drift; and normalized named DB constraint codes.

- [ ] **Step 3: Implement source-first cost commands**

For both commands:

1. verify the caller transaction and isolation;
2. take one transaction advisory lock derived only from `{source.type, source.id, source.key}`;
3. load/compare the immutable receipt for exact replay before authority work;
4. lock authority rows in stable table/id order with `NOWAIT`;
5. validate every supplied cross-ID relationship and liveness marker;
6. insert the immutable entry and receipt; never update/upsert an entry;
7. return `{ outcome, wrote }`, with replay returning the stored original public outcome.

Reversal must lock the original entry before insert, copy all accounting/authority dimensions, set the exact negative amount, and rely on the partial unique index as final concurrent authority.

- [ ] **Step 4: Write and run real PostgreSQL concurrency RED/GREEN**

Cover two concurrent identical append commands, conflicting same-source append/reverse, different-source double reversal, held authority mutations, related/unrelated authority lock independence, transaction rollback, raw update/delete, and all named constraint normalization. Observe advisory/row-lock wait or `NOWAIT` failure rather than using sleeps as the assertion.

- [ ] **Step 5: Run final Task 3 gates and commit**

Run unit + database projects, lint/typecheck, Prisma validate/status, residue audit, Prettier/diff check, then commit exactly the repository, two specs, and two Vitest config files:

```powershell
git commit -m "feat(stage1c): add immutable vehicle cost commands"
```

### Task 4: Snapshot-bound exception approval commands

**Files:**

- Modify: `apps/api/src/asset-accounting/asset-accounting.repository.ts`
- Modify: `apps/api/src/asset-accounting/asset-accounting.types.ts`
- Modify: `apps/api/test/asset-accounting.repository.spec.ts`
- Modify: `apps/api/test/asset-accounting.repository.integration.spec.ts`

**Interfaces:**

- Produces: `requestExceptionApproval`, `decideExceptionApproval`, `expireExceptionApproval`, and `requireCurrentApprovedException`.
- Requires: authoritative snapshots supplied by a server-side owning-domain resolver after that domain has locked its current facts; never accepts a client hash as authority.

- [ ] **Step 1: Write approval command RED tests**

Cover exact request/decision/expiry replay, cross-command source conflict, one live (`PENDING` or `APPROVED`) approval per subject/field/snapshot, expected version, requester/decider separation, status transitions, approve/reject payload drift, and a current-snapshot mismatch returning a committed `EXPIRED` result rather than rolling back stale-state expiration.

- [ ] **Step 2: Implement minimal repository transitions**

Use source lock first, then a stable subject advisory lock, then `FOR UPDATE NOWAIT` on an existing approval. Compute hashes server-side from the supplied canonical snapshot. Consume/create the immutable command receipt before any replay return. `requireCurrentApprovedException` returns either `{ valid: true, approval }` or `{ valid: false, expiredApproval }`; callers must not continue the protected write when false.

- [ ] **Step 3: Prove approval/fact concurrency in PostgreSQL**

Use two transactions sharing the same subject lock. Show that a decision racing a fact revision cannot leave a stale `APPROVED`; exactly one of approval or expiration becomes authoritative, with stable replay and no duplicate receipt.

- [ ] **Step 4: Run final Task 4 gates and commit**

Run focused unit/database suites, lint/typecheck, residue and diff checks. Commit the exact four files:

```powershell
git commit -m "feat(stage1c): add snapshot-bound exception approvals"
```

### Task 5: Audited application service and safe projections

**Files:**

- Create: `apps/api/src/asset-accounting/asset-accounting.service.ts`
- Create: `apps/api/src/asset-accounting/asset-accounting.module.ts`
- Create: `apps/api/test/asset-accounting.service.spec.ts`
- Modify: `apps/api/test/asset-accounting.repository.integration.spec.ts`

**Interfaces:**

- Produces public cost commands/read methods plus transaction-bound internal approval methods for owning domains.
- Consumes repository methods from Tasks 3–4 and `AuditService` with the same transaction client.

- [ ] **Step 1: Write service RED tests**

Require authenticated context, permission tokens, source validation, `READ COMMITTED`, source lock before authority lock, one audit per newly appended fact/receipt transition, replay zero audit, JSON-safe BigInt/Date projection, no internal receipt/envelope, and full rollback when any audit fails.

- [ ] **Step 2: Implement cost application methods**

Expose `appendCost`, `reverseCost`, `getEntry`, `listVehicleEntries`, `listOrderEntries`, `listWorkOrderEntries`, `summarizeOrderCostFacts`, and `assertWorkOrderCostConfirmed`. `assertWorkOrderCostConfirmed` must ignore fully reversed entries and require at least one active `ACTUAL_COST` for a cost-required work order.

- [ ] **Step 3: Implement internal approval methods**

Expose `requestApprovalInTransaction`, `decideApprovalInTransaction`, `expireStaleApprovalsInTransaction`, and `requireApprovedExceptionInTransaction`. These methods require an owning-domain resolver callback that loads the authoritative snapshot inside the supplied transaction. Enforce `requestedBy !== decidedBy` even for ADMIN.

- [ ] **Step 4: Prove audit atomicity and contention in PostgreSQL**

Test append, reverse, request, decide, automatic expiry, replay, audit failure rollback, and holder-transaction usability after a `NOWAIT` loser. Verify exact audit module/entity/action/source/hash/reason/permission/request context without exposing private approval comments in public projections.

- [ ] **Step 5: Run final Task 5 gates and commit**

Run focused tests, API lint/typecheck/build, Prisma status/validate, residue audit, and commit the exact service/module/tests:

```powershell
git commit -m "feat(stage1c): audit asset accounting commands"
```

### Task 6: API, permissions, and permission-only access baseline

**Files:**

- Create: `apps/api/src/asset-accounting/asset-accounting.controller.ts`
- Create: `apps/api/src/asset-accounting/dto/asset-accounting.dto.ts`
- Create: `apps/api/test/asset-accounting.controller.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/shared/src/auth.ts`
- Modify: `apps/api/prisma/seed.mjs`
- Modify: `apps/api/test/permissions.spec.ts`
- Modify: `scripts/stage1c-access-baseline-core.mjs`
- Modify: `scripts/stage1c-access-baseline-core.test.mjs`
- Modify: `scripts/stage1c-access-baseline-executor.mjs`
- Modify: `scripts/stage1c-access-baseline-executor.test.mjs`
- Modify: `apps/web/src/constants/labels.ts`

**Interfaces:**

- Produces authenticated cost write/read routes and approval read routes.
- Produces permission codes `vehicle_cost_ledger:view|confirm|reverse` and `business_exception:view|request|approve`.

- [ ] **Step 1: Write controller and permission RED tests**

Cost routes:

```text
POST /asset-accounting/cost-entries
POST /asset-accounting/cost-entries/:id/reverse
GET  /asset-accounting/cost-entries/:id
GET  /asset-accounting/vehicles/:vehicleId/cost-entries
GET  /asset-accounting/orders/:orderId/cost-entries
GET  /asset-accounting/work-orders/:workOrderId/cost-entries
```

Approval routes are read-only:

```text
GET /asset-accounting/exception-approvals/:id
GET /asset-accounting/exception-approvals?subjectType=&subjectId=&status=
```

Assert one scalar `Idempotency-Key`, header/body exact match, DTO rejection of unsafe number/UUID/date/period/source/snapshot values, JSON-safe responses, and absence of any generic approval mutation route.

- [ ] **Step 2: Implement exact permissions and matrix**

Use this initial matrix:

| Role             | Ledger permissions     | Exception permissions  |
| ---------------- | ---------------------- | ---------------------- |
| ADMIN            | view, confirm, reverse | view, request, approve |
| ASSET_MANAGER    | view, confirm          | view, request          |
| OPERATIONS       | view, confirm          | view, request          |
| FINANCE          | view, confirm, reverse | view, request          |
| GENERAL_MANAGER  | view, reverse          | view, approve          |
| RISK_CONTROL     | view                   | view, request          |
| SALES            | none                   | none                   |
| CUSTOMER_SERVICE | none                   | none                   |

The service-level no-self-approval invariant remains mandatory regardless of grants. Add labels/descriptions but no menu/page: Stage 1C-C approval mutations remain owned by later domain workflows.

- [ ] **Step 3: Extend the permission-only synchronizer under TDD**

Dry-run must report exact permission definition/grant changes, identity collisions, and no owner/ownership-period mutation. Apply remains gated by the exact existing confirmation contract and one transaction/audit; replay changes zero.

- [ ] **Step 4: Prove dedicated-local apply/replay and exact cleanup**

If the canonical PLATFORM owner is absent after earlier proof cleanup, materialize only the guarded exact disposable owner prerequisite already approved for access proof. Apply the permission synchronizer only to the dedicated local database, verify the exact matrix and zero ownership-period writes, replay zero, then delete only exact new grants/permissions/audit/temp owner and verify zero residue. Never run generic seed or Production apply.

- [ ] **Step 5: Run final Task 6 gates and commit**

Run controller, permission, access core/executor, shared tests, API lint/typecheck/build, web typecheck, Prisma status/validate, secret/diff checks, then commit exact files:

```powershell
git commit -m "feat(stage1c): expose governed asset accounting APIs"
```

### Task 7: Require canonical cost before closing cost-required work orders

**Files:**

- Modify: `apps/api/src/asset-operations/asset-operations.module.ts`
- Modify: `apps/api/src/asset-operations/asset-operations.service.ts`
- Modify: `apps/api/test/asset-operations.service.spec.ts`
- Modify: `apps/api/test/asset-operations.repository.integration.spec.ts`

**Interfaces:**

- Consumes: `AssetAccountingService.assertWorkOrderCostConfirmed(tx, workOrderId)` from Task 5.
- Produces: an authoritative `PENDING_COST_CONFIRMATION -> CLOSED` gate tied to active immutable ledger facts.

- [ ] **Step 1: Write the integration RED**

Prove that a cost-required work order with only the legacy `COST_CONFIRMED` event cannot close; one active canonical `ACTUAL_COST` entry permits close; a fully reversed entry blocks close; a no-cost work order follows the existing direct-close path.

- [ ] **Step 2: Add the guard without changing lock order**

After the existing source and current-header `FOR UPDATE NOWAIT` lock, but before event/header writes, call the transaction-bound ledger assertion. It performs a read of immutable ledger facts only and must not acquire a conflicting work-order lock.

- [ ] **Step 3: Prove race and rollback behavior**

Run a real PostgreSQL race between reversal and close. The original entry lock/reversal uniqueness plus work-order transaction must yield one serial outcome: either close observes an active cost, or reversal wins and close returns a stable conflict. Audit failure rolls back all work-order and ledger-side effects.

- [ ] **Step 4: Run regression gates and commit**

Run asset-accounting and asset-operations unit/database suites, full Fleet Ops, API lint/typecheck/build, residue/diff checks, then commit exact four files:

```powershell
git commit -m "feat(stage1c): gate work order closure on cost facts"
```

### Task 8: Rollout and reconciliation runbook

**Files:**

- Create: `docs/runbooks/stage1c-asset-accounting-rollout.zh-CN.md`
- Create: `scripts/stage1c-asset-accounting-reconciliation.test.mjs`
- Modify: `docs/runbooks/stage1c-asset-operations-rollout.zh-CN.md`

**Interfaces:**

- Produces: read-only rollout gates and cross-links for operators; no backfill/apply command.

- [ ] **Step 1: Write the document contract RED**

Require exact headings, enum inventories, permission matrix, source/replay rules, reversal rules, approval hash/expiry rules, no-client-snapshot warning, no-backfill statement, contention/retry guidance, evidence/redaction, and numbered independent `BEGIN TRANSACTION READ ONLY` SQL blocks.

- [ ] **Step 2: Write read-only reconciliation SQL**

Include exact checks for migration/checksum/drift, catalog functions/triggers/checks/index validity, source receipt uniqueness/pairing, reversal equality and single-reversal shape, ledger immutability, accounting period/date shape, authority orphans, approval state tuple validity, stale active approvals supplied by registered resolver queries, audit parity/duplicates/orphans, permission definitions/grants, and work orders closed without active canonical cost.

- [ ] **Step 3: Execute every SQL block verbatim on the dedicated database**

Extract blocks by marker, run each independently with `ON_ERROR_STOP` and read-only transaction, record sanitized counts, and confirm the known checksum/drift blockers remain nonzero and unmodified.

- [ ] **Step 4: Run mutation-sensitive document tests and commit**

Mutate trigger definitions, reversal predicates, approval status predicates, permission names, and read-only markers; prove the validator fails; restore and run GREEN. Commit exact three documentation/test files:

```powershell
git commit -m "docs(stage1c): add asset accounting rollout gates"
```

### Task 9: Full verification, independent review, PR, merge, and main CI

**Files:**

- Modify only if verification finds a scoped defect; every fix requires its own RED/GREEN and independent review.
- Record ignored evidence under `.superpowers/sdd/2026-08-20-stage1c-c-cost-ledger-exception-approval-implementation-plan/`.

**Interfaces:**

- Produces: one reviewed ready PR, normal merge, and exact merge-SHA main CI success.

- [ ] **Step 1: Run complete local gates on the final tree**

Run all Stage 1C-C focused/unit/database suites, Stage 1C-A/B regressions, asset operations, finance billing, order return, subscription expiry, permissions/access/reconciliation, full API, shared, web, repo lint/typecheck, API/web builds, Prisma status/validate/generate, changed-file Prettier, `git diff --check`, secret/scope/residue audits, and all rollout SQL read-only.

- [ ] **Step 2: Obtain whole-branch independent review**

Review the exact `6d9f62c..HEAD` diff against the approved spec and this plan. Publication is blocked until Critical and Important findings are zero. Fixes use strict TDD and a scoped independent rereview.

- [ ] **Step 3: Create or reuse exactly one ready PR**

Check for an existing matching head PR before push/create. The PR body must disclose the migration, append-only/reversal semantics, snapshot-resolver boundary, permissions, work-order gate, complete test counts, no backfill/Production apply, and inherited local checksum/drift/rolled-back rollout blockers.

- [ ] **Step 4: Wait for checks/reviews and merge normally**

Do not bypass checks, force-push, admin-merge, or create a second PR. Resolve actionable feedback through reviewed commits. When all checks are green and review threads are resolved, merge normally.

- [ ] **Step 5: Verify exact merge-SHA main CI and hand off to P0**

Track only the main workflow run whose `headSha` equals the merge commit. Require completed success for every job, update the Task 9 report/ledger, and preserve the worktree for the next independent P0 branch from new `origin/main`.
