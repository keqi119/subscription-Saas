# Delivery Mileage Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make confirmed delivery and return mileage auditable, update `Vehicle.currentMileageKm` only through an immutable mileage ledger, and default delivery confirmation to the signed Stage 2 time and Field mileage.

**Architecture:** Introduce a focused `VehicleMileageModule` that owns append-only mileage readings and the vehicle mileage projection. Vehicle creation, delivery confirmation, and return confirmation call this service inside their existing transactions. The admin web reads authoritative confirmation defaults from the delivery-check API and exposes vehicle mileage as read-only history after creation.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, Vitest, Next.js App Router, React, Ant Design.

## Global Constraints

- `Vehicle.currentMileageKm` is a projection; every post-creation change must have a matching active `VehicleMileageReading` in the same transaction.
- Existing vehicles receive one `LEGACY_MIGRATION` reading without changing their current mileage.
- Delivery time and mileage remain editable, but the server revalidates Stage 2 completion, Field source data, non-regression, and order state at commit time.
- Return confirmation must use the same ledger service; no direct `currentMileageKm` write may remain in `OrderService`.
- Residual-value formulas remain unchanged. Mileage writes only set the existing `salePriceReinitRequiredAt` marker.
- Use TDD: each behavioral change must have a failing test before production code changes.

---

### Task 1: Add the immutable vehicle mileage schema and historical backfill

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260802100000_vehicle_mileage_readings/migration.sql`
- Create: `apps/api/test/vehicle-mileage-schema.spec.ts`

**Interfaces:**
- Add enums `VehicleMileageSourceType` and `VehicleMileageReadingStatus`.
- Add model `VehicleMileageReading` with relations to `Vehicle`, optional `SubscriptionOrder`, previous reading, confirmer, and voider.
- Enforce unique `(sourceType, sourceRecordId)` and indexes on `(vehicleId, status, recordedAt)` and `(orderId, recordedAt)`.

- [x] **Step 1: Write the failing schema test**

Assert that the Prisma schema contains the two enums, the required model fields, the source uniqueness constraint, and relations from `Vehicle` and `SubscriptionOrder`.

```ts
expect(schema).toContain("model VehicleMileageReading {");
expect(schema).toContain("@@unique([sourceType, sourceRecordId])");
expect(schema).toContain("mileageReadings VehicleMileageReading[]");
```

- [x] **Step 2: Run the test to verify RED**

Run: `pnpm --filter @subscription-saas/api test -- vehicle-mileage-schema.spec.ts`

Expected: FAIL because the ledger does not exist.

- [x] **Step 3: Add the Prisma model and migration**

Use these source values: `VEHICLE_INITIALIZATION`, `LEGACY_MIGRATION`, `DELIVERY_BASELINE`, `MONTHLY_REVIEW`, `RETURN_CONFIRMATION`, `MANUAL_CORRECTION`; use statuses `ACTIVE` and `VOIDED`. Store `sourceRecordId` as `VarChar(128)`, `recordedAt`/confirmation/void timestamps as `Timestamptz(6)`, and evidence/audit snapshots as JSON.

The migration must create the schema first, then backfill one reading per non-deleted historical vehicle:

```sql
INSERT INTO "vehicle_mileage_readings" (...)
SELECT gen_random_uuid(), v."id", 'LEGACY_MIGRATION', v."id",
       COALESCE(v."updated_at", v."created_at"), v."current_mileage_km", v."current_mileage_km",
       'ACTIVE', jsonb_build_object('migration', '20260802100000'), v."created_at", v."updated_at"
FROM "vehicles" v
WHERE v."deleted_at" IS NULL
ON CONFLICT ("source_type", "source_record_id") DO NOTHING;
```

- [x] **Step 4: Validate schema and migration**

Run:

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api test -- vehicle-mileage-schema.spec.ts
```

Expected: both commands exit 0.

