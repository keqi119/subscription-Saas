# Stage 1C-B Asset Work Orders and Operational Restrictions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the additive Stage 1C-B common asset-operations substrate: governed asset work orders, append-only events and evidence, authoritative vehicle operational restrictions, and one fail-closed availability helper used by every current allocation/delivery/re-entry boundary.

**Architecture:** Add a new `asset-operations` domain beside—not inside—the existing delivery handover, return, service-case, and Fleet Ops domains. `AssetWorkOrder` is a mutable current header; its events and evidence are append-only facts; restrictions have immutable start facts and a single audited release; a pure availability evaluator consumes vehicle, open occupancy, and active restriction snapshots. Existing specialist records remain authoritative for their own details and link through a stable source tuple without historical conversion.

**Tech Stack:** NestJS 11, TypeScript 6, Prisma 7, PostgreSQL, Vitest 4, Node test runner, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-08-18-stage1-capability-boundary-audit-revised-baseline-design.zh-CN.md`

## Global Constraints

- Work only in `D:\Projects\auto-subscription-platform\.worktrees\stage1c-common-facts-20260818`; do not create a second worktree or touch user-owned changes in the main checkout.
- Base this increment on `origin/main` merge `32278d03af2aab769a06e99c9128eaacd4a9cb82`; publish from branch `stage1c-b-work-orders-restrictions-20260820`.
- Use the dedicated local PostgreSQL container `subscription-saas-codex-postgres`, port `55432`, database `subscription_saas_codex`; read its password with `docker inspect` directly into a child-process environment and never print the password or `DATABASE_URL`.
- Create exactly one new forward-only migration for 1C-B. Never edit a historical migration, run `prisma db push`, reset a database, or repair the known 58 historical checksum mismatches.
- Never perform a Production backfill apply, permission apply, deployment, or seed. `pnpm prisma:seed` is forbidden in deployed environments because it mutates demo/business fixtures.
- Existing `VehicleHandoverWorkOrder`, `VehicleReturn`, `ServiceCase`, `VehicleConditionReport`, `InsuranceClaim`, and their evidence remain specialist facts. Do not replace, bulk-convert, or write their state from the common domain in 1C-B.
- Existing `Vehicle.status`, order status, Lease status, and Stage 1C-A period facts remain authoritative. 1C-B adds guards and projections; it does not introduce a second lifecycle state machine.
- Do not infer an `AssetOwner`, ownership period, work order, restriction, inspection, physical-control fact, or evidence record from a status or missing relationship.
- All command identities use an exact stable source tuple `{ type, id, key }`. HTTP writes require exactly one `Idempotency-Key`, and it must equal `body.source.key`.
- Command repositories require a caller-owned Prisma interactive transaction with `READ COMMITTED`; they never open their own transaction. Acquire the command-source advisory lock first, authority rows with `FOR SHARE NOWAIT` in the repository-wide stable order second, then mutable domain rows with `FOR UPDATE`.
- Exact replay returns the original result. The same source tuple with any different authority snapshot or command payload returns a stable `409` conflict. Database constraints remain the final concurrency guard.
- `AssetWorkOrderEvent` and `AssetWorkOrderEvidence` are append-only. PostgreSQL triggers reject update/delete. Evidence correction appends `SUPERSEDE` or `REMOVE`; it never edits or soft-deletes a prior row.
- A restriction's start identity, vehicle, type, severity, scopes, and start snapshot never change. A command may close it once as `RELEASED` or `VOIDED`; replay is exact and a second different release conflicts.
- `DEAD_LETTER` is never an asset work-order or restriction business state. Technical task failure cannot close a work order or release a restriction.
- 1C-B exposes all seven approved work-order types but does not activate the P0 `RETURN_INBOUND` handover flow or the P0 recovery/settlement orchestration.
- Multiple active work orders of the same type are allowed when their source tuples identify different incidents. Do not add a partial unique constraint on `(vehicleId, workOrderType)`.
- Generic work orders link to specialist records through their stable source tuple plus core optional order/contract/customer FKs. Do not add delivery-only or return-only FKs to the common header in 1C-B.
- Generate `workOrderNo` with the existing `createBusinessNo("AWO")` helper and the repository's bounded unique-business-number retry pattern; clients never supply it.
- Work-order status is exactly `PENDING`, `IN_PROGRESS`, `WAITING_EXTERNAL`, `PENDING_ACCEPTANCE`, `PENDING_COST_CONFIRMATION`, `CLOSED`, or `CANCELLED`. `CLOSED` and `CANCELLED` are terminal.
- Work-order transitions are exactly: `PENDING -> IN_PROGRESS|CANCELLED`; `IN_PROGRESS -> WAITING_EXTERNAL|PENDING_ACCEPTANCE|CANCELLED`; `WAITING_EXTERNAL -> IN_PROGRESS|CANCELLED`; `PENDING_ACCEPTANCE -> IN_PROGRESS|PENDING_COST_CONFIRMATION|CLOSED|CANCELLED`; `PENDING_COST_CONFIRMATION -> IN_PROGRESS|CLOSED|CANCELLED`. `PENDING_ACCEPTANCE -> CLOSED` is allowed only when `costConfirmationRequired=false`; `PENDING_ACCEPTANCE -> PENDING_COST_CONFIRMATION` only when it is true.
- Evidence `ATTACH` and `SUPERSEDE` require a live `FileObject` plus a lowercase 64-hex `contentSha256`; `REMOVE` requires no file/hash and must name the evidence row it removes. Freeze bucket, object key, file size, MIME type, and hash in the append-only evidence row.
- Restriction types are exactly `RETURN_INSPECTION_PENDING`, `REINSPECTION_PENDING`, `RECONDITIONING_PENDING`, `MAINTENANCE_OR_ACCIDENT`, `RECOVERY_IN_PROGRESS`, `LEGAL_HOLD`, `EVIDENCE_EXCEPTION`, `OWNERSHIP_EXCEPTION`, `OTHER`.
- Restriction severities are `ADVISORY` and `BLOCKING`; scopes are `ALLOCATION`, `DELIVERY`, `CUSTOMER_USE`, and `INVENTORY_RELEASE`. Only an active `BLOCKING` restriction blocks its listed scopes.
- Releasing `LEGAL_HOLD`, `OWNERSHIP_EXCEPTION`, or `EVIDENCE_EXCEPTION` requires `vehicle_restriction:approve_release`; other releases require `vehicle_restriction:release`. A linked work-order restriction cannot be released before the work order reaches `PENDING_COST_CONFIRMATION` or `CLOSED`.
- The availability evaluator is pure and fail-closed. It is the shared rule used by available-vehicle reads, allocation/reservation, delivery confirmation, and every current write that moves a vehicle to `AVAILABLE`.
- 1C-B has no historical apply. The rollout runbook provides read-only reconciliation SQL and explicitly classifies unlinked specialist facts as review items, never as inferred work orders/restrictions.
- Each task uses strict RED/GREEN TDD, commits only its scoped files, receives a task-scoped independent review, and completes with a clean tracked worktree before the next task.

---

## Binding Interfaces and Domain Decisions

Use these names verbatim across tasks:

```ts
export type StableAssetOperationSource = Readonly<{
  type: string;
  id: string;
  key: string;
}>;

