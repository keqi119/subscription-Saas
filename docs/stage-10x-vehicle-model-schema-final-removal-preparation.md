# Stage 10X-U-C VehicleModel Schema Final Removal Preparation

## 1. Goal

Stage 10X-U-C defines the final preparation plan for removing the frozen Prisma `VehicleModel` enum.

This stage is planning only. It does not change Prisma schema, create migrations, delete enum values, modify data, deploy to production, or change runtime behavior.

The plan assumes the target end state is:

```text
modelDefinitionId is the only runtime truth source
legacy enum usage is zero
external contracts no longer depend on VehicleModel
schema dependencies are isolated and ready for a rehearsed migration
```

Current local governance evidence still shows:

```json
{
  "registeredReferences": 9,
  "missingReferences": 0,
  "warningModeReady": true,
  "hardRemovalReady": false
}
```

Therefore this document is a final-removal preparation plan, not approval to remove the enum today.

## 2. Final Readiness Definition

The only acceptable hard-removal state is:

```text
READY_TO_REMOVE = true
```

Formula:

```text
READY_TO_REMOVE =
  externalUsageCount == 0
  AND fallbackUsageCount == 0
  AND businessDecisionUsageCount == 0
  AND schema dependency isolated
  AND contract governance hardRemovalReady == true
  AND production-like clone rehearsal passed
  AND rollback rehearsal passed
```

The readiness report must show:

```json
{
  "businessDecisionUsageCount": 0,
  "fallbackUsageCount": 0,
  "externalUsageCount": 0,
  "readinessScore": 100,
  "decision": "READY"
}
```

The governance report must show:

```json
{
  "missingReferences": 0,
  "blockingConsumers": 0,
  "hardRemovalBlockingConsumers": [],
  "hardRemovalReady": true
}
```

## 3. Schema Dependency Isolation

Before enum deletion, every direct `VehicleModel` schema dependency must be isolated.

| Current schema dependency | Final target | Removal blocker |
| --- | --- | --- |
| `enum VehicleModel` | deleted only after no model uses it | all enum-typed fields must be gone first |
| `Vehicle.vehicleModel` | removed or converted to nullable string compatibility field | runtime and API must not require it |
| `VehicleModelDefinition.legacyVehicleModel` | converted to string code or removed after mapping no longer required | legacy mapping and freeze guard must be replaced |
| `VehiclePackage.vehicleModel` | removed or converted to string compatibility field | package matching and API must use `modelDefinitionId` |
| `ProductPriceRule.vehicleModel` | removed after uniqueness moves to `modelDefinitionId` | pricing uniqueness risk |
| `SubscriptionQuote.vehicleModel` | removed or replaced by string snapshot/code field | historical audit and API contract risk |
| `SubscriptionQuote.legacyVehicleModelSnapshot` | removed after string snapshot is canonical | historical snapshot risk |
| `SubscriptionOrder.vehicleModel` | removed or replaced by string snapshot/code field | historical audit and API contract risk |
| `SubscriptionOrder.legacyVehicleModelSnapshot` | removed after string snapshot is canonical | historical snapshot risk |

Isolation means:

- code no longer imports `VehicleModel` outside migration compatibility scripts;
- DTOs no longer expose enum-typed `vehicleModel` as input;
- response compatibility uses strings or legacy sections, not Prisma enum types;
- report filters use `modelDefinitionId`;
- CSV exports use model code / display / snapshot fields;
- tests and seeds no longer require enum values.

## 4. Schema Removal Execution Plan

### 4.1 Preflight Checks

Required commands on the removal branch:

```powershell
pnpm vehicle-model:contract-governance
pnpm vehicle-model:removal-readiness
pnpm release:check
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Required outputs:

```text
contract governance hardRemovalReady = true
removal readiness decision = READY
release check passes
migration status up to date
```

Do not begin schema editing if any output fails.

### 4.2 Safe Enum Deletion Steps

The deletion must happen through small, reviewable branches.

#### Step 1: Replace enum contract fields with strings where history must remain readable

Target examples:

```prisma
legacyVehicleModelCode String?
legacyVehicleModelCodeSnapshot String?
```

Rules:

- never delete historical meaning without a string code replacement;
- keep `modelDefinitionId` as canonical runtime identity;
- use string snapshots for historical audit display;
- do not reuse enum values as new application truth.

#### Step 2: Move ProductPriceRule uniqueness fully to `modelDefinitionId`

Target:

```prisma
@@unique([productVersionId, modelDefinitionId])
```

Migration requirements:

- ensure `modelDefinitionId` is non-null for active/new price rules before uniqueness switch;
- keep a transition strategy for historical rows;
- remove all Prisma selectors using `productVersionId_vehicleModel`;
- prove quote pricing tests do not query by enum.

This step is high risk and should happen before enum deletion.

#### Step 3: Remove enum-typed fields from operational models

Operational models:

```text
Vehicle
VehiclePackage
ProductPriceRule
```

Removal rules:

- runtime queries must already use `modelDefinitionId`;
- API responses must use `modelDefinitionId`, `modelDisplayName`, or string compatibility fields;
- seed and fixtures must not write enum fields;
- no report group/filter may read enum fields.

#### Step 4: Remove enum-typed fields from historical models

Historical models:

```text
SubscriptionQuote
SubscriptionOrder
```

Removal rules:

- `modelDisplayNameSnapshot` and `legacyVehicleModelCodeSnapshot` must be populated for historical rows;
- API/CSV/report display must use snapshot mode;
- audit sign-off must confirm string snapshots are sufficient;
- historical facts such as amounts, status, dates, and original model code semantics must remain explainable.

#### Step 5: Remove `VehicleModelDefinition.legacyVehicleModel`

This is late-stage only.

Replacement:

```text
legacyVehicleModelCode String?
```

or no legacy mapping if all enum removal and legacy compatibility requirements are closed.

The freeze guard must be retired or replaced with a check that verifies no enum exists and new model codes are created only through `VehicleModelDefinition`.

#### Step 6: Delete `enum VehicleModel`

Only after no schema field references it.

Expected final schema condition:

```text
rg "VehicleModel" apps/api/prisma/schema.prisma
```

returns no enum definition and no enum-typed fields. References to `VehicleModelDefinition` are still valid and expected.

### 4.3 Prisma Migration Strategy

Use explicit migrations only.

Forbidden:

```text
prisma db push
prisma migrate reset
manual production schema edits
```

Recommended migration sequence:

| Migration | Purpose | Risk |
| --- | --- | --- |
| `product_price_rule_model_definition_unique` | move pricing uniqueness to modelDefinitionId | High |
| `legacy_vehicle_model_code_columns` | add/confirm string compatibility fields where needed | Medium |
| `drop_operational_vehicle_model_enum_fields` | remove operational enum columns after all reads/writes are clean | High |
| `drop_quote_order_vehicle_model_enum_fields` | remove historical enum columns after snapshot sign-off | High |
| `drop_vehicle_model_enum_definition` | remove enum type after all columns are gone | High |

Each migration must be rehearsed on a production-like clone before production deployment.

### 4.4 Backward Compatibility Constraints

Do not remove enum schema until all are true:

- v1 API clients do not require enum responses;
- v2 API contracts are available and validated;
- CSV v2 contracts are validated by report consumers;
- report filters reject or ignore `vehicleModel` safely;
- legacy `vehicleModel` response fields are either removed in a major version or replaced by string compatibility fields;
- support scripts and BI jobs use canonical fields;
- ProductPriceRule pricing is proven with `modelDefinitionId` uniqueness.

## 5. Rollback Strategy

### 5.1 Schema Rollback

Schema rollback after enum deletion is expensive and must be rehearsed.

Rollback assets required before production migration:

```text
database backup
down migration rehearsal notes
previous application image
API compatibility test suite
CSV sample comparison set
pricing sample comparison set
```

Rollback order:

1. rollback application deployment to prior compatible version;
2. verify old application can still read current schema;
3. if schema rollback is required, restore backup or execute rehearsed down migration;
4. re-run report/CSV/pricing smoke checks;
5. freeze further enum-removal work until root cause review completes.

Never rely on ad-hoc enum recreation in production.

### 5.2 Report / CSV Fallback Safety

Before schema removal:

- capture baseline CSV samples for asset profitability, general reports, residual exports, Quote/Order historical exports;
- compare row counts, primary ids, model display fields, and snapshot fields;
- prove exports work without enum columns;
- keep v1 export fallback available for at least one release if legacy columns are removed.

Fallback plan:

```text
if CSV v2 breaks a consumer:
  restore v1 export contract as default
  keep v2 opt-in
  do not rollback schema unless data cannot be explained
```

### 5.3 API Contract Fallback Strategy

Before schema removal:

- v2 clients must use `modelDefinitionId` and display/snapshot fields;
- v1 `vehicleModel` response fields must be removed, converted to string, or declared unsupported;
- API gateway/docs must route old clients to v1 until v1 retirement.

Fallback plan:

```text
if an API client fails after contract removal:
  restore v1 compatibility route or response transformer if available
  do not reintroduce enum business logic
  treat compatibility response as string-only
