# Stage 1 Active-Term Contract Change Center Implementation Plan

> **Execution rule:** The primary agent executes this plan directly after PR A is merged and deployed. Do not spawn subagents or parallel implementation workers. Use `superpowers:test-driven-development` for each task and `superpowers:verification-before-completion` before PR B.

**Goal:** Fix `ACC-20260826-04` by adding a discoverable Active-order change center for extension, vehicle swap, early termination, and controlled managed-other changes, while preserving the existing pre-delivery order-redesign path.

**Architecture:** Generalize the existing V2 `SubscriptionChangeOrder` root with typed detail tables. Preserve and migrate the working extension flow. Add an original-order vehicle-swap orchestrator that soft-reserves a target vehicle, signs a supplement, coordinates `SWAP_INBOUND`/`SWAP_OUTBOUND`, and atomically switches vehicle-period/contract/entitlement facts. Adapt the existing early-termination Closure flow behind a change order. Keep managed-other changes non-generic and approval-controlled. Enforce one active change per order in PostgreSQL and at the command boundary.

**Tech stack:** NestJS 11, Prisma 7, PostgreSQL 16, TypeScript 6, Vitest 4, Next.js 16, React 19, Ant Design 6, pnpm workspace.

**Approved design:** `docs/superpowers/specs/2026-08-26-stage1-active-term-contract-change-center-design.zh-CN.md`

**Base:** merged PR A. Rebase a new PR B branch on protected `main`; do not stack implementation commits on an unmerged PR A.

## Binding invariants

- The old `OrderChange` route remains pre-delivery only and is labelled “交付前退回重做方案”.
- An order has at most one active V2 contract change across all change types.
- Extension migrations retain existing change numbers, quotes, confirmations, contracts, jobs, and segments.
- Vehicle swap remains within the original `SubscriptionOrder`; no replacement order is created.
- A swap can never leave two active vehicle subscription periods or two `LEASED` vehicles for the same order.
- Early termination cannot stop future bills or start return execution before the governed agreement is effective.
- Managed-other cannot mutate term, vehicle, price, historical bills, or segments through arbitrary JSON.
- Business waiting is a state, not `FAILED` or dead letter. Exact replay is idempotent.
- Forward migrations only; no historical migration edits, `db push`, or database reset.

---

## Task B0: Establish PR B baseline and RED capability tests

**Files:**

- Modify `apps/api/test/subscription-change-schema.spec.ts`.
- Modify `apps/api/test/subscription-change.controller.spec.ts`.
- Add `apps/api/test/subscription-change-active-order.e2e-spec.ts`.
- Modify `apps/web/test/admin-order-workspace.spec.ts`.
- Modify `apps/web/test/subscription-change-admin-pages.spec.tsx`.

**Steps:**

1. Create a clean PR B branch from merged PR A and verify targeted A tests remain green.
2. Add RED API/schema tests for four change types and one-active-change-per-order.
3. Add a RED E2E test proving an `ACTIVE` order can create an extension, swap, early termination, or managed-other request, while the old pre-delivery endpoint still rejects `ACTIVE`.
4. Add RED Web tests for the unified “发起合同变更” entry and renamed pre-delivery action.
5. Run targeted tests and confirm only missing B capability fails.
6. Commit RED tests.

## Task B1: Generalize the V2 change-order schema without losing extension data

**Files:**

- Modify `apps/api/prisma/schema.prisma`.
- Add `apps/api/prisma/migrations/20260826020000_stage1_active_term_change_center/migration.sql`.
- Modify `apps/api/test/subscription-change-schema.spec.ts`.
- Modify `apps/api/test/subscription-change-migration.spec.ts`.
- Modify `apps/api/test/subscription-change-migration.integration.spec.ts`.

**Schema changes:**

