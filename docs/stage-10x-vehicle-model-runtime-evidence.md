# Stage 10X-T VehicleModel Runtime Evidence

## 1. Goal

Stage 10X-T adds a shadow evidence system for the frozen `VehicleModel` enum.

The system does not change pricing, quote, order, report, CSV, portal, residual, schema, migrations, or data.
It only records evidence that helps decide whether the enum can eventually be removed.

## 2. Runtime Tracking Architecture

The runtime evidence layer is centered on:

```text
VehicleModelUsageTracker
```

Location:

```text
apps/api/src/common/vehicle-model-usage-tracker.ts
```

It records immutable in-process events with:

```text
module
operation
usageKind
decisionPath
riskLevel
modelDefinitionId
legacyVehicleModelCode
metadata
```

Supported decision paths:

```text
MODEL_DEFINITION_ID
LEGACY_ENUM
SNAPSHOT
UNKNOWN
```

Supported usage categories:

```text
ENUM_RESOLVE
FALLBACK
BUSINESS_DECISION
PRODUCT_PRICE_RULE_INPUT
API_ENUM_FILTER
EXTERNAL_CONTRACT
DISPLAY
```

This layer is intentionally side-effect light:

- it never blocks requests;
- it never changes query predicates;
- it never rewrites payloads;
- it never changes pricing, quote, order, or report results.

## 3. Telemetry Collection Design

Runtime tracking currently emits evidence from these compatibility boundaries:

| Boundary | Evidence |
| --- | --- |
| `VehicleModelLegacyAdapter.resolveModelDefinitionInput` | deprecated enum input, fallback resolution, ProductPriceRule enum input |
| `vehicleModelReadPathMatches` | modelDefinitionId comparison vs legacy enum fallback |
| Product quote direct price-rule path | whether ProductPriceRule lookup originated from modelDefinitionId or legacy enum |
| Product subscription-plan quote path | whether package compatibility used modelDefinitionId or legacy enum |
| Order customer-order package match | whether order pricing/package compatibility used modelDefinitionId or legacy enum |
| Order change package match | whether order-change compatibility used modelDefinitionId or legacy enum |
| Report filter resolution | whether API legacy `vehicleModel` filters still reach backend filters |

The tracker aggregates:

```text
enumUsageCount
businessDecisionUsageCount
fallbackUsageCount
externalUsageCount
readinessScore
decision
```

## 4. Business Decision Tracing

Business decisions are explicitly traced when they affect:

- Quote pricing path;
- Order pricing / package compatibility path;
- ProductPriceRule active lookup path;
- Report filter resolution path.

Each decision records:

```text
decisionPath = MODEL_DEFINITION_ID | LEGACY_ENUM
```

Only `LEGACY_ENUM` business decisions increase `businessDecisionUsageCount`.
`MODEL_DEFINITION_ID` decisions are still recorded as evidence, but they do not count as enum dependency.

## 5. External Dependency Scan

The static readiness scanner lives in:

```text
scripts/vehicle-model-removal-readiness.mjs
scripts/vehicle-model-removal-readiness-core.mjs
```

It scans:

```text
apps/api/src
apps/web/src
packages/shared/src
scripts
```

It classifies enum usage as:

```text
API_CONTRACT
REPORTS_API
CSV_EXPORT
EXTERNAL_INTEGRATION
```

The scanner writes:

```text
.tmp/vehicle-model-removal-readiness-report.json
```

`.tmp/` is ignored by git. The report is generated locally or in CI evidence jobs and is not committed as source.

Command:

```powershell
pnpm vehicle-model:removal-readiness
```

Optional runtime events can be merged:

```powershell
node scripts/vehicle-model-removal-readiness.mjs --runtime-events .tmp/vehicle-model-runtime-events.json
```

## 6. Readiness Scoring Model

Base score:

```text
100
```

Penalties:

| Evidence | Penalty |
| --- | --- |
| Legacy enum business decision | -50 each |
| Legacy enum fallback | -20 each |
| External/API/CSV contract usage | -15 each |
| Display-only enum usage | -5 each |

Decision:

```text
READY
```

requires:

- `businessDecisionUsageCount = 0`
- `fallbackUsageCount = 0`
- `externalUsageCount = 0`
- `readinessScore >= 90`

Otherwise:

```text
NOT_READY
```

## 7. Current Report Shape

The generated JSON contains at least:

```json
{
  "enumUsageCount": 0,
  "businessDecisionUsageCount": 0,
  "fallbackUsageCount": 0,
  "externalUsageCount": 0,
  "readinessScore": 100,
  "decision": "READY"
}
```

Additional fields include:

```text
events
externalEnumUsageMap
riskClassification
totalUsageCount
```

## 8. Current Risk Analysis

Runtime business decision evidence is now observable, but schema removal is still not automatically safe.

Expected blockers before enum removal:

- API DTOs still expose deprecated `vehicleModel` fields;
- CSV/report surfaces still expose legacy compatibility columns;
- generated Prisma schema still contains enum hard dependencies;
- ProductPriceRule uniqueness still needs a schema-level migration plan before enum removal;
- external consumers must be reviewed before contract removal.

## 9. Expected Threshold For Stage 10X-U

Stage 10X-U should not start enum contract deprecation until the evidence report shows:

```text
businessDecisionUsageCount = 0
fallbackUsageCount = 0
externalUsageCount reviewed and approved
readinessScore >= 90
decision = READY or manually accepted NOT_READY with only display/API compatibility usage
```

For production hard removal, the stricter threshold should be:

```text
enumUsageCount = 0
businessDecisionUsageCount = 0
fallbackUsageCount = 0
externalUsageCount = 0
readinessScore = 100
decision = READY
```

## 10. No-op Confirmation

This stage does not:

- change Prisma schema;
- add migrations;
- delete `VehicleModel`;
- rewrite data;
- change pricing, quote, order, report, residual, portal, payment, write-off, billing, ROE, depreciation, or BaaS behavior;
- deploy to production.