export enum VehicleAvailabilityPurpose {
  ALLOCATION = "ALLOCATION",
  DELIVERY = "DELIVERY",
  MARK_AVAILABLE = "MARK_AVAILABLE"
}

export type VehicleAvailabilityReasonCode =
  | "VEHICLE_NOT_FOUND"
  | "VEHICLE_DELETED"
  | "LIFECYCLE_STATUS_BLOCKED"
  | "SALE_PRICE_NOT_EFFECTIVE"
  | "SALE_PRICE_NOT_POSITIVE"
  | "ACTIVE_SUBSCRIPTION_PERIOD"
  | "ACTIVE_OPERATIONAL_RESTRICTION";

export interface VehicleAvailabilityInput {
  purpose: VehicleAvailabilityPurpose;
  vehicle: null | {
    id: string;
    status: VehicleStatus;
    deletedAt: Date | null;
    salePriceStatus: SalePriceStatus;
    currentSalePriceAmount: bigint | null;
  };
  activeSubscriptionPeriods: ReadonlyArray<{ id: string; orderId: string }>;
  activeRestrictions: ReadonlyArray<{
    id: string;
    restrictionType: VehicleOperationalRestrictionType;
    severity: VehicleOperationalRestrictionSeverity;
    scopes: readonly VehicleOperationalRestrictionScope[];
    sourceType: string;
    sourceId: string;
    sourceKey: string;
    workOrderId: string | null;
  }>;
}