- Extend `SubscriptionChangeType` with `VEHICLE_SWAP`, `EARLY_TERMINATION`, and `MANAGED_OTHER`.
- Add `SubscriptionExtensionChangeDetail` and move extension months, pricing mode, target dates, price-override data, and source segment ownership into the typed detail.
- Add `SubscriptionVehicleSwapChangeDetail` with source/target vehicle, target plan/package version, planned/actual swap timestamps, inbound/outbound work-order IDs, and immutable commercial snapshot/hash.
- Add `SubscriptionEarlyTerminationChangeDetail` with effective date, reason snapshot, estimate settlement revision, agreement/contract, and Closure Case links.
- Add `SubscriptionManagedOtherChangeDetail` with reason, effective date, evidence snapshot, approved operation snapshot, before/after snapshots, and supplement link.
- Add an activity marker suitable for a PostgreSQL partial unique index on `order_id` across active statuses.

**Steps:**

1. Write RED schema/migration tests for exactly one typed detail matching the root type and one active root per order.
2. Make extension-only root columns nullable during compatibility rollout; backfill one extension detail per existing row.
3. Add shape constraints that reject mismatched/multiple detail rows and immutable-field update triggers where the repository uses append-only facts.
4. Preserve existing extension query compatibility until service reads are switched.
5. Run Prisma validate/generate, schema tests, and rollback-only real-PostgreSQL migration proofs.
6. Commit migration and schema.

## Task B2: Add generic change commands, repository locking, permissions, and projections

**Files:**

- Add `apps/api/src/subscription-change/subscription-change.repository.ts`.
- Add `apps/api/src/subscription-change/subscription-change.domain.ts`.
- Modify `apps/api/src/subscription-change/subscription-change.types.ts`.
- Modify `apps/api/src/subscription-change/subscription-change.dto.ts`.
- Modify `apps/api/src/subscription-change/subscription-change.service.ts`.
- Modify `apps/api/src/subscription-change/subscription-change.controller.ts`.
- Modify `apps/api/src/subscription-change/subscription-change.module.ts`.
- Modify `packages/shared/src/auth.ts` to add `SUBSCRIPTION_CHANGE_APPROVE`.
- Modify `packages/shared/test/auth.spec.ts`.
- Modify `apps/api/prisma/seed.mjs` and access-baseline scripts/tests.
- Modify `apps/api/test/subscription-change.service.spec.ts`.
- Modify `apps/api/test/subscription-change.controller.spec.ts`.
- Add `apps/api/test/subscription-change.permissions.spec.ts`.

**Steps:**

1. Add RED tests for generic create, load, cancel, allowed-actions, optimistic version, source idempotency, and active-order preconditions.
2. Implement one transaction boundary that locks order, active segment, active change, and relevant resource rows in stable order.
3. Add `POST /subscription-changes` with a discriminated DTO per change type; retain `POST /subscription-changes/extensions` as a compatibility façade.
4. Return a type-safe projection with `allowedActions`; Web must not duplicate the full state machine.
5. Add/seed only permissions that are not already covered by existing subscription-change permissions.
6. Run shared/API tests and commit.

## Task B3: Move extension reads/writes to the typed detail and expose Admin creation

**Files:**

- Modify `apps/api/src/subscription-change/subscription-extension.service.ts`.
- Modify `apps/api/src/subscription-change/subscription-extension-pricing.service.ts`.
- Modify `apps/api/src/subscription-change/subscription-extension-contract.service.ts`.
- Modify `apps/api/src/subscription-change/subscription-extension-activation.service.ts`.
- Modify `apps/api/src/subscription-change/renewal-consideration.service.ts`.
- Modify `apps/api/src/portal/portal-renewal.service.ts`.
- Modify `apps/api/test/subscription-extension-pricing.spec.ts`.
- Modify `apps/api/test/subscription-extension-contract.spec.ts`.
- Modify `apps/api/test/subscription-extension-activation.spec.ts`.
- Modify `apps/api/test/subscription-extension.integration.spec.ts`.
- Modify `apps/api/test/subscription-extension-e2e.spec.ts`.

**Steps:**