- [x] **Step 5: Commit the schema slice**

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260802100000_vehicle_mileage_readings/migration.sql apps/api/test/vehicle-mileage-schema.spec.ts
git commit -m "feat: add immutable vehicle mileage ledger"
```

### Task 2: Implement the transaction-safe mileage ledger service

**Files:**
- Create: `apps/api/src/vehicle-mileage/vehicle-mileage.module.ts`
- Create: `apps/api/src/vehicle-mileage/vehicle-mileage.service.ts`
- Create: `apps/api/src/vehicle-mileage/vehicle-mileage.controller.ts`
- Create: `apps/api/src/vehicle-mileage/vehicle-mileage.types.ts`
- Create: `apps/api/test/vehicle-mileage.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/shared/src/auth.ts`
- Modify: `apps/api/prisma/seed.mjs`

**Interfaces:**

```ts
export interface AppendVehicleMileageReadingInput {
  vehicleId: string;
  orderId?: string | null;
  sourceType: VehicleMileageSourceType;
  sourceRecordId: string;
  recordedAt: Date;
  mileageKm: number;
  confirmedBy?: string | null;
  evidenceSnapshot?: Prisma.InputJsonValue;
}

appendConfirmedReading(
  tx: Prisma.TransactionClient,
  input: AppendVehicleMileageReadingInput
): Promise<VehicleMileageReading>;
```

- [x] **Step 1: Write failing service tests**

Cover initialization with zero/positive mileage, delivery append, duplicate source idempotency, mileage regression rejection, atomic projection update, and list ordering. Assert a source collision with different values is rejected rather than silently reused.

- [x] **Step 2: Run the tests to verify RED**

Run: `pnpm --filter @subscription-saas/api test -- vehicle-mileage.spec.ts`

Expected: FAIL because the module is absent.

- [x] **Step 3: Implement append and query behavior**

Inside `appendConfirmedReading`, lock the vehicle and latest active reading using `SELECT ... FOR UPDATE`, validate non-negative integer and non-regression, create the reading, and update `vehicle.currentMileageKm` plus `salePriceReinitRequiredAt` in the same transaction. `VEHICLE_INITIALIZATION` and `LEGACY_MIGRATION` may opt out of the residual recalculation marker.

Expose `GET /vehicles/:id/mileage-readings` behind new permission `vehicle_mileage:view`; return newest first with source, cumulative mileage, delta, recorded time, related order, and status. Do not expose mutable endpoints.

- [x] **Step 4: Register permission and module**

Add `PermissionCode.VEHICLE_MILEAGE_VIEW = "vehicle_mileage:view"`, seed it for system administrator and vehicle/order operational roles, import `VehicleMileageModule` from `AppModule`, and export `VehicleMileageService` for `VehicleModule` and `OrderModule`.

- [x] **Step 5: Run focused tests**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- vehicle-mileage.spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
```

Expected: PASS.

- [x] **Step 6: Commit the service slice**

```powershell
git add apps/api/src/vehicle-mileage apps/api/src/app.module.ts packages/shared/src/auth.ts apps/api/prisma/seed.mjs apps/api/test/vehicle-mileage.spec.ts
git commit -m "feat: centralize vehicle mileage projection updates"
```

### Task 3: Create initialization readings and block direct mileage edits

**Files:**
- Modify: `apps/api/src/vehicle/vehicle.module.ts`
- Modify: `apps/api/src/vehicle/vehicle.service.ts`
- Modify: `apps/api/src/vehicle/dto/vehicle.dto.ts`
- Create: `apps/api/test/vehicle-mileage-integration.spec.ts`

**Interfaces:**
- `CreateVehicleDto.currentMileageKm` remains optional and defaults to `0`.
- `UpdateVehicleDto.currentMileageKm` remains parseable so the service can return a precise business error, but is never written.
- Vehicle creation returns only after both vehicle and `VEHICLE_INITIALIZATION` reading commit.

- [x] **Step 1: Write failing integration tests**

Assert create produces exactly one initialization reading and a matching projection. Assert PATCH with `currentMileageKm` throws `车辆创建后只能通过里程流程单据更新当前里程。`, while an unrelated vehicle edit still succeeds.