export interface VehicleAvailabilityDecision {
  available: boolean;
  purpose: VehicleAvailabilityPurpose;
  reasons: ReadonlyArray<{
    code: VehicleAvailabilityReasonCode;
    restrictionId?: string;
    sourceId?: string;
    sourceType?: string;
    workOrderId?: string;
  }>;
}
```

Lifecycle rules:

```ts
const PURPOSE_STATUSES = {
  ALLOCATION: new Set([VehicleStatus.AVAILABLE]),
  DELIVERY: new Set([VehicleStatus.RESERVED]),
  MARK_AVAILABLE: new Set([
    VehicleStatus.DRAFT,
    VehicleStatus.IN_PREPARATION,
    VehicleStatus.RETURNED,
    VehicleStatus.MAINTENANCE,
    VehicleStatus.AVAILABLE
  ])
} as const;
```

`ALLOCATION` and `MARK_AVAILABLE` require an effective positive sale price; `DELIVERY` preserves the already-reviewed reserved price. All three reject an open `VehicleSubscriptionPeriod`. `MARK_AVAILABLE` checks active blocking restrictions in `ALLOCATION`, `DELIVERY`, or `INVENTORY_RELEASE`; the other purposes check their matching scope. The result returns every reason in deterministic `(code, restrictionId)` order.

## Task 1: Add the 1C-B schema and forward-only migration

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260820120000_stage1c_asset_work_orders_restrictions/migration.sql`
- Create: `apps/api/test/asset-operations.schema.spec.ts`

**Interfaces:**

- Consumes: Stage 1C-A stable source tuple and `AuditLog` conventions.
- Produces: Prisma enums/models `AssetWorkOrder`, `AssetWorkOrderEvent`, `AssetWorkOrderEvidence`, `VehicleOperationalRestriction` and their relations.

- [ ] **Step 1: Re-run the secret-safe database preflight**

Run `pnpm prisma:migrate:status`, `pnpm prisma:validate`, and `pnpm prisma:generate` with the dedicated container URL injected only into the process. Expected: 92 applied migrations, schema valid, generate exit `0`. Record—but do not repair—the known datasource/schema drift and 58 checksum mismatches.

- [ ] **Step 2: Write failing schema contract tests**

Create tests which read `schema.prisma` and the new migration path and assert the exact enum values from Global Constraints; exact table names; source tuple unique constraints; append-only triggers; restriction all-null/all-non-null release tuple; evidence action/file/hash checks; event/evidence immutable triggers; and indexes on vehicle/status, source identity, assignee/SLA, work-order timeline, and active restrictions.

```ts
expect(schema).toContain("model AssetWorkOrder {");
expect(schema).toContain("model AssetWorkOrderEvent {");
expect(schema).toContain("model AssetWorkOrderEvidence {");
expect(schema).toContain("model VehicleOperationalRestriction {");
expect(migration).toContain('CREATE TRIGGER "asset_work_order_event_append_only"');
expect(migration).toContain('CREATE TRIGGER "asset_work_order_evidence_append_only"');
```

Run: `pnpm --filter @subscription-saas/api exec vitest run test/asset-operations.schema.spec.ts`

Expected RED: the four models/migration do not exist.

- [ ] **Step 3: Add the exact Prisma enums and models**

Add the seven work-order types, seven statuses, priorities `LOW|NORMAL|HIGH|URGENT`, core event types `CREATED|ASSIGNED|STARTED|WAITING_EXTERNAL|RESUMED|EVIDENCE_ATTACHED|SUBMITTED_FOR_ACCEPTANCE|ACCEPTED|COST_CONFIRMED|PHYSICAL_CONTROL_CONFIRMED|INSPECTION_RECORDED|RESTRICTION_CREATED|RESTRICTION_RELEASED|CLOSED|CANCELLED|NOTE_ADDED`, evidence actions `ATTACH|SUPERSEDE|REMOVE`, evidence types `PHOTO|VIDEO|DOCUMENT|SIGNATURE|LOCATION_PROOF|THIRD_PARTY_RECEIPT|INSPECTION_REPORT|OTHER`, and the restriction types/severities/scopes/statuses fixed above.

The work-order header must include: `workOrderNo`, mandatory `vehicleId`, optional `orderId/contractId/customerId/assetOwnerId/relatedWorkOrderId`, `workOrderType/status/priority`, `costConfirmationRequired`, assignee, schedule/SLA, start/accept/cost-confirm/close/cancel timestamps, description/solution/closeReason, stable create source tuple, `authoritySnapshot`, metadata, `version`, and audit columns.

Events include a per-work-order monotonic `sequence`, before/after status, actor, occurred/recorded timestamps, stable source tuple, and detail snapshot. Evidence includes action/type, optional event/file/superseded row, frozen file fields/hash, captured metadata, stable source tuple, and actor. Restrictions include vehicle/work-order, type/severity/scopes/status, start/release facts, conditions/evidence snapshots, stable start/release source tuples, and audit columns.

- [ ] **Step 4: Author the additive SQL migration**