1. Add RED compatibility tests that existing extension fixtures produce identical quotes, contracts, segment dates, and activation results after detail migration.
2. Switch extension service reads/writes to `SubscriptionExtensionChangeDetail`; keep a temporary fallback reader for migrated-but-old-shaped rows only during rollout.
3. Route generic `EXTENSION` create to the existing extension service.
4. Prove Admin-created and Renewal-Consideration-created extensions share the same active-change constraint and idempotency rules.
5. Run extension suites and commit.

## Task B4: Add versioned multi-model vehicle-package membership

**Files:**

- Modify `apps/api/prisma/schema.prisma`.
- Add `apps/api/prisma/migrations/20260826021000_stage1_vehicle_package_members/migration.sql`.
- Modify `apps/api/src/product/product.service.ts`.
- Modify `apps/api/src/product/dto/product.dto.ts`.
- Modify `apps/api/test/product-components.spec.ts`.
- Add `apps/api/test/vehicle-package-members.spec.ts`.
- Modify `apps/web/src/app/products/page.tsx`.
- Modify `apps/web/test/product-center-access.spec.ts`.

**Data contract:**

- Add immutable/version-bound `VehiclePackageModelMember` rows keyed by vehicle package and model definition.
- Backfill the current `VehiclePackage.modelDefinitionId` as the sole member.
- Preserve the legacy primary model field during compatibility rollout; all new eligibility checks read membership.

**Steps:**

1. Add RED schema/service tests for multiple members, duplicate prevention, inactive/deleted model rejection, and historical version stability.
2. Add migration and backfill without changing existing package semantics.
3. Change application/swap model eligibility to membership lookup; verify existing single-model paths remain green.
4. Add Admin edit/display support to the existing product/package page.
5. Run product, application, quote, and migration tests; commit.

## Task B5: Implement vehicle-swap quote, target reservation, and customer confirmation

**Files:**

- Add `apps/api/src/subscription-change/subscription-vehicle-swap.service.ts`.
- Add `apps/api/src/subscription-change/subscription-vehicle-swap-pricing.service.ts`.
- Modify `apps/api/src/subscription-change/subscription-change.dto.ts`.
- Modify `apps/api/src/subscription-change/subscription-change.controller.ts`.
- Modify `apps/api/src/portal/portal-renewal.controller.ts`.
- Add `apps/api/src/portal/portal-subscription-change.service.ts` and delegate existing renewal-specific behavior from `portal-renewal.service.ts`.
- Add `apps/api/test/subscription-vehicle-swap-pricing.spec.ts`.
- Add `apps/api/test/subscription-vehicle-swap.service.spec.ts`.
- Add `apps/api/test/subscription-vehicle-swap.integration.spec.ts`.

**Steps:**

1. Write RED tests for Active order/leased source vehicle checks, package membership, target availability, concurrent soft reservation, commercial-delta calculation, quote revision, expiry, confirm, reject, and cancel compensation.
2. Reuse authoritative vehicle-availability and reservation services; never set `Vehicle.status` directly from the quote service.
3. Bind the quote to target vehicle, target package/plan version, effective date, price/deposit/entitlement delta, and stable commercial hash.
4. Publish only after target soft reservation commits. Reject/cancel/expiry releases only the reservation owned by this change.
5. Customer confirm requires exact formal quote revision/hash.
6. Run new swap tests and commit.

## Task B6: Generate and archive the vehicle-swap supplemental agreement

**Files:**

- Add `apps/api/src/subscription-change/subscription-vehicle-swap-contract.service.ts`.
- Modify `apps/api/src/contract/contract.service.ts` and contract template mapping only through existing extension points.
- Modify `apps/api/src/esign/esign.service.ts` only for a new governed source type/slot mapping.
- Modify `apps/api/src/subscription-change/subscription-change-job.service.ts`.
- Modify `apps/api/src/subscription-change/subscription-change.worker.ts`.
- Add `apps/api/test/subscription-vehicle-swap-contract.spec.ts`.
- Add `apps/api/test/subscription-vehicle-swap-esign.spec.ts`.

