# VehicleModel Enum Final Removal Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Prisma `VehicleModel` enum with zero data loss, no pricing regression, no runtime enum dependency, and a rehearsed rollback path.

**Architecture:** Use an expand-and-contract migration sequence. First isolate every enum-typed schema dependency behind `modelDefinitionId` and string compatibility fields, then switch API/CSV/report contracts to string or modelDefinition fields, then drop enum-typed columns, and only then delete `enum VehicleModel`.

**Tech Stack:** Prisma 7, PostgreSQL, NestJS API, Next.js web, pnpm workspace, Vitest, Node scripts, existing VehicleModel runtime evidence / contract governance / ProductPriceRule decommission gates.

---

## Non-Implementation Boundary For Stage 10X-X

This document is the Stage 10X-X final execution plan only.

This stage must not:

- edit `apps/api/prisma/schema.prisma`;
- create or run migrations;
- delete `VehicleModel`;
- modify database rows;
- change API behavior;
- change CSV/report behavior;
- deploy to production.

The current repository state after Stage 10X-W is:

- `ProductPriceRule` uniqueness is canonical on `productVersionId + modelDefinitionId`;
- legacy `ProductPriceRule` `productVersionId + vehicleModel` unique index has been decommissioned;
- runtime read/write logic is modelDefinitionId-first;
- runtime evidence and contract governance exist;
- external contract governance still reports hard removal as not ready until all external enum references are retired.

## Current Remaining Hard Dependencies

The final removal cannot start until every dependency below has an assigned replacement and passing evidence.

| Schema dependency | Current field | Final replacement | Removal risk |
| --- | --- | --- | --- |
| `enum VehicleModel` | frozen enum values `ET5 / ET5T / ET7 / ES6 / EC6 / ES8 / ET9 / ES9` | no enum after all typed fields are gone | High |
| `Vehicle.vehicleModel` | `VehicleModel?` | `Vehicle.modelDefinitionId`, optionally `legacyVehicleModelCode String?` for compatibility | High |
| `VehiclePackage.vehicleModel` | `VehicleModel` | `VehiclePackage.modelDefinitionId`, optionally `legacyVehicleModelCode String?` | High |
| `ProductPriceRule.vehicleModel` | `VehicleModel` | `ProductPriceRule.modelDefinitionId`, optionally `legacyVehicleModelCode String?` | High |
| `SubscriptionPlan.vehicleModel` | `VehicleModel?` through package snapshot/compat paths | `modelDefinitionId` from package/plan relations or string compatibility snapshot | Medium |
| `VehicleModelDefinition.legacyVehicleModel` | `VehicleModel? @unique` | `legacyVehicleModelCode String? @unique` or retirement after all fallback is gone | High |
| `SubscriptionQuote.vehicleModel` | `VehicleModel` historical fact | `modelDefinitionIdSnapshot`, `modelDisplayNameSnapshot`, `legacyVehicleModelCodeSnapshot` | High |
| `SubscriptionQuote.legacyVehicleModelSnapshot` | `VehicleModel?` | `legacyVehicleModelCodeSnapshot` | High |
| `SubscriptionOrder.vehicleModel` | `VehicleModel` historical fact | `modelDefinitionIdSnapshot`, `modelDisplayNameSnapshot`, `legacyVehicleModelCodeSnapshot` | High |
| `SubscriptionOrder.legacyVehicleModelSnapshot` | `VehicleModel?` | `legacyVehicleModelCodeSnapshot` | High |

## Final Safety Gate

Do not begin hard schema removal unless every line below is true on a production-like clone and immediately before production migration:

```text
vehicle-model removal readiness decision = READY
vehicle-model readiness score = 100
businessDecisionUsageCount = 0
fallbackUsageCount = 0
externalUsageCount = 0
contract governance hardRemovalReady = true
ProductPriceRule constraint decommission ready = true
Quote / Order string snapshot coverage = 100%
API v2 contract consumers signed off
CSV/report v2 consumers signed off
production-like clone migration rehearsal passed
rollback rehearsal passed
```

Required commands:

```powershell
pnpm vehicle-model:removal-readiness
pnpm vehicle-model:contract-governance
pnpm product-price-rule:constraint-decommission
pnpm release:check
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected gate output:

```json
{
  "decision": "READY",
  "readinessScore": 100,
  "businessDecisionUsageCount": 0,
  "fallbackUsageCount": 0,
  "externalUsageCount": 0
}
```

If any value differs, stop. Do not edit schema.

## File Responsibility Map

Future implementation will touch these files only in the stages where they are listed.

| File | Responsibility |
| --- | --- |
| `apps/api/prisma/schema.prisma` | Remove enum-typed fields only after string/code replacements and contract gates are green |
| `apps/api/prisma/migrations/*` | Add string compatibility fields, backfill-safe indexes, drop enum fields, drop enum type |
| `apps/api/src/common/vehicle-model-resolver.ts` | Remove enum input types after all DTOs and services use strings/modelDefinitionId |
| `apps/api/src/common/vehicle-model-snapshot.ts` | Make Quote/Order display fully string-snapshot based |
| `apps/api/src/common/vehicle-model-usage-tracker.ts` | Keep evidence until after hard removal, then retire enum-specific counters |
| `apps/api/src/product/*` | Remove Product/Package/PriceRule enum-typed DTOs and service signatures |
| `apps/api/src/vehicle/*` | Remove Vehicle enum DTOs and system-derived enum writes |
| `apps/api/src/report/*` | Remove legacy enum filters after v2 report contracts are default |
| `apps/api/src/portal/*` | Remove catalog legacy enum filter and keep customer-friendly display |
| `apps/api/src/vehicle-model-definition/*` | Replace `legacyVehicleModel` enum input with string code or remove legacy mapping |
| `apps/api/test/*` | Replace enum fixtures with modelDefinitionId/string code fixtures |
| `apps/web/src/*` | Remove hard-coded enum option arrays and legacy enum editable UI |
| `scripts/*vehicle-model*` | Replace enum freeze guard with no-enum guard and final-removal preflight |
| `docs/*` | Record final removal rehearsal, cutover, rollback, and owner sign-off |

## Migration Strategy Overview

Use five separate branches and migrations. Do not combine these into one large migration.

| Phase | Purpose | Production posture |
| --- | --- | --- |
| X-A Expand string compatibility | Add missing string/code fields and backfill scripts | Safe, reversible |
| X-B Contract cutover | API/CSV/report clients consume canonical/string fields | No schema deletion |
| X-C Enum field removal rehearsal | Drop enum-typed columns on production-like clone only | No production |
| X-D Production enum field removal | Drop enum-typed columns after green rehearsal | Maintenance window |
| X-E Enum type deletion | Delete `enum VehicleModel` after no column references it | Maintenance window |

## Zero-Downtime Strategy

The safe strategy is not a single zero-downtime drop. It is a staged compatible rollout:

```text
expand nullable string fields
backfill string fields
deploy app that ignores enum fields
observe zero enum usage
remove enum columns in a maintenance window
delete enum type after all enum columns are gone
```

True zero downtime is allowed only if all active application versions tolerate both schemas. If old app versions still import enum-typed Prisma fields, use a short maintenance window.

## Task 1: Final Dependency Validation

**Files:**
- Read: `apps/api/prisma/schema.prisma`
- Read: `apps/api/src/**`
- Read: `apps/web/src/**`
- Read: `scripts/**`
- Read: `docs/stage-10x-vehicle-model-schema-final-removal-preparation.md`
- Create later if missing: `docs/stage-10x-vehicle-model-final-removal-dependency-report.md`

- [ ] **Step 1: Confirm current branch is based on Stage 10X-W**

Run:

```powershell
git log --oneline -5
git status --short
```

Expected:

```text
contains feat: decommission product price rule legacy constraint
working tree clean
```

- [ ] **Step 2: Generate schema dependency inventory**

Run:

```powershell
rg -n "enum VehicleModel|vehicleModel\\s+VehicleModel|vehicleModel\\s+VehicleModel\\?|legacyVehicleModel\\s+VehicleModel|legacyVehicleModelSnapshot\\s+VehicleModel" apps/api/prisma/schema.prisma
```

Expected before implementation:

```text
VehicleModel enum and enum-typed fields are listed.
```

Expected before hard deletion:

```text
no enum-typed fields remain
```

- [ ] **Step 3: Generate API/DTO enum dependency inventory**

Run:

```powershell
rg -n "VehicleModel|@IsEnum\\(VehicleModel\\)|vehicleModel\\?:" apps/api/src apps/web/src
```

Expected before hard deletion:

```text
Only string compatibility fields, documentation strings, and no-enum guards remain.
No DTO imports VehicleModel from @prisma/client.
```

- [ ] **Step 4: Run contract governance**

Run:

```powershell
pnpm vehicle-model:contract-governance
```

Expected before hard deletion:

```json
{
  "hardRemovalReady": true,
  "blockingConsumers": 0,
  "missingReferences": 0
}
```

- [ ] **Step 5: Run runtime evidence**

Run:

```powershell
pnpm vehicle-model:removal-readiness
```

Expected before hard deletion:

```json
{
  "businessDecisionUsageCount": 0,
  "fallbackUsageCount": 0,
  "externalUsageCount": 0,
  "decision": "READY"
}
```

- [ ] **Step 6: Commit dependency report**

Run:

```powershell
git add docs/stage-10x-vehicle-model-final-removal-dependency-report.md
git commit -m "docs: record vehicle model final removal dependencies"
```

## Task 2: Expand String Compatibility Fields

**Files:**
- Modify later: `apps/api/prisma/schema.prisma`
- Create later: `apps/api/prisma/migrations/<timestamp>_vehicle_model_string_compatibility/migration.sql`
- Create later: `scripts/vehicle-model-string-compatibility-backfill.mjs`
- Create later: `scripts/vehicle-model-string-compatibility-backfill-core.mjs`
- Create later: `scripts/vehicle-model-string-compatibility-backfill-core.test.mjs`

- [ ] **Step 1: Add nullable string compatibility columns**

Target Prisma shape:

```prisma
model VehicleModelDefinition {
  legacyVehicleModelCode String? @unique @map("legacy_vehicle_model_code") @db.VarChar(64)
}

model Vehicle {
  legacyVehicleModelCode String? @map("legacy_vehicle_model_code") @db.VarChar(64)
}

model VehiclePackage {
  legacyVehicleModelCode String? @map("legacy_vehicle_model_code") @db.VarChar(64)
}

model ProductPriceRule {
  legacyVehicleModelCode String? @map("legacy_vehicle_model_code") @db.VarChar(64)
}

model SubscriptionPlan {
  legacyVehicleModelCode String? @map("legacy_vehicle_model_code") @db.VarChar(64)
}
```

Do not remove any existing enum fields in this task.

- [ ] **Step 2: Write failing backfill core test**

Create `scripts/vehicle-model-string-compatibility-backfill-core.test.mjs` with:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildVehicleModelStringCompatibilityBackfillPlan } from "./vehicle-model-string-compatibility-backfill-core.mjs";

test("plans string code updates without overwriting existing values", () => {
  const plan = buildVehicleModelStringCompatibilityBackfillPlan({
    records: [
      { id: "vehicle-1", legacyVehicleModelCode: null, vehicleModel: "ET5" },
      { id: "vehicle-2", legacyVehicleModelCode: "ES6", vehicleModel: "ET5" }
    ],
    tableName: "Vehicle"
  });

  assert.deepEqual(plan.updates, [{ id: "vehicle-1", legacyVehicleModelCode: "ET5" }]);
  assert.equal(plan.skippedExisting, 1);
  assert.equal(plan.unresolved.length, 0);
});

test("reports unresolved records without a code source", () => {
  const plan = buildVehicleModelStringCompatibilityBackfillPlan({
    records: [{ id: "vehicle-1", legacyVehicleModelCode: null, vehicleModel: null }],
    tableName: "Vehicle"
  });

  assert.equal(plan.updates.length, 0);
  assert.deepEqual(plan.unresolved, [{ id: "vehicle-1", reason: "missing vehicleModel", tableName: "Vehicle" }]);
});
```

- [ ] **Step 3: Run test and verify it fails before implementation**

Run:

```powershell
node --test scripts/vehicle-model-string-compatibility-backfill-core.test.mjs
```

Expected:

```text
ERR_MODULE_NOT_FOUND or missing function
```

- [ ] **Step 4: Implement dry-run/apply guarded backfill**

Implementation rules:

```text
default dry-run
apply requires VEHICLE_MODEL_STRING_COMPATIBILITY_BACKFILL_APPLY=1
production apply also requires ALLOW_PRODUCTION_VEHICLE_MODEL_STRING_COMPATIBILITY_BACKFILL=1
never overwrite existing string code
fail apply when unresolved > 0
write .tmp/vehicle-model-string-compatibility-backfill/latest.json
```

- [ ] **Step 5: Run migration locally/staging only**

Run:

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
pnpm vehicle-model:string-compatibility-backfill:dry-run
```

Expected:

```text
unresolved = 0
conflicts = 0
```

- [ ] **Step 6: Apply backfill in local/staging**

Run:

```powershell
$env:VEHICLE_MODEL_STRING_COMPATIBILITY_BACKFILL_APPLY="1"
pnpm vehicle-model:string-compatibility-backfill:apply
pnpm vehicle-model:string-compatibility-backfill:dry-run
```

Expected:

```text
second dry-run updated = 0
skippedExisting equals total records needing string compatibility
```

- [ ] **Step 7: Commit expand phase**

Run:

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations scripts package.json docs
git commit -m "feat: add vehicle model string compatibility fields"
```

## Task 3: Switch Runtime And Contracts Away From Enum Types

**Files:**
- Modify later: `apps/api/src/common/vehicle-model-resolver.ts`
- Modify later: `apps/api/src/common/vehicle-model-snapshot.ts`
- Modify later: `apps/api/src/vehicle/dto/vehicle.dto.ts`
- Modify later: `apps/api/src/product/dto/product.dto.ts`
- Modify later: `apps/api/src/report/dto/report.dto.ts`
- Modify later: `apps/api/src/portal/portal-catalog.dto.ts`
- Modify later: `apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts`
- Modify later: `apps/web/src/app/**`

- [ ] **Step 1: Replace DTO enum inputs with strings or remove deprecated inputs**

Target DTO pattern:

```ts
/** @deprecated Compatibility-only model code. Use modelDefinitionId. */
@IsOptional()
@IsString()
vehicleModel?: string;
```

Do not use:

```ts
@IsEnum(VehicleModel)
vehicleModel?: VehicleModel;
```

- [ ] **Step 2: Replace resolver enum types with string codes**

Target resolver output:

```ts
export type ResolvedVehicleModel = {
  legacyVehicleModelCode: string | null;
  modelDefinitionId: string | null;
  modelDisplayName: string | null;
  source: "MODEL_DEFINITION_ID" | "STRING_CODE" | "UNKNOWN";
};
```

- [ ] **Step 3: Replace Quote/Order display enum fallback with code snapshot fallback**

Target display priority:

```text
modelDisplayNameSnapshot
modelDefinitionIdSnapshot lookup displayName
legacyVehicleModelCodeSnapshot
runtime modelDefinition.displayName
runtime legacyVehicleModelCode
null
```

- [ ] **Step 4: Run enum import scan**

Run:

```powershell
rg -n "import \\{[^}]*VehicleModel|VehicleModel\\b|@IsEnum\\(VehicleModel\\)" apps/api/src apps/web/src
```

Expected:

```text
No runtime service or DTO import uses VehicleModel.
Only migration scripts, old docs, and no-enum guard tests may reference the literal name.
```

- [ ] **Step 5: Run full verification**

Run:

```powershell
pnpm release:check
pnpm -r lint
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web build
```

Expected:

```text
all commands exit 0
```

- [ ] **Step 6: Commit contract switch**

Run:

```powershell
git add apps/api/src apps/web/src scripts docs package.json
git commit -m "feat: switch vehicle model contracts to string compatibility"
```

## Task 4: Clone Rehearsal For Enum Field Removal

**Files:**
- Create later: `docs/stage-10x-vehicle-model-enum-removal-rehearsal.md`
- Create later: `scripts/vehicle-model-enum-removal-preflight.mjs`
- Test later: `scripts/vehicle-model-enum-removal-preflight.test.mjs`

- [ ] **Step 1: Create preflight script**

The script must fail unless all checks are true:

```text
no runtime import of VehicleModel
no @IsEnum(VehicleModel)
no schema field uses VehicleModel except fields scheduled for removal
contract governance hardRemovalReady = true
runtime readiness decision = READY
ProductPriceRule decommission ready = true
Quote / Order legacyVehicleModelCodeSnapshot coverage = 100%
string compatibility fields coverage = 100%
```

- [ ] **Step 2: Run on production-like clone**

Run:

```powershell
pnpm vehicle-model:enum-removal-preflight
pnpm release:check
```

Expected:

```text
preflight ready = true
release check passes
```

- [ ] **Step 3: Record rehearsal evidence**

Create `docs/stage-10x-vehicle-model-enum-removal-rehearsal.md` with:

```markdown
# Stage 10X-X Enum Removal Rehearsal

