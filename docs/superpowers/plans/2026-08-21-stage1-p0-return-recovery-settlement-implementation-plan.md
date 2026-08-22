# Stage 1 P0 Return, Recovery, and Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Use TDD for every behavior change, request an independent review at each task boundary, and stop on any Critical or Important finding.

**Goal:** Deliver three production-equivalent, auditable P0 journeys: normal expiry through physical return and contract completion; administrator-approved vehicle recovery through physical control and termination settlement; and early termination through vehicle return and final settlement.

**Architecture:** Add a `subscription-closure` orchestration domain. It owns exactly one active closure aggregate per order while retaining retired cancelled early-termination attempts as immutable history, plus append-only closure events, immutable document and settlement revisions, and stable command receipts. A case's immutable initiation intent is normal completion or early termination; its physical-control mode can be escalated from voluntary return to recovery through an audited event without creating a second active case. Existing specialist facts remain authoritative: `VehicleReturn` records现场 return details, Stage 1C-A owns occupancy periods, Stage 1C-B owns asset work orders/evidence/restrictions and vehicle availability, and Stage 1C-C owns cost/recovery ledger entries and snapshot-bound approvals. Every cross-domain mutation runs in one caller-owned `READ COMMITTED` transaction with a stable source lock and a documented `NOWAIT` authority-lock order. The legacy return endpoint becomes a compatibility façade and cannot bypass a managed closure case.

**Tech stack:** NestJS 11, Prisma 7, PostgreSQL 16, TypeScript 6, Vitest 4, Next.js, Node.js test runner, pnpm workspace.

**Approved design:** `docs/superpowers/specs/2026-08-18-stage1-capability-boundary-audit-revised-baseline-design.zh-CN.md`

**Base:** protected `main` at `fee5cce9f2e394503d4f2e963d22e25a999ec10d`, after Stage 1C-A/B/C and the test-only main-CI corrective.

## Position and scope

This is the independent P0 vertical slice that follows Stage 1C-C. It implements only:

1. normal expiry → return preparation → physical receipt → inspection/reconditioning → final settlement → order and contract completion → inventory release;
2. D+7 recovery assessment → separate administrator approval → recovery execution → physical control → inspection → termination settlement;
3. early termination → immutable agreement snapshot → return preparation/physical receipt → inspection → final settlement → order and contract termination.

It does **not** implement automatic debit, full collection strategy, vehicle swap, package benefits, procurement, disposal, or Production rollout.

### Authorized sequencing override

The approved baseline originally places the complete early-termination change center in P1 (§17.6). In this thread the user explicitly confirmed the fixed continuation through a P0 human-acceptance boundary after the P0 scope was stated as exactly three journeys: normal return, administrator-approved recovery, and early termination return/settlement. This plan therefore brings forward only the **execution closure** of early termination. It does not implement vehicle swap, generic `SubscriptionChangeOrder` expansion, quote/change-center UI, or the rest of P1, and it must report that limitation in the final handoff.

### Binding Task 7 data-contract amendment

The user explicitly replaced the original “one closure case per order forever” rule with **exactly one active closure aggregate per order; retired cancelled early-termination attempts remain immutable history**. This amendment is binding for Task 7 and later tasks:

- `SubscriptionOrder.closureCases[]` retains all attempts. Operational reads require `retiredAt = NULL`; source replay resolves its historical attempt before any active-only lookup; list/history reads retain retired rows.
- `SubscriptionClosureCase.retiredAt` and `retiredBy` are all-null or all-nonnull. `retiredBy` has a restrictive `User` foreign key. The database retains a normal `order_id` index and enforces exactly one active row with a partial unique index on `order_id WHERE retired_at IS NULL`.
- A retired row must be `EARLY_TERMINATION / CANCELLED` and have no `VehicleReturn`, specialist/common/recovery/reconditioning work-order, physical-control, or current-settlement links. Its documents, events, receipts, and audits remain immutable and attached.
- Existing rows remain active with both retirement columns `NULL`. Migration 104 performs no inferred retirement, data repair, or backfill.
- Governed source-first cancellation/supersession may retire only a pre-execution early attempt in `PREPARING_RETURN` or `MANUAL_TAKEOVER`, after exact graph validation, optional stale e-sign cancellation, immutable event/receipt/audit writes, and one database clock.
- A retired early attempt must not prevent later normal expiry or a later valid early request. Competing paths serialize on the order authority plus the partial unique index and produce exactly one active winner without deleting history.

