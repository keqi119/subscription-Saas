# Stage 10X-M-F VehicleModel Enum Retirement Final Review

## 1. Background

Stage 10X-M-F is the final feasibility review for retiring the Prisma `VehicleModel` enum after the Stage 10X model master-data rollout.

The system now has:

```text
VehicleModelDefinition master data
modelDefinitionId-first create/update paths for Vehicle
modelDefinitionId-first Product / VehiclePackage / ProductPriceRule paths
modelDefinitionId-first Portal catalog and Reports filters
modelDefinitionId-first Residual market / curve / forecast inputs
VehicleModel enum freeze guard in release:check and CI
low-risk modelDefinitionId backfill for Vehicle / VehiclePackage / ProductPriceRule
Quote / Order additive model snapshots
Quote / Order snapshot-mode display and CSV reads
Quote / Order string model-code snapshots for future enum detachment
```

This review does not remove the enum, change schema, write data, or modify runtime behavior.

## 2. Current Model Master Data Adoption Status

Current new-flow status:

| Area | modelDefinitionId adoption | Legacy fallback status |
| --- | --- | --- |
| Vehicle | New create resolves and writes `modelDefinitionId` | `Vehicle.vehicleModel` remains compatibility field |
| VehiclePackage | New create resolves and writes `modelDefinitionId` | `VehiclePackage.vehicleModel` remains compatibility field |
| ProductPriceRule | New create resolves and writes `modelDefinitionId` | `ProductPriceRule.vehicleModel` remains compatibility field and unique key participant |
| Portal catalog | Supports `modelDefinitionId` filter and display | Legacy `vehicleModel` filter remains |
| Reports | Supports `modelDefinitionId` filter and model display | Legacy `vehicleModel` filters and groupings remain |
| Residual market | New sample / curve / target run resolves `modelDefinitionId` | Legacy `brand` / `series` / `model` strings remain for history |
| Quote / Order | New rows write additive snapshots including string model code | `vehicleModel` and `legacyVehicleModelSnapshot` remain enum fields |
| CSV / UI display | Quote / Order use snapshot mode | Runtime vehicle reports still expose legacy compatibility columns |

## 3. Remaining VehicleModel Enum Dependencies

The frozen enum values remain:

```text
ET5
ET5T
ET7
ES6
EC6
ES8
ET9
ES9
```

### 3.1 Schema Hard Dependencies

`apps/api/prisma/schema.prisma` still contains hard enum dependencies:

| Model | Field | Current role |
| --- | --- | --- |
| `VehicleModelDefinition` | `legacyVehicleModel VehicleModel?` | Legacy enum mapping from master data |
| `Vehicle` | `vehicleModel VehicleModel?` | Vehicle compatibility / fallback field |
| `VehiclePackage` | `vehicleModel VehicleModel` | Product package compatibility / legacy matching |
| `ProductPriceRule` | `vehicleModel VehicleModel` | Price-rule compatibility and `@@unique([productVersionId, vehicleModel])` |
| `SubscriptionQuote` | `vehicleModel VehicleModel` | Original quote fact / legacy snapshot |
| `SubscriptionQuote` | `legacyVehicleModelSnapshot VehicleModel?` | Additive model snapshot compatibility |
| `SubscriptionOrder` | `vehicleModel VehicleModel` | Original order fact / legacy snapshot |
| `SubscriptionOrder` | `legacyVehicleModelSnapshot VehicleModel?` | Additive model snapshot compatibility |

Removing the enum now would require schema migrations for all of these fields and every dependent index / unique constraint.

### 3.2 Runtime Service Dependencies

Runtime services still use the enum for compatibility logic:

