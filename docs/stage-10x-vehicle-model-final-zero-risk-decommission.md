# Stage 10X Final VehicleModel Enum Zero-Risk Decommission Plan

## 1. Objective

This document is the one-shot execution plan for the final Prisma schema-level decommission of `VehicleModel`.

It is a plan and validation artifact only. It does not execute schema changes, migrations, production deployment, enum deletion, data modification, or business logic changes.

Target end state:

```text
modelDefinitionId is the runtime truth source
VehicleModel enum no longer exists in Prisma schema
historical explanation is preserved by string snapshots
external API / CSV / report contracts no longer require enum values
pricing, quote, order, payment, billing, ROE, depreciation, and residual logic remain unchanged
```

## 2. Current Evidence Snapshot

Local read-only checks executed on branch:

```text
feature/stage10-vehicle-model-final-decommission
```

### Runtime Evidence

Command:

```powershell
pnpm vehicle-model:removal-readiness
```

Observed result:

```json
{
  "businessDecisionUsageCount": 0,
  "decision": "NOT_READY",
  "enumUsageCount": 9,
  "externalUsageCount": 9,
  "fallbackUsageCount": 0,
  "readinessScore": 0
}
```

Interpretation:

```text
Business usage is zero.
Fallback usage is zero.
External/schema-contract usage is still present.
Hard removal is not ready.
```

### Contract Governance

Command:

```powershell
pnpm vehicle-model:contract-governance
```

Observed result:

```json
{
  "blockingConsumers": 0,
  "hardRemovalReady": false,
  "missingReferences": 0,
  "registeredReferences": 9,
  "totalExternalReferences": 9,
  "warningModeReady": true
}
```

Interpretation:

```text
External usage is governed, but not yet fully removed.
Schema enum deletion must not execute until hardRemovalReady=true.
```

### ProductPriceRule Constraint Decommission Check

Command:

```powershell
pnpm product-price-rule:constraint-decommission
```

Observed result:

```json
{
  "blockers": [],
  "database": {
    "legacyDatabaseUniquePresent": false,
    "modelDefinitionDatabaseUniquePresent": true
  },
  "legacyRollbackSummary": {
    "duplicateLegacyScopes": 0
  },
  "ready": true,
  "readinessSummary": {
    "duplicateModelDefinitionScopes": 0,
    "legacyMappingMismatches": 0,
    "missingModelDefinitionId": 0,
    "totalRules": 2
  },
  "schema": {
    "legacySchemaUniquePresent": false,
    "modelDefinitionSchemaUniquePresent": true
  }
}
```

Interpretation:

```text
ProductPriceRule legacy unique constraint decommission is freshly verified.
The legacy productVersionId + vehicleModel unique index is absent.
The canonical productVersionId + modelDefinitionId unique index is present.
Rollback restore of the legacy unique index is currently safe because duplicateLegacyScopes = 0.
```

### Schema Dependency Scan

Command:

```powershell
rg -n "enum VehicleModel|vehicleModel\s+VehicleModel|vehicleModel\s+VehicleModel\?|legacyVehicleModel\s+VehicleModel|legacyVehicleModelSnapshot\s+VehicleModel|@IsEnum\(VehicleModel\)|import \{[^}]*VehicleModel" apps\api\prisma\schema.prisma apps\api\src apps\web\src scripts
```

Observed hard schema dependencies:

```text
apps/api/prisma/schema.prisma: enum VehicleModel
VehiclePackage.vehicleModel VehicleModel
ProductPriceRule.vehicleModel VehicleModel
Vehicle.vehicleModel VehicleModel?
VehicleModelDefinition.legacyVehicleModel VehicleModel?
SubscriptionQuote.vehicleModel VehicleModel
SubscriptionQuote.legacyVehicleModelSnapshot VehicleModel?
SubscriptionOrder.vehicleModel VehicleModel
SubscriptionOrder.legacyVehicleModelSnapshot VehicleModel?
```

Observed API / DTO / service dependencies include:

```text
apps/api/src/report/dto/report.dto.ts @IsEnum(VehicleModel)
apps/api/src/product/dto/product.dto.ts @IsEnum(VehicleModel)
apps/api/src/portal/portal-catalog.dto.ts @IsEnum(VehicleModel)
apps/api/src/vehicle/dto/vehicle.dto.ts @IsEnum(VehicleModel)
apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts @IsEnum(VehicleModel)
apps/api/src/common/vehicle-model-snapshot.ts imports VehicleModel
apps/api/src/common/vehicle-model-resolver.ts imports VehicleModel
apps/api/src/vehicle-model-definition/vehicle-model-definition.service.ts imports VehicleModel
```