Environment: production-like clone
Date: YYYY-MM-DD
Source backup id: <backup id>

## Preflight

- vehicle-model:removal-readiness: READY
- vehicle-model:contract-governance: hardRemovalReady true
- ProductPriceRule decommission: ready true
- string compatibility coverage: 100%

## Migration Rehearsal

- expand migrations applied: pass
- drop enum fields migration applied: pass
- enum type deletion migration applied: pass

## Smoke Tests

- quote pricing: pass
- subscription plan quote: pass
- order creation: pass
- reports CSV: pass
- portal catalog: pass

## Rollback Rehearsal

- application rollback: pass
- schema restore / backup restore: pass
```

- [ ] **Step 4: Commit rehearsal report**

Run:

```powershell
git add docs/stage-10x-vehicle-model-enum-removal-rehearsal.md scripts/vehicle-model-enum-removal-preflight*
git commit -m "docs: record vehicle model enum removal rehearsal"
```

## Task 5: Drop Enum-Typed Operational Columns

**Files:**
- Modify later: `apps/api/prisma/schema.prisma`
- Create later: `apps/api/prisma/migrations/<timestamp>_drop_operational_vehicle_model_enum_fields/migration.sql`

- [ ] **Step 1: Remove operational enum fields from Prisma schema**

Remove:

```prisma
Vehicle.vehicleModel
VehiclePackage.vehicleModel
ProductPriceRule.vehicleModel
SubscriptionPlan.vehicleModel
VehicleModelDefinition.legacyVehicleModel
```

Keep:

```prisma
modelDefinitionId
modelDefinition
legacyVehicleModelCode
legacyVehicleModelCodeSnapshot
modelDisplayNameSnapshot
```

- [ ] **Step 2: Generate migration on clone**

Run:

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate diff --from-url $env:DATABASE_URL --to-schema-datamodel prisma/schema.prisma --script
```