```

## 6. Production Cutover Plan

### 6.1 Migration Execution Window

Recommended window:

```text
low-traffic maintenance window
database backup completed immediately before migration
application rollback artifact available
operator and business owner online
```

Do not combine with:

- payment or billing releases;
- pricing formula releases;
- residual forecast releases;
- Quote/Order workflow changes;
- unrelated schema migrations.

### 6.2 Zero-Downtime Strategy

Preferred path:

```text
expand -> observe -> contract switch -> observe -> remove
```

For the final removal window:

1. deploy application version that does not read enum fields;
2. observe readiness reports at zero usage;
3. execute schema migration in maintenance window;
4. run post-migration smoke tests;
5. keep prior app image and database backup ready.

True zero downtime is only acceptable if:

- old and new application versions can both tolerate the intermediate schema;
- enum columns are not dropped while any old application can read them;
- deployment ordering prevents old code from starting after column removal.

If these conditions are not guaranteed, use a short maintenance window instead of claiming zero downtime.

### 6.3 Dual-Read Fallback Phase

Dual-read fallback is allowed before removal, not after enum deletion.

Dual-read phase:

```text
read modelDefinitionId first
compare string legacy code / snapshot code
record mismatch telemetry
do not use enum for decisions
```

Exit:

```text
zero mismatches
zero enum fallback
zero external enum usage
```

After deletion:

```text
fallback can only use string compatibility fields, never VehicleModel enum
```

## 7. Risk Analysis

### 7.1 Report System Break Risk

Risk: High until reports no longer filter, group, or export enum fields.

Potential failures:

- legacy `vehicleModel` filter disappears before consumers migrate;
- report grouping changes from enum code to display name;
- historical Quote/Order rows display runtime model instead of snapshot;
- row counts change because fallback predicates are removed incorrectly.

Mitigation:

- require report snapshot/runtime mode tests;
- baseline CSV samples before migration;
- maintain v1 report contract until owner sign-off;
- use `modelDefinitionId` filters only after legacy alias usage is zero.

### 7.2 CSV Export Break Risk

Risk: Medium to High depending on external parser usage.

Potential failures:

- downstream spreadsheet expects `vehicleModel`;
- BI import expects column order;
- residual import/export users rely on legacy brand/model fields;
- support workflows use enum code as lookup key.

Mitigation:

- version CSV schema;
- keep canonical columns and legacy columns during transition;
- publish v2 preview samples;
- require consumer validation evidence;
- remove legacy columns only after signed migration or accepted exception.

### 7.3 Historical Data Inconsistency Risk

Risk: High for Quote / Order and audit trails.

Potential failures:

- deleting enum fields removes original historical code before string snapshot is trusted;
- historical orders display current model definition instead of order-time snapshot;
- audit users cannot reconcile old enum values with current model codes;
- nullable snapshot gaps remain undiscovered.

Mitigation:

- require `legacyVehicleModelCodeSnapshot` coverage;
- keep `modelDisplayNameSnapshot` as display truth;
- run snapshot completeness report before migration;
- preserve original facts through string snapshots;
- obtain audit sign-off before dropping enum historical fields.

## 8. Final Safety Gate Checklist

All items must be checked before enum deletion implementation begins:

- [ ] `pnpm vehicle-model:removal-readiness` outputs `decision = READY`.
- [ ] `pnpm vehicle-model:contract-governance` outputs `hardRemovalReady = true`.
- [ ] `externalUsageCount = 0`.
- [ ] `fallbackUsageCount = 0`.
- [ ] `businessDecisionUsageCount = 0`.
- [ ] schema dependency isolation document lists no active enum-typed business fields.
- [ ] ProductPriceRule uniqueness no longer uses `vehicleModel`.
- [ ] Quote / Order historical display uses string snapshots without enum dependency.
- [ ] Reports and CSV exports pass v2 sample comparison.
- [ ] API v2 clients are migrated or v1 fallback is intentionally retained.
- [ ] production-like clone migration rehearsal passes.
- [ ] rollback rehearsal passes.
- [ ] manual sign-off is recorded from product, finance/reporting, operations, asset, and platform owners.

## 9. Follow-Up Stages

| Stage | Goal | Schema change? | Risk |
| --- | --- | --- | --- |
| 10X-V | ProductPriceRule additive uniqueness migration to modelDefinitionId while retaining legacy uniqueness | Yes | High |
| 10X-W | Quote / Order enum snapshot read deprecation completion | Maybe | Medium |
| 10X-X | API / CSV v2 contract cutover and legacy response removal | No to Medium | Medium |
| 10X-Y | final enum removal dry-run on production-like clone | Yes, dry-run only first | High |
| 10X-Z | production enum removal, only if all gates pass | Yes | High |

## 10. No-op Confirmation

Stage 10X-U-C does not:

- modify Prisma schema;
- add or run migrations;
- delete `VehicleModel`;
- modify database rows;
- change API behavior;
- change CSV output;
- change pricing, quote, order, product, portal, report, residual, ROE, depreciation, BaaS, payment, billing, contract, service-case, or write-off logic;
- deploy to production.