| Area | Examples | Classification |
| --- | --- | --- |
| Vehicle service | `resolveModelDefinitionByLegacyVehicleModel`, `resolveVehicleModelForWrite` | Active compatibility write path |
| Product service | VehiclePackage / ProductPriceRule create/update validation and quote generation fallback | Active compatibility write and matching path |
| Order service | Vehicle/package compatibility checks and Quote/Order snapshot creation | Active quote/order workflow dependency |
| Customer self-service | Vehicle/package compatibility checks and snapshot creation | Active portal order workflow dependency |
| Portal catalog | Legacy `vehicleModel` filter retained beside `modelDefinitionId` | Legacy API compatibility |
| Reports | `vehicleModel` filters, groupings, and CSV legacy columns | Active reporting compatibility |
| Finance / e-sign | Order / vehicle summaries still read `vehicleModel` for historical display | Historical display / contract-adjacent dependency |
| VehicleModelDefinition service | CRUD validates `legacyVehicleModel` uniqueness | Master-data compatibility dependency |

### 3.3 DTO / API Contract Dependencies

DTOs still expose enum-backed `vehicleModel` fields:

```text
apps/api/src/vehicle/dto/vehicle.dto.ts
apps/api/src/product/dto/product.dto.ts
apps/api/src/report/dto/report.dto.ts
apps/api/src/portal/portal-catalog.dto.ts
apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts
```

These fields are API compatibility surfaces. Deleting the enum would be a breaking API change unless they are converted to string-compatible legacy fields first.

### 3.4 Frontend Fallback / Label Dependencies

The frontend still includes compatibility labels and legacy selectors:

```text
apps/web/src/constants/labels.ts
apps/web/src/app/vehicles/page.tsx
apps/web/src/app/products/page.tsx
apps/web/src/app/reports/page.tsx
apps/web/src/app/reports/asset-profitability/page.tsx
apps/web/src/app/vehicle-model-definitions/page.tsx
apps/web/src/app/residual-market/page.tsx
apps/web/src/app/applications/[id]/page.tsx
apps/web/src/app/quotes/*
apps/web/src/app/orders/*
```

Most new-flow selectors are model-definition-first, but legacy labels and fallback display remain intentionally visible in admin or CSV contexts.

### 3.5 Snapshot / Historical Dependencies

Quote / Order historical interpretation still uses enum fields:

```text
SubscriptionQuote.vehicleModel
SubscriptionQuote.legacyVehicleModelSnapshot
SubscriptionOrder.vehicleModel
SubscriptionOrder.legacyVehicleModelSnapshot
quoteSnapshot / finalPlanSnapshot JSON payloads that may contain vehicleModel text
```

Stage 10X-M-C through M-E made snapshots additive and display-first. Stage 10X-N adds `legacyVehicleModelCodeSnapshot` as an additive string explanation field, but the original enum snapshot fields remain for compatibility.

### 3.6 Seed / Scenario Dependencies

Seed scripts still create legacy-compatible data:

```text
apps/api/prisma/seed.mjs
apps/api/prisma/seed-scenario.mjs
```

They seed `VehicleModelDefinition.legacyVehicleModel`, create demo vehicles with `vehicleModel`, and create ET5 baseline product configuration that still satisfies legacy package/rule fields.

### 3.7 Tests Dependencies

API tests still use `VehicleModel` heavily to assert compatibility behavior, including:

```text
vehicle create/update enforcement
product package / price rule compatibility
portal catalog legacy fallback
report filters and CSV
residual fallback display
quote/order snapshot display
enum freeze guard
backfill scripts
```

This is expected while enum compatibility remains part of the contract.

### 3.8 Docs / Scripts / CI Dependencies

Scripts and CI intentionally depend on the enum:

```text
scripts/check-vehicle-model-enum-freeze.mjs
scripts/check-vehicle-model-enum-freeze.test.mjs
scripts/model-definition-backfill*.mjs
scripts/quote-order-model-snapshot-backfill*.mjs
scripts/release-check.mjs
.github/workflows/ci.yml
```

The freeze guard is a deliberate protection: the enum exists but cannot be expanded.