## Binding invariants

- Use forward-only migrations. Never edit historical migrations, run `prisma migrate reset`, or use `prisma db push`.
- `SubscriptionClosureCase` is the active orchestration aggregate per order; only retired cancelled early attempts may coexist as immutable history. `VehicleReturn`, work orders, periods, restrictions, ledger entries, receivable bills, approvals, contracts, and e-sign tasks remain facts owned by their existing domains.
- Case initiation intent is immutable. A `NORMAL_COMPLETION` case can escalate its physical-control mode from `VOLUNTARY_RETURN` to `RECOVERY`, and its final disposition from `COMPLETE` to `TERMINATE`, only through the governed recovery-approval transition. The original intent and escalation event remain visible forever.
- Physical control and financial closure are separate. Physical receipt moves the order to `RETURNED_PENDING_SETTLEMENT`, closes occupancy, completes the lease, and creates an inspection restriction; it does not mark the order or contract final.
- A vehicle is never made `AVAILABLE` merely because an order or contract is final. Inventory release requires physical control, a closed occupancy period, no blocking `INVENTORY_RELEASE` restriction, and the existing availability evaluator.
- A normal closure ends as `OrderStatus.COMPLETED` and `ContractStatus.COMPLETED`. An early-termination or recovery closure ends as `OrderStatus.TERMINATED` and `ContractStatus.TERMINATED`.
- `RETURN_INBOUND`, `RECOVERY`, and `RECONDITIONING` use the existing `AssetWorkOrder` command service. Their events/evidence are append-only and retain stable source tuples.
- Recovery execution requires a live `RECOVERY_EXECUTION_APPROVAL` whose server-resolved snapshot still matches the current recovery case, order, debt, dispute, extension, vehicle, and collection context. Requester and decider remain separated.
- Settlement waiver/write-off requires the corresponding live approval. Client-provided hashes or authoritative snapshots are never trusted.
- Settlement and closure-document revisions are immutable from insertion. Every proposed/finalized/settled or generated/signed/archived state creates a successor row and atomically advances the case pointer. Corrections create another successor. Cost corrections use Stage 1C-C reversal entries rather than updating ledger history.
- Completion requires a finalized current settlement revision and a server-resolved financial outcome showing every included receivable is paid, written off, or covered by an approved waiver; deposit disposition must also be final.
- Commands are idempotent by canonical `{sourceType, sourceId, sourceKey}` and immutable normalized payload. Exact replay returns the original outcome; drift fails closed.
- Source ownership is always the first lock. Remaining locks are acquired in one stable table/id order with `NOWAIT`; contention maps to stable 409 errors and never aborts the holder transaction. Stage 1C fact/operation/accounting calls use explicit same-transaction capabilities and never open nested transactions or silently reacquire locks.
- All domain changes and their `AuditLog` rows commit atomically. Notifications/outbox are supporting facts and may fail without changing domain truth.
- Business waiting (`WAITING_RETURN`, approval, signature, payment, inspection) is not retried or dead-lettered. `DEAD_LETTER` remains technical-task-only.
- Customer/Field responses exclude internal approval comments, provider payloads, private command envelopes, and BigInt values.
- The dedicated local database may be used only for tests and read-only rollout evidence. No Production deploy, seed, backfill, apply, or historical migration repair is authorized.

## Data contract

### Closure case

