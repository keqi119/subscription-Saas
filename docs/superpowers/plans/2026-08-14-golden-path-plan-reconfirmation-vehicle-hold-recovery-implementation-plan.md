# Golden Path Plan Reconfirmation Vehicle Hold Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the admin-allocated vehicle review-reserved while a revised final plan waits for customer reconfirmation, then safely restore the affected Staging acceptance application.

**Architecture:** Keep the existing Journey sequence and reconfirmation transition. Change only the vehicle-allocation transaction so it reserves the selected target before releasing a different previous hold and persists the selected hold as approved; after customer reconfirmation, the existing state machine can safely skip the completed allocation step and create the order. Recover the single affected Staging record with an explicitly guarded, audited transaction after the fixed image is deployed.

**Tech Stack:** NestJS, TypeScript, Prisma 7, PostgreSQL 17, Vitest, Docker Compose, GitHub Actions/GHCR.

**Approved Design:** `docs/superpowers/specs/2026-08-14-golden-path-plan-reconfirmation-vehicle-hold-recovery-design.zh-CN.md`

## Global Constraints

- Do not change Prisma schema, migrations, Journey step order, API request/response contracts, or Web UI.
- Keep `JOURNEY_APPLICATION_VEHICLE_UNAVAILABLE` for unavailable target vehicles.
- Vehicle allocation remains an audited manual decision; customer reconfirmation changes only plan-confirmation fields.
- Preserve `REVIEW_RESERVED -> RESERVED` as the A-line transition at formal order creation.
- The Staging repair may touch only `APP20260811071250MC2M` and vehicle `3f04c8a9-f485-4830-b5d9-c91b29ad7ff9` after every guard in the approved design passes.
- Use Inline Execution by the primary agent; do not delegate to subagents.

---

### Task 1: Preserve or transfer the allocated vehicle hold during plan reconfirmation

**Files:**
- Modify: `apps/api/test/application-review-api.spec.ts`
- Modify: `apps/api/src/customer/customer.service.ts:1820-1935`

**Interfaces:**
- Consumes: `CustomerService.allocateJourneyVehicle(tx, applicationId, vehicleId, actor, context)` and the existing `releaseApplicationSoftReservedVehicle()` helper.
- Produces: the existing return shape `{ application, requiresCustomerReconfirmation }`; when reconfirmation is required, `application.softReservedVehicleId` identifies the selected vehicle and `application.vehicleReviewStatus` is `APPROVED`.

- [ ] **Step 1: Change the existing regression test to state the required same-vehicle behavior**

Rename the existing test and replace its old release assertions with:

```ts
it("keeps the allocated vehicle held while changed terms wait for reconfirmation", async () => {
  // Keep the existing setup: finalize revision 1, mark it confirmed,
  // then change currentSalePriceAmount before allocation.
  const result = await harness.service.allocateJourneyVehicle(
    harness.tx as never,
    harness.application.id,
    harness.vehicle.id,
    harness.user,
    harness.context
  );

  expect(result.requiresCustomerReconfirmation).toBe(true);
  expect(result.application).toEqual(
    expect.objectContaining({
      customerConfirmedPlanRevision: null,
      finalPlanRevision: 2,
      planConfirmStatus: PlanConfirmStatus.PENDING,
      softReservedVehicleId: harness.vehicle.id,
      vehicleReviewStatus: OrderReviewStatus.APPROVED
    })
  );
  expect(harness.state.vehicleStatus).toBe(VehicleStatus.REVIEW_RESERVED);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- application-review-api.spec.ts
```

Expected: FAIL because the current implementation returns `vehicleReviewStatus = PENDING`, clears `softReservedVehicleId`, and changes the vehicle to `AVAILABLE`.

- [ ] **Step 3: Add transfer and unavailable-target coverage before production changes**

Add two focused tests:

```ts
it("transfers the review hold to a different available final vehicle before reconfirmation", async () => {
  // Configure application.softReservedVehicleId as "vehicle-old".
  // Mock vehicle.findUnique by requested id so vehicle-old is REVIEW_RESERVED
  // and harness.vehicle is AVAILABLE. Trigger changed commercial terms.
  const result = await harness.service.allocateJourneyVehicle(
    harness.tx as never,
    harness.application.id,
    harness.vehicle.id,
    harness.user,
    harness.context
  );

  expect(result.requiresCustomerReconfirmation).toBe(true);
  expect(result.application.softReservedVehicleId).toBe(harness.vehicle.id);
  expect(result.application.vehicleReviewStatus).toBe(OrderReviewStatus.APPROVED);
  expect(harness.tx.vehicle.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: VehicleStatus.REVIEW_RESERVED }),
      where: expect.objectContaining({
        id: harness.vehicle.id,
        status: VehicleStatus.AVAILABLE
      })
    })
  );
  expect(harness.tx.vehicle.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: VehicleStatus.AVAILABLE }),
      where: { id: "vehicle-old" }
    })
  );
});

it("does not release the previous hold when the new final vehicle is unavailable", async () => {
  // Configure vehicle-old as REVIEW_RESERVED and the target as RESERVED.
  await expect(
    harness.service.allocateJourneyVehicle(
      harness.tx as never,
      harness.application.id,
      harness.vehicle.id,
      harness.user,
      harness.context
    )
  ).rejects.toMatchObject({ code: "JOURNEY_APPLICATION_VEHICLE_UNAVAILABLE" });

  expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
  expect(harness.state.application.softReservedVehicleId).toBe("vehicle-old");
});
```