Use PostgreSQL `TIMESTAMPTZ(6)`, named FKs/indexes/checks, and triggers. Include these database invariants:

```sql
CHECK ("occurred_at" <= "recorded_at")
CHECK ("content_sha256" IS NULL OR "content_sha256" ~ '^[0-9a-f]{64}$')
CHECK (("action" = 'REMOVE' AND "file_id" IS NULL AND "content_sha256" IS NULL AND "supersedes_evidence_id" IS NOT NULL)
    OR ("action" = 'ATTACH' AND "file_id" IS NOT NULL AND "content_sha256" IS NOT NULL AND "supersedes_evidence_id" IS NULL)
    OR ("action" = 'SUPERSEDE' AND "file_id" IS NOT NULL AND "content_sha256" IS NOT NULL AND "supersedes_evidence_id" IS NOT NULL))
CHECK (cardinality("scopes") > 0)
CHECK ("released_at" IS NULL OR "released_at" >= "started_at")
```

Release identity, releaser, timestamp, reason, and release snapshot are all null for `ACTIVE` and all non-null for `RELEASED|VOIDED`. Add `UNIQUE(supersedes_evidence_id)` so one immutable evidence version cannot have competing successors.

- [ ] **Step 5: Replay the migration on the dedicated database and run GREEN**

Run migration deploy/status, Prisma validate/generate, the schema test, and a real PostgreSQL constraint test which attempts illegal event update/delete, illegal evidence action shapes, future event time, and partial release tuples. Expected: every invalid write is rejected and all focused tests pass. Do not modify historical migrations if `migrate dev --create-only` reports checksum drift; derive only the additive SQL from the schema diff and verify it on the dedicated database.