## 4. Dependency Classification

| Classification | Current dependencies | Removal impact |
| --- | --- | --- |
| Active dependency | Vehicle/Product create-update compatibility, quote/order creation, reports filters/grouping | High |
| Legacy fallback | Portal catalog, Reports, UI labels, product/vehicle matching fallback | Medium |
| Historical snapshot | Quote / Order `vehicleModel` and `legacyVehicleModelSnapshot` | High |
| Test-only | Fixtures and regression tests around fallback behavior | Low by itself, but reflects real contracts |
| Docs-only | Stage documentation and runbooks | Low |
| CI / guard | Enum freeze scripts and release-check / CI workflow | Medium, because guard must be replaced if enum is removed |

## 5. Model-Level Risk Matrix

| Model / area | Direct enum field? | Has modelDefinitionId? | Has snapshot display? | Can remove enum now? | Risk | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| `Vehicle` | Yes, `vehicleModel` | Yes | Runtime display uses definition | No | High | Keep frozen; move to read-only later |
| `VehicleModelDefinition` | Yes, `legacyVehicleModel` | N/A | N/A | No | High | Keep as legacy mapping until string bridge exists |
| `VehiclePackage` | Yes, `vehicleModel` | Yes | Runtime display uses definition | No | High | Keep frozen; do not write legacy-only new rows |
| `ProductPriceRule` | Yes, `vehicleModel` | Yes | Runtime display uses definition | No | High | Keep; unique constraint must be redesigned first |
| `SubscriptionQuote` | Yes, `vehicleModel`, `legacyVehicleModelSnapshot` | Snapshot id and string code | Yes | No | High | Keep enum while string snapshot adoption stabilizes |
| `SubscriptionOrder` | Yes, `vehicleModel`, `legacyVehicleModelSnapshot` | Snapshot id and string code | Yes | No | High | Keep enum while string snapshot adoption stabilizes |
| Contract / e-sign display | Reads order / vehicle legacy fields | Indirect | Quote/order display exists | No | Medium | Keep display fallback; consider contract snapshot audit |
| Application / review snapshots | JSON may contain `vehicleModel` text | Indirect | Partial | No | Medium | Treat JSON as historical text, not enum first |
| `VehicleMarketPriceObservation` | No `VehicleModel` enum | Yes | Runtime display exists | Not blocked by enum | Low | Keep legacy brand/series/model strings |
| `VehicleResidualCurve` | No `VehicleModel` enum | Yes | Runtime display exists | Not blocked by enum | Medium | Keep legacy brand/series/model strings for historical curves |
| `VehicleResidualForecast` | No `VehicleModel` enum | Yes | Runtime display exists | Not blocked by enum | Medium | Keep forecast snapshots stable |
| `ResidualModelRun` | No `VehicleModel` enum | Target modelDefinition id | Runtime display exists | Not blocked by enum | Low | Keep target modelDefinition path |
| `VehicleValuationReview` | No direct enum field | Via vehicle / forecast | Runtime display exists | Not blocked by enum | Medium | Keep display fallback |
| Report DTO / CSV | Yes via `vehicleModel` filters and legacy columns | Yes | Yes for many detail rows | No | Medium | Keep legacy filters; default to modelDefinitionId |
| Portal catalog DTO | Yes via legacy `vehicleModel` filter | Yes | Runtime display exists | No | Medium | Keep deprecated legacy filter until clients migrate |

## 6. Can VehicleModel Enum Be Removed Now?

No.

Immediate deletion is not feasible because:

1. `Vehicle.vehicleModel`, `VehiclePackage.vehicleModel`, `ProductPriceRule.vehicleModel`, `SubscriptionQuote.vehicleModel`, and `SubscriptionOrder.vehicleModel` still directly use the enum.
2. `SubscriptionQuote.legacyVehicleModelSnapshot` and `SubscriptionOrder.legacyVehicleModelSnapshot` are enum-typed additive snapshot fields.
3. Product price rule uniqueness still includes `vehicleModel`.
4. Runtime services still validate `modelDefinitionId` against `legacyVehicleModel` for compatibility.
5. Public/admin DTOs still expose `vehicleModel` filters and payload fields.
6. Reports still group and export legacy `vehicleModel` for compatibility.
7. Seeds, backfill scripts, tests, and CI guard intentionally depend on the frozen enum.
8. Historical audit needs the legacy enum label until a string snapshot bridge exists.

Deleting the enum now would require coordinated schema migrations, data migration, API contract changes, report changes, seed updates, and replacement of the freeze guard. That is too much blast radius for a single retirement step.

## 7. Legacy Enum Snapshot vs String Snapshot Analysis

Current snapshot fields:

```text
legacyVehicleModelSnapshot VehicleModel?
legacyVehicleModelCodeSnapshot String?
modelDefinitionIdSnapshot String?
modelDisplayNameSnapshot String?
```

Stage 10X-N implements the string-based option additively:

```text
legacyVehicleModelCodeSnapshot String?
```

### Benefits of String Snapshot

1. Historical Quote / Order snapshots no longer depend on a Prisma enum.
2. Historical facts remain explainable even if `VehicleModel` is eventually removed.
3. Snapshot values can preserve the exact code text that existed at creation / backfill time.
4. Future external model codes can be represented without schema enum churn.

### Costs of String Snapshot

1. Requires additive schema migration.
2. Requires backfill from `legacyVehicleModelSnapshot` / `vehicleModel`.
3. Requires API and UI read priority updates.
4. Creates temporarily duplicated snapshot fields.
5. Requires clear audit language: reconstructed string snapshots are explanation fields, not original facts.

### Recommendation

Stage 10X-N implements string snapshots additively. Keep the enum snapshot fields during the transition, then re-review removal once Quote / Order / Contract / Report reads no longer need enum values.

## 8. Final Recommendation

### Option A: Keep Frozen Enum Long Term

```text
Keep VehicleModel enum.
Do not add enum values.
Use VehicleModelDefinition for all new models.
Use enum only for legacy compatibility and historical fallback.
```

Pros:

```text
Lowest risk
No schema migration
No historical data rewrite
Keeps current fallback and tests stable
```

Cons:

```text
Enum still exists as technical debt
Historical snapshots remain enum-coupled
New engineers may still notice enum and need guardrails
```

### Option B: Frozen Enum Plus String Snapshot Detachment

```text
Keep enum frozen now.
Add string snapshot fields for Quote / Order later.
Move historical display to string snapshots.
Gradually make legacy enum fields read-only.
Re-review enum removal after data and API detachment.
```

Pros:

```text
Best medium-term path
Reduces enum coupling without risky removal
Allows staged migrations and backfills
Preserves historical auditability
```

Cons:

```text
Needs migration and backfill
Requires API / UI dual-read period
Still does not remove enum immediately
```

### Option C: Remove Enum Completely

```text
Replace all VehicleModel enum fields with strings or modelDefinitionId.
Migrate historical rows.
Rewrite DTOs, tests, scripts, seeds, reports, and CI guard.
```

Pros:

```text
Eliminates enum technical debt
Future models are fully master-data driven
```

Cons:

```text
Highest risk
Large schema and data migration
Breaks current API contracts
Requires product/rule unique constraint redesign
Risks historical quote/order interpretation
Requires new guard strategy
```

### Recommended Strategy

Use Option A immediately and plan Option B next.

Do not choose Option C now.

Short-term final state:

```text
VehicleModel enum remains frozen.
New models must use VehicleModelDefinition.
New business flows are modelDefinitionId-first.
Legacy enum remains compatibility-only.
```

Medium-term target:

```text
Detach Quote / Order historical snapshots from enum through string snapshot fields.
Stop writing legacy enum fields where schema permits.
Move legacy enum to read-only compatibility mode.
```

