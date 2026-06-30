# Stage 10X-S VehicleModel Enum Zero-Risk Removal Plan

## 1. Executive Summary

This document designs a zero-risk strategy for eventually removing the frozen `VehicleModel` Prisma enum.

The current system is already model master-data first:

- `VehicleModelDefinition` is the model-code master data source.
- new write paths are `modelDefinitionId` first.
- legacy enum writes are frozen or system-derived only.
- read paths have a `VehicleModelResolver` and `VehicleModelLegacyAdapter`.
- ProductPriceRule, Quote / Order snapshots, Reports, and CSV have modelDefinitionId-first or snapshot-first read behavior.

The enum must still not be removed immediately. Zero-risk removal requires observability, shadow validation, API-contract deprecation, schema dry-runs, and explicit safety gates before any destructive migration.

This stage is architecture-only:

- no schema changes
- no migrations
- no data writes
- no production deploy
- no enum deletion implementation

## 2. Current Blockers

| Area | Current dependency | Removal risk |
| --- | --- | --- |
| Prisma schema | `enum VehicleModel` and enum-typed fields on Vehicle, VehiclePackage, ProductPriceRule, SubscriptionQuote, SubscriptionOrder, VehicleModelDefinition legacy mapping | High |
| API contracts | `vehicleModel` remains in request DTOs, responses, and compatibility filters | High |
| Reports / CSV | legacy columns and filters remain for compatibility | Medium |
| Quote / Order history | `vehicleModel`, `legacyVehicleModelSnapshot`, and string snapshots coexist | High |
| ProductPriceRule uniqueness | unique constraint still includes `vehicleModel` in schema history and generated client contracts | High |
| External integrations | exports and downstream consumers may still rely on enum codes | Unknown until sweep |
| CI governance | enum freeze guard parses `enum VehicleModel` | Medium |
| Test / seed fixtures | fixtures still use enum values to represent historical compatibility | Medium |

## 3. Zero-Risk Principles

1. No removal without measurement.
2. No removal while any business decision depends on enum identity.
3. No removal while any external contract requires enum-typed values.
4. No destructive migration until a reversible expand-contract path has run clean in dry-run and staging.
5. No production apply without backup, rollback rehearsal, and manual approval.
6. Legacy enum may remain indefinitely if removal risk is higher than maintenance cost.

## 4. Shadow Usage Tracking

### 4.1 Goal

Track every remaining enum usage before changing behavior. The tracker must distinguish safe compatibility display from risky business decisions.

### 4.2 Proposed Component

Add a future `VehicleModelUsageTracker` with no business side effects.

Suggested event shape:

```ts
type VehicleModelUsageEvent = {
  aggregateId?: string | null;
  aggregateType:
    | "Vehicle"
    | "VehiclePackage"
    | "ProductPriceRule"
    | "SubscriptionQuote"
    | "SubscriptionOrder"
    | "Report"
    | "CsvExport"
    | "Portal"
    | "Seed"
    | "Script";
  enumCode?: string | null;
  fallbackReason?:
    | "MISSING_MODEL_DEFINITION_ID"
    | "MISSING_MODEL_DEFINITION_RELATION"
    | "SNAPSHOT_ENUM_ONLY"
    | "API_LEGACY_FILTER"
    | "CSV_LEGACY_COLUMN"
    | "DISPLAY_FALLBACK"
    | "BUSINESS_DECISION_FALLBACK";
  modelDefinitionId?: string | null;
  module: string;
  operation:
    | "DISPLAY"
    | "FILTER"
    | "MATCH"
    | "PRICE_RULE_LOOKUP"
    | "REPORT_QUERY"
    | "CSV_EXPORT"
    | "SNAPSHOT_RENDER"
    | "SYSTEM_DERIVED_WRITE";
  severity: "INFO" | "WARN" | "BLOCKER";
  sourceFile?: string;
  timestamp: string;
};
```

### 4.3 Instrumentation Points