Expected migration content:

```sql
ALTER TABLE "vehicle" DROP COLUMN "vehicle_model";
ALTER TABLE "vehicle_package" DROP COLUMN "vehicle_model";
ALTER TABLE "product_price_rule" DROP COLUMN "vehicle_model";
ALTER TABLE "subscription_plan" DROP COLUMN "vehicle_model";
ALTER TABLE "vehicle_model_definition" DROP COLUMN "legacy_vehicle_model";
```

Do not include amount, status, quote/order, payment, billing, residual, or contract changes.

- [ ] **Step 3: Run clone migration**

Run:

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
pnpm release:check
```

Expected:

```text
migration deploy succeeds
release check passes
```

- [ ] **Step 4: Commit operational field removal**

Run:

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations docs
git commit -m "feat: drop operational vehicle model enum fields"
```

## Task 6: Drop Quote / Order Enum Snapshot Columns

**Files:**
- Modify later: `apps/api/prisma/schema.prisma`
- Create later: `apps/api/prisma/migrations/<timestamp>_drop_quote_order_vehicle_model_enum_fields/migration.sql`

- [ ] **Step 1: Confirm historical string snapshot coverage**

Run:

```sql
SELECT COUNT(*) FROM subscription_quote WHERE legacy_vehicle_model_code_snapshot IS NULL;
SELECT COUNT(*) FROM subscription_order WHERE legacy_vehicle_model_code_snapshot IS NULL;
```

