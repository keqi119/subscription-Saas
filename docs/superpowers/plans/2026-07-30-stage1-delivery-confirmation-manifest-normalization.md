# Stage 1 Delivery Confirmation Manifest Normalization Implementation Plan

> **Goal:** Remove the Stage 1A delivery-confirmation blocker caused by comparing a prefixed evidence manifest hash with its persisted digest, without weakening Stage 2 integrity gates or changing data.

**Architecture:** `HandoverWorkOrderService` owns the boundary between the evidence package representation and the persisted Stage 2 handover representation. It must convert `sha256:<digest>` to `<digest>` before delegating to `DeliveryHandoverService`. The lower-level delivery gate continues to compare canonical 64-character digests.

**Tech Stack:** NestJS, TypeScript, Prisma, Vitest, pnpm.

---

## Task 1: Capture the regression

**Files:**

- Modify: `apps/api/test/handover-work-order.spec.ts`

1. Make the confirmed-work-order fixture persist the evidence package's 64-character digest on the handover.
2. Make the delivery-handover test double enforce the same digest equality as production.
3. Run the focused test and verify it fails because the service passes `sha256:<digest>`.

## Task 2: Normalize at the service boundary

**Files:**

- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/delivery-handover/delivery-handover.service.ts`

1. Normalize the current evidence package hash with the existing strict SHA-256 helper.
2. Pass the resulting digest to `DeliveryHandoverService`.
3. Rename the lower-level parameter to make the digest contract explicit.
4. Keep real hash mismatches and all existing signing-integrity checks fail-closed.

## Task 3: Verify focused and surrounding behavior

**Files:**

- Test: `apps/api/test/handover-work-order.spec.ts`
- Test: `apps/api/test/delivery-handover.spec.ts`
- Test: `apps/api/test/order-delivery.spec.ts`

1. Run the new focused regression and verify it passes.
2. Run delivery-handover and order-delivery suites.
3. Run API typecheck and Prisma schema validation.
4. Inspect the diff for accidental schema, migration, generated-file, or staging-data changes.

## Task 4: Prepare integration and staging handoff

1. Commit only the design, plan, production fix, and tests.
2. Push a dedicated branch and open a PR against `main`.
3. Verify PR checks and merge only when healthy.
4. Confirm `main` is aligned with the merge commit.
5. Hand off a staging rebuild checklist; do not deploy or mutate staging in this task.