- [ ] **Step 6: Commit Task 1**

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260820120000_stage1c_asset_work_orders_restrictions/migration.sql apps/api/test/asset-operations.schema.spec.ts
git commit -m "feat(stage1c): add asset operations facts"
```

## Task 2: Implement work-order, event, and evidence repository commands

**Files:**

- Create: `apps/api/src/asset-operations/asset-operations.types.ts`
- Create: `apps/api/src/asset-operations/asset-operations.repository.ts`
- Create: `apps/api/test/asset-operations.repository.spec.ts`
- Create: `apps/api/test/asset-operations.repository.integration.spec.ts`

**Interfaces:**

- Consumes: Task 1 models and `StableAssetOperationSource`.
- Produces: transaction-only `createWorkOrder`, `assignWorkOrder`, `transitionWorkOrder`, `appendNote`, `appendEvent`, `appendEvidence`, and read projections. `appendEvent` is internal infrastructure; public callers use the named commands.

- [ ] **Step 1: Write repository unit RED tests**

Cover rejection of root Prisma clients and non-READ-COMMITTED transactions; exact create replay; same-source/different-payload conflict; legal/illegal transitions; version CAS; deterministic event sequence; append-only evidence chain; file liveness; SHA-256 normalization; and stable error codes.

```ts
await expect(repository.createWorkOrder(rootPrisma, command)).rejects.toMatchObject({
  code: "ASSET_OPERATION_TRANSACTION_REQUIRED"
});
await expect(repository.transitionWorkOrder(tx, illegalCommand)).rejects.toMatchObject({
  code: "ASSET_WORK_ORDER_TRANSITION_INVALID"
});
```

Expected RED: repository exports are absent.

- [ ] **Step 2: Implement transaction and lock probes**

Follow the proven Stage 1C-A transaction detector. Acquire a namespaced source advisory lock before loading replay state. Map only actual PostgreSQL/Prisma SQLSTATE `55P03` shapes to `ASSET_OPERATION_AUTHORITY_BUSY`; do not recursively search arbitrary strings or nested payload values.

- [ ] **Step 3: Implement exact create and transition replay**

`createWorkOrder` generates `workOrderNo`, freezes the authority snapshot, and writes the `CREATED` event in the same transaction. `assignWorkOrder` owns `assignedUserId`, `scheduledAt`, and `slaDueAt` and emits `ASSIGNED`. `transitionWorkOrder` locks the header `FOR UPDATE`, verifies `expectedVersion`, applies the fixed transition table, updates the current header, and appends exactly one status event. `appendNote` emits `NOTE_ADDED` without allowing a caller to forge lifecycle, physical-control, inspection, or restriction events. Exact replay returns the original header/event; payload drift returns `ASSET_OPERATION_SOURCE_CONFLICT`.

- [ ] **Step 4: Implement append-event and append-evidence commands**

Assign event sequence while holding the header lock. Reject `occurredAt > transactionNow`. For evidence, lock the referenced file and superseded evidence rows with `FOR SHARE NOWAIT`/`FOR UPDATE`, freeze file metadata, verify action shape and hash, and append an `EVIDENCE_ATTACHED` event exactly once.

- [ ] **Step 5: Prove real PostgreSQL concurrency and rollback**

Write tests where two clients concurrently create the same source, transition the same version, append the same event, and supersede the same evidence. Assert one material row/event/evidence, exact replay for identical payloads, conflict for differing payloads, no aborted-transaction reread, and zero committed rows when the second append or audit stub fails.

Run: `pnpm --filter @subscription-saas/api exec vitest run --project database test/asset-operations.repository.integration.spec.ts`

- [ ] **Step 6: Run focused GREEN and commit Task 2**

Run the unit and database repository files, API lint, and API typecheck. Commit only the four Task 2 files with message `feat(stage1c): add asset work order commands`.

## Task 3: Implement restriction commands and the pure availability evaluator

**Files:**

- Modify: `apps/api/src/asset-operations/asset-operations.types.ts`
- Modify: `apps/api/src/asset-operations/asset-operations.repository.ts`
- Create: `apps/api/src/asset-operations/vehicle-availability.ts`
- Modify: `apps/api/test/asset-operations.repository.spec.ts`
- Modify: `apps/api/test/asset-operations.repository.integration.spec.ts`
- Create: `apps/api/test/vehicle-availability.spec.ts`

**Interfaces:**

- Consumes: Task 2 transaction/source contracts and Task 1 restrictions.
- Produces: `createRestriction`, `releaseRestriction`, `loadAvailabilitySnapshot`, and `evaluateVehicleAvailability(input)`.

- [ ] **Step 1: Write restriction and availability RED tests**

The pure matrix must cover every purpose, every allowed/disallowed lifecycle status, deleted/missing vehicles, sale-price states, zero/negative/null prices, one/multiple open subscription periods, advisory restrictions, released/voided restrictions, each blocking scope, multiple simultaneous reasons, and deterministic order.

```ts
expect(evaluateVehicleAvailability(input)).toEqual({
  available: false,
  purpose: VehicleAvailabilityPurpose.ALLOCATION,
  reasons: [{ code: "ACTIVE_OPERATIONAL_RESTRICTION", restrictionId }]
});
```

Repository RED covers exact create/release replay, conflicting release, missing release evidence, linked work order not yet accepted, multiple active same-type incidents, and concurrent release/create.

- [ ] **Step 2: Implement the pure evaluator**

Use no Prisma/Nest imports other than enum types. Accumulate all reasons, deduplicate by `(code, restrictionId)`, sort deterministically, and return `available = reasons.length === 0`. Never use Fleet Ops confidence scores.

- [ ] **Step 3: Implement restriction repository commands**

Create locks the source and vehicle/work-order authority rows, inserts the immutable start fact, and appends `RESTRICTION_CREATED` to a linked work order. Release locks source, restriction, and linked work-order rows; enforces acceptance; writes the complete release tuple once; and appends `RESTRICTION_RELEASED`. Different source incidents may create simultaneous restrictions.

- [ ] **Step 4: Implement the deterministic availability snapshot loader**

Load one live vehicle, every open subscription period with `startedAt <= asOf < endedAt|null`, and every `ACTIVE` restriction whose `startedAt <= asOf`. Return only the immutable fields required by the evaluator and sort restrictions by ID.

- [ ] **Step 5: Run real concurrency GREEN and commit Task 3**

Run the three focused files with the dedicated DB, API lint, and API typecheck. Commit only Task 3 paths with message `feat(stage1c): add vehicle restrictions and availability rules`.

## Task 4: Add the audited application service and read projections

**Files:**

- Create: `apps/api/src/asset-operations/asset-operations.service.ts`
- Create: `apps/api/test/asset-operations.service.spec.ts`
- Modify: `apps/api/test/asset-operations.repository.integration.spec.ts`

**Interfaces:**

- Consumes: Tasks 2–3 repositories/evaluator and `AuditService`.
- Produces: authenticated service methods used by Task 5 controllers and Task 6 legacy guards.

- [ ] **Step 1: Write service RED tests**

Test complete authority validation for live vehicle/order/contract/customer/asset owner/file; cross-entity ID consistency; no guessed owner; stable source/header command identity; request actor/IP/User-Agent audit context; dynamic high-risk release permission; linked-work-order acceptance; and audit rollback.

- [ ] **Step 2: Implement one transaction boundary per command**

Use `this.prisma.$transaction(async tx => ..., { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })`. Lock authority rows with one stable, `NOWAIT` strategy compatible with order delivery and return paths. All header/event/evidence/restriction writes and one `AuditLog` per new fact commit together; replays do not create duplicate audit rows.

- [ ] **Step 3: Implement dynamic release authorization**

For `LEGAL_HOLD|OWNERSHIP_EXCEPTION|EVIDENCE_EXCEPTION`, require the authenticated permission set to contain `vehicle_restriction:approve_release`; otherwise require `vehicle_restriction:release`. Return `403` with stable code `VEHICLE_RESTRICTION_RELEASE_FORBIDDEN` without changing data.

- [ ] **Step 4: Implement read projections**

Expose work-order detail with ordered events, effective evidence chain, active/all restrictions, source tuple, and specialist deep links computed from source type. Expose vehicle work-order/restriction lists and availability decisions. Never mutate specialist facts while building projections.

- [ ] **Step 5: Prove transaction rollback and authority contention**

Real PostgreSQL tests hold order-first and vehicle-first writer transactions. The Stage 1C-B command must fail fast with `ASSET_OPERATION_AUTHORITY_BUSY`, and the live holder remains usable. Inject an audit failure after each fact kind and assert zero domain rows commit.

- [ ] **Step 6: Run focused GREEN and commit Task 4**

Run service/repository/availability suites, API lint/typecheck, and commit with message `feat(stage1c): add audited asset operations service`.

## Task 5: Add governed HTTP APIs and the production-safe permission baseline

**Files:**

- Create: `apps/api/src/asset-operations/dto/asset-operations.dto.ts`
- Create: `apps/api/src/asset-operations/asset-operations.controller.ts`
- Create: `apps/api/src/asset-operations/asset-operations.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/shared/src/auth.ts`
- Modify: `apps/api/prisma/seed.mjs`
- Modify: `scripts/stage1c-access-baseline-core.mjs`
- Modify: `scripts/stage1c-access-baseline-core.test.mjs`
- Modify: `scripts/stage1c-access-baseline-executor.test.mjs`
- Create: `apps/api/test/asset-operations.controller.spec.ts`
- Modify: `apps/api/test/permissions.spec.ts`

**Interfaces:**

- Consumes: Task 4 service methods.
- Produces: authenticated APIs and exact permission definitions/matrix.

- [ ] **Step 1: Write controller and permission RED tests**

Assert these routes and permissions exactly:

| Route                                                     | Permission                                                                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /asset-operations/work-orders/:id`                   | `asset_operations:view`                                                                                                       |
| `GET /asset-operations/vehicles/:vehicleId/work-orders`   | `asset_operations:view`                                                                                                       |
| `GET /asset-operations/vehicles/:vehicleId/restrictions`  | `asset_operations:view`                                                                                                       |
| `GET /asset-operations/vehicles/:vehicleId/availability`  | `asset_operations:view`                                                                                                       |
| `POST /asset-operations/work-orders`                      | `asset_work_order:manage`                                                                                                     |
| `POST /asset-operations/work-orders/:id/assignment`       | `asset_work_order:manage`                                                                                                     |
| `POST /asset-operations/work-orders/:id/transition`       | `asset_work_order:manage`                                                                                                     |
| `POST /asset-operations/work-orders/:id/notes`            | `asset_work_order:manage`                                                                                                     |
| `POST /asset-operations/work-orders/:id/evidence`         | `asset_work_order:manage`                                                                                                     |
| `POST /asset-operations/vehicles/:vehicleId/restrictions` | `vehicle_restriction:manage`                                                                                                  |
| `POST /asset-operations/restrictions/:id/release`         | any of `vehicle_restriction:release` or `vehicle_restriction:approve_release`, followed by Task 4's exact type-specific check |