- `SubscriptionClosureType`: `NORMAL_COMPLETION`, `EARLY_TERMINATION` (immutable initiation intent).
- `SubscriptionClosurePhysicalControlMode`: `VOLUNTARY_RETURN`, `RECOVERY`.
- `SubscriptionClosureFinalDisposition`: `COMPLETE`, `TERMINATE`.
- `SubscriptionClosureStatus`: `PREPARING_RETURN`, `RECOVERY_ASSESSMENT_PENDING`, `RECOVERY_APPROVAL_PENDING`, `RECOVERY_APPROVED`, `RECOVERY_IN_PROGRESS`, `VEHICLE_SECURED`, `RETURN_INSPECTION`, `RECONDITIONING`, `PENDING_SETTLEMENT`, `COMPLETED`, `TERMINATED`, `REJECTED`, `PAUSED`, `CANCELLED`, `MANUAL_TAKEOVER`.
- Exactly one active case per order, with stable case number, order/vehicle/customer/contract/return/specialist-handover/asset-work-order links, authority snapshot, effective/physical-control/settled/closed timestamps, version, and current document/settlement revision pointers. Retired cancelled early attempts retain their immutable history under the amendment above.
- Normal completion is created from the expiry fact, not as a `SubscriptionChangeOrder`.
- Early termination records an immutable customer/agreement snapshot and effective time in the case authority snapshot. This P0 execution slice does not claim the later P1 change-center expansion is complete.
- D+7 recovery does not create a second case. It appends an escalation event, changes physical-control mode to `RECOVERY`, changes final disposition to `TERMINATE`, and binds the approval snapshot to both the immutable origin and current escalation projection.

### Closure events and command receipts

- Append-only event timeline with before/after status, actor, occurred/recorded times, stable source tuple, and detail snapshot.
- One command receipt per stable source tuple, containing normalized payload hash/snapshot and original JSON-safe outcome.
- Database triggers reject update/delete of events, settlement revisions, and receipts.

### Closure document revisions

- `RETURN_MANIFEST`, `EARLY_TERMINATION_AGREEMENT`, or `RECOVERY_AUTHORITY`.
- Each immutable successor stores exact manifest/agreement/authority snapshot and hash, source/signed file IDs and hashes, specialist `VehicleHandoverWorkOrder`, `ContractESignTask`, actor/timestamps, and superseded revision.
- A return manifest must reference the same closure, `VehicleReturn`, order, vehicle, and governed `RETURN_INBOUND` handover work order. Facts changing after generation supersede the document and invalidate its sign task; they never overwrite or reuse the prior artifact.
- Voluntary physical receipt requires the current return manifest to be archived and signed. Recovery receipt instead requires an archived recovery-authority document plus a live recovery approval and execution evidence.
- Early termination cannot enter return preparation until the current termination agreement is archived and signed, except an explicitly approved breach/recovery path captured by `RECOVERY_AUTHORITY`.

### Settlement revisions

- Immutable monotonically increasing revision per case.
- `ESTIMATE` or `FINAL`; stage `PROPOSED`, `FINALIZED`, or `SETTLED`.
- Stores server-computed ledger/bill/deposit inputs, totals in integer cents, responsibility/waiver/write-off references, result snapshot/hash, created/finalized/settled actors and times.
- Rows are immutable. Finalizing or settling inserts a higher revision with `supersedesRevisionId` and atomically advances the case pointer; older versions remain queryable.

### Receipt write point

- A command receipt is inserted only after every domain fact and same-transaction audit for that command has succeeded. It contains the already-known original outcome. Any failure rolls back the receipt with the command; there is no placeholder receipt to update.

## Stable lock order

1. exact source advisory lock;
2. closure case (if known), then order;
3. vehicle, lease, contract, active contract segment, vehicle return;
4. active subscription period;
5. referenced collection case / approval;
6. referenced specialist handover, asset work orders, documents, and restrictions;
7. financial rows needed by the command.

Rows are sorted by table rank then canonical UUID. Existing lower-layer services may reuse a same-transaction capability but must not reacquire a conflicting lock in a different order.

---

## Task 0: Plan, baseline, and isolated branch

**Files:**

- Add this plan.
- Add ignored SDD task briefs/reports under `.superpowers/sdd/2026-08-21-stage1-p0-return-recovery-settlement-implementation-plan/`.

- [ ] Verify the existing linked worktree is clean and on `stage1-p0-return-recovery-settlement-20260821` from exact base.
- [ ] Verify dedicated PostgreSQL migration status and Prisma validation without printing credentials.
- [ ] Record inherited rollout blockers without repairing them.
- [ ] Commit the plan before implementation and obtain an independent plan review.