## 3. Hard Gate Status

Required hard gate:

```text
businessDecisionUsageCount == 0
fallbackUsageCount == 0
externalUsageCount == 0
schema dependency isolated
```

Current status:

| Gate | Current value | Status |
| --- | --- | --- |
| `businessDecisionUsageCount == 0` | `0` | PASS |
| `fallbackUsageCount == 0` | `0` | PASS |
| `externalUsageCount == 0` | `9` | FAIL |
| `schema dependency isolated` | enum-typed fields still present | FAIL |
| `contract governance hardRemovalReady` | `false` | FAIL |
| `ProductPriceRule constraint decommission` | `ready=true`, no blockers | PASS |

Final deletion decision:

```text
NOT READY
```

No enum deletion, schema execution, migration execution, or production cutover is permitted from this state.

## 4. Final Dependency Verification Plan

Before final removal, run and archive these checks.

### API Contracts

Required command:

```powershell
rg -n "@IsEnum\(VehicleModel\)|VehicleModel\b|vehicleModel\?:" apps/api/src
```

Required condition:

```text
No request DTO imports or validates VehicleModel.
No API contract requires enum-typed vehicleModel.
Any remaining vehicleModel response is string-only compatibility.
```

API replacement strategy:

```text
modelDefinitionId
modelCode
modelDisplayName
legacyVehicleModelCodeSnapshot
```

### CSV / Reports

Required command:

```powershell
rg -n "vehicleModel|VehicleModel|legacyVehicleModel" apps/api/src/report apps/web/src/app/reports
```

Required condition:

```text
Reports filter by modelDefinitionId.
Legacy vehicleModel filters are removed or converted into string compatibility aliases.
CSV includes canonical modelDefinitionId / modelCode / modelDisplayName.
Any legacy vehicleModel column is string-only and not enum-typed.
```

### External Consumers

Required command:

```powershell
pnpm vehicle-model:contract-governance
```

Required output:

```json
{
  "hardRemovalReady": true,
  "registeredReferences": 0,
  "totalExternalReferences": 0,
  "blockingConsumers": 0,
  "missingReferences": 0
}
```

If external references remain intentionally supported, the enum cannot be deleted. Those references must use string compatibility only.

### Prisma Schema

Required command:

```powershell
rg -n "\bVehicleModel\b" apps/api/prisma/schema.prisma
```

Required state before deleting enum:

```text
Only the enum VehicleModel block remains.
No model field uses VehicleModel.
```

Required state after deleting enum:

```text
No VehicleModel occurrences remain in schema.prisma.
VehicleModelDefinition remains and continues to provide modelCode / displayName / modelDefinitionId relations.
```

### Tests

Required command:

```powershell
rg -n "VehicleModel\.|@IsEnum\(VehicleModel\)|from \"@prisma/client\".*VehicleModel" apps/api/test apps/api/src apps/web/src scripts
```

Required condition:

```text
No active runtime test depends on Prisma VehicleModel enum.
Fixtures use VehicleModelDefinition, modelDefinitionId, or string model codes.
No test imports VehicleModel from @prisma/client except historical migration/no-enum guard tests.
```

### Runtime Shadow Tracker

Required command:

```powershell
pnpm vehicle-model:removal-readiness
```

Required output:

```json
{
  "businessDecisionUsageCount": 0,
  "fallbackUsageCount": 0,
  "externalUsageCount": 0,
  "enumUsageCount": 0,
  "readinessScore": 100,
  "decision": "READY"
}
```

## 5. Final Schema Removal Strategy

The final removal must be performed as an expand-contract sequence, not as a direct enum deletion.

### Phase 1: Complete Contract Isolation

Goal:

```text
No API / CSV / Report / external client requires enum-typed vehicleModel.
```

Actions:

```text
1. Replace request DTO enum fields with modelDefinitionId or string compatibility codes.
2. Replace response enum fields with string compatibility fields.
3. Version CSV/report exports if downstream consumers still expect vehicleModel.
4. Re-run contract governance until hardRemovalReady=true.
```

No Prisma schema deletion in this phase.

### Phase 2: Add / Confirm String Compatibility Coverage

Required string coverage:

```text
Vehicle legacy model code
VehiclePackage legacy model code
ProductPriceRule legacy model code
SubscriptionPlan legacy model code if needed
VehicleModelDefinition legacy model code if retained
SubscriptionQuote legacyVehicleModelCodeSnapshot
SubscriptionOrder legacyVehicleModelCodeSnapshot
```

Rules:

```text
all string code fields nullable during expand phase
backfill is dry-run first
apply requires explicit env guard
production apply requires backup and manual approval
never overwrite existing values
```