- [x] **Step 2: Run the tests to verify RED**

Run: `pnpm --filter @subscription-saas/api test -- vehicle-mileage-integration.spec.ts`

- [x] **Step 3: Refactor create into one transaction**

Change the retry helper so `vehicle.create` and `createInitializationReading` share the same transaction client. Preserve business-number retry and existing audit behavior.

- [x] **Step 4: Reject direct updates explicitly**

At the start of `updateVehicle`, reject when `dto.currentMileageKm !== undefined`; remove `assignIfDefined(data, "currentMileageKm", ...)` from `updateVehicleData`.

- [x] **Step 5: Verify tests and typecheck**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- vehicle-mileage-integration.spec.ts vehicle-model.spec.ts vehicle-operational-state.spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
```

- [x] **Step 6: Commit the integration slice**

```powershell
git add apps/api/src/vehicle apps/api/test/vehicle-mileage-integration.spec.ts
git commit -m "feat: initialize and protect vehicle mileage"
```

### Task 4: Return authoritative delivery-confirmation defaults

**Files:**
- Modify: `apps/api/src/order/order.service.ts`
- Modify: `apps/api/src/order/order.module.ts`
- Modify: `apps/api/test/order-delivery.spec.ts`

**Interfaces:**

```ts
confirmationDefaults: {
  deliveredAt: string;
  deliveredAtSource: "STAGE2_COMPLETED_AT";
  handoverMileageKm: number;
  handoverMileageSource: "FIELD_WORK_ORDER";
  stage2HandoverId: string;
  fieldWorkOrderId: string;
}
```

- [x] **Step 1: Add failing delivery-check tests**

Use a completed handover with `completedAt` and its outbound Field work order with `handoverMileageKm`; assert `getDeliveryCheck` returns the exact values and source identifiers. Add missing-time and missing-mileage cases that keep confirmation blocked with explicit reasons.

- [x] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/api test -- order-delivery.spec.ts`

- [x] **Step 3: Implement default resolution**

Resolve the active Stage 2 handover and corresponding `VehicleHandoverWorkOrder` by order/handover id. Extend `buildDeliveryCheck` without changing existing readiness fields. Never fall back to server time or vehicle master mileage when Stage 2/Field source is absent.

- [x] **Step 4: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api test -- order-delivery.spec.ts
git add apps/api/src/order apps/api/test/order-delivery.spec.ts
git commit -m "feat: expose signed delivery defaults"
```

### Task 5: Confirm delivery with submitted values and append the baseline

**Files:**
- Modify: `apps/api/src/order/dto/order.dto.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Modify: `apps/api/test/order-delivery.spec.ts`

**Interfaces:**
- `ConfirmDeliveryDto.deliveredAt` and `handoverMileageKm` become required.
- The transaction creates one `DELIVERY_BASELINE` reading with source record `VehicleDelivery.id` and stores source/default/final values in `evidenceSnapshot`.

- [x] **Step 1: Add failing confirmation tests**

Freeze time and prove a submitted `deliveredAt` is persisted instead of `new Date()`. Assert delivery, order, vehicle projection, and mileage reading commit together. Cover invalid future/before-order time, mileage regression, duplicate confirmation, and manual override snapshots.

- [x] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/api test -- order-delivery.spec.ts vehicle-mileage.spec.ts`

- [x] **Step 3: Implement the atomic confirmation**

Parse `dto.deliveredAt`, reload Stage 2 and Field defaults inside the transaction, validate the supplied values, update delivery/order, call `appendConfirmedReading`, and transition vehicle to `LEASED`. Do not issue a separate direct mileage update.

- [x] **Step 4: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api test -- order-delivery.spec.ts vehicle-mileage.spec.ts
git add apps/api/src/order apps/api/test/order-delivery.spec.ts
git commit -m "feat: persist delivery mileage baseline"
```

### Task 6: Route return confirmation through the mileage ledger

**Files:**
- Modify: `apps/api/src/order/order.service.ts`
- Modify: `apps/api/test/order-return.spec.ts`