## 9. Follow-up Stages

### Stage 10X-N: Legacy Enum Snapshot to String Snapshot

Goal:

```text
Add additive string snapshot fields for Quote / Order historical model code.
Backfill them from existing enum snapshots.
Update display helpers to prefer string snapshots.
```

Status: Implemented after this review.

Migration: Yes.

Risk: Medium.

Acceptance:

```text
New Quote / Order writes string snapshot.
Historical rows backfilled through guarded dry-run/apply.
Display reads string snapshot before enum snapshot.
No quote/order amount or status changes.
```

### Stage 10X-O: Vehicle / Product Legacy Enum Write Reduction

Goal:

```text
Stop Vehicle, VehiclePackage, and ProductPriceRule from accepting legacy-only writes.
Keep existing enum fields but treat them as derived compatibility values.
```

Implementation status: Completed in Stage 10X-O.

Migration: No.

Risk: Medium.

Acceptance:

```text
Create/update APIs require modelDefinitionId for new writes.
Legacy vehicleModel is derived from VehicleModelDefinition where still required.
No legacy-only new records are created.
Frontend forms use modelDefinitionId selectors and show legacy vehicleModel as read-only compatibility.
```

### Stage 10X-P: Legacy Enum Read-Only Mode

Goal:

```text
Mark enum fields as read-only compatibility in API docs and UI.
Keep CSV legacy columns for audit.
Default all filters and selectors to modelDefinitionId.
```

Migration: No.

Risk: Low to Medium.

Acceptance:

```text
Admin UI hides legacy enum controls except compatibility sections.
DTO docs mark vehicleModel deprecated / legacy-only.
Reports still accept legacy filters but modelDefinitionId is primary.
```

Implementation status: Completed in Stage 10X-P.

Notes:

```text
Vehicle / VehiclePackage / ProductPriceRule legacy-only writes remain rejected.
Residual sample / curve / target-specific model-run legacy-only writes are rejected.
Frontend legacy enum controls remain disabled compatibility fields.
Reports keep legacy vehicleModel filters as read-only compatibility.
```

### Stage 10X-Q: Enum Removal Feasibility Re-review

Goal:

```text
Re-run this audit after string snapshots and read-only mode are stable.
Decide whether enum removal is worth the migration risk.
```

Migration: No for review; Yes only if removal is approved later.

Risk: Low for review, High for removal.

Acceptance:

```text
No active create/update path requires enum input.
Quote / Order / Contract / Report historical display works without enum.
ProductPriceRule uniqueness no longer depends on enum or has a replacement strategy.
CI guard has been replaced with a master-data-only guard.
```

## 10. Manual Confirmation Items

Before any future enum removal effort, product / engineering should confirm:

1. Whether `Vehicle.vehicleModel` must remain as a permanent operational fallback.
2. Whether `ProductPriceRule` uniqueness should move from `vehicleModel` to `modelDefinitionId`, and how to handle global rules.
3. Whether Quote / Order historical snapshots require exact original code text rather than reconstructed mapping.
4. Whether Contract / e-sign outputs need their own immutable model snapshot fields.
5. Whether Reports should keep legacy `vehicleModel` filters indefinitely for audit users.
6. Whether Residual legacy `brand` / `series` / `model` strings should remain long-term independent dimensions.
7. Whether CI should keep enum freeze guard until enum removal, or add a new guard that prevents legacy-only writes.
8. Whether production backfills have been executed and archived with approvals.

## 11. No-op Confirmation

Stage 10X-M-F is documentation-only.

This stage does not:

```text
delete VehicleModel enum
modify Prisma schema
add migrations
write database data
change Vehicle / Product / Portal / Reports / Residual behavior
change Quote / Order snapshot write behavior
change ROE / depreciation / BaaS
change payment / write-off / billing / contract / service-case logic
deploy to production
```