## Task 1: Add closure and settlement schema

**Files:**

- Modify `apps/api/prisma/schema.prisma`.
- Add one forward migration `apps/api/prisma/migrations/20260821xxxxxx_stage1_p0_subscription_closure/migration.sql`.
- Add `apps/api/test/subscription-closure.schema.spec.ts`.
- Modify `apps/api/vitest.config.ts` only if the real-PostgreSQL suite needs serial registration.

- [ ] Add closure, document, and settlement enums; case/event/document-revision/settlement-revision/receipt models and reverse relations; `OrderStatus.RETURNED_PENDING_SETTLEMENT`; `ContractStatus.COMPLETED`; and `SubscriptionAutomationJobType.CLOSURE_RECOVERY_ASSESSMENT_D7`.
- [ ] Add exact foreign keys, exactly-one-active-case-per-order partial uniqueness with immutable retired early-attempt history, monotonic settlement revision uniqueness, source tuple uniqueness, state-shape checks, current-revision integrity, and append-only triggers.
- [ ] Add strong document relations to closure case, `VehicleReturn`, `VehicleHandoverWorkOrder`, `ContractESignTask`, source/signed `FileObject`, and superseded revision, with exact document-type shape checks.
- [ ] Ensure existing enum values preserve order and all historical migration blobs remain unchanged.
- [ ] RED/GREEN exact schema mutation tests and rollback-only PostgreSQL constraint proofs.
- [ ] Deploy only to the dedicated local database; verify status/validate/generate and zero fixture residue.
- [ ] Commit and request independent review.

## Task 2: Implement the authoritative closure repository and domain matrix

**Files:**

- Add `apps/api/src/subscription-closure/subscription-closure.types.ts`.
- Add `apps/api/src/subscription-closure/subscription-closure.domain.ts`.
- Add `apps/api/src/subscription-closure/subscription-closure.repository.ts`.
- Add unit and serial PostgreSQL specs.
- Register the database spec in `apps/api/vitest.config.ts` if needed.
- Modify `apps/api/src/asset-facts/asset-facts.service.ts` / repository and tests for a caller-owned transaction capability.
- Modify `apps/api/src/asset-operations/asset-operations.service.ts` / repository and tests for a caller-owned transaction capability.
- Modify `apps/api/src/handover-work-order/handover-work-order.service.ts` and its focused persistence/tests for a caller-owned `READ COMMITTED` P0 capability.
- Reuse the existing transaction-bound Stage 1C-C accounting methods; modify them only if a capability proof is missing.

- [ ] Implement canonical source parsing, source-first lock, stable mixed authority locks, command receipt replay/drift, and JSON-safe immutable outcomes.
- [ ] Implement create/load/list case; append event; attach current settlement revision; and exact projections.
- [ ] Pin the full allowed transition matrix for both immutable initiation intents and both physical-control modes.
- [ ] Pin `NORMAL_COMPLETION/VOLUNTARY_RETURN/COMPLETE → NORMAL_COMPLETION/RECOVERY/TERMINATE` as the only recovery escalation; initiation intent never changes and a second active case cannot be created.
- [ ] Add unforgeable, one-use, same-repository/same-transaction capabilities so the orchestrator can invoke Stage 1C facts/operations/accounting without nested transactions or lock-order inversion.
- [ ] Add an equivalent unforgeable P0 capability for specialist `VehicleHandoverWorkOrder(RETURN_INBOUND)`: it reuses handover validation/status/audit rules, runs inside the caller transaction, and locks the specialist row at the documented rank. Arbitrary callers still receive the existing disabled-flow error.
- [ ] Prove exact replay, cross-command source conflicts, payload drift, wrong-authority rejection, rollback, and one-winner concurrency.
- [ ] Prove expiry rolls back the closure case, specialist handover, common asset work order, first document revision, and audits together when any one write fails; prove specialist/common work-order contention fails fast and exact replay creates neither duplicate.
- [ ] Prove empty authority probes fail closed against concurrent inserts.
- [ ] Commit and request independent review.

## Task 3: Normal expiry and return preparation