### Phase 3: Deploy Enum-Free Runtime

Goal:

```text
Application code no longer imports VehicleModel from @prisma/client.
```

Runtime must use:

```text
modelDefinitionId
modelCode
modelDisplayName
legacyVehicleModelCodeSnapshot
```

Validation:

```powershell
rg -n "import \{[^}]*VehicleModel|VehicleModel\b|@IsEnum\(VehicleModel\)" apps/api/src apps/web/src
pnpm release:check
```

### Phase 4: Drop Enum-Typed Columns

Only after Phases 1-3 pass, create migrations to remove enum-typed fields.

Operational column migration:

```sql
ALTER TABLE "vehicle" DROP COLUMN "vehicle_model";
ALTER TABLE "vehicle_package" DROP COLUMN "vehicle_model";
ALTER TABLE "product_price_rule" DROP COLUMN "vehicle_model";
ALTER TABLE "subscription_plan" DROP COLUMN "vehicle_model";
ALTER TABLE "vehicle_model_definition" DROP COLUMN "legacy_vehicle_model";
```

Historical snapshot migration:

```sql
ALTER TABLE "subscription_quote" DROP COLUMN "vehicle_model";
ALTER TABLE "subscription_quote" DROP COLUMN "legacy_vehicle_model_snapshot";
ALTER TABLE "subscription_order" DROP COLUMN "vehicle_model";
ALTER TABLE "subscription_order" DROP COLUMN "legacy_vehicle_model_snapshot";
```

Both migrations must be rehearsed on a production-like clone before production.

### Phase 5: Delete Enum Type

Only after no column depends on `"VehicleModel"`:

```sql
DROP TYPE "VehicleModel";
```

If PostgreSQL reports dependencies, stop and do not force the drop.

### Phase 6: Replace Freeze Guard With No-Enum Guard

Replace:

```text
pnpm vehicle-model:enum-freeze
```

with:

```text
pnpm vehicle-model:no-enum
```

No-enum guard must fail if:

```text
enum VehicleModel exists in schema.prisma
any Prisma model field has type VehicleModel
any runtime source imports VehicleModel from @prisma/client
```

## 6. Migration Sequence

Use separate PRs and migrations:

| Order | Migration | Purpose | Risk |
| --- | --- | --- | --- |
| 1 | `vehicle_model_string_compatibility_fields` | Add missing string code compatibility fields | Medium |
| 2 | `vehicle_model_string_compatibility_backfill` | Backfill string codes through guarded script, not data migration if possible | Medium |
| 3 | `drop_operational_vehicle_model_enum_fields` | Drop Vehicle / Product / Plan enum fields | High |
| 4 | `drop_quote_order_vehicle_model_enum_fields` | Drop Quote / Order enum fields after snapshot coverage | High |
| 5 | `drop_vehicle_model_enum_type` | Drop PostgreSQL enum type | High |
| 6 | `vehicle_model_no_enum_guard` | Replace freeze guard with no-enum guard | Low |

Each migration must have:

```text
production-like clone rehearsal
rollback rehearsal
release check
smoke evidence
owner sign-off
```

## 7. Zero-Downtime Strategy

True zero downtime is allowed only if both old and new application versions tolerate the intermediate schema.

Preferred path:

```text
expand nullable compatibility fields
deploy enum-free runtime
observe zero usage
schedule maintenance window
drop enum columns
drop enum type
run smoke tests
```

If old application versions still access enum columns, use a short maintenance window instead of claiming zero downtime.

Maintenance window is recommended for:

```text
dropping enum-typed columns
dropping PostgreSQL enum type
```

## 8. Rollback Strategy

### 8.1 Before Column Drop

Rollback is simple:

```text
rollback application artifact
keep expanded string columns
do not revert data
continue observing telemetry
```

### 8.2 After Enum Column Drop, Before Enum Type Drop

Rollback options:

```text
deploy compatibility application that does not require enum columns
or run rehearsed down migration to recreate columns
```

Down migration must recreate columns and refill from string codes:

```sql
ALTER TABLE "vehicle" ADD COLUMN "vehicle_model" "VehicleModel";
UPDATE "vehicle"
SET "vehicle_model" = "legacy_vehicle_model_code"::"VehicleModel"
WHERE "legacy_vehicle_model_code" IN ('ET5', 'ET5T', 'ET7', 'ES6', 'EC6', 'ES8', 'ET9', 'ES9');
```

If any string code cannot cast to the frozen enum set, stop and restore backup.

### 8.3 After Enum Type Drop

Rollback is backup-first.

Required assets:

```text
database backup
restore rehearsal notes
previous app artifact
schema migration log
API/CSV/report validation samples
```

Emergency enum recreation is allowed only if rehearsed:

```sql
CREATE TYPE "VehicleModel" AS ENUM ('ET5', 'ET5T', 'ET7', 'ES6', 'EC6', 'ES8', 'ET9', 'ES9');
```

Then recreate columns and refill from verified string code fields.

If refill is not complete, restore backup.

### 8.4 API Fallback

After enum deletion, fallback must be string-only:

```json
{
  "vehicleModel": "ET5",
  "modelDefinitionId": "uuid",
  "modelCode": "ET5-2024",
  "modelDisplayName": "NIO ET5"
}
```

Do not reintroduce Prisma `VehicleModel` in runtime code.

### 8.5 CSV / Report Fallback

If a consumer breaks:

```text
restore v1 CSV column names with string values
keep canonical v2 columns
record consumer id and owner
do not rollback schema unless historical interpretation is impossible
```

## 9. Execution Cutover Plan

### Pre-Cutover

Required:

```text
contract governance hardRemovalReady=true
runtime readiness decision=READY
ProductPriceRule decommission ready=true
schema dependency isolated
production-like clone rehearsal passed
rollback rehearsal passed
backup completed
owners online
```

Run:

```powershell
pnpm vehicle-model:removal-readiness
pnpm vehicle-model:contract-governance
pnpm product-price-rule:constraint-decommission
pnpm release:check
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

### Deployment Sequence

```text
1. Freeze unrelated releases.
2. Deploy enum-free application runtime.
3. Observe runtime usage at zero.
4. Backup database.
5. Apply drop enum-typed column migrations.
6. Run smoke tests.
7. Apply drop enum type migration.
8. Replace freeze guard with no-enum guard.
9. Run full release validation.
10. Record cutover evidence.
```

### Release Freeze

Do not combine with:

```text
payment changes
billing changes
quote pricing formula changes
residual forecast changes
report schema rewrites
unrelated migrations
```

## 10. Post-Cutover Verification

### API Health Check

```powershell
pnpm smoke:api
```

Expected:

```text
health endpoint OK
auth flow OK
core API routes OK
```

### Pricing Consistency Check

Run before and after cutover on the same fixtures:

```powershell
pnpm --filter @subscription-saas/api test -- product-components.spec.ts subscription-plan.spec.ts
```

Expected:

```text
same monthlyFeeAmount
same monthlyFeeRate
same mileage and over-mileage fee
same deposit
same quote/order snapshot display
```

### Report Consistency Check

Run:

```powershell
pnpm --filter @subscription-saas/api test -- report
```

Expected:

```text
same row counts
same totals
same model display names through modelDefinitionId or string snapshot
no enum filter required
```

### CSV Export Validation

Validate sample exports:

```text
asset profitability CSV
order CSV
quote/order historical CSV
residual CSV
comprehensive report CSV
```

Expected:

```text
canonical modelDefinitionId / modelCode / modelDisplayName present
legacy vehicleModel column, if present, is string-only
column order matches published contract version
```

### Regression Suite

Run:

```powershell
pnpm release:check
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web build
```

Expected:

```text
all commands exit 0
no VehicleModel enum references in schema
no runtime import of VehicleModel from @prisma/client
```

## 11. Final Validation Checklist

Before production execution:

- [ ] `businessDecisionUsageCount == 0`
- [ ] `fallbackUsageCount == 0`
- [ ] `externalUsageCount == 0`
- [ ] `readinessScore == 100`
- [ ] `decision == READY`
- [ ] `contract governance hardRemovalReady == true`
- [ ] `ProductPriceRule constraint decommission ready == true`
- [ ] schema dependency inventory has no enum-typed fields except the enum block scheduled for deletion
- [ ] API contracts no longer require enum `vehicleModel`
- [ ] CSV/report consumers signed off on string/canonical fields
- [ ] tests no longer import Prisma `VehicleModel`
- [ ] production-like clone migration rehearsal passed
- [ ] rollback rehearsal passed
- [ ] database backup created
- [ ] operations, product, finance/reporting, asset, and platform owners signed off

Current local status:

```text
NOT READY
```

Reasons:

```text
externalUsageCount = 9
contract governance hardRemovalReady = false
schema still contains enum-typed fields
```

## 12. Decision

Do not execute VehicleModel enum deletion yet.

Approved next action:

```text
Continue contract retirement and schema dependency isolation until hard gate is green.
```

Forbidden until then:

```text
DROP TYPE "VehicleModel"
dropping enum-typed columns
production migration
data rewrite
business logic changes
```