Test missing, duplicate, array-shaped, blank, and header/body-mismatched `Idempotency-Key`; nested missing source; UUID/date/hash validation; and authenticated actor/context forwarding.

- [ ] **Step 2: Implement DTO/controller/module**

DTOs use class-validator enums, UUIDs, ISO-8601 dates, trimmed bounded strings, a lowercase 64-hex hash, and `@IsDefined()` for nested source. The release route uses the existing any-permission decorator so a GM with only `vehicle_restriction:approve_release` can reach the type-specific service check. Controller never accepts actor IDs from the body and returns stable `400/403/404/409` service errors.

- [ ] **Step 3: Add exact permission definitions and role matrix**

Definitions are `asset_operations:view`, `asset_work_order:manage`, `vehicle_restriction:manage`, `vehicle_restriction:release`, and `vehicle_restriction:approve_release` in module `asset_operations`.

Matrix:

```ts
ADMIN = all five
AS = all five
OP = view + work-order manage + restriction manage + restriction release
GM = view + approve release
FI = view
RC = view
SA = none
CS = none
```

Extend the safe Stage 1C access synchronizer and generic seed definitions. The synchronizer remains fail-closed on missing/inactive roles or permission identity drift and never writes ownership periods. Do not run generic seed against the dedicated database.

- [ ] **Step 4: Run access dry-run/apply/replay only on the dedicated database**