**Steps:**

1. Add RED tests that a confirmed quote produces one supplement containing old/new vehicle, swap date, price/deposit/entitlement changes, and return/delivery obligations.
2. Reuse existing source-bound contract/e-sign durability. Exact replay must return the same contract/task; quote drift supersedes rather than overwrites.
3. Only archived signed artifacts can advance the change to `SCHEDULED`.
4. Provider pending/unknown states stay waiting; true provider/config failures can retry or enter manual takeover.
5. Run contract/e-sign tests and commit.

## Task B7: Coordinate swap work orders and atomically activate the vehicle change

**Files:**

- Add `apps/api/src/subscription-change/subscription-vehicle-swap-activation.service.ts`.
- Modify `apps/api/src/subscription-change/subscription-change-job.service.ts`.
- Modify `apps/api/src/subscription-change/subscription-change.worker.ts`.
- Modify `apps/api/src/asset-operations/asset-operations.service.ts` only through same-transaction public capabilities.
- Modify `apps/api/src/asset-facts/asset-facts.service.ts`.
- Modify `apps/api/src/order/order-entitlement.service.ts`.
- Add `apps/api/test/subscription-vehicle-swap-activation.spec.ts`.
- Add `apps/api/test/subscription-vehicle-swap-failure-injection.spec.ts`.
- Add `apps/api/test/subscription-vehicle-swap.e2e-spec.ts`.

**Steps:**

1. Add RED tests for one governed `SWAP_INBOUND` and one `SWAP_OUTBOUND`, evidence readiness, physical sequencing, and exact replay.
2. Use existing asset work-order commands; bind both work orders to the change detail.
3. Define the activation gate: signed supplement, valid target reservation, required inbound/outbound handover facts, no blocking restrictions, and any required price-difference settlement.
4. In one caller-owned transaction close the old vehicle subscription period, open the new period, update order current vehicle, activate the contract segment, update future entitlement grants, set target vehicle `LEASED`, and move source vehicle to governed inspection/reconditioning.
5. Inject failures after each mutation and prove rollback leaves exactly one active period/leased vehicle.
6. Complete the change only after all authoritative facts match; otherwise retain `EXECUTING` or enter explicit manual takeover.
7. Run swap activation/E2E tests and commit.

## Task B8: Adapt early termination into the change center

**Files:**

- Add `apps/api/src/subscription-change/subscription-early-termination-change.service.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.service.ts` through a same-transaction adapter, not duplicated closure logic.
- Modify `apps/api/src/subscription-change/subscription-change.controller.ts`.
- Modify `apps/api/src/subscription-change/subscription-change-job.service.ts`.
- Modify `apps/api/src/subscription-change/subscription-change.worker.ts`.
- Modify `apps/api/test/subscription-closure.early-termination.service.spec.ts`.
- Add `apps/api/test/subscription-early-termination-change.spec.ts`.
- Add `apps/api/test/subscription-early-termination-change.e2e-spec.ts`.

**Steps:**

1. Add RED tests for estimate, customer decision, agreement, cancellation before execution, future-bill boundary, Closure creation/link, and completion after operational closure.
2. Wrap the existing `initiateEarlyTermination`, cancel, and execute capabilities with the V2 root and typed detail.
3. Do not duplicate `SubscriptionClosureCase` authority or settlement calculations.
4. Cancel/reject before effective execution restores original contract/billing and releases the active-change slot.
5. Keep the change `EXECUTING` while Closure is operationally open; complete it after Closure reaches the correct operational terminal even if a legal receivable remains.
6. Run early-termination and Closure regressions; commit.

## Task B9: Implement controlled managed-other changes

**Files:**