| Point | Event severity | Reason |
| --- | --- | --- |
| `VehicleModelLegacyAdapter.resolveModelDefinitionInput` called from deprecated API input | `WARN` | Legacy input still reaches backend. |
| `vehicleModelReadPathMatches` falls back because one side lacks `modelDefinitionId` | `WARN` | Historical compatibility, but still a blocker for hard removal until count is zero or accepted. |
| `buildQuoteOrderModelDisplay` uses enum snapshot before string snapshot or display snapshot | `WARN` | Historical snapshot dependency. |
| report filter receives `vehicleModel` | `WARN` | Deprecated filter still used. |
| CSV exports legacy enum column | `INFO` | Compatibility output, not necessarily a blocker. |
| ProductPriceRule lookup cannot use `modelDefinitionId` and falls back to enum | `BLOCKER` | Pricing correctness depends on enum. |
| Portal / order / customer plan matching falls back to enum | `BLOCKER` if current objects, `WARN` if historical record | Matching is a business decision. |

### 4.4 Metrics

Expose daily counters by module:

```text
vehicle_model.enum_usage.total
vehicle_model.enum_usage.business_decision
vehicle_model.enum_usage.report_filter
vehicle_model.enum_usage.csv_display
vehicle_model.enum_usage.snapshot_enum_only
vehicle_model.enum_usage.unresolved_mapping
vehicle_model.enum_usage.conflict_mapping
```

### 4.5 Removal Gate

Before soft removal:

```text
business_decision = 0 for 30 consecutive production days
unresolved_mapping = 0
conflict_mapping = 0
report_filter legacy usage trend accepted by product owner
external CSV/API consumers acknowledged deprecation
```

## 5. Fallback Detection

Fallback detection must identify whether enum usage is harmless or removal-blocking.

### 5.1 Fallback Classes

| Class | Example | Removal impact |
| --- | --- | --- |
| Display fallback | Vehicle list displays `vehicleModel` because `modelDefinition` relation is unavailable | Low |
| Snapshot fallback | old Quote / Order lacks display snapshot and uses enum snapshot | Medium |
| API compatibility filter | report accepts `vehicleModel=ET5` then resolves it via adapter | Medium |
| Business decision fallback | plan matching or price lookup uses enum because `modelDefinitionId` is missing | High |
| Mapping fallback | legacy enum maps to VehicleModelDefinition.legacyVehicleModel | High until all contracts are string/modelDefinition based |

### 5.2 Required Logging Rule

Every fallback must emit:

```text
module
operation
aggregate type/id
fallback class
modelDefinitionId present?
legacy enum code
whether result affects a business decision
```

No sampling should be used for `BLOCKER` events.

## 6. Business Decision Detection

The following operations are business decisions and must not depend on enum at final removal time:

- ProductPriceRule lookup
- SubscriptionPlan / VehiclePackage matching
- customer self-service vehicle-plan validation
- order change plan selection
- portal catalog plan availability
- residual curve lookup and forecast target selection
- report filters that feed financial decisions

Allowed post-removal equivalents:

- `modelDefinitionId`
- immutable string snapshot code
- display name snapshot
- legacy string code where no master-data relation is expected

Forbidden at final removal:

- branching on `VehicleModel`
- querying by enum fields
- relying on Prisma-generated enum types in DTOs or service signatures

## 7. Dual-Read Validation

### 7.1 Goal

Run modelDefinitionId-first logic and legacy enum logic side by side, compare the result, and fail gates if they diverge.

Dual-read validation must be read-only.

### 7.2 Validation Surfaces

| Surface | Primary read | Shadow read | Expected |
| --- | --- | --- | --- |
| Vehicle model identity | `vehicle.modelDefinitionId` | `vehicle.vehicleModel -> VehicleModelDefinition.legacyVehicleModel` | same definition id |
| VehiclePackage identity | `vehiclePackage.modelDefinitionId` | `vehiclePackage.vehicleModel -> legacy mapping` | same definition id |
| ProductPriceRule identity | `rule.modelDefinitionId` | `rule.vehicleModel -> legacy mapping` | same definition id |
| Quote display | snapshot display/id/code | enum snapshot / original enum | same display class or accepted historical difference |
| Order display | order snapshot | quote snapshot / enum fallback | same display class or accepted historical difference |
| Reports | modelDefinitionId filter result | legacy filter resolved through adapter | same row count and IDs |
| CSV | model display snapshot/runtime | legacy enum column | no row loss; legacy column only compatibility |