Use exact existing confirmation `STAGE1C_ACCESS_BASELINE_APPLY=SYNC_STAGE1C_ACCESS_BASELINE`. Prove dry-run, one apply, idempotent replay, exact matrix SQL, one audit for a changing apply, zero ownership writes, then restore only the test-created permission/grant/audit rows with guarded exact predicates. Never run this apply in Production.

- [ ] **Step 5: Run GREEN and commit Task 5**

Run controller, permission, access-baseline, service, API lint/typecheck. Commit only Task 5 files with message `feat(stage1c): expose governed asset operations APIs`.

## Task 6: Enforce the availability helper at every current boundary

**Files:**

- Modify: `apps/api/src/vehicle/vehicle.service.ts`
- Modify: `apps/api/src/vehicle/vehicle.module.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Modify: `apps/api/src/order/order.module.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.module.ts`
- Modify: `apps/api/src/fleet-ops/vehicle-operational-state.types.ts`
- Modify: `apps/api/src/fleet-ops/vehicle-operational-state.repository.ts`
- Modify: `apps/api/src/fleet-ops/vehicle-operational-state.resolver.ts`
- Modify: `apps/api/src/fleet-ops/vehicle-operational-state.rules.ts`
- Modify: `apps/api/test/vehicle.spec.ts`
- Modify: `apps/api/test/order.spec.ts`
- Modify: `apps/api/test/handover-work-order.spec.ts`
- Modify: `apps/api/test/vehicle-operational-state.spec.ts`
- Create: `apps/api/test/vehicle-availability.integration.spec.ts`

**Interfaces:**

- Consumes: Task 4 availability service and Task 3 pure evaluator.
- Produces: one authoritative guard for lists, status writes, reservation/allocation, delivery, and Fleet Ops explanation.

- [ ] **Step 1: Write integration RED tests at unchanged call sites**

Create active blocking restrictions and prove current code wrongly: lists the vehicle as available; moves it to `REVIEW_RESERVED`; confirms reservation; starts delivery; or writes `AVAILABLE` from `REVIEW_RESERVED`, `RESERVED`, `RETURNED`, or `MAINTENANCE`. Add released/advisory/wrong-scope controls which remain allowed.

- [ ] **Step 2: Guard available reads and allocation/reservation**

`VehicleService.listAvailableVehicles()` adds a database `none` filter for active blocking `ALLOCATION` restrictions and no open subscription period. Every order path that changes `AVAILABLE -> REVIEW_RESERVED|RESERVED` calls `assertVehicleAvailable(..., ALLOCATION)` inside its existing transaction after authority locks.

- [ ] **Step 3: Guard delivery**

The handover/order delivery gate calls `assertVehicleAvailable(..., DELIVERY)` while the vehicle is locked and before delivery/handover state writes. A blocking delivery restriction returns stable `409 VEHICLE_OPERATIONALLY_RESTRICTED`; it does not become a workflow retry/dead letter.

- [ ] **Step 4: Guard every current transition to `AVAILABLE`**

Refactor `VehicleService.updateVehicle` and `updateStatus` so the availability snapshot and vehicle update share one READ COMMITTED transaction and authority lock. Guard the three order release writes currently used for review rejection, cancellation, and rollback. Preserve existing return-repricing and positive-price checks; add occupancy and restriction reasons rather than replacing them.

- [ ] **Step 5: Make Fleet Ops explain restrictions as authoritative**

Add `OPERATIONALLY_RESTRICTED` and source `OPERATIONAL_RESTRICTION`. Load active restrictions in the Fleet Ops repository and emit one evidence item per restriction. Its priority is above heuristic service/condition signals; do not alter Fleet Ops into a write boundary.

- [ ] **Step 6: Prove SQL/command parity and concurrency**

For each purpose, compare list/command behavior with the pure evaluator. Hold a concurrent restriction create/release transaction while allocation, delivery, or mark-available runs; assert fail-fast busy or a serial result, never a vehicle made available while a committed blocker is active.

- [ ] **Step 7: Run GREEN and commit Task 6**

Run the five focused test files plus full `test:fleet-ops`, API lint/typecheck/build. Commit only Task 6 files with message `feat(stage1c): enforce operational availability guards`.

## Task 7: Add read-only reconciliation and rollout documentation

**Files:**

- Create: `docs/runbooks/stage1c-asset-operations-rollout.zh-CN.md`
- Modify: `docs/runbooks/stage1c-period-facts-rollout.zh-CN.md`
- Create: `scripts/stage1c-asset-operations-reconciliation.test.mjs`

**Interfaces:**

- Consumes: Tasks 1–6 tables, permissions, and error contracts.
- Produces: copy/paste-safe read-only rollout/reconciliation evidence; no apply script.

- [ ] **Step 1: Write documentation contract RED tests**

The Node test asserts the new runbook contains: non-goals; generic-seed prohibition; no historical apply; migration/checksum/drift gates; exact permissions/matrix; all statuses/types/scopes; event/evidence immutability; reconciliation SQL; active restriction/availability parity SQL; contention/retry behavior; rollback-forward procedure; secret redaction; and explicit stop rules.

- [ ] **Step 2: Write exact read-only reconciliation SQL**

Include queries that classify existing handover work orders, returns, open vehicle service cases, and blocking condition reports as `LINKED`, `UNLINKED_REVIEW_REQUIRED`, or `SOURCE_CONFLICT` using exact source tuples. The runbook must say that `UNLINKED_REVIEW_REQUIRED` is not permission to create a work order/restriction.

- [ ] **Step 3: Add availability and immutability checks**

Include SQL for active blocking restrictions by scope; vehicles marked AVAILABLE but blocked/occupied; restriction release tuple completeness; work-order terminal timestamp consistency; duplicate source tuples; event sequence gaps; competing evidence successors; and AuditLog counts/fingerprints.

- [ ] **Step 4: Execute every SQL query read-only on the dedicated database**

Record row counts and explain local anomalies without mutating them. Run schema validate, migration status, checksum gate, and datasource/schema diff. The known checksum/drift results make this dedicated database rollout-ineligible and must remain documented.

- [ ] **Step 5: Run GREEN and commit Task 7**

Run the Node documentation test, Prettier on both runbooks/test, `git diff --check`, and commit with message `docs(stage1c): add asset operations rollout controls`.

## Task 8: Final regression, review, PR, merge, and post-merge main CI

**Files:**

- Modify only if verification exposes a Stage 1C-B defect; each fix requires its own RED/GREEN and scoped review.
- Evidence: `.superpowers/sdd/2026-08-20-stage1c-b-asset-work-orders-restrictions-implementation-plan/task-8-report.md`

**Interfaces:**

- Consumes: completed reviewed Tasks 1–7.
- Produces: one ready PR, normal merge, and a green post-merge main CI run.

- [ ] **Step 1: Re-run final secret-safe database gates**

Run migration status, Prisma validate/generate, every new unit/database/concurrency test, Stage 1C-A regressions, handover/return/order/vehicle/Fleet Ops suites, access baseline tests, and reconciliation test on the final tree.

- [ ] **Step 2: Run full workspace gates**

Run full API tests, shared tests, web tests, repository lint, full typecheck, API build, web build, changed-file Prettier, and `git diff --check`. Restore only the known generated `apps/web/next-env.d.ts` build delta via `apply_patch` after verifying its exact one-line form.

- [ ] **Step 3: Perform the whole-branch independent review**

Review the complete merge-base diff against this plan and the approved design. No Critical or Important finding may remain. One final fix wave is allowed by the SDD contract; re-run tests covering every amended path and perform one scoped re-review.

- [ ] **Step 4: Verify rollout boundaries**

Confirm: no Production write; no historical migration edit; no generic seed on the dedicated database; no guessed owner/work order/restriction; no enabled `RETURN_INBOUND` handover; no legacy status takeover; exact permission matrix; dedicated DB fixture residue zero.

- [ ] **Step 5: Publish one ready PR and wait**

Check for an existing matching head PR before push. Push `stage1c-b-work-orders-restrictions-20260820`, create one ready PR against `main`, and include migration/locking/evidence/availability/permission risks plus exact verification counts. Wait for checks and review threads; do not bypass a required check.

- [ ] **Step 6: Merge and verify main**

After PR CI is green and no actionable review remains, merge normally. Track the exact merge SHA's main workflow to `completed/success`. Do not deploy or run any Production apply.

- [ ] **Step 7: Record completion and continue to 1C-C**

Write the Task 8 report with PR URL, merge SHA, main CI URL, test counts, known warnings, and all rulings. Keep the worktree; branch the same worktree from the new `origin/main` for the separately migrated 1C-C increment.