Expected:

```text
0
0
```

- [ ] **Step 2: Remove historical enum fields**

Remove:

```prisma
SubscriptionQuote.vehicleModel
SubscriptionQuote.legacyVehicleModelSnapshot
SubscriptionOrder.vehicleModel
SubscriptionOrder.legacyVehicleModelSnapshot
```

Keep:

```prisma
modelDefinitionIdSnapshot
modelDisplayNameSnapshot
legacyVehicleModelCodeSnapshot
```

- [ ] **Step 3: Generate migration**

Expected migration content:

```sql
ALTER TABLE "subscription_quote" DROP COLUMN "vehicle_model";
ALTER TABLE "subscription_quote" DROP COLUMN "legacy_vehicle_model_snapshot";
ALTER TABLE "subscription_order" DROP COLUMN "vehicle_model";
ALTER TABLE "subscription_order" DROP COLUMN "legacy_vehicle_model_snapshot";
```

- [ ] **Step 4: Run historical display regression tests**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- quote-order-model-snapshot.spec.ts order
pnpm --filter @subscription-saas/web build
```

Expected:

```text
Quote / Order display uses modelDisplayNameSnapshot or legacyVehicleModelCodeSnapshot.
No API response requires enum snapshot fields.
```

- [ ] **Step 5: Commit historical field removal**

Run:

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src apps/api/test apps/web/src docs
git commit -m "feat: drop quote order vehicle model enum fields"
```