### 7.3 Pricing Consistency Check

For every active ProductPriceRule:

```text
input:
  productVersionId
  modelDefinitionId
  vehicleModel

checks:
  1. modelDefinitionId is not null
  2. VehicleModelDefinition.id exists and deletedAt is null
  3. if legacyVehicleModel exists, it equals rule.vehicleModel
  4. lookup by modelDefinitionId returns same rule as legacy lookup
  5. quote monthly fee calculation uses the same rule in both paths

blockers:
  duplicate active rules for same productVersionId + modelDefinitionId
  missing modelDefinitionId
  mismatched legacyVehicleModel
  calculation mismatch
```

### 7.4 Report Consistency Check

For each report with model filtering:

```text
run A:
  query with modelDefinitionId

run B:
  query with legacy vehicleModel
  resolve through VehicleModelLegacyAdapter

compare:
  total row count
  sorted record ids
  CSV row count
  aggregate totals
  model display values
```

Allowed differences:

- display source label differs between snapshot and runtime mode
- legacy compatibility column exists only in CSV

Blocking differences:

- row count mismatch
- amount mismatch
- order/vehicle ids mismatch
- unresolved legacy mapping

### 7.5 Runtime Strategy

Use feature flags:

```text
VEHICLE_MODEL_DUAL_READ_VALIDATE=1
VEHICLE_MODEL_DUAL_READ_STRICT=0
VEHICLE_MODEL_USAGE_TRACKING=1
```

Start with logging only. Move to strict mode only after staging and production observation windows are clean.

## 8. Dependency Sweep

### 8.1 API Contracts

Sweep:

- DTO input fields named `vehicleModel`
- response fields named `vehicleModel`
- OpenAPI / Swagger descriptions
- frontend client types
- portal response types
- external integration docs

Actions:

1. classify each field as `current contract`, `deprecated input`, `compatibility output`, or `historical snapshot`.
2. publish deprecation notice.
3. add replacement field documentation: `modelDefinitionId`, `modelDisplayName`, `legacyVehicleModelCodeSnapshot`.
4. keep compatibility output through at least one release window after clients migrate.

### 8.2 Reports

Sweep:

- query DTOs
- report service where clauses
- grouped dimensions
- dashboard widgets
- saved report links

Exit condition:

```text
No report business query relies on enum.
vehicleModel filter is either removed or translated before query construction.
```

### 8.3 CSV

Sweep:

- Vehicle exports
- Product exports
- Quote / Order exports
- Report exports
- Residual exports

CSV policy:

```text
Keep human-readable model display columns.
Keep legacy model-code columns as strings during deprecation.
Never require Prisma enum type for CSV generation.
```

### 8.4 External Integrations

Sweep:

- API consumers
- BI / finance exports
- operational spreadsheets
- portal clients
- residual import/export users
- payment / contract / e-sign snapshots if they embed order payloads

Required evidence:

```text
consumer owner
field usage
replacement field
migration status
approval date
rollback contact
```

## 9. Schema Removal Safety Gate

### 9.1 Hard Conditions

All conditions must be true before enum removal implementation starts:

```text
1. business_decision fallback events = 0 for 30 production days
2. unresolved mapping events = 0 for 30 production days
3. dual-read pricing mismatches = 0 in staging and production shadow mode
4. dual-read report mismatches = 0 in staging and production shadow mode
5. ProductPriceRule uniqueness no longer depends on vehicleModel
6. Quote / Order displays do not read enum snapshots except compatibility output
7. API contract deprecation window completed
8. CSV consumers have migrated to string code/display columns
9. seed / scenario seed can run without Prisma VehicleModel type
10. tests pass with enum type references removed in a dry-run branch
11. rollback rehearsal completed against a production-like clone
12. backup and restore drill passed
```

### 9.2 Risk Thresholds

| Risk item | Threshold before removal |
| --- | --- |
| business decision fallback | exactly 0 |
| pricing mismatch | exactly 0 |
| report row mismatch | exactly 0 |
| unresolved mapping | exactly 0 |
| conflict mapping | exactly 0 |
| external consumer unknown status | exactly 0 |
| CSV consumer not migrated | exactly 0 for critical consumers |
| optional compatibility display fallback | product-owner approved residual count |