Expected before implementation: the same-vehicle test fails; the transfer test fails because the selected hold is cleared; the unavailable-target test confirms the old hold is not released before target validation.

- [ ] **Step 4: Implement the minimal transaction behavior**

Move `alreadyHeld` above the `termsChanged` branch and use this pattern inside that branch:

```ts
const alreadyHeld =
  before.softReservedVehicleId === details.vehicle.id &&
  details.vehicle.status === VehicleStatus.REVIEW_RESERVED;

if (termsChanged) {
  if (!alreadyHeld) {
    const reserved = await tx.vehicle.updateMany({
      data: { status: VehicleStatus.REVIEW_RESERVED, updatedBy: actor.id },
      where: {
        deletedAt: null,
        id: details.vehicle.id,
        status: VehicleStatus.AVAILABLE
      }
    });
    if (reserved.count !== 1) {
      throw journeyError(
        "JOURNEY_APPLICATION_VEHICLE_UNAVAILABLE",
        "The journey vehicle could not be reserved."
      );
    }
    if (
      before.softReservedVehicleId &&
      before.softReservedVehicleId !== details.vehicle.id
    ) {
      await releaseApplicationSoftReservedVehicle(tx, before, actor);
    }
  }

  const allocatedAt = alreadyHeld
    ? (before.softReservedAt ?? new Date())
    : new Date();
  // Keep the existing revision/snapshot updates, but persist:
  // softReservedAt: allocatedAt
  // softReservedVehicleId: details.vehicle.id
  // vehicleReviewStatus: OrderReviewStatus.APPROVED
  // Do not clear softReservationExpiresAt.
}
```

Remove the duplicate `alreadyHeld` declaration from the unchanged-terms branch. Do not change the Journey signal call or revision semantics.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- application-review-api.spec.ts subscription-journey-application.spec.ts subscription-journey-order-contract.spec.ts
```

Expected: all focused files pass and the reconfirmation signal still carries revision 2 and the selected vehicle id.

- [ ] **Step 6: Commit the code and regression tests**

```powershell
git add apps/api/src/customer/customer.service.ts apps/api/test/application-review-api.spec.ts
git commit -m "fix: retain journey vehicle hold during reconfirmation"
```

### Task 2: Verify the complete branch and publish through PR

**Files:**
- Verify only: repository-wide source and tests
- No schema or migration files should change

**Interfaces:**
- Consumes: the Task 1 vehicle-allocation behavior.
- Produces: a merged `main` commit suitable for immutable API/Web image builds.

- [ ] **Step 1: Run required quality gates**

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm -r lint
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
```

Expected: every command exits 0. Re-run `prisma migrate status` against the controlled Staging configuration and require “Database schema is up to date!”.

- [ ] **Step 2: Verify branch scope**