- Add `apps/api/src/subscription-change/subscription-managed-other.service.ts`.
- Modify `apps/api/src/subscription-change/subscription-change.dto.ts`.
- Modify `apps/api/src/subscription-change/subscription-change.controller.ts`.
- Add `apps/api/test/subscription-managed-other.spec.ts`.
- Add `apps/api/test/subscription-managed-other.permissions.spec.ts`.

**Steps:**

1. Add RED tests requiring reason, effective date, evidence, approved operation, before snapshot, and immutable execution result.
2. Permit only an explicit allowlist of non-term/non-vehicle/non-price/non-historical-bill operations.
3. Route any attempted extension, vehicle change, termination, price, or segment mutation to the dedicated type with a stable validation error.
4. Require a supplement and customer signature when the approved operation changes customer rights/obligations.
5. Store execution as immutable before/after facts with actor and approval; no generic field patch endpoint.
6. Run tests and commit.

## Task B10: Build the unified Admin and Portal change-center UI

**Files:**

- Modify `apps/web/src/lib/subscription-change-api.ts`.
- Modify `apps/web/src/lib/subscription-change-view-model.ts`.
- Modify `apps/web/src/app/subscription-changes/page.tsx`.
- Modify `apps/web/src/app/subscription-changes/[id]/page.tsx`.
- Modify `apps/web/src/app/orders/[id]/page.tsx`.
- Modify `apps/web/src/app/portal/subscription-changes/[id]/page.tsx`.
- Modify `apps/web/src/app/portal/orders/[id]/page.tsx`.
- Modify `apps/web/src/constants/labels.ts`.
- Modify `apps/web/test/subscription-change-view-model.spec.ts`.
- Modify `apps/web/test/subscription-change-admin-pages.spec.tsx`.
- Modify `apps/web/test/admin-order-workspace.spec.ts`.
- Add `apps/web/test/subscription-change-portal-pages.spec.tsx`.

**Steps:**

1. Add RED UI tests for the four-type modal, active-change blocking, type-specific forms, allowed actions, customer quote confirmation/rejection, e-sign entry, swap work-order progress, and Closure link.
2. Rename and restrict the old pre-delivery action.
3. Implement create calls and route to the new change detail.
4. Render backend-provided allowed actions and stable blocking reasons; do not duplicate server state transitions.
5. Ensure Portal exposes customer-visible terms/evidence only.
6. Run Web tests, typecheck, lint, and accessibility-sensitive form assertions; commit.

## Task B11: Add rollout/bootstrap controls and Staging preflight

**Files:**

- Modify `apps/api/src/subscription-change/subscription-change.config.ts`.
- Add `scripts/stage1-contract-change-bootstrap-core.mjs`.
- Add `scripts/stage1-contract-change-bootstrap.mjs`.
- Add `scripts/stage1-contract-change-bootstrap.test.mjs`.
- Modify `package.json`.
- Modify deployment environment documentation without writing secrets.

**Steps:**

1. Validate extension/swap/early-termination/managed-other feature flags independently, with extension explicitly enabled for Staging.
2. Dry-run existing Active orders for missing BASE contract segments, invalid active periods, multiple active changes, and unmigrated extension details.
3. Apply only deterministic BASE-segment/detail backfills; report ambiguous orders for manual repair.
4. Add idempotent script tests and root commands.
5. Run preflight against the dedicated test database only; commit.

## Task B12: Full verification and PR B

**Steps:**

1. Run all subscription-change, extension, swap, early-termination, contract-segment, Closure integration, package membership, and related Web suites.
2. Run `pnpm prisma:validate`, `pnpm prisma:generate`, migration checksum/status, API/Web/shared typecheck and lint.
3. Run bootstrap dry-run on the dedicated test database and prove zero unintended writes.
4. Run `pnpm test` and `pnpm build`.
5. Review concurrency/failure-injection evidence and verify no dual active change, dual vehicle period, or orphan reservation.
6. Update `ACC-20260826-04` with commits/test evidence, but close only after Staging verification.
7. Push PR B, require CI green, merge, deploy, and manually verify extension, swap, early termination, and managed-other entry before beginning PR C.