### 9.3 Rollback Strategy

Use expand-contract, never single-step deletion:

1. add replacement string / relation fields in advance.
2. backfill and verify.
3. run dual writes if a field still needs to exist.
4. switch reads.
5. stop writes.
6. keep columns for one or more releases.
7. only then remove enum fields.

Rollback before hard removal:

```text
disable strict validation
restore compatibility reads
continue writing legacy compatibility fields
retain enum schema
```

Rollback after hard removal is expensive because PostgreSQL enum and column removal can be destructive. Therefore hard removal requires:

```text
fresh backup
restore rehearsal
tagged release
forward-fix migration plan
manual production approval
maintenance window
```

## 10. Staged Removal Plan

### Stage A: Observe

Goal:

```text
Add shadow usage tracking and fallback classification.
```

No schema changes.

Acceptance:

```text
Usage dashboards show enum usage by module, operation, and severity.
No business behavior changes.
```

### Stage B: Dual-Read Shadow Validation

Goal:

```text
Run modelDefinitionId and legacy enum reads side by side for pricing, matching, and reports.
```

No schema changes.

Acceptance:

```text
pricing consistency = 100%
report consistency = 100%
no blocker fallbacks for current records
```

### Stage C: Dependency Sweep And Contract Deprecation

Goal:

```text
Document all API, CSV, report, and external consumers; publish replacements.
```

No schema changes initially.

Acceptance:

```text
All consumers have owners and migration status.
Deprecated fields are documented.
New integrations use modelDefinitionId or string snapshots only.
```

### Stage D: Soft Removal

Goal:

```text
Stop exposing legacy enum as recommended input/output while keeping compatibility fields.
```

Possible code changes, still no enum deletion.

Acceptance:

```text
frontend hides legacy enum fields except details/audit.
API docs mark enum fields legacy only.
new tests assert no business decision reads enum.
```

### Stage E: Schema Preparation

Goal:

```text
Replace enum-typed contract dependencies with string snapshots or modelDefinitionId relations.
```

Requires future migrations.

Acceptance:

```text
ProductPriceRule uniqueness uses modelDefinitionId.
Quote / Order original enum fields have string or snapshot alternatives.
Vehicle / Package enum columns are nullable compatibility only or unused.
```

### Stage F: Final Removal Dry-Run

Goal:

```text
Create an isolated branch and production-like clone rehearsal that removes VehicleModel enum.
```

No production changes.

Acceptance:

```text
prisma validate/generate pass
seed passes
all tests pass
report exports pass
dual-read validation has no blockers
rollback rehearsal is documented
```

### Stage G: Hard Removal

Goal:

```text
Remove enum fields and the enum definition only after all gates pass.
```

Requires migration and production approval.

Acceptance:

```text
production deploy completed in maintenance window
post-deploy smoke passes
no fallback blocker events
restore plan validated
```

## 11. Recommended Near-Term Roadmap

| Stage | Recommendation | Why |
| --- | --- | --- |
| 10X-S | implement shadow usage tracking | lowest-risk way to discover hidden enum dependency |
| 10X-T | dual-read validation for pricing and reports | proves modelDefinitionId behavior before contract changes |
| 10X-U | API / CSV / external dependency sweep | prevents breaking downstream consumers |
| 10X-V | ProductPriceRule uniqueness migration design | highest technical blocker |
| 10X-W | soft removal and docs deprecation | gives consumers time |
| 10X-X | final enum removal dry-run | only after evidence is clean |

## 12. Manual Confirmation Items

- What is the required production observation window: 30, 60, or 90 days?
- Which external CSV/API consumers are considered critical?
- Can legacy `vehicleModel` response fields remain forever as strings after enum removal?
- Should ProductPriceRule support model definitions without legacy mapping before hard removal?
- What rollback RTO/RPO is required for schema hard removal?
- Who signs off on API contract deprecation and CSV column lifecycle?

## 13. No-op Confirmation

This plan does not implement:

- schema changes
- migration execution
- data modification
- production deploy
- enum deletion
- business logic changes

It defines the zero-risk strategy and safety gates required before any future implementation can be considered.