**Files:**

- Add `apps/api/src/subscription-closure/subscription-closure.service.ts` and module.
- Modify `apps/api/src/subscription-change/subscription-expiry.service.ts` and its tests.
- Modify `apps/api/src/handover-work-order/handover-work-order.service.ts` and focused tests to permit governed `RETURN_INBOUND` creation only.
- Modify `apps/api/src/asset-operations/asset-operations.service.ts` / repository only through the Task 2 transaction-bound capability contract.
- Add real PostgreSQL boundary/concurrency tests.

- [ ] Extend expiry so the no-extension transaction creates/replays one normal closure case, one `RETURN_INBOUND` AssetWorkOrder, and the existing `VehicleReturn`, while preserving segment/order/lease/billing/entitlement behavior.
- [ ] Notify the customer and expose a business-waiting state without retry/dead-letter semantics.
- [ ] Permit both specialist `VehicleHandoverWorkOrder(RETURN_INBOUND)` and common `AssetWorkOrder(RETURN_INBOUND)` only through same-transaction P0 orchestration capabilities; persist their exact links on the closure case.
- [ ] Create the first immutable return-manifest document revision and bind later PDF/e-sign/archive successors to its exact hash.
- [ ] Ensure legacy `OrderService.prepareReturn` reads/updates the same specialist record without bypassing case authority.
- [ ] Prove expiry-vs-extension and prepare-vs-recovery races have one authoritative result.
- [ ] Commit and request independent review.

## Task 4: Physical receipt, inspection, reconditioning, and inventory release

**Files:**

- Modify closure service/repository/types and tests.
- Modify `apps/api/src/order/order.service.ts` and focused tests to route managed returns through closure orchestration.
- Add serial PostgreSQL boundary tests spanning facts/operations/accounting.

- [ ] Confirm physical control from a locked `VehicleReturn` checklist and the current archived signed return-manifest revision; recovery instead requires the current archived recovery-authority revision, live approval, and execution evidence.
- [ ] Atomically close the open subscription period with the correct end reason, complete the lease, set order `RETURNED_PENDING_SETTLEMENT`, record actual return, transition return/recovery work order, create `RETURN_INSPECTION_PENDING` restriction, and move vehicle only to `RETURNED`/`MAINTENANCE`.
- [ ] Make duplicate receipt an exact replay; competing voluntary return/recovery has one winner.
- [ ] Complete inspection by appending evidence/costs, creating a governed `RECONDITIONING` work order when required, and moving the case to settlement only after acceptance.
- [ ] Release restrictions through the existing command. Make inventory `AVAILABLE` only when the existing evaluator permits `MARK_AVAILABLE` and no blocking `INVENTORY_RELEASE` fact remains.
- [ ] Prove every injected audit failure rolls back all domain facts and that holder transactions remain usable after a contender’s `NOWAIT` failure.
- [ ] Commit and request independent review.

## Task 5: Final settlement and contract completion

**Files:**

- Modify closure service/repository/domain/types and tests.
- Add a transaction-bound settlement resolver using existing receivable/payment/write-off/deposit and Stage 1C-C ledger reads.
- Modify finance/order read projections only as needed; do not create a parallel payment ledger.

- [ ] Create immutable proposed/finalized/settled successor revisions from server-resolved ledger, damage, mileage, receivable, payment, write-off, waiver, and deposit facts; never update a prior revision.
- [ ] Reject client totals/hashes and stale resolver snapshots.
- [ ] Require approval for settlement waiver/write-off and expire approval on source-fact change.
- [ ] Mark a final revision settled only when all included financial obligations have a durable resolution.
- [ ] Complete normal cases as order/contract `COMPLETED`; complete recovery/early cases as `TERMINATED`; never alter vehicle availability as a side effect of financial closure.
- [ ] Prove revision immutability, replay/drift, stale approval, partial payment, mixed write-off/waiver, rollback, and close-vs-ledger-reversal races.
- [ ] Commit and request independent review.

## Task 6: Administrator-approved recovery journey

**Files:**