```powershell
git diff --check origin/main...HEAD
git status --short
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Expected changed implementation files: `customer.service.ts`, `application-review-api.spec.ts`, this plan, and the approved design document only.

- [ ] **Step 3: Push, create PR, wait for checks, and merge**

```powershell
git push -u origin fix/golden-path-reconfirmation-vehicle-hold-20260814
gh pr create --base main --head fix/golden-path-reconfirmation-vehicle-hold-20260814 --fill
$prNumber = gh pr view --json number --jq '.number'
gh pr checks $prNumber --watch
gh pr merge $prNumber --merge --delete-branch
```

Expected: required checks pass and GitHub reports the PR as `MERGED`.

### Task 3: Build, deploy, and recover the affected Staging acceptance record

**Files:**
- Operational configuration: `/opt/subscription-saas/.env.staging.images`
- No repository file changes

**Interfaces:**
- Consumes: merged `origin/main` SHA and existing image-only Staging Compose deployment.
- Produces: matching API/Web containers, repaired acceptance record, and a user-visible retry point.

- [ ] **Step 1: Build and publish immutable images from the merge SHA**

Derive one immutable tag from the merged commit and use it for both images:

```powershell
git fetch origin
$mergeSha = git rev-parse origin/main
$tag = "Staging-$(Get-Date -Format yyyyMMdd)-$($mergeSha.Substring(0, 7))"
```

```text
ghcr.io/keqi119/subscription-api:$tag
ghcr.io/keqi119/subscription-web:$tag
```

Build Web with:

```text
NEXT_PUBLIC_API_BASE_URL=https://staging-api.subauto.keybox.cloud/api
NEXT_DEPLOYMENT_ID=$tag
```

Inspect both remote manifests and record their linux/amd64 digests before deployment.

- [ ] **Step 2: Deploy API first, verify migrations, then deploy Web**

Back up `.env.staging.images`, update only `API_IMAGE` and `WEB_IMAGE`, validate Compose config, pull both images, and recreate API before Web. Require:

- API and Web containers are `healthy`;
- each container `.Config.Image` equals the exact new tag;
- each container image id matches the pulled target id;
- `SizeRw = 0` for both containers;
- Prisma reports no pending migrations.

- [ ] **Step 3: Run the guarded Staging repair transaction**

Before any update, lock and validate the application, Journey, and vehicle rows. Abort unless all approved design guards match. Within one PostgreSQL transaction:

```sql
UPDATE vehicle AS v
SET status = 'REVIEW_RESERVED',
    updated_at = clock_timestamp(),
    updated_by = a.sales_user_id
FROM application AS a
WHERE v.id = '3f04c8a9-f485-4830-b5d9-c91b29ad7ff9'::uuid
  AND a.id = 'bfa9e3bf-3ac1-418d-bc53-a0ce758488b3'::uuid
  AND a.final_vehicle_id = v.id
  AND a.plan_confirm_status = 'CONFIRMED'
  AND a.customer_confirmed_plan_revision = a.final_plan_revision
  AND a.final_plan_revision = 2
  AND v.status = 'AVAILABLE'
  AND v.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM subscription_order AS o
    WHERE o.vehicle_id = v.id
      AND o.deleted_at IS NULL
      AND o.order_status NOT IN ('CANCELLED', 'REJECTED', 'COMPLETED', 'TERMINATED')
  )
  AND NOT EXISTS (
    SELECT 1 FROM application AS holder
    WHERE holder.soft_reserved_vehicle_id = v.id
      AND holder.id <> a.id
      AND holder.deleted_at IS NULL
  );

UPDATE application
SET soft_reserved_vehicle_id = final_vehicle_id,
    soft_reserved_at = clock_timestamp(),
    soft_reservation_expires_at = clock_timestamp() + interval '24 hours',
    vehicle_review_status = 'APPROVED',
    updated_at = clock_timestamp(),
    updated_by = sales_user_id
WHERE id = 'bfa9e3bf-3ac1-418d-bc53-a0ce758488b3'::uuid
  AND final_vehicle_id = '3f04c8a9-f485-4830-b5d9-c91b29ad7ff9'::uuid
  AND plan_confirm_status = 'CONFIRMED'
  AND customer_confirmed_plan_revision = final_plan_revision
  AND final_plan_revision = 2
  AND NOT EXISTS (SELECT 1 FROM subscription_order WHERE application_id = application.id);

INSERT INTO application_action_log (
  id, application_id, action_type, from_status, to_status, comment,
  operator_id, operator_name, created_at, updated_at, created_by, updated_by
)
SELECT gen_random_uuid(), id, 'APPROVE', status, status,
       'Staging repair: restore Golden Path vehicle hold after final-plan reconfirmation',
       sales_user_id, 'Golden Path repair', clock_timestamp(), clock_timestamp(),
       sales_user_id, sales_user_id
FROM application
WHERE id = 'bfa9e3bf-3ac1-418d-bc53-a0ce758488b3'::uuid
  AND soft_reserved_vehicle_id = final_vehicle_id
  AND vehicle_review_status = 'APPROVED';
```

The executable repair script must assert exactly one vehicle row and one application row changed and must re-query: vehicle status, soft holder count, active order count, Journey status/step, and exact confirmed revision before `COMMIT`.

- [ ] **Step 4: Run public smoke checks and hand off manual acceptance**

Verify HTTP 200 for API health, Admin login/application, and Portal application entry. Scan fresh API/Web logs for `error|exception|fatal|unhandled`.

Notify the user to open the Admin application and click “重试失败步骤” once. Expected result:

- order and main contract are created;
- Journey advances to the Fadada signing step;
- customer is not asked to confirm a third time;
- vehicle becomes `RESERVED`.