## Task 7: Delete `enum VehicleModel`

**Files:**
- Modify later: `apps/api/prisma/schema.prisma`
- Create later: `apps/api/prisma/migrations/<timestamp>_drop_vehicle_model_enum_type/migration.sql`
- Modify later: `scripts/check-vehicle-model-enum-freeze.mjs`
- Modify later: `scripts/release-check.mjs`

- [ ] **Step 1: Confirm no schema field references enum**

Run:

```powershell
rg -n "\\bVehicleModel\\b" apps/api/prisma/schema.prisma
```

Expected:

```text
only enum VehicleModel block remains
```

- [ ] **Step 2: Delete enum block from schema**

Remove:

```prisma
enum VehicleModel {
  ET5
  ET5T
  ET7
  ES6
  EC6
  ES8
  ET9
  ES9
}
```

- [ ] **Step 3: Generate migration**

Expected migration content:

```sql
DROP TYPE "VehicleModel";
```

If PostgreSQL reports dependencies, stop and return to Task 5 or Task 6.

- [ ] **Step 4: Replace enum freeze guard with no-enum guard**

New guard behavior:

```text
fail if enum VehicleModel exists in schema.prisma
fail if any Prisma model field has type VehicleModel
pass if VehicleModelDefinition exists and modelCode remains unique
```

Package script:

```json
"vehicle-model:no-enum": "node scripts/check-vehicle-model-no-enum.mjs"
```

Release check must run `vehicle-model:no-enum` instead of `vehicle-model:enum-freeze`.

- [ ] **Step 5: Run final release verification**

Run:

```powershell
pnpm release:check
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web build
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected:

```text
all commands exit 0
VehicleModel no-enum guard passes
```

- [ ] **Step 6: Commit enum deletion**

Run:

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations scripts package.json docs
git commit -m "feat: remove vehicle model enum schema"
```

## Task 8: Production Cutover

**Files:**
- Create later: `docs/stage-10x-vehicle-model-enum-removal-production-cutover.md`

- [ ] **Step 1: Freeze release window**

Required freeze:

```text
no payment release
no billing release
no quote pricing formula release
no residual forecast release
no unrelated schema migration
```

- [ ] **Step 2: Create production backup**

Record:

```text
backup id
backup timestamp
restore test status
operator name
```

- [ ] **Step 3: Deploy app version that no longer reads enum fields**

Run post-deploy smoke:

```powershell
pnpm vehicle-model:removal-readiness
pnpm vehicle-model:contract-governance
pnpm product-price-rule:constraint-decommission
```