- [x] **Step 1: Add failing return tests**

Assert confirmation creates a `RETURN_CONFIRMATION` reading sourced by `VehicleReturn.id`, updates the projection, and rejects a value below the latest active ledger reading even if the old delivery row is lower.

- [x] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/api test -- order-return.spec.ts`

- [x] **Step 3: Replace the direct write**

Call `appendConfirmedReading` inside the existing return transaction, then update only vehicle status in the order service. Preserve damage, audit, and order-completion logic.

- [x] **Step 4: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api test -- order-return.spec.ts vehicle-mileage.spec.ts
git add apps/api/src/order/order.service.ts apps/api/test/order-return.spec.ts
git commit -m "refactor: record return mileage through ledger"
```

### Task 7: Update the admin delivery dialog and vehicle mileage presentation

**Files:**
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Modify: `apps/web/src/app/vehicles/page.tsx`
- Create: `apps/web/src/lib/vehicle-mileage-view-model.ts`
- Create: `apps/web/test/vehicle-mileage-view-model.spec.ts`
- Modify: `apps/web/test/admin-order-workspace.spec.ts`

- [x] **Step 1: Write failing view-model/UI tests**

Assert the delivery form uses `confirmationDefaults`, renders both source labels, and marks fields as manually adjusted only after the operator changes them. Assert an existing vehicle form renders current mileage read-only and the timeline maps all source/status labels.

- [x] **Step 2: Run RED**

Run: `pnpm --filter @subscription-saas/web test -- vehicle-mileage-view-model.spec.ts admin-order-workspace.spec.ts`

- [x] **Step 3: Implement the UI**

Populate the modal only after `/orders/:id/delivery-check` resolves. Show `Stage 2 双方签署完成时间` and `Field 现场交接里程` under the controls. Keep both fields editable and send ISO time plus integer mileage. On vehicle edit, remove the mileage input; on vehicle create, retain initial mileage. Add a mileage timeline drawer backed by `GET /vehicles/:id/mileage-readings`.

- [x] **Step 4: Run GREEN, lint/typecheck, and commit**

```powershell
pnpm --filter @subscription-saas/web test -- vehicle-mileage-view-model.spec.ts admin-order-workspace.spec.ts
pnpm --filter @subscription-saas/web exec tsc --noEmit -p tsconfig.json
git add apps/web/src/app/orders/[id]/page.tsx apps/web/src/app/vehicles/page.tsx apps/web/src/lib/vehicle-mileage-view-model.ts apps/web/test
git commit -m "feat: surface delivery mileage sources and history"
```

### Task 8: Verify Stage A end to end

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-delivery-mileage-baseline-monthly-review-design.md` only if implementation evidence clarifies a non-behavioral detail.

- [ ] **Step 1: Run migration/schema gates**

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit -p tsconfig.json
```

- [ ] **Step 2: Run focused regression suite**

```powershell
pnpm --filter @subscription-saas/api test -- vehicle-mileage-schema.spec.ts vehicle-mileage.spec.ts vehicle-mileage-integration.spec.ts order-delivery.spec.ts order-return.spec.ts vehicle-sale-price.spec.ts vehicle-depreciation.spec.ts
pnpm --filter @subscription-saas/web test -- vehicle-mileage-view-model.spec.ts admin-order-workspace.spec.ts
```

- [ ] **Step 3: Inspect migration against an empty and populated database**

Apply the migration to a disposable database, confirm every existing non-deleted vehicle has exactly one active reading and `currentMileageKm` is unchanged, then create a fresh vehicle and confirm initialization does not duplicate.

- [ ] **Step 4: Manual API/UI acceptance**

On a controlled Staging order, verify the dialog defaults to signed Stage 2 time and Field mileage, manual edits persist, delivery creates the baseline, vehicle timeline matches the projection, and residual-value reads the updated projection. Verify a return confirmation appends a later record.

- [ ] **Step 5: Final Stage A commit**

Commit only remaining verification/doc changes with `chore: verify delivery mileage baseline`.