- Modify closure service/repository/domain/types and tests.
- Add recovery DTO/controller methods in the closure controller task or focused internal APIs here.
- Modify `apps/api/src/subscription-change/subscription-change-job.service.ts`, worker wiring, renewal job scheduling, and focused tests for the one P0 D+7 job.
- Modify collection read integration only to resolve current debt/actions/promises/disputes and to cancel the pending assessment job when the linked overdue facts settle; do not change the broader P1 collection policy.

- [ ] Schedule one stable `CLOSURE_RECOVERY_ASSESSMENT_D7` job when the normal closure enters return-due. Its due boundary is the earliest due date among still-unsettled overdue bills for the order; if no such bill exists, no recovery assessment job is scheduled. `availableAt` is Shanghai start-of-day at due date + 7 calendar days. Persist the selected `billId` and `dueDate` in the immutable job payload/command receipt so later bills cannot rewrite the historical SLA.
- [ ] Cancel or no-op that job when the vehicle is voluntarily returned, all linked overdue bills settle, or a live dispute/approved extension blocks escalation.
- [ ] Create an assessment only for an overdue, unreturned, physically uncontrolled vehicle and store the server-resolved debt/collection/actions/promises/disputes/extension/legal/vehicle snapshot.
- [ ] Request and decide `RECOVERY_EXECUTION_APPROVAL` through Stage 1C-C with requester/decider separation.
- [ ] On approved execution, create/replay a `RECOVERY` work order and `RECOVERY_IN_PROGRESS` restriction.
- [ ] Record execution evidence/costs; on vehicle secured, use the same physical-control command with `RECOVERY_CONFIRMED` and transition through inspection/settlement.
- [ ] Reject/expire/pause/cancel/manual-takeover states remain business states with explicit recovery actions and no technical dead letter.
- [ ] Prove D+7 timing, exact replay, paid-before-D+7 cancellation, dispute/extension blocking, approval-vs-authority mutation, recovery-vs-voluntary return, recovery-vs-extension, and duplicate executor races.
- [ ] Commit and request independent review.

## Task 7: Early termination journey

**Files:**

- Modify closure service/repository/domain/types and tests.
- Add early-termination DTO/API methods.
- Modify billing/entitlement scheduling only through existing authoritative commands.
- Add termination-agreement document/PDF/e-sign archive commands and tests using the closure document revision model.

- [ ] Create an early-termination case from an active order with immutable agreement snapshot, effective time, reason, and evidence; generate/sign/archive successor document revisions and invalidate stale tasks when facts change.
- [ ] Permit governed pre-execution cancellation/supersession to retire only the exact cancelled early attempt, retain its immutable history, and allow one later normal-expiry or early-termination active aggregate.
- [ ] Stop future billing and benefits from the effective boundary without mutating earned receivables.
- [ ] Create/replay `VehicleReturn(EARLY_TERMINATION)` and `RETURN_INBOUND` or approved `RECOVERY` work order.
- [ ] Reuse physical-control, inspection, settlement, and final termination commands.
- [ ] Prove signed-agreement drift, physical-control-before-finance, earned-vs-future billing boundaries, cancellation, rollback, and replay.
- [ ] Explicitly report that P1 vehicle swap/change-center expansion remains out of scope.
- [ ] Commit and request independent review.

## Task 8: Governed API, RBAC, access synchronizer, and public projections

**Files:**

- Add `apps/api/src/subscription-closure/subscription-closure.controller.ts` and DTOs.
- Modify module wiring, shared permission codes, labels, seed/access synchronizer, controller tests, and permission matrix tests.
- Add customer-safe/admin projections.

- [ ] Add dedicated permissions for closure prepare/view/receive/inspect/settle; recovery assess/approve/execute; early-termination create/execute; waiver/write-off approval reuse.
- [ ] Grant `ADMIN` all; restrict other roles to exact duties; no implicit broad role.
- [ ] Expose exact route inventory and reject inherited/accidental mutation routes in tests.
- [ ] DTOs fail closed on UUIDs, dates, cents, enums, nesting, lengths, source tuples, and unknown properties.
- [ ] Public projections recursively remove approval comments, command envelopes, provider payloads, and BigInt.
- [ ] Run dry-run/apply/replay/cleanup proof only against the dedicated database; generic seed is never executed as part of proof.
- [ ] Commit and request independent review.