Expected:

```text
READY / hardRemovalReady true / decommission ready true
```

- [ ] **Step 4: Apply schema migrations**

Apply in this order:

```text
1. string compatibility migrations already applied
2. drop operational enum fields
3. drop Quote / Order enum fields
4. drop enum type
```

Run:

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
```

- [ ] **Step 5: Run post-cutover validation**

Run:

```powershell
pnpm release:check
pnpm smoke:api
pnpm smoke:mainline
pnpm smoke:residual
```

Business validation:

```text
create quote by modelDefinitionId
create order from quote
view portal catalog
export order/report CSV
open asset profitability report
run residual forecast smoke
```

- [ ] **Step 6: Record production cutover**

Create `docs/stage-10x-vehicle-model-enum-removal-production-cutover.md` with:

```markdown
# Stage 10X-X VehicleModel Enum Removal Production Cutover

Date:
Operator:
Backup id:
Application version:
Migration range:

## Preflight

- runtime readiness:
- contract governance:
- ProductPriceRule decommission:
- release check:

## Migration

- deploy app:
- migrate deploy:
- migration status:

## Post-Cutover

- API smoke:
- mainline smoke:
- residual smoke:
- CSV/report sample:
- portal sample:

## Rollback Readiness

- previous app artifact:
- backup restore path:
- rollback decision owner:
```

## Rollback Strategy

### Preferred rollback before enum type deletion

If failure occurs before enum type deletion:

1. rollback application artifact;
2. stop migration sequence;
3. keep already-added string fields;
4. do not revert data;
5. fix application compatibility and re-run clone rehearsal.

### Rollback after enum field drops

If enum-typed columns were dropped but enum type still exists:

1. rollback application only if previous app can tolerate missing enum fields; otherwise deploy compatibility app;
2. restore enum columns only through rehearsed down migration;
3. refill enum columns from string code fields with explicit mapping:

```sql
UPDATE vehicle
SET vehicle_model = legacy_vehicle_model_code::"VehicleModel"
WHERE legacy_vehicle_model_code IN ('ET5', 'ET5T', 'ET7', 'ES6', 'EC6', 'ES8', 'ET9', 'ES9');
```

If any string code is outside the frozen enum set, stop and restore backup instead.

### Rollback after enum type deletion

Rollback after enum type deletion is backup-first.

Allowed options:

```text
restore database backup to previous schema
deploy previous application artifact
rerun smoke tests
```

Emergency down migration is allowed only if rehearsed:

```sql
CREATE TYPE "VehicleModel" AS ENUM ('ET5', 'ET5T', 'ET7', 'ES6', 'EC6', 'ES8', 'ET9', 'ES9');
ALTER TABLE vehicle ADD COLUMN vehicle_model "VehicleModel";
ALTER TABLE vehicle_package ADD COLUMN vehicle_model "VehicleModel";
ALTER TABLE product_price_rule ADD COLUMN vehicle_model "VehicleModel";
ALTER TABLE subscription_quote ADD COLUMN vehicle_model "VehicleModel";
ALTER TABLE subscription_order ADD COLUMN vehicle_model "VehicleModel";
```

Then refill only from verified string code fields. If refill cannot be proven complete, restore backup.

### API fallback strategy

After enum removal, never reintroduce enum business logic.

If an external client still expects `vehicleModel`, serve it as string compatibility only:

```json
{
  "vehicleModel": "ET5",
  "modelDefinitionId": "uuid",
  "modelDisplayName": "NIO ET5"
}
```

If a CSV consumer breaks:

1. restore v1 CSV field names with string values;
2. keep canonical v2 columns;
3. log consumer id and owner;
4. do not rollback schema unless historical data cannot be explained.

## Final Decision

Do not proceed to implementation until:

- contract governance hard removal is ready;
- all external consumers are migrated or explicitly retired;
- production-like clone rehearsal and rollback rehearsal both pass;
- finance/reporting, operations, product, asset, and platform owners sign off.

Recommended near-term posture remains:

```text
VehicleModel enum stays frozen and read-only until every final safety gate is green.
```