## Task 9: Admin/Portal surfaces and three acceptance journeys

**Files:**

- Modify `apps/web/src/app/orders/[id]/page.tsx` and its focused workspace/view-model tests for the admin closure panel.
- Add `apps/web/src/lib/subscription-closure-api.ts` and `apps/web/src/lib/subscription-closure-view-model.ts` with focused tests.
- Add customer-safe closure projection to the existing Portal order/journey surface under `apps/web/src/app/portal/**`; freeze the exact files after a pre-edit code survey and record any necessary scope ruling.
- Add three named production-equivalent API/database/web acceptance suites and register any serial PostgreSQL suite explicitly.

- [ ] Admin displays current case, return/work orders, restrictions, inspection, settlement revisions, approvals, event timeline, audit links, and allowed recovery actions.
- [ ] Portal displays only customer-safe status, return appointment, signed/evidence references, settlement result, and next action.
- [ ] Journey A: expiry → return → inspection/reconditioning → final settlement → contract completed → inventory release.
- [ ] Journey B: D+7 assessment → separate admin approval → recovery → secured → inspection → termination settlement.
- [ ] Journey C: early termination agreement → return → inspection → final settlement → termination.
- [ ] Each journey asserts API, authoritative database facts, admin and Portal projections, audit, notification/outbox, exact replay, rollback/recovery, and no fixture residue.
- [ ] Commit and request independent review.

## Task 10: Rollout reconciliation and runbook

**Files:**

- Add `docs/runbooks/stage1-p0-subscription-closure-rollout.zh-CN.md`.
- Add `scripts/stage1-p0-subscription-closure-reconciliation.test.mjs`.
- Add only package-script/cross-link changes required to run the validator.

- [ ] Add independent `BEGIN TRANSACTION READ ONLY` SQL blocks for migration catalog, permissions, schema objects/triggers, case-state integrity, source receipts, physical control/occupancy, work-order/restriction links, settlement revisions/financial resolution, approval snapshots, order/contract/lease projections, audit, and fixture residue.
- [ ] Validator must parse and mutation-test the actual SQL and exact API/permission inventories.
- [ ] Record inherited checksum/drift/rolled-back and historical unresolved-stop evidence unchanged; do not claim rollout eligibility.
- [ ] Execute every block verbatim against the dedicated database and publish only sanitized counts.
- [ ] Commit and request independent review.

## Task 11: Whole-branch verification, review, publication, and handoff

- [ ] Run focused unit and all serial PostgreSQL suites after the last tracked edit.
- [ ] Run full API/shared/web tests, repo lint/typecheck, API/web builds, Prisma status/validate/generate, formatting/diff/scope/secret scans, and exact fixture-residue/session audits.
- [ ] Obtain an independent whole-branch review of the frozen base-to-head package. Fix all Critical/Important findings with fresh RED/GREEN and rereview; record deferred Minors.
- [ ] Push one branch and create one ready PR. Wait for exact-head CI and zero blocking review threads.
- [ ] Merge normally without admin/bypass/force/squash/rebase. Verify the exact merge-SHA `main` CI succeeds.
- [ ] Do not deploy or apply to Production.
- [ ] Stop at the human acceptance boundary and provide the three exact manual journeys, required roles/test data, expected facts, and rollback/recovery observations.

## Definition of done

- The three P0 journeys pass automated production-equivalent acceptance with authoritative facts, audit, notification, public/admin projections, replay, concurrency, and residue assertions.
- Physical receipt no longer finalizes financial closure or releases inventory prematurely.
- Normal contracts finish as `COMPLETED`; early termination/recovery finish as `TERMINATED` only after final settlement.
- Recovery cannot execute without a current administrator approval, and voluntary return/recovery races yield one physical-control result.
- Every cost, responsibility, waiver/write-off, and recovery result is traceable through the append-only ledger and evidence.
- One reviewed PR is merged normally and exact merge-SHA main CI is green.
- Production rollout remains blocked until inherited reconciliation stops are separately resolved and authorized.
